# Future work

Six tasks, each written to be handed to an agent that starts with no memory of how this repo
came to be. Each is self-contained: why it exists, what is already built, the exact API surface
(verified against the installed bindings, not recalled), a plan, and what "done" means.

**Read first, whatever the task:** [ARCHITECTURE.md](ARCHITECTURE.md) and
[GOTCHAS.md](GOTCHAS.md). The gotchas are not trivia - most of them are a day each if you
rediscover them.

---

## Shared context

```
packages/descriptor/   SocketDescriptor over WebSocket, reconnect   (M1-M3, published shape)
packages/proxy/        ws→tcp relay + regtest chain backend          (M1, M4)
packages/node/         full node: chain sync, persistence, channels  (M4)
packages/demo/         Vite page that runs the node                  (M2-M4)
```

Pinned: `lightningdevkit@0.2.5-0` → LDK `v0.2.5-37-g6accd2acaff8f94f`, C bindings `v0.2.5.0`.
The exact LDK commit prints to the console on init; trust that over any table.

**Rules that apply to every task below.**

1. **Verify API shapes against `node_modules/lightningdevkit/structs/*.d.mts` before writing
   code.** The bindings track LDK closely and most second-hand documentation (including LDK's
   own doc comments on `Persist`) describes older APIs. Several gotchas in this repo exist only
   because something was assumed.
2. **Never return `Completed` from a persistence path that has not completed.** See
   [GOTCHAS 22](GOTCHAS.md). This is the one class of bug here that costs money rather than
   time.
3. **Hold strong references.** The bindings free Rust-side memory when JS drops the last
   reference. Anything long-lived goes on a long-lived object (see `_roots` in
   `packages/node/src/node.ts`).
4. **Read callback arguments before awaiting.** Objects handed to a binding callback are not
   guaranteed to outlive it.
5. **Tests go against real counterparties where possible.** The existing suites run LDK's own
   `lightningdevkit-node-net` on the far side so that both ends are not our code. Keep that.
6. **Add to GOTCHAS.md as you go**, with how the surprise was found. It is the most valuable
   artifact in the repo after the code.
7. **Regtest/signet only.** Nothing here is safe on mainnet, and the README says so; keep it
   true.

Commit style: one logical change per commit, message body says *why*, not what the diff shows.

---

## Task 1 — Chain sync that works off regtest (`Confirm` + Esplora)

**Size:** 3-5 days. **Blocks:** Tasks 3, 4, 6. Do this first if anything needs a public network.

### Why

`packages/node/src/chain.ts` feeds **whole blocks** to `Listen::block_connected`. That is
correct, and it is the right choice on regtest where blocks are tiny and appear on command. It
does not survive contact with a real network: a wallet offline for a day must replay thousands
of blocks, each fetched in full.

LDK's answer is the `Confirm` interface plus a filtered view of the chain, which is what
`lightning-transaction-sync`'s Esplora client implements in Rust. **The TypeScript bindings do
not expose that crate**, so this has to be written by hand. That is the single biggest gap
between this project and a usable browser wallet.

Good news that makes this worth doing now: **Mutinynet's Esplora sends
`access-control-allow-origin: *`** (verified: `curl -I https://mutinynet.com/api/blocks/tip/height`),
so a browser can sync from it directly with no server-side chain component at all. The
`/chain/*` half of `ldk-chain-proxy` becomes regtest-only convenience.

### Verified API surface

```ts
// Both ChainMonitor and ChannelManager expose both interfaces:
chain_monitor.as_Confirm(); channel_manager.as_Confirm();

// Confirm (structs/Confirm.d.mts)
transactions_confirmed(header: Uint8Array /* 80 bytes */, txdata: TwoTuple_usizeTransactionZ[], height: number): void;
transaction_unconfirmed(txid: Uint8Array): void;
best_block_updated(header: Uint8Array, height: number): void;
get_relevant_txids(): ThreeTuple_ThirtyTwoBytesu32COption_ThirtyTwoBytesZZ[];  // (txid, height, block_hash)

// Filter (structs/Filter.d.mts) - pass as Option_FilterZ.constructor_some(...) to ChainMonitor
register_tx(txid: Uint8Array, script_pubkey: Uint8Array): void;
register_output(output: WatchedOutput): void;
```

`ChainMonitor.constructor_new` takes `Option_FilterZ` as its first argument; we currently pass
`constructor_none()` because whole-block sync needs no filter.

### Plan

1. Implement a `Filter` that records registered txids and outpoints (`WatchedOutput` carries
   the outpoint and script).
2. Implement an Esplora client: `/blocks/tip/height`, `/blocks/tip/hash`, `/block-height/:h`,
   `/block/:hash/header`, `/tx/:txid`, `/tx/:txid/hex`, `/tx/:txid/merkle-proof` (gives the
   position needed for `txdata`), `/scripthash/:hash/txs` (to spot spends of watched outputs -
   note Esplora wants the scripthash reversed).
3. Implement the sync loop in the order LDK requires, which is **not** obvious: gather
   `get_relevant_txids()` from every `Confirm`, check each for reorg/unconfirmation, then
   deliver `transactions_confirmed` in **block order, ascending**, then
   `best_block_updated` last. Read the Rust `lightning-transaction-sync` source as the
   reference implementation; it exists precisely because this ordering is easy to get wrong.
4. Keep the whole-block `Listen` path for regtest, selectable. Do not delete it: it is simpler,
   it is what the existing tests use, and it is a useful teaching contrast.

### Acceptance

- A node syncs against Mutinynet's Esplora from a browser with no chain proxy running.
- A node that was offline across hundreds of blocks catches up without fetching every block.
- The existing regtest suites (`npm run test -w ldk-ws-node`) still pass on the `Listen` path.
- A new test: fund a channel, take the node offline, mine past the funding confirmation, bring
  it back, confirm the channel becomes usable without a full block replay.

### Risks

Reorg handling in `Confirm` is subtler than in `Listen` - a transaction can unconfirm without
any block being disconnected. Lean on the Rust implementation rather than inventing the logic.

---

## Task 2 — VSS storage backend

**Size:** 1-2 days plus server setup. **Depends on:** nothing. **Start here if you want a win.**

### Why

Channel state currently lives in IndexedDB: one browser profile, no backup, and "clear site
data" loses channels. Losing a `ChannelMonitor` loses money. VSS (Versioned Storage Service) is
LDK's answer - a small server that stores encrypted, versioned blobs.

It also fixes a problem nobody has hit yet but will: **two tabs open on the same wallet** would
currently corrupt each other's state silently. VSS's versioning makes that a detectable
conflict instead.

### What exists

`packages/node/src/kv.ts` defines the only seam the node has to storage:

```ts
export interface KvStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

`MemoryKv` and `IndexedDbKv` implement it. A `VssKv` slots in beside them and **nothing else in
the node changes** - the async `InProgress` persistence path already assumes writes take time.

### VSS API

From [vss-server](https://github.com/lightningdevkit/vss-server), `api/src/proto/vss.proto`:

- `GetObject(store_id, key)`
- `PutObject(store_id, global_version?, transaction_items[], delete_items[])` - batched, with
  optimistic concurrency on `global_version`
- `DeleteObject(store_id, ...)`
- `ListKeyVersions(store_id, key_prefix?, page_size?, page_token?)`
- `KeyValue { key, version, value }`, `Storable { data }`,
  `EncryptionMetadata { cipher_format, nonce, tag }`

Client-side encryption is part of the format, so the server stores ciphertext it cannot read.

### Plan

1. Stand up `vss-server` (it needs a database behind it) and decide authentication. LNURL-auth
   or a JWT keyed to the node id are the usual choices; pick one and write down why.
2. Implement `VssKv implements KvStore` with AES-GCM via WebCrypto (`crypto.subtle`), key
   derived from the node seed - **never** send the seed. Match `vss-rust-client`'s
   `cipher_format` string so a Rust client could read the same store.
3. Track `global_version` and surface a conflict as a distinct error type, not a generic
   failure. A conflict means another tab or device wrote; the right response is to stop, not
   retry blindly.
4. Add a `KvStore` that writes to IndexedDB **and** VSS, treating the write as complete only
   when both land. Local-only is fast but not durable; remote-only breaks when offline.

### Acceptance

- `packages/node`'s existing restart test passes with `VssKv` substituted for `MemoryKv`.
- A node restored on a *different browser profile* from the same VSS store keeps its channel
  and can still pay. This is the whole point; do not skip it.
- Two nodes writing the same store produce a detected version conflict, not silent corruption.
- The VSS server never sees plaintext (check by reading a row directly out of its database).

### Non-goals

Do not implement VSS *server* features. Do not try to wrap `KVStoreSync` from the bindings - it
is synchronous and a network store cannot be.

---

## Task 3 — LSPS2 client: JIT channels

**Size:** 1-2 weeks. **Depends on:** Task 1 if you want this off regtest.
**Counterparty: already exists** - see the integration note below.

### Why

The biggest hack in this repo is `POST /dev/fund` in `packages/proxy/src/chain.ts`: regtest
bitcoind builds and signs the funding transaction because a browser has no on-chain wallet.
LSPS2 is the principled fix. The LSP opens a zero-conf channel when the first payment arrives
and takes its fee from that payment, so a tab can receive Lightning from a cold start with no
on-chain funds, no funding transaction, and no waiting for confirmations.

For a browser wallet this is not a nice-to-have. It is the difference between "first, acquire
some regtest coins" and "open this page and get paid".

### The counterparty problem is already solved

`lightning-liquidity` is **not** bound in the TypeScript bindings (verified: no LSPS structs
exist), and neither LND nor CLN speaks LSPS2, so there would normally be nothing to test
against. But **f3r10/lightning-ecommerce already runs one**: its `lsp-service` is an ldk-node
instance with `enable_liquidity_provider(LSPS2ServiceConfig { .. })` listening on TCP 9737.

Put `ldk-ws-proxy` in front of it and a browser tab can speak LSPS2 to a real LSP locally:

```
browser tab ──ws──► ldk-ws-proxy ──tcp──► lsp-service (ldk-node, LSPS2 service)
```

Clone that repo, read `lsp-service/src/main.rs` for the fee parameters it advertises, and use
`payer-cli` and `node-service` as reference clients - `node-service` calls
`receive_via_jit_channel`, which is the Rust equivalent of what you are building.

### Verified API surface

LSPS2 rides on BOLT-8 **custom messages** (bLIP-50/52: JSON-RPC inside custom message type
37913). The plumbing is bound, even though the protocol is not:

```ts
// structs/Type.d.mts - implement an outbound custom message
ldk.Type.new_impl({ type_id(): number, write(): Uint8Array, debug_str(): string });

// structs/CustomMessageReader.d.mts - parse inbound ones
read(message_type: number, buffer: Uint8Array): Result_COption_TypeZDecodeErrorZ;

// structs/CustomMessageHandler.d.mts
handle_custom_message(msg: Type, sender_node_id: Uint8Array): Result_NoneLightningErrorZ;
get_and_clear_pending_msg(): TwoTuple_PublicKeyTypeZ[];
provided_node_features(): NodeFeatures;
```

`packages/node/src/node.ts` currently passes `IgnoringMessageHandler` for custom messages -
that is where this goes.

Zero-conf acceptance needs `UserConfig` changes (`manually_accept_inbound_channels`) and
handling `Event_OpenChannelRequest`, which the event handler does not cover yet.

### Plan

1. Read bLIP-52 (LSPS2). Implement the two client calls: `lsps2.get_info` and `lsps2.buy`.
2. Implement `CustomMessageHandler` + `CustomMessageReader` for type 37913, with the JSON-RPC
   envelope. Keep the protocol layer separate from LDK plumbing so it can be tested without a
   node.
3. Turn on `manually_accept_inbound_channels`, handle `Event_OpenChannelRequest`, and accept
   the zero-conf channel **only** from the LSP node id you bought the channel from. Accepting
   zero-conf from anyone is a way to lose money.
4. Wire it into invoice creation: the invoice must carry the LSP's routing hint with the
   `jit_channel_scid` the LSP returned, not a real channel id.
5. Surface the LSP fee in the demo before the user commits to anything.

### Acceptance

- A browser tab with **no channel and no on-chain funds** creates an invoice, something pays
  it, the LSP opens a zero-conf channel, and the payment settles into the tab.
- The tab refuses a zero-conf channel from a node id that is not the LSP.
- `/dev/fund` is no longer needed for the receive path (it stays for the "open a channel
  yourself" lesson).

### Risks

Fee and expiry handling in `lsps2.buy` has real money consequences on a public network. On
regtest/signet the failure mode is noise; write the checks as if it were not.

---

## Task 4 — Async payments: receive while the tab is closed

**Size:** 3-5 days. **Depends on:** nothing technically, but it is the least load-bearing.

### Why

A browser tab is offline most of the time, which is the deepest problem with the whole idea of
a browser wallet. Async payments (BOLT 12) are the ecosystem's answer: the recipient publishes
an offer whose blinded paths terminate at an always-online server, the sender's HTLC is held,
and the payment completes when the recipient reappears.

Status, from [LDK's post](https://lightningdevkit.org/blog/async-payments-receiving-while-offline):
**beta**, "not yet recommended for production", sender-side flows unmerged, and **LDK-to-LDK
only** today. So build it as a demonstration and a tutorial lesson, not as wallet
infrastructure - and do not expect LND to be the counterparty.

### Verified API surface

Both roles are fully bound, which is better than the blog post's "refer to the implementation
guide" suggests:

```ts
// Recipient (the tab)
channel_manager.set_paths_to_static_invoice_server(paths: BlindedMessagePath[]): Result_NoneNoneZ;
channel_manager.get_async_receive_offer(): Result_OfferNoneZ;
// structs/AsyncReceiveOfferCache.d.mts

// Always-online static invoice server
channel_manager.blinded_paths_for_async_recipient(recipient_id, relative_expiry): Result_CVec_BlindedMessagePathZNoneZ;
channel_manager.static_invoice_persisted(invoice_persisted_path: Responder): void;
// Events: Event_StaticInvoiceRequested { recipient_id, invoice_slot, reply_path: Responder, invoice_request }
//         Event_PersistStaticInvoice { invoice, invoice_request_path, invoice_slot, recipient_id, invoice_persisted_path }
```

**The one real piece of work:** async payments ride on onion messages, and
`packages/node/src/node.ts` currently passes `IgnoringMessageHandler` for those. You need a
real `OnionMessenger`:

```ts
ldk.OnionMessenger.constructor_new(entropy_source, node_signer, logger,
  channel_manager.as_NodeIdLookUp(), message_router, channel_manager.as_OffersMessageHandler(),
  channel_manager.as_AsyncPaymentsMessageHandler(), dns_resolver, custom_handler);
```

Everything it wants, `ChannelManager` already provides. Then pass
`onion_messenger.as_OnionMessageHandler()` to the `PeerManager` instead of the ignoring one.

### Plan

1. Wire the `OnionMessenger` first and prove ordinary BOLT 12 works (`create_offer_builder`,
   `pay_for_offer`) between two of our nodes. Do not start on async payments until a plain
   offer payment settles.
2. Make `packages/node` able to run as the **static invoice server**: handle
   `Event_PersistStaticInvoice` (store it, then call `static_invoice_persisted` with the
   responder) and `Event_StaticInvoiceRequested` (reply with the stored invoice). The existing
   Node.js-side node is the natural host - it is already always-on in the tests.
3. Browser side: `set_paths_to_static_invoice_server`, then `get_async_receive_offer` to show
   the user an offer that works while the tab is shut.
4. Demo: close the tab, pay the offer, reopen the tab, watch it settle.

### Acceptance

- A plain BOLT 12 offer payment settles between two of our nodes.
- An async payment to a **closed** browser tab settles when the tab is reopened, with the
  Node-side node acting as static invoice server.
- The held-HTLC flow is visible in the logs on both sides, because that is the teaching value.

### Non-goals

Do not try to interoperate with LND. Do not build the sender side beyond what LDK gives you.

---

## Task 5 — Side-by-side tutorial: theory and a live node

**Status: prototyped and working.** `packages/tutorial` is lesson one, end to end. Read this
section for the design, but the open questions below are now answered - see "What the spike
settled".

**Size:** 2-3 days for the first lesson; the curriculum is open-ended.

### Why

Every piece of this repo was built by discovering something the docs got wrong, and
`GOTCHAS.md` is 27 entries of exactly the material a Lightning course needs. The unique asset:
**a real node runs in the reader's page**. Not a mock, not a recording - genuine BOLT-8,
genuine channels. Three things follow:

- The wire is visible. LDK's log already prints `Finished noise handshake`,
  `Enqueueing message Init { features: … }`, `Received message Ping`. Theory on the left, the
  reader's own bytes on the right.
- Lessons grade themselves against real protocol state (`list_peers()`, `list_channels()`, the
  event stream) rather than string-matching output.
- Failure teaches. A learner who returns `data.length` from `send_data` and drops bytes watches
  the peer disconnect with a decryption error.

### Architecture

```
main thread                      Web Worker                     your infra
┌──────────────────┐            ┌──────────────────┐           ┌─────────────┐
│ theory pane      │            │ LDK WASM         │           │ ws proxy    │
│ Monaco editor    │ ◄─postMsg─►│ node + learner   │ ◄──ws───► │ CLN or LND  │
│ run / assertions │            │ code             │ ◄──http──►│ Esplora     │
└──────────────────┘            └──────────────────┘           └─────────────┘
```

Put the node **and** the learner's code in a Web Worker: everything LDK needs exists there
(`WebSocket`, `fetch`, `IndexedDB`, `crypto`, `FinalizationRegistry`), the UI stays responsive
through a 14 MB WASM init, learner code cannot touch the page, and a runaway loop is one
`worker.terminate()` away. **Verify the worker assumption first** - it is half a day and the
whole design rests on it. LDK objects cannot cross a worker boundary (they are handles into
WASM memory), so the node must live on the same side as the code using it.

Monaco over CodeMirror, for one reason: feed it `lightningdevkit`'s `.d.mts` files and learners
get real autocomplete over the LDK API. Load a curated subset per lesson - there are 1,624
struct definitions.

### Lesson tiers, by what they cost to host

| Tier | Needs | Lessons |
|---|---|---|
| 1 - transport | one WS proxy + one peer | connect, read `init` features, answer a ping, **implement `send_data` yourself** |
| 2 - channels | + chain backend, LSP | open a channel, confirm it, create an invoice, settle a payment |

**Start with tier 1.** A single CLN node with `bind-addr=ws:` serves every learner with no proxy
at all. It also contains the best lesson in the set: have the learner implement the
`SocketDescriptor` contract and grade it with `packages/descriptor/test/backpressure.test.ts`,
which already drives a fake congested socket and checks the byte stream comes out intact.

### Acceptance for the first slice

One lesson, end to end: theory pane, editor, run button, and one assertion against real
protocol state ("you are connected and have exchanged `init`"). If the feel is wrong you have
lost two evenings, not a month.

### What the spike settled

- **LDK runs in a Web Worker.** This was the assumption everything rested on. It holds.
- **Re-running is cheap, and the risk below was wrong.** A run does not reload the WASM: the
  worker keeps it and only rebuilds the node object graph, measured at **5ms**. The 14 MB init
  (a few seconds) is paid once per worker, and again only if a worker is terminated. Teardown
  between runs is `net.stop()` plus dropping the session.
- **A runaway loop is survivable.** `while (true) {}` hangs the worker, not the page. Stop
  terminates it and a fresh worker is ready a moment later; a 30s timeout does the same
  automatically.
- **Grading on live protocol state works, and fails correctly.** Code that opens the socket
  without awaiting the peer gets three red crosses while the wire pane shows the handshake
  happening - which is the lesson made visible.

### Remaining risks

- **Assertions run when the learner's function returns**, so the contract is "when your code
  returns, the peer is connected". A learner who writes `connect_link(...)` then
  `await sleep(3000)` passes without understanding. That is a false positive, and arguably
  they did satisfy the contract - but lesson design has to account for it.
- First load is 4.5 MB gzipped.
- Safari and iOS still need checking (IndexedDB quirks, WASM memory limits).
- Editor is CodeMirror. Monaco fed the `lightningdevkit` `.d.mts` files is the upgrade and the
  real differentiator; the spike did not need it to answer the question.

---

## Task 6 — Combine with `f3r10/lightning-ecommerce`

**Size:** 1 week after Task 3. **Depends on:** Task 3 (LSPS2), Task 1 for signet.

### What that project is

A self-custodial Lightning payment backend on `ldk-node`, so a merchant can receive payments
with no on-chain Bitcoin and no manual channel management:

```
lsp-service/     ldk-node with enable_liquidity_provider(LSPS2ServiceConfig), TCP :9737
node-service/    merchant node: axum HTTP API (POST /api/invoice, GET /api/invoice/:hash),
                 SQLite, receive_via_jit_channel
payer-cli/       test payer: connects to the LSP, opens a channel, pays a BOLT11 invoice
packages/core/   typed HTTP client for node-service
packages/nextjs/ Next.js route handler, hooks, checkout UI
packages/create/ npx scaffold
```

Default network is **mutinynet** (signet) with Esplora at `https://mutinynet.com/api`.

### How the two projects fit together

They are the two halves of the same transaction, and neither currently has the other's half.

**lightning-ecommerce has a merchant and an LSP but no in-page customer wallet** - the payer is
a CLI or some external wallet.
**This project has a wallet that runs in a page but no LSP and no merchant** - which is why
funding is a regtest hack.

```
   browser tab (this repo)              server side (lightning-ecommerce)
┌───────────────────────────┐        ┌──────────────────────────────────┐
│ buyer wallet              │──ws──► │ ldk-ws-proxy ──► lsp-service      │  LSPS2, JIT channel
│ LDK in WASM               │        └──────────────────────────────────┘
│ chain: mutinynet Esplora  │──https────► https://mutinynet.com/api        (CORS: verified open)
│ pays BOLT11              ─┼──────► │ node-service /api/invoice         │  merchant
└───────────────────────────┘        └──────────────────────────────────┘
```

Three concrete integrations, in order of value:

1. **`lsp-service` is the LSPS2 counterparty Task 3 needs.** No other local LSP exists; this
   unblocks JIT channels immediately. Put `ldk-ws-proxy` in front of its 9737 port.
2. **The browser tab replaces `payer-cli`.** A buyer wallet in the checkout page: the shop
   shows an invoice via `packages/nextjs`, the tab pays it self-custodially. That is a demo
   neither repo can give on its own, and it is the honest version of "Lightning checkout" -
   no custodian on either side.
3. **`node-service` can be the always-online static invoice server** for Task 4, if ldk-node
   exposes the async-payments service role (check before planning around it).

**The chain story gets much simpler on signet.** Mutinynet's Esplora sends
`access-control-allow-origin: *`, so with Task 1 done the browser syncs directly and the
`/chain/*` endpoints of `ldk-chain-proxy` are regtest-only convenience. With LSPS2 (Task 3)
there is no funding transaction either, so `/dev/*` disappears for the receive path. A browser
wallet on signet then needs **no bespoke server at all** except the WebSocket proxy.

### Plan

1. Run `lightning-ecommerce` locally (`docker compose up`, mutinynet). Confirm `payer-cli` can
   pay a `node-service` invoice end to end, so you know the baseline works.
2. Point `ldk-ws-proxy` at `lsp-service:9737` with an allowlist entry, and connect the browser
   node to the LSP over WebSocket. Stop at a completed handshake - that alone proves the glue.
3. Do Task 3 against that LSP.
4. Build the buyer-wallet page: fetch an invoice from `node-service`, pay from the tab, poll
   `GET /api/invoice/:hash` for settlement. Reuse `packages/core`'s typed client rather than
   re-describing the API.
5. Decide where the buyer wallet lives. Options: a new package here that depends on
   `ldk-ws-descriptor`; or a `@lightning-ecommerce/wallet` package in that repo that depends on
   this one as an npm dependency. The second is probably right - that repo already publishes a
   package family and has the scaffold CLI.

### Acceptance

- A browser tab pays a real `node-service` invoice on mutinynet, from a wallet with no on-chain
  funds, over a JIT channel opened by `lsp-service`.
- The merchant's `GET /api/invoice/:hash` reports `succeeded`.
- No bitcoind and no chain proxy anywhere in that flow.

### Open questions to settle before building

- Where does the buyer's channel liquidity come from on a second purchase? JIT solves the first
  inbound payment; a *spending* wallet needs outbound liquidity, which is a different problem.
  Decide whether the buyer wallet is receive-only (a tip jar, a refund target) or genuinely
  spending, and say so in the README.
- Does the demo keep a wallet across sessions (Task 2, VSS) or is it ephemeral? An ephemeral
  wallet with a real channel on signet strands funds every time it is cleared.

---

## Suggested order

```
Task 2 (VSS)          ─┐ independent, cheapest, closes a data-loss hole
Task 1 (Confirm sync) ─┼─► Task 3 (LSPS2) ─► Task 6 (ecommerce integration)
                       └─► Task 4 (async payments, demo value)
Task 5 (tutorial) - any time after Task 1; tier-1 lessons need nothing new
```

Task 2 first if you want momentum. Task 1 first if the goal is a wallet anyone can run.
