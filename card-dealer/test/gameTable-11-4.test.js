'use strict';

const { assert, test, tableWithPlayers } = require('./helpers');

// ---------------------------------------------------------------
// v11.4: Client Heartbeat, Badge Ticker, Field Order, Uncallable-Bet
// Gating (the-cut-spec_v11-4.md). Parts A/B/C are almost entirely
// client.js/index.html, exercised by live_test_11_4.js and direct
// review -- this file covers Part D's GameTable-level logic.
// ---------------------------------------------------------------

test('11.4 Part D.2: the simplified "You must Check" message fires only when NO bet at all (not even $1) is possible', () => {
  const room = tableWithPlayers('A', 'B', 'C', 'D');
  for (const p of room.players) room.buyChips(p.id, 1000);
  for (const id of ['p1', 'p2', 'p3']) {
    const p = room.getPlayer(id);
    p.totalContributedThisHand = 100;
    p.bettingCapped = true;
    p.allIn = true;
    p.chips = 0;
  }
  const d = room.getPlayer('p4');
  d.totalContributedThisHand = 100; // already AT the ceiling -- not even $1 more is possible
  d.currentBet = 0;

  const result = room._validateBetOrRaise(d, 10);
  assert.strictEqual(result.ok, false);
  assert.ok(/You must Check/.test(result.error), `expected the simplified message, got: ${result.error}`);
});

test('11.4 Part D.2: the original All-In-suggesting message is kept when a SMALLER bet would still be legal', () => {
  const room = tableWithPlayers('A', 'B', 'C', 'D');
  for (const p of room.players) room.buyChips(p.id, 1000);
  for (const id of ['p1', 'p2', 'p3']) {
    const p = room.getPlayer(id);
    p.totalContributedThisHand = 100;
    p.bettingCapped = true;
    p.allIn = true;
    p.chips = 0;
  }
  const d = room.getPlayer('p4');
  d.totalContributedThisHand = 50; // $50 of headroom remains before hitting the $100 ceiling
  d.currentBet = 0;

  const result = room._validateBetOrRaise(d, 60); // tries to jump straight to $110 cumulative -- too much
  assert.strictEqual(result.ok, false);
  assert.ok(/use All-In/.test(result.error), `expected the original All-In-suggesting message, got: ${result.error}`);

  // Confirm a genuinely smaller bet (within the remaining headroom) is
  // still actually legal -- proves the message wasn't just optimistic.
  const smallerBet = room._validateBetOrRaise(d, 40); // cumulative would become $90, under the $100 ceiling
  assert.strictEqual(smallerBet.ok, true);
});

test('11.4 Part D.3: canBetOrRaise reflects the real check (GATE_BETTING_BUTTONS_WHEN_UNCALLABLE on, the shipped default)', () => {
  const room = tableWithPlayers('A', 'B', 'C', 'D');
  for (const p of room.players) room.buyChips(p.id, 1000);
  for (const id of ['p1', 'p2', 'p3']) {
    const p = room.getPlayer(id);
    p.totalContributedThisHand = 100;
    p.bettingCapped = true;
    p.allIn = true;
    p.chips = 0;
  }
  const d = room.getPlayer('p4');
  d.totalContributedThisHand = 100;
  d.currentBet = 0;

  assert.strictEqual(room._canBetOrRaise(d), false);
  const state = room.toRedactedState('p4');
  const dInState = state.players.find((p) => p.id === 'p4');
  assert.strictEqual(dInState.canBetOrRaise, false);

  // An ordinary player with real headroom should still read true.
  const a = room.getPlayer('p1');
  a.bettingCapped = false;
  a.allIn = false;
  a.chips = 900;
  a.totalContributedThisHand = 100;
  assert.strictEqual(room._canBetOrRaise(a), true);
});

test('11.4 Part D.3: canBetOrRaise reads true unconditionally when nobody else is in the hand (no ceiling to speak of)', () => {
  const room = tableWithPlayers('A', 'B');
  for (const p of room.players) room.buyChips(p.id, 1000);
  const a = room.getPlayer('p1');
  const b = room.getPlayer('p2');
  b.folded = true; // A is now the only remaining hand participant
  assert.strictEqual(room._canBetOrRaise(a), true);
});

test('11.4 Part D.3: _opponentCeiling() and _validateBetOrRaise() share the exact same computation as _canBetOrRaise() -- no drift between the reactive and proactive checks', () => {
  const room = tableWithPlayers('A', 'B', 'C');
  for (const p of room.players) room.buyChips(p.id, 1000);
  const b = room.getPlayer('p2');
  const c = room.getPlayer('p3');
  b.totalContributedThisHand = 200;
  b.bettingCapped = true;
  b.allIn = true;
  b.chips = 0;
  c.folded = true;
  const a = room.getPlayer('p1');
  a.totalContributedThisHand = 200;
  a.currentBet = 0;

  // Proactive query says no bet is possible...
  assert.strictEqual(room._canBetOrRaise(a), false);
  // ...and the reactive validator agrees on the exact same attempt.
  const reactive = room._validateBetOrRaise(a, 1);
  assert.strictEqual(reactive.ok, false);
});
