# Gotchas

A running log of every surprise. Entries are dated and say how they were found, because the
value here is partly in knowing which claims were actually tested.

Versions in play: `lightningdevkit@0.2.5-0`, which loads LDK `v0.2.5-37-g6accd2acaff8f94f`
with LDK-C-Bindings `v0.2.5.0`. The exact LDK commit is printed to the console at init - that
is the only reliable way to know what you are running.

---

## 1. `read_event` no longer tells you to pause (LDK 0.2)

Most writing about `SocketDescriptor`, including tutorials and the notes this project started
from, says `read_event` returns a `bool` meaning "stop reading, my buffer is full". In LDK 0.2
it returns `Result_NonePeerHandleErrorZ`. There is no bool.

Pausing moved to `send_data`, whose second parameter was renamed `resume_read` ->
`continue_read`. When LDK wants you to stop reading it calls `send_data` with `continue_read`
unset, possibly with an empty slice; when it is ready again it calls with it set.

Upstream made the same change in `node-net` between `main` and the `0.2` branch: `else
socket.pause()` was added to `send_data` and the `.res` check after `read_event` deleted.

The practical consequence for a WebSocket: the pause flag can only change while you are
inside `process_events`, so call `process_events` after *each* chunk you feed to `read_event`
rather than once after draining the whole inbound queue.

## 2. `timer_tick_occurred` wants ~10 seconds, not 60

The Rust docs say "roughly once every ten seconds is preferred" and `node-net` uses a 10s
interval. A 60s timer is a guess that shows up in a lot of second-hand notes. Ping/pong in the
browser demo fires every ~6s once connected, which is LDK's own pinging on top of that timer.

## 3. The handshake needs far less than a node

M2 completes with `KeysManager` + `Logger` + `PeerManager`, with `IgnoringMessageHandler` for
routing/onion/custom/send-only and `ErroringMessageHandler` for channels. No `ChannelManager`,
no `ChainMonitor`, no `NetworkGraph`, no chain data at all. `node-net`'s own test does exactly
this, and so does `packages/descriptor/src/minimal_node.ts`.

`ErroringMessageHandler` also advertises the feature bits peers tend to require. The `init` we
send carries `VariableLengthOnion`, `StaticRemoteKey`, `PaymentSecret`, `BasicMPP`, `Wumbo`,
`RouteBlinding`, `ShutdownAnySegwit`, `ChannelType`, `ZeroConf`, `SCIDPrivacy` and
`UpfrontShutdownScript` as supported - enough that a real LND or CLN node will not drop us.

## 4. WebSocket `send()` is all-or-nothing, which makes `send_data` simpler than TCP

The scary failure mode for `send_data` - return `data.length`, then drop bytes, then watch
every subsequent message fail to decrypt because BOLT-8 is a stream cipher - needs a transport
that can accept a *prefix* of your write. A WebSocket cannot: while the socket is `OPEN`,
`send()` queues the whole frame and grows `bufferedAmount`. Mutiny's production wallet just
called `send()` and returned `data.len()`, ignoring backpressure entirely, and it worked.

So backpressure here is about bounding memory and honouring LDK's anti-DoS design, not about
avoiding corruption. What *can* corrupt the stream is item 5.

## 5. `send()` on a closing socket discards silently

Once `readyState` is `CLOSING` or `CLOSED`, `send()` throws nothing and sends nothing. If you
return `data.length` from there, LDK believes bytes went out that never did. Check
`readyState !== OPEN` and return `0`. (The connection is dead anyway; returning 0 is the
honest answer.)

## 6. There is no `drain` event

Node sockets emit `drain`; WebSocket has nothing. The only way to notice `bufferedAmount`
falling is to poll it. We use a 50ms interval that only runs while blocked, with a high water
mark of 1 MiB and a low water mark of 256 KiB, and call `write_buffer_space_avail` when it
drops.

## 7. `binaryType` defaults to `"blob"`, and blobs can reorder your bytes

The obvious way to handle a blob is `await ev.data.arrayBuffer()`, and two of those awaits can
resolve out of order. Out-of-order bytes into `read_event` is exactly the stream-cipher
corruption everyone warns about, arriving through a door nobody watches. Set
`ws.binaryType = "arraybuffer"` before anything else.

## 8. Never call back into `PeerManager` from inside one of its callbacks

`send_data` and `disconnect_socket` run on the stack of a `process_events` /
`write_buffer_space_avail` call inside WASM. Resuming reads from inside `send_data` would
re-enter `read_event` while LDK holds its internal locks. Defer with `queueMicrotask`, which
runs once the call into WASM has returned. In `disconnect_socket`, just call `ws.close()` -
`onclose` fires asynchronously, and `socket_disconnected` happens there.

## 9. `socket_disconnected` exactly once, and never after `disconnect_socket`

`onerror` is usually followed by `onclose`, so an unguarded handler calls it twice. A single
`disconnected` flag covers both. Note the Rust docs also say calling `socket_disconnected`
after `disconnect_socket` is a no-op, so the flag is belt and braces.

## 10. A proxy refusing your target looks like a *successful* connect

Found by a failing test on 2026-09-28. The proxy has to accept the WebSocket before it can
read the target out of the URL path, so a refusal arrives as `onopen` followed immediately by
`onclose` with code 1008 - not as a connection error. `connect_peer` resolves, and the only
symptom is a peer that never appears. `WsConnection.close_code` is exposed so this is
diagnosable; without it, a typo'd allowlist looks like a mysterious handshake failure.

## 11. Byte arrays handed to `send_data` are already copies

`bindings.mjs`'s `decodeUint8Array` does `viewer.slice(0, size)` before calling your callback,
with a TODO about wrapping the view instead someday. So the `Uint8Array` you get is a private
JS copy, not a view into WASM linear memory, and you can hand it straight to `ws.send()` even
though `ws` may hold the reference past your return. If that TODO is ever acted on, this
package will need a defensive `.slice()`.

## 12. Vite warns about `crypto` being externalized. It is fine

`bindings.mjs` does `await import('crypto')` but only inside `if (typeof crypto ===
"undefined")`, which is false in a browser. The warning is noise; the dynamic import is never
evaluated there.

## 13. Payload sizes

`liblightningjs.wasm` is 14.5 MB uncompressed, 4.5 MB gzipped, plus ~93 KB gzipped of JS. Fine
for a demo, and worth a line in any writeup about whether this is viable for real users on
mobile connections.

## 14. An out-of-sync LND accepts your connection and then drops it

Found on 2026-10-03, pointing the demo at a Polar LND node for the first time. The browser log
said "Finished noise handshake" and "Enqueueing message Init", and then nothing: no peer, no
error, and 55 seconds later a disconnect. LND's log showed only its access-control manager
granting a slot - no `PEER:` lines at all.

The cause was not the transport. LND's regtest chain was weeks stale, so `getinfo` reported
`synced_to_chain: false` (LND judges this from the best block's *timestamp*, so a regtest
network that has not mined recently is permanently "syncing"), and it never started the peer.
Mining a block fixes it instantly:

```sh
docker exec polar-n1-backend1 bitcoin-cli -regtest -rpcuser=polaruser -rpcpassword=polarpass \
  generatetoaddress 6 "$(docker exec polar-n1-backend1 bitcoin-cli -regtest -rpcuser=polaruser -rpcpassword=polarpass getnewaddress)"
```

Worth knowing because every symptom points at your own handshake code.

(Also: `lncli` inside a Polar container needs `--lnddir=/home/lnd/.lnd`, since `docker exec`
runs as root and the default `/root/.lnd` is empty.)

## 15. `ErroringMessageHandler`'s feature bits really are enough for LND

Confirmed against LND 0.20.0-beta, which requires `data-loss-protect`, `tlv-onion`,
`static-remote-key`, `payment-addr` and `amp`. The `init` we send advertises
`VariableLengthOnion`, `StaticRemoteKey`, `PaymentSecret` and `BasicMPP` among others, and
LND's `init` came back with `DataLossProtect: required, VariableLengthOnion: required,
StaticRemoteKey: required, PaymentSecret: required` - accepted, and the connection stayed up
with ping/pong every 10s. So a `PeerManager` with no channel machinery at all is a legitimate
peer as far as a real node is concerned.

## 16. An 'error' event with no listener takes the process down

The proxy crashed with an unhandled `EADDRINUSE` instead of rejecting its start promise, even
though `server.on("error", reject)` was in place. `ws` re-emits the HTTP server's errors on
the `WebSocketServer`, which had no listener, and an unhandled 'error' event throws. Both
emitters need a handler; the fix also distinguishes "failed to start" (reject) from "failed
later" (log), since after `listen` there is no promise left to reject.

## 17. Backpressure is a cycle, not an event

Expected one drain to clear the queue; it takes several. Each resume lets another few KB
through before `bufferedAmount` crosses the high water mark again, so 20 KB through a 4 KB
mark is three full block/resume rounds. Anything that assumes `write_buffer_space_avail`
means "the queue is now empty" is wrong, including the first version of our own test.

## 18. Jitter applied after a ceiling is not bounded by it

Spotted in a 100-second outage run: a backoff capped at 30s produced a 36.3s wait, because
the ±25% jitter was applied to the already-capped delay. Clamp after jittering, not before.
Harmless here, embarrassing in anything with a contractual maximum.

## 19. A connection that opens and instantly dies looks like a success

Reconnect backoff keyed off "did the socket open?" never grows when the far end accepts and
immediately closes - which is exactly what a proxy refusing your target does (gotcha 10). The
result is a hot reconnect loop against a server that is already saying no. A connection has
to *last* before it counts: `stable_after_ms`, default 10s.

## 20. A paused reader needs a bounded queue

LDK's read pause exists to stop a peer filling our buffers with messages it will not read the
responses to. Honouring it over a WebSocket means queueing in JS, and an unbounded queue
hands that same denial of service straight back - the tab dies instead of the buffer. The
queue is capped and the connection dropped when a peer pushes past it while paused; hanging
up is the only backpressure primitive a WebSocket has.

## 21. `Persist` has a fourth method, and the docs describe the older path

`PersistInterface` is `persist_new_channel`, `update_persisted_channel`, `archive_persisted_channel`
and `get_and_clear_completed_updates`. Implement the first three and LDK dies inside WASM with
`arg.get_and_clear_completed_updates is not a function` - a JS TypeError surfacing through a
Rust call stack, which is not where you will look first.

It matters more than a missing method: it *is* the async persistence path. The doc comments on
the other three describe calling `ChainMonitor::channel_monitor_updated` yourself, which is the
older mechanism. In 0.2 you return `InProgress` and queue the completion; LDK drains the queue.

## 22. Async persistence is not optional, and the shortcut is expensive

`Persist` is synchronous; IndexedDB is not. Returning `Completed` and writing in the background
means LDK proceeds on state it believes is durable, and a tab closed in that window loses the
update. That is not a crash, it is a lost channel balance: the counterparty can later broadcast
a state you no longer have the data to punish.

Return `InProgress` (the channel stalls), write, then report completion. A failed write is
simply never reported - the channel stays stalled, which is the safe outcome.

## 23. Read everything out of a callback's arguments before you await

Objects handed to a binding callback are not guaranteed to outlive the callback. `monitor.write()`,
`monitor.channel_id()`, `update.get_update_id()` all have to happen before the async write
starts, not in the continuation.

## 24. LDK 0.2 will not remind you to forward HTLCs

There is no `Event_PendingHTLCsForwardable` any more. Something has to call
`process_pending_htlc_forwards()` on a timer or payments sit in the node doing nothing, with no
error anywhere. Easy to misread as a routing or channel problem.

## 25. Restoring is ordered, and half a node is not a node

Monitors must be read before the `ChannelManager`, which cannot be deserialised without them -
it cross-checks its view of each channel against the monitor's. Restored monitors then have to
be given to the `ChainMonitor` with `watch_channel`, or nothing is watching the chain for them.
Sync resumes from the manager's own best block, not the tip.

If storage has monitors but no manager, refuse to start. Starting fresh there looks like a
working node that has forgotten a channel which still exists on the chain and on the
counterparty's disk. Ours hit exactly this case, from storage written before the manager was
being persisted, and refused - which is how it should feel.

## 26. A restored channel is "pending" until the peer reconnects

After a reload the channel reappears immediately but is not usable until the peer is connected
again and `channel_reestablish` has been exchanged. The UI showing "pending" for a few seconds
after a restart is correct, not a restore failure.

## 27. `tsc` output paths and `package.json` main

With `rootDir: "."` and both `src` and `test` in `include`, output lands at `dist/src/...`.
Vite fails with "Failed to resolve entry for package" until `main`/`exports` match. Obvious in
hindsight, ten minutes in practice.
