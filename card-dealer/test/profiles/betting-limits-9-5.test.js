'use strict';

const { assert, test } = require('../helpers');
const { GameTable } = require('../../src/gameTable');

// ---------------------------------------------------------------
// v9.5: emergency fix -- the Pot-Limit Maximum formula was
// double-counting a player's own current-street contribution when
// they had already put something in before facing a raise (a blind,
// a Bring-In, an earlier call). The Minimum Raise formula was
// investigated alongside it and confirmed, with Mike, to be correct
// as originally built -- it deliberately does NOT credit the
// player's own contribution, since Minimum Raise is measured from
// the table's shared current bet uniformly for every player, while
// Pot-Limit Maximum credits the specific player's own call amount.
// These are two different formulas answering two different
// questions, not the same bug in two places.
// ---------------------------------------------------------------

test('BUG FIX 9.5: Pot-Limit Maximum credits the acting player\'s own current-street contribution -- was double-counting it', () => {
  const room = new GameTable('T1');
  ['p1', 'p2', 'p3'].forEach((id, i) => {
    room.addPlayer(id, `Player${i + 1}`);
    room.buyChips(id, 1000);
  });
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'smallBlind', 5);
  room.setGameOption('p1', 'bigBlind', 10);
  room.setGameOption('p1', 'bettingStructure', 'pot-limit');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1');
  room.openBetting('p1');
  // p1 (Dealer, $0 in) raises to $30 -- currentBetToCall becomes 30, pot becomes 5+10+30=45.
  room.placeBet(room.currentTurnPlayerId, 30);
  // p2 (SB, already has $5 in) faces this. callAmount = 30-5 = 25. potAfterCall = 45+25 = 70.
  // Correct max = callAmount + potAfterCall = 25+70 = 95. Pre-9.5 buggy formula would have
  // given currentBetToCall + potAfterCall = 30+70 = 100 -- exactly $5 too generous, matching
  // p2's own $5 already-in contribution precisely.
  const tooHigh = room.placeBet('p2', 96);
  assert.strictEqual(tooHigh.ok, false);
  assert.match(tooHigh.error, /Pot-Limit maximum raise is to \$95/);
  const atMax = room.placeBet('p2', 95);
  assert.strictEqual(atMax.ok, true);
});

test('BUG FIX 9.5: Pot-Limit Maximum is unchanged (a pure no-op) for a player with $0 already in this street', () => {
  // Re-verifies §6.10's own original worked example still holds exactly:
  // blinds $1/$2, pot $3 before UTG acts, UTG faces a $2 call, max raise to $7.
  const room = new GameTable('T1');
  ['p1', 'p2', 'p3'].forEach((id, i) => {
    room.addPlayer(id, `Player${i + 1}`);
    room.buyChips(id, 1000);
  });
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'bettingStructure', 'pot-limit');
  room.setGameOption('p1', 'smallBlind', 1);
  room.setGameOption('p1', 'bigBlind', 2);
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1');
  room.openBetting('p1');
  assert.strictEqual(room.pot, 3);
  assert.strictEqual(room.placeBet(room.currentTurnPlayerId, 8).ok, false);
  assert.strictEqual(room.placeBet(room.currentTurnPlayerId, 7).ok, true);
});

test('CONFIRMED 9.5 (not a bug): Minimum Raise is measured from the table\'s shared current bet, NOT credited by the acting player\'s own contribution -- a player with a blind already in gets no discount on raise size', () => {
  const room = new GameTable('T1');
  ['p1', 'p2', 'p3'].forEach((id, i) => {
    room.addPlayer(id, `Player${i + 1}`);
    room.buyChips(id, 1000);
  });
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'smallBlind', 5);
  room.setGameOption('p1', 'bigBlind', 10);
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1');
  room.openBetting('p1');
  // p1 raises to $30 (a $20 raise over the $10 BB) -- minRaiseIncrement becomes $20.
  assert.strictEqual(room.placeBet('p1', 30).ok, true);
  // p2 (SB) already has $5 in this street. If Minimum Raise credited that
  // (the same way Pot-Limit Maximum correctly does), $45 would wrongly be
  // legal (only a $15 increase over the $30 bet, less than the $20
  // minimum raise size). It must NOT be legal -- everyone facing this
  // $30 bet needs to reach $50, regardless of what they'd already posted.
  const tooLow = room.placeBet('p2', 45);
  assert.strictEqual(tooLow.ok, false);
  assert.match(tooLow.error, /raise to at least \$50/);
  assert.strictEqual(room.placeBet('p2', 50).ok, true);
});
