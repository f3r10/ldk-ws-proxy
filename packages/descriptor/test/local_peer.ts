/**
 * A stand-in Lightning peer for local development: a plain LDK node listening on TCP via
 * LDK's own `lightningdevkit-node-net`, printing its node id.
 *
 * It is not a full node - it will reject any channel message - but it completes the BOLT-8
 * handshake and the `init` exchange, which is all M2 is about. Use it when you do not feel
 * like starting Polar; point the demo at a real LND or CLN node for the real screenshot.
 *
 *   npm run peer -w ldk-ws-descriptor -- [port]
 */
import * as fs from "fs";
import { createRequire } from "module";
import * as ldk from "lightningdevkit";
import { NodeLDKNet } from "lightningdevkit-node-net";
import { minimal_peer_manager } from "../src/minimal_node.js";

const require = createRequire(import.meta.url);
const port = Number(process.argv[2] ?? 9735);

await ldk.initializeWasmFromBinary(fs.readFileSync(require.resolve("lightningdevkit/liblightningjs.wasm")));

const seed = new Uint8Array(32);
seed.fill(42); // fixed, so the node id is stable across restarts
const peer = minimal_peer_manager(seed);
const net = new NodeLDKNet(peer.peer_manager);
await net.bind_listener("127.0.0.1", port);

const node_id = Array.from(peer.node_id, (b) => b.toString(16).padStart(2, "0")).join("");
console.log("local peer listening on 127.0.0.1:" + port);
console.log("node id: " + node_id);

let last = 0;
setInterval(() => {
	const peers = peer.peer_manager.list_peers();
	if (peers.length != last) {
		last = peers.length;
		console.log(
			new Date().toISOString().slice(11, 19) + "  connected peers: " +
			peers.map((p) => Array.from(p.get_counterparty_node_id(), (b) => b.toString(16).padStart(2, "0")).join("")).join(", ") ||
			"(none)",
		);
	}
}, 500);
