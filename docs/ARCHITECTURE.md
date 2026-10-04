# Architecture

## The problem

Lightning peers speak a binary protocol over raw TCP, encrypted with the BOLT-8 Noise_XK
handshake. Browsers cannot open raw TCP sockets.

LDK is transport-agnostic on purpose: `PeerManager` owns the protocol state machine - the
handshake, encryption, message framing, ping/pong, backpressure - but does not own sockets. It
reaches the network through the `SocketDescriptor` trait, which the embedder implements. LDK's
own `lightningdevkit-node-net` implements it over Node's `net` sockets, in 188 lines. This
repo is the same idea over a WebSocket.

## The pieces

```
  browser tab                         server                         peer
 ┌───────────────────────┐        ┌──────────────┐          ┌──────────────────┐
 │ PeerManager (WASM)    │        │  ldk-ws-proxy│          │ LND / CLN / LDK  │
 │   │                   │        │              │          │                  │
 │   ├─ send_data ──────►│  ws    │  ws ──► tcp  │   tcp    │                  │
 │   │                   │═══════►│              │═════════►│  :9735           │
 │   └─ read_event ◄─────│◄═══════│  tcp ──► ws  │◄═════════│                  │
 │      WsSocketDescriptor        │              │          │                  │
 └───────────────────────┘        └──────────────┘          └──────────────────┘
        packages/demo              packages/proxy
        packages/descriptor
```

`packages/descriptor` is the only part with any subtlety. The proxy is a byte pipe. The demo
is a form and a log pane.

A Core Lightning node started with `bind-addr=ws:0.0.0.0:<port>` speaks the peer protocol over
WebSocket itself, so the middle box disappears entirely and the browser connects straight to
the node. The demo has a "connect directly" checkbox for that.

## What the descriptor has to get right

`WsLdkNet` owns a `PeerManager` and a set of `WsConnection`s. Each `WsConnection` owns one
WebSocket and the `SocketDescriptor` LDK holds for it.

**Outbound.** `send_data(data, continue_read)` returns how many bytes we took ownership of.
While the socket is `OPEN` a WebSocket `send()` takes the whole frame, so we take everything
and return `data.length`. Once `bufferedAmount` passes the high water mark we stop taking
bytes, return `0` (LDK buffers them for us), poll until the buffer drains, then call
`write_buffer_space_avail`. If the socket is not `OPEN` we return `0` rather than pretending.

**Inbound.** Bytes arrive in whatever chunking the proxy and the WebSocket layer produce; one
frame is not one Lightning message. We push each chunk onto a queue and feed it to
`read_event` in order, calling `process_events` after each one. WebSocket has no pause
primitive, so when LDK asks us to stop reading (`continue_read` unset) we stop draining the
queue and let it grow until LDK asks for more.

**Identity.** Each connection gets a monotonic integer at construction; `eq` and `hash` derive
from it and from nothing mutable, because LDK keys hash maps on them.

**Lifetime.** The TS bindings free Rust-side memory when JS drops its last reference
(`FinalizationRegistry` + `WeakRef`). `WsLdkNet` holds every live connection, each connection
holds its descriptor, and `minimal_peer_manager` returns a `_roots` array holding the message
handlers that nothing else references. Letting any of these go unreachable while LDK still
knows about them is a use-after-free.

**Teardown.** `socket_disconnected` fires exactly once per connection, from `onclose` or
`onerror`, guarded by a flag.

**Reconnection.** `WsConnection` is one socket and dies with it. `PeerLink` sits above it and
reopens the socket with exponential backoff (500ms doubling to 30s, 25% jitter) until told to
stop, which is what makes a tab survivable: a laptop lid, a sleeping radio, a redeployed
proxy. A connection has to last 10s before it resets the backoff, so a server that accepts and
immediately closes cannot produce a hot loop. `link.state` describes the transport, not the
Lightning peer.

The ordering and re-entrancy rules behind these choices are in [GOTCHAS.md](GOTCHAS.md).

## How the hard parts are tested

Three of these behaviours only happen under conditions a loopback handshake never produces, so
the tests go at them from different directions:

| | How |
|---|---|
| Handshake, `init`, disconnect | The real stack: LDK's own `node-net` peer over TCP, the proxy, our descriptor. Nothing of ours on the far side. |
| Backpressure, read pause, queue cap | A fake WebSocket whose `bufferedAmount` the test controls, and a stand-in `PeerManager` that follows LDK's contract - believe the count, keep the remainder, wait for `write_buffer_space_avail`. The `SocketDescriptor` is real, so calls still cross into WASM. |
| Reconnect | The real stack, with the proxy killed mid-connection and restarted on the same port. |
| Idle survival | An opt-in soak (`npm run soak`), run for a real 30 minutes at the real 10s tick. |

The fake-socket tests exist because congesting a real loopback socket on demand is not
something you can do reliably, and a test that only passes when the machine is busy is worse
than no test.

## What is deliberately absent

No `ChannelManager`, `ChainMonitor`, `NetworkGraph`, chain sync, or persistence. None of them
sit on the path between a browser tab and a connected peer, and leaving them out is what keeps
the milestone honest. They arrive with M4, along with the hard parts: Esplora sync and
IndexedDB persistence of `ChannelMonitor` state, which is consensus-critical - losing it loses
money.

## The proxy's trust position

After the BOLT-8 handshake the proxy carries ciphertext it cannot read. It does see which node
addresses you connect to, and it is a TCP relay for whatever its allowlist permits. Both
points are covered in the README's security section.
