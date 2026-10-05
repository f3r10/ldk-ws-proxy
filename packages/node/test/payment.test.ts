/**
 * M4 end to end, in Node: open a channel over the WebSocket transport, fund it, confirm it,
 * and settle a payment through it.
 *
 * Both nodes are the full node from this package, so this exercises the chain sync, the
 * IndexedDB-shaped persistence layer (memory-backed here) and the event handling, with the
 * browser-side node reaching its peer the only way a browser can: WebSocket to the proxy to
 * TCP.
 *
 * Needs a regtest bitcoind with a funded wallet - the Polar network in docker/regtest. The
 * chain proxy is started in-process.
 */
import * as fs from "fs";
import { createRequire } from "module";
import * as ldk from "lightningdevkit";
import { NodeLDKNet } from "lightningdevkit-node-net";
import { WebSocket } from "ws";
import { start_proxy, start_chain_proxy } from "ldk-ws-proxy";
import { WsLdkNet, proxy_url } from "ldk-ws-descriptor";

import { start_full_node } from "../src/node.js";
import { ChainClient } from "../src/chain.js";
import { MemoryKv } from "../src/kv.js";
import { MONITOR_PREFIX } from "../src/persist.js";

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

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

await ldk.initializeWasmFromBinary(
	fs.readFileSync(require.resolve("lightningdevkit/liblightningjs.wasm")),
);

// --- infrastructure ------------------------------------------------------------------------
const chain_proxy = await start_chain_proxy({ port: 0, log: (l) => console.log("  [chain] " + l) });
const chain = new ChainClient("http://127.0.0.1:" + chain_proxy.port);
try {
	await chain.tip();
} catch (err) {
	console.log("\nNo regtest bitcoind reachable - start the Polar network first:");
	console.log("  cd ~/.polar/networks/<id> && USERID=$(id -u) GROUPID=$(id -g) docker compose up -d\n");
	process.exit(1);
}

const events: string[] = [];
const peer_events: string[] = [];

// The peer: a full node listening on TCP, standing in for the regtest Lightning node.
const peer_seed = new Uint8Array(32); peer_seed.fill(11);
const peer = await start_full_node({
	seed: peer_seed, chain, kv: new MemoryKv(), chain_poll_ms: 1000,
	log: (l) => console.log("  [peer] " + l),
	on_event: (name, detail) => { peer_events.push(name); console.log("  [peer event] " + name + " " + detail); },
});
const peer_net = new NodeLDKNet(peer.peer_manager);
let peer_port = 0;
for (let candidate = 20135; candidate < 20235; candidate++) {
	try { await peer_net.bind_listener("127.0.0.1", candidate); peer_port = candidate; break; } catch (_) {}
}
check(peer_port != 0, "peer node listening on TCP");

const ws_proxy = await start_proxy({ port: 0, allow: ["127.0.0.1:" + peer_port] });

// The browser-side node: same code a tab runs, reaching the peer over WebSocket.
const kv = new MemoryKv();
const browser_seed = new Uint8Array(32); browser_seed.fill(12);
const browser = await start_full_node({
	seed: browser_seed, chain, kv, chain_poll_ms: 1000,
	log: (l) => console.log("  [browser] " + l),
	on_event: (name, detail) => { events.push(name); console.log("  [browser event] " + name + " " + detail); },
});
const net = new WsLdkNet(browser.peer_manager, {
	web_socket_impl: WebSocket as unknown as new (url: string) => any,
});

const link = net.connect_link(proxy_url("ws://127.0.0.1:" + ws_proxy.port, "127.0.0.1", peer_port), peer.node_id, {});
await link.wait_connected();
check(await wait_for("the peers to connect", () => browser.peer_manager.list_peers().length == 1),
	"connected to the peer over WebSocket");

// --- open a channel ---------------------------------------------------------------------------
console.log("\nopening a 1,000,000 sat channel, pushing 300,000 sat to the peer");
browser.open_channel(peer.node_id, 1_000_000, 300_000_000);

check(await wait_for("the funding transaction", () => events.includes("FundingGenerationReady")),
	"LDK asked for a funding transaction");
check(await wait_for("the channel to be pending", () => events.includes("ChannelPending")),
	"the funding transaction was accepted and broadcast");

// The funding transaction needs confirmations; regtest only mines when told.
await sleep(1000);
await chain.mine(6);
check(await wait_for("channel_ready", () => events.includes("ChannelReady"), 90_000),
	"the channel confirmed and became usable");
check(await wait_for("the peer's side", () => peer_events.includes("ChannelReady"), 30_000),
	"the peer agrees the channel is ready");

const channels = browser.channel_manager.list_usable_channels();
check(channels.length == 1, "the browser node has one usable channel");
if (channels.length == 1) {
	console.log("  channel capacity: " + channels[0].get_channel_value_satoshis() + " sat, ours: " +
		channels[0].get_outbound_capacity_msat() + " msat");
}

// --- persistence ---------------------------------------------------------------------------------
const monitor_keys = await kv.list(MONITOR_PREFIX);
check(monitor_keys.length == 1, "a ChannelMonitor was persisted (" + monitor_keys.join(", ") + ")");
const monitor_bytes = await kv.get(monitor_keys[0]);
check(monitor_bytes !== undefined && monitor_bytes.length > 1000,
	"the monitor is a real serialised monitor (" + (monitor_bytes?.length ?? 0) + " bytes)");
await browser.persist_manager();
const manager_bytes = await kv.get("manager");
check(manager_bytes !== undefined && manager_bytes.length > 100,
	"the ChannelManager was persisted (" + (manager_bytes?.length ?? 0) + " bytes)");
check(browser.persist.in_flight == 0, "no monitor writes are still in flight");

// --- settle a payment ------------------------------------------------------------------------------
console.log("\npaying an invoice from the browser-side node");
const invoice = peer.create_invoice(50_000_000n, "M4: a payment from a browser tab");
console.log("  invoice: " + invoice.slice(0, 60) + "…");
browser.pay_invoice(invoice);

check(await wait_for("the payment to settle", () => events.includes("PaymentSent"), 60_000),
	"the payment settled from the payer's side");
check(await wait_for("the peer to claim", () => peer_events.includes("PaymentClaimed"), 30_000),
	"the peer claimed the payment");

const after = browser.channel_manager.list_usable_channels();
if (after.length == 1 && channels.length == 1) {
	const before_msat = channels[0].get_outbound_capacity_msat();
	const after_msat = after[0].get_outbound_capacity_msat();
	console.log("  outbound capacity: " + before_msat + " -> " + after_msat + " msat");
	check(after_msat < before_msat, "our balance went down by roughly the payment amount");
}

// --- and the other way --------------------------------------------------------------------------
console.log("\npaying an invoice issued by the browser-side node");
const browser_invoice = browser.create_invoice(20_000_000n, "M4: a payment into a browser tab");
peer.pay_invoice(browser_invoice);
check(await wait_for("the inbound payment", () => events.includes("PaymentClaimed"), 60_000),
	"the browser-side node received and claimed a payment");

net.stop();
browser.stop();
peer.stop();
peer_net.stop();
await ws_proxy.close();
await chain_proxy.close();

console.log(failures == 0
	? "\nM4: channel opened, funded, confirmed, and payments settled both ways.\n"
	: "\n" + failures + " check(s) failed\n");
process.exit(failures == 0 ? 0 : 1);
