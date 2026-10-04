/**
 * M3: does an idle connection stay up?
 *
 * The milestone asks for 30 minutes idle. That is too long for a test suite to run on every
 * change, so this is opt-in (`npm run soak -w ldk-ws-descriptor`) and takes its duration from
 * SOAK_SECONDS (default 120).
 *
 * To make a short run meaningful it compresses time: `timer_tick_ms` is turned down so LDK's
 * ping/pong cycle runs every second rather than every ten. Two minutes at that rate puts the
 * connection through more ping rounds than half an hour at the default would. It is not the
 * same as thirty real minutes - nothing here catches a bug that needs wall-clock time, like a
 * proxy idle timeout - so run it long at least once before believing the milestone.
 *
 *   SOAK_SECONDS=1800 npm run soak -w ldk-ws-descriptor
 */
import * as fs from "fs";
import { createRequire } from "module";
import * as ldk from "lightningdevkit";
import { NodeLDKNet } from "lightningdevkit-node-net";
import { WebSocket } from "ws";
import { start_proxy } from "ldk-ws-proxy";

import { WsLdkNet } from "../src/descriptor.js";
import { minimal_peer_manager } from "../src/minimal_node.js";
import { proxy_url } from "../src/proxy_url.js";

const require = createRequire(import.meta.url);
const seconds = Number(process.env.SOAK_SECONDS ?? 120);
const tick_ms = Number(process.env.SOAK_TICK_MS ?? 1000);

let failures = 0;
function check(condition: boolean, what: string): void {
	console.log((condition ? "  ok   " : "  FAIL ") + what);
	if (!condition) failures += 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await ldk.initializeWasmFromBinary(
	fs.readFileSync(require.resolve("lightningdevkit/liblightningjs.wasm")),
);

const peer_seed = new Uint8Array(32);
peer_seed.fill(42);
const peer = minimal_peer_manager(peer_seed);
const peer_net = new NodeLDKNet(peer.peer_manager);
let peer_port = 0;
for (let candidate = 20035; candidate < 20135; candidate++) {
	try {
		await peer_net.bind_listener("127.0.0.1", candidate);
		peer_port = candidate;
		break;
	} catch (_) { /* in use */ }
}

const proxy = await start_proxy({ port: 0, allow: ["127.0.0.1:" + peer_port] });

const client_seed = new Uint8Array(32);
client_seed.fill(43);

// Count LDK's own ping/pong traffic, so "still connected" is backed by evidence of the
// keepalive actually running rather than just an idle socket nobody noticed dying.
let pings = 0, pongs = 0;
const counting_client = minimal_peer_manager(client_seed, (line) => {
	if (line.includes("Enqueueing message Ping")) pings += 1;
	if (line.includes("Received message Pong")) pongs += 1;
});

const net = new WsLdkNet(counting_client.peer_manager, {
	web_socket_impl: WebSocket as unknown as new (url: string) => any,
	timer_tick_ms: tick_ms,
});

const url = proxy_url("ws://127.0.0.1:" + proxy.port, "127.0.0.1", peer_port);
const link = net.connect_link(url, peer.node_id, { stable_after_ms: 2000 });
await link.wait_connected();
await net.await_peer(peer.node_id);
console.log("connected; holding idle for " + seconds + "s with a " + tick_ms + "ms timer tick\n");

const started = Date.now();
let drops = 0;
let last_state = link.state;
link.on_state = (state, detail) => {
	if (state !== "connected" && last_state === "connected") drops += 1;
	last_state = state;
	console.log("  [link] " + state + ": " + detail);
};

while ((Date.now() - started) / 1000 < seconds) {
	await sleep(10_000);
	const elapsed = Math.round((Date.now() - started) / 1000);
	const peers = counting_client.peer_manager.list_peers().length;
	console.log(
		"  " + elapsed + "s  peers=" + peers + " pings=" + pings + " pongs=" + pongs +
		" state=" + link.state + " attempts=" + link.attempts,
	);
	if (peers != 1) failures += 1;
}

check(counting_client.peer_manager.list_peers().length == 1, "still connected after " + seconds + "s idle");
check(peer.peer_manager.list_peers().length == 1, "the peer agrees we are still there");
check(drops == 0, "the link never dropped (" + drops + " drops)");
check(pings > 0 && pongs > 0, "ping/pong ran throughout (" + pings + " pings, " + pongs + " pongs)");
check(link.attempts == 0, "no reconnect attempts were needed");

net.stop();
peer_net.stop();
await proxy.close();

console.log(failures == 0 ? "\nM3: idle connection survives.\n" : "\n" + failures + " check(s) failed\n");
process.exit(failures == 0 ? 0 : 1);
