# A regtest peer to talk to

Three options, cheapest first.

## 1. No peer at all (what the quickstart uses)

```sh
npm run peer -w ldk-ws-descriptor
```

A plain LDK node listening on TCP via `lightningdevkit-node-net`, with a fixed node id. It
completes the handshake and `init`, and rejects every channel message. That is enough for M2
and it needs nothing installed. It is not enough for M4.

## 2. Polar (recommended for anything beyond M2)

[Polar](https://lightningpolar.com) gives you a GUI regtest network with bitcoind and your
choice of LND, CLN or Eclair, with node pubkeys and ports visible in the UI.

- **LND**: use the proxy. `LDK_WS_PROXY_ALLOW="127.0.0.1:<p2p port>"`.
- **CLN**: add `bind-addr=ws:0.0.0.0:9736` to the node's advanced config, then tick "connect
  directly" in the demo and point it at `ws://127.0.0.1:9736`. No proxy involved.

Polar also gives you a funded wallet and a mining button, which is what M4 will need.

## 3. docker-compose

`compose.yml` here starts bitcoind in regtest and one Core Lightning node with the WebSocket
listener enabled, so the browser can reach it with no proxy at all.

```sh
docker compose -f docker/regtest/compose.yml up -d
docker compose -f docker/regtest/compose.yml exec cln lightning-cli --regtest getinfo
```

Take `id` from that output as the peer node id, tick "connect directly" in the demo, and use
`ws://127.0.0.1:9736`.

> Not yet run end to end - the demo was verified against option 1 and is documented for
> Polar. Treat this file as a starting point and fix it in place when you use it.
