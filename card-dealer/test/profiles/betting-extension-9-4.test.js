'use strict';

const { assert, test } = require('../helpers');
const { GameTable } = require('../../src/gameTable');

// ---------------------------------------------------------------
// v9.4: extends 9.0-9.3's Hold'em-only betting-structure/side-pot/
// All-In enforcement to Stud and Draw, plus two real bug fixes (the
// All-In capping bug, and the $0-chip Dealer gap).
// ---------------------------------------------------------------

function drawRoomReadyToBet(options, ...buyIns) {
  const room = new GameTable('T1');
  buyIns.forEach((amount, i) => {
    room.addPlayer(`p${i + 1}`, `Player${i + 1}`);
    room.buyChips(`p${i + 1}`, amount);
  });
  room.setGameChoice('p1', 'draw-5card');
  for (const [key, value] of Object.entries(options || {})) room.setGameOption('p1', key, value);
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(5, 'p1');
  room.openBetting('p1');
  return room;
}

function studRoomReadyToBet(gameChoiceId, options, ...buyIns) {
  const room = new GameTable('T1');
  buyIns.forEach((amount, i) => {
    room.addPlayer(`p${i + 1}`, `Player${i + 1}`);
    room.buyChips(`p${i + 1}`, amount);
  });
  room.setGameChoice('p1', gameChoiceId);
  for (const [key, value] of Object.entries(options || {})) room.setGameOption('p1', key, value);
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(gameChoiceId.startsWith('stud-7') ? 3 : 2, 'p1');
  return room;
}

// ---------------------------------------------------------------
// Draw: Minimum Bet = $0, general betting-structure enforcement
// ---------------------------------------------------------------

test('Draw: Minimum Bet is $0 -- any positive amount is a legal opening bet, no floor', () => {
  const room = drawRoomReadyToBet({}, 1000, 1000, 1000);
  const actor = room.currentTurnPlayerId;
  assert.strictEqual(room.placeBet(actor, 1).ok, true); // the smallest possible legal opening bet
});

test('Draw: Fixed-Limit uses smallBet pre-draw, bigBet post-draw', () => {
  const room = drawRoomReadyToBet({ bettingStructure: 'fixed-limit', smallBet: 2, bigBet: 4 }, 1000, 1000);
  assert.strictEqual(room._fixedLimitSize(), 2); // FirstBetting
  const actor = room.currentTurnPlayerId;
  assert.strictEqual(room.placeBet(actor, 3).ok, false); // not exactly the Small Bet
  assert.strictEqual(room.placeBet(actor, 2).ok, true);
});

test('Draw: an all-in player still participates in the Discard phase and receives their draw normally', () => {
  const room = drawRoomReadyToBet({}, 1000, 1000, 30);
  room.check(room.currentTurnPlayerId); // p1
  const shortStack = room.currentTurnPlayerId; // p2
  room.allIn(shortStack);
  room.call(room.currentTurnPlayerId); // p3 (Dealer, since p1 already acted... whoever's next)
  room.call(room.currentTurnPlayerId);
  assert.strictEqual(room.handPhase, 'DiscardPhase');
  const player = room.getPlayer(shortStack);
  assert.strictEqual(player.allIn, true);
  const result = room.discard(shortStack, [player.hand[0].id]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(player.discardPhaseActed, true);
});

// ---------------------------------------------------------------
// Stud: Fixed-Limit street mapping, Bring-In all-in-for-less
// ---------------------------------------------------------------

test('Stud: 7-Card Fixed-Limit -- Small Bet on 3rd/4th Street, Big Bet on 5th/6th/7th', () => {
  const room = studRoomReadyToBet('stud-7card', { bettingStructure: 'fixed-limit', smallBet: 2, bigBet: 4 }, 1000, 1000);
  for (const [phase, expected] of [
    ['StreetABetting', 2],
    ['StreetBBetting', 2],
    ['StreetCBetting', 4],
    ['StreetDBetting', 4],
    ['StreetEBetting', 4],
  ]) {
    room.handPhase = phase;
    assert.strictEqual(room._fixedLimitSize(), expected, `${phase} should be $${expected}`);
  }
});

test('Stud: 5-Card Fixed-Limit -- Small Bet on 2nd/3rd Street, Big Bet on 4th/5th', () => {
  const room = studRoomReadyToBet('stud-5card', { bettingStructure: 'fixed-limit', smallBet: 2, bigBet: 4 }, 1000, 1000);
  for (const [phase, expected] of [
    ['StreetABetting', 2],
    ['StreetBBetting', 2],
    ['StreetCBetting', 4],
    ['StreetDBetting', 4],
  ]) {
    room.handPhase = phase;
    assert.strictEqual(room._fixedLimitSize(), expected, `${phase} should be $${expected}`);
  }
});

test('Stud: a short stack can meet the Bring-In as an all-in for less, and cannot fold it', () => {
  const room = studRoomReadyToBet('stud-7card', { bringIn: 10 }, 1000, 5, 1000);
  room.setOpeningBettor('p1', 'p2'); // p2 has only $5, less than the $10 Bring-In
  room.openBetting('p1');
  assert.strictEqual(room.currentBetToCall, 10);
  assert.strictEqual(room._bringInObligationId, 'p2');
  const foldAttempt = room.fold('p2');
  assert.strictEqual(foldAttempt.ok, false);
  assert.match(foldAttempt.error, /can't be folded/);
  const callAttempt = room.call('p2');
  assert.strictEqual(callAttempt.ok, false); // can't cover the full $10 -- must use All-In
  const allInResult = room.allIn('p2');
  assert.strictEqual(allInResult.ok, true);
  assert.strictEqual(room.getPlayer('p2').chips, 0);
  assert.strictEqual(room.getPlayer('p2').totalContributedThisHand, 5);
  assert.strictEqual(room._bringInObligationId, null); // resolved
});

test('Stud: the Dealer cannot select an all-in or bettingCapped player as the opening bettor -- they have no chips to act with', () => {
  const room = studRoomReadyToBet('stud-7card', {}, 1000, 30, 1000);
  room.setOpeningBettor('p1', 'p2');
  room.openBetting('p1');
  room.allIn('p2'); // p2 goes all-in on 3rd Street
  room.call('p3');
  room.call('p1');
  assert.strictEqual(room.handPhase, 'StreetB');
  room.deal(1, 'p1'); // deal 4th Street to advance into StreetBBetting
  assert.strictEqual(room.handPhase, 'StreetBBetting');
  const result = room.setOpeningBettor('p1', 'p2'); // p2 is now allIn -- cannot be re-selected
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /able to act/); // CHANGED 10.1: unified error message via _canAct()
});

// ---------------------------------------------------------------
// Side pots and the uncalled-bet refund now apply to Stud and Draw
// ---------------------------------------------------------------

test('Draw: side pots compute correctly, same formula as Hold\'em, once a genuine all-in occurs', () => {
  const room = drawRoomReadyToBet({ anteAmount: 0 }, 1000, 30, 1000); // p2 acts first for 3 players -- make them the short stack
  const short = room.currentTurnPlayerId;
  assert.strictEqual(short, 'p2');
  room.allIn(short); // $30 all-in
  room.placeBet(room.currentTurnPlayerId, 100); // p3 raises beyond the all-in amount -- a genuine tier split
  room.call(room.currentTurnPlayerId); // p1 calls the $100 -- round closes
  assert.notStrictEqual(room.pots, null);
  const main = room.pots.find((t) => t.id === 0);
  assert.strictEqual(main.amount, 90); // 30 x 3
  assert.deepStrictEqual(main.eligiblePlayerIds.sort(), ['p1', 'p2', 'p3']);
  const side1 = room.pots.find((t) => t.id === 1);
  assert.strictEqual(side1.amount, 140); // (100-30) x 2
  assert.deepStrictEqual(side1.eligiblePlayerIds.sort(), ['p1', 'p3']);
});

test('Stud: the uncalled-bet refund fires on fold, same as Hold\'em', () => {
  const room = studRoomReadyToBet('stud-7card', { anteAmount: 0, bringIn: 0 }, 500, 175, 400);
  room.setOpeningBettor('p1', 'p1');
  room.openBetting('p1');
  room.placeBet('p1', 400); // opens for $400 (well within $400 = p3's stack, the ceiling at this moment)
  room.allIn('p2'); // $175 all-in
  const foldResult = room.fold('p3'); // folds -- refund should fire, p1 has no other coverer left
  assert.strictEqual(foldResult.ok, true);
  const p1 = room.getPlayer('p1');
  assert.strictEqual(p1.totalContributedThisHand, 175); // refunded down to match p2's all-in
  assert.strictEqual(p1.bettingCapped, true);
});

// ---------------------------------------------------------------
// BUG FIX 9.4: All-In capped at the legal maximum, not the raw stack
// ---------------------------------------------------------------

test('BUG FIX 9.4: a deep-stacked All-In under Fixed-Limit is capped at the legal maximum, not the full stack -- and Player.allIn is NOT set when capped short', () => {
  const room = drawRoomReadyToBet({ bettingStructure: 'fixed-limit', smallBet: 2, bigBet: 4, anteAmount: 0 }, 1000, 100000);
  const actor = room.currentTurnPlayerId; // p2, the deep stack, acts first in a 2-player Draw game
  assert.strictEqual(actor, 'p2');
  const result = room.allIn(actor);
  assert.strictEqual(result.ok, true);
  const player = room.getPlayer(actor);
  assert.strictEqual(player.currentBet, 2); // capped at the Small Bet, not the huge stack
  assert.strictEqual(player.chips, 99998); // most of the stack stays put
  assert.strictEqual(player.allIn, false); // capped short -- not a genuine full-stack commitment
});

test('BUG FIX 9.4: a genuinely short stack under Fixed-Limit still goes fully all-in for less, Player.allIn set true', () => {
  const room = drawRoomReadyToBet({ bettingStructure: 'fixed-limit', smallBet: 2, bigBet: 4, anteAmount: 0 }, 1000, 1);
  const actor = room.currentTurnPlayerId; // p2, the short stack, acts first
  assert.strictEqual(actor, 'p2');
  const result = room.allIn(actor);
  assert.strictEqual(result.ok, true);
  const player = room.getPlayer(actor);
  assert.strictEqual(player.chips, 0);
  assert.strictEqual(player.allIn, true); // genuinely committed everything they had
});

test('BUG FIX 9.4: a deep-stacked All-In under Pot-Limit is capped at the pot-after-call maximum, not the full stack', () => {
  const room = new GameTable('T1');
  ['p1', 'p2', 'p3'].forEach((id, i) => {
    room.addPlayer(id, `Player${i + 1}`);
  });
  room.buyChips('p1', 100000);
  room.buyChips('p2', 1000);
  room.buyChips('p3', 1000);
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'smallBlind', 1);
  room.setGameOption('p1', 'bigBlind', 2);
  room.setGameOption('p1', 'bettingStructure', 'pot-limit');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1');
  room.openBetting('p1');
  // UTG (p1, the huge stack) faces the pot-limit worked example: pot $3, call $2, max raise to $7.
  const result = room.allIn('p1');
  assert.strictEqual(result.ok, true);
  const p1 = room.getPlayer('p1');
  assert.strictEqual(p1.currentBet, 7); // capped at Pot-Limit's own legal max, not the $100000 stack
  assert.strictEqual(p1.allIn, false);
});

// ---------------------------------------------------------------
// BUG FIX 9.4: $0-chip Dealer -- covered in gameTable-core.test.js
// (auto Pass the Buck, then normal sit-out); referenced here for
// discoverability alongside the rest of this release's coverage.
// ---------------------------------------------------------------
