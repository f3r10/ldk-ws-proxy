import * as http from "http";

/**
 * A regtest chain backend for a browser Lightning node.
 *
 * A browser cannot talk to bitcoind: there is no CORS on its RPC, the credentials have no
 * business in a page, and `fetch` cannot speak the JSON-RPC auth bitcoind wants. So this
 * exposes the handful of chain operations a node actually needs, over CORS-enabled HTTP.
 *
 * Two groups of endpoints:
 *
 *   /chain/*  what any Lightning node needs: the tip, blocks by height, broadcast.
 *   /dev/*    a stand-in for an on-chain wallet: build and sign a funding transaction,
 *             mine blocks. Regtest only, and the reason this must never be exposed.
 *
 * In production the /chain half would be an Esplora instance and the /dev half would be a
 * real wallet in the page. This is a spike; both are bitcoind.
 */
export interface ChainProxyOptions {
	port?: number;
	host?: string;
	/** bitcoind JSON-RPC endpoint. */
	rpc_url?: string;
	rpc_user?: string;
	rpc_pass?: string;
	/** Wallet name for the /dev endpoints. Empty string is bitcoind's default wallet. */
	wallet?: string;
	/** Allow the /dev wallet endpoints at all. Default true; turn it off for anything real. */
	enable_dev?: boolean;
	log?: (line: string) => void;
}

export interface ChainProxyHandle {
	port: number;
	close(): Promise<void>;
}

export function start_chain_proxy(options: ChainProxyOptions = {}): Promise<ChainProxyHandle> {
	const rpc_url = options.rpc_url ?? "http://127.0.0.1:18443";
	const rpc_user = options.rpc_user ?? "polaruser";
	const rpc_pass = options.rpc_pass ?? "polarpass";
	const wallet = options.wallet ?? "";
	const enable_dev = options.enable_dev ?? true;
	const log = options.log ?? (() => {});
	const auth = "Basic " + Buffer.from(rpc_user + ":" + rpc_pass).toString("base64");

	let rpc_id = 0;
	async function rpc(method: string, params: unknown[] = [], use_wallet = false): Promise<any> {
		const url = use_wallet ? rpc_url + "/wallet/" + wallet : rpc_url;
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: auth },
			body: JSON.stringify({ jsonrpc: "1.0", id: "ldk-ws-" + rpc_id++, method, params }),
		});
		const text = await res.text();
		let body: any;
		try {
			body = JSON.parse(text);
		} catch (_) {
			throw new Error("bitcoind returned non-JSON (" + res.status + "): " + text.slice(0, 200));
		}
		if (body.error) throw new Error(method + ": " + JSON.stringify(body.error));
		return body.result;
	}

	const routes: Array<{
		method: string;
		pattern: RegExp;
		dev?: boolean;
		handle: (m: RegExpMatchArray, body: any) => Promise<unknown>;
	}> = [
		{
			method: "GET",
			pattern: /^\/chain\/tip$/,
			handle: async () => {
				const height: number = await rpc("getblockcount");
				const hash: string = await rpc("getblockhash", [height]);
				return { height, hash };
			},
		},
		{
			method: "GET",
			pattern: /^\/chain\/block-hash\/(\d+)$/,
			handle: async (m) => ({ hash: await rpc("getblockhash", [Number(m[1])]) }),
		},
		{
			// Whole blocks, which is what Listen::block_connected wants. Fine on regtest;
			// a mainnet node would use Confirm with an Esplora-style filtered view instead.
			method: "GET",
			pattern: /^\/chain\/block\/([0-9a-fA-F]{64})$/,
			handle: async (m) => ({ hex: await rpc("getblock", [m[1], 0]) }),
		},
		{
			method: "GET",
			pattern: /^\/chain\/header\/([0-9a-fA-F]{64})$/,
			handle: async (m) => ({ hex: await rpc("getblockheader", [m[1], false]) }),
		},
		{
			method: "POST",
			pattern: /^\/chain\/broadcast$/,
			handle: async (_m, body) => {
				if (typeof body?.hex !== "string") throw new Error("expected { hex }");
				return { txid: await rpc("sendrawtransaction", [body.hex]) };
			},
		},
		{
			method: "GET",
			pattern: /^\/chain\/tx\/([0-9a-fA-F]{64})$/,
			handle: async (m) => {
				try {
					const tx = await rpc("getrawtransaction", [m[1], true]);
					return {
						txid: tx.txid,
						confirmations: tx.confirmations ?? 0,
						block_hash: tx.blockhash ?? null,
					};
				} catch (_) {
					return { txid: m[1], confirmations: 0, block_hash: null };
				}
			},
		},

		// --- the on-chain wallet a browser does not have --------------------------------------
		{
			method: "POST",
			pattern: /^\/dev\/fund$/,
			dev: true,
			handle: async (_m, body) => {
				const script_hex: string = body?.script_hex;
				const amount_sat: number = body?.amount_sat;
				if (typeof script_hex !== "string" || typeof amount_sat !== "number") {
					throw new Error("expected { script_hex, amount_sat }");
				}
				// LDK hands us a scriptPubKey; bitcoind's wallet wants an address. decodescript
				// turns one into the other, so no bech32 implementation is needed here.
				const decoded = await rpc("decodescript", [script_hex]);
				const address: string | undefined = decoded.address ?? decoded.segwit?.address;
				if (address === undefined) {
					throw new Error("could not derive an address from script " + script_hex);
				}
				const btc = (amount_sat / 1e8).toFixed(8);
				const raw = await rpc("createrawtransaction", [[], [{ [address]: btc }]], true);
				const funded = await rpc("fundrawtransaction", [raw, { fee_rate: 10 }], true);
				const signed = await rpc("signrawtransactionwithwallet", [funded.hex], true);
				if (!signed.complete) throw new Error("wallet could not fully sign the funding tx");
				return { hex: signed.hex, address, amount_sat };
			},
		},
		{
			method: "POST",
			pattern: /^\/dev\/mine$/,
			dev: true,
			handle: async (_m, body) => {
				const blocks = Number(body?.blocks ?? 1);
				const address = await rpc("getnewaddress", [], true);
				return { hashes: await rpc("generatetoaddress", [blocks, address], true) };
			},
		},
	];

	const server = http.createServer((req, res) => {
		const send = (status: number, payload: unknown) => {
			const text = JSON.stringify(payload);
			res.writeHead(status, {
				"content-type": "application/json",
				// The page is served from a different origin (Vite on 5173), so without this
				// every request fails with an opaque CORS error rather than a useful one.
				"access-control-allow-origin": "*",
				"access-control-allow-headers": "content-type",
				"access-control-allow-methods": "GET, POST, OPTIONS",
			});
			res.end(text);
		};

		if (req.method === "OPTIONS") return send(204, {});

		const path = (req.url ?? "").split("?")[0];
		const route = routes.find((r) => r.method === req.method && r.pattern.test(path));
		if (route === undefined) return send(404, { error: "no route for " + req.method + " " + path });
		if (route.dev && !enable_dev) return send(403, { error: "dev endpoints are disabled" });

		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			let body: any = undefined;
			if (chunks.length > 0) {
				try {
					body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				} catch (_) {
					return send(400, { error: "body was not JSON" });
				}
			}
			route
				.handle(path.match(route.pattern)!, body)
				.then((payload) => send(200, payload))
				.catch((err: Error) => {
					log("error on " + path + ": " + err.message);
					send(502, { error: err.message });
				});
		});
	});

	return new Promise<ChainProxyHandle>((resolve, reject) => {
		let listening = false;
		server.on("error", (err) => {
			if (!listening) reject(err);
			else log("server error: " + err.message);
		});
		server.listen(options.port ?? 3002, options.host ?? "127.0.0.1", () => {
			listening = true;
			const addr = server.address();
			const port = typeof addr === "object" && addr !== null ? addr.port : 0;
			log("chain proxy on port " + port + " against " + rpc_url +
				(enable_dev ? " (dev wallet endpoints ENABLED - regtest only)" : ""));
			resolve({
				port,
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}
