'use strict';

const { assert, test, tableWithPlayers } = require('./helpers');

// ---------------------------------------------------------------
// v11.3: Reconnect Resilience, Landing-Page Socket Robustness, Code
// Alphabet Fix (the-cut-spec_v11-3.md). Part A/B are almost entirely
// client.js/server.js wiring, exercised by live_test_11_3.js -- this
// file covers what's testable at the pure-GameTable level: Part C's
// alphabet, and the Part A.8 rate-limiter correction's own
// GameTable-level contract (a valid-but-mistimed code must be
// distinguishable from a genuinely wrong one).
// ---------------------------------------------------------------

test('11.3 Part C: reconnect codes never contain 0 (zero) or O (letter O)', () => {
  const room = tableWithPlayers('A', 'B', 'C', 'D', 'E');
  for (const p of room.players) {
    assert.ok(!p.reconnectCode.includes('0'), `code ${p.reconnectCode} contains 0`);
    assert.ok(!p.reconnectCode.includes('O'), `code ${p.reconnectCode} contains O`);
    assert.strictEqual(p.reconnectCode.length, 6);
  }
});

test("11.3 Part A.8: reconnectPlayer() distinguishes \"no such code\" from \"correct code, bad timing\" -- the contract server.js's rate limiter correction relies on", () => {
  const room = tableWithPlayers('A', 'B');
  // Case 1: a code that matches nobody at all -- SHOULD count against
  // the per-IP limiter (genuine guessing).
  const noMatch = room.reconnectPlayer('ZZZZZZ');
  assert.strictEqual(noMatch.ok, false);
  assert.strictEqual(noMatch.codeMatchedNoPlayer, true);

  // Case 2: a genuinely correct code, rejected only because that Player
  // is already connected (bad timing / already-reconnected / the
  // multi-device rule) -- must NOT count against the limiter.
  const stillConnectedCode = room.getPlayer('p2').reconnectCode;
  const badTiming = room.reconnectPlayer(stillConnectedCode);
  assert.strictEqual(badTiming.ok, false);
  assert.strictEqual(badTiming.codeMatchedNoPlayer, false);
});
