# The Cut — Card Dealing & Betting Engine (v11.5)

**Reconnect Dialog Restructure, Code Input Casing, ReAnteable All-In
Warning** — built from `the-cut-spec_v11-5.md`, consolidating a full
round of 11.4 play-testing findings. `npm test` — **449 tests**
(unchanged from v11.4 — this release is almost entirely client-side
UI plus a test-infrastructure fix; no new GameTable-level behavior to
unit-test). Live end-to-end verification run and passed, including a
proper adversarial re-check of Part D's own fix, plus a re-run of
`live_test_11_0.js` through `live_test_11_4.js` to confirm nothing
regressed.

## Part A — Reconnect dialog restructure

Confirmed against actual screenshots during this round. Four changes,
all to the popup from `the-cut-spec_v11-3.md` Part A.5:
- A second `<h3>` heading line, reusing `.chip-dialog h3` as-is (no new
  CSS tier): "Attempting Reconnection" during the Grace Period,
  "Still Attempting Reconnection" after expiry — literally true either
  way, since automatic retry is only ever stopped by an actual
  successful reconnect, never by expiry itself.
- The Grace-Period-active message/countdown content is unchanged,
  confirmed correct as-is via screenshot review.
- The post-expiry message shortened to just "You've been moved to
  Sitting Out." — the "you can still reconnect at any time" half is
  now redundant given the new heading.
- **The manual Reconnect/Rejoin button removed entirely, both states.**
  Root cause of a real, confirmed UX problem: with automatic retry
  running every 2.5s and each attempt needing its own 3.5s timeout to
  fail before the button re-enables, a genuinely dead connection
  produced a button visibly flickering enabled/disabled roughly every
  1.5s indefinitely — an invitation to click that accomplished nothing
  the ticker wasn't already about to do moments later. The dialog is
  now purely informational; automatic retry alone continues
  indefinitely, exactly as it already did.

## Part B — Force uppercase on landing-page code inputs

A new, dedicated `.code-input` class (`text-transform: uppercase`),
applied alongside the existing `.mono-input` on exactly three fields —
`join-code`, `rejoin-table-code`, `rejoin-code` — deliberately
separate from `.mono-input` itself, which is also shared by numerous
unrelated numeric/select fields throughout the app and would have been
imprecise scoping for this. Pure CSS, browser-native — the underlying
typed value (already case-insensitive on the server) is unaffected;
only the display changes, avoiding any cursor-position or
paste-handling risk a hand-rolled JS implementation could introduce.

## Part C — Confirmation before All-In in a ReAnteable game

Found via a rich multi-layered testing scenario (3 of 4 players
all-in, nobody able to open, New Hand blocked entirely). The real
underlying fix (deal-eligibility filter changes, a new degenerate-case
pot resolution) is explicitly deferred past Beta per Mike's own call —
revisited after, not abandoned. What ships instead: a generic warning,
not a smart one — this app never judges hand strength anywhere, by
design, so it can't know whether a given All-In is actually safe.
Shown only in a ReAnteable game, using the existing `appConfirm()`
component (no new dialog type), layered in *front of* the app's own
pre-existing All-In confirmation dialog rather than replacing it —
players in a ReAnteable game now see the ReAnteable-specific warning
first, then the existing "commit your stack" confirmation, unchanged.
Purely a client-side gate; no betting or dealing logic touched at all.

## Part D — `live_test_11_4.js` fixed, and properly this time

Confirmed exactly the two defects flagged: `console.assert()` never
fails the Node.js process on a failed assertion (proven by deliberately
breaking the real Part-H.2 exclusion under test and getting
byte-for-byte identical "passed" output and exit code 0), and the test
assumed `TEST_SWEEP_MS`/`TEST_INACTIVITY_SECONDS` environment-variable
overrides that only ever existed on a temporary, locally-reverted copy
of `server.js`/`gameTable.js` during v11.4's own manual verification —
never in the actually-shipped code.

**Fixed properly, not with another throwaway hack**: both overrides
are now genuinely, permanently wired into the real source
(`server.js`'s `LIFECYCLE_SWEEP_INTERVAL_MS`, `gameTable.js`'s
`inactivityTimeoutSeconds`) — harmless in production, since the
env vars are simply never set there. The test itself now uses real
`assert()` calls, with spawned-server cleanup moved into a `finally`
block after discovering a failed assertion left the child process
running, masking the correct nonzero exit code behind an external
timeout. Re-ran the exact adversarial check that caught this in the
first place — deliberately broke the real exclusion again, confirmed
the fixed test now genuinely fails with exit code 1, then confirmed it
passes cleanly again once reverted.

---

## v11.4 — Client Heartbeat, Badge Ticker, Field Order, Uncallable-Bet Gating

Built from `the-cut-spec_v11-4.md`, consolidating findings from
extended 11.3 play-testing. `npm test` — **449 tests** (up from 444 in
v11.3 — 5 new, in `test/gameTable-11-4.test.js`). Live end-to-end
verification run and passed (`live_test_11_4.js`), plus a re-run of
`live_test_11_0.js` through `live_test_11_3.js` to confirm nothing
regressed.

## Part A — Client-side active heartbeat

Confirmed live: with wifi disabled entirely across four tabs, none
showed the "Connection Lost" popup during a 3-minute outage. Root
cause: the server's heartbeat is one-directional — it pings the
client, but the client has no equivalent of its own, and browsers
don't expose WebSocket ping/pong frames to JavaScript at all. Fixed
with a plain application-level `clientHeartbeat`/`clientHeartbeatAck`
message pair, sent every 6s while genuinely connected at a table; no
ack within 6s closes the socket proactively, routing through the
exact same `close` handler already driving `startReconnectFlow()`
(the-cut-spec_v11-3.md Part A) — no new reconnect logic needed.

**Caught before shipping, not after**: the existing Part H.2 "any
message counts as activity" hook would have treated the heartbeat
itself as real activity, resetting the 30-minute inactivity clock
every 6 seconds and making that timeout unreachable during ordinary
play. Excluded `clientHeartbeat` specifically from that hook, and
proved the fix live — a table with a shortened inactivity window still
closed exactly on schedule despite a full second of continuous
heartbeats running throughout.

## Part B — Disconnected-player badge ticker

Confirmed live: the badge started accurate, then froze until jumping
straight to 0 at Grace Period expiry. Root cause: `secondsLeft` was
only ever recomputed as part of a full per-player render, itself only
triggered by an incoming `gameTableState` broadcast — and nothing else
at the table may broadcast while everyone's simply waiting on the one
disconnected player. Fixed with the same pattern already used for the
reconnect dialog's own countdown: the deadline is stashed directly on
the badge element, and a dedicated 1s ticker refreshes just that
element's text/title, independent of server broadcast timing.

## Part C — Landing page Re-Join field order

Table code now first, Reconnect code second, in the "Re-join a table"
card. Pure markup reorder — element IDs, the click handler, and
validation were never order-dependent.

## Part D — Uncallable-bet messaging and button gating

**D.2 (unconditional)**: the private rejection message for a blocked
Bet now distinguishes "no bet at all is possible" from "a smaller bet
would still be legal" — the old message always suggested All-In as a
working alternative, which was actively wrong advice in the first
case. Pure string change; the underlying condition is untouched.
Probed via the same "smallest possible amount" figure
(`_minimumPossibleCumulativeTotal`, fixed at $1) the button-gating
check below also uses.

**D.3 (behind `GATE_BETTING_BUTTONS_WHEN_UNCALLABLE`, defaulting
`true`)**: Bet and All-In now proactively disable in the same state,
per the Standing Convention — Check/Fold remain available. The
underlying check (`_opponentCeiling()`) was factored out of
`_validateBetOrRaise()` so the new proactive `_canBetOrRaise()` reuses
the exact same computation rather than a second copy that could drift,
exposed as `canBetOrRaise` in `toRedactedState` following the same
established pattern as Buy Chips's own `canBuyChips`. Client-side, the
button-gating logic now reads this field directly instead of
reconstructing the check itself — the pre-11.4 client-side
reconstruction is gone. A single named constant near the top of
`gameTable.js` reverts the whole proactive-gating behavior with no
client-side change needed, kept as explicit Beta-window scaffolding
per Mike's own request given how close this touches the betting rail
to Beta.

---

## v11.3 — Reconnect Resilience, Landing-Page Socket Robustness, Code Alphabet Fix

Built from `the-cut-spec_v11-3.md`. `npm test` — **444 tests**
(up from 442 in v11.2 — 2 new, in `test/gameTable-11-3.test.js`). Live
end-to-end verification run and passed for the server-side pieces
(`live_test_11_3.js`), plus a re-run of `live_test_11_0.js`/
`live_test_11_1.js`/`live_test_11_2.js` to confirm nothing regressed.

**Verification caveat, stated plainly rather than glossed over**: Part
A's actual reconnect mechanism (the popup, the automatic timer, the
manual button, `sessionStorage`) is almost entirely client-side
JavaScript coordinating real browser `WebSocket`/`dialog` APIs. This
build's live-test harness runs Node's `ws` library directly against
`server.js` — it cannot execute `client.js` itself, since that needs a
real DOM this environment doesn't have. Every server-side contract
Part A depends on is unit- and live-tested; the client-side flow
itself has had careful code review and a syntax check, but not a
real-browser click-through. Treat this build as ready for your own
hands-on testing rather than as fully self-certified the way v11.0–v11.2
were for their own client-side pieces.

## Part A — Reconnect Resilience

The Grace Period was "time to manually Re-Join" in name only — manual
recovery realistically takes minutes (refresh, land on the lobby, type
both codes, maybe a Host-mediated round trip for the code itself), not
the 30 seconds actually available. Fixed with a single continuous
mechanism (`attemptReconnectOnce()`), used identically by both an
automatic timer (every 2.5s) and a manual button, sharing one
in-flight flag and each attempt bounded by its own 3.5s timeout
(independent of any native browser connection timeout, since a
silently-hanging attempt could otherwise block the shared flag far
longer than the retry cadence intends).

**Two real course-corrections happened while building this, kept here
rather than only shipping the final answer:**
1. The reconnect code never needed to be re-typed at all — a dropped
   socket doesn't wipe the tab's own JS memory, only a full reload
   does, so the tab can just reuse what it already has.
2. An earlier draft staged automatic-then-manual as sequential phases.
   Wrong: if background-tab throttling (a real, confirmed cause of
   same-machine multi-tab test disconnects since 11.1) can silently
   suppress an automatic-only phase, that's exactly the scenario a
   manual click needs to still work in — and it reliably does, since
   clicking a tab necessarily brings it into focus first. Both now run
   for the entire Grace Period, never staged.

**On the disconnected player's own screen**: a popup with a single
countdown for the whole Grace Period, showing the actual accurate
outcome the whole time (not a placeholder) — "You'll be folded" if
facing a bet, or "You'll be checked through, but you can't reveal or
claim the pot while disconnected" if free (confirmed directly against
`revealHand()`: a simple, always-available voluntary action with no
gating, so a player who reconnects even after the pot would otherwise
have been claimed genuinely still has a chance). After expiry, the
same button persists indefinitely, relabeled "Rejoin," no more
countdown, message updated to reflect they're now Sitting Out.

**Persistence**: the reconnect/table code pair is written to
`sessionStorage` on every successful join/reconnect, and checked
before anything else on page load — a same-tab reload recovers
automatically, skipping the landing page entirely. The landing page's
Re-Join form remains the correct fallback for a genuinely closed tab,
a different device, or a stale cached pair — pre-filled from cache
either way, never left blank just because the automatic attempt didn't
pan out.

**Rate-limiter correction**: `reconnectPlayer()` now returns
`codeMatchedNoPlayer`, so the per-IP limiter only counts a code that
matches nobody at all — a legitimate player's own correct code,
rejected merely for timing (already reconnected, or the multi-device
rule), no longer risks tripping the same limiter built to catch
guessing.

## Part B — Landing-page socket robustness

Confirmed directly: the heartbeat loop pings every connected socket
regardless of whether it's associated with a joined player yet, so a
landing-page socket left idle for 20-30s (a realistic time to look up
a code) was just as subject to the same ~10-12s detection/termination
window as an in-table one — and the old `send()`'s silent readyState
guard meant a click on that now-dead socket did visibly nothing at
all. Fixed by making `send()` itself robust: a not-open socket now
transparently reconnects, queues the message, and flushes it the
instant the new connection opens, with a "Connecting…" state on
whichever lobby button triggered it. One unified mechanism, not a
separate background reconnect ticker — it also incidentally covers the
rarer "clicked before the very first handshake finished" case for free.

## Part C — Reconnect code alphabet

`0` (zero) and `O` (letter O) removed from the 36-character alphabet
(34 remain) — confirmed as a real, recurring problem during testing.
Both removed together, not just one side, since a player who hasn't
had the benefit of this conversation has no way to know which one was
kept. `1`/`I` deliberately kept, per Mike's own judgment. Keyspace
drops from 36^6 (~2.18 billion) to 34^6 (~1.54 billion) — negligible
against the real threat model of a rate-limited human guesser.

---

## v11.2 — Table Owner Function Fixes, Host rename, and two smaller corrections

Built from `the-cut-spec_v11-2.md`, consolidating
everything found during 11.1 play-testing. `npm test` — **442 tests**
(up from 435 in v11.1 — 7 new, all in `test/gameTable-11-2.test.js`).
Live end-to-end verification run and passed (`live_test_11_2.js`,
plus a re-run of `live_test_11_0.js`/`live_test_11_1.js` to confirm
nothing in the wider rename/fix set regressed anything earlier).

## Fix 1 — Restore Stacks now accounts for multi-hand cycles

`_preGameSnapshot` was being recaptured on *every* hand, including a
re-ante "New Hand" within an ongoing ReAnteable cycle, not only a
genuine new cycle — the 10.3-era comment describing that behavior was
correct when written, and silently stopped being true the moment a
cycle could span more than one hand. Restoring to a mid-cycle hand's
own snapshot and then zeroing the pot discarded whatever the prior
hand(s) in that cycle had already carried forward. Fixed: the snapshot
is now only recaptured on a genuine new cycle (`clearFolded === true`,
entry from PreGame/CycleComplete) — the only point where the total
money in play is unambiguous. Confirmation/announcement wording
corrected from "the start of the last hand" to "the start of the
current cycle" to match.

## Fix 2 — a terminated hand can no longer leave a postable stale ante

`_performFullReset()` reset every other per-hand transient field but
never `oweAnte`; `postAnteBlind()` had no phase check of its own, so a
stale nonzero `oweAnte` surviving Terminate Cleanly or Restore Stacks
was sufficient on its own to let real money move into the pot while
the table sat idle. Fixed with both the required change (`oweAnte`
now reset alongside everything else) and the recommended
defense-in-depth one (`postAnteBlind()` now also gated on
`handPhase === 'RequestAntes'`) — scoped to phase-gated profiles only,
after an existing test caught that the legacy no-Game-Choice "flexible
toolbox" mode never transitions `handPhase` away from its constructor
default at all, and would have been broken by an unconditional gate.

## Fix 3 — Stud side-pot bug: an uncallable bet no longer creates a pot

**Live-reproduced directly against `GameTable` before fixing**, per
this project's own standing discipline, not shipped on a code-read
alone: three players already all-in and capped at $100 total from an
earlier street, the fourth (also at $100 cumulative) betting a further
$10 was incorrectly allowed by `_validateBetOrRaise()`'s proactive
opponent-ceiling cap. Root cause: the check compared a street-local
raw bet amount against a whole-hand-cumulative ceiling — unit-mismatched
scales that happen to coincide on a player's first street and silently
diverge on any later one. Fixed by comparing the player's own proposed
*cumulative total for the hand* against the ceiling instead. Also
added the recommended defense-in-depth measure:
`_checkUncalledBetRefund()` now also runs after an ordinary Bet/Raise,
not only fold/all-in, so this category of bug can't slip through both
layers at once again. Two regression tests added, including one
confirming the fix isn't overly strict on a genuinely callable bet.

## Fix 4 — "Table Owner" renamed to "Host" everywhere player-facing

"Table Owner" stays exactly as-is in code, comments, `creatorId`, and
every spec/VERSIONING document. Every player-facing occurrence is now
"Host": all fourteen "Only the [Table Owner→Host] can..." messages,
three dialog headings (Host Tools/Host Settings/Host Testing), the
Player Rail's section label, the pot-distribution-in-progress banner,
and the Terminate Cleanly/Restore Stacks/End Game announcements. The
Pot Distribution announcement was also rewritten from a bare "has
distributed the pot" into a full per-player breakdown — one entry per
player in the committed batch, ordered by seat position, `+$X`/`−$X`
per player (including a plain `$0` entry for a net-zero player,
never omitted).

## Fix 5 — disconnected-player badge: consistent danger styling

Was the app's warm gold/amber tint, the same visual register as a
routine status. Now reuses the existing danger palette
(`var(--danger-bg)`/`var(--danger-text)`, the same pairing already
used for `.lobby-error`/`.table-error`) rather than introducing a
third color for "something's wrong." Styling only — no change to the
countdown text or logic.

## Fix 6 — Buy Chips prompt no longer fires on reconnect

The prompt was gated on `isFirstGameTableState` alone, true for a
reconnecting client's own empty local state just as much as a genuinely
new one — the client itself has no way to tell the two cases apart.
Fixed by adding an explicit `isReconnect` field to the `'joined'`
message (the server already knows internally which handler produced
it); the Buy Chips prompt now also requires `isReconnect === false`.

---

## v11.1 — Table Owner Testing Tools, plus four fixes carried forward from 10.4

Built from `the-cut-spec_v11-1.md`. `npm test` — **435
tests** (up from 429 in v11.0 — 6 new, all in
`test/gameTable-11-1.test.js`). Live end-to-end WebSocket verification
run and passed (`live_test_11_1.js`, confirming both Testing
capabilities route through the exact real production code paths, not
a simulated shortcut), plus a re-run of `live_test_11_0.js`.

## New: Testing dialog (Table Owner Player Rail, below the divider)

Deliberately scoped as a general debug/QA surface, not named after
either capability inside it — same reasoning as Settings — since more
capabilities are expected to follow.

- **Force Disconnect**: the Table Owner picks any currently-connected
  seated player (Dealer or themselves included) and terminates their
  *actual* socket. This is not a simulated state change —
  `targetSocket.terminate()` fires that socket's own real `close`
  event, which routes through the exact same `handleConnectionLost()`
  a genuine heartbeat failure or clean close already uses. Everything
  downstream (grace period, freeze, check/fold-on-expiry, Sitting Out,
  Dealer reassignment) proceeds at its normal, real timing — this only
  solves *triggering* the disconnect on demand.
- **Force Timeout to T-5**: backdates `lastActivityAt` so
  `tableCloseAt` lands exactly 5 minutes out — the same real field
  every other consumer (the client's own banner/popup, the server's
  lifecycle sweep) already reads, not a separate simulated banner
  state. From that point, T-1 and T-0 follow in real time exactly as
  production, and real activity still resets the clock normally.

Both are Table-Owner-only, unit-tested (`canForceDisconnect()`,
`forceInactivityWarning()`), and confirmed live against real sockets.
Decided to survive through the 13.0 beta, not gated off before then —
beta testers will hit the same practical testing limitation Mike did.

## Fix 1 — "Please stand by" banner no longer outlives the dialog

The Pot Distribution banner (`tableOwnerDistributionInProgress`) was
only ever cleared by the explicit "Discard Batch" button or a commit.
Closing the Table Owner Tools dialog any other way (Escape, its own
Close button) left `_pendingAllocationBatch` open indefinitely. Fixed
with a single `close` event listener on the dialog itself — the native
event fires uniformly for every close path in this app (there's no
backdrop-click-to-close anywhere to also account for) — that discards
any still-open batch automatically. A batch can no longer outlive the
dialog that owns it.

## Fix 2 — no native `confirm()` left anywhere

Replaced with one reusable, app-styled, promise-based `appConfirm()`
dialog, used at every site the native browser confirm used to appear:
Terminate Cleanly, Restore Stacks, Commit Batch, Misdeal, both Remove
Player confirmations (the plain case and the fold-now/wait-for-cycle
choice, now with real button labels instead of implicit OK/Cancel
semantics), End Game, and both player-facing Leave Table
confirmations. (Direct count came to 8 native `confirm()` call sites,
not the 9 the review document estimated — every one found was
converted regardless of the exact number.)

## Fix 3 — inactivity timing precision

- **Issue A**: the client's shared banner/popup tick was 5000ms — fine
  for the T-5 banner's "about N minutes" wording, too coarse for the
  T-1 popup's live per-second countdown. Dropped to 1000ms; it's a
  pure re-render from already-known state, no new network cost.
- **Issue B**: the server's `runLifecycleSweep()` ran once every 60
  seconds — correct for H.1's 30-60-minute timescale, but H.2's entire
  T-5→T-1→T-0 sequence plays out over 5 minutes, so the real close
  could lag up to a full minute behind `tableCloseAt`. Same category of
  bug as `_activePlayers()` being shared across callers with
  incompatible needs. Fixed by tightening the single shared interval to
  5 seconds rather than splitting into two sweeps — this app runs at
  most a handful of concurrent tables, so comparing timestamps five
  times a second is negligible cost; the "don't poll every table every
  second forever" concern the spec raised doesn't bite at this app's
  actual scale. H.2's worst-case lag drops from up to 60s to up to 5s;
  H.1 is unaffected by the tighter interval.

## Fix 4 — landing page: two columns, not three

"Open a Table" stays alone in the first column; "Join a Table" and
"Re-join a Table" are now stacked as a pair in the second column,
separated by a horizontal "or" divider. Halves the layout's horizontal
footprint at the video-call-plus-browser width range that prompted
this, without touching the already-correct sub-720px single-column
stack (Open → Join → Re-join), which this restructuring doesn't
change at all.

---

## v11.0 — Disconnection, Reconnection, Leave Table/Remove Player, and table lifecycle

Built from `the-cut-spec_v11-0.md` (Parts A through I),
`reconnection-reconciliation-11-0.md`, and `10-0-reconnection-reference.md`.
`npm test` — **429 tests** (up from 393 in v10.4 — 36 new, all in
`test/gameTable-11-0.test.js`; no existing test removed or weakened).
Live end-to-end WebSocket verification run and passed
(`live_test_11_0.js`, covering disconnect detection through reconnect
and Leave Table/Remove Player/End Game; a separate throwaway harness
covering the zero-connection and inactivity lifecycle timeouts on
shortened windows, since those run on 30–45 minute clocks by default).

## Part A/B — Heartbeat detection and the reconnect grace period

Every socket is pinged every 5 seconds; two missed pongs in a row
(~10–12s of silence) is treated as a lost connection, via the exact
same `handleConnectionLost()` path a clean tab close uses — both route
into `GameTable.markDisconnected()`, never straight into the old,
blunt `removePlayer()`. A configurable grace period then runs (default
30s, Table-Owner-adjustable from the new Settings dialog) before the
Player actually converts to Sitting Out. The heartbeat interval itself
is a server-level constant, not Table-Owner-exposed — a technical
tripwire, not a social preference, per the explicit reasoning worked
through with Mike (server load, false-positive risk on a merely laggy
connection).

## Part C — Involuntary timeout ≠ voluntary Sit Out

A disconnect that runs out its grace period converges into the
existing Sitting Out mechanic, but with a deliberately different
resolution rule than Sit Out's own explicit "Fold and Sit Out": check
if free, fold only if actually facing a live bet
(`_resolveAbsentPlayerTurn()`), reusing the exact "amount owed" figure
the client's own "$YY to You" display is built from. Caught and fixed
during this build's own testing, before it shipped: an early draft
reused Sit Out's unconditional-fold logic for this path, which would
have folded a disconnected Player who owed nothing.

## Part D — Reconnect codes

Every seated Player gets a 6-character reconnect code the moment they
join (not only once they first disconnect), shown on their own rail so
they don't need to ask the Table Owner for it, and visible to the
Table Owner for every seated Player via the new Settings dialog. A
currently-connected Player's code cannot be used from a second device
— rejected with the same generic message a wrong code gets, so a
guesser learns nothing either way. Reconnect attempts are rate-limited
per IP (5 attempts/minute, then a 5-minute cooldown).

## Part E — Dealer-specific handling

A disconnected Dealer's role transfers via a **direct call to
`_reassignDealerToNextEligible()`**, never `passTheBuck()` — confirmed
during the reconciliation pass that `passTheBuck()` genuinely cannot
serve this purpose (requires the Dealer themselves as requester; gated
to between-hands only). If the handoff happens mid-cycle, the
**positional anchor splits**: the original Dealer's seat stays the
blinds/first-to-act reference for the rest of the current cycle even
though `isDealer` has already moved, via a new `dealerPositionAnchorId`
field consulted at every call site that used to read the Dealer's seat
purely for position. Clears automatically the moment the cycle
actually closes (`_setHandPhase()`, the one place a cycle boundary is
recognized). Disconnected candidates are correctly skipped when
picking a replacement Dealer, generalizing to multiple simultaneous
disconnects.

## Part F — Leave Table / Remove Player (a real gap, not in the
original 10.0-era reconnection design)

`leaveTable()`/`removePlayerFromTable()` reuse the exact same
`_isPending()` gate Buy Chips already relies on: no unresolved stake,
leave immediately; a pending stake, choose fold-now-and-leave or
wait-until-cycle-close (mirroring Sit Out's own existing choice).
Compaction of the seat list only ever happens at a cycle boundary,
never mid-cycle, even when the departure itself was triggered
mid-cycle — a deferred departure reuses the fully-audited Sitting Out
machinery (`pendingDeparture` is consulted in exactly one other place:
the cycle-close hook) rather than teaching a new eligibility concept to
every consumer.

**`removePlayer()` itself was reconciled, not retired** — the spec's
own groundwork had flagged this as a genuine open question. It's now
exclusively the "permanently delete this seat" primitive, called only
at the moment a departure actually takes effect, fixed to reassign the
Dealer role properly (`_reassignDealerToNextEligible()`, not
"whoever's first in turn order") and to handle an in-flight pot claim
deliberately: a departing Player who held only the **approver** role
(no real stake) gets their approval reassigned to the next eligible
Player instead of the whole claim being silently voided; a departing
proposer or allocation recipient still voids the claim outright — the
safe fallback, and, per Mike's own explicit call, not something this
needed to get perfectly right in every combination (Table Owner
Functions 1–3 remain the backstop for exactly this class of edge case).

End Game (Part F.6) is a new, real Table Owner function — distinct
from Function 1 (Terminate Cleanly), which only ends the current hand.
End Game disconnects every seated Player and deletes the table itself.

## Part G — Notifications

Disconnect, reconnect, grace-period expiry, and departure all queue an
immediate table-wide announcement from inside `GameTable` itself
(consistent with how every other announcement in this codebase already
works), plus the one row the notification table required that hadn't
existed anywhere before 11.0: a brand-new Player joining (including
session start) now also announces itself. A failed or blocked
reconnect attempt is deliberately silent — no announcement, so a
guesser or a legitimate device conflict both look the same to everyone
else at the table.

## Part H — Table lifecycle

Two independent timeouts, checked on a single shared 60-second sweep
rather than a timer per table:

- **H.1 (zero connections):** if literally nobody is connected to a
  table for 45 minutes, it's wiped with nobody left to notify.
- **H.2 (idle but connected):** if no real activity happens at a table
  for 30 minutes, it closes and every connected Player is notified and
  returned to the lobby. "Real activity" is any message against an
  already-established table context, touched generically at the
  dispatch layer rather than sprinkled through every individual
  game-action method — a join or reconnect touches it explicitly
  inside `GameTable` itself.

Both timeouts share one server-computed fact — `tableCloseAt`,
`toRedactedState`'s own field — which the client reads directly for
its T-5-minute banner (everyone) and T-1-minute popup (Table Owner
only, with a "Keep Table Open" button), per the Standing Convention:
the server computes the real answer once, the client never re-derives
it. The actual authoritative close is enforced server-side regardless
of whether any client is even watching the clock.

## Part I — The required exhaustive eligibility audit

Walked every named consumer (`_isHandParticipant`, `_canAct`,
`_isPending`, turn order construction, claim eligibility, dealing)
against the new states 11.0 introduces (mid-grace-period,
timed-out-into-Sitting-Out, reconnecting, pending-departure). Most of
this machinery needed no change at all — a mid-grace-period Player
(`connected: false`, `sittingOut` still `false`) is correctly still
treated as a full, live hand participant everywhere, which is exactly
the "table freezes, waiting for them" behavior Part B calls for.

**One genuine gap found and fixed:** nothing stopped a brand-new hand
from being dealt while a Player was disconnected but hadn't yet timed
out — they'd be dealt cards and assigned an ante they had no way to
post. Fixed at the two actual entry points, `startGame()`/`newHand()`,
which now reject while anyone is disconnected (`anyoneDisconnected`,
exposed via `toRedactedState` so the "Start"/"Same Game"/"New Hand"
controls are disabled client-side with an explanation, per the
Standing Convention, rather than left clickable and rejected after the
fact).

**A broader version of that same fix was drafted first, then reverted**
after tracing a real cross-consumer regression it would have caused:
excluding `connected: false` directly from `_computeBlindSeats()`
would have broken that function's OTHER caller
(`openBetting()`'s PreFlopBetting recomputation, which must reproduce
the exact same blind assignment already used to seed real posted money
at RequestAntes — even if that Player's connection status changes in
between). `_computeBlindSeats()` itself is deliberately unchanged;
there's a regression test pinning down exactly why. Recorded here
because it's the kind of thing Part I's own audit discipline exists to
catch, not because it shipped.

## Review pass — three items found and fixed

A first-pass review against `the-cut-spec_v11-0.md` found the
substance of the build sound (in particular, the `removePlayer()`
reconciliation and claim-approver handling above were confirmed
correct on direct reading) but flagged three real gaps, all fixed
here:

1. **Leave Table's mid-cycle confirmation dialog** stated the
   chip-loss/immediate-fold consequence only in a button's hover
   tooltip, not in the dialog's own visible body text. Fixed —
   `#leave-table-dialog-consequence` states it plainly.
2. **No visual separation** existed between ordinary Player Rail
   controls and the Table-Owner-exclusive section, per Mike's explicit
   request for "a line... maybe some text to go along with it." Fixed
   — reuses the existing `.rail-divider` line (already used four times
   on the Dealer's Rail) plus a new "Table Owner" label, both toggling
   in lockstep with the section itself.
3. **This README** wasn't updated for 11.0 at all before this pass —
   now is.

**A fourth item, found while re-running the live smoke test after the
above fixes, not from the review document:** the Part G "player
joined" announcement was correctly queued by `addPlayer()`, but
`handleCreateGameTable()`/`handleJoinGameTable()` in `server.js` never
actually called `broadcastAnnouncements()` — so it was silently
dropped every time, for every table, since the moment Part G was
built. Fixed by adding the missing call to both handlers, alongside
the state broadcast they already send.


**Corrected against `the-cut-spec_v10-4.md`'s final "10.4 Completion"
section**, added after review of the first v10.4 delivery flagged two
client-only gaps. `npm test` — still **393** (no net change; this
correction pass added client-side wiring and one live-test extension,
no new unit-testable server logic). Live end-to-end verification
extended (`live_test_10_4.js` now also covers `misdealStuckAntes`'s
wire shape) and re-run clean, alongside every prior version's own live
test.

**Gap 1 (Table Owner Tools button visibility) — corrected, not
skipped.** The prior pass in this build re-checked the code, found the
button's *wrapping group* already hidden for non-owners
(`el.tableOwnerRailGroup.hidden = !isOwner`), reasoned that has the
same visual effect, and left the button itself untouched — substituting
that inference for the spec's own explicit, cheap, unambiguous
instruction instead of just doing what was asked. There's no way to
render this in an actual browser from this environment to confirm the
visual result either way, so there was no real basis for confidence
strong enough to override an explicit instruction. Fixed now:
`el.btnOpenTableOwnerDialog.hidden = !isOwner` set directly, alongside
the existing group-level hiding, matching the spec's own literal
request.

**Gap 2 (Misdeal has no client control), confirmed and fixed.** A new
Dealer-visible (not Table-Owner-only — `misdealStuckAntes()` is a
Dealer-level action, matching every other Dealer control on the same
rail) "Misdeal (Stuck Ante)" button, visible/enabled only when
`stuckAntePlayerIds.length > 0` (the already-exposed field read
directly, not re-derived), placed in the Dealer rail next to Set
Ante/Blind since the concern is cross-cutting across all three
profiles, not a single profile's own rail table. A native `confirm()`
gut-check before firing, matching Terminate/Restore's own established
pattern for a real, one-shot emergency action.

**Combined release again, same reason as 10.3: testing time is the real
bottleneck.** Built from `the-cut-spec_v10-4.md` (Standing Convention +
Parts A-E). `npm test` — **393 tests** (up from 388 in v10.3 — a net
+5: 7 new, 2 removed after B.2's own approach was superseded/reverted
and its test no longer reflected shipped behavior). Live end-to-end
WebSocket verification run and passed (`live_test_10_4.js`, exercising
the exact wire message shapes the new client UI sends), plus a re-run
of every prior version's own live test confirming no regression
anywhere in the 10.0→10.4 line.

## New Standing Convention, effective immediately

Whenever a user action needs blocking, it must be enforced server-side
AND reflected client-side (the control disabled, not left clickable to
bounce off a rejection) — Mike's own direct call, after B.3 shipped
server-side only in 10.3 and the client's Buy Chips button was never
updated. Applied here to close that specific gap
(`_canBuyChips()`, shared between `buyChips()` and `toRedactedState`),
and to Part E's own client counterpart below — governs every future
gating change from here on, not just this release.

## Part A §5 — Table Owner Tools now actually reachable

**The real headline of this release.** 10.3 built all three Table
Owner recovery functions correctly server-side, but shipped with zero
client UI — confirmed by direct inspection that they were completely
unreachable through the app, hand-crafted WebSocket messages only.
Built: an owner-only "Table Owner Tools" button (player rail, visible
only when `creatorId === the viewer's own id`), opening a dialog with
Terminate Cleanly and Restore Stacks (native `confirm()` gut-checks —
destructive, owner-only, one-shot actions, not worth a second custom
dialog layer) and the full Pot Distribution staging workflow (begin,
add/remove allocations, a live preview of the resulting pot and
affected stacks, discard, commit). Everyone else sees the simplified
"please stand by" indicator already spec'd as an acceptable fallback in
10.3's own delivery.

**A real gap found while wiring this, not part of the spec's own list**:
none of `terminateGameCleanly`/`restorePlayerStacks`/`commitPotDistribution`'s
`server.js` handlers ever drained the announcements those methods
queue — they'd fire, then vanish. Fixed all three, plus `openBetting`'s
new one from Part E below.

## Part E — Stud all-in lockup (live-confirmed, fixed)

5-Card Stud, all four remaining Players go all-in by 2nd Street; B.1's
own fix correctly deals 3rd Street's card to everyone; the Dealer then
can't open betting at all — Stud's opener requirement (`_canAct(opener)`)
can never be satisfied once every remaining Player is `bettingCapped`,
and the dropdown is correctly empty. Root cause traced fully before
fixing: `_maybeCloseBettingRound()`, called unconditionally at the end
of `openBetting()`, already handles an empty "who can still act" list
correctly (`[].every(...)` is vacuously true) — already proven, already
used successfully by Hold'em/Draw in this exact scenario. Fixed by
skipping the opener requirement entirely when nobody at the table can
act at all, falling through to that same already-proven path — no new
closing/advancing logic, only a bypass of the one gate that didn't know
how to handle "nobody can act." Client-side counterpart per the new
Standing Convention: a new `anyHandParticipantCanAct` field lets the
Open Betting control distinguish "nobody selected yet" from "nobody
CAN act, betting will auto-skip," instead of both looking identical
(disabled, empty dropdown, no explanation).

## B.2 — reverted, replaced

The 10.3 partial-post fix is **reverted outright, not patched further**.
Live testing surfaced a real, cascading, money-affecting defect it
wasn't designed against: blind-seat *identity* is deliberately never
persisted in this codebase (computed fresh by `_computeBlindSeats()`,
called once during ante collection and again, independently, inside
`openBetting()`) — an invariant that held safely pre-10.3 because
nothing could drop a Player's chips from positive to exactly `0` in the
gap between those two calls. The partial-post fix broke that invariant,
and a second, independent blind-seat computation could then disagree
with the first about who actually posted — live-confirmed to cascade
into three separate symptoms (the real Big Blind never dealt in, a
wrong Player skipped as actor entirely, `currentBet` seeded to an
amount never posted). Two live, cascading, money-affecting defects from
one change was the bar for reverting rather than attempting a third
containment patch.

`postAnteBlind()` is back to exact pre-10.3 behavior. The replacement,
per Mike's own original instinct: **misdeal and bail out**. New
`misdealStuckAntes()` — Dealer-level (not Table-Owner-only, since a
stuck ante is an ordinary game-flow problem, not an emergency requiring
table ownership), gated to the genuinely-stuck case via a new
`_stuckAntePlayers()` helper (not just "any time RequestAntes is
active," which would let a Dealer misdeal a perfectly normal ante
collection). Reuses `_forceTerminateCurrentHand()` — the exact reset
Function 1 already uses and this same version already re-verified
correct — leaning entirely on already-proven machinery.

## Part C, Part D — small, low-risk, done

**Part C**: a Cancel/Back button on the Options/Start popup, visible
only in the same editable (Dealer, idle) state Start itself requires —
reopens Select Game Choice via the exact same, already-safe path the
main Select button uses. No server-side change; `setGameChoice()`
already supported being called again at any time while idle.

**Part D**: `buildDate` moved into `package.json` alongside `version`,
read the same way — piggybacks on the one manual release step that's
already proven reliable every release (bumping `version`), rather than
asking anyone to remember a second, separate edit in a different file
(missed for at least several releases, found stuck at a date predating
10.0).

## How the highest-stakes tests were verified — not just "they pass"

Same adversarial discipline as 10.2/10.3: every new test touching a
live-confirmed defect was checked by temporarily reverting its fix and
confirming the test actually fails without it, then restoring and
confirming green. Checked directly this way: Part E's lockup fix
(confirmed the test fails with the bypass disabled) and both new
`misdealStuckAntes()` tests (confirmed they fail — one via a wrong
assertion, one via an actual thrown `ReferenceError` — with the
stuck-case guard removed). The live end-to-end test itself also caught
a real bug in its own test harness before it shipped: the `act()`
helper assumed every action broadcasts to both connected sockets, but a
*rejected* action only ever replies to the actor — a naive turn-order
assumption (assuming the Table Owner always acts first) would have hung
the test forever waiting for a message that was never coming.

## What's still open, carried forward unchanged

Exact reconnect-window duration, Side Pot Attributes, a dedicated Table
Owner regression fixture (still deferred, per the 10.3 decision), and
§3.3's richer per-Player live Pot Distribution view (still deferred,
per Mike's own explicit 10.3 call) — none touched by this build beyond
what's already noted in prior versions' own README sections.

---

**Combined release, per Mike's explicit call: testing time is the real
bottleneck, so everything ready ships together in one pass.** Built
from `the-cut-spec_v10-3.md` (Part A + Part B). `npm test` — **388
tests** (up from 371 in v10.2 — 17 new). Live end-to-end WebSocket
verification run and passed (`live_test_10_3.js`, focused on the two
highest-stakes pieces), plus a re-run of every prior version's own live
tests confirming no regression anywhere in the line.

## Deferred, deliberately — flagging for the Spec chat

Mike agreed with a recommendation made during this build's planning:
**no dedicated regression fixture** (matching the project's existing
`side-pot-scenario-reference.md`/`refund-scenario-reference.md`
convention) for the three Table Owner functions this release. Instead,
this release relies on direct code verification plus a solid in-suite
test file (`test/gameTable-10-3.test.js`). The reasoning, given the
timeline pressure: building a worked-example fixture now, before anyone
has actually used these tools live, risks encoding guessed scenarios
rather than the ones that turn out to matter. Once beta testing has
exercised Functions 1-3 for real, a dedicated fixture — if still
wanted — can be built from what actually happened, not from
speculation. This is an open item for `the-cut-spec_v10-3.md`'s own
"Open items" section to close explicitly, not something resolved
silently here.

## Part A — Table Owner Recovery Functions (NEW)

Authority: the existing `creatorId` — no new auth concept. All three
functions gated `creatorId`-only, matching the existing
`setTableName`/`setSuggestedBuyIn` permission pattern exactly.

**Function 1 (`terminateGameCleanly`)**: force-ends the current hand
from any phase via a new shared internal helper
(`_forceTerminateCurrentHand()`, built on the existing
`_performFullReset()`), adding only `handPhase = 'CycleComplete'`,
`idle = true`, and an explicit `pendingClaim = null`. Verified directly,
not assumed: `_performFullReset()` already leaves `chips`/`totalBuyIn`/
`this.pot` completely untouched, and already clears any paused
Baseball-style deal interrupt — no special-casing needed for either.
Verified live over real sockets that a genuinely pending claim is truly
**denied**, not silently discarded: no money moves, the pot stays fully
intact.

**Function 2 (`restorePlayerStacks`)**: independently invokable, reuses
the existing `snapshot()`/`restore()` pair in `src/player.js` (built in
v8.0, never called until now). A new hook in `_enterRequestAntes()`
captures `this._preGameSnapshot` fresh at the start of every genuinely
new hand. **Per Mike's explicit direction**: rejects outright (with a
clear message) if invoked before any hand has ever started this
session, rather than silently no-opping or restoring to a meaningless
state — verified this isn't just a rejected-with-a-message case but a
genuine crash-prevention guard (`restore()` itself throws on a `null`
snapshot without it).

**Function 3 (Pot Distribution — `beginPotDistribution`/
`stageAllocation`/`updateStagedAllocation`/`removeStagedAllocation`/
`discardPotDistributionBatch`/`commitPotDistribution`)**: a staged
batch of `take`/`give` allocations against `this.pot`, freely edited,
live-previewed, applied only on an explicit commit — **or none of it**.
Commit re-validates by the **net effect per Player**, not per entry —
directly verified this distinction matters: a Player with two separate
`take` entries that each individually fit their current chips can still
overdraw when combined, and the net-effect check catches this while a
naive per-entry check would not (confirmed by reverting to a per-entry
check and watching the test fail). **Gated to idle for both staging and
commit**, not just commit — Mike's own explicit confirmation: these are
emergency unlock functions, reserved for the Table Owner, always
invoked at an already (fatally) idle table.

**Visibility, deliberately simplified from the spec's own richer
design, per Mike's explicit fallback authorization**: §3.3 called for a
persistent, live-updating detail view for every seated Player. Built
instead: a simple `tableOwnerDistributionInProgress` boolean, true for
everyone while a batch is open (drives a standing "Table Owner
functions have been invoked, please stand by" indicator), with the full
staged-batch detail and live preview (`pendingAllocationBatch`) sent
only to the Table Owner themselves. If the richer per-player live view
is wanted for a future release, it's a straightforward extension of
this same field, not a redesign.

## Part B — Gameplay Fixes from 10.2 Live Testing

**B.1 (Stud's `deal()`, later streets)**: 10.2 correctly added a
`hand.length > 0` check for streets B-E but left the pre-existing
`chips > 0` requirement in place alongside it — never re-examined
together. A genuinely all-in Player surviving from an earlier street
was wrongly excluded from receiving their next card, live-confirmed to
block dealing entirely once enough of the table was all-in. Fixed by
dropping `chips > 0` for the later-street case specifically, leaving it
completely unchanged for the initial deal (Hold'em/Draw/StreetA), where
it remains correct.

**B.2 (`postAnteBlind()` partial post)**: a Player short of the full
ante/blind now posts what they have and goes `allIn`/`bettingCapped`,
exactly mirroring every other all-in in this codebase — everyone else
still faces the full nominal amount, confirmed directly
(`openBetting()`'s existing `currentBetToCall` seeding needed no
change, per the spec's own explicit retraction of an earlier
misidentified second defect). One genuine edge case preserved, not
covered by the spec's own text: a Player with *exactly* `$0` chips
(reachable via a Dealer manually assigning an ante via the real
`setAnteBlind()` method) is a different case from "some chips, not
enough" and still correctly rejects — verified against the existing
test that already asserted this. `oweAnte` is zeroed unconditionally
after posting, not just reduced by the posted amount — checked the
client directly and confirmed it displays `oweAnte` as an "Owes $X"
badge and a still-clickable action; leaving a stray remainder would
have shown a misleading, functionally-dead control for a Player who has
$0 chips and cannot post more.

**B.3 (`buyChips()` during `RequestAntes`)**: one narrow additional
check, deliberately *not* folded into `_isPending()` itself — that
function has exactly two other consumers and a distinct meaning
("eligible to win a portion of a pot"), and broadening it would have
repeated the exact "two things sharing one name" pattern this project
has spent three versions fixing.

## How the highest-stakes tests were verified — not just "they pass"

Following the same discipline established in 10.2 after two masked
false-positive tests shipped there: every test touching real money
movement or Function-1/3's core guarantees was checked by temporarily
reverting its specific fix and confirming the test actually fails
without it, then restoring and confirming green again. Checked directly
this way: Function 1's claim-denial, Function 2's pre-snapshot crash
guard, Function 3's atomic net-effect commit guard, and both B.1/B.2.
None needed a second attempt this time — each caught its bug on the
first adversarial check, unlike several of 10.2's own first drafts.

## What's still open, carried forward unchanged

Exact reconnect-window duration, Side Pot Attributes, and a dedicated
Table Owner regression fixture (see above, explicitly deferred) — none
touched by this build beyond what's already noted.

---

**URGENT addendum — complete, exhaustive server-side re-audit**, per
`the-cut-spec_v10-2.md` §9, following two more live-testing failures in
normal Draw play after 10.1 shipped. `npm test` — **371 tests** (up from
361 in v10.1 — 10 new, one per confirmed defect, each individually
verified by temporarily reverting its fix and confirming the test
actually fails without it — see "How these tests were verified" below).
Live end-to-end WebSocket verification run and passed
(`live_test_10_2.js`, focused on the most severe item), plus a re-run of
both 10.0's and 10.1's own live tests confirming no regression.

## A discrepancy worth naming plainly

§9.1 states "two [live-confirmed] plus four [audit-confirmed] equals
six" defects. §9.3's actual enumerated list has **eight** numbered
items. This is a real inconsistency in the delivered spec text, not
something resolved during this build — the enumerated list is what's
actionable, so all eight were fixed regardless of the prose count. Worth
flagging back to the Spec chat, not silently reconciled here.

## The eight defects, fixed

**Items 1, 3, 6, 7 — the same missing-dealt-in-check pattern as 10.1,
in different call sites the 10.1 pass didn't reach:**

- **Item 1** (live-confirmed by Mike — the most severe): `openBetting()`'s
  first-actor anchor selection ran its own one-time
  sittingOut/folded/allIn/bettingCapped check instead of delegating to
  the already-fixed `_nextTurnPlayerId()` loop — a never-dealt Player
  could be set as `currentTurnPlayerId` directly, bypassing turn-order
  entirely. Fixed by routing through `_canAct()` and delegating to
  `_nextTurnPlayerId()`, same as the pattern established in 10.1. Also
  fixed the adjacent Stud opening-bettor re-validation, found in the
  same immediate neighborhood during this pass, same defect signature.
- **Item 3**: the uncalled-bet refund's ceiling computation counted a
  never-dealt Player as a real opponent with a `$0` ceiling — reachable
  specifically when they're the *only* other seat, which is why 10.1's
  broader sweep didn't happen to construct this exact scenario.
- **Item 6**: Stud's `deal()`, reused across every street, filtered
  recipients by `chips > 0` alone from 3rd Street onward — a Player who
  bought chips *between* two Stud streets could be dealt into a hand
  already in progress. Fixed by adding a dealt-in-from-StreetA check for
  later streets specifically, leaving StreetA's own (correct) `chips >
  0` logic untouched.
- **Item 7**: the claim-approval fallback search used
  `!sittingOut && !folded` with no dealt-in check — a never-dealt Player
  could be selected to approve a real money claim.

**Item 2 — a genuinely different category, per §9.2's own framing, not
a missing eligibility check:** `_checkUncalledBetRefund()` correctly
updated the refunded Player's own `chips`/`totalContributedThisHand`/
`currentBet`, but never resynced `currentBetToCall` — the one value
every *other* Player's Call/Check/Raise decision is computed from.
Live-confirmed by Mike: an all-in for $2,300 correctly refunded down to
$750, and the next Player to act was shown $2,300 owed. Fixed by
mirroring the exact adjustment already applied to `currentBet`, onto
`currentBetToCall`, in the same place.

**Items 4, 5 — deliberately NOT the standard pattern.** Before applying
`_isHandParticipant()` here, verified directly that `maxDiscards` has no
ceiling relative to `cardsPerPlayer`, so a Player can legitimately
discard their *entire* Draw hand (`hand.length === 0`) while genuinely
awaiting a redraw. A bare dealt-in check would have wrongly excluded
them — a regression this build would have introduced, not fixed. Built
`_wasDealtOriginalHandThisRound()` instead: `discardPhaseActed ||
hand.length > 0`, verified safe because both `discard()` and
`standPat()` already reject a never-dealt Player before either could set
`discardPhaseActed` (confirmed by direct trace, not assumed). Both
`dealToAllPlayers()` and `dealToPlayer()` now use this, with a dedicated
negative-case test each confirming the legitimate full-hand-discard
scenario still redraws correctly.

**Item 8**: `declare()` had no dealt-in guard at all, unlike its sibling
`standPat()`. Added the identical `hand.length === 0` guard, matching
`standPat()`'s own convention exactly.

## How these tests were verified — not just "they pass"

Every one of the 10 new tests was checked by temporarily reverting its
specific fix in isolation and confirming the test actually fails without
it, then restoring the fix and confirming it passes again — for every
single item, not a sample. This caught two real problems in the tests
themselves before they shipped:

- **Items 2 and 3's first drafts passed even with the bug present**,
  because the test setup happened to route around the exact condition
  the bug requires (a real opponent's higher ceiling masked the
  phantom's `$0` ceiling in `Math.max()`). Rewritten so the phantom is
  the *only* other seat — the exact condition §9.3 itself describes.
- **Items 1 and 7's first drafts had the same masking problem from a
  different cause**: the never-dealt Player wasn't seated in the exact
  turn-order position the buggy code actually checks first, so a real,
  legitimate candidate was found before ever reaching the phantom.
  Rewritten with the phantom seated directly after the Dealer, the exact
  position both bugs check first.

Worth recording as its own lesson: a passing regression test is not
proof of anything by itself. The adversarial check (revert the fix,
confirm red; restore it, confirm green) is what actually establishes
that.

## Decisions made without an explicit spec answer

- **`_wasDealtOriginalHandThisRound()` as its own function, not a reuse
  of `_isHandParticipant()`**: a deliberate departure from "route
  everything through the existing shared layer," made only after
  verifying the existing layer would have been actively wrong for this
  specific case (see items 4/5 above). Named distinctly rather than
  overloading `_wasDealtIn()`'s meaning, which is exactly the "two
  concepts, one name" failure mode this whole re-architecture exists to
  prevent.
- **The §9.1 "six vs. eight" discrepancy left unresolved, not
  silently picked**: flagged above rather than guessing which count is
  authoritative.

## What's still open, carried forward unchanged

Exact reconnect-window duration, Side Pot Attributes, and Buy-Chips
amounts/limits — none touched by this build, none needed to be.

---

**MAJOR-line MINOR — centralized eligibility evaluation, per Mike's
direct instruction after 10.0's live testing surfaced a recurring
defect class.** Built from `the-cut-spec_v10-1.md` §8. `npm test` —
**361 tests** (up from 351 in v10.0 — 10 new, one per confirmed defect
plus the bonus bug found this session). Live end-to-end WebSocket
verification run and passed (`live_test_10_1.js`), plus a re-run of
10.0's own live test to confirm no regression.

## Why this version exists

Mike's own live testing of the delivered v10.0 build found the same
underlying defect, in different forms, in at least nine separate places
across server and client — every instance traced to the identical root
cause: a decision about what a Player can currently do was computed
independently, inline, at each point that decision was needed, instead
of through one shared, centrally-defined answer. 10.0 introduced a new
possibility (a Player seated with `$0` chips, never dealt into the
current hand) that none of these nine scattered checks accounted for,
because none of them shared a definition to fix in one place.

Mike's explicit direction: organize every status/condition check into
functions, so a future change happens in one place, not scattered
across the codebase where it can't reliably be found. Agreed directly,
without reservation — this is the same "two concepts, one name" lesson
that justified the whole 10.0 re-architecture, applied one level up
from data fields to shared questions.

## The shared eligibility layer (`src/gameTable.js`)

A small, deliberately layered set of functions, each building on the
last, replacing every independent inline reimplementation:

- **`_wasDealtIn(player)`** — the true base fact: was this Player
  actually dealt into the current hand? `hand.length > 0`, with one
  critical exception found before applying this broadly: the legacy
  no-Game-Choice "flexible toolbox" mode (still extensively exercised
  by `gameTable-core.test.js`) never calls `deal()` at all and has no
  dealt-in/never-dealt-in distinction to make — scoped to phase-gated
  profiles only, so that whole mode is untouched by construction, not
  by luck.
- **`_isHandParticipant(player)`** — dealt in, not folded, not sitting
  out. The base "is this Player part of the current hand at all"
  question the spec explicitly asked for.
- **`_canAct(player)`** — a hand participant who can still take a
  betting action: additionally not all-in, not bettingCapped.
- **`_isPending(player)`** (10.0, refactored here to build on
  `_wasDealtIn()` instead of its own copy of the same check — no
  behavior change).
- **`_currentClaimEligiblePlayerIds()`** — who can currently claim/
  receive the current pot, uniformly across the multi-pot and ordinary
  single-pot cases.
- **`_claimWindowOpen()`** — is there actually anything claimable right
  now (Showdown, or the early-claim single-eligible-player condition)?

## Every confirmed defect, fixed

**A. Missing dealt-in check (7 sites)** — turn order
(`_nextTurnPlayerId`), betting-round close (`_maybeCloseBettingRound`),
Draw's Discard-phase and Stud's Declare-phase completion checks, the
heads-up raise-cap waiver (2 sites) and the opponent-ceiling calculation
on a voluntary Bet/Raise, and `setOpeningBettor()` (server validation —
confirmed live that a Dealer could select a never-dealt `$0` Player and
the server would accept it). All now route through `_canAct()` or
`_isHandParticipant()`.

**B. Client independently re-deriving eligibility (2 sites, plus 3 more
found and fixed during the same pass)** — the Claim Pot button never
considered hand phase or the early-claim condition at all; the per-pot
hover text was never filtered against `provenLosers`. Both fixed by
exposing new server-computed fields (`claimEligiblePlayerIds`,
`claimWindowOpen`, per-pot `liveEligiblePlayerIds`,
`eligibleOpeningBettorIds`, `isHandParticipant`) via `toRedactedState`
and having the client read them directly — per §8.2, the client no
longer inspects `folded`/`sittingOut`/`allIn`/`bettingCapped` in
combination anywhere. Beyond the two originally listed, three more
client-side re-derivations of the identical folded/sittingOut
combination were found and fixed for consistency (the raise-cap
heads-up indicator, twice, and the opponent-ceiling bet-limit hint) —
not confirmed defects on their own (the server always re-validates on
submit regardless), but the same pattern, closed for the same reason.

**C. Inconsistent trigger/timing (2 sites)** — `sitOut()`'s
`foldAndSitOut` mode only force-folded a Player if a betting round
happened to be open at the exact instant it was called, leaving a
Player who sat out mid-Discard-phase or mid-Declare-phase still holding
an unresolved hand. Fixed by gating the fold on `_canAct()` instead of
`bettingOpen` — with an explicit negative case confirmed by test: a
genuinely all-in Player is correctly NOT force-folded, since there's
nothing to fold from and doing so would incorrectly zero out real pot
equity. Queued Sit-In intent resolved immediately when a claim resolves
and the hand goes idle; queued Sit-Out intent didn't, only resolving at
the next `deal()`. Fixed by calling `_applyPendingSitOuts()` alongside
the existing `_applyPendingSitIns()` call, symmetrically, at the same
idle-transition point.

## One additional bug, found via direct reproduction, not in the
original 11

While fixing `openBetting()`'s missing dealt-in check, reproduced a
**more severe, pre-existing, hand-blocking bug**: a legitimately all-in
Player surviving from an earlier street (chips `=== 0` for a completely
normal, in-game reason) was *also* excluded by the old `chips > 0`
filter — with no path forward, since the early-claim shortcut doesn't
apply while two genuinely pot-eligible Players remain. Reproduced
directly (two Hold'em Players, short stack all-in pre-flop, both
survive to the flop) before fixing, and again after, both as a
standalone script and as the centerpiece of this version's live-socket
test. This predates 10.0 — the same "who counts as active" ambiguity,
just never previously triggered by a reachable scenario during testing.

## Decisions made without an explicit spec answer

- **`claimPot()`'s proposer/recipient eligibility, unified across modes**:
  the pre-existing multi-pot path already required the proposer be
  eligible for the current pot; the ordinary single-pot path had no such
  check at all. Generalized the existing multi-pot rule to both, rather
  than inventing a new one — closes a real, if minor, gap rather than
  just refactoring around it.
- **Which client-side re-derivations to also fix beyond the 2 explicitly
  listed**: extended to every site sharing the identical
  folded/sittingOut combination (3 more found), on the reasoning that
  §8.4's own completion criterion is "no remaining client-side
  eligibility logic," not "no remaining known bugs." Left narrower,
  single-purpose visibility gates (Fold-at-Showdown, Discard
  availability) untouched — each carries its own distinct extra
  conditions (phase, `discardPhaseActed`, `maxDiscards`) that don't map
  cleanly onto the shared functions, and none were confirmed defects.

## What's still open, carried forward unchanged

Exact reconnect-window duration, Side Pot Attributes, and Buy-Chips
amounts/limits — none touched by this build, none needed to be.

---

**MAJOR — Seat/Player/Dealer re-architecture, first build.** Built from
`the-cut-spec_v10-0.md` (finalized, Mike-confirmed), grounded against
`the-cut-current-state-v9-7.md`. `npm test` — **351 tests** (up from 339
in v9.7 — 12 new, all covering genuinely untested behavior this spec
introduced or clarified). Live end-to-end WebSocket verification also
run and passed (`live_test_10_0.js`), per project convention — not just
the in-process suite.

## What changed

**Seat as a concept** is not yet built in code — per the spec's own §1,
its only real value today is reconnection continuity, and reconnection
is 11.0's work. Nothing to build here yet; noted so it isn't mistaken
for an oversight.

**The real work this build did**: formalizing "pending" (spec §2.1) as
an actual computed signal, and enforcing/exposing it everywhere the
spec requires.

- Added `_isPending(player)` (`src/gameTable.js`) — one function
  implementing the spec's definition exactly: eligible to win at least
  a portion of any unclaimed pot. `!idle && !folded &&
  !provenLosers.has(id) && hand.length > 0`. Deliberately independent of
  both `allIn` (display, clears on refund) and `bettingCapped` (acting
  restriction) — confirmed via new tests that a genuinely all-in player
  stays pending, and a folded/provenLosers player is never pending even
  while the hand continues for others.
- **Real bug found, not previously flagged in any source document**:
  `buyChips()` had **no gate at all** on Player status before this
  build — confirmed by direct inspection, not assumed. Any player could
  buy chips at any time, including mid-pending-hand, with no server-side
  check whatsoever. Fixed by gating on `_isPending()`.
- `toRedactedState` now exposes `pending` per player, following the
  existing `excludedForZeroChips` pattern (server computes once, client
  reads) — the same principle the project has used since 9.x.
- **Client-side gap, also not previously flagged**: `provenLosers` was
  already sent over the wire every state update but never read anywhere
  in `client.js`. Two consequences, both fixed:
  - The Claim Pot button's `canClaim` check never excluded
    `provenLosers` — a player excluded from all remaining pots could
    still see Claim as available in some cases (spec §4's whole reason
    for existing).
  - Buy Chips (`btnOpenBuyDialog`) was never gated at all client-side,
    matching the server-side gap above.
  Both now disable (not hide) with an explanatory title, consistent
  with the existing Claim Pot pattern from 5.2.
- **New visual state**: a player who lost a side pot and is excluded
  from all remaining ones now gets `.is-lost-side-pot` (dimmed, same as
  Folded) plus its own `Out of Hand` badge (`seat-lost-pot-badge`, dusty
  rose) — a distinct third state from Folded, per spec §4.1's explicit
  requirement that it not collapse into either "still active" or an
  indistinguishable Folded variant.

## Verified, not built — the two previously-flagged Dealer behaviors

Spec §3/§7 flagged two behaviors as "confirmed by Mike as requirements,
but not yet verified against the live 9.7 app." Both were checked by
direct code inspection before any 10.0 code was written, and both were
**already correctly built**, requiring no fix:

- A Dealer is already unconditionally blocked from `sitOut()` with the
  exact message *"The Dealer can't sit out -- Pass the Buck first."*
- A pending/`$0` Dealer already keeps running the table — `deal()`,
  `openBetting()`, and every other Dealer-only action gate solely on
  `dealer.id !== requesterId`, never on the Dealer's own chip/pending
  status.

Both now have explicit regression coverage in `test/gameTable-10-0.test.js`
so this verification is locked in going forward, not just a one-time
inspection.

## Decisions made without an explicit spec answer

- **How "dealt into this hand" is detected for the pending calculation**
  (`hand.length > 0`): the spec defines pending in pure game-rules terms
  and explicitly leaves representation to Dev chat (§4.2's own framing,
  applied here by extension). A player never dealt into the current hand
  (sitting out, or excluded for $0 chips) has no stake in anything and
  is correctly never pending regardless of `folded`/`provenLosers` —
  confirmed via a dedicated test.
- **provenLosers storage left untouched** (`src/gameTable.js`'s existing
  table-level `Set`, not moved to a per-Player field) — spec §4.2
  explicitly calls this Dev chat's call, not a spec question. Chose not
  to move it: the existing pattern already supports both functional
  requirements (§4.1) without a data-model change, and moving it would
  touch every one of its existing call sites for no behavioral gain.

## What's still open, carried forward unchanged

Exact reconnect-window duration, Side Pot Attributes, and Buy-Chips
amounts/limits (spec §7) — none touched by this build, none needed to
be.

---

**MINOR — regression fix.** v9.6's `sittingOut`/$0-chips correction
introduced a real bug in `_activePlayers()`, caught by Mike's review of
the delivered v9.6 build before it reached play-testing. `npm test` —
**339 tests** (up from 334 in v9.6 — 5 new, covering the confirmed
regression and the two suspected-but-unreproduced cases the bug report
flagged, all three now verified fixed).

## What happened

9.6's fix added a `chips > 0` exclusion directly to `_activePlayers()`
to correct the $0-chips-Dealer handling. That function is **shared** by
six different callers, and most of them were never meant to exclude an
all-in player — `chips === 0` mid-hand is completely normal for anyone
who's gone all-in, not a sign they've stopped being part of the hand. I
looked at the six call sites during the 9.6 build and reasoned they'd
"all benefit from the same fix." That reasoning was wrong, and it's
exactly the "two concepts sharing one name" pattern this project has
hit several times before — this time in function form rather than a
data field, as Mike's own bug report put it.

**Confirmed broken**: the single most common short-stack scenario in
the app — a player shoves all-in, everyone else folds, leaving them as
the sole remaining player — was being incorrectly rejected at the
automatic early-claim step. Reproduced exactly as described in the
report before touching anything, then confirmed fixed after.

**The two suspected-but-unreproduced cases were real too**, and I
verified both directly this time:

- Draw's `DiscardPhase` → `DrawPhase` advance now correctly still waits
  on an all-in player's Discard/Stand Pat input before moving on,
  instead of silently advancing without it.
- Stud's `Declare` → `Showdown` advance (Hi/Lo presets) now correctly
  still waits on an all-in player's declaration the same way.

## The fix

Reverted `_activePlayers()` to its original, pre-9.6 meaning
(`!folded && !sittingOut`, no chip-count check) — exactly what every
non-dealing caller was built and tested against. Added a new, narrowly
named `_dealableActivePlayers()` (`!folded && !sittingOut && chips > 0`)
for the two places that genuinely need it: `_maybeAdvanceFromRequestAntes()`
(deciding whether a hand can actually begin dealing) and — already
correctly scoped independently, confirmed unaffected by this whole bug
— `deal()`, `_computeBlindSeats()`, `_autoApplyAnte()`, and
`openBetting()`'s active-count check, each of which already carried its
own inline `chips > 0` filter rather than routing through
`_activePlayers()` at all.

**One more correction beyond the report's own recommendation**: while
implementing the fix, I found `_maybeAdvanceFromRequestAntes()` needed
the *dealable* variant too, not the plain one — its purpose is
specifically "can dealing proceed," not "who's still part of an
existing hand." Using the plain (reverted) `_activePlayers()` there
would have technically been safe in practice (a `$0`-chip player never
has `oweAnte` set, so they'd never block the `.every()` check either
way) — but it would have let a table where *every* seated player
happens to be `$0`-chip incorrectly advance out of `RequestAntes` into
a hand nobody could actually be dealt into. New regression test locks
this in.

## What's confirmed unaffected

The multi-pot claim path (when a genuine side pot exists) was never
part of this bug — it already used `currentPot.eligiblePlayerIds`
directly, a dedicated, `folded`-only exclusion untouched by chip count,
matching the 9.0/9.1 rule that all-in status must never affect pot
eligibility. Only the single-pot fallback path (`_activePlayers()`
directly) was broken. New test confirms the multi-pot path stays
correctly out of scope.

## Live end-to-end WebSocket verification

Ran the exact confirmed-bug scenario over real sockets — short stack
shoves all-in, both opponents fold, the short stack claims the pot —
confirmed the claim succeeds without a server rejection, live, not just
in the in-process test suite.

## What to check in play-testing

The three fixed scenarios above, on a real table — especially the
sole-all-in-player early-claim case, since it's likely the single most
common hand shape this bug affected.

## Not touched this release

Everything else from 9.6 (the `sittingOut` correction's other pieces,
`provenLosers`, draggable dialogs, the Stud dropdown fix, the Dealer
marker cosmetic) is unchanged and confirmed still correct by the full
regression suite. Kill Hand's interaction with a partially-formed side
pot remains the one open item carried from 9.4, still unconfirmed by
Mike.
