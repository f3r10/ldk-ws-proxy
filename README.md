# ldk-ws-descriptor

An LDK `SocketDescriptor` backed by a WebSocket, so a Lightning node can run in a browser tab.

LDK's TypeScript/WASM bindings give you `PeerManager`, but not a way to reach the network from
a browser: Lightning peers speak a binary protocol over raw TCP, and browsers cannot open TCP
sockets. The bindings' own README says you will need to bring your own bridge from
`SocketDescriptor` to a WebSocket proxy. This is that bridge, plus the proxy, plus a demo.

**Status: M2 reached.** A browser tab completes the BOLT-8 handshake and the `init` exchange
with a Lightning peer, and stays connected through ping/pong. Backpressure, reconnection and
anything involving channels are not done - see [Milestones](#milestones).

**Regtest only. Never point this at mainnet.** There is no persistence yet, and in Lightning
losing `ChannelMonitor` state loses money.

```
packages/descriptor/   the SocketDescriptor, the queue logic, connect_peer   (npm: ldk-ws-descriptor)
packages/proxy/        WebSocket-to-TCP relay                                (npm: ldk-ws-proxy)
packages/demo/         Vite app - the thing you screenshot
docs/ARCHITECTURE.md   how the pieces fit
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

Runs the whole path in one process: an LDK node listening over TCP via LDK's own
`lightningdevkit-node-net`, the proxy, and a second `PeerManager` driving our WebSocket
descriptor. It asserts that both sides see each other connected, that a target outside the
allowlist is refused, and that closing the socket reaches `socket_disconnected` on both ends.

## Using the descriptor

```ts
import * as ldk from "lightningdevkit";
import { WsLdkNet, proxy_url } from "ldk-ws-descriptor";

const net = new WsLdkNet(peer_manager);          // holds a 10s timer_tick_occurred
const url = proxy_url("ws://127.0.0.1:3001", "127.0.0.1", 9735);
const conn = await net.connect_peer(url, peer_node_id);   // resolves when the socket is open
await net.await_peer(peer_node_id);              // resolves when the peer is actually connected
```

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
- [ ] **M3** - real backpressure under load, inbound queue limits, reconnect with backoff
- [ ] **M4** - Esplora chain sync, IndexedDB persistence, open a channel, settle a payment
- [ ] **M5** - publish to npm, write it up

M3's machinery (water marks, `write_buffer_space_avail`, the read pause) is implemented but
has only been exercised at handshake volumes. It is not ticked until something has actually
pushed enough bytes through it to block.

## Prior art

- [`lightningdevkit-node-net`](https://github.com/lightningdevkit/ldk-garbagecollected/blob/0.2/node-net/net.mts) - LDK's own TCP implementation of this bridge. This package is a port of it.
- [Mutiny Wallet](https://github.com/MutinyWallet/mutiny-node) (archived) - a production browser Lightning wallet in Rust/WASM, and proof this works. Its descriptor ignored backpressure entirely.
- [`ln-websocket-proxy`](https://github.com/MutinyWallet/ln-websocket-proxy) - Mutiny's proxy, whose `/v1/<host>/<port>` URL shape this one copies.
- [`clams-tech/ln-ws-proxy`](https://github.com/clams-tech/ln-ws-proxy) - another WebSocket proxy, aimed at Core Lightning.

## Licence

MIT or Apache-2.0, matching LDK.
