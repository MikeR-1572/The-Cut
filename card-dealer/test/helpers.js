'use strict';

/**
 * NEW 8.0 (ARCHITECTURE_v8.md §10, sequencing item 1): shared test
 * harness (`test`/`assert`) plus every fixture-building helper used
 * across the split test files below -- `tableWithPlayers` and the
 * per-profile `drawRoomAt*`/`holdemRoomAt*`/`studRoomAt*` families.
 * Split out of the single 2675-line `engine.test.js` this refactor
 * retires, so each of `deck.test.js`, `gameTable-core.test.js`,
 * `player.test.js`, `actionDispatch.test.js`, and `profiles/*.test.js`
 * can `require('./helpers')` (or `require('../helpers')` from
 * `profiles/`) instead of duplicating any of this.
 *
 * No dependency on 'ws' anywhere in this file or anything requiring
 * it -- every helper here exercises only the pure engine logic in
 * src/, so the whole split suite still runs with plain `node`, no
 * server process needed. See test/run-all.js for how every split file
 * gets invoked together as one `npm test` run.
 */

const assert = require('assert');
const { buildDeck, shuffle } = require('../src/deck');
const { GameTable, GAME_CHOICES, DEFAULT_PRESET_FLAGS } = require('../src/gameTable');

function test(name, fn) {
  try {
    fn();
    console.log(`ok  - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function tableWithPlayers(...names) {
  const room = new GameTable('ABC123');
  names.forEach((n, i) => room.addPlayer(`p${i + 1}`, n));
  return room;
}

/**
 * NEW 5.0 test helper: buys everyone plenty of chips, selects the given
 * Draw preset, starts the game (-> RequestAntes), pays every owed ante
 * (-> OpeningDeal), and deals (-> FirstBetting). Returns the room ready
 * for a betting round. Use 'draw-5card' (not reAnteable, not
 * requiresOpeners) for tests that just need a working Draw room without
 * exercising the reAnteable/requiresOpeners-specific paths.
 */
function drawRoomAtFirstBetting(gameChoiceId, ...names) {
  const room = tableWithPlayers(...names);
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', gameChoiceId);
  room.startGame('p1');
  for (const p of room.players) {
    if (p.oweAnte > 0) room.postAnteBlind(p.id);
  }
  room.deal(room.gameOptions.cardsPerPlayer, 'p1');
  return room;
}

/** Everyone checks around FirstBetting -> DiscardPhase (assumes nobody needs to open, or the preset doesn't require it). */
function drawRoomAtDiscardPhase(gameChoiceId, ...names) {
  const room = drawRoomAtFirstBetting(gameChoiceId, ...names);
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) {
    room.check(room.currentTurnPlayerId);
  }
  return room;
}

/** Every active player Stands Pat -> DrawPhase -> immediately Draws (All Players) -> SecondBetting. */
function drawRoomAtSecondBetting(gameChoiceId, ...names) {
  const room = drawRoomAtDiscardPhase(gameChoiceId, ...names);
  for (const p of room._activePlayers()) room.standPat(p.id);
  room.dealToAllPlayers('p1');
  return room;
}

/** Everyone checks around SecondBetting -> Showdown. */
function drawRoomAtShowdown(gameChoiceId, ...names) {
  const room = drawRoomAtSecondBetting(gameChoiceId, ...names);
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) {
    room.check(room.currentTurnPlayerId);
  }
  return room;
}

/**
 * NEW 6.0 test helper: buys everyone plenty of chips, selects the given
 * Hold'em preset, starts the game (-> RequestAntes, blinds auto-assigned
 * to the two active seats left of the Dealer via the existing 4.3
 * _autoApplyAnte mechanism, unchanged), pays both blinds (-> PreFlop),
 * deals hole cards (-> PreFlopBetting). Returns the room ready for the
 * pre-flop betting round.
 */
function holdemRoomAtPreFlopBetting(gameChoiceId, ...names) {
  const room = tableWithPlayers(...names);
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', gameChoiceId);
  room.startGame('p1');
  for (const p of room.players) {
    if (p.oweAnte > 0) room.postAnteBlind(p.id);
  }
  room.deal(room.gameOptions.cardsPerPlayer, 'p1');
  return room;
}

/** Calls if something's owed (correctly required pre-flop, per §6.7), checks otherwise -> Flop dealt (3 cards). */
function holdemRoomAtFlop(gameChoiceId, ...names) {
  const room = holdemRoomAtPreFlopBetting(gameChoiceId, ...names);
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) {
    const p = room.getPlayer(room.currentTurnPlayerId);
    if (p.currentBet < room.currentBetToCall) room.call(p.id);
    else room.check(p.id);
  }
  room.dealCommunity('p1');
  return room;
}

/** Everyone checks around FlopBetting -> Turn dealt (1 card). */
function holdemRoomAtTurn(gameChoiceId, ...names) {
  const room = holdemRoomAtFlop(gameChoiceId, ...names);
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) room.check(room.currentTurnPlayerId);
  room.dealCommunity('p1');
  return room;
}

/** Everyone checks around TurnBetting -> River dealt (1 card). */
function holdemRoomAtRiver(gameChoiceId, ...names) {
  const room = holdemRoomAtTurn(gameChoiceId, ...names);
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) room.check(room.currentTurnPlayerId);
  room.dealCommunity('p1');
  return room;
}

/** Everyone checks around RiverBetting -> Showdown. */
function holdemRoomAtShowdown(gameChoiceId, ...names) {
  const room = holdemRoomAtRiver(gameChoiceId, ...names);
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) room.check(room.currentTurnPlayerId);
  return room;
}

/**
 * NEW 7.0 test helper: buys everyone plenty of chips, selects the given
 * Stud preset, starts the game (-> RequestAntes, flat ante -- same
 * mechanism as Draw), pays every owed ante (-> StreetA), deals the
 * initial multi-card street (2 for 5-Card, 3 for 7-Card, from
 * `room.finalStreet`) (-> StreetABetting). Returns the room ready for the
 * first betting round, with no opening bettor selected yet.
 */
function studRoomAtStreetABetting(gameChoiceId, ...names) {
  const room = tableWithPlayers(...names);
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', gameChoiceId);
  room.startGame('p1');
  for (const p of room.players) {
    if (p.oweAnte > 0) room.postAnteBlind(p.id);
  }
  const initialCount = room.finalStreet === 'E' ? 3 : 2;
  room.deal(initialCount, 'p1');
  return room;
}

/**
 * NEW 7.0 test helper: drives every remaining active player's action
 * (call if they owe, check otherwise) until the currently-open betting
 * round closes. Factored out of studCloseBettingRound so tests can fold
 * or otherwise hand-control one or two players mid-round, then let this
 * finish the rest.
 */
function studActUntilRoundCloses(room) {
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) {
    const p = room.getPlayer(room.currentTurnPlayerId);
    if (p.currentBet < room.currentBetToCall) room.call(p.id);
    else room.check(p.id);
  }
}

/**
 * NEW 7.0 test helper: selects `openerId` as the opening bettor and opens
 * betting for the current Street*Betting phase, then has every active
 * player call (if they owe) or check around the table until the round
 * closes -- advancing to the next Street (or Showdown, at `finalStreet`).
 */
function studCloseBettingRound(room, openerId) {
  const setResult = room.setOpeningBettor('p1', openerId);
  if (!setResult.ok) throw new Error(`setOpeningBettor failed: ${setResult.error}`);
  const openResult = room.openBetting('p1');
  if (!openResult.ok) throw new Error(`openBetting failed: ${openResult.error}`);
  studActUntilRoundCloses(room);
}

/** Deals the next street's single card once the room is between betting rounds (a `Street*` non-betting phase). */
function studDealNextStreet(room) {
  const result = room.deal(1, 'p1');
  if (!result.ok) throw new Error(`deal failed: ${result.error}`);
}

/** StreetABetting -> StreetBBetting: closes A (opener acts on the Bring-In), deals StreetB's single card. */
function studRoomAtStreetBBetting(gameChoiceId, ...names) {
  const room = studRoomAtStreetABetting(gameChoiceId, ...names);
  studCloseBettingRound(room, room.turnOrder[0]);
  studDealNextStreet(room);
  return room;
}

/** Walks the room all the way to Showdown, from a fresh table, closing every street's betting round in turn. */
function studRoomAtShowdown(gameChoiceId, ...names) {
  const room = studRoomAtStreetABetting(gameChoiceId, ...names);
  let guard = 0;
  while (room.handPhase !== 'Showdown' && guard++ < 10) {
    studCloseBettingRound(room, room.turnOrder[0]);
    if (room.handPhase !== 'Showdown') studDealNextStreet(room);
  }
  return room;
}

/**
 * NEW 8.1 test helper: removes every card of a given rank from the
 * room's deck (so a later stackDeckTop() call is the only source of
 * that rank, avoiding an accidental early/duplicate trigger), then
 * arranges `cards` (an array of `{ suit, rank }`) so they come out of
 * `deck.pop()` in exactly that order on the next several deals.
 * `deck.pop()` removes from the END of the array (LIFO) -- pushed in
 * reverse so `cards[0]` ends up popped first.
 */
function stackDeckTop(room, cards, ranksToClear = []) {
  for (const rank of ranksToClear) {
    room.deck = room.deck.filter((c) => c.rank !== rank);
  }
  for (let i = cards.length - 1; i >= 0; i--) {
    const { suit, rank } = cards[i];
    room.deck.push({ suit, rank, id: `rigged-${rank}-${suit}-${i}-${Math.random()}`, faceUp: false });
  }
}

module.exports = {
  assert,
  test,
  buildDeck,
  shuffle,
  GameTable,
  GAME_CHOICES,
  DEFAULT_PRESET_FLAGS,
  tableWithPlayers,
  drawRoomAtFirstBetting,
  drawRoomAtDiscardPhase,
  drawRoomAtSecondBetting,
  drawRoomAtShowdown,
  holdemRoomAtPreFlopBetting,
  holdemRoomAtFlop,
  holdemRoomAtTurn,
  holdemRoomAtRiver,
  holdemRoomAtShowdown,
  studRoomAtStreetABetting,
  studActUntilRoundCloses,
  studCloseBettingRound,
  studDealNextStreet,
  studRoomAtStreetBBetting,
  studRoomAtShowdown,
  stackDeckTop,
};
