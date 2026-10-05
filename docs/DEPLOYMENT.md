# Deploying the tutorial

What it takes to put `packages/tutorial` on the public internet, with Next.js as the example
front end. The page is the easy half; the Lightning peer behind it is the half that decides
your hosting bill.

Verified while writing this: the production bundle builds, serves with
`Content-Type: application/wasm`, and passes lesson 1 from a built bundle rather than the dev
server. WASM init on a warm cache is **37ms**; building a fresh node per run is **12ms**. The
cost is download, not compile.

---

## The page

### Why Next.js at all

Not for a technical reason - the Vite build already works. The reason is
[f3r10/lightning-ecommerce](https://github.com/f3r10/lightning-ecommerce) already ships
`@lightning-ecommerce/nextjs`, so a Next.js tutorial shares a component library, a deploy
pipeline and a domain with the thing it is teaching people to build. If that alignment does not
matter to you, deploy the Vite build to any static host and skip this section.

### What has to change

**1. Everything is client-only.** There is no WASM and no Web Worker on the server. Load the
workbench through `next/dynamic` with `ssr: false`; the theory pane can stay a server component
and should, because it is the part search engines will read.

```tsx
const Workbench = dynamic(() => import("../components/Workbench"), { ssr: false });
```

**2. The worker.** Next supports the standard form:

```ts
new Worker(new URL("../workers/node-worker.ts", import.meta.url), { type: "module" });
```

This works under webpack 5. Check it under Turbopack on whatever Next version you pick before
building anything on top of it - that is a ten-minute check and a bad afternoon if you skip it.

**3. The WASM file.** Do not try to `import` it. Copy it into `public/` at build time and
`fetch` it, which is what `initializeWasmWebFetch` wants anyway:

```json
"scripts": {
  "prebuild": "cp node_modules/lightningdevkit/liblightningjs.wasm public/liblightningjs-0.2.5-0.wasm"
}
```

Put the version in the filename. The file is 14.5 MB (4.5 MB over the wire) and never changes
for a given binding version, so it should be cached forever:

```js
// next.config.js
async headers() {
  return [{
    source: "/liblightningjs-:version.wasm",
    headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
  }];
}
```

**4. Do not add COOP/COEP.** The reflex with WASM is to set
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` for `SharedArrayBuffer`. This module
does not need them - checked: no `pthread`, no atomics, no shared memory, just
`wasi_snapshot_preview1` and the bindings' own callbacks. Adding them would break embedding and
third-party resources for nothing.

### What it costs

A cold visitor downloads ~4.5 MB (WASM) + ~600 KB (app and worker JS, gzipped). On Vercel's
free tier's 100 GB/month that is roughly 20,000 cold loads; returning visitors cost nothing
because of the cache header above. The page itself is static and can sit on any CDN.

---

## The part Vercel cannot host

**A tutorial with no Lightning peer teaches nothing, and you cannot run the peer on Vercel.**
Serverless functions are request-scoped; a Lightning node and a WebSocket-to-TCP relay are both
long-lived processes holding sockets open. You need one small always-on machine - Hetzner, Fly,
Railway, a DigitalOcean droplet, anything with a public IP.

### The simplest topology that works

```
  learner's browser ──wss──► Caddy (TLS) ──► Core Lightning, bind-addr=ws:
       (Vercel/CDN)                          one container, signet or regtest
```

**One Core Lightning node with `bind-addr=ws:0.0.0.0:9736`, behind a reverse proxy that
terminates TLS.** CLN speaks the peer protocol over WebSocket natively, so there is no proxy of
ours in the picture at all, and one component disappears from the thing you have to operate.

If the peer must be LND (or anything else that only speaks TCP), put `ldk-ws-proxy` in front of
it and give it an allowlist containing exactly that one node:

```sh
LDK_WS_PROXY_HOST=0.0.0.0 LDK_WS_PROXY_ALLOW="10.0.0.5:9735" npx ldk-ws-proxy
```

### The thing that will bite you first

**An `https://` page cannot open a `ws://` socket.** Browsers block it as mixed content, with an
error that does not say so clearly. The moment the tutorial leaves localhost it needs `wss://`,
which means a real certificate in front of the peer. Caddy does this in two lines; Cloudflare
will also do it, but check that WebSocket upgrades pass through on your plan.

This is also why the `peer settings` box in the lesson defaults to `ws://127.0.0.1:3001`: it is
a local-development default, and the deployed build must ship a `wss://` one.

### Operating it

- **Never deploy the proxy without an allowlist.** The default is loopback-only for a reason:
  an open one is an open TCP relay, and someone will find it.
- **Cap connections per IP.** Every learner opens a socket; a bored one opens ten thousand.
  Caddy or nginx can do this without touching our code.
- **The peer accumulates connections, not state.** Learners get a fresh random node id per run
  and never open channels in Part 1 or 2, so nothing persists and nothing needs resetting. CLN
  handles hundreds of peers without complaint.
- **Watch the peer's log** for the first week. It is the only place a learner's mistake becomes
  visible to you.

### Which lessons this supports

All of Part 1 and Part 2 - ten lessons - need exactly the box above. Part 3 adds a chain
backend, a funding wallet and per-learner channel state, which is a different operational
problem; see [CURRICULUM.md](CURRICULUM.md).

---

## A deployment checklist

1. `npm run build -w ldk-ws-tutorial` locally and open the built bundle, not the dev server.
   Worker and WASM handling differ between the two, and this is where that shows up.
2. Stand up the peer: one CLN container, `bind-addr=ws:`, TLS in front, firewall everything
   else.
3. Point the lesson's default peer settings at `wss://your-peer` and the real node id.
4. Deploy the page as a static/Next build with the WASM in `public/` and the cache header set.
5. Load it in a private window on a phone. That is where the 4.5 MB download and any
   Safari/iOS WASM problem will show up, and both are better found by you than by a reader.
