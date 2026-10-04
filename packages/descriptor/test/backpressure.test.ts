/**
 * M3: the backpressure and read-pause paths, exercised deterministically.
 *
 * The handshake test proves the happy path against a real peer, but a handshake is a few
 * hundred bytes and never fills anything. These paths only run when a socket is congested or
 * when LDK stops reading, so they are driven here with a fake WebSocket whose bufferedAmount
 * we control, and a stand-in PeerManager that follows the same contract LDK does: hand bytes
 * to send_data, believe the returned count, keep the remainder, and wait for
 * write_buffer_space_avail.
 *
 * The SocketDescriptor itself is real - calls still round-trip through WASM - so what is
 * under test is the actual object LDK would hold.
 */
import * as fs from "fs";
import { createRequire } from "module";
import * as ldk from "lightningdevkit";

import { WsLdkNet, type WsLike } from "../src/descriptor.js";

const require = createRequire(import.meta.url);

let failures = 0;
function check(condition: boolean, what: string): void {
	console.log((condition ? "  ok   " : "  FAIL ") + what);
	if (!condition) failures += 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A WebSocket whose congestion we drive by hand. */
class FakeSocket implements WsLike {
	public readyState = 0;
	public bufferedAmount = 0;
	public binaryType = "blob";
	public sent: Uint8Array[] = [];
	public onopen: ((ev: any) => void) | null = null;
	public onmessage: ((ev: { data: any }) => void) | null = null;
	public onclose: ((ev: any) => void) | null = null;
	public onerror: ((ev: any) => void) | null = null;
	public static last: FakeSocket | undefined;

	constructor(public readonly url: string) {
		FakeSocket.last = this;
	}

	send(data: Uint8Array): void {
		// A real WebSocket takes the whole frame and grows bufferedAmount until it flushes.
		this.sent.push(data.slice());
		this.bufferedAmount += data.length;
	}
	close(): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		if (this.onclose) this.onclose({ code: 1000, reason: "" });
	}
	/** Pretend the network took `n` bytes off our hands. */
	flush(n: number): void {
		this.bufferedAmount = Math.max(0, this.bufferedAmount - n);
	}
	open(): void {
		this.readyState = 1;
		if (this.onopen) this.onopen({});
	}
	deliver(bytes: Uint8Array): void {
		if (this.onmessage) this.onmessage({ data: bytes });
	}
	get total_sent(): number {
		return this.sent.reduce((n, c) => n + c.length, 0);
	}
}

const ok = { is_ok: () => true };

/**
 * Enough of a PeerManager to exercise the descriptor, following the same rules LDK does:
 * believe the count send_data returns, hold the remainder, and resume on
 * write_buffer_space_avail.
 */
class FakePeerManager {
	public descriptor: ldk.SocketDescriptor | undefined;
	public outbound: Uint8Array[] = [];
	public pending: Uint8Array | undefined;
	public read_events: Uint8Array[] = [];
	public wbsa_calls = 0;
	public disconnects = 0;
	/** What we pass as send_data's continue_read - LDK's read pause lives here. */
	public continue_read = true;

	queue(bytes: Uint8Array): void {
		this.outbound.push(bytes);
	}
	process_events(): void {
		for (;;) {
			const chunk = this.pending ?? this.outbound.shift();
			if (chunk === undefined) return;
			const taken = this.descriptor!.send_data(chunk, this.continue_read);
			if (taken < chunk.length) {
				this.pending = chunk.subarray(taken);
				return;
			}
			this.pending = undefined;
		}
	}
	/** Tell the descriptor to pause or resume reads, the way LDK does: through send_data. */
	signal_read(continue_read: boolean): void {
		this.continue_read = continue_read;
		this.descriptor!.send_data(new Uint8Array(0), continue_read);
	}
	write_buffer_space_avail(_d: ldk.SocketDescriptor) {
		this.wbsa_calls += 1;
		return ok;
	}
	read_event(_d: ldk.SocketDescriptor, data: Uint8Array) {
		this.read_events.push(data);
		return ok;
	}
	socket_disconnected(_d: ldk.SocketDescriptor): void {
		this.disconnects += 1;
	}
	timer_tick_occurred(): void {}
	disconnect_all_peers(): void {}
	new_outbound_connection(_id: Uint8Array, d: ldk.SocketDescriptor, _addr: unknown) {
		this.descriptor = d;
		return { is_ok: () => true, res: new Uint8Array(0) };
	}
	get read_bytes(): number {
		return this.read_events.reduce((n, c) => n + c.length, 0);
	}
}

async function connect(pm: FakePeerManager, options: Record<string, unknown> = {}) {
	const net = new WsLdkNet(pm as unknown as ldk.PeerManager, {
		web_socket_impl: FakeSocket as unknown as new (url: string) => WsLike,
		drain_poll_ms: 10,
		timer_tick_ms: 1_000_000,
		...options,
	});
	const pending = net.connect_peer("ws://fake/v1/host/9735", new Uint8Array(33));
	FakeSocket.last!.open();
	const conn = await pending;
	return { net, conn, socket: FakeSocket.last! };
}

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

await ldk.initializeWasmFromBinary(
	fs.readFileSync(require.resolve("lightningdevkit/liblightningjs.wasm")),
);

// --- the socket has room: take everything ------------------------------------------------
{
	const pm = new FakePeerManager();
	const { net, conn, socket } = await connect(pm, { high_water_mark: 1 << 20 });
	for (let i = 0; i < 10; i++) pm.queue(bytes(1000));
	pm.process_events();

	check(socket.total_sent == 10_000, "under the high water mark every byte is taken");
	check(pm.pending === undefined, "nothing is left buffered in the PeerManager");
	check(!conn.is_write_blocked, "the connection is not write-blocked");
	net.stop();
}

// --- the socket is congested: take nothing, and say so -----------------------------------
const blocked = await (async () => {
	const pm = new FakePeerManager();
	const { net, conn, socket } = await connect(pm, { high_water_mark: 4096, low_water_mark: 1024 });

	// 20 KB of distinguishable chunks, so the bytes that come out the far end can be
	// compared with the bytes that went in.
	const expected = new Uint8Array(20_000);
	for (let i = 0; i < 20; i++) {
		const chunk = bytes(1000, i + 1);
		expected.set(chunk, i * 1000);
		pm.queue(chunk);
	}
	pm.process_events();

	check(conn.is_write_blocked, "past the high water mark the connection reports blocked");
	check(socket.total_sent <= 5000, "writing stopped at the mark rather than draining the queue");
	check(pm.pending !== undefined || pm.outbound.length > 0, "the rest stayed with the PeerManager");
	const sent_while_blocked = socket.total_sent;
	pm.process_events();
	check(socket.total_sent == sent_while_blocked, "a second process_events writes nothing more");
	return { pm, net, conn, socket, sent_while_blocked, expected };
})();

// --- it drains, and keeps draining, until the whole stream is through ---------------------
{
	const { pm, net, conn, socket, sent_while_blocked, expected } = blocked;

	// Each drain lets another ~5 KB through before the mark is hit again, so this is a cycle
	// rather than a single event: flush, get asked for more, block again.
	let cycles = 0;
	while ((pm.pending !== undefined || pm.outbound.length > 0) && cycles < 50) {
		socket.flush(socket.bufferedAmount); // the network caught up
		await sleep(40);
		cycles += 1;
	}

	check(cycles > 1, "draining took several block/resume cycles (" + cycles + ")");
	check(pm.wbsa_calls == cycles, "one write_buffer_space_avail per drain, no spurious calls");
	check(socket.total_sent > sent_while_blocked, "the remaining bytes go out after the drains");
	check(socket.total_sent == 20_000, "all 20 KB arrive in the end");

	const got = new Uint8Array(socket.total_sent);
	let at = 0;
	for (const chunk of socket.sent) { got.set(chunk, at); at += chunk.length; }
	let identical = got.length == expected.length;
	for (let i = 0; identical && i < expected.length; i++) identical = got[i] == expected[i];
	check(identical, "the byte stream came out intact, in order, with nothing duplicated");
	net.stop();
}

// --- a closing socket is not a place to put bytes ----------------------------------------
{
	const pm = new FakePeerManager();
	const { net, socket } = await connect(pm);
	socket.close();
	const taken = pm.descriptor!.send_data(bytes(100), true);
	check(taken == 0, "send_data on a closed socket takes nothing rather than discarding");
	check(socket.total_sent == 0, "and nothing was handed to the socket");
	check(pm.disconnects == 1, "socket_disconnected fired exactly once");
	net.stop();
}

// --- the read pause is honoured, and resumption preserves order --------------------------
{
	const pm = new FakePeerManager();
	const { net, conn, socket } = await connect(pm);
	pm.signal_read(false);

	socket.deliver(bytes(10, 1));
	socket.deliver(bytes(10, 2));
	socket.deliver(bytes(10, 3));
	await sleep(20);

	check(pm.read_events.length == 0, "no read_event while LDK has asked us to stop reading");
	check(conn.queued_inbound_bytes == 30, "the bytes are queued, not dropped");

	pm.signal_read(true);
	await sleep(20);

	check(pm.read_events.length == 3, "everything queued is delivered once reads resume");
	check(conn.queued_inbound_bytes == 0, "the queue is empty again");
	const order = pm.read_events.map((c) => c[0]).join(",");
	check(order == "1,2,3", "and in the order it arrived (got " + order + ")");
	net.stop();
}

// --- a peer that ignores the pause gets hung up on ---------------------------------------
{
	const pm = new FakePeerManager();
	const { net, socket } = await connect(pm, { max_inbound_bytes: 2000 });
	pm.signal_read(false);

	for (let i = 0; i < 5; i++) socket.deliver(bytes(1000));
	await sleep(20);

	check(socket.readyState == 3, "the socket is closed once the inbound queue passes the cap");
	check(pm.disconnects == 1, "socket_disconnected fired exactly once for it");
	check(pm.read_events.length == 0, "and nothing was fed to LDK while paused");
	net.stop();
}

console.log(failures == 0 ? "\nM3: backpressure and read pause behave.\n" : "\n" + failures + " check(s) failed\n");
process.exit(failures == 0 ? 0 : 1);
