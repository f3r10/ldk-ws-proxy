import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import NodeWorker from "./worker/node-worker.ts?worker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const STARTER = `// The peer is waiting. Open the connection, then wait until it is really there.
//
// Remember the two-step: a socket being open is not the same as a peer being connected.

`;

const SOLUTION = `// Open the connection. connect_link also reconnects if the socket drops,
// which is the normal condition for a browser tab.
const link = net.connect_link(peer_url, peer_id);

// The socket is open...
await link.wait_connected();
log("socket open — now the handshake runs");

// ...but the peer is not connected until BOLT-8 and init have both finished.
await net.await_peer(peer_id);
log("connected to " + peer_id_hex);
`;

const editor = new EditorView({
	doc: STARTER,
	extensions: [basicSetup, javascript(), oneDark, EditorView.lineWrapping],
	parent: $("editor"),
});

const console_el = $<HTMLPreElement>("console");
const wire_el = $<HTMLPreElement>("wire");
const checks_el = $<HTMLUListElement>("checks");

function append(el: HTMLPreElement, line: string): void {
	el.classList.remove("empty");
	el.textContent += line + "\n";
	el.scrollTop = el.scrollHeight;
}

function status(text: string, kind: string): void {
	const el = $("worker-status");
	el.textContent = text;
	el.className = "pill " + kind;
}

// The node lives in here, along with whatever the learner writes. Nothing it does can reach
// this page, and - the reason this matters for a tutorial - an infinite loop in lesson code
// hangs the worker, not the page, so we can kill it and carry on.
let worker: Worker;
let run_timer: ReturnType<typeof setTimeout> | undefined;
const RUN_TIMEOUT_MS = 30_000;

function spawn_worker(): void {
	worker = new NodeWorker();
	status("starting worker…", "warn");
	$<HTMLButtonElement>("run").disabled = true;

	worker.onmessage = (ev: MessageEvent) => {
		const msg = ev.data;
		if (msg.type === "ready") {
			status("LDK ready in worker", "ok");
			$<HTMLButtonElement>("run").disabled = false;
		} else if (msg.type === "log") {
			append(msg.channel === "wire" ? wire_el : console_el, msg.line);
		} else if (msg.type === "result") {
			finish_run();
			render_checks(msg.checks, msg.error);
			status(msg.ok ? "lesson passed" : "not yet", msg.ok ? "ok" : "warn");
		}
	};

	worker.onerror = (err) => {
		status("worker error", "bad");
		append(console_el, "worker error: " + err.message);
	};

	worker.postMessage({ type: "init" });
}

function finish_run(): void {
	if (run_timer !== undefined) clearTimeout(run_timer);
	run_timer = undefined;
	$<HTMLButtonElement>("run").disabled = false;
	$<HTMLButtonElement>("stop").disabled = true;
}

/** Kill the worker mid-run and start a fresh one. The page never stops responding. */
function stop_run(reason: string): void {
	worker.terminate();
	finish_run();
	append(console_el, reason);
	render_checks([], undefined);
	status("stopped", "bad");
	spawn_worker();
}

spawn_worker();

function render_checks(checks: Array<{ ok: boolean; label: string }>, error?: string): void {
	checks_el.innerHTML = "";
	if (error !== undefined) {
		const li = document.createElement("li");
		li.className = "bad";
		li.textContent = "your code threw: " + error.split("\n")[0];
		checks_el.appendChild(li);
	}
	if (checks.length == 0 && error === undefined) {
		checks_el.innerHTML = '<li class="empty">no checks ran</li>';
		return;
	}
	for (const check of checks) {
		const li = document.createElement("li");
		li.className = check.ok ? "ok" : "bad";
		li.textContent = check.label;
		checks_el.appendChild(li);
	}
	if (checks.length > 0 && checks.every((c) => c.ok)) {
		const li = document.createElement("li");
		li.className = "done";
		li.textContent = "Your browser is a Lightning peer. On to lesson 2.";
		checks_el.appendChild(li);
	}
}

$("stop").addEventListener("click", () => stop_run("stopped — the worker was terminated"));

$("run").addEventListener("click", () => {
	$<HTMLButtonElement>("run").disabled = true;
	$<HTMLButtonElement>("stop").disabled = false;
	run_timer = setTimeout(
		() => stop_run("timed out after " + RUN_TIMEOUT_MS / 1000 + "s — the worker was terminated"),
		RUN_TIMEOUT_MS,
	);
	console_el.textContent = "";
	wire_el.textContent = "";
	wire_el.classList.add("empty");
	checks_el.innerHTML = '<li class="empty">running…</li>';
	status("running…", "warn");

	worker.postMessage({
		type: "run",
		code: editor.state.doc.toString(),
		peer_id: $<HTMLInputElement>("peer").value.trim(),
		proxy: $<HTMLInputElement>("proxy").value.trim(),
		host: $<HTMLInputElement>("host").value.trim(),
		port: Number($<HTMLInputElement>("port").value),
	});
});

$("reveal").addEventListener("click", () => {
	editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: SOLUTION } });
});
