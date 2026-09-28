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

## 14. `tsc` output paths and `package.json` main

With `rootDir: "."` and both `src` and `test` in `include`, output lands at `dist/src/...`.
Vite fails with "Failed to resolve entry for package" until `main`/`exports` match. Obvious in
hindsight, ten minutes in practice.
