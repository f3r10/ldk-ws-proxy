import * as ldk from "lightningdevkit";

/**
 * The subset of the browser `WebSocket` API this package needs.
 *
 * Declared structurally so the same code runs in a browser (global `WebSocket`) and under
 * Node.JS with the `ws` package, which is how the test suite drives a real handshake.
 */
export interface WsLike {
	readyState: number;
	bufferedAmount: number;
	binaryType: string;
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev: any) => void) | null;
	onmessage: ((ev: { data: any }) => void) | null;
	onclose: ((ev: any) => void) | null;
	onerror: ((ev: any) => void) | null;
}

/** `WebSocket.readyState` values, spelled out so we do not depend on a global. */
const CONNECTING = 0, OPEN = 1;

export interface WsLdkNetOptions {
	/**
	 * Stop handing bytes to the socket once `bufferedAmount` exceeds this, and tell LDK to
	 * buffer instead by returning a short count from `send_data`. Default 1 MiB.
	 */
	high_water_mark?: number;
	/** Resume writing once `bufferedAmount` drops back to this. Default 256 KiB. */
	low_water_mark?: number;
	/**
	 * How often to poll `bufferedAmount` while blocked. WebSocket has no `drain` event, so
	 * polling is the only way to notice the buffer draining. Default 50ms.
	 */
	drain_poll_ms?: number;
	/**
	 * How often to call `timer_tick_occurred()`. LDK's docs ask for "roughly once every ten
	 * seconds". Default 10s.
	 */
	timer_tick_ms?: number;
	/** WebSocket constructor to use. Defaults to the global one. */
	web_socket_impl?: new (url: string) => WsLike;
	/** Optional trace hook. */
	log?: (msg: string) => void;
}

interface ResolvedOptions extends Required<Omit<WsLdkNetOptions, "web_socket_impl" | "log">> {
	web_socket_impl: new (url: string) => WsLike;
	log: (msg: string) => void;
}

/**
 * One live WebSocket connection to a peer, and the `SocketDescriptor` LDK holds for it.
 *
 * Strong references to both the descriptor and this object are held by `WsLdkNet` for as
 * long as the connection lives. The TypeScript bindings free the Rust-side object when JS
 * drops its last reference, so letting either become unreachable while LDK still knows
 * about the connection is a use-after-free.
 */
export class WsConnection {
	/** The LDK-side handle. Do not let this become unreachable while connected. */
	public readonly descriptor: ldk.SocketDescriptor;

	private readonly inbound: Uint8Array[] = [];
	/** LDK asked us to stop feeding it data (`send_data` with `continue_read` unset). */
	private read_paused = false;
	/** We returned a short count from `send_data` and owe a `write_buffer_space_avail`. */
	private write_blocked = false;
	private drain_timer: ReturnType<typeof setInterval> | undefined;
	private disconnected = false;

	constructor(
		private readonly net: WsLdkNet,
		private readonly pm: ldk.PeerManager,
		private readonly ws: WsLike,
		public readonly id: bigint,
		private readonly opts: ResolvedOptions,
	) {
		// The default is "blob" in browsers, and awaiting blob.arrayBuffer() can deliver
		// chunks out of order. BOLT-8 is a stream cipher; reordered bytes are fatal.
		ws.binaryType = "arraybuffer";

		const self = this;
		this.descriptor = ldk.SocketDescriptor.new_impl({
			send_data(data: Uint8Array, continue_read: boolean): number {
				return self.send_data(data, continue_read);
			},
			disconnect_socket(): void {
				self.opts.log("descriptor " + self.id + ": disconnect_socket()");
				// close() is safe in any state and fires onclose asynchronously, which is
				// where we call socket_disconnected. Doing it here would re-enter the
				// PeerManager from inside one of its own callbacks.
				self.ws.close();
			},
			eq(other: ldk.SocketDescriptor): boolean {
				return other.hash() == self.id;
			},
			hash(): bigint {
				return self.id;
			},
		} as ldk.SocketDescriptorInterface);

		ws.onmessage = (ev: { data: any }) => {
			const bytes = to_bytes(ev.data);
			if (bytes === undefined) {
				this.opts.log("descriptor " + this.id + ": ignoring non-binary message");
				return;
			}
			this.inbound.push(bytes);
			this.pump();
		};
		ws.onclose = () => this.on_closed("close");
		ws.onerror = () => this.on_closed("error");
	}

	/**
	 * `SocketDescriptor::send_data`.
	 *
	 * The return value is a promise to LDK about how many bytes we took ownership of. A
	 * WebSocket's `send()` is all-or-nothing while the socket is open - unlike a TCP write
	 * it never accepts a prefix - so we either take everything or take nothing and ask LDK
	 * to hold the bytes for us.
	 */
	private send_data(data: Uint8Array, continue_read: boolean): number {
		// LDK signals read pause/resume through this flag, including on calls with no data.
		if (continue_read && this.read_paused) {
			this.read_paused = false;
			// Never call back into the PeerManager from inside one of its callbacks; this
			// runs once the current call into WASM has returned.
			queueMicrotask(() => this.pump());
		} else if (!continue_read) {
			this.read_paused = true;
		}

		if (this.disconnected || this.ws.readyState !== OPEN) {
			// send() on a closing/closed socket silently discards, which would put a hole in
			// the encrypted stream. Take nothing: the connection is over anyway.
			return 0;
		}
		if (this.write_blocked) return 0;
		if (data.length == 0) return 0;

		this.ws.send(data);

		if (this.ws.bufferedAmount > this.opts.high_water_mark) {
			this.write_blocked = true;
			this.start_drain_poll();
		}
		return data.length;
	}

	/**
	 * Feed queued inbound bytes to LDK, honouring the read pause.
	 *
	 * `read_event` never calls back into `send_data`, so the pause flag can only change
	 * during `process_events` - hence one `process_events` per chunk rather than one at the
	 * end of the loop.
	 */
	private pump(): void {
		while (!this.disconnected && !this.read_paused && this.inbound.length > 0) {
			const chunk = this.inbound.shift()!;
			const res = this.pm.read_event(this.descriptor, chunk);
			if (!res.is_ok()) {
				this.opts.log("descriptor " + this.id + ": read_event failed, disconnecting");
				this.ws.close();
				return;
			}
			this.pm.process_events();
		}
	}

	private start_drain_poll(): void {
		if (this.drain_timer !== undefined) return;
		this.drain_timer = setInterval(() => {
			if (this.disconnected || this.ws.readyState !== OPEN) {
				this.stop_drain_poll();
				return;
			}
			if (this.ws.bufferedAmount > this.opts.low_water_mark) return;

			this.stop_drain_poll();
			this.write_blocked = false;
			if (!this.pm.write_buffer_space_avail(this.descriptor).is_ok()) {
				this.opts.log("descriptor " + this.id + ": write_buffer_space_avail failed");
				this.ws.close();
				return;
			}
			this.pm.process_events();
		}, this.opts.drain_poll_ms);
	}

	private stop_drain_poll(): void {
		if (this.drain_timer !== undefined) {
			clearInterval(this.drain_timer);
			this.drain_timer = undefined;
		}
	}

	private on_closed(reason: string): void {
		// onerror is usually followed by onclose; socket_disconnected must happen exactly once.
		if (this.disconnected) return;
		this.disconnected = true;
		this.stop_drain_poll();
		this.inbound.length = 0;
		this.opts.log("descriptor " + this.id + ": socket " + reason + ", disconnecting peer");
		this.pm.socket_disconnected(this.descriptor);
		this.pm.process_events();
		this.net._forget(this);
	}

	/** Close the socket from the application side. */
	public close(): void {
		this.ws.close();
	}

	public get is_connected(): boolean {
		return !this.disconnected;
	}

	/** Send the handshake bytes LDK handed us when the connection was registered. */
	/* @internal */
	_send_initial(bytes: Uint8Array): void {
		const sent = this.send_data(bytes, true);
		if (sent != bytes.length) {
			// Only possible if the socket died between open and here.
			this.opts.log("descriptor " + this.id + ": could not send handshake, closing");
			this.ws.close();
		}
	}
}

/**
 * Bridges an `ldk.PeerManager` to peers reached over WebSocket, either through a
 * WebSocket-to-TCP proxy or directly to a node that speaks the peer protocol over
 * WebSocket (Core Lightning's `bind-addr=ws:...`).
 *
 * Hold this object for as long as the node runs.
 */
export class WsLdkNet {
	private readonly opts: ResolvedOptions;
	private readonly connections = new Set<WsConnection>();
	private descriptor_count = BigInt(0);
	private ping_timer: ReturnType<typeof setInterval>;

	public constructor(public readonly peer_manager: ldk.PeerManager, options: WsLdkNetOptions = {}) {
		const global_ws = (globalThis as any).WebSocket;
		this.opts = {
			high_water_mark: options.high_water_mark ?? 1024 * 1024,
			low_water_mark: options.low_water_mark ?? 256 * 1024,
			drain_poll_ms: options.drain_poll_ms ?? 50,
			timer_tick_ms: options.timer_tick_ms ?? 10_000,
			web_socket_impl: options.web_socket_impl ?? global_ws,
			log: options.log ?? (() => {}),
		};
		if (this.opts.web_socket_impl === undefined) {
			throw new Error("No WebSocket implementation: pass options.web_socket_impl");
		}
		if (this.opts.low_water_mark > this.opts.high_water_mark) {
			throw new Error("low_water_mark must not exceed high_water_mark");
		}

		this.ping_timer = setInterval(() => {
			peer_manager.timer_tick_occurred();
			peer_manager.process_events();
		}, this.opts.timer_tick_ms);
	}

	/**
	 * Opens a WebSocket to `url` and registers it with the `PeerManager` as an outbound
	 * connection to `peer_node_id`.
	 *
	 * The returned promise resolves once the socket is open and the first handshake bytes
	 * have been written - not once the peer is connected. Use `await_peer` for that.
	 */
	public async connect_peer(url: string, peer_node_id: Uint8Array): Promise<WsConnection> {
		const ws = new this.opts.web_socket_impl(url);
		const id = this.descriptor_count;
		this.descriptor_count += BigInt(1);
		const conn = new WsConnection(this, this.peer_manager, ws, id, this.opts);
		this.connections.add(conn);

		return new Promise<WsConnection>((resolve, reject) => {
			ws.onopen = () => {
				this.opts.log("descriptor " + id + ": socket open to " + url);
				const res = this.peer_manager.new_outbound_connection(
					peer_node_id,
					conn.descriptor,
					// A browser has no idea what address the peer sees us on, and the proxy
					// hop means our socket address is meaningless to the peer either way.
					ldk.Option_SocketAddressZ.constructor_none(),
				);
				if (!res.is_ok()) {
					conn.close();
					reject(new Error("PeerManager rejected the new outbound connection"));
					return;
				}
				// These bytes are act one of the BOLT-8 handshake. Nothing happens until
				// they reach the peer.
				conn._send_initial((res as ldk.Result_CVec_u8ZPeerHandleErrorZ_OK).res);
				resolve(conn);
			};
			// Covers failure to connect at all; after open, errors go to the descriptor.
			const on_fail = () => reject(new Error("WebSocket to " + url + " failed"));
			const prev_onerror = ws.onerror;
			ws.onerror = (ev: any) => {
				if (ws.readyState === CONNECTING) on_fail();
				if (prev_onerror) prev_onerror(ev);
			};
			const prev_onclose = ws.onclose;
			ws.onclose = (ev: any) => {
				on_fail();
				if (prev_onclose) prev_onclose(ev);
			};
		});
	}

	/**
	 * Waits until `peer_node_id` shows up in `list_peers()`, meaning the BOLT-8 handshake
	 * and the `init` exchange both completed.
	 */
	public async await_peer(peer_node_id: Uint8Array, timeout_ms = 15_000): Promise<void> {
		const deadline = Date.now() + timeout_ms;
		const wanted = hex(peer_node_id);
		for (;;) {
			for (const peer of this.peer_manager.list_peers()) {
				if (hex(peer.get_counterparty_node_id()) === wanted) return;
			}
			if (Date.now() > deadline) throw new Error("Timed out waiting for peer " + wanted);
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	/** Flush queued outbound messages. Call after anything that generates messages. */
	public process_events(): void {
		this.peer_manager.process_events();
	}

	/** Closes every connection and releases this handler's resources. */
	public stop(): void {
		clearInterval(this.ping_timer);
		for (const conn of Array.from(this.connections)) conn.close();
		this.peer_manager.disconnect_all_peers();
	}

	/* @internal */
	_forget(conn: WsConnection): void {
		this.connections.delete(conn);
	}
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Normalises whatever the WebSocket handed us into bytes.
 *
 * With `binaryType = "arraybuffer"` this is always an ArrayBuffer in a browser; the `ws`
 * package hands us a Buffer instead. Text frames are not part of the peer protocol.
 */
function to_bytes(data: any): Uint8Array | undefined {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	if (Array.isArray(data)) {
		// `ws` can deliver a fragmented message as an array of Buffers.
		const parts = data.map(to_bytes).filter((p): p is Uint8Array => p !== undefined);
		const total = parts.reduce((n, p) => n + p.length, 0);
		const out = new Uint8Array(total);
		let off = 0;
		for (const p of parts) { out.set(p, off); off += p.length; }
		return out;
	}
	return undefined;
}
