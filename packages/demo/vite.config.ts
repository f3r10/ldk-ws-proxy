import { defineConfig } from "vite";

export default defineConfig({
	server: { port: 5173 },
	// The bindings are one big ESM file plus a 14 MB .wasm; pre-bundling them is slow and
	// buys nothing, and the linked workspace package should be served from source.
	optimizeDeps: { exclude: ["ldk-ws-descriptor", "lightningdevkit"] },
	build: { target: "es2022" },
});
