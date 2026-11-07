# The Cut — v13.2 Build Notes (Dev chat)

## Buildfix round (`the-cut-v13-2-buildfix.md`) — applied

- **The three diffs were applied as given**, with `git apply`, no edits (`src/gameTable.js`, `public/client.js`, `test/gameTable-13-2.test.js`). All three applied cleanly.
- **1. Hidden cards follow the cards:**
  - The new `cardsHiddenFromOwner` is set in `_performFullReset()` and exposed in the state.
  - `_redactedHand()`, `revealHand()` and the client's Show Cards button use it instead of the selected game.
  - No Peek's game-flow checks still follow the selected game.
- **2. Mike's rule change:**
  - No Reveal Rail for a player with no face-down cards (`_canTakeRevealRail()`).
  - Showdown when nobody but the high-hand holder could reveal (`_anyoneLeftToReveal()`).
  - Open Betting is always available.
  - A rejected revealer with no face-down cards is folded.
- **One small extra, as the note suggested:** the client's Open Betting tooltip no longer has the "Reveal at least one card this turn first" branch, which can't appear anymore.
- **Tests:** 512 passing. Against the first delivery, the 5 new or changed tests fail (checked); with the fix they pass. Stress-run 20 times in a row, all clean. `live_test_11_4.js` passes. Both version files stay `13.2.0`.

---

Built from `the-cut-spec_v13-2.md` against `build-v13_1.zip`. Both `package.json` and `package-lock.json` (top-level and `packages[""]`) are `13.2.0`.

## Verification

- **Tests:** 508 passing: the 489 from 13.1 plus 19 new in `test/gameTable-13-2.test.js`. Stress-run 20 times in a row, all clean. `live_test_11_4.js` passes.
- **Proving the new tests can fail:** 24 rules were broken one at a time on a scratch copy, and all 24 were caught. Two needed attention first:
  - **The high-hand skip (B.5):** in normal play the seat right after the last revealer is never the high-hand holder. Everyone between the holder and the revealer has folded, or the revealer *is* the holder. So the skip never changes the result through play alone. Test `13.2 C.11b` sets that state up directly to pin the rule.
  - **An absent revealer:** the grace-expiry path and the `_reconcilePlayerInputPhases()` path back each other up, because a grace expiry also sits the player out. Removing either one alone changes nothing; removing both fails `C.15`. Both are kept, as the spec asks.
- **Existing tests updated (catalog size and version only):**
  - The catalog count goes 19 → 20.
  - The "original 16" check now filters by the draw/stud/holdem profiles, since No Peek sits in 7-Card Stud Variants.
  - 13.0 E.14 excludes the new entry.
  - The version-agreement test now expects 13.2.0.
- **Catalog:** the diff is 20 added lines (the No Peek entry, last in 7-Card Stud Variants). No existing record changed.
- **Not checked in a live browser** (no browser run, at Mike's request). Every client-side change in 13.2 needs a look:
  - "Is Deciding" and "Draw Card"
  - the "Open 2nd" / "Drawing Round" break
  - the Skipped badge
  - the whole No Peek screen: card backs in your own hand, no Show Cards, the Reveal Rail, "Is Revealing", Deal 7 Cards, Select Opening Bettor, Reject, banners and the Options layout

  The 13.1 client changes are still unseen too.

## What was built

**Part A**
- **A.1:** "[Name] Is Deciding".
- **A.2:** "Draw Card", plus the tooltip.
- **A.3:** the label breaks after the ordinal, using `white-space: pre-line` on `#btn-open-drawing`. `textContent` only, no innerHTML.
- **A.4:** `consecutivePasses` is exposed per player. The seat badge reads "Skipped N of M", or "Skipped N" with Never Freeze, then "Frozen". It's hidden at 0, and shown in a quieter style until it becomes Frozen. 7-27 / 15-35 only.
- **A.5:** Pick-a-Card with a $0 pot and At Showdown waits at Showdown until every participant has shown. The check re-runs from `revealHand()` and `_reconcilePlayerInputPhases()`. When Drawn, a pot above $0, and 7-27 / 15-35 are unchanged.
- **A.6:** "…Go All In anyway?".

**Part B — 7-Card No Peek** (new `nopeek` profile, registered in the server and in `railTables.js`)
- **Catalog:**
  - The entry is as in B.1, with Mike's description word for word.
  - The Rules text is a Dev draft, starting with "DRAFT (Dev) -- Mike to replace."
  - Flip Cards Until accepts only its two values, and is information only.
- **Seven players at most:** `startGame()` and `deal()` both reject more than 7, with the B.2 message.
- **Hidden from the owner:**
  - `_redactedHand()` sends `{ faceUp: false }` for every face-down card to every viewer, the owner included, unless the hand is revealed by Show All.
  - `revealHand()` is rejected with the B.3 message. The seat Show Cards button is hidden, and card selection is off.
- **Reveal Rail:** Reveal Next (the leftmost face-down card), Open Betting (needs a Reveal Next this turn unless no face-down cards are left) and Fold (any time).
  - The 1st Reveal's first card ends that turn automatically.
  - Revealers go clockwise from the last revealer, skipping the high-hand holder.
- **RevealBetting:**
  - The opener is pre-selected: the revealer, or after a fold the nearest participant counterclockwise.
  - Select Opening Bettor (`setOpeningBettor()`, now allowed for nopeek) works only in RevealBetting with betting closed.
  - Open Betting Round opens with $0 to call, and makes the revealer the high-hand holder.
  - Reject is shown only after an Open Betting. It returns the rail to the same revealer and keeps this turn's Reveal Next count.
- **Endings:** one participant left, or nobody with a face-down card left, goes to Showdown ("Last Man Standing – Claim Pot"). A split claim works for a tie.
- **Leaving mid-reveal** (sit-out, leave, grace expiry) is treated as Fold.
- **Shared with 7-27:** Fixed-Limit single bet, Raise Cap with No Cap rejected, Folded Hands, Show All (keeps the green dot), remembered options, and Restore Defaults.
- **Profile audit:**
  - Every `profile ===` site in `gameTable.js` and `client.js` carries a `CHANGED 13.2` or `AUDIT 13.2` decision.
  - Discard, Deal to Player, Deal to All and Deal Community reject nopeek.
  - `isPhaseGatedProfile()` covers it through its `RAIL_TABLES` entry.
- **State** (Standing Convention):
  - `revealTurnPlayerId`, `revealRoundNumber`, `highHandPlayerId`, `revealEndedBy`, `preselectedOpeningBettorId`
  - `rejectAvailable`, `revealNextAvailable`, `openBettingAvailable`
  - per player, `faceDownCount` (a count only)

## Decisions beyond the spec (please confirm or redirect)

1. **The 1st Reveal's revealer becomes the high-hand holder** when the Dealer opens betting, the same as after an Open Betting. The spec names only Open Betting; a single showing card is the high hand by definition.
2. **The pre-selected opener must be able to act.** If the revealer, or the counterclockwise player after a fold, is All In, the pre-selection moves clockwise to the nearest player who can act. If nobody can act, betting is skipped for that reveal, the same path Stud already uses.
3. **A reveal-Fold that leaves nobody with a face-down card goes straight to Showdown,** with no betting round. The spec checks endings "after any fold".
4. **Select Opening Bettor hint:** "High Hand Opens Betting". The spec gave no hint text.
5. **The Reject button** sits on the Dealer's Rail next to Open Betting Round.
6. **The Skipped badge** appears only in 7-27 / 15-35, in a quieter style than Frozen.

## For Mike

- **Rules text** for 7-Card No Peek is a marked Dev draft. The 7-27 / 15-35 drafts are still out of date (two-pass freeze, the Naturals mention). Please replace all three.
- ~~The spec's Open Betting rule (needs a Reveal Next this turn).~~ *Replaced in the buildfix by Mike's ruling: Open Betting is always available.*

## Carried, unchanged

Guts (13.3); deck exhaustion in general; automatic round opening; the stale gold seat-turn highlight; the 13.0/13.1/13.2 screens not yet seen live; inactivity timeout vs auto-reconnect; the 11.4 revert toggle; the 12.1 28px nudge; the 12.4 client-only clamp on Max Discards / Small Bet / Big Bet; shuffle randomness (`Math.random()`).
