# iOS: the guardian's phone side (not yet built)

The PC guardian (`desktop/src/bin/guardian.rs`) is done: a LocalSystem Windows service that
stays up from boot, holds a phone listener on **apiM's port + 1** (default `47101`), wakes apiM
when it is closed, and — once the lock is on — relaunches apiM whenever it is killed. It speaks
the same wire protocol as apiM (`desktop/src/remote.rs`), so the already-paired phone and secret
work with no new pairing.

What is left is the iOS side. It must be built and tested in Xcode on a Mac — it was left unwritten
rather than committed blind, because it touches the encrypted connection and can only be verified on
a device against a running guardian.

## What to add

1. **A second connector to the guardian port.** The existing `Remote` (`apiM/Remote.swift`) holds one
   `NWConnection` + `Sealer` to `pairing.port`. The guardian lives at `pairing.port + 1`. Add a small
   second connector (reuse `Sealer`, `Pairing`, and the hello handshake exactly as `attempt(...)` does)
   that dials `pairing.port + 1`. It only ever sends; it needs no view/receive loop beyond the handshake.
   Keep it lazy: one short-lived connection per command is fine (connect → handshake → seal one frame →
   close), since wake/lock are rare taps, not a stream.

2. **Two commands** over that connector (same `send(["t": ...])` shape as the other 15 commands):
   - `["t": "wake"]` — launch apiM on the PC if it is closed.
   - `["t": "lock", "on": true/false]` — turn protection on/off. Only the phone sends this; the guardian
     (SYSTEM) is the only writer of the flag, so a user-level virus on the PC cannot flip it off.

3. **Settings toggle** in `apiM/SettingsView.swift`: a "Lock this PC" switch that sends `lock on/off`,
   and optionally a "Wake PC" button that sends `wake`. Reflect the state the PC reports if you add it to
   the view; otherwise keep the switch's own last-sent state.

## The flow it enables

Virus hits → grab phone → open apiM app → flip **Lock this PC** on → type "I have a virus, clean it up".
The phone's `lock on` reaches the guardian (always up), which from then on relaunches apiM if the virus
kills it; the `wake`/message starts apiM if it was closed. Turn the lock off from the phone to let apiM
close for good again.

## Honest limits (say these in the UI, as the PC Settings already does)

- Unkillable only against a **user-level** virus. A virus already at admin/SYSTEM can stop the service,
  delete the files, or force a shutdown — no app beats that; keep Windows UAC on.
- The lock is forward-only: it stops further killing, it does not undo damage already done.
- A forced shutdown is clean (no brick); the guardian returns at next boot because it is auto-start.
