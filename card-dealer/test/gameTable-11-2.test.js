'use strict';

const { assert, test, tableWithPlayers } = require('./helpers');

// ---------------------------------------------------------------
// v11.2: Table Owner Function Fixes, Host rename, two corrections
// (the-cut-spec_v11-2.md). Every fix traced to a confirmed root cause
// directly in the v11.1 code before being written up in the spec.
// ---------------------------------------------------------------

test('11.2 Fix 1: _preGameSnapshot is captured on a genuine new Cycle, NOT recaptured on a re-ante hand within the same Cycle', () => {
  const room = tableWithPlayers('A', 'B', 'C');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'draw-5card-jacks'); // reAnteable
  room.startGame('p1'); // hand 1 of a genuine new cycle -- clearFolded: true
  const snapshotAfterHand1Start = room._preGameSnapshot;
  assert.ok(snapshotAfterHand1Start, 'expected a snapshot to exist after the first hand of a new cycle starts');

  // Simulate hand 1 carrying an ante into the pot, then a re-ante New
  // Hand within the SAME cycle (clearFolded: false) -- exactly the
  // shape Fix 1 describes: a cycle spanning more than one hand.
  room.pot = 20; // stand-in for hand 1's already-posted, carried-forward antes
  room._enterRequestAntes(false); // New Hand mid-cycle, same as the reAnteable "nobody opened" / Showdown-continuation path

  assert.strictEqual(room._preGameSnapshot, snapshotAfterHand1Start, 'the mid-cycle re-ante hand must NOT overwrite the true start-of-cycle snapshot');
});

test('11.2 Fix 1: restorePlayerStacks() mid-cycle restores to the CYCLE start, not the most recent hand, and updates its own message wording', () => {
  const room = tableWithPlayers('A', 'B', 'C');
  for (const p of room.players) room.buyChips(p.id, 1000);
  const startOfCycleChips = room.getPlayer('p1').chips;
  room.setGameChoice('p1', 'draw-5card-jacks');
  room.startGame('p1');
  // Hand 1: p1 posts an ante, reducing their own chips -- if the bug were
  // still present, THIS post-hand-1 state is what a mid-cycle Restore
  // would incorrectly snap back to instead of the true cycle start.
  if (room.getPlayer('p1').oweAnte > 0) room.postAnteBlind('p1');
  const chipsAfterHand1Ante = room.getPlayer('p1').chips;
  assert.ok(chipsAfterHand1Ante < startOfCycleChips, 'expected the ante post to actually reduce p1\'s chips');

  room._enterRequestAntes(false); // re-ante hand 2, same cycle

  const result = room.restorePlayerStacks(room.creatorId);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').chips, startOfCycleChips, 'Restore Stacks should return p1 to the true start-of-CYCLE chip count, not hand 2\'s own (already-reduced) snapshot');

  const announcements = room.drainAnnouncements();
  assert.ok(announcements.some((a) => /start of the current cycle/.test(a.text)), 'expected the corrected "start of the current cycle" wording');
  assert.ok(announcements.some((a) => /The Host/.test(a.text)), 'expected the Host rename (Fix 4) in this announcement');
});

test('11.2 Fix 2: a stale ante obligation does not survive Terminate Cleanly -- postAnteBlind() is rejected afterward', () => {
  const room = tableWithPlayers('A', 'B', 'C');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'holdem-texas');
  room.startGame('p1');
  const owingPlayer = room.players.find((p) => p.oweAnte > 0);
  assert.ok(owingPlayer, 'expected someone to owe an ante/blind pre-flop');
  room.terminateGameCleanly(room.creatorId);
  assert.strictEqual(owingPlayer.oweAnte, 0, 'oweAnte must be reset by _performFullReset() after termination');
  const postResult = room.postAnteBlind(owingPlayer.id);
  assert.strictEqual(postResult.ok, false, 'posting an ante should be rejected once the table is idle/terminated');
});

test('11.2 Fix 4: Host rename -- Table-Owner-only rejection messages say "Host", not "Table Owner"', () => {
  const room = tableWithPlayers('A', 'B');
  const rejections = [
    room.setReconnectTimeout('p2', 30).error,
    room.removePlayerFromTable('p2', 'p1', 'foldAndLeave').error,
    room.endGame('p2').error,
    room.restartActivityClock('p2').error,
    room.canForceDisconnect('p2', 'p1').error,
    room.terminateGameCleanly('p2').error,
    room.restorePlayerStacks('p2').error,
  ];
  for (const message of rejections) {
    assert.ok(/Host/.test(message), `expected "Host" in rejection message, got: ${message}`);
    assert.ok(!/Table Owner/.test(message), `expected NO "Table Owner" in a player-facing message, got: ${message}`);
  }
});

test('11.2 Fix 3: a Bet/Raise that no remaining opponent could ever call is rejected, even across multiple streets (not just the first)', () => {
  // Direct reproduction, matching the exact live-confirmed shape: three
  // players already all-in and capped at $100 total from an EARLIER
  // street; the sole remaining player (also at $100 cumulative already)
  // proposes a further $10 bet on a LATER street. Before this fix, the
  // proactive cap compared the raw, street-local $10 against the
  // cumulative $100 ceiling and incorrectly allowed it -- a bet nobody
  // could ever call, which would have created an uncallable side pot.
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
  d.totalContributedThisHand = 100; // matched everyone through the earlier street
  d.currentBet = 0; // fresh, later street

  const result = room._validateBetOrRaise(d, 10);
  assert.strictEqual(result.ok, false, 'a bet nobody could call should be rejected outright, not accepted into an uncallable side pot');
});

test('11.2 Fix 3: an ordinary, genuinely callable Bet/Raise on a later street still works correctly (the fix isn\'t overly strict)', () => {
  const room = tableWithPlayers('A', 'B');
  for (const p of room.players) room.buyChips(p.id, 1000);
  const a = room.getPlayer('p1');
  const b = room.getPlayer('p2');
  a.totalContributedThisHand = 50;
  b.totalContributedThisHand = 50;
  a.currentBet = 0; // fresh later street
  // b can still cover well beyond this -- b.chips is still 950, so
  // b's own ceiling contribution is totalContributedThisHand + chips = 1000.
  const result = room._validateBetOrRaise(a, 100);
  assert.strictEqual(result.ok, true, 'a genuinely callable bet on a later street should still be allowed');
});

test('11.2 Fix 6: the \'joined\' payload distinguishes a reconnect from a genuine join/create -- GameTable-level methods return enough for server.js to set isReconnect correctly', () => {
  const room = tableWithPlayers('A', 'B');
  // reconnectPlayer() succeeding is the ONLY case server.js should mark
  // isReconnect: true for -- addPlayer() (create/join) is the other, and
  // is never confused with a reconnect since it's a structurally
  // different call entirely. This test pins the contract server.js
  // relies on: reconnectPlayer()'s ok:true result is unambiguous.
  room.markDisconnected('p2');
  const result = room.reconnectPlayer(room.getPlayer('p2').reconnectCode);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.playerId, 'p2');
});
