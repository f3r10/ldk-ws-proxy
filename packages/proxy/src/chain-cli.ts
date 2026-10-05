import { start_chain_proxy } from "./chain.js";

const port = Number(process.env.LDK_CHAIN_PORT ?? 3002);
const host = process.env.LDK_CHAIN_HOST ?? "127.0.0.1";
const rpc_url = process.env.LDK_CHAIN_RPC ?? "http://127.0.0.1:18443";
const rpc_user = process.env.LDK_CHAIN_RPC_USER ?? "polaruser";
const rpc_pass = process.env.LDK_CHAIN_RPC_PASS ?? "polarpass";
const wallet = process.env.LDK_CHAIN_WALLET ?? "";
const enable_dev = process.env.LDK_CHAIN_DEV !== "0";

const handle = await start_chain_proxy({
	port, host, rpc_url, rpc_user, rpc_pass, wallet, enable_dev,
	log: (line) => console.log("[chain] " + line),
}).catch((err: Error) => {
	console.error("[chain] could not start: " + err.message);
	process.exit(1);
});

console.log("[chain] http://" + host + ":" + handle.port + "/chain/tip");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		handle.close().then(() => process.exit(0));
	});
}
