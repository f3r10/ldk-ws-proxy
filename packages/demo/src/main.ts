import * as ldk from "lightningdevkit";
import wasm_url from "lightningdevkit/liblightningjs.wasm?url";
import { WsLdkNet, proxy_url, type PeerLink } from "ldk-ws-descriptor";
import { start_full_node, ChainClient, IndexedDbKv, type FullNode } from "ldk-ws-node";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log_el = $<HTMLPreElement>("log");
const peers_el = $<HTMLUListElement>("peers");
const channels_el = $<HTMLUListElement>("channels");

function log(line: string): void {
	const stamp = new Date().toISOString().slice(11, 19);
	log_el.textContent += stamp + "  " + line + "\n";
	log_el.scrollTop = log_el.scrollHeight;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function from_hex(s: string): Uint8Array {
	const clean = s.trim().toLowerCase();
	if (!/^[0-9a-f]{66}$/.test(clean)) throw new Error("node id must be 66 hex characters");
	const out = new Uint8Array(33);
	for (let i = 0; i < 33; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function status(id: string, text: string, kind: string): void {
	const el = $<HTMLOutputElement>(id);
	el.textContent = text;
	el.className = kind;
}

log("loading WASM (~14 MB, ~4.5 MB over the wire gzipped)…");
await ldk.initializeWasmWebFetch(wasm_url);
log("WASM ready");

// One identity per browser profile, kept in IndexedDB alongside the channel state. Losing it
// loses the channels, which on anything but regtest means losing money.
const kv = new IndexedDbKv();
let seed = await kv.get("seed");
if (seed === undefined) {
	seed = new Uint8Array(32);
	crypto.getRandomValues(seed);
	await kv.put("seed", seed);
	log("generated a new node identity");
} else {
	log("reusing the node identity already in IndexedDB");
}

const chain = new ChainClient($<HTMLInputElement>("chain-url").value.trim());
let node: FullNode;
try {
	node = await start_full_node({
		seed, chain, kv,
		log,
		on_event: (name, detail) => {
			log("event " + name + (detail ? ": " + detail : ""));
			if (name === "PaymentClaimed") $("payment-status").textContent = "received " + detail;
			if (name === "PaymentSent") $("payment-status").textContent = "payment settled";
			if (name === "PaymentFailed") $("payment-status").textContent = "payment failed";
			if (name === "ChannelReady") $("payment-status").textContent = "channel ready";
		},
	});
} catch (err) {
	log("could not start the node: " + (err instanceof Error ? err.message : String(err)));
	log("is the chain proxy running? npm run chain");
	throw err;
}

// Everything the node needs stays reachable from here for the lifetime of the page: the
// bindings free Rust-side memory as soon as JS drops the last reference.
const net = new WsLdkNet(node.peer_manager, { log });
(globalThis as any).ldk_node = { node, net, chain, kv };

$<HTMLOutputElement>("our-node-id").textContent = hex(node.node_id);
log("our node id is " + hex(node.node_id));
for (const id of ["connect", "open-channel", "mine", "create-invoice", "pay"]) {
	$<HTMLButtonElement>(id).disabled = false;
}

let link: PeerLink | undefined;

$("connect").addEventListener("click", async () => {
	$<HTMLButtonElement>("connect").disabled = true;
	let peer_id: Uint8Array;
	try {
		peer_id = from_hex($<HTMLInputElement>("pubkey").value);
	} catch (err) {
		log("bad input: " + (err instanceof Error ? err.message : String(err)));
		$<HTMLButtonElement>("connect").disabled = false;
		return;
	}
	const base = $<HTMLInputElement>("proxy").value.trim();
	const host = $<HTMLInputElement>("host").value.trim();
	const port = Number($<HTMLInputElement>("port").value);
	const url = $<HTMLInputElement>("direct").checked ? base : proxy_url(base, host, port);

	link = net.connect_link(url, peer_id, {});
	$<HTMLButtonElement>("disconnect").disabled = false;
	log("connecting to " + url);
	link.on_state = (state, detail) => {
		log("link " + state + ": " + detail);
		if (state === "connected") status("link-status", "connected", "ok");
		else if (state === "waiting") status("link-status", "reconnecting (attempt " + link!.attempts + ")", "warn");
		else if (state === "connecting") status("link-status", "connecting…", "warn");
		else status("link-status", "closed", "off");
	};
	try {
		await link.wait_connected();
		await net.await_peer(peer_id);
		log("handshake and init exchange complete");
	} catch (err) {
		log("connect failed: " + (err instanceof Error ? err.message : String(err)));
	}
});

$("disconnect").addEventListener("click", () => {
	link?.close();
	link = undefined;
	$<HTMLButtonElement>("disconnect").disabled = true;
	$<HTMLButtonElement>("connect").disabled = false;
	status("link-status", "not connected", "off");
});

$("open-channel").addEventListener("click", () => {
	try {
		const peer_id = from_hex($<HTMLInputElement>("pubkey").value);
		const sats = Number($<HTMLInputElement>("channel-sats").value);
		const push = Number($<HTMLInputElement>("push-msat").value);
		log("opening a " + sats + " sat channel (pushing " + push + " msat)");
		node.open_channel(peer_id, sats, push);
	} catch (err) {
		log("could not open a channel: " + (err instanceof Error ? err.message : String(err)));
	}
});

// Regtest only, and the honest version of "wait for confirmations".
$("mine").addEventListener("click", () => {
	void chain.mine(6).then(
		(hashes) => log("mined " + hashes.length + " blocks"),
		(err: Error) => log("could not mine: " + err.message),
	);
});

$("create-invoice").addEventListener("click", () => {
	try {
		const msat = BigInt($<HTMLInputElement>("invoice-msat").value);
		const invoice = node.create_invoice(msat, "paid into a browser tab");
		$<HTMLTextAreaElement>("invoice-out").value = invoice;
		log("created an invoice for " + msat + " msat");
	} catch (err) {
		log("could not create an invoice: " + (err instanceof Error ? err.message : String(err)));
	}
});

$("pay").addEventListener("click", () => {
	try {
		const invoice = $<HTMLTextAreaElement>("invoice-in").value.trim();
		if (invoice.length == 0) return;
		$("payment-status").textContent = "sending…";
		node.pay_invoice(invoice);
		log("payment sent to LDK");
	} catch (err) {
		$("payment-status").textContent = "failed to send";
		log("could not pay: " + (err instanceof Error ? err.message : String(err)));
	}
});

setInterval(() => {
	status("chain-status", "height " + node.chain_sync.height, "ok");

	const peers = node.peer_manager.list_peers();
	peers_el.innerHTML = "";
	if (peers.length == 0) {
		peers_el.innerHTML = '<li class="empty">' +
			(link === undefined ? "none" : "none (link " + link.state + ")") + "</li>";
	} else {
		for (const peer of peers) {
			const li = document.createElement("li");
			li.className = "connected";
			li.textContent = hex(peer.get_counterparty_node_id());
			peers_el.appendChild(li);
		}
	}

	const channels = node.channel_manager.list_channels();
	channels_el.innerHTML = "";
	if (channels.length == 0) {
		channels_el.innerHTML = '<li class="empty">none</li>';
		return;
	}
	for (const channel of channels) {
		const li = document.createElement("li");
		const usable = channel.get_is_usable();
		li.className = usable ? "connected" : "pending";
		const ours = channel.get_outbound_capacity_msat();
		const theirs = channel.get_inbound_capacity_msat();
		li.textContent = (usable ? "ready" : "pending") + " · " +
			channel.get_channel_value_satoshis() + " sat · ours " + ours +
			" msat · theirs " + theirs + " msat · " + hex(channel.get_counterparty().get_node_id()).slice(0, 16) + "…";
		channels_el.appendChild(li);
	}
}, 1000);
