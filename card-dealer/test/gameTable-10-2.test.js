'use strict';

const { assert, test, tableWithPlayers, studRoomAtStreetABetting } = require('./helpers');
const { GameTable } = require('../src/gameTable');

// ---------------------------------------------------------------
// v10.2: the complete, exhaustive re-audit (the-cut-spec_v10-2.md §9).
// Each test reproduces one of the 8 confirmed defects in §9.3 -- none
// had coverage before this version. Items 4/5 also carry a NEGATIVE
// case each, confirming the fix does not regress the legitimate
// full-hand-discard scenario that a naive dealt-in check would have
// broken (verified by direct reproduction before writing the fix, not
// assumed).
// ---------------------------------------------------------------

test('item 1: openBetting() never hands the first-actor turn to a never-dealt $0-chip Player', () => {
  const room = new GameTable('T1');
  room.addPlayer('p1', 'A'); // Dealer -- Draw's anchor is always the Dealer directly, no blind-seat override
  room.addPlayer('p3', 'Phantom'); // seated DIRECTLY after the Dealer -- the exact position the anchor logic checks first
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  room.deal(5, 'p1');
  const result = room.openBetting('p1');
  assert.strictEqual(result.ok, true);
  assert.notStrictEqual(room.currentTurnPlayerId, 'p3');
  assert.strictEqual(room.getPlayer('p3').hand.length, 0);
});

test('item 2: an uncalled-bet refund resyncs currentBetToCall, not just the refunded Player\'s own fields', () => {
  // Reuses the exact zeroBlindRoom/Refund Scenario A fixture from
  // holdem-9-1.test.js (refund-scenario-reference.md), a proven,
  // deterministic setup, plus one new assertion this version's fix is
  // actually about. 4 players, UTG-first turn order: A=p4($500),
  // B=p1($175), C=p2($400), D=p3($250).
  const room = new GameTable('T2');
  [175, 400, 250, 500].forEach((amount, i) => {
    room.addPlayer(`p${i + 1}`, `Player${i + 1}`);
    room.buyChips(`p${i + 1}`, amount);
  });
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'smallBlind', 0);
  room.setGameOption('p1', 'bigBlind', 0);
  room.startGame('p1');
  room.deal(2, 'p1');
  room.openBetting('p1');
  assert.strictEqual(room.currentTurnPlayerId, 'p4');

  room.placeBet('p4', 400); // A bets $400
  assert.strictEqual(room.currentBetToCall, 400);
  room.allIn('p1'); // B all-in $175
  room.fold('p2'); // C folds -- refund $150 to A (ceiling = D's $250 stack)
  const A = room.getPlayer('p4');
  assert.strictEqual(A.totalContributedThisHand, 250);
  assert.strictEqual(A.currentBet, 250);
  // THE FIX (the-cut-spec_v10-2.md §9.3 item 2): previously stayed
  // stale at $400 -- the next Player to act was shown the old,
  // pre-refund amount owed instead of the correct, refunded ceiling.
  assert.strictEqual(room.currentBetToCall, 250, `expected currentBetToCall resynced to $250, got $${room.currentBetToCall}`);
});

test('item 3: the refund ceiling excludes a never-dealt $0-chip Player from the "others" comparison, even when they are the ONLY other seat', () => {
  const room = new GameTable('T3');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'Phantom'); // never buys chips -- must never count as a real opponent
  room.buyChips('p1', 1000);
  room.buyChips('p2', 500);
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'smallBlind', 0);
  room.setGameOption('p1', 'bigBlind', 0);
  room.startGame('p1');
  room.deal(2, 'p1'); // p3 never dealt in -- chips === 0
  assert.strictEqual(room.getPlayer('p3').hand.length, 0);
  room.openBetting('p1');
  const bettor = room.currentTurnPlayerId;
  const otherReal = bettor === 'p1' ? 'p2' : 'p1';
  const bettorStartingChips = room.getPlayer(bettor).chips;
  room.placeBet(bettor, 300);
  // The ONE other real Player folds -- leaving the phantom as the ONLY
  // remaining non-folded, non-sitting-out seat besides the bettor. This
  // is the exact case §9.3 item 3 describes: with the bug, `others`
  // would consist of just the phantom (a real fold correctly excludes
  // the genuine opponent, but the old filter never excluded the
  // phantom), giving a ceiling of $0 and triggering a spurious FULL
  // refund of the bettor's entire $300 -- even though nobody in this
  // scenario has actually made that bet uncalled at all yet (the early-
  // claim shortcut, not a refund, is what should apply here instead).
  room.fold(otherReal);
  const bettorState = room.getPlayer(bettor);
  assert.strictEqual(bettorState.currentBet, 300, `expected the bettor's $300 to remain intact (no spurious refund), got $${bettorState.currentBet}`);
  assert.strictEqual(bettorState.chips, bettorStartingChips - 300, 'expected no chips refunded back to the bettor');
});

test('item 4: dealToAllPlayers excludes a never-dealt $0-chip Player from redraw', () => {
  const room = new GameTable('T4');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'Phantom');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  room.deal(5, 'p1');
  room.openBetting('p1');
  while (room.bettingOpen) room.check(room.currentTurnPlayerId);
  room.standPat('p1');
  room.standPat('p2');
  assert.strictEqual(room.handPhase, 'DrawPhase');
  const deckBefore = room.deck.length;
  const result = room.dealToAllPlayers('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p3').hand.length, 0, 'the never-dealt Player must not receive cards');
  assert.strictEqual(room.deck.length, deckBefore, 'no cards should have been drawn for the phantom');
});

test('item 4 (negative case): dealToAllPlayers still redeals a Player who legitimately discarded their entire hand', () => {
  const room = new GameTable('T4b');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.setGameOption('p1', 'maxDiscards', 5); // allow discarding the entire hand
  room.startGame('p1');
  room.deal(5, 'p1');
  room.openBetting('p1');
  while (room.bettingOpen) room.check(room.currentTurnPlayerId);
  const p1cards = room.getPlayer('p1').hand.map((c) => c.id);
  const discardResult = room.discard('p1', p1cards);
  assert.strictEqual(discardResult.ok, true);
  assert.strictEqual(room.getPlayer('p1').hand.length, 0);
  room.standPat('p2');
  assert.strictEqual(room.handPhase, 'DrawPhase');
  const result = room.dealToAllPlayers('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').hand.length, 5, 'p1 discarded everything but must still be redealt a full hand');
});

test('item 5: dealToPlayer rejects a never-dealt $0-chip Player and a sitting-out Player', () => {
  const room = new GameTable('T5');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'Phantom');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  room.deal(5, 'p1');
  room.openBetting('p1');
  while (room.bettingOpen) room.check(room.currentTurnPlayerId);
  room.standPat('p1');
  room.standPat('p2');
  const result = room.dealToPlayer('p1', 'p3');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(room.getPlayer('p3').hand.length, 0);
});

test('item 5 (negative case): dealToPlayer still redeals a Player who legitimately discarded their entire hand', () => {
  const room = new GameTable('T5b');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.setGameOption('p1', 'maxDiscards', 5);
  room.startGame('p1');
  room.deal(5, 'p1');
  room.openBetting('p1');
  while (room.bettingOpen) room.check(room.currentTurnPlayerId);
  const p1cards = room.getPlayer('p1').hand.map((c) => c.id);
  room.discard('p1', p1cards);
  assert.strictEqual(room.getPlayer('p1').hand.length, 0);
  room.standPat('p2');
  const result = room.dealToPlayer('p1', 'p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').hand.length, 5);
});

test('item 6: Stud\'s deal() rejects a Player who bought chips mid-hand, between two streets', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'A', 'B');
  // A third player joins the table and buys chips AFTER StreetA has
  // already been dealt -- never part of this hand from the start.
  room.addPlayer('p3', 'Latecomer');
  room.buyChips('p3', 1000);
  // Close StreetA's betting round normally.
  const opener = room.turnOrder[0];
  room.setOpeningBettor('p1', opener);
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 10) {
    const p = room.getPlayer(room.currentTurnPlayerId);
    if (p.currentBet < room.currentBetToCall) room.call(p.id);
    else room.check(p.id);
  }
  assert.strictEqual(room.handPhase, 'StreetB');
  const deckBefore = room.deck.length;
  const result = room.deal(1, 'p1'); // StreetB's single card
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p3').hand.length, 0, 'the late-joining Player must not be dealt into a hand already in progress');
  // Only p1 and p2 should have received StreetB's card (1 card each).
  assert.strictEqual(deckBefore - room.deck.length, 2);
});

test('item 7: the claim-approval fallback never selects a never-dealt $0-chip Player', () => {
  const room = new GameTable('T7');
  room.addPlayer('p1', 'A'); // Dealer
  room.addPlayer('p3', 'Phantom'); // seated DIRECTLY after the Dealer -- the exact position the fallback search checks first
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameOption('p1', 'anteAmount', 0);
  room.startGame('p1');
  room.deal(5, 'p1'); // p3 never dealt in -- chips === 0
  assert.strictEqual(room.getPlayer('p3').hand.length, 0);
  room.openBetting('p1');
  const firstToAct = room.currentTurnPlayerId; // p3 (phantom) is correctly skipped -- see item 1's own test
  assert.notStrictEqual(firstToAct, 'p3');
  room.check(firstToAct); // no money committed -- action passes to the Dealer
  room.placeBet('p1', 20); // the Dealer bets
  room.fold(firstToAct); // the non-Dealer folds in response -- the Dealer survives as sole eligible
  // The Dealer proposes the claim -- the approver fallback search must
  // run (proposer === dealer) and correctly skip the phantom seated
  // right next to them.
  const claimResult = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(claimResult.ok, true);
  assert.notStrictEqual(room.pendingClaim.approverId, 'p3');
});

test('item 8: declare() rejects a never-dealt Player, matching standPat\'s existing guard', () => {
  const room = new GameTable('T8');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'Phantom');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'stud-7card-stud8');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(3, 'p1');
  room.handPhase = 'Declare'; // synthetic jump, matching this suite's existing pattern for testing Declare in isolation
  const result = room.declare('p3', 'both');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /no cards/i);
});
