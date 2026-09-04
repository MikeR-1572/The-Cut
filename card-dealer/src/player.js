'use strict';

/**
 * NEW 8.0 (ARCHITECTURE_v8.md §4): Player and Bank state factored out of
 * GameTable into their own bounded module. Two independent reasons this
 * needed to happen now, not just refactor-for-its-own-sake:
 *
 *   1. Cross-app portability -- Mike is open to a future House-vs-Players
 *      app (Blackjack, Baccarat, Caribbean Stud) living in a separate
 *      process entirely, as long as player identity and bank status
 *      carry over automatically. That requires a real interface boundary
 *      between Player/Bank state and GameTable/game-engine internals
 *      NOW, regardless of whether the two families ever actually end up
 *      in one process or two.
 *   2. Hand/cycle undo (design note only, not built -- master spec §14
 *      item 16) needs historical chip-total SNAPSHOTS, not just current
 *      state, on a per-player basis. That's a concrete shape requirement
 *      for this module itself, not just an external interface concern --
 *      hence snapshot()/restore() existing here even though nothing
 *      calls restore() yet.
 *
 * Scope, deliberately narrow for v8.0: player creation, chip bookkeeping,
 * and snapshotting only. Hand-specific state (hand, folded, currentBet,
 * discardCountThisHand, standingPat, etc.) still lives on the same
 * per-seat object -- there's still exactly one object per seated player,
 * this module hasn't split the player into two separate records -- but
 * conceptually that state belongs to GameTable's hand-flow logic, not
 * here. This module owns the *identity and bank* fields specifically,
 * and is the only place that touches `chips`/`totalBuyIn`.
 *
 * Not scoped for v8.0: actual persistence (in-memory is sufficient, same
 * as the app's existing memory-only architecture), the House-vs-Players
 * game family itself, or any Table Owner UI. Only the boundary needs to
 * exist.
 */

/**
 * Creates a new player object. The full shape here matches what a
 * single seat has always carried -- this module doesn't (yet) split
 * "bank identity" from "hand state" into two separate objects, since
 * nothing in v8.0's scope requires that split; it only requires that
 * the *operations* on the bank-specific fields (chips, totalBuyIn) be
 * centralized here rather than scattered wherever GameTable happened to
 * touch them.
 */
function createPlayer(id, name, isFirst) {
  return {
    id,
    name,
    hand: [],
    isDealer: isFirst,
    chips: 0,
    totalBuyIn: 0,
    currentBet: 0,
    folded: false,
    revealed: false,
    sittingOut: false,
    sitOutPending: false, // internal: "Sit Out Next Game" queued, not yet applied
    sitInPending: false, // Sit In clicked while idle===false; auto-resolves when idle becomes true
    oweAnte: 0,
    discardCountThisHand: 0, // resets on Deal/Reshuffle, checked against gameOptions.maxDiscards and the once-per-hand rule
    mucked: 0, // separate from discardCountThisHand: the seat's visible face-down discard pile, cleared on redraw
    discardPhaseActed: false, // true once they've submitted Discard OR Stand Pat this hand; DiscardPhase waits on this for everyone active
    standingPat: false, // true if they chose Stand Pat (drives the "Stand Pat" seat text)
    declaration: null, // NEW 8.1 (§5.11) -- "high" | "low" | "both" | null, declareHighLowBoth presets only. Pure stored label, never evaluated server-side. Resets to null at every RequestAntes entry, same as discardPhaseActed/standingPat.
    allIn: false, // NEW 9.0 (§6.11), CLARIFIED 9.1 -- true once this player has used the All-In action this hand. Drives the "All-In" seat badge -- a DISPLAY-only concept as of 9.1. Clears back to false the instant a refund (§6.10) restores any stack to this player. Does NOT govern turn-order eligibility on its own as of 9.1 -- see bettingCapped below. Resets to false at every RequestAntes entry.
    bettingCapped: false, // NEW 9.1 (§6.10) -- true the instant this player is ever the recipient of an uncalled-bet refund, for ANY reason, whether or not they were ever marked allIn. Once true, stays true for the REST OF THE HAND. Excludes the player from all future turn-order, independent of allIn's own value -- the functional concept; allIn is purely cosmetic as of 9.1. Resets to false at every RequestAntes entry.
    totalContributedThisHand: 0, // NEW 9.0 (§6.10) -- running total of everything this player has put into the pot this hand (antes/blinds/bets/calls/raises/all-ins). Resets to 0 at every RequestAntes entry.
  };
}

/** The only place `chips`/`totalBuyIn` are mutated on a buy-in. */
function buyChips(player, amount) {
  player.chips += amount;
  player.totalBuyIn += amount;
}

/**
 * NEW 8.0: a plain-object snapshot of every player's BANK state only
 * (chips, totalBuyIn) -- not hand state, not identity fields that never
 * change. Deliberately minimal: only what a future hand/cycle undo
 * (master spec §14 item 16) would actually need to restore. Keyed by
 * player id, not array index, so restore() doesn't depend on seating
 * order or membership staying identical between snapshot and restore.
 */
function snapshot(players) {
  const snap = {};
  for (const player of players) {
    snap[player.id] = { chips: player.chips, totalBuyIn: player.totalBuyIn };
  }
  return snap;
}

/**
 * NEW 8.0, not yet called anywhere -- no undo feature exists yet (§14
 * item 16 is explicitly a design note, not built this release). Restores
 * each player's bank fields from a prior snapshot() result, by id. A
 * player present in `players` but missing from `snap` (e.g. joined after
 * the snapshot was taken) is left untouched, not zeroed -- restoring a
 * snapshot should never punish someone who wasn't part of it.
 */
function restore(players, snap) {
  for (const player of players) {
    const saved = snap[player.id];
    if (saved) {
      player.chips = saved.chips;
      player.totalBuyIn = saved.totalBuyIn;
    }
  }
}

module.exports = { createPlayer, buyChips, snapshot, restore };
