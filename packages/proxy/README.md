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
