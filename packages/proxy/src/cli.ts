import { start_proxy } from "./proxy.js";

const port = Number(process.env.LDK_WS_PROXY_PORT ?? 3001);
const host = process.env.LDK_WS_PROXY_HOST ?? "127.0.0.1";
const allow = process.env.LDK_WS_PROXY_ALLOW?.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

const handle = await start_proxy({ port, host, allow, log: (line) => console.log("[proxy] " + line) });
console.log("[proxy] connect to ws://" + host + ":" + handle.port + "/v1/<host>/<port>");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		handle.close().then(() => process.exit(0));
	});
}
