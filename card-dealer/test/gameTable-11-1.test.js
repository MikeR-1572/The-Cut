'use strict';

const { assert, test, tableWithPlayers } = require('./helpers');

// ---------------------------------------------------------------
// v11.1: Table Owner Testing Tools (the-cut-spec_v11-1.md). Only the
// GameTable-level authorization/state-computation is covered here --
// Capability 1's actual socket termination lives in server.js and isn't
// exercised by this pure-engine suite (see live_test_11_1.js).
// ---------------------------------------------------------------

test('11.1 Capability 1: canForceDisconnect() is Table-Owner-only', () => {
  const room = tableWithPlayers('A', 'B');
  assert.strictEqual(room.canForceDisconnect('p2', 'p1').ok, false);
});

test('11.1 Capability 1: canForceDisconnect() rejects an unknown or already-disconnected target', () => {
  const room = tableWithPlayers('A', 'B');
  assert.strictEqual(room.canForceDisconnect('p1', 'nope').ok, false);
  room.markDisconnected('p2');
  assert.strictEqual(room.canForceDisconnect('p1', 'p2').ok, false);
});

test('11.1 Capability 1: canForceDisconnect() allows targeting any currently-connected seated player, Dealer or Table Owner themselves included', () => {
  const room = tableWithPlayers('A', 'B', 'C');
  assert.strictEqual(room.canForceDisconnect('p1', 'p2').ok, true); // ordinary player
  assert.strictEqual(room.canForceDisconnect('p1', 'p1').ok, true); // the Dealer AND the Table Owner, same person here
});

test('11.1 Capability 2: forceInactivityWarning() is Table-Owner-only', () => {
  const room = tableWithPlayers('A', 'B');
  assert.strictEqual(room.forceInactivityWarning('p2').ok, false);
});

test('11.1 Capability 2: forceInactivityWarning() jumps tableCloseAt to exactly ~5 minutes out, using the REAL field every other consumer reads', () => {
  const room = tableWithPlayers('A', 'B');
  const result = room.forceInactivityWarning('p1');
  assert.strictEqual(result.ok, true);
  const tableCloseAt = room.toRedactedState('p1').tableCloseAt;
  const msRemaining = tableCloseAt - Date.now();
  assert.ok(Math.abs(msRemaining - 5 * 60 * 1000) < 2000, 'expected tableCloseAt to land within ~5 minutes of now');
});

test('11.1 Capability 2: real activity after Force Timeout to T-5 still resets the clock normally, same as production', () => {
  const room = tableWithPlayers('A', 'B');
  room.forceInactivityWarning('p1');
  const closeAtAfterForce = room.toRedactedState('p1').tableCloseAt;
  room.touchActivity(); // simulates any real action resetting the clock
  const closeAtAfterActivity = room.toRedactedState('p1').tableCloseAt;
  assert.ok(closeAtAfterActivity > closeAtAfterForce);
});
