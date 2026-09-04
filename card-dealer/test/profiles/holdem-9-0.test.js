'use strict';

const { assert, test, tableWithPlayers } = require('../helpers');

// ---------------------------------------------------------------
// v9.0: Betting limits, side pots, and All-In (§6.10, §6.11)
// ---------------------------------------------------------------

/** Fresh Hold'em room with the given gameOptions overrides applied before startGame, dealt through to PreFlopBetting. */
function holdemRoomAtPreFlopBettingWithOptions(overrides, ...buyIns) {
  const names = buyIns.map((_, i) => `Player${i + 1}`);
  const room = tableWithPlayers(...names);
  buyIns.forEach((amount, i) => room.buyChips(`p${i + 1}`, amount));
  room.setGameChoice('p1', 'holdem-texas');
  for (const [key, value] of Object.entries(overrides || {})) room.setGameOption('p1', key, value);
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1');
  room.openBetting('p1');
  return room;
}

test('Minimum Raise (§6.10): max(opening bet, most recent raise), worked example -- BB $10, raise to $30, next min raise is to $50 not $40', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions({ smallBlind: 5, bigBlind: 10 }, 1000, 1000, 1000);
  assert.strictEqual(room.placeBet('p1', 30).ok, true); // raise +$20 over the $10 BB
  assert.strictEqual(room.placeBet('p2', 45).ok, false); // min next raise increment is $20 -> must reach $50
  assert.strictEqual(room.placeBet('p2', 50).ok, true);
});

test('No-Limit: a Bet/Raise that would commit the entire stack is rejected -- must use All-In instead (Option B)', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions({ smallBlind: 5, bigBlind: 10 }, 100, 1000, 1000);
  const result = room.placeBet('p1', 100); // p1's entire stack
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /All-In/);
});

test('No-Limit: Call that would commit the entire remaining stack is rejected -- must use All-In instead', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions({ smallBlind: 5, bigBlind: 10 }, 1000, 1000, 25);
  room.call('p1'); // UTG calls the $10 BB, turn -> p2
  room.placeBet('p2', 200); // p2 raises big, turn -> p3
  // p3 (BB, already $10 in, $15 chips left) owes $190 to call -- more than they have.
  const result = room.call('p3');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /All-In/);
  assert.strictEqual(room.allIn('p3').ok, true);
});

test('Pot-Limit worked example (§6.10): blinds $1/$2, pot $3 before UTG acts -- max raise to $7, not $5', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions(
    { bettingStructure: 'pot-limit', smallBlind: 1, bigBlind: 2 },
    1000,
    1000,
    1000
  );
  assert.strictEqual(room.pot, 3);
  assert.strictEqual(room.placeBet('p1', 8).ok, false); // over the true max
  assert.strictEqual(room.placeBet('p1', 7).ok, true);
});

test('Fixed-Limit: exact Small Bet/Big Bet sizing enforced, and the bet-plus-three-raises cap', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions(
    { bettingStructure: 'fixed-limit', smallBlind: 5, bigBlind: 10, raiseCap: 3 },
    1000,
    1000,
    1000
  );
  assert.strictEqual(room.placeBet('p1', 25).ok, false); // not an exact $10 raise
  assert.strictEqual(room.placeBet('p1', 20).ok, true); // raise 1: to $20
  assert.strictEqual(room.placeBet('p2', 30).ok, true); // raise 2
  assert.strictEqual(room.placeBet('p3', 40).ok, true); // raise 3 -- bet (BB) + 3 raises, cap reached
  assert.strictEqual(room.placeBet('p1', 50).ok, false); // 4th raise rejected
  assert.strictEqual(room.call('p1').ok, true); // call still allowed once capped
});

test('Fixed-Limit: raise cap is waived heads-up', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions(
    { bettingStructure: 'fixed-limit', smallBlind: 5, bigBlind: 10, raiseCap: 3 },
    1000,
    1000
  );
  // Heads-up: p1 is Dealer/Big Blind, p2 is Small Blind and acts first
  // pre-flop -- raiseCap should never block either of them regardless.
  assert.strictEqual(room.currentTurnPlayerId, 'p2');
  room.placeBet('p2', 20);
  room.placeBet('p1', 30);
  room.placeBet('p2', 40);
  room.placeBet('p1', 50);
  assert.strictEqual(room.placeBet('p2', 60).ok, true); // 5th raise, would be capped 3-handed, allowed heads-up
});

test('All-In (§6.11): commits the entire stack, sets the seat badge, excludes from further turn order', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions({ smallBlind: 5, bigBlind: 10 }, 30, 1000, 1000);
  assert.strictEqual(room.currentTurnPlayerId, 'p1');
  const result = room.allIn('p1');
  assert.strictEqual(result.ok, true);
  const p1 = room.getPlayer('p1');
  assert.strictEqual(p1.allIn, true);
  assert.strictEqual(p1.chips, 0);
  assert.strictEqual(p1.folded, false); // NOT folded -- still pot-eligible
  assert.notStrictEqual(room.currentTurnPlayerId, 'p1'); // moved on, p1 excluded from turn order
});

test('All-In: rejected for a player with no chips left', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions({ smallBlind: 5, bigBlind: 10 }, 30, 1000, 1000);
  room.allIn('p1');
  // simulate a later turn landing on p1 again is impossible via normal
  // flow (excluded from turn order), so call allIn() directly to confirm
  // the server-side guard independent of turn-order exclusion.
  const result = room.allIn('p1');
  assert.strictEqual(result.ok, false);
});

test('All-In: only available for Hold\'em', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(5, 'p1');
  room.openBetting('p1');
  assert.strictEqual(room.allIn('p1').ok, false);
});

test('Side Pots (§6.10): a short-stacked all-in called by a larger bet produces Main Pot + Side Pot 1 with correct amounts and eligibility', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions({ smallBlind: 5, bigBlind: 10 }, 30, 1000, 1000);
  room.allIn('p1'); // p1 (UTG) all-in for $30 total
  room.call('p2'); // p2 (SB, already $5 in) calls up to $30
  room.placeBet('p3', 100); // p3 (BB, already $10 in) raises to $100
  room.call('p2'); // p2 calls up to $100

  assert.strictEqual(room.pot, 230); // 30 + 100 + 100
  assert.notStrictEqual(room.pots, null);
  assert.strictEqual(room.pots.length, 2);
  const [main, side1] = room.pots;
  assert.strictEqual(main.id, 0);
  assert.strictEqual(main.label, 'Main Pot');
  assert.strictEqual(main.amount, 90); // 30 x 3 eligible contributors
  assert.deepStrictEqual(main.eligiblePlayerIds.sort(), ['p1', 'p2', 'p3']);
  assert.strictEqual(side1.id, 1);
  assert.strictEqual(side1.label, 'Side Pot 1');
  assert.strictEqual(side1.amount, 140); // (100-30) x 2 eligible contributors
  assert.deepStrictEqual(side1.eligiblePlayerIds.sort(), ['p2', 'p3']);
});

test('Side Pots: an ordinary hand with no uneven all-in never populates pots -- looks completely unchanged', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions({ smallBlind: 5, bigBlind: 10 }, 1000, 1000, 1000);
  room.call('p1');
  room.call('p2');
  room.check('p3');
  assert.strictEqual(room.pots, null);
});

test('Side Pots: Last-Pot-First claiming, each pot restricted to its own eligiblePlayerIds, hand only ends once every pot is claimed', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions({ smallBlind: 5, bigBlind: 10 }, 30, 1000, 1000);
  room.allIn('p1');
  room.call('p2');
  room.placeBet('p3', 100);
  room.call('p2');
  // Fast-forward to Showdown by checking around every remaining street --
  // p1 is all-in and excluded from turn order; only p2/p3 act.
  let guard = 0;
  while (room.handPhase !== 'Showdown' && guard++ < 30) {
    if (room.handPhase.endsWith('Betting')) {
      room.openBetting('p1');
      while (room.bettingOpen) room.check(room.currentTurnPlayerId);
    } else {
      room.dealCommunity('p1');
    }
  }
  assert.strictEqual(room.handPhase, 'Showdown');

  // p1 isn't eligible for Side Pot 1 (id 1, the higher id -- claimed first).
  assert.strictEqual(room.claimPot('p1', [{ playerId: 'p1', amount: 140 }]).ok, false);
  assert.strictEqual(room.claimPot('p2', [{ playerId: 'p2', amount: 140 }]).ok, true);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.handPhase, 'Showdown'); // hand not over yet -- Main Pot still unclaimed
  assert.strictEqual(room.pots[1].claimed, true);
  assert.strictEqual(room.pots[0].claimed, false);

  assert.strictEqual(room.claimPot('p1', [{ playerId: 'p1', amount: 90 }]).ok, true);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.handPhase, 'CycleComplete'); // now the hand fully resolves
  assert.strictEqual(room.pot, 0);
  assert.strictEqual(room.getPlayer('p1').allIn, false); // cleared for next hand
});

test('CHANGED 9.1: a fold that would have left a tier with exactly one eligible player instead triggers a refund first, correctly collapsing the tier rather than leaving a premature early-claim opportunity', () => {
  // Under the pre-9.1 rules this scenario produced a genuine Side Pot 1
  // with p3 as its sole eligible player, claimable via the early-claim
  // shortcut before Showdown. Under the corrected 9.1 refund rule, the
  // SAME fold that would reduce a tier to one eligible player also
  // always reveals that the excess above the next-highest ceiling was
  // never genuinely covered -- so it refunds first, converging p3's
  // total down to exactly match p1's all-in threshold and collapsing
  // what would have been Side Pot 1 entirely. This is a deliberate,
  // fixture-verified consequence of the refund rule, not a bug.
  const room = holdemRoomAtPreFlopBettingWithOptions({ smallBlind: 5, bigBlind: 10 }, 30, 1000, 1000);
  room.allIn('p1'); // p1 all-in $30
  room.call('p2'); // p2 calls to $30
  room.placeBet('p3', 100); // p3 raises to $100 -- legal at the time (p2 could still cover it)
  room.fold('p2'); // p2 folds facing the raise -- the moment p3's excess above p1's $30 becomes uncallable
  assert.strictEqual(room.pots, null); // no genuine split remains -- p3's total converged to p1's $30
  assert.strictEqual(room.getPlayer('p3').totalContributedThisHand, 30);
  assert.strictEqual(room.getPlayer('p3').chips, 970); // 1000 - 100 + 70 refunded
  assert.strictEqual(room.getPlayer('p3').bettingCapped, true);
  assert.strictEqual(room.getPlayer('p3').allIn, false); // never was all-in in the first place -- Scenario A/B's exact pattern
});

test('Folding removes eligibility for every pot, including ones already contributed to before folding -- verified with a genuine, still-uneven multi-tier pot (a third covering player prevents the refund from collapsing it)', () => {
  const room = holdemRoomAtPreFlopBettingWithOptions({ smallBlind: 5, bigBlind: 10 }, 30, 1000, 1000, 1000);
  // 4 players: p1 Dealer, p2 SB, p3 BB, p4 UTG -- UTG acts first pre-flop.
  room.call('p4'); // p4 calls the BB
  room.allIn('p1'); // p1 all-in $30 (a raise over the $10 BB)
  room.call('p2'); // p2 calls to $30
  room.call('p3'); // p3 calls to $30
  room.placeBet('p4', 100); // p4 (already acted, action reopened by the raise) raises to $100
  room.fold('p2'); // p2 folds facing the $100 -- p3 still hasn't acted on it yet, but has ample chips, so no refund fires
  assert.notStrictEqual(room.pots, null);
  const main = room.pots.find((p) => p.id === 0);
  assert.strictEqual(main.eligiblePlayerIds.includes('p2'), false); // folded -- money stays in, can't win it
  assert.strictEqual(main.eligiblePlayerIds.includes('p1'), true);
  const side1 = room.pots.find((p) => p.id === 1);
  assert.deepStrictEqual(side1.eligiblePlayerIds.sort(), ['p4']); // only p4 has reached $100 so far -- p3 hasn't called yet
  assert.strictEqual(room.getPlayer('p4').bettingCapped, false); // not refunded -- p3's remaining chips still cover it
  room.call('p3'); // p3 completes the call to $100
  const side1After = room.pots.find((p) => p.id === 1);
  assert.deepStrictEqual(side1After.eligiblePlayerIds.sort(), ['p3', 'p4']); // now a genuine, still-uncollapsed two-eligible-player tier
});
