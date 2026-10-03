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

- **LND**: use the proxy. `LDK_WS_PROXY_ALLOW="127.0.0.1:<p2p port>"`. This is the path that
  has actually been demonstrated, against LND 0.20.0-beta.
- **CLN**: add `bind-addr=ws:0.0.0.0:9736` to the node's advanced config, then tick "connect
  directly" in the demo and point it at `ws://127.0.0.1:9736`. No proxy involved.

Polar also gives you a funded wallet and a mining button, which is what M4 will need.

Two things that cost time the first time round:

```sh
# lncli inside the container: docker exec runs as root, whose ~/.lnd is empty
docker exec polar-n1-alice lncli --lnddir=/home/lnd/.lnd --network=regtest getinfo

# an LND whose chain has not mined recently reports synced_to_chain: false and will accept
# your connection without ever starting the peer - mine a block before blaming your code
B="docker exec polar-n1-backend1 bitcoin-cli -regtest -rpcuser=polaruser -rpcpassword=polarpass"
$B generatetoaddress 6 "$($B getnewaddress)"
```

Starting the network without opening the Polar GUI:

```sh
cd ~/.polar/networks/<id> && USERID=$(id -u) GROUPID=$(id -g) docker compose up -d
```

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
