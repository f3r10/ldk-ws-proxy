import * as ldk from "lightningdevkit";
import wasm_url from "lightningdevkit/liblightningjs.wasm?url";
import { WsLdkNet, minimal_peer_manager, proxy_url, type WsConnection } from "ldk-ws-descriptor";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log_el = $<HTMLPreElement>("log");
const peers_el = $<HTMLUListElement>("peers");
const connect_btn = $<HTMLButtonElement>("connect");
const disconnect_btn = $<HTMLButtonElement>("disconnect");

function log(line: string): void {
	const stamp = new Date().toISOString().slice(11, 19);
	log_el.textContent += stamp + "  " + line + "\n";
	log_el.scrollTop = log_el.scrollHeight;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function from_hex(s: string): Uint8Array {
	const clean = s.trim().toLowerCase();
	if (!/^[0-9a-f]{66}$/.test(clean)) throw new Error("node id must be 66 hex characters");
	const out = new Uint8Array(33);
	for (let i = 0; i < 33; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	return out;
}

log("loading WASM (~14 MB, ~4.5 MB over the wire gzipped)…");
await ldk.initializeWasmWebFetch(wasm_url);
log("WASM ready");

// A fresh identity per page load. Real persistence is M4, and is consensus-critical:
// losing ChannelMonitor state loses money. Regtest only.
const seed = new Uint8Array(32);
crypto.getRandomValues(seed);

// Everything the node needs stays reachable from this object for the lifetime of the page.
// The bindings free Rust-side memory once JS drops the last reference to an object.
const node = minimal_peer_manager(seed, (line) => {
	if (line.includes("peer_handler")) log(line);
});
const net = new WsLdkNet(node.peer_manager, { log });
(globalThis as any).ldk_node = { node, net }; // also handy from the console

$<HTMLOutputElement>("our-node-id").textContent = hex(node.node_id);
log("our node id is " + hex(node.node_id));
connect_btn.disabled = false;

let conn: WsConnection | undefined;

connect_btn.addEventListener("click", async () => {
	connect_btn.disabled = true;
	try {
		const peer_id = from_hex($<HTMLInputElement>("pubkey").value);
		const base = $<HTMLInputElement>("proxy").value.trim();
		const host = $<HTMLInputElement>("host").value.trim();
		const port = Number($<HTMLInputElement>("port").value);
		// A Core Lightning node started with bind-addr=ws:... speaks the peer protocol over
		// WebSocket itself, so there is nothing to proxy.
		const url = $<HTMLInputElement>("direct").checked ? base : proxy_url(base, host, port);

		log("connecting to " + url);
		conn = await net.connect_peer(url, peer_id);
		disconnect_btn.disabled = false;
		await net.await_peer(peer_id);
		log("handshake and init exchange complete with " + hex(peer_id));
	} catch (err) {
		log("connect failed: " + (err instanceof Error ? err.message : String(err)));
		if (conn !== undefined && conn.close_code !== undefined) {
			log("socket closed with code " + conn.close_code + " " + (conn.close_reason ?? ""));
		}
		connect_btn.disabled = false;
	}
});

disconnect_btn.addEventListener("click", () => {
	conn?.close();
	disconnect_btn.disabled = true;
	connect_btn.disabled = false;
});

setInterval(() => {
	const peers = node.peer_manager.list_peers();
	peers_el.innerHTML = "";
	if (peers.length == 0) {
		const li = document.createElement("li");
		li.className = "empty";
		li.textContent = "none";
		peers_el.appendChild(li);
		if (conn !== undefined && !conn.is_connected) {
			disconnect_btn.disabled = true;
			connect_btn.disabled = false;
		}
		return;
	}
	for (const peer of peers) {
		const li = document.createElement("li");
		li.className = "connected";
		li.textContent = hex(peer.get_counterparty_node_id()) +
			(peer.get_is_inbound_connection() ? " (inbound)" : " (outbound)");
		peers_el.appendChild(li);
	}
}, 1000);
