/// <reference lib="webworker" />
/**
 * The learner's node, and the learner's code, both inside a Web Worker.
 *
 * Why a worker: LDK needs `WebSocket`, `fetch`, `IndexedDB`, `crypto` and
 * `FinalizationRegistry`, all of which exist here, and none of which need the DOM. Putting the
 * node here keeps a 14 MB WASM init off the UI thread, keeps learner code away from the page,
 * and makes a runaway loop recoverable with worker.terminate().
 *
 * LDK objects cannot cross the worker boundary - they are handles into WASM memory - so the
 * learner's code has to run on this side, next to the node, and only strings come back.
 */
import * as ldk from "lightningdevkit";
import wasm_url from "lightningdevkit/liblightningjs.wasm?url";
import { WsLdkNet, proxy_url, minimal_peer_manager } from "ldk-ws-descriptor";

type ToWorker =
	| { type: "init" }
	| { type: "run"; code: string; peer_id: string; proxy: string; host: string; port: number }
	| { type: "reset" };

type FromWorker =
	| { type: "ready"; ldk_version: string }
	| { type: "log"; channel: "console" | "wire"; line: string }
	| { type: "result"; ok: boolean; error?: string; checks: Array<{ ok: boolean; label: string }> };

const post = (msg: FromWorker) => (self as unknown as Worker).postMessage(msg);
const log = (line: string) => post({ type: "log", channel: "console", line });
const wire = (line: string) => post({ type: "log", channel: "wire", line });

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function from_hex(s: string): Uint8Array {
	const clean = s.trim().toLowerCase();
	if (!/^[0-9a-f]{66}$/.test(clean)) throw new Error("peer id must be 66 hex characters");
	const out = new Uint8Array(33);
	for (let i = 0; i < 33; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	return out;
}

let initialised = false;
/** Rebuilt for every run, so a lesson always starts from a known state. */
let session: { node: ReturnType<typeof minimal_peer_manager>; net: WsLdkNet } | undefined;

function teardown(): void {
	if (session === undefined) return;
	session.net.stop();
	session = undefined;
}

function build_session(): NonNullable<typeof session> {
	const seed = new Uint8Array(32);
	crypto.getRandomValues(seed);
	const node = minimal_peer_manager(seed, (line) => {
		// LDK's own trace is the point of the exercise: the learner watches the handshake and
		// the init exchange happen in response to their code.
		if (line.includes("peer_handler")) wire(line.replace(/^.*peer_handler: /, ""));
	});
	const net = new WsLdkNet(node.peer_manager, { log });
	return { node, net };
}

/**
 * The surface the learner's code is given. Deliberately small: this is lesson one, and the
 * interesting part is that every one of these is the real thing.
 */
function lesson_api(peer_id: Uint8Array, proxy: string, host: string, port: number) {
	const s = session!;
	return {
		ldk,
		node: s.node,
		net: s.net,
		peer_id,
		peer_id_hex: hex(peer_id),
		proxy_url,
		/** The URL of the peer, through the WebSocket proxy. */
		peer_url: proxy_url(proxy, host, port),
		log,
		sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
	};
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
	const msg = ev.data;

	if (msg.type === "init") {
		if (initialised) return post({ type: "ready", ldk_version: "already loaded" });
		log("loading LDK (about 4.5 MB over the wire)…");
		const started = performance.now();
		await ldk.initializeWasmWebFetch(wasm_url);
		initialised = true;
		log("LDK ready, in a Web Worker (" + Math.round(performance.now() - started) + "ms)");
		// The bindings print the exact LDK commit to the console during init; there is no
		// exported accessor for it, so do not pretend there is.
		post({ type: "ready", ldk_version: "0.2.5-0" });
		return;
	}

	if (msg.type === "reset") {
		teardown();
		log("session reset");
		return;
	}

	if (msg.type === "run") {
		teardown();
		// Note what this does *not* do: reload the WASM. A run rebuilds the node, which is
		// milliseconds; only a terminated worker pays the full init again.
		const built = performance.now();
		session = build_session();
		log("fresh node built in " + Math.round(performance.now() - built) + "ms");
		const checks: Array<{ ok: boolean; label: string }> = [];
		try {
			const peer_id = from_hex(msg.peer_id);
			log("your node id is " + hex(session.node.node_id));

			const api = lesson_api(peer_id, msg.proxy, msg.host, msg.port);
			const fn = new AsyncFunction("api", "const { " + Object.keys(api).join(", ") + " } = api;\n" + msg.code);
			await fn(api);

			// --- the lesson's assertions, against real protocol state -------------------------
			const peers = session.node.peer_manager.list_peers();
			checks.push({ ok: peers.length > 0, label: "your node has a connected peer" });
			const matched = peers.some((p) => hex(p.get_counterparty_node_id()) === hex(peer_id));
			checks.push({ ok: matched, label: "the peer is the one you were asked to connect to" });
			const outbound = peers.some((p) => !p.get_is_inbound_connection());
			checks.push({ ok: outbound, label: "you opened the connection (it is outbound)" });

			post({ type: "result", ok: checks.every((c) => c.ok), checks });
		} catch (err) {
			post({
				type: "result",
				ok: false,
				error: err instanceof Error ? (err.stack ?? err.message) : String(err),
				checks,
			});
		}
		return;
	}
};
