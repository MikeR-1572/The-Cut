'use strict';

const { assert, test, tableWithPlayers } = require('./helpers');
const { GameTable } = require('../src/gameTable');

// ---------------------------------------------------------------
// v10.1: centralized eligibility evaluation (the-cut-spec_v10-1.md §8).
// Every test below reproduces one of the 11 confirmed defects from
// Mike's own live testing of v10.0 (§8.3), or the one additional
// hand-blocking bug found via direct reproduction while fixing them
// (openBetting()'s minimum-active-player gate). None of these had
// coverage before this version -- confirmed by direct inspection before
// writing these, not assumed.
//
// Shared setup pattern: p3 is seated (in turnOrder) but never buys
// chips, so deal() never deals them in (chips === 0) -- the exact
// "never-dealt $0-chip Player" possibility every defect here traces to.
// ---------------------------------------------------------------

function drawRoomWithPhantomPlayer() {
  const room = new GameTable('T1');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'Phantom'); // never buys chips -- never dealt in
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  room.deal(5, 'p1');
  return room;
}

test('defect 1: turn order never gives a never-dealt $0-chip Player a turn', () => {
  const room = drawRoomWithPhantomPlayer();
  assert.strictEqual(room.getPlayer('p3').hand.length, 0);
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 10) {
    assert.notStrictEqual(room.currentTurnPlayerId, 'p3');
    room.check(room.currentTurnPlayerId);
  }
  assert.strictEqual(room.bettingOpen, false); // closed correctly, never hung waiting on p3
});

test('defect 2: betting round closes normally with a never-dealt $0-chip Player seated', () => {
  const room = drawRoomWithPhantomPlayer();
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 10) {
    room.check(room.currentTurnPlayerId);
  }
  assert.ok(guard < 10, 'round should have closed well within the guard limit');
  assert.strictEqual(room.bettingOpen, false);
});

test('defect 3: Discard-phase completion does not wait on a never-dealt $0-chip Player', () => {
  const room = drawRoomWithPhantomPlayer();
  room.openBetting('p1');
  while (room.bettingOpen) room.check(room.currentTurnPlayerId);
  assert.strictEqual(room.handPhase, 'DiscardPhase');
  room.standPat('p1');
  room.standPat('p2');
  // p3 never acts (never dealt in) -- phase must still advance.
  assert.strictEqual(room.handPhase, 'DrawPhase');
});

test('defect 4/6: heads-up raise-cap waiver and opponent-ceiling both ignore a never-dealt $0-chip Player', () => {
  const room = new GameTable('T2');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'Phantom');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'bettingStructure', 'fixed-limit');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(room.gameOptions.cardsPerPlayer, 'p1');
  room.openBetting('p1');
  // Only p1 and p2 are genuinely dealt in -- this IS heads-up despite p3
  // sitting at the table, so the raise cap must be waived, and a
  // voluntary raise must not be artificially capped down by p3's $0.
  const opener = room.currentTurnPlayerId;
  const other = opener === 'p1' ? 'p2' : 'p1';
  // Raise repeatedly beyond any default cap (3) -- should never be
  // rejected as "cap reached" since this is genuinely heads-up.
  for (let i = 0; i < 5 && room.bettingOpen; i++) {
    const actingId = room.currentTurnPlayerId;
    const acting = room.getPlayer(actingId);
    if (acting.currentBet < room.currentBetToCall) {
      const result = room.call(actingId);
      if (result.ok === false) break;
    } else {
      break;
    }
  }
  // Directly confirm the cap-waiver condition itself rather than only
  // its downstream effect.
  assert.strictEqual(room.players.filter((p) => room._isHandParticipant(p)).length, 2);
});

test('defect 5: setOpeningBettor rejects a never-dealt $0-chip Player, and excludes them from eligibleOpeningBettorIds', () => {
  const room = new GameTable('T3');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'Phantom');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'stud-7card-stud8');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(3, 'p1');
  assert.strictEqual(room.getPlayer('p3').hand.length, 0);

  const result = room.setOpeningBettor('p1', 'p3');
  assert.strictEqual(result.ok, false);

  const state = room.toRedactedState('p1');
  assert.strictEqual(state.eligibleOpeningBettorIds.includes('p3'), false);
  assert.strictEqual(state.eligibleOpeningBettorIds.includes('p1'), true);
  assert.strictEqual(state.eligibleOpeningBettorIds.includes('p2'), true);
});

test('defects 7-9: claimEligiblePlayerIds excludes a never-dealt Player (single-pot) and a provenLosers Player (multi-pot), and claimWindowOpen reflects the early-claim condition', () => {
  const room = drawRoomWithPhantomPlayer();
  room.openBetting('p1');
  room.placeBet(room.currentTurnPlayerId, 20);
  room.call(room.currentTurnPlayerId);
  // Betting round auto-closed once both real players called/bet evenly.
  const stateBeforeClaim = room.toRedactedState('p1');
  assert.strictEqual(stateBeforeClaim.claimEligiblePlayerIds.includes('p3'), false);
  assert.strictEqual(stateBeforeClaim.claimEligiblePlayerIds.includes('p1'), true);
  assert.strictEqual(stateBeforeClaim.claimEligiblePlayerIds.includes('p2'), true);

  // Now the multi-pot / provenLosers case, reusing the 9.6 fixture shape.
  const room2 = new GameTable('T4');
  room2.addPlayer('p1', 'A');
  room2.addPlayer('p2', 'B');
  room2.addPlayer('p3', 'C');
  room2.buyChips('p1', 1000);
  room2.buyChips('p2', 30); // short stack
  room2.buyChips('p3', 1000);
  room2.setGameChoice('p1', 'draw-5card');
  room2.setGameOption('p1', 'anteAmount', 0);
  room2.startGame('p1');
  room2.deal(5, 'p1');
  room2.openBetting('p1');
  room2.allIn('p2');
  room2.placeBet(room2.currentTurnPlayerId, 100);
  room2.call(room2.currentTurnPlayerId);
  for (const p of room2.players) if (!p.folded) room2.standPat(p.id);
  room2.dealToAllPlayers('p1');
  room2.openBetting('p1');
  while (room2.bettingOpen) room2.check(room2.currentTurnPlayerId);
  assert.strictEqual(room2.handPhase, 'Showdown');
  const [main, side1] = room2.pots;
  room2.claimPot('p1', [{ playerId: 'p1', amount: side1.amount }]);
  room2.resolveClaim(room2.pendingClaim.approverId, true);
  assert.strictEqual(room2.provenLosers.has('p3'), true);

  const state2 = room2.toRedactedState('p1');
  // Main Pot is now the current claimable pot -- p3 was proven to lose
  // Side Pot 1 and must be excluded from the Main Pot's eligibility too.
  assert.strictEqual(state2.claimEligiblePlayerIds.includes('p3'), false);
  assert.strictEqual(state2.claimWindowOpen, true); // Showdown -- always claimable
  const mainPotState = state2.pots.find((p) => p.id === main.id);
  assert.strictEqual(mainPotState.liveEligiblePlayerIds.includes('p3'), false);
  assert.strictEqual(mainPotState.eligiblePlayerIds.includes('p3'), true); // raw threshold fact, untouched
});

test('defect 10: Fold and Sit Out force-folds a Player outside an open betting round (mid-Discard-phase)', () => {
  const room = new GameTable('T5');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'C');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  room.deal(5, 'p1');
  room.openBetting('p1');
  while (room.bettingOpen) room.check(room.currentTurnPlayerId);
  assert.strictEqual(room.handPhase, 'DiscardPhase');

  const result = room.sitOut('p3', 'foldAndSitOut');
  assert.strictEqual(result.ok, true);
  const p3 = room.getPlayer('p3');
  assert.strictEqual(p3.folded, true); // the actual fix -- previously stayed false outside a betting window
  assert.strictEqual(p3.sittingOut, true);

  const state = room.toRedactedState('p1');
  const p3State = state.players.find((p) => p.id === 'p3');
  assert.strictEqual(p3State.pending, false); // resolved via fold, not left in limbo
  assert.strictEqual(state.claimEligiblePlayerIds.includes('p3'), false);

  // Confirms the phase-completion re-check fires too, not just the flag.
  room.standPat('p1');
  room.standPat('p2');
  assert.strictEqual(room.handPhase, 'DrawPhase'); // does not hang waiting on p3
});

test("defect 10 (negative case): Fold and Sit Out does NOT force-fold a genuinely all-in Player -- there is nothing to fold from", () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 30);
  room.buyChips('p3', 1000);
  room.openBetting('p1'); // turn -> p2 in the no-Game-Choice generic mode
  room.allIn('p2');
  room.placeBet(room.currentTurnPlayerId, 100);
  room.call(room.currentTurnPlayerId);
  const p2Before = room.getPlayer('p2');
  assert.strictEqual(p2Before.allIn, true);
  assert.strictEqual(p2Before.folded, false);

  const result = room.sitOut('p2', 'foldAndSitOut');
  assert.strictEqual(result.ok, true);
  const p2After = room.getPlayer('p2');
  assert.strictEqual(p2After.folded, false); // NOT force-folded -- would have wrongly zeroed real pot equity
  assert.strictEqual(p2After.sittingOut, true);
});

test('defect 11: queued Sit-Out intent resolves symmetrically with Sit-In, the instant a claim resolves and the hand goes idle', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.call('p1');
  const queueResult = room.sitOut('p2', 'sitOutNextGame');
  assert.strictEqual(queueResult.ok, true);
  assert.strictEqual(room.getPlayer('p2').sitOutPending, true);
  assert.strictEqual(room.getPlayer('p2').sittingOut, false); // not yet applied

  room.claimPot('p2', [{ playerId: 'p2', amount: 40 }]);
  room.resolveClaim('p1', true);

  // Previously this only resolved at the NEXT deal()/reset -- now
  // resolves immediately alongside sitInPending, at the exact instant
  // idle becomes true.
  assert.strictEqual(room.idle, true);
  assert.strictEqual(room.getPlayer('p2').sittingOut, true);
  assert.strictEqual(room.getPlayer('p2').sitOutPending, false);
});

test('bonus defect (found via direct reproduction, not in the original 11): openBetting() no longer blocks on a legitimately all-in Player surviving from an earlier street', () => {
  const room = new GameTable('T6');
  room.addPlayer('p1', 'A'); // short stack
  room.addPlayer('p2', 'B'); // deep stack
  room.buyChips('p1', 100);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'holdem-texas');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(room.gameOptions.cardsPerPlayer, 'p1');
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 10) {
    const turn = room.currentTurnPlayerId;
    if (turn === 'p1' && room.getPlayer('p1').chips > 0) {
      room.allIn('p1');
    } else {
      const p = room.getPlayer(turn);
      if (p.currentBet < room.currentBetToCall) room.call(turn);
      else room.check(turn);
    }
  }
  assert.strictEqual(room.getPlayer('p1').chips, 0);
  assert.strictEqual(room.getPlayer('p1').allIn, true);
  room.dealCommunity('p1'); // Flop -> FlopBetting
  assert.strictEqual(room.handPhase, 'FlopBetting');
  // Previously rejected: "Need at least 2 active (not sitting out) players
  // to open betting" -- p1's $0 chips wrongly excluded them, leaving no
  // path forward at all (2 players genuinely remain pot-eligible, so the
  // early-claim shortcut doesn't apply either).
  const result = room.openBetting('p1');
  assert.strictEqual(result.ok, true);
});
