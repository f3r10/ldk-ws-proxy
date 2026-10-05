import { defineConfig } from "vite";

export default defineConfig({
	server: { port: 5174 },
	worker: { format: "es" },
	optimizeDeps: { exclude: ["ldk-ws-descriptor", "lightningdevkit"] },
	build: { target: "es2022" },
});
