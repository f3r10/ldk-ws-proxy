# ldk-ws-node

A full LDK node for the browser: chain sync, channel state in IndexedDB, channels and
payments. Built on `ldk-ws-descriptor` for transport and `ldk-chain-proxy` for the chain.

```ts
const node = await start_full_node({ seed, chain: new ChainClient("http://127.0.0.1:3002"), kv: new IndexedDbKv() });
const net = new WsLdkNet(node.peer_manager);
net.connect_link(proxy_url("ws://127.0.0.1:3001", "127.0.0.1", 9735), peer_id);

node.open_channel(peer_id, 1_000_000, 300_000_000);
node.pay_invoice("lnbcrt…");
const invoice = node.create_invoice(20_000_000n, "paid into a browser tab");
```

**Regtest only.** Channel state is consensus-critical and IndexedDB is one browser profile's
local storage with no backup behind it. Losing a `ChannelMonitor` loses money.

Private to this repo - it is a demo node, not a library anyone should depend on yet. See the
[repository README](../../README.md) and [docs/GOTCHAS.md](../../docs/GOTCHAS.md).
