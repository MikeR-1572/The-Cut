'use strict';

const { assert, test } = require('../helpers');
const { GameTable } = require('../../src/gameTable');

// ---------------------------------------------------------------
// v9.1: Side-pot Bug 1/Bug 2 fixes, the uncalled-bet refund rule,
// and the raiseCap/bettingStructure dependency -- verified directly
// against side-pot-scenario-reference.md (27-action fixture) and
// refund-scenario-reference.md (four scenarios, A-D).
// ---------------------------------------------------------------

function zeroBlindRoom(...buyIns) {
  const room = new GameTable('T1');
  buyIns.forEach((amount, i) => {
    room.addPlayer(`p${i + 1}`, `Player${i + 1}`);
    room.buyChips(`p${i + 1}`, amount);
  });
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'smallBlind', 0);
  room.setGameOption('p1', 'bigBlind', 0);
  room.startGame('p1');
  room.deal(2, 'p1');
  room.openBetting('p1');
  return room;
}

test('BUG FIX 9.1: a Hold\'em table with both blinds set to $0 no longer hangs forever at RequestAntes', () => {
  const room = zeroBlindRoom(500, 175, 400, 250);
  assert.strictEqual(room.handPhase, 'PreFlopBetting');
});

test('BUG FIX 9.1: post-flop turn anchor now correctly skips all-in/bettingCapped seats, not just folded/sittingOut -- previously could permanently strand a round on a seat that could never act', () => {
  const room = zeroBlindRoom(500, 175, 400, 250);
  const utg = room.currentTurnPlayerId;
  room.allIn(utg); // UTG goes all-in as the very first action
  // Everyone else folds around them, closing PreFlop; deal the Flop and
  // reopen betting -- the anchor selection used to blindly pick the
  // seat after the (now all-in) Dealer/BB reference without checking
  // whether THAT seat could actually act either.
  const others = room.players.filter((p) => p.id !== utg).map((p) => p.id);
  for (const id of others.slice(0, -1)) room.fold(id);
  room.call(others[others.length - 1]);
  room.dealCommunity('p1');
  room.openBetting('p1');
  const turnPlayer = room.getPlayer(room.currentTurnPlayerId);
  assert.strictEqual(turnPlayer.folded, false);
  assert.strictEqual(turnPlayer.allIn, false);
  assert.strictEqual(turnPlayer.bettingCapped, false);
});

// ---------------------------------------------------------------
// side-pot-scenario-reference.md -- full 27-action fixture, all six
// players (A-F), verified exactly against the doc's own Final
// Showdown and Reconciliation tables.
// ---------------------------------------------------------------
test('side-pot-scenario-reference.md: full 27-action fixture matches exactly, every tier and every reconciled stack', () => {
  const room = new GameTable('T1');
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((name, i) => {
    room.addPlayer(`p${i + 1}`, name);
  });
  room.buyChips('p1', 600); // A, Dealer
  room.buyChips('p2', 125); // B, Small Blind
  room.buyChips('p3', 400); // C, Big Blind
  room.buyChips('p4', 25); // D, UTG
  room.buyChips('p5', 500); // E
  room.buyChips('p6', 300); // F
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'smallBlind', 5);
  room.setGameOption('p1', 'bigBlind', 10);
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1');
  room.openBetting('p1');

  // Pre-Flop
  assert.strictEqual(room.allIn('p4').ok, true); // D all-in $25
  assert.strictEqual(room.pot, 40);
  assert.strictEqual(room.call('p5').ok, true); // E calls $25
  assert.strictEqual(room.placeBet('p6', 50).ok, true); // F raises to $50
  assert.strictEqual(room.pots.find((t) => t.id === 1).amount, 25);
  assert.strictEqual(room.call('p1').ok, true); // A calls $50
  assert.strictEqual(room.call('p2').ok, true); // B calls $50
  assert.strictEqual(room.call('p3').ok, true); // C calls $50
  assert.strictEqual(room.call('p5').ok, true); // E calls $50
  assert.strictEqual(room.pots.find((t) => t.id === 0).amount, 150);
  assert.strictEqual(room.pots.find((t) => t.id === 1).amount, 125);
  assert.strictEqual(room.handPhase, 'Flop');

  // Flop
  room.dealCommunity('p1');
  room.openBetting('p1');
  room.check('p2');
  room.check('p3');
  room.placeBet('p5', 25); // E bets $25
  room.call('p6'); // F calls
  room.call('p1'); // A calls
  room.call('p2'); // B calls
  room.fold('p3'); // C folds
  assert.strictEqual(room.pots.find((t) => t.id === 0).amount, 150);
  assert.strictEqual(room.pots.find((t) => t.id === 1).amount, 225);
  assert.strictEqual(room.pots.find((t) => t.id === 1).eligiblePlayerIds.includes('p3'), false); // C folded -- excluded from eligibility everywhere, even the Main Pot
  assert.strictEqual(room.handPhase, 'Turn');

  // Turn
  room.dealCommunity('p1');
  room.openBetting('p1');
  room.check('p2');
  room.placeBet('p5', 25); // E opens $25
  room.call('p6'); // F calls
  room.placeBet('p1', 75); // A raises to street-bet $75 (cumulative $150)
  room.allIn('p2'); // B all-in for $50 more (cumulative $125)
  room.call('p5'); // E calls to $150
  room.call('p6'); // F calls to $150
  assert.strictEqual(room.pots.find((t) => t.id === 0).amount, 150);
  assert.strictEqual(room.pots.find((t) => t.id === 1).amount, 425);
  assert.strictEqual(room.pots.find((t) => t.id === 2).amount, 75);
  assert.strictEqual(room.handPhase, 'River');

  // River
  room.dealCommunity('p1');
  room.openBetting('p1');
  room.placeBet('p5', 50); // E opens street-bet $50 (cumulative $200)
  room.allIn('p6'); // F all-in for $150 more (cumulative $300)
  room.placeBet('p1', 350); // A raises to street-bet $350 (cumulative $500)
  room.allIn('p5'); // E all-in for $300 more (cumulative $500)
  assert.strictEqual(room.handPhase, 'Showdown');

  // Final Showdown -- exact match against the fixture's own table
  const [main, side1, side2, side3] = room.pots;
  assert.strictEqual(main.amount, 150);
  assert.deepStrictEqual(main.eligiblePlayerIds.sort(), ['p1', 'p2', 'p4', 'p5', 'p6']);
  assert.strictEqual(side1.amount, 425);
  assert.deepStrictEqual(side1.eligiblePlayerIds.sort(), ['p1', 'p2', 'p5', 'p6']);
  assert.strictEqual(side2.amount, 525);
  assert.deepStrictEqual(side2.eligiblePlayerIds.sort(), ['p1', 'p5', 'p6']);
  assert.strictEqual(side3.amount, 400);
  assert.deepStrictEqual(side3.eligiblePlayerIds.sort(), ['p1', 'p5']);
  assert.strictEqual(room.pot, 1500);

  // Reconciliation
  const byId = Object.fromEntries(room.players.map((p) => [p.id, p]));
  assert.strictEqual(byId.p1.chips, 100);
  assert.strictEqual(byId.p1.totalContributedThisHand, 500);
  assert.strictEqual(byId.p2.chips, 0);
  assert.strictEqual(byId.p2.totalContributedThisHand, 125);
  assert.strictEqual(byId.p3.chips, 350);
  assert.strictEqual(byId.p3.totalContributedThisHand, 50);
  assert.strictEqual(byId.p4.chips, 0);
  assert.strictEqual(byId.p4.totalContributedThisHand, 25);
  assert.strictEqual(byId.p5.chips, 0);
  assert.strictEqual(byId.p5.totalContributedThisHand, 500);
  assert.strictEqual(byId.p6.chips, 0);
  assert.strictEqual(byId.p6.totalContributedThisHand, 300);
});

// ---------------------------------------------------------------
// refund-scenario-reference.md -- Scenarios A-D, verified exactly.
// No blinds/antes modeled (matching the fixture); turn order for N
// players is UTG-first, so player letters are mapped to seats by
// ACTUAL turn order, not seating order -- see each scenario's own
// comment for the mapping used.
// ---------------------------------------------------------------

test('Refund Scenario A: one refund, no pot eliminated', () => {
  // 4 players -- turn order is UTG, Dealer, SB, BB. Mapped so p4 acts
  // first (fixture's "A"): A=p4($500), B=p1($175), C=p2($400), D=p3($250).
  const room = zeroBlindRoom(175, 400, 250, 500);
  assert.strictEqual(room.currentTurnPlayerId, 'p4');
  room.placeBet('p4', 400); // A bets $400
  room.allIn('p1'); // B all-in $175
  room.fold('p2'); // C folds -- refund $150 to A
  const A = room.getPlayer('p4');
  assert.strictEqual(A.totalContributedThisHand, 250);
  assert.strictEqual(A.chips, 250);
  assert.strictEqual(A.bettingCapped, true);
  assert.strictEqual(A.allIn, false); // never was all-in -- Scenario A/B's exact point
  room.allIn('p3'); // D all-in $250
  assert.strictEqual(room.pot, 675);
  const [main, side1] = room.pots;
  assert.strictEqual(main.amount, 525);
  assert.deepStrictEqual(main.eligiblePlayerIds.sort(), ['p1', 'p3', 'p4']);
  assert.strictEqual(side1.amount, 150);
  assert.deepStrictEqual(side1.eligiblePlayerIds.sort(), ['p3', 'p4']);
});

test('Refund Scenario B: two refunds, a side pot eliminated entirely', () => {
  const room = zeroBlindRoom(175, 400, 250, 500);
  room.placeBet('p4', 400); // A bets $400
  room.allIn('p1'); // B all-in $175
  room.fold('p2'); // C folds -- refund $150 to A
  room.fold('p3'); // D folds too -- a SECOND, independent refund of $75 to A
  const A = room.getPlayer('p4');
  assert.strictEqual(A.totalContributedThisHand, 175); // exactly matches B's all-in amount
  assert.strictEqual(A.chips, 325);
  assert.strictEqual(A.bettingCapped, true);
  assert.strictEqual(room.pot, 350);
  // The provisional side pot doesn't shrink to $0 -- it stops existing.
  assert.strictEqual(room.pots, null);
});

test('Refund Scenario C: a genuinely all-in player\'s allIn flag clears on refund, but bettingCapped keeps them out of turn order for good', () => {
  // A=p4($400, genuinely all-in this time), B=p1($175), C=p2($500), D=p3($250).
  const room = zeroBlindRoom(175, 500, 250, 400);
  room.allIn('p4'); // A all-in $400
  room.allIn('p1'); // B all-in $175
  room.fold('p2'); // C folds -- refund $150 to A (ceiling = D's $250 stack)
  const A = room.getPlayer('p4');
  assert.strictEqual(A.totalContributedThisHand, 250);
  assert.strictEqual(A.chips, 150);
  assert.strictEqual(A.allIn, false); // clears -- A visibly has $150 in front of them now
  assert.strictEqual(A.bettingCapped, true); // but can never act again regardless
  room.allIn('p3'); // D all-in $250
  assert.strictEqual(room.pot, 675);
  const [main, side1] = room.pots;
  assert.strictEqual(main.amount, 525);
  assert.deepStrictEqual(main.eligiblePlayerIds.sort(), ['p1', 'p3', 'p4']);
  assert.strictEqual(side1.amount, 150);
  assert.deepStrictEqual(side1.eligiblePlayerIds.sort(), ['p3', 'p4']);
});

test('Refund Scenario D: a second cascading refund correctly re-targets the next-highest remaining ceiling, even after allIn already cleared from the first', () => {
  // 5 players, turn order UTG,+1,+2,+3,+4 -- mapped so seat order is
  // A=p4($400), B=p5($175), C=p1($500), D=p2($250), E=p3($225).
  const room = zeroBlindRoom(500, 250, 225, 400, 175);
  assert.strictEqual(room.currentTurnPlayerId, 'p4');
  room.allIn('p4'); // A all-in $400
  room.allIn('p5'); // B all-in $175
  room.fold('p1'); // C folds -- refund $150 to A (ceiling = D's $250)
  const A = room.getPlayer('p4');
  assert.strictEqual(A.totalContributedThisHand, 250);
  assert.strictEqual(A.bettingCapped, true);
  room.fold('p2'); // D folds too -- SECOND refund of $25 to A (ceiling now = E's $225)
  assert.strictEqual(A.totalContributedThisHand, 225);
  assert.strictEqual(A.chips, 175);
  assert.strictEqual(A.bettingCapped, true); // was already true -- stays true
  room.allIn('p3'); // E all-in $225
  assert.strictEqual(room.pot, 625);
  const [main, side1] = room.pots;
  assert.strictEqual(main.amount, 525);
  assert.deepStrictEqual(main.eligiblePlayerIds.sort(), ['p3', 'p4', 'p5']);
  assert.strictEqual(side1.amount, 100);
  assert.deepStrictEqual(side1.eligiblePlayerIds.sort(), ['p3', 'p4']);
});

// ---------------------------------------------------------------
// The new proactive opponent-ceiling cap on Bet/Raise (prevents the
// excess from ever being created for a VOLUNTARY bet -- All-In stays
// exempt, since committing beyond what anyone can cover is exactly
// what it's for).
// ---------------------------------------------------------------
test('NEW 9.1: a voluntary Bet/Raise is rejected outright if it would exceed what any remaining opponent could ever cover', () => {
  const room = zeroBlindRoom(1000, 100, 50); // p1 huge stack, p2 $100, p3 $50 -- turn order p1 first (3-handed, UTG=p1... verify)
  // Whoever acts first, try to bet far beyond both opponents' combined ceiling.
  const actor = room.currentTurnPlayerId;
  const result = room.placeBet(actor, 500);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /No remaining player could cover/);
});

test('NEW 9.1: All-In stays exempt from the opponent-ceiling cap -- committing beyond what anyone can cover is exactly what it is for', () => {
  const room = zeroBlindRoom(1000, 100, 50);
  const actor = room.currentTurnPlayerId;
  // A huge stack going all-in is legal even though nobody can cover it --
  // the refund rule (not a rejection) is what corrects this afterward.
  assert.strictEqual(room.allIn(actor).ok, true);
});

// ---------------------------------------------------------------
// raiseCap / bettingStructure dependency (§3, NEW 9.1)
// ---------------------------------------------------------------
test('raiseCap auto-resets to the new structure default every time bettingStructure changes', () => {
  const room = new GameTable('T1');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'holdem-texas');
  assert.strictEqual(room.gameOptions.bettingStructure, 'no-limit');
  assert.strictEqual(room.gameOptions.raiseCap, 'no-cap'); // default under No-Limit

  room.setGameOption('p1', 'bettingStructure', 'pot-limit');
  assert.strictEqual(room.gameOptions.raiseCap, 3); // auto-reset to the active default

  room.setGameOption('p1', 'raiseCap', 5); // Dealer customizes it
  assert.strictEqual(room.gameOptions.raiseCap, 5);

  room.setGameOption('p1', 'bettingStructure', 'no-limit');
  assert.strictEqual(room.gameOptions.raiseCap, 'no-cap'); // switching back resets again -- no stale value lingers

  room.setGameOption('p1', 'bettingStructure', 'fixed-limit');
  assert.strictEqual(room.gameOptions.raiseCap, 3);
});

test('raiseCap accepts either a positive integer or the literal string "no-cap"', () => {
  const room = new GameTable('T1');
  room.addPlayer('p1', 'A');
  room.buyChips('p1', 1000);
  room.setGameChoice('p1', 'holdem-texas');
  assert.strictEqual(room.setGameOption('p1', 'raiseCap', 'no-cap').ok, true);
  assert.strictEqual(room.gameOptions.raiseCap, 'no-cap');
  assert.strictEqual(room.setGameOption('p1', 'raiseCap', 7).ok, true);
  assert.strictEqual(room.gameOptions.raiseCap, 7);
  assert.strictEqual(room.setGameOption('p1', 'raiseCap', 0).ok, false);
  assert.strictEqual(room.setGameOption('p1', 'raiseCap', 'garbage').ok, false);
});

test('raiseCap now also applies under Pot-Limit, extended from Fixed-Limit-only', () => {
  const room = new GameTable('T1');
  ['p1', 'p2', 'p3'].forEach((id, i) => {
    room.addPlayer(id, `Player${i + 1}`);
    room.buyChips(id, 1000);
  });
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'smallBlind', 1);
  room.setGameOption('p1', 'bigBlind', 2);
  room.setGameOption('p1', 'bettingStructure', 'pot-limit');
  room.setGameOption('p1', 'raiseCap', 2);
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1');
  room.openBetting('p1');
  const first = room.currentTurnPlayerId;
  assert.strictEqual(room.placeBet(first, 6).ok, true); // raise 1
  const second = room.currentTurnPlayerId;
  assert.strictEqual(room.placeBet(second, 16).ok, true); // raise 2 -- cap reached
  const third = room.currentTurnPlayerId;
  const blocked = room.placeBet(third, 40); // raise 3 -- should be rejected
  assert.strictEqual(blocked.ok, false);
  assert.match(blocked.error, /Pot-Limit raise cap reached/);
  assert.strictEqual(room.call(third).ok, true); // call still allowed once capped
});
