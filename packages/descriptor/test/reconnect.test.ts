/**
 * M3: surviving the proxy going away.
 *
 * Same three tiers as the handshake test - LDK peer over TCP, proxy, our descriptor - but
 * here the proxy is killed mid-connection and brought back, which is the failure a browser
 * tab will actually meet (a laptop lid, a redeploy, a dropped wifi).
 */
import * as fs from "fs";
import { createRequire } from "module";
import * as ldk from "lightningdevkit";
import { NodeLDKNet } from "lightningdevkit-node-net";
import { WebSocket } from "ws";
import { start_proxy, type ProxyHandle } from "ldk-ws-proxy";

import { WsLdkNet } from "../src/descriptor.js";
import { minimal_peer_manager } from "../src/minimal_node.js";
import { proxy_url } from "../src/proxy_url.js";
import type { LinkState } from "../src/peer_link.js";

const require = createRequire(import.meta.url);

let failures = 0;
function check(condition: boolean, what: string): void {
	console.log((condition ? "  ok   " : "  FAIL ") + what);
	if (!condition) failures += 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function wait_for(what: string, predicate: () => boolean, timeout_ms = 20_000): Promise<boolean> {
	const deadline = Date.now() + timeout_ms;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(100);
	}
	console.log("  timed out waiting for " + what);
	return false;
}

await ldk.initializeWasmFromBinary(
	fs.readFileSync(require.resolve("lightningdevkit/liblightningjs.wasm")),
);

const seed = new Uint8Array(32);
seed.fill(42);
const peer = minimal_peer_manager(seed);
const peer_net = new NodeLDKNet(peer.peer_manager);
let peer_port = 0;
for (let candidate = 19935; candidate < 20035; candidate++) {
	try {
		await peer_net.bind_listener("127.0.0.1", candidate);
		peer_port = candidate;
		break;
	} catch (_) { /* in use */ }
}
check(peer_port != 0, "peer node listening on TCP");

// A fixed port, because the client has to find the proxy again at the same address after it
// comes back.
let proxy: ProxyHandle | undefined;
let proxy_port = 0;
for (let candidate = 13001; candidate < 13101; candidate++) {
	try {
		proxy = await start_proxy({ port: candidate, allow: ["127.0.0.1:" + peer_port] });
		proxy_port = candidate;
		break;
	} catch (_) { /* in use */ }
}
check(proxy !== undefined, "proxy listening");

const client_seed = new Uint8Array(32);
client_seed.fill(43);
const client = minimal_peer_manager(client_seed);
const states: LinkState[] = [];
const net = new WsLdkNet(client.peer_manager, {
	web_socket_impl: WebSocket as unknown as new (url: string) => any,
	log: (line) => console.log("  [client] " + line),
});

const url = proxy_url("ws://127.0.0.1:" + proxy_port, "127.0.0.1", peer_port);
const link = net.connect_link(url, peer.node_id, {
	initial_delay_ms: 200,
	max_delay_ms: 1_000,
	stable_after_ms: 500,
});
link.on_state = (state, detail) => {
	states.push(state);
	console.log("  [link] " + state + ": " + detail);
};

await link.wait_connected();
check(await wait_for("the peer", () => peer.peer_manager.list_peers().length == 1), "connected through the proxy");

// --- the proxy dies ------------------------------------------------------------------------
console.log("\nkilling the proxy");
await proxy!.close();

check(
	await wait_for("the client to notice", () => link.state === "waiting" || link.state === "connecting"),
	"the link notices the socket died and starts retrying",
);
check(
	await wait_for("the peer to notice", () => peer.peer_manager.list_peers().length == 0),
	"the peer sees the disconnect too",
);

// Let it fail a few times, so the backoff is doing something rather than hot-looping.
await sleep(1500);
const attempts_while_down = link.attempts;
check(attempts_while_down >= 2, "it retried while the proxy was down (" + attempts_while_down + " attempts)");
check(client.peer_manager.list_peers().length == 0, "and did not pretend to be connected meanwhile");

// --- the proxy comes back -------------------------------------------------------------------
console.log("\nrestarting the proxy on the same port");
proxy = await start_proxy({ port: proxy_port, allow: ["127.0.0.1:" + peer_port] });

check(await wait_for("reconnection", () => link.state === "connected"), "the link reconnects on its own");
check(
	await wait_for("the peer again", () => peer.peer_manager.list_peers().length == 1),
	"the peer sees the browser-side node connected again",
);
check(
	client.peer_manager.list_peers().length == 1,
	"and the client has exactly one peer, not a ghost from the old socket",
);
check(states.includes("waiting"), "the link reported a waiting state while backing off");

// --- closing the link means closing it --------------------------------------------------------
console.log("\nclosing the link");
link.close();
check(link.state === "closed", "close() stops the link immediately");
check(
	await wait_for("the peer to drop", () => peer.peer_manager.list_peers().length == 0),
	"closing the link disconnects the peer",
);
const attempts_after_close = link.attempts;
await sleep(1200);
check(link.attempts == attempts_after_close, "and it does not keep reconnecting afterwards");

net.stop();
peer_net.stop();
await proxy.close();

console.log(failures == 0 ? "\nM3: reconnect survives the proxy restarting.\n" : "\n" + failures + " check(s) failed\n");
process.exit(failures == 0 ? 0 : 1);
