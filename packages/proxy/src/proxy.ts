import * as net from "net";
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";

export interface ProxyOptions {
	/** Port to listen on. 0 picks a free one; read it back from `ProxyHandle.port`. */
	port?: number;
	/** Interface to bind. Defaults to loopback - see the security note in the README. */
	host?: string;
	/**
	 * Which TCP endpoints clients may reach, as `host:port` entries. `*` as the port means
	 * any port on that host. Defaults to loopback only.
	 *
	 * An unrestricted proxy is an open TCP relay. Do not deploy one.
	 */
	allow?: string[];
	/** Pause the TCP socket once the WebSocket has this many bytes buffered. Default 1 MiB. */
	high_water_mark?: number;
	log?: (line: string) => void;
}

export interface ProxyHandle {
	port: number;
	close(): Promise<void>;
}

const DEFAULT_ALLOW = ["127.0.0.1:*", "localhost:*", "[::1]:*"];

/** `/v1/<host>/<port>` - the path format Mutiny's `ln-websocket-proxy` used. */
function parse_target(url: string | undefined): { host: string; port: number } | undefined {
	if (url === undefined) return undefined;
	const path = url.split("?")[0];
	const parts = path.split("/").filter((p) => p.length > 0);
	if (parts.length != 3 || parts[0] !== "v1") return undefined;
	const host = decodeURIComponent(parts[1]);
	const port = Number(parts[2]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	return { host, port };
}

function is_allowed(allow: string[], host: string, port: number): boolean {
	return allow.some((entry) => {
		const idx = entry.lastIndexOf(":");
		if (idx < 0) return false;
		const allow_host = entry.slice(0, idx);
		const allow_port = entry.slice(idx + 1);
		if (allow_host !== host) return false;
		return allow_port === "*" || Number(allow_port) === port;
	});
}

/**
 * A WebSocket-to-TCP relay: one WebSocket in, one TCP connection to a Lightning peer out,
 * bytes piped both ways in order.
 *
 * After the BOLT-8 handshake everything crossing this process is ciphertext it cannot read.
 * It does see which node addresses a client connects to, which is a real metadata leak.
 */
export function start_proxy(options: ProxyOptions = {}): Promise<ProxyHandle> {
	const allow = options.allow ?? DEFAULT_ALLOW;
	const high_water_mark = options.high_water_mark ?? 1024 * 1024;
	const log = options.log ?? (() => {});

	const server = http.createServer((_req, res) => {
		res.writeHead(426, { "content-type": "text/plain" });
		res.end("This endpoint speaks WebSocket only: connect to /v1/<host>/<port>\n");
	});
	const wss = new WebSocketServer({ server });
	const sockets = new Set<net.Socket>();

	wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
		const target = parse_target(req.url);
		if (target === undefined) {
			log("rejecting connection with bad path " + req.url);
			ws.close(1008, "expected /v1/<host>/<port>");
			return;
		}
		if (!is_allowed(allow, target.host, target.port)) {
			log("rejecting disallowed target " + target.host + ":" + target.port);
			ws.close(1008, "target not allowed");
			return;
		}

		const tag = target.host + ":" + target.port;
		log("opening TCP connection to " + tag);
		const socket = net.createConnection({ host: target.host, port: target.port });
		socket.setNoDelay(true);
		sockets.add(socket);

		// The WebSocket is buffering faster than the peer reads: stop reading from TCP.
		let drain_timer: ReturnType<typeof setInterval> | undefined;

		const cleanup = () => {
			if (drain_timer !== undefined) clearInterval(drain_timer);
			drain_timer = undefined;
			sockets.delete(socket);
			socket.destroy();
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
		};

		socket.on("connect", () => log("connected to " + tag));

		socket.on("data", (chunk: Buffer) => {
			if (ws.readyState !== WebSocket.OPEN) return;
			ws.send(chunk);
			if (ws.bufferedAmount > high_water_mark && drain_timer === undefined) {
				socket.pause();
				drain_timer = setInterval(() => {
					if (ws.readyState !== WebSocket.OPEN) { cleanup(); return; }
					if (ws.bufferedAmount > high_water_mark / 4) return;
					clearInterval(drain_timer);
					drain_timer = undefined;
					socket.resume();
				}, 25);
			}
		});

		socket.on("error", (err: Error) => {
			log("TCP error on " + tag + ": " + err.message);
			cleanup();
		});
		socket.on("close", () => {
			log("TCP connection to " + tag + " closed");
			cleanup();
		});

		ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], is_binary: boolean) => {
			if (!is_binary) return; // the peer protocol is binary only
			const buf = Array.isArray(data)
				? Buffer.concat(data)
				: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
			// Flow control the other way: stop reading frames until the kernel takes them.
			if (!socket.write(buf)) {
				ws.pause();
				socket.once("drain", () => ws.resume());
			}
		});
		ws.on("close", () => {
			log("WebSocket for " + tag + " closed");
			cleanup();
		});
		ws.on("error", (err: Error) => {
			log("WebSocket error for " + tag + ": " + err.message);
			cleanup();
		});
	});

	return new Promise<ProxyHandle>((resolve, reject) => {
		let listening = false;
		// `ws` re-emits the HTTP server's errors on the WebSocketServer, and an 'error' event
		// with no listener takes the process down - so a port already in use crashes rather
		// than rejecting this promise. Both emitters need a handler.
		const on_error = (err: Error) => {
			if (!listening) {
				reject(err);
				return;
			}
			log("server error: " + err.message);
		};
		server.on("error", on_error);
		wss.on("error", on_error);

		server.listen(options.port ?? 3001, options.host ?? "127.0.0.1", () => {
			listening = true;
			const addr = server.address();
			const port = typeof addr === "object" && addr !== null ? addr.port : 0;
			log("proxy listening on port " + port + ", allowing " + allow.join(", "));
			resolve({
				port,
				close: () =>
					new Promise<void>((done) => {
						for (const socket of Array.from(sockets)) socket.destroy();
						for (const client of wss.clients) client.terminate();
						wss.close(() => server.close(() => done()));
					}),
			});
		});
	});
}
