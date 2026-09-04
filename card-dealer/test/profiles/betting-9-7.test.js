'use strict';

const { assert, test, tableWithPlayers } = require('../helpers');
const { GameTable } = require('../../src/gameTable');

// ---------------------------------------------------------------
// v9.7: BUG FIX -- 9.6's _activePlayers() fix (adding a `chips > 0`
// exclusion for the sittingOut correction) was a real regression.
// _activePlayers() is shared by several callers that were never meant
// to exclude an all-in player (chips === 0 mid-hand is normal, not a
// sign they've stopped being part of the hand). Reverted to its
// original meaning; the $0-chips-at-dealing-time exclusion now lives
// in its own narrowly-scoped _dealableActivePlayers() instead.
// ---------------------------------------------------------------

test('BUG FIX 9.7: a sole all-in player, everyone else folds, can claim the pot automatically -- the confirmed regression', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 50);
  room.buyChips('p2', 1000);
  room.buyChips('p3', 1000);
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'smallBlind', 0);
  room.setGameOption('p1', 'bigBlind', 0);
  room.startGame('p1');
  room.deal(2, 'p1');
  room.openBetting('p1');
  const turn1 = room.currentTurnPlayerId;
  room.allIn(turn1);
  room.fold(room.currentTurnPlayerId);
  room.fold(room.currentTurnPlayerId);

  assert.deepStrictEqual(room._activePlayers().map((p) => p.id), [turn1]); // the all-in player still counts
  const claim = room.claimPot(turn1, [{ playerId: turn1, amount: room.pot }]);
  assert.strictEqual(claim.ok, true); // automatic, uncontested win -- no longer wrongly rejected
});

test('BUG FIX 9.7: Draw\'s DiscardPhase still correctly waits on an all-in player before advancing to DrawPhase', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 50); // p2 acts first for 3 players -- the short stack
  room.buyChips('p3', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  room.deal(5, 'p1');
  room.openBetting('p1');
  assert.strictEqual(room.currentTurnPlayerId, 'p2');
  room.allIn('p2'); // all-in for $50
  room.call('p3');
  room.call('p1');
  assert.strictEqual(room.handPhase, 'DiscardPhase');
  const allInPlayer = room.getPlayer('p2');
  assert.strictEqual(allInPlayer.chips, 0);
  assert.strictEqual(allInPlayer.allIn, true);
  assert.deepStrictEqual(
    room._activePlayers().map((p) => p.id).sort(),
    ['p1', 'p2', 'p3']
  ); // the all-in player still counts as active for this purpose

  room.standPat('p1');
  room.standPat('p3');
  assert.strictEqual(room.handPhase, 'DiscardPhase'); // still waiting on p2 -- never silently skipped
  room.standPat('p2');
  assert.strictEqual(room.handPhase, 'DrawPhase'); // advances only once everyone, including the all-in player, has acted
});

test('BUG FIX 9.7: Stud\'s Declare phase still correctly waits on an all-in player before advancing to Showdown', () => {
  const room = new GameTable('T1');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'C');
  room.setGameChoice('p1', 'stud-7card-stud8');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 0);
  room.buyChips('p3', 1000);
  room.getPlayer('p2').allIn = true;
  // FIXED 10.1: this synthetic fixture sets Declare-phase state directly
  // without ever calling deal(), so p2's hand was left empty -- harmless
  // before 10.1, but now caught by the new _wasDealtIn() check this test
  // exists to exercise (an all-in player is, by definition, someone who
  // WAS dealt into the hand; "all-in but never dealt" isn't a real state
  // this fixture intends to represent). Giving p2 real cards makes the
  // fixture accurately reflect what it's actually testing.
  room.getPlayer('p2').hand = [{ suit: 'spades', rank: 'A', id: 'fixture-1', faceUp: false }];
  room.handPhase = 'Declare';
  room.getPlayer('p1').declaration = 'high';
  room.getPlayer('p3').declaration = 'low';
  assert.deepStrictEqual(
    room._activePlayers().map((p) => p.id).sort(),
    ['p1', 'p2', 'p3']
  ); // the all-in, not-yet-declared player still counts

  room._maybeAdvanceFromDeclare();
  assert.strictEqual(room.handPhase, 'Declare'); // still waiting on p2's declaration
  room.getPlayer('p2').declaration = 'high';
  room._maybeAdvanceFromDeclare();
  assert.strictEqual(room.handPhase, 'Showdown'); // advances only once the all-in player has also declared
});

test('BUG FIX 9.7: RequestAntes correctly refuses to advance if every seated player happens to be $0-chip -- uses _dealableActivePlayers(), not the plain _activePlayers()', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  // Nobody buys chips -- both stay at $0.
  room.setGameChoice('p1', 'draw-5card');
  room.startGame('p1');
  assert.strictEqual(room.handPhase, 'RequestAntes'); // never advances -- nobody is dealable
});

test('The multi-pot claim path (currentPot.eligiblePlayerIds) was never affected by this bug -- confirms the fix is scoped correctly', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 30); // p2 acts first -- short stack
  room.buyChips('p3', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  room.deal(5, 'p1');
  room.openBetting('p1');
  room.allIn('p2'); // $30 all-in
  room.placeBet(room.currentTurnPlayerId, 100); // raises beyond it -- genuine side-pot split
  room.call(room.currentTurnPlayerId);
  assert.notStrictEqual(room.pots, null); // a real side pot exists -- multi-pot path, not the single-pot fallback
});
