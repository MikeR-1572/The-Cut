'use strict';

const { assert, test } = require('../helpers');
const { GameTable } = require('../../src/gameTable');

// ---------------------------------------------------------------
// v9.6: provenLosers cascading exclusion, and the corrected $0-chip
// exclusion model (sittingOut itself untouched -- see
// gameTable-core.test.js's own "CORRECTED 9.6" tests for that piece).
// ---------------------------------------------------------------

function drawRoomThroughToShowdownWithSidePot() {
  const room = new GameTable('T1');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'C');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 30); // short stack
  room.buyChips('p3', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  room.deal(5, 'p1');
  room.openBetting('p1');
  const short = room.currentTurnPlayerId; // p2
  room.allIn(short); // $30 all-in
  room.placeBet(room.currentTurnPlayerId, 100); // raises beyond the all-in -- genuine side-pot split
  room.call(room.currentTurnPlayerId); // covers the raise fully
  for (const p of room.players) if (!p.folded) room.standPat(p.id);
  room.dealToAllPlayers('p1');
  room.openBetting('p1');
  while (room.bettingOpen) room.check(room.currentTurnPlayerId);
  return room;
}

test('NEW 9.6 (§6.10): a player who receives $0 from an already-claimed higher pot is excluded from every remaining pot too, even though they were genuinely eligible for it', () => {
  const room = drawRoomThroughToShowdownWithSidePot();
  assert.strictEqual(room.handPhase, 'Showdown');
  const [main, side1] = room.pots;
  assert.deepStrictEqual(main.eligiblePlayerIds.sort(), ['p1', 'p2', 'p3']);
  assert.deepStrictEqual(side1.eligiblePlayerIds.sort(), ['p1', 'p3']);

  // Side Pot 1 (id 1, claimed first) goes entirely to p1 -- p3 gets $0
  // despite being genuinely eligible for it.
  const claimSide = room.claimPot('p1', [{ playerId: 'p1', amount: side1.amount }]);
  assert.strictEqual(claimSide.ok, true);
  room.resolveClaim(room.pendingClaim.approverId, true);

  assert.strictEqual(room.provenLosers.has('p3'), true);
  assert.strictEqual(room.provenLosers.has('p1'), false);
  assert.strictEqual(room.provenLosers.has('p2'), false);

  // Main Pot's own eligiblePlayerIds still literally lists p3 (raw,
  // contribution-based -- _recomputePots() itself is untouched), but
  // p3 can no longer actually claim any part of it.
  assert.deepStrictEqual(room.pots[0].eligiblePlayerIds.sort(), ['p1', 'p2', 'p3']);
  const p3Attempt = room.claimPot('p3', [{ playerId: 'p3', amount: main.amount }]);
  assert.strictEqual(p3Attempt.ok, false);
  assert.match(p3Attempt.error, /not eligible/);

  // p3 also can't be named as a recipient in someone ELSE's proposed split.
  const splitAttempt = room.claimPot('p1', [
    { playerId: 'p1', amount: main.amount - 10 },
    { playerId: 'p3', amount: 10 },
  ]);
  assert.strictEqual(splitAttempt.ok, false);
  assert.match(splitAttempt.error, /isn't eligible/);

  // The remaining genuinely-eligible players can still claim it normally.
  const validClaim = room.claimPot('p1', [
    { playerId: 'p1', amount: main.amount - 20 },
    { playerId: 'p2', amount: 20 },
  ]);
  assert.strictEqual(validClaim.ok, true);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.handPhase, 'CycleComplete'); // every pot now claimed
});

test('NEW 9.6: provenLosers resets to empty at the start of every new hand', () => {
  const room = drawRoomThroughToShowdownWithSidePot();
  const side1 = room.pots[1];
  room.claimPot('p1', [{ playerId: 'p1', amount: side1.amount }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.provenLosers.size, 1);

  const main = room.pots[0];
  room.claimPot('p1', [{ playerId: 'p1', amount: main.amount }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.handPhase, 'CycleComplete');

  room.startGame('p1'); // New Hand within the same Cycle
  assert.strictEqual(room.provenLosers.size, 0);
});

test('NEW 9.6 (§6.8): the Dealer cannot select an already all-in/bettingCapped player as Stud\'s opening bettor -- unaffected by the sittingOut correction', () => {
  const room = new GameTable('T1');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'C');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 30);
  room.buyChips('p3', 1000);
  room.setGameChoice('p1', 'stud-7card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.setGameOption('p1', 'bringIn', 0);
  room.startGame('p1');
  room.deal(3, 'p1');
  room.setOpeningBettor('p1', 'p2');
  room.openBetting('p1');
  room.allIn('p2');
  room.call('p3');
  room.call('p1');
  room.deal(1, 'p1'); // deal 4th street, entering the next betting round
  const result = room.setOpeningBettor('p1', 'p2'); // p2 is now allIn -- still correctly rejected
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /able to act/); // CHANGED 10.1: unified error message via _canAct()
});
