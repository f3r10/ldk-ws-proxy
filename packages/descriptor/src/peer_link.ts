import type { WsConnection, WsLdkNet } from "./descriptor.js";

export type LinkState =
	/** Opening a socket right now. */
	| "connecting"
	/** A socket is open and registered with the PeerManager. */
	| "connected"
	/** Waiting out a backoff delay before the next attempt. */
	| "waiting"
	/** Stopped for good, by close() or by running out of attempts. */
	| "closed";

export interface ReconnectOptions {
	/** Delay before the first retry. Default 500ms. */
	initial_delay_ms?: number;
	/** Ceiling for the backoff. Default 30s. */
	max_delay_ms?: number;
	/** Multiplier applied per consecutive failure. Default 2. */
	factor?: number;
	/**
	 * Randomisation applied to each delay, as a fraction either side. Default 0.25.
	 *
	 * Without it, every tab that lost the same proxy comes back at the same instant.
	 */
	jitter?: number;
	/** Give up after this many consecutive failures. Default: never give up. */
	max_attempts?: number;
	/**
	 * How long a connection must survive before it counts as a success and resets the
	 * backoff. Default 10s.
	 *
	 * Without this, a socket that opens and is immediately closed - a proxy refusing the
	 * target with 1008, say - looks like a success every time, and the backoff never grows.
	 */
	stable_after_ms?: number;
}

interface ResolvedReconnect extends Required<ReconnectOptions> {}

/**
 * A durable connection to one peer: opens a socket, and reopens it with exponential backoff
 * whenever it goes away, until told to stop.
 *
 * `state` is the state of the transport, not of the Lightning peer - "connected" means the
 * socket is open and registered with the `PeerManager`, which is a moment or two before the
 * `init` exchange finishes. Ask the `PeerManager` (or `WsLdkNet.await_peer`) for the latter.
 */
export class PeerLink {
	public state: LinkState = "connecting";
	/** Consecutive failures since the last connection that lasted. */
	public attempts = 0;
	/** The current connection, while there is one. */
	public connection: WsConnection | undefined;
	/** Called on every state change, for status displays. */
	public on_state: ((state: LinkState, detail: string) => void) | undefined;

	private readonly opts: ResolvedReconnect;
	private stopped = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private connected_at = 0;

	constructor(
		private readonly net: WsLdkNet,
		public readonly url: string,
		public readonly node_id: Uint8Array,
		options: ReconnectOptions = {},
	) {
		this.opts = {
			initial_delay_ms: options.initial_delay_ms ?? 500,
			max_delay_ms: options.max_delay_ms ?? 30_000,
			factor: options.factor ?? 2,
			jitter: options.jitter ?? 0.25,
			max_attempts: options.max_attempts ?? Number.POSITIVE_INFINITY,
			stable_after_ms: options.stable_after_ms ?? 10_000,
		};
		void this.attempt();
	}

	/** Stop reconnecting and close any current connection. */
	public close(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		const conn = this.connection;
		this.connection = undefined;
		if (conn !== undefined) {
			// Drop the hook first: this close is not a failure to retry.
			conn.on_disconnect = undefined;
			conn.close();
		}
		this.set_state("closed", "closed by the application");
	}

	/** Resolves once the socket is up; rejects if the link is closed or gives up first. */
	public async wait_connected(timeout_ms = 30_000): Promise<WsConnection> {
		const deadline = Date.now() + timeout_ms;
		for (;;) {
			if (this.state === "connected" && this.connection !== undefined) return this.connection;
			if (this.state === "closed") throw new Error("link to " + this.url + " is closed");
			if (Date.now() > deadline) throw new Error("timed out connecting to " + this.url);
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	private async attempt(): Promise<void> {
		if (this.stopped) return;
		this.set_state("connecting", "attempt " + (this.attempts + 1));

		let conn: WsConnection;
		try {
			conn = await this.net.connect_peer(this.url, this.node_id);
		} catch (err) {
			this.retry(err instanceof Error ? err.message : String(err));
			return;
		}
		if (this.stopped) {
			conn.close();
			return;
		}

		this.connection = conn;
		this.connected_at = Date.now();
		this.set_state("connected", "socket open");

		conn.on_disconnect = () => {
			if (this.connection === conn) this.connection = undefined;
			const lasted = Date.now() - this.connected_at;
			if (lasted >= this.opts.stable_after_ms) this.attempts = 0;
			const code = conn.close_code === undefined ? "" : " (close code " + conn.close_code + ")";
			this.retry("disconnected after " + Math.round(lasted / 1000) + "s" + code);
		};
	}

	private retry(detail: string): void {
		if (this.stopped) return;
		this.attempts += 1;
		if (this.attempts > this.opts.max_attempts) {
			this.stopped = true;
			this.set_state("closed", "giving up after " + (this.attempts - 1) + " attempts: " + detail);
			return;
		}

		const delay = this.backoff_delay();
		this.set_state("waiting", detail + "; retrying in " + Math.round(delay) + "ms");
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.attempt();
		}, delay);
	}

	private backoff_delay(): number {
		const base = Math.min(
			this.opts.max_delay_ms,
			this.opts.initial_delay_ms * Math.pow(this.opts.factor, this.attempts - 1),
		);
		const spread = base * this.opts.jitter;
		// Clamp after jitter, not before: jittering a delay that is already at the ceiling
		// pushes it past the ceiling, which is how a 30s maximum produced a 36s wait.
		return Math.min(this.opts.max_delay_ms, Math.max(0, base + (Math.random() * 2 - 1) * spread));
	}

	private set_state(state: LinkState, detail: string): void {
		this.state = state;
		if (this.on_state !== undefined) this.on_state(state, detail);
	}
}
