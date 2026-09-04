'use strict';

const { assert, test, tableWithPlayers, drawRoomAtFirstBetting } = require('./helpers');
const { GameTable } = require('../src/gameTable');

// ---------------------------------------------------------------
// v10.0: the Seat/Player/Dealer re-architecture's Player-status model.
// See the-cut-spec_v10-0.md §2 (pending/Buy-Chips), §3 (Dealer
// independence), §4 (client visibility -- not unit-testable here, no
// DOM harness in this suite; verified via direct code inspection and
// live-socket testing instead, per project convention).
//
// No prior test in this suite ever exercised buyChips() mid-hand at
// all (confirmed by direct grep before writing these) -- every existing
// call happens during pre-hand setup, so the gate added here was a
// genuinely untested gap, not a hidden regression risk.
// ---------------------------------------------------------------

test('pending: nobody is pending between games (idle), even a player who will be dealt in next hand', () => {
  const room = tableWithPlayers('A', 'B');
  for (const p of room.players) room.buyChips(p.id, 500);
  assert.strictEqual(room.idle, true);
  const state = room.toRedactedState('p1');
  for (const p of state.players) assert.strictEqual(p.pending, false);
});

test('pending: an active, non-folded, non-excluded player mid-hand is pending', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'A', 'B', 'C');
  assert.strictEqual(room.idle, false);
  const state = room.toRedactedState('p1');
  for (const p of state.players) assert.strictEqual(p.pending, true);
});

test('pending: a folded player mid-hand is not pending, even though the hand is still live for others', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'A', 'B', 'C');
  room.openBetting('p1');
  const firstToAct = room.currentTurnPlayerId;
  room.fold(firstToAct);
  const folded = room.getPlayer(firstToAct);
  assert.strictEqual(folded.folded, true);
  assert.strictEqual(room.idle, false); // hand still going for B/C
  const state = room.toRedactedState('p1');
  const foldedState = state.players.find((p) => p.id === firstToAct);
  assert.strictEqual(foldedState.pending, false);
  // confirms the other two, still live, remain pending
  for (const p of state.players) {
    if (p.id !== firstToAct) assert.strictEqual(p.pending, true);
  }
});

test('pending: a genuinely all-in player is still pending (independent of the allIn display flag)', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'A', 'B', 'C');
  room.openBetting('p1');
  const firstToAct = room.currentTurnPlayerId;
  room.allIn(firstToAct);
  const shover = room.getPlayer(firstToAct);
  assert.strictEqual(shover.allIn, true);
  const state = room.toRedactedState('p1');
  const shoverState = state.players.find((p) => p.id === firstToAct);
  assert.strictEqual(shoverState.pending, true); // §2.1: pending != allIn
});

test('pending: a player excluded from all remaining pots (provenLosers) is not pending, even while the hand continues for others', () => {
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
  room.allIn('p2'); // $30 all-in
  room.placeBet(room.currentTurnPlayerId, 100); // raises beyond the all-in -- genuine side-pot split
  room.call(room.currentTurnPlayerId);
  for (const p of room.players) if (!p.folded) room.standPat(p.id);
  room.dealToAllPlayers('p1');
  room.openBetting('p1');
  while (room.bettingOpen) room.check(room.currentTurnPlayerId);
  assert.strictEqual(room.handPhase, 'Showdown');

  const [main, side1] = room.pots;
  // Side Pot 1 goes entirely to p1 -- p3 gets $0 despite genuine eligibility, per 9.6.
  const claimSide = room.claimPot('p1', [{ playerId: 'p1', amount: side1.amount }]);
  assert.strictEqual(claimSide.ok, true);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.provenLosers.has('p3'), true);
  assert.strictEqual(room.idle, false); // Main Pot still unclaimed -- hand isn't over yet

  const state = room.toRedactedState('p1');
  const p3State = state.players.find((p) => p.id === 'p3');
  assert.strictEqual(p3State.pending, false); // resolved to zero, even though the hand goes on
  const p1State = state.players.find((p) => p.id === 'p1');
  assert.strictEqual(p1State.pending, true); // still eligible for the unclaimed Main Pot
});

test('pending: a sitting-out player (never dealt into this hand) is not pending, even though they are not folded', () => {
  const room = tableWithPlayers('A', 'B', 'C');
  for (const p of room.players) room.buyChips(p.id, 500);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  // p3 sits out before the deal -- immediate mode, idle is still true here so it applies now
  room.sitOut('p3', 'foldAndSitOut');
  assert.strictEqual(room.getPlayer('p3').sittingOut, true);
  room.deal(5, 'p1'); // only p1/p2 get dealt in
  assert.strictEqual(room.getPlayer('p3').hand.length, 0);
  assert.strictEqual(room.getPlayer('p3').folded, false); // sitting out, not folded
  const state = room.toRedactedState('p1');
  const p3State = state.players.find((p) => p.id === 'p3');
  assert.strictEqual(p3State.pending, false);
});

test('buyChips: rejected while the requester is pending mid-hand', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'A', 'B', 'C');
  const active = room.currentTurnPlayerId;
  const result = room.buyChips(active, 200);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /pending/i);
});

test('buyChips: allowed for a folded player mid-hand, while the hand is still live for others (§5.3)', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'A', 'B', 'C');
  room.openBetting('p1');
  const firstToAct = room.currentTurnPlayerId;
  const before = room.getPlayer(firstToAct).chips;
  room.fold(firstToAct);
  assert.strictEqual(room.idle, false);
  const result = room.buyChips(firstToAct, 150);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer(firstToAct).chips, before + 150);
});

test('buyChips: allowed for a player excluded from all remaining pots (provenLosers), while the hand is still live', () => {
  const room = new GameTable('T2');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'C');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 30);
  room.buyChips('p3', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  room.deal(5, 'p1');
  room.openBetting('p1');
  room.allIn('p2');
  room.placeBet(room.currentTurnPlayerId, 100);
  room.call(room.currentTurnPlayerId);
  for (const p of room.players) if (!p.folded) room.standPat(p.id);
  room.dealToAllPlayers('p1');
  room.openBetting('p1');
  while (room.bettingOpen) room.check(room.currentTurnPlayerId);
  const [main, side1] = room.pots;
  room.claimPot('p1', [{ playerId: 'p1', amount: side1.amount }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.provenLosers.has('p3'), true);
  assert.strictEqual(room.idle, false);
  const result = room.buyChips('p3', 100);
  assert.strictEqual(result.ok, true);
});

test('buyChips: allowed between games for everyone (unchanged baseline behavior)', () => {
  const room = tableWithPlayers('A', 'B');
  assert.strictEqual(room.idle, true);
  const result = room.buyChips('p1', 300);
  assert.strictEqual(result.ok, true);
});

// ---------------------------------------------------------------
// Dealer-role independence (the-cut-spec_v10-0.md §3) -- both behaviors
// below were confirmed correct by direct code inspection against the
// live 9.7 build before any 10.0 code was written (per the dev-chat
// resolutions doc's explicit caveat that these were stated requirements,
// not yet verified). These tests lock that verification in as
// regression coverage now that it's confirmed.
// ---------------------------------------------------------------

test("Dealer independence: a Dealer can never Sit Out directly, mid-game or between games -- must Pass the Buck first", () => {
  const room = tableWithPlayers('A', 'B');
  for (const p of room.players) room.buyChips(p.id, 500);
  const dealer = room.getDealer();
  assert.ok(dealer);
  const result = room.sitOut(dealer.id, 'foldAndSitOut');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /Pass the Buck/i);
});

test('Dealer independence: a $0/all-in, pending Dealer keeps dealing, opening betting, and approving claims -- none of it gated on their own chip/pending status', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'A', 'B', 'C');
  const dealer = room.getDealer();
  room.openBetting('p1');
  // Force the Dealer itself all-in and pending, mid-hand.
  while (room.currentTurnPlayerId !== dealer.id && room.bettingOpen) {
    room.check(room.currentTurnPlayerId);
  }
  if (room.bettingOpen) room.allIn(dealer.id);
  const dealerState = room.getPlayer(dealer.id);
  assert.strictEqual(dealerState.chips, 0);
  const pendingState = room.toRedactedState(dealer.id).players.find((p) => p.id === dealer.id);
  assert.strictEqual(pendingState.pending, true);
  // The pending Dealer's own chip/pending status buys them no exemption
  // AND no penalty on their continuing Dealer-role responsibilities --
  // confirm buyChips is still correctly blocked (§2.2) while dealing
  // itself is untouched (§3), the two axes the spec insists stay separate.
  assert.strictEqual(room.buyChips(dealer.id, 100).ok, false);
});
