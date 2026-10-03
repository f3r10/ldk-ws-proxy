import { start_proxy } from "./proxy.js";

const port = Number(process.env.LDK_WS_PROXY_PORT ?? 3001);
const host = process.env.LDK_WS_PROXY_HOST ?? "127.0.0.1";
const allow = process.env.LDK_WS_PROXY_ALLOW?.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

let handle;
try {
	handle = await start_proxy({ port, host, allow, log: (line) => console.log("[proxy] " + line) });
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	console.error("[proxy] could not start: " + message);
	if (message.includes("EADDRINUSE")) {
		console.error("[proxy] something is already listening on " + host + ":" + port +
			" - stop it, or set LDK_WS_PROXY_PORT");
	}
	process.exit(1);
}
console.log("[proxy] connect to ws://" + host + ":" + handle.port + "/v1/<host>/<port>");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		handle.close().then(() => process.exit(0));
	});
}
