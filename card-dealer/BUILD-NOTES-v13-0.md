# The Cut — v13.0 Build Notes (Dev chat)

## Buildfix round (`the-cut-v13-0-buildfix.md`) — applied

- **1. Frozen reset test:** added `13.0 E.7b` word for word. Removing either `player.frozen = false;` or `player.consecutivePasses = 0;` from `_performFullReset()` now makes it fail. Both were checked.
- **2. Selection clearing narrowed:** only the `vying` profile (7-27 / 15-35) clears a card selection on a phase change. Draw's Discard selection is back to its 12.6 behavior. The drop-in from the buildfix note was used verbatim.
- **Tests:** 476 passing. Stress-run 20 times in a row, all clean. `package.json` stays `13.0.0`.

---

Built from `the-cut-spec_v13-0.md` against `build-v12_6.zip`. `package.json` → `13.0.0`.

## Verification

- **Tests (first delivery):** 475 passing (449 existing + 26 new in `test/gameTable-13-0.test.js`). Stress-run 25 times in a row, all clean.
- **Proving the new tests can fail:** 17 rules were broken one at a time on a scratch copy (frozen, no-draw → Declare, muck, Show All window, pick position, reveal privacy, zero-card reveal, grace expiry = Pass, all-in sit-out on the Drawing Rail, fixed bet, one player → no Declare, ante validation, $0 pot, empty deck, Select grouping, Home group, missing `menuGroup`). The tests caught all 17. The sit-out case was initially missed, and a test was added for it.
- **Live browser check (three real Chrome sessions on a local server):** one full 7-27 hand was played and checked from screenshots:
  - Select showed five groups, with Home Game Favorites last and listing 7-27, 15-35, Pick-a-Card.
  - Options auto-opened for everyone: editable for the Dealer, read-only for the others. The new options sit in the spec'd columns.
  - Deal button read "Deal 2 Cards".
  - During the Initial Reveal, other players saw only "Revealed ✓" and no cards until the last player was done. Then all chosen cards flipped together.
  - Banners read "1st Draw", "1st Draw Betting" and "2nd Draw".
  - The Drawing Rail showed only to the player whose turn it was.
  - A second consecutive pass put a Frozen marker on the seat. An all-pass round went straight to Declaration.
  - After the claim, Show All appeared for the Dealer only, turned every card face up, then disappeared.
- **Not verified live:** the Pick-a-Card screens (the browser run stopped before that part; the server logic is fully tested), Folded Hands = Mucked on screen, disconnect handling on screen, and mobile/narrow layouts.

## What was built, by spec part

- **A:** `menuGroup` added to all 16 existing entries. Nothing else in those records changed: a diff shows only the added line. The three new entries are in order 7-27, 15-35, Pick-a-Card. `selectGroupKeyFor()` returns `menuGroup` only. A missing or unknown value logs a console warning and the entry stays out of Select. The `stud-7card-` naming contract is retired.
- **B.1:**
  - New `src/profiles/pickcard.js` and `vying.js`, both registered, with matching `railTables.js` entries.
  - Every `profile ===` branch listed in the spec has an explicit decision, marked `AUDIT 13.0` or `NEW 13.0`. The three-way client lists became one helper, `isPhaseGatedProfile()`.
  - The primitives that had been open to any non-Draw/Hold'em profile (Discard, Deal to Player, Deal to All, Deal Community) now reject `pickcard` and `vying`.
  - Leaving mid-phase goes through one `_reconcilePlayerInputPhases()`. It is called from fold bookkeeping, sit-out, grace expiry and deferred departure.
  - Grace expiry while holding the Drawing Rail counts as a Pass.
  - All new gates are exposed in `toRedactedState()`: `drawTurnPlayerId`, `drawRoundOpen`, `drawRoundNumber`, `drawCardAvailable`, `initialDealCount`, `pickTurnPlayerId`, `pickRange`, `showAllAvailable`, `fixedLimitSize`, and per player `frozen`, `revealDone`, `eligibleToDraw`. The reveal selection itself is never sent.
- **B.2:** `_fixedLimitSize()` returns `fixedBet` for vying. Server validation:
  - `fixedBet` and `raiseCap` must be whole numbers ≥ 1. "No Cap" is rejected for vying.
  - The new dropdown options accept only their listed values.
  - **`anteAmount` must be a whole number ≥ 0 in every game** (Mike's call: global).
- **B.3:** Folded Hands muck/leave, plus a Dealer-only Show All (`showAll()`). Rabbit Hunt is unchanged.
- **C:** Pick-a-Card has no deal, no betting and no fold. Its rail is a number field with a server-given range. A $0 ante skips antes, and a $0 pot goes straight to CycleComplete.
- **D:** the full 7-27 / 15-35 phase graph, the Initial Reveal, the Drawing Rail, frozen tracking, the empty-deck tooltip, and Declare reused for vying.

## Decisions beyond the spec (please confirm or redirect)

1. **"Under Trumps Over"** replaces "Under Trumps Lower", per Mike.
2. **$0 pot in 7-27 / 15-35:** the spec gives Pick-a-Card this rule. I applied the same no-hang rule to vying: reaching Showdown with a $0 pot goes straight to CycleComplete, since nothing can be claimed. Show All is still offered then.
3. **One participant left:** any vying transition with ≤ 1 participant goes to Showdown. That means skipping DrawRound too, not just Declare.
4. **Muck applies to every way of folding:** a normal fold, folding at Showdown or Declaration, Fold and Sit Out, and the automatic fold on disconnect.
5. **Pick-a-Card:** Fold is rejected everywhere, including Showdown. Start needs at least 2 players with chips, because there's no Deal step to enforce that.
6. **Server sets the opening-deal count** (2 or 3 from Initial Deal). Whatever count the client sends is ignored.
7. **Showdown banner** uses the existing decorated "♣♥ SHOWDOWN ♦♠", matching every other game.
8. **Card selection clears on any phase change.** *Narrowed in the buildfix: now 7-27 / 15-35 only.*
9. **Seat turn highlight** follows the Drawing Rail or Pick-a-Card rail while one is live.
10. **Game Rules dialog:** the tag under each new game reads "Home Game Favorites" instead of the internal profile name.
11. **Three existing tests changed (catalog size only):** two counted exactly 16 games, and one expected only Stud games to set `declareHighLowBoth`. Each now checks the original 16, or Stud only, plus the new total of 19.

## For Mike

- **Rules text for the three new games is a Dev draft.** Mike supplied `displayName` and `description`, used word for word, but no Rules text. The draft was written from the spec's point values and naturals lists, for Mike to replace.
- 13.1 and 13.2 text has been received and held for those releases: "7-Card No Peek" and "Guts", with their descriptions. Note that Mike's name is **"7-Card No Peek"**, while the spec and versioning say "No Peeky".

## Observed, not changed

- A seat can keep its gold turn highlight outside a betting round. During the Initial Reveal, the Dealer's seat was highlighted. At CycleComplete, the last betting actor's seat was. The cause is `currentTurnPlayerId` carrying over. It looks pre-existing and not specific to 13.0, but this wasn't confirmed against 12.6 in a browser.
- In the browser console, Google Fonts failed to load in the sandbox (no outside network) and there was one 404 (no favicon exists). Neither is related to 13.0.

## For the Spec chat

- The 12.6 versioning file listed 12.4 and 12.6 as "draft, not yet built or tested". `the-cut-versioning_v13-0.md` already corrects this, so it's resolved.
- The carried items are unchanged: inactivity timeout vs auto-reconnect, the 11.4 revert toggle, the 12.1 28px nudge, the 12.4 client-only clamp on Max Discards / Small Bet / Big Bet (Ante is now checked on the server), deck exhaustion in general, and automatic round opening.
