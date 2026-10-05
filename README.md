# ldk-ws-descriptor

An LDK `SocketDescriptor` backed by a WebSocket, so a Lightning node can run in a browser tab.

LDK's TypeScript/WASM bindings give you `PeerManager`, but not a way to reach the network from
a browser: Lightning peers speak a binary protocol over raw TCP, and browsers cannot open TCP
sockets. The bindings' own README says you will need to bring your own bridge from
`SocketDescriptor` to a WebSocket proxy. This is that bridge, plus the proxy, plus a demo.

**Status: M4 reached.** A browser tab completes the BOLT-8 handshake with a real Lightning
peer, survives the proxy being killed under it, opens a channel, settles payments both ways,
and keeps its channel across a page reload. Verified against LND 0.20 in Polar - see
[Milestones](#milestones).

**Regtest only. Never point this at mainnet.** Channel state lives in one browser profile's
IndexedDB with no backup behind it, and in Lightning losing `ChannelMonitor` state loses money.

```
packages/descriptor/   the SocketDescriptor, the queue logic, connect_peer   (npm: ldk-ws-descriptor)
packages/proxy/        WebSocket-to-TCP relay, and a regtest chain backend   (npm: ldk-ws-proxy)
packages/node/         a full node: chain sync, persistence, channels
packages/demo/         Vite app - the thing you screenshot
packages/tutorial/     side-by-side lesson: theory, an editor, and a real node
docs/ARCHITECTURE.md   how the pieces fit
docs/CURRICULUM.md     the eighteen lessons the tutorial is going to teach
docs/GOTCHAS.md        every surprise, with how it was found
```

## Quickstart

Three terminals, no Docker required - `ldk-ws-descriptor` ships a stand-in LDK peer that
listens on TCP, so you can see the whole path working before installing anything else.

```sh
npm install

npm run peer -w ldk-ws-descriptor      # prints the peer's node id; listens on 127.0.0.1:9735
LDK_WS_PROXY_ALLOW="127.0.0.1:9735" npm run proxy
npm run demo                            # http://localhost:5173
```

For channels and payments (M4) you also need a regtest bitcoind - see
[docker/regtest](docker/regtest/README.md) - and the chain backend:

```sh
npm run chain                           # bitcoind-backed, CORS-enabled, on :3002
```

There is also a tutorial prototype - theory on one side, an editor on the other, and a real
node in a Web Worker that grades what you write against live protocol state:

```sh
npm run tutorial                        # http://localhost:5174
```

Paste the peer's node id into the page and press Connect. The log fills with:

```
descriptor 0: socket open to ws://127.0.0.1:3001/v1/127.0.0.1/9735
lightning::ln::peer_handler: Finished noise handshake for connection with 02c798…
lightning::ln::peer_handler: Enqueueing message Init { features: […] } to 02c798…
lightning::ln::peer_handler: Received peer Init message from 02c798…
handshake and init exchange complete with 02c798…
```

and a `Ping`/`Pong` pair every few seconds after that.

### Against a real node

With [Polar](https://lightningpolar.com), start a regtest network and read the node's pubkey
and listening address from its info panel.

- **LND**: keep the proxy. Set the peer host/port to the node's P2P address and allow it:
  `LDK_WS_PROXY_ALLOW="127.0.0.1:9735"`. Verified against LND 0.20.0-beta: the tab shows up in
  `lncli listpeers` and stays there.
  If the connection stalls right after "Finished noise handshake", check
  `lncli getinfo | grep synced_to_chain` - an LND whose regtest chain has not mined recently
  considers itself out of sync and never starts the peer. Mine a block and it connects
  immediately. See [GOTCHAS.md](docs/GOTCHAS.md#14).
- **Core Lightning**: add `bind-addr=ws:0.0.0.0:9736` to the node's config and skip the proxy
  entirely - tick "connect directly" in the demo and point it at `ws://127.0.0.1:9736`. CLN
  speaks the peer protocol over WebSocket natively.

### Tests

```sh
npm test
```

Three suites, about 40 seconds:

- **handshake** - the whole path in one process: an LDK node listening over TCP via LDK's own
  `lightningdevkit-node-net`, the proxy, and a second `PeerManager` driving our WebSocket
  descriptor. Both sides see each other connected, a target outside the allowlist is refused,
  and closing the socket reaches `socket_disconnected` on both ends.
- **backpressure** - the water marks, `write_buffer_space_avail`, the read pause and the
  inbound queue cap, driven with a fake socket whose congestion the test controls.
- **reconnect** - the proxy is killed under a live connection and restarted; the link backs
  off and comes back.

```sh
npm run soak -w ldk-ws-descriptor               # 120s by default
SOAK_SECONDS=1800 npm run soak -w ldk-ws-descriptor   # the real 30-minute idle test
```

## Using the descriptor

```ts
import * as ldk from "lightningdevkit";
import { WsLdkNet, proxy_url } from "ldk-ws-descriptor";

const net = new WsLdkNet(peer_manager);          // holds a 10s timer_tick_occurred
const url = proxy_url("ws://127.0.0.1:3001", "127.0.0.1", 9735);

// Reopens itself with exponential backoff whenever the socket dies. Use this for anything
// long-lived; link.state is the transport's state, link.close() stops reconnecting.
const link = net.connect_link(url, peer_node_id);
link.on_state = (state, detail) => console.log(state, detail);
await link.wait_connected();                     // the socket is up
await net.await_peer(peer_node_id);              // the peer is actually connected

// Or one-shot, if you want to own the retry policy yourself:
const conn = await net.connect_peer(url, peer_node_id);
```

Tuning, all optional: `high_water_mark` / `low_water_mark` (when to stop and resume taking
bytes), `max_inbound_bytes` (how much to queue while LDK has reads paused before hanging up),
`timer_tick_ms`, and the backoff settings on `connect_link`.

`connect_peer` resolves once the transport is up and the first handshake bytes are away, which
is not the same as being connected - a proxy that refuses your target still opens the
WebSocket and then closes it with code 1008. Use `await_peer` for the real thing, and check
`conn.close_code` when it times out.

Hold onto `net` and anything you passed it for as long as the node runs. The bindings free
Rust-side memory when JS drops its last reference.

## Versions

Pin these exactly. The bindings track LDK releases and break between them.

| Package | Version | Corresponds to |
|---|---|---|
| `lightningdevkit` | `0.2.5-0` | LDK `v0.2.5-37-g6accd2acaff8f94f`, LDK-C-Bindings `v0.2.5.0` |

The exact LDK commit is printed to the console when the WASM initialises. Trust that over any
version table, including this one.

## Security and privacy

The proxy is the part to think about before deploying anything.

- After the BOLT-8 handshake the proxy sees only ciphertext. It cannot read your messages.
- It *does* see which node ids and addresses you connect to. That is a real metadata leak, and
  it is inherent to the design, not a bug to be fixed later.
- **An open proxy is an open TCP relay.** It defaults to loopback-only, both for what it binds
  and for what it will connect to (`LDK_WS_PROXY_ALLOW`). Keep it that way, or restrict it to
  your regtest network. Do not deploy an unrestricted one to the public internet.
- Browsers require `wss://` from an `https://` page. Terminate TLS in front of the proxy.

## Browser requirements

`FinalizationRegistry` and `WeakRef` (Chrome 84+, Firefox 79+, Safari 14.1+/iOS 14.5+), and
WASM BigInt (Chrome 85+, Firefox 78+, Safari 14.1+). The WASM payload is 4.5 MB gzipped.

## Milestones

- [x] **M1** - WebSocket-to-TCP proxy with an allowlist
- [x] **M2** - handshake and `init` exchange from a browser tab, against LDK and against LND 0.20
- [x] **M3** - backpressure under load, inbound queue limits, reconnect with backoff
- [x] **M4** - chain sync, IndexedDB persistence, open a channel, settle a payment
- [ ] **M5** - publish to npm, write it up

Beyond the milestones, [docs/FUTURE-WORK.md](docs/FUTURE-WORK.md) specs six follow-on tasks in
enough detail to hand to someone (or something) with no memory of this repo: Esplora/`Confirm`
chain sync, VSS storage, LSPS2 JIT channels, async payments, a tutorial page that runs a real
node in the reader's browser, and an integration with
[f3r10/lightning-ecommerce](https://github.com/f3r10/lightning-ecommerce).

What M3 is ticked on: the water marks, `write_buffer_space_avail` and the read pause are
exercised by tests that actually block and resume them; reconnect is demonstrated by killing
the proxy under a live connection, in Node and in the browser against LND; and the idle
question was answered by a real 30-minute soak (zero drops, 15 ping/pong rounds).

What M4 is ticked on, against a Polar LND node: a 1,000,000 sat channel opened from the tab,
confirmed, a 50,000 sat invoice paid to LND, 20,000 sat received back, and - after reloading
the page - another 25,000 sat paid through the same channel restored from IndexedDB. LND
reports all of them `SETTLED`.

Two honest caveats about how M4 is done here:

- **Chain sync feeds whole blocks.** Correct, and fine on regtest; hopeless on mainnet, which
  is what `Confirm` and `lightning-transaction-sync`'s Esplora client are for. The TypeScript
  bindings do not expose that crate, so a mainnet version of this would have to implement the
  filtered path by hand.
- **The funding transaction is built and signed by regtest bitcoind**, through a dev endpoint
  on the chain proxy. A browser has no on-chain wallet; supplying one is a separate project
  (BDK in WASM), not a detail of this spike.

## Prior art

- [`lightningdevkit-node-net`](https://github.com/lightningdevkit/ldk-garbagecollected/blob/0.2/node-net/net.mts) - LDK's own TCP implementation of this bridge. This package is a port of it.
- [Mutiny Wallet](https://github.com/MutinyWallet/mutiny-node) (archived) - a production browser Lightning wallet in Rust/WASM, and proof this works. Its descriptor ignored backpressure entirely.
- [`ln-websocket-proxy`](https://github.com/MutinyWallet/ln-websocket-proxy) - Mutiny's proxy, whose `/v1/<host>/<port>` URL shape this one copies.
- [`clams-tech/ln-ws-proxy`](https://github.com/clams-tech/ln-ws-proxy) - another WebSocket proxy, aimed at Core Lightning.

## Licence

MIT or Apache-2.0, matching LDK.
