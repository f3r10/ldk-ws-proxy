/**
 * M4, the half that makes persistence mean anything: can the node come back?
 *
 * Opens a channel, shuts the browser-side node down, builds a new one from the same storage,
 * and checks that it finds its channel, catches up on the blocks it missed, and can still
 * pay through it. A node that writes state but cannot restore it is not persistent, it is
 * just slow.
 */
import * as fs from "fs";
import { createRequire } from "module";
import * as ldk from "lightningdevkit";
import { NodeLDKNet } from "lightningdevkit-node-net";
import { WebSocket } from "ws";
import { start_proxy, start_chain_proxy } from "ldk-ws-proxy";
import { WsLdkNet, proxy_url } from "ldk-ws-descriptor";

import { start_full_node, type FullNode } from "../src/node.js";
import { ChainClient } from "../src/chain.js";
import { MemoryKv } from "../src/kv.js";

const require = createRequire(import.meta.url);

let failures = 0;
function check(condition: boolean, what: string): void {
	console.log((condition ? "  ok   " : "  FAIL ") + what);
	if (!condition) failures += 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function wait_for(what: string, predicate: () => boolean, timeout_ms = 60_000): Promise<boolean> {
	const deadline = Date.now() + timeout_ms;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(250);
	}
	console.log("  timed out waiting for " + what);
	return false;
}

await ldk.initializeWasmFromBinary(
	fs.readFileSync(require.resolve("lightningdevkit/liblightningjs.wasm")),
);

const chain_proxy = await start_chain_proxy({ port: 0 });
const chain = new ChainClient("http://127.0.0.1:" + chain_proxy.port);
try {
	await chain.tip();
} catch (_) {
	console.log("\nNo regtest bitcoind reachable - start the Polar network first.\n");
	process.exit(1);
}

const peer_events: string[] = [];
const peer_seed = new Uint8Array(32); peer_seed.fill(21);
const peer = await start_full_node({
	seed: peer_seed, chain, kv: new MemoryKv(), chain_poll_ms: 1000,
	on_event: (name) => peer_events.push(name),
});
const peer_net = new NodeLDKNet(peer.peer_manager);
let peer_port = 0;
for (let candidate = 20235; candidate < 20335; candidate++) {
	try { await peer_net.bind_listener("127.0.0.1", candidate); peer_port = candidate; break; } catch (_) {}
}
const ws_proxy = await start_proxy({ port: 0, allow: ["127.0.0.1:" + peer_port] });
const url = proxy_url("ws://127.0.0.1:" + ws_proxy.port, "127.0.0.1", peer_port);

// Storage outlives the node, which is the entire point of the test.
const kv = new MemoryKv();
const seed = new Uint8Array(32); seed.fill(22);
let events: string[] = [];

async function build(): Promise<{ node: FullNode; net: WsLdkNet }> {
	const node = await start_full_node({
		seed, chain, kv, chain_poll_ms: 1000,
		log: (l) => console.log("  [node] " + l),
		on_event: (name, detail) => { events.push(name); console.log("  [event] " + name + " " + detail); },
	});
	const net = new WsLdkNet(node.peer_manager, {
		web_socket_impl: WebSocket as unknown as new (url: string) => any,
	});
	const link = net.connect_link(url, peer.node_id, {});
	await link.wait_connected();
	return { node, net };
}

// --- first life: open a channel ---------------------------------------------------------------
let { node, net } = await build();
check(await wait_for("the peer", () => node.peer_manager.list_peers().length == 1), "connected");

node.open_channel(peer.node_id, 1_000_000, 300_000_000);
check(await wait_for("funding", () => events.includes("ChannelPending")), "channel funded and pending");
await sleep(1000);
await chain.mine(6);
check(await wait_for("channel_ready", () => events.includes("ChannelReady"), 90_000), "channel ready");

await node.persist_manager();
const channel_id_before = node.channel_manager.list_channels()[0].get_channel_id().get_a();
const capacity_before = node.channel_manager.list_usable_channels()[0].get_outbound_capacity_msat();
check(node.persist.in_flight == 0, "every monitor write landed before we pull the plug");

// --- the tab closes ------------------------------------------------------------------------------
console.log("\nshutting the node down and mining while it is away");
net.stop();
node.stop();
await sleep(500);
await chain.mine(3); // the chain moves on without us

// --- second life: rebuild from storage ------------------------------------------------------------
console.log("\nrebuilding from storage");
events = [];
({ node, net } = await build());

const restored = node.channel_manager.list_channels();
check(restored.length == 1, "the restored node found its channel");
if (restored.length == 1) {
	const id_after = restored[0].get_channel_id().get_a();
	check(Array.from(id_after).join() == Array.from(channel_id_before).join(),
		"it is the same channel, not a new one");
}
check(await wait_for("the chain to catch up",
	() => node.chain_sync.height >= (peer.chain_sync.height - 1)), "it replayed the blocks it missed");
check(await wait_for("the channel to be usable again",
	() => node.channel_manager.list_usable_channels().length == 1, 60_000),
	"the channel came back usable");

// --- and it still works ---------------------------------------------------------------------------
console.log("\npaying through the restored channel");
const invoice = peer.create_invoice(10_000_000n, "paid after a restart");
node.pay_invoice(invoice);
check(await wait_for("the payment", () => events.includes("PaymentSent"), 60_000),
	"a payment settled through the restored channel");

const capacity_after = node.channel_manager.list_usable_channels()[0].get_outbound_capacity_msat();
check(capacity_after < capacity_before, "the balance moved (" + capacity_before + " -> " + capacity_after + " msat)");

net.stop();
node.stop();
peer.stop();
peer_net.stop();
await ws_proxy.close();
await chain_proxy.close();

console.log(failures == 0
	? "\nM4: a node restored from storage keeps its channel and can still pay.\n"
	: "\n" + failures + " check(s) failed\n");
process.exit(failures == 0 ? 0 : 1);
