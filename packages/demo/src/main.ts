import * as ldk from "lightningdevkit";
import wasm_url from "lightningdevkit/liblightningjs.wasm?url";
import { WsLdkNet, minimal_peer_manager, proxy_url, type PeerLink } from "ldk-ws-descriptor";

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

let link: PeerLink | undefined;
const status_el = $<HTMLOutputElement>("link-status");

function set_status(text: string, kind: string): void {
	status_el.textContent = text;
	status_el.className = kind;
}

connect_btn.addEventListener("click", async () => {
	connect_btn.disabled = true;
	let peer_id: Uint8Array;
	try {
		peer_id = from_hex($<HTMLInputElement>("pubkey").value);
	} catch (err) {
		log("bad input: " + (err instanceof Error ? err.message : String(err)));
		connect_btn.disabled = false;
		return;
	}

	const base = $<HTMLInputElement>("proxy").value.trim();
	const host = $<HTMLInputElement>("host").value.trim();
	const port = Number($<HTMLInputElement>("port").value);
	// A Core Lightning node started with bind-addr=ws:... speaks the peer protocol over
	// WebSocket itself, so there is nothing to proxy.
	const url = $<HTMLInputElement>("direct").checked ? base : proxy_url(base, host, port);

	// connect_link, not connect_peer: it reopens the socket by itself when the proxy is
	// restarted or the network drops, which is the normal condition for a browser tab.
	link = net.connect_link(url, peer_id, {});
	disconnect_btn.disabled = false;
	log("connecting to " + url);

	link.on_state = (state, detail) => {
		log("link " + state + ": " + detail);
		if (state === "connected") set_status("connected", "ok");
		else if (state === "waiting") set_status("reconnecting (attempt " + link!.attempts + ")", "warn");
		else if (state === "connecting") set_status("connecting…", "warn");
		else set_status("closed", "off");
	};

	try {
		await link.wait_connected();
		await net.await_peer(peer_id);
		log("handshake and init exchange complete with " + hex(peer_id));
	} catch (err) {
		log("connect failed: " + (err instanceof Error ? err.message : String(err)));
	}
});

disconnect_btn.addEventListener("click", () => {
	link?.close();
	link = undefined;
	disconnect_btn.disabled = true;
	connect_btn.disabled = false;
	set_status("not connected", "off");
});

setInterval(() => {
	const peers = node.peer_manager.list_peers();
	const queued = link?.connection?.queued_inbound_bytes ?? 0;
	if (queued > 0) log("inbound queue holding " + queued + " bytes (LDK asked us to pause)");

	peers_el.innerHTML = "";
	if (peers.length == 0) {
		const li = document.createElement("li");
		li.className = "empty";
		li.textContent = link === undefined ? "none" : "none (link " + link.state + ")";
		peers_el.appendChild(li);
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
