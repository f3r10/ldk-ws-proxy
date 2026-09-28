# ldk-ws-descriptor

An LDK `SocketDescriptor` backed by a WebSocket, so a Lightning node can run in a browser tab.

```ts
import { WsLdkNet, proxy_url } from "ldk-ws-descriptor";

const net = new WsLdkNet(peer_manager);
await net.connect_peer(proxy_url("ws://127.0.0.1:3001", "127.0.0.1", 9735), peer_node_id);
await net.await_peer(peer_node_id);
```

Pairs with `ldk-ws-proxy`, or connects directly to a Core Lightning node started with
`bind-addr=ws:...`. Pin `lightningdevkit` to the exact version in the root README's version
table.

Regtest only. See the [repository README](../../README.md) and
[docs/GOTCHAS.md](../../docs/GOTCHAS.md).
