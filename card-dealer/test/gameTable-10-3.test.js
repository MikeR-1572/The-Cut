'use strict';

const { assert, test, tableWithPlayers } = require('./helpers');
const { GameTable } = require('../src/gameTable');

// ---------------------------------------------------------------
// v10.3 Part A: Table Owner Recovery Functions
// (the-cut-spec_v10-3.md Part A). Priorities per Mike's own explicit
// ordering: Function 1 >> Function 2 >> Function 3 (each ~5x more
// important than the next) -- test depth below follows that ordering.
// ---------------------------------------------------------------

test('Function 1: creatorId-only, force-ends the hand, leaves pot/chips/totalBuyIn untouched, denies a pending claim without moving money', () => {
  const room = new GameTable('T1');
  room.addPlayer('p1', 'A'); // creator/Table Owner
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 500);
  room.setGameChoice('p1', 'holdem-texas');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1');
  room.openBetting('p1');
  const bettor = room.currentTurnPlayerId;
  const other = bettor === 'p1' ? 'p2' : 'p1';
  room.placeBet(bettor, 40);
  room.fold(other); // sole-eligible -- early claim window
  const claimResult = room.claimPot(bettor, [{ playerId: bettor, amount: room.pot }]);
  assert.strictEqual(claimResult.ok, true);
  assert.ok(room.pendingClaim);

  assert.strictEqual(room.terminateGameCleanly('p2').ok, false); // non-owner rejected

  const potBefore = room.pot;
  const p1ChipsBefore = room.getPlayer('p1').chips;
  const p2ChipsBefore = room.getPlayer('p2').chips;
  const p1BuyInBefore = room.getPlayer('p1').totalBuyIn;
  const result = room.terminateGameCleanly('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.handPhase, 'CycleComplete');
  assert.strictEqual(room.idle, true);
  assert.strictEqual(room.pendingClaim, null); // denied, not silently discarded
  assert.strictEqual(room.pot, potBefore); // untouched
  assert.strictEqual(room.getPlayer('p1').chips, p1ChipsBefore); // untouched -- claim never approved
  assert.strictEqual(room.getPlayer('p2').chips, p2ChipsBefore);
  assert.strictEqual(room.getPlayer('p1').totalBuyIn, p1BuyInBefore);
  assert.strictEqual(room.pots, null); // any tier structure collapsed
});

test('Function 1: force-ends the hand from an arbitrary mid-hand phase (not just mid-betting)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  room.deal(5, 'p1');
  room.openBetting('p1');
  while (room.bettingOpen) room.check(room.currentTurnPlayerId);
  assert.strictEqual(room.handPhase, 'DiscardPhase');
  const potBefore = room.pot;
  const result = room.terminateGameCleanly('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.handPhase, 'CycleComplete');
  assert.strictEqual(room.pot, potBefore);
});

test('Function 2: rejects cleanly when no hand has ever started this session', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 500);
  const result = room.restorePlayerStacks('p1');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /no hand has started/i);
});

test('Function 2: creatorId-only, restores chips/totalBuyIn to the pre-current-hand snapshot, zeroes the pot, leaves a mid-hand joiner untouched', () => {
  const room = new GameTable('T2');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 500);
  room.setGameChoice('p1', 'holdem-texas');
  room.startGame('p1'); // snapshot taken here -- p1=1000, p2=500
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1');
  room.openBetting('p1');
  room.placeBet(room.currentTurnPlayerId, 100);
  room.call(room.currentTurnPlayerId);
  assert.notStrictEqual(room.getPlayer('p1').chips, 1000);

  assert.strictEqual(room.restorePlayerStacks('p2').ok, false); // non-owner rejected

  const result = room.restorePlayerStacks('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').chips, 1000);
  assert.strictEqual(room.getPlayer('p2').chips, 500);
  assert.strictEqual(room.getPlayer('p1').totalBuyIn, 1000);
  assert.strictEqual(room.pot, 0);
  assert.strictEqual(room.handPhase, 'CycleComplete');

  // A second real hand, then a mid-hand joiner -- restore() must leave them untouched.
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1');
  room.addPlayer('p3', 'C');
  room.buyChips('p3', 300);
  room.restorePlayerStacks('p1');
  assert.strictEqual(room.getPlayer('p3').chips, 300, 'a Player who joined after the snapshot must be left untouched, not zeroed');
});

test('Function 2: snapshot is re-taken fresh every hand -- restores to the MOST RECENT hand, not a stale earlier one', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1'); // snapshot #1: 1000/1000
  room.deal(5, 'p1');
  room.terminateGameCleanly('p1'); // back to idle
  room.buyChips('p1', 500); // deliberately change stacks between hands
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1'); // snapshot #2, taken fresh, reflecting the NEW stacks
  const snapshotTwoP1Chips = room.getPlayer('p1').chips;
  room.deal(5, 'p1');
  room.openBetting('p1');
  room.placeBet(room.currentTurnPlayerId, 20);
  room.restorePlayerStacks('p1');
  assert.strictEqual(room.getPlayer('p1').chips, snapshotTwoP1Chips, 'must restore to the SECOND hand\'s snapshot, not the first');
});

test('Function 3: creatorId-only at every stage (begin, stage, update, remove, discard, commit)', () => {
  const room = new GameTable('T3');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 500);
  room.buyChips('p2', 500);
  assert.strictEqual(room.beginPotDistribution('p2').ok, false);
  room.beginPotDistribution('p1');
  assert.strictEqual(room.stageAllocation('p2', { playerId: 'p1', direction: 'take', amount: 10 }).ok, false);
  const s = room.stageAllocation('p1', { playerId: 'p1', direction: 'take', amount: 10 });
  assert.strictEqual(room.updateStagedAllocation('p2', s.allocationId, { direction: 'take', amount: 20 }).ok, false);
  assert.strictEqual(room.removeStagedAllocation('p2', s.allocationId).ok, false);
  assert.strictEqual(room.discardPotDistributionBatch('p2').ok, false);
  assert.strictEqual(room.commitPotDistribution('p2').ok, false);
});

test('Function 3: full staging lifecycle -- add, edit, remove, live preview, commit', () => {
  const room = new GameTable('T3b');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'C');
  room.buyChips('p1', 500);
  room.buyChips('p2', 500);
  room.buyChips('p3', 500);
  room.pot = 300;

  assert.strictEqual(room.beginPotDistribution('p1').ok, true);
  assert.strictEqual(room.beginPotDistribution('p1').ok, false, 'a second open is rejected while one is already active');

  const give = room.stageAllocation('p1', { playerId: 'p2', direction: 'give', amount: 150 });
  const take = room.stageAllocation('p1', { playerId: 'p3', direction: 'take', amount: 50 });
  assert.strictEqual(give.ok, true);
  assert.strictEqual(take.ok, true);

  assert.strictEqual(room.stageAllocation('p1', { playerId: 'ghost', direction: 'take', amount: 10 }).ok, false);
  assert.strictEqual(room.stageAllocation('p1', { playerId: 'p2', direction: 'sideways', amount: 10 }).ok, false);
  assert.strictEqual(room.stageAllocation('p1', { playerId: 'p2', direction: 'take', amount: -5 }).ok, false);

  assert.strictEqual(room.updateStagedAllocation('p1', give.allocationId, { direction: 'give', amount: 200 }).ok, true);

  const preview = room.toRedactedState('p1').pendingAllocationBatch;
  assert.strictEqual(preview.previewPot, 300 + 50 - 200); // take adds, give subtracts
  assert.strictEqual(preview.previewChipsByPlayerId.p2, 700);
  assert.strictEqual(preview.previewChipsByPlayerId.p3, 450);

  // Nothing real has moved yet.
  assert.strictEqual(room.pot, 300);
  assert.strictEqual(room.getPlayer('p2').chips, 500);

  assert.strictEqual(room.removeStagedAllocation('p1', take.allocationId).ok, true);

  const commitResult = room.commitPotDistribution('p1');
  assert.strictEqual(commitResult.ok, true);
  assert.strictEqual(room.pot, 100); // 300 - 200
  assert.strictEqual(room.getPlayer('p2').chips, 700);
  assert.strictEqual(room.getPlayer('p3').chips, 500); // untouched -- that entry was removed before commit
  assert.strictEqual(room._pendingAllocationBatch, null);
});

test('Function 3: commit is atomic -- a batch that would drive a Player negative applies NOTHING, even the parts that individually look fine', () => {
  const room = new GameTable('T3c');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 500);
  room.buyChips('p2', 100);
  room.pot = 50;
  room.beginPotDistribution('p1');
  // Two separate take entries, each individually well within p2's $100,
  // but together they overdraw ($60 + $60 = $120 > $100) -- must be
  // caught by NET effect, not per-entry.
  room.stageAllocation('p1', { playerId: 'p2', direction: 'take', amount: 60 });
  room.stageAllocation('p1', { playerId: 'p2', direction: 'take', amount: 60 });
  const p2Before = room.getPlayer('p2').chips;
  const potBefore = room.pot;
  const result = room.commitPotDistribution('p1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(room.getPlayer('p2').chips, p2Before, 'nothing applied on atomic failure');
  assert.strictEqual(room.pot, potBefore);
  assert.notStrictEqual(room._pendingAllocationBatch, null, 'the batch stays open after a failed commit -- not silently discarded');
});

test('Function 3: commit is atomic -- a batch that would drive the pot negative applies nothing', () => {
  const room = new GameTable('T3d');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 500);
  room.buyChips('p2', 1000);
  room.pot = 50;
  room.beginPotDistribution('p1');
  room.stageAllocation('p1', { playerId: 'p2', direction: 'give', amount: 1000 }); // far more than the $50 pot
  const potBefore = room.pot;
  const result = room.commitPotDistribution('p1');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /negative/i);
  assert.strictEqual(room.pot, potBefore);
});

test('Function 3: gated to idle for both staging and commit, per Mike\'s explicit confirmation', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1'); // idle -> false
  assert.strictEqual(room.idle, false);
  assert.strictEqual(room.beginPotDistribution('p1').ok, false);
});

test('Function 3: discard clears the batch without touching any real value', () => {
  const room = new GameTable('T3e');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 500);
  room.buyChips('p2', 500);
  room.pot = 100;
  room.beginPotDistribution('p1');
  room.stageAllocation('p1', { playerId: 'p2', direction: 'give', amount: 400 });
  assert.strictEqual(room.discardPotDistributionBatch('p1').ok, true);
  assert.strictEqual(room.pot, 100);
  assert.strictEqual(room.getPlayer('p2').chips, 500);
  assert.strictEqual(room._pendingAllocationBatch, null);
});

test('Function 3: everyone but the Table Owner sees only the standing indicator, never the staged detail', () => {
  const room = new GameTable('T3f');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 500);
  room.buyChips('p2', 500);
  room.pot = 100;
  room.beginPotDistribution('p1');
  room.stageAllocation('p1', { playerId: 'p2', direction: 'give', amount: 50 });
  const ownerView = room.toRedactedState('p1');
  const otherView = room.toRedactedState('p2');
  assert.strictEqual(ownerView.tableOwnerDistributionInProgress, true);
  assert.ok(ownerView.pendingAllocationBatch);
  assert.strictEqual(otherView.tableOwnerDistributionInProgress, true);
  assert.strictEqual(otherView.pendingAllocationBatch, null);
});

// ---------------------------------------------------------------
// v10.3 Part B: Gameplay Fixes from 10.2 Live Testing
// ---------------------------------------------------------------

test('B.1: Stud\'s deal() no longer excludes legitimately all-in survivors on later streets', () => {
  const room = new GameTable('B1');
  room.addPlayer('p1', 'A'); // will go all-in
  room.addPlayer('p2', 'B'); // deep stack, stays active
  room.addPlayer('p3', 'C'); // will go all-in
  room.addPlayer('p4', 'D'); // will go all-in
  room.buyChips('p1', 30);
  room.buyChips('p2', 1000);
  room.buyChips('p3', 30);
  room.buyChips('p4', 30);
  room.setGameChoice('p1', 'stud-7card');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(3, 'p1');
  room.setOpeningBettor('p1', room.turnOrder[0]);
  room.openBetting('p1');
  // Directly drive the exact scenario B.1 describes -- 3 of 4 remaining
  // Players genuinely all-in from this street -- rather than relying on
  // emergent behavior from a generic betting loop that might never
  // happen to exhaust anyone's stack.
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) {
    const p = room.getPlayer(room.currentTurnPlayerId);
    if (p.id === 'p2') {
      if (p.currentBet < room.currentBetToCall) room.call(p.id);
      else room.check(p.id);
    } else if (p.chips > 0) {
      room.allIn(p.id);
    } else {
      room.check(p.id);
    }
  }
  const allInCount = room.players.filter((p) => p.allIn).length;
  assert.strictEqual(allInCount, 3, `expected exactly 3 Players genuinely all-in (p1/p3/p4), got ${allInCount}`);
  assert.strictEqual(room.handPhase, 'StreetB');
  const result = room.deal(1, 'p1'); // 3rd Street's single card
  assert.strictEqual(result.ok, true, `expected deal() to succeed with multiple all-in survivors, got: ${result.error}`);
  for (const p of room.players) {
    if (!p.folded) assert.strictEqual(p.hand.length, 4, `${p.name} (allIn=${p.allIn}, chips=${p.chips}) should have received their 4th card regardless of chip count`);
  }
});

// REPLACED 10.4 (the-cut-spec_v10-4.md B.2, superseded/reverted -- see
// test/gameTable-10-4.test.js for the reverted behavior + the new
// misdealStuckAntes() coverage). Left as a comment, not silently
// deleted with no trace, matching this project's own convention of
// keeping history visible: the partial-post approach this test asserted
// caused a live, cascading, money-affecting defect (blind-seat identity
// desync) and was reverted outright rather than patched further.

test('B.2 ($0 chips case, unchanged by the revert): a Player with exactly $0 chips still cannot post', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setAnteBlind('p1', 'p2', 50); // p2 has never bought chips -- $0
  const result = room.postAnteBlind('p2');
  assert.strictEqual(result.ok, false);
});

test('B.3: buyChips rejects during RequestAntes once a Player owes or has posted for the hand being formed', () => {
  const room = new GameTable('B3');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'holdem-texas');
  room.startGame('p1');
  assert.strictEqual(room.handPhase, 'RequestAntes');
  const owingPlayer = room.players.find((p) => p.oweAnte > 0);
  assert.ok(owingPlayer);
  const rejectResult = room.buyChips(owingPlayer.id, 100);
  assert.strictEqual(rejectResult.ok, false);
  room.postAnteBlind(owingPlayer.id);
  const stillRejectResult = room.buyChips(owingPlayer.id, 100);
  assert.strictEqual(stillRejectResult.ok, false, 'still rejected after posting -- already committed to the hand being formed');
});

test('B.3: buyChips remains available between hands (idle), unaffected by the new RequestAntes-specific check', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.idle, true);
  const result = room.buyChips('p1', 300);
  assert.strictEqual(result.ok, true);
});
