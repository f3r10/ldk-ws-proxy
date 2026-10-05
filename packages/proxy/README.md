# ldk-ws-proxy

A WebSocket-to-TCP relay so a browser can reach a Lightning peer. One WebSocket in, one TCP
connection out, bytes piped both ways in order.

```sh
LDK_WS_PROXY_ALLOW="127.0.0.1:9735" npx ldk-ws-proxy
# then connect to ws://127.0.0.1:3001/v1/127.0.0.1/9735
```

| Env var | Default | Meaning |
|---|---|---|
| `LDK_WS_PROXY_PORT` | `3001` | Port to listen on |
| `LDK_WS_PROXY_HOST` | `127.0.0.1` | Interface to bind |
| `LDK_WS_PROXY_ALLOW` | loopback, any port | Comma-separated `host:port` targets; `*` for any port |

**An open proxy is an open TCP relay.** After the BOLT-8 handshake it carries only ciphertext,
but it sees every node address its clients connect to, and it will connect anywhere its
allowlist permits. Keep the allowlist tight and do not deploy an unrestricted one.

Browsers require `wss://` from an `https://` page; terminate TLS in front of this.

## The chain backend

`ldk-chain-proxy` (`npm run chain`) is a separate server in this package, for the browser node
in `packages/node`. A browser cannot talk to bitcoind - no CORS, and no reason to hand a page
RPC credentials - so this exposes what a node needs over CORS-enabled HTTP.

| Route | |
|---|---|
| `GET /chain/tip`, `/chain/block-hash/:height`, `/chain/block/:hash`, `/chain/tx/:txid` | what any node needs; an Esplora instance on a real chain |
| `POST /chain/broadcast` | |
| `POST /dev/fund`, `POST /dev/mine` | **regtest only**: builds and signs a funding transaction, mines blocks |

The `/dev` endpoints stand in for the on-chain wallet a browser does not have. They let anyone
who can reach them spend the bitcoind wallet, so they are loopback-only by default and can be
turned off entirely with `LDK_CHAIN_DEV=0`. Configure with `LDK_CHAIN_PORT`, `LDK_CHAIN_RPC`,
`LDK_CHAIN_RPC_USER`, `LDK_CHAIN_RPC_PASS`, `LDK_CHAIN_WALLET`.
