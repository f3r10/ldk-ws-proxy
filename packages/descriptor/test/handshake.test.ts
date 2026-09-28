/**
 * M2 end-to-end test: a BOLT-8 handshake and `init` exchange over WebSocket.
 *
 * The three processes of the real demo all run in-process here:
 *
 *   client PeerManager --(WsLdkNet)--> WebSocket --> proxy --> TCP --> peer PeerManager
 *
 * The "peer" side uses LDK's own `lightningdevkit-node-net` over plain TCP, so it is a
 * stand-in for a real Lightning node and none of our code is on that side of the wire.
 * Run the same client against Polar for the version with a real LND or CLN node.
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
const wasm_path = require.resolve("lightningdevkit/liblightningjs.wasm");

let failures = 0;
function check(condition: boolean, what: string): void {
	console.log((condition ? "  ok   " : "  FAIL ") + what);
	if (!condition) failures += 1;
}

async function wait_for(what: string, predicate: () => boolean, timeout_ms = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeout_ms;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	console.log("  timed out waiting for " + what);
	return false;
}

function seed_of(byte: number): Uint8Array {
	const seed = new Uint8Array(32);
	seed.fill(byte);
	return seed;
}

await ldk.initializeWasmFromBinary(fs.readFileSync(wasm_path));

// --- the remote peer: a vanilla LDK node listening on TCP ---------------------------------
const peer = minimal_peer_manager(seed_of(42));
const peer_net = new NodeLDKNet(peer.peer_manager);
let peer_port = 0;
for (let candidate = 19735; candidate < 19835; candidate++) {
	try {
		await peer_net.bind_listener("127.0.0.1", candidate);
		peer_port = candidate;
		break;
	} catch (_) { /* port in use, try the next */ }
}
check(peer_port != 0, "peer node listening on TCP");
console.log("  peer node id: " + hex(peer.node_id) + " on 127.0.0.1:" + peer_port);

// --- the proxy ----------------------------------------------------------------------------
const proxy = await start_proxy({
	port: 0,
	allow: ["127.0.0.1:" + peer_port],
	log: (line) => console.log("  [proxy] " + line),
});
check(proxy.port != 0, "proxy listening");

// --- the browser side ---------------------------------------------------------------------
const client = minimal_peer_manager(seed_of(43));
const net = new WsLdkNet(client.peer_manager, {
	web_socket_impl: WebSocket as unknown as new (url: string) => any,
	log: (line) => console.log("  [client] " + line),
});

const url = proxy_url("ws://127.0.0.1:" + proxy.port, "127.0.0.1", peer_port);
console.log("\nconnecting to " + url);
const conn = await net.connect_peer(url, peer.node_id);
check(conn.is_connected, "WebSocket open and handshake bytes sent");

await net.await_peer(peer.node_id);
check(client.peer_manager.list_peers().length == 1, "client sees the peer connected");
check(
	await wait_for("the peer to see us", () => peer.peer_manager.list_peers().length == 1),
	"peer node sees the browser-side node connected",
);

const peers = peer.peer_manager.list_peers();
if (peers.length == 1) {
	check(hex(peers[0].get_counterparty_node_id()) == hex(client.node_id), "peer sees our node id");
	check(peers[0].get_is_inbound_connection(), "the peer sees the connection as inbound");
}

// --- a disallowed target is refused --------------------------------------------------------
// Note the shape of this failure: the WebSocket opens (the proxy has to accept it to read
// the path), so connect_peer resolves and the refusal arrives as an immediate close.
const bad_url = proxy_url("ws://127.0.0.1:" + proxy.port, "127.0.0.1", peer_port + 1);
const bad_conn = await net.connect_peer(bad_url, peer.node_id);
check(
	await wait_for("the refused connection to close", () => !bad_conn.is_connected, 5_000),
	"proxy refuses a target outside the allowlist",
);
check(bad_conn.close_code == 1008, "refusal arrives as close code 1008, not a connect error");
check(client.peer_manager.list_peers().length == 1, "the refused connection left the good peer alone");

// --- clean disconnect -----------------------------------------------------------------------
conn.close();
check(
	await wait_for("both sides to notice the disconnect", () =>
		client.peer_manager.list_peers().length == 0 && peer.peer_manager.list_peers().length == 0),
	"socket close propagates to socket_disconnected on both sides",
);

net.stop();
peer_net.stop();
await proxy.close();

console.log(failures == 0 ? "\nM2: handshake over WebSocket works.\n" : "\n" + failures + " check(s) failed\n");
process.exit(failures == 0 ? 0 : 1);

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
