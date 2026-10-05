# Curriculum

Eighteen lessons, in four parts, from "your browser is not a Lightning node" to "your browser
is a Lightning node and you know what can go wrong with it".

Lesson 1 is built (`packages/tutorial`). The rest are specified here.

## The rule that decides what is a lesson

**A lesson earns its place only if the learner's code can be graded against real protocol
state.** Not "did you type the right thing" - did your node end up connected, did the bytes
arrive intact, did the payment settle. Anything that cannot be checked that way is prose, and
belongs in the theory pane of a lesson that can.

The second test, which most good lessons pass: **is the mistake visible on the wire?** Lesson 1
works because a learner who forgets to wait for the peer sees three red crosses *and* the
handshake happening in the wire pane. That contradiction is the lesson.

Each lesson below gives:

| | |
|---|---|
| **Theory** | what the left pane explains |
| **You write** | what the learner actually types |
| **Graded on** | the assertion, against live state |
| **Needs** | infrastructure beyond a WebSocket proxy and one peer |
| **From** | where the material already exists in this repo |

---

## Part 1 — The connection

One peer and a WebSocket proxy. No chain, no funds, nothing to reset between learners. A single
Core Lightning node with `bind-addr=ws:` can serve a whole class with no proxy at all.

### 1. Connect to a peer — *built*

- **Theory** — why a browser cannot speak TCP; BOLT-8 Noise_XK as a three-message handshake;
  the peer proving it owns the key you dialled; no certificate authority anywhere.
- **You write** — `connect_link`, `wait_connected`, `await_peer`.
- **Graded on** — `list_peers()` contains the node they were asked to dial, outbound.
- **From** — `packages/tutorial`.

### 2. Read the init message

- **Theory** — feature bits as a bitfield; optional vs **required** and why a required bit you
  do not understand is a hang-up; how features are negotiated once, at connection time, and
  never again.
- **You write** — pull `get_init_features()` off the connected peer and answer questions about
  it: does this peer support zero-conf channels? does it *require* `static_remote_key`? would a
  node that only spoke the 2018 protocol be able to talk to it?
- **Graded on** — the learner's returned answers against the peer's actual advertised features.
  `InitFeatures` has 56 `supports_*` / `requires_*` methods; the grader uses the same ones.
- **Why it matters** — this is the lesson that explains the single most common "my node won't
  connect" and why our own `ErroringMessageHandler` node is accepted by LND at all.

### 3. Keep it alive

- **Theory** — Lightning has no TCP keepalive worth trusting; `timer_tick_occurred` drives
  ping/pong and peer timeout, and it is the *embedder's* job to call it. A node that does not
  tick looks dead to its peers.
- **You write** — the timer. Start from a node with no tick, watch the peer drop, add the tick,
  watch it survive.
- **Graded on** — the peer is still connected after the harness runs the clock forward.
- **Needs** — accelerated time (`timer_tick_ms` turned down), which the harness already
  supports.
- **From** — GOTCHAS 2; `packages/descriptor/test/soak.test.ts`.

### 4. Survive a broken connection

- **Theory** — a browser tab loses its connection constantly: a lid closing, a sleeping radio, a
  redeployed proxy. Exponential backoff, jitter, and why "did the socket open?" is the wrong
  signal for success.
- **You write** — reconnection. The harness kills the proxy mid-lesson; their code has to get
  back on its own.
- **Graded on** — the peer is connected again after the harness restores the proxy, and the
  learner did not hot-loop while it was down.
- **Needs** — harness control over the proxy (kill and restore).
- **From** — `PeerLink`, GOTCHAS 19, `reconnect.test.ts`.

---

## Part 2 — The transport contract

**This is the part no other Lightning course can teach**, because it needs a real
`SocketDescriptor` and a socket whose congestion you control. Still tier 1: no chain, no funds.

### 5. Implement `send_data`

- **Theory** — `SocketDescriptor` as a contract rather than an API: the return value is a
  *promise about how many bytes you took ownership of*. BOLT-8 is a stream cipher, so a gap in
  the byte stream is not a dropped message, it is every subsequent message failing to decrypt.
- **You write** — `send_data`, from scratch, against a socket the harness controls.
- **Graded on** — every byte LDK handed over arrives, in order, exactly once; and the count
  returned never exceeds what was actually taken.
- **Needs** — the fake-socket harness ported from `backpressure.test.ts` into the tutorial.
- **From** — `packages/descriptor/src/descriptor.ts`, GOTCHAS 4, 5.
- **Note** — the best lesson in the set. The grader already exists as a test.

### 6. Backpressure

- **Theory** — what happens when the socket cannot keep up; why returning `data.length` and
  dropping the remainder corrupts the connection; `write_buffer_space_avail` as the way back;
  why draining is a cycle rather than an event.
- **You write** — water marks, short counts, and the resume path.
- **Graded on** — the full byte stream arrives intact across several block/resume cycles, and
  `write_buffer_space_avail` is called once per drain, not spuriously.
- **From** — GOTCHAS 6, 17.

### 7. The read pause, and a hostile peer

- **Theory** — LDK's anti-DoS design: a peer that sends without reading your responses is
  attacking you, and `continue_read` is how LDK asks you to stop. WebSocket has no pause, so
  honouring it means queueing in JS - and an unbounded queue hands the attack straight back.
- **You write** — the inbound queue, the pause, the resume in order, and the cap.
- **Graded on** — nothing reaches `read_event` while paused; everything queued arrives in order
  on resume; a peer that pushes past the cap gets disconnected.
- **From** — GOTCHAS 1, 20.

> Lessons 5-7 could be one long lesson. Three is better: each has its own failure to see.

---

## Part 3 — Becoming a node

Needs a chain backend and a funded wallet. Costs real infrastructure and per-learner state -
see "What this costs to host".

### 8. Build a node

- **Theory** — the object graph, and why the order is forced: `ChainMonitor` before
  `ChannelManager` (which needs it as a `Watch`), `PeerManager` last (it needs the
  `ChannelManager` as its message handler). Also: the bindings free Rust memory when JS drops
  the last reference, so something must hold on.
- **You write** — the wiring, from `KeysManager` to `PeerManager`.
- **Graded on** — the node starts, derives its node id, `list_channels()` answers.
- **From** — `packages/node/src/node.ts`, GOTCHAS 3.

### 9. Follow the chain

- **Theory** — a Lightning node is a Bitcoin node's client: it needs to know when the funding
  transaction confirms and whether anyone published a commitment. `Listen` (whole blocks, simple
  and correct) vs `Confirm` (filtered, and the only thing viable on mainnet).
- **You write** — the sync loop: fetch blocks, feed them, handle the reorg.
- **Graded on** — the node's best block tracks the chain after the harness mines; a reorg
  rewinds it to the fork point.
- **Needs** — chain backend with a mine button.
- **From** — `packages/node/src/chain.ts`, GOTCHAS 25.

### 10. Persist, correctly

- **Theory** — the lesson where mistakes cost money. `Persist` is synchronous, every durable
  browser store is not, and the tempting shortcut - return `Completed`, write in the background
  - means LDK proceeds on state it believes is on disk. A tab closed in that window can lose the
  channel balance, because the counterparty can broadcast an old state you can no longer punish.
- **You write** — `Persist`, with a store the harness makes deliberately slow.
- **Graded on** — the learner returns `InProgress`, reports completion only after the write
  lands, and **never reports a failed write as complete**. The harness fails writes on purpose
  and checks the channel stalls rather than proceeding.
- **Needs** — a controllable fake store.
- **From** — `packages/node/src/persist.ts`, GOTCHAS 21, 22, 23.
- **Note** — the most valuable lesson in Part 3. Grade it harshly.

### 11. Open a channel

- **Theory** — what a channel is: a 2-of-2 output and a pile of signed, revocable states.
  `FundingGenerationReady` as the moment LDK asks *you* for a transaction, and why that is the
  one thing a browser cannot do alone.
- **You write** — `create_channel`, handle the funding event, hand the transaction back, wait
  for `channel_ready`.
- **Graded on** — `list_usable_channels()` has the channel and the counterparty agrees.
- **Needs** — chain backend, funding wallet, mine button.
- **From** — `packages/node/test/payment.test.ts`.

### 12. Receive a payment

- **Theory** — invoices, payment hashes and preimages; why the preimage is the receipt; why
  LDK hands you `PaymentClaimable` and waits instead of claiming for you.
- **You write** — create an invoice, handle `PaymentClaimable`, `claim_funds`.
- **Graded on** — `PaymentClaimed` for the right amount; the channel balance moved.
- **Needs** — something to pay the invoice (harness-driven).

### 13. Send a payment

- **Theory** — routing, onions, and why a payment can fail in ways a bank transfer cannot;
  retries; what `PaymentSent` actually proves.
- **You write** — `pay_for_bolt11_invoice`, handle success and failure.
- **Graded on** — the payment settles, and the learner's failure path is exercised by a second
  invoice the harness makes unpayable.

### 14. Survive a restart

- **Theory** — why restoring is ordered: monitors first (the `ChannelManager` cannot be
  deserialised without them), then re-register with `watch_channel`, then resume sync from the
  manager's best block rather than the tip. Why half a node must refuse to start.
- **You write** — the restore path.
- **Graded on** — after the harness restarts the node, the same channel is there and a payment
  still goes through it.
- **From** — `packages/node/test/restart.test.ts`, GOTCHAS 25, 26.

---

## Part 4 — What a real wallet needs

These map onto [FUTURE-WORK.md](FUTURE-WORK.md). Each becomes a lesson once the feature exists.

### 15. Back up your channel state — *needs FUTURE-WORK task 2*

Why IndexedDB is not a backup; what VSS is; client-side encryption so the server stores
ciphertext; and the problem nobody expects - two tabs on the same wallet, and why versioning
turns silent corruption into a visible conflict.
**Graded on** — a node restored from the remote store, in a fresh profile, keeps its channel.

### 16. Get a channel with no on-chain funds — *needs FUTURE-WORK task 3*

LSPS2 and JIT channels: the LSP opens a zero-conf channel when the first payment arrives and
takes its fee from it. The honest framing of the trust involved, and why accepting zero-conf
from anyone but your LSP is a way to lose money.
**Graded on** — a wallet with no channel and no coins creates an invoice and gets paid.

### 17. Get paid while your tab is closed — *needs FUTURE-WORK task 4*

BOLT 12 offers, blinded paths, static invoices without a payment hash, and held HTLCs. The
best demo in the set: close the tab, send a payment, reopen it, watch it settle.
**Graded on** — a payment made while the learner's node was stopped settles when it restarts.

### 18. What can go wrong

Force closes, revoked states and penalty transactions; why `data_loss_protect` exists; what
actually happens if you restore a stale backup. Mostly theory, with one grading: the harness
force-closes the channel from the other side and the learner's node has to notice and handle
the `ChannelClosed` event rather than hanging.

---

## What the harness still needs

The lessons above need capabilities the prototype does not have. In rough build order:

| Capability | For lessons |
|---|---|
| Harness-driven events between steps (kill the proxy, mine, pay the learner, force-close) | 4, 9, 11, 12, 13, 18 |
| The fake-socket rig from `backpressure.test.ts`, exposed to lesson code | 5, 6, 7 |
| A controllable store that can be slow and can fail | 10 |
| Node restart within a session, preserving storage | 14 |
| Per-learner chain state, or sturdy sharing of one regtest network | 8-14 |
| Monaco plus the `lightningdevkit` type definitions | all of them, really |

## What this costs to host

Part 1 and Part 2 are nearly free: one Lightning node, one WebSocket proxy, no per-learner
state, nothing to reset. **Ten lessons, essentially free.** Start there and ship.

Part 3 needs a chain, a funding wallet and per-learner channels. The shared-regtest problems
are real - one learner mining ten thousand blocks, a drained faucet, an LSP with a hundred
stale channels - so rate-limit the mine and fund endpoints, cap per session, and expect to
reset the network on a schedule.

## What is deliberately not a lesson

- **Writing a WebSocket proxy.** It is forty lines of byte copying and teaches nothing about
  Lightning.
- **Cryptographic internals of Noise_XK.** Read BOLT 8. Implementing it teaches you about
  Noise, not about building a wallet.
- **Routing and pathfinding.** Genuinely interesting, and a node with one channel to one peer
  cannot demonstrate any of it. It needs a network, which is a different kind of exercise.
- **Anything about mainnet.** Every lesson here runs on regtest or signet, and the course
  should say plainly that running this against real money is a different project.
