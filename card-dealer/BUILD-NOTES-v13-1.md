# The Cut — v13.1 Build Notes (Dev chat)

Built from `the-cut-spec_v13-1.md` against the resubmitted `build-v13_0.zip`. Both `package.json` and `package-lock.json` (top-level and `packages[""]`) are now `13.1.0`. A new test fails if they ever disagree.

## Verification

- **Tests:** 489 passing: the 476 from 13.0 plus 13 new in `test/gameTable-13-1.test.js`. Stress-run 20 times in a row, all clean. `live_test_11_4.js` passes.
- **Proving the new tests can fail:** 17 rules were broken one at a time on a scratch copy. The tests caught all 17:
  - Freeze After ignored
  - Never still freezing
  - Freeze After unvalidated
  - seq not bumped
  - saved options not applied
  - options saved on every edit
  - options not saved at start
  - Restore Defaults not Dealer-only
  - Restore Defaults allowed mid-hand
  - Show All turning cards
  - Show All not revealing
  - the Pick-a-Card automatic reveal put back
  - the old All In history text
  - the old Fixed Bet error
  - `naturalsWin` back in the catalog
  - the old Over / Under default
  - `package-lock.json` slipping back

  Two of my first sabotage attempts didn't actually change the behavior. I redid both, and the tests caught them.
- **Existing tests updated, as the spec lists:**
  - 13.0 E.4: At Showdown no longer turns cards up. The test now uses Show Cards and checks that `faceUp` stays false.
  - 13.0 E.7 and E.7b now pin `freezeAfter: 2`, since they prove the two-pass mechanics.
  - 13.0 E.11: Show All now checks that every hand is `revealed` and `faceUp` is unchanged.
  - Four older tests matched the "All-In" spelling in error messages. Only those patterns changed.
- **Not checked in a live browser** (no browser run this round, at Mike's request). Every client-side change in 13.1 needs a look in the next play-test:
  - the new labels
  - whether "Mucked on Fold" and the Freeze After choices fit the 160px dropdown (see below)
  - the "[Name] Is Drawing" / "[Name] Is Picking a Card" line
  - "Open Nth Drawing Round"
  - the History button only during betting
  - Options opening on a re-Select of the same game
  - the plain "Raise To" at the raise cap
  - the Restore Defaults button and its placement

  On the dropdown widths: in 13.0's screenshots, "2 down, 1 reveal" (16 characters) fit the 160px dropdown with room to spare. "Mucked on Fold" is 14 and "3 Skipped Draws" is 15, so they should fit, but this is reasoned, not seen.

## What was built, by spec part

- **0:** both version files are 13.1.0.
- **A.1:** the label "Fixed Bet", and the error "Fixed Bet must be a whole number of at least 1."
- **A.2:** the choice "Mucked on Fold". The stored value `muck` is unchanged.
- **A.3:** the label "Reveal Pick".
- **A.4:** "All In" in exactly the eight listed places.
- **B.1:** `naturalsWin` removed from both catalog entries, the server enum list, and the client labels, choices and layout.
- **B.2:** Over / Under defaults to `nearest`.
- **B.3:** Freeze After.
  - The values 2–5 are stored as numbers and Never as `"never"`. The default is 3, and the option sits after Draw Cards Dealt.
  - The client turns the dropdown's text back into a number before sending, and the server also accepts `"3"` and stores it as 3.
  - With Never, an all-pass round still goes to Declare.
- **C.1:** "[Name] Is Drawing" / "[Name] Is Picking a Card" appears on the shared betting line for everyone except the turn-holder. The name comes from `drawTurnPlayerId` / `pickTurnPlayerId`. The rail stays visible to show it.
- **C.2:** "Open 1st/2nd/… Drawing Round", using the same ordinal helper as the banner. "Open Betting Round" is unchanged.
- **C.3:** the History button shows only while `bettingOpen` is true and the log isn't empty.
- **D.1:** `gameChoiceSeq` goes up on every successful `setGameChoice()` and is exposed in the state. The client's auto-open now keys on it, keeping the first-observation baseline.
- **D.2:** "(use All In)" appears only when `betWouldBeAllIn` is the reason. At the raise cap the button reads plain "Raise To", and the existing tooltip explains why.
- **E.1:** `showAll()` sets `revealed` on every hand that holds cards and doesn't touch `faceUp`, so the green dot stays. Show All is now available when some unrevealed hand still has a face-down card.
- **E.2:** Pick-a-Card at At Showdown has no automatic reveal. Players use Show Cards.
- **F:**
  - `savedOptionsByGame` is saved on every successful `startGame()` (Options → Start and Same Game), for `dealerOptions` keys only. It belongs to the table, so it survives Pass the Buck (tested).
  - `setGameChoice()` starts from the catalog defaults and lays the saved values on top, only for keys still in the catalog's `dealerOptions`. The 12.5 comment is replaced.
  - The new `restoreDefaultOptions()` has the same gates as `setGameOption()`.
  - The Restore Defaults button sits next to Game Rules and shows only in the editable state. After the reset arrives, the client re-runs `pushComputedBets()` once.

## Decisions beyond the spec (please confirm or redirect)

1. **Freeze After conversion:** the spec says to convert the dropdown's value "the same way as the other mixed-type options". No dropdown conversion existed before; every dropdown value was text. A small conversion was added for `freezeAfter` only, and the server also accepts the text form.
2. **Dropdown selection matching:** this now compares values as text, so a stored number 3 matches the "3" choice. It applies to every dropdown, but no existing option's display changes.

## For Mike

- **The Dev-draft Rules text for 7-27 and 15-35 is now out of date.** It says a player who passes twice in a row is frozen, while the new default is 3 and the Dealer can change it. It also points to the Options for Naturals, which no longer exists. Per the spec I didn't touch the Rules text. Please cover both when you replace it.
- **One more "All-In" remains:** the 11.5 re-ante warning's message still reads "…Go All-In anyway?". Its confirm button now says "Go All In". The message wasn't one of the spec's eight places, so it's unchanged. Changing it would be a one-line edit.

## Carried, unchanged

Deck exhaustion in general; automatic round opening; the stale gold seat-turn highlight; the 13.0 items not yet seen live (Pick-a-Card screens, Mucked on screen, disconnects); inactivity timeout vs auto-reconnect; the 11.4 revert toggle; the 12.1 28px nudge; the 12.4 client-only clamp on Max Discards / Small Bet / Big Bet.
