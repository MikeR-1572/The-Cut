'use strict';

const { assert, test, tableWithPlayers } = require('./helpers');
const { GameTable } = require('../src/gameTable');

// ---------------------------------------------------------------
// v10.4: Standing Convention fix, Part E (Stud all-in lockup), and
// B.2's revert + replacement (the-cut-spec_v10-4.md). Table Owner
// Functions 1-3 themselves are unchanged from 10.3 and already covered
// in test/gameTable-10-3.test.js -- not duplicated here.
// ---------------------------------------------------------------

test('Standing Convention: canBuyChips (server-computed) agrees with buyChips() itself, in both directions', () => {
  const room = new GameTable('SC1');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'holdem-texas');
  room.startGame('p1');
  const owingPlayer = room.players.find((p) => p.oweAnte > 0);
  assert.ok(owingPlayer);

  // canBuyChips says false -> buyChips() itself must also reject.
  const stateBefore = room.toRedactedState(owingPlayer.id);
  const meBefore = stateBefore.players.find((p) => p.id === owingPlayer.id);
  assert.strictEqual(meBefore.canBuyChips, false);
  assert.strictEqual(room.buyChips(owingPlayer.id, 50).ok, false);

  // Advance past RequestAntes, then fold one Player to get a clean,
  // unambiguous non-pending Player (everyone else is pending right
  // after the deal, since they all hold live cards).
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1');
  room.openBetting('p1');
  const someoneId = room.currentTurnPlayerId;
  room.fold(someoneId);
  const stateAfter = room.toRedactedState(someoneId);
  const meAfter = stateAfter.players.find((p) => p.id === someoneId);
  assert.strictEqual(meAfter.canBuyChips, true);
  assert.strictEqual(room.buyChips(someoneId, 50).ok, true);
});

test('Part E: openBetting() skips Stud\'s opener requirement when nobody at the table can act, and the round auto-advances', () => {
  const room = new GameTable('E1');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B');
  room.addPlayer('p3', 'C');
  room.addPlayer('p4', 'D');
  for (const id of ['p1', 'p2', 'p3', 'p4']) room.buyChips(id, 30);
  room.setGameChoice('p1', 'stud-7card');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(3, 'p1');
  room.setOpeningBettor('p1', room.turnOrder[0]);
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) {
    const p = room.getPlayer(room.currentTurnPlayerId);
    if (p.chips > 0) room.allIn(p.id);
    else room.check(p.id);
  }
  assert.strictEqual(room.players.every((p) => p.allIn), true);
  room.deal(1, 'p1'); // B.1's fix -- 3rd Street's card reaches everyone
  assert.strictEqual(room.toRedactedState('p1').eligibleOpeningBettorIds.length, 0);
  assert.strictEqual(room.toRedactedState('p1').anyHandParticipantCanAct, false);

  const result = room.openBetting('p1');
  assert.strictEqual(result.ok, true, `expected the lockup to be bypassed, got: ${result.error}`);
  assert.strictEqual(room.bettingOpen, false, 'expected the round to auto-close (vacuous truth)');
  assert.strictEqual(room.handPhase, 'StreetC', 'expected the phase to auto-advance with no real betting');

  const announcements = room.drainAnnouncements().map((a) => a.text);
  assert.ok(announcements.some((t) => /no one can act/i.test(t)));
});

test('Part E: the normal Stud opener requirement is unaffected when at least one Player can still act', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.buyChips('p3', 1000);
  room.setGameChoice('p1', 'stud-7card');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(3, 'p1');
  // No opener selected -- everyone still has plenty of chips (can act) --
  // must still be rejected, exactly as before this version.
  const result = room.openBetting('p1');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /select an opening bettor/i);
});

test('B.2 (reverted): postAnteBlind flatly rejects a Player short of the full ante/blind, matching pre-10.3 behavior', () => {
  const room = new GameTable('B2R');
  room.addPlayer('p1', 'A');
  room.addPlayer('p2', 'B'); // short-stacked
  room.buyChips('p1', 1000);
  room.buyChips('p2', 3); // less than either blind
  room.setGameChoice('p1', 'holdem-texas');
  room.startGame('p1');
  const short = room.players.find((p) => p.oweAnte > p.chips);
  assert.ok(short, 'expected a genuinely short-stacked Player owing more than they have');
  const before = { chips: short.chips, oweAnte: short.oweAnte };
  const result = room.postAnteBlind(short.id);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(short.chips, before.chips, 'nothing should have been posted');
  assert.strictEqual(short.oweAnte, before.oweAnte);
  assert.strictEqual(short.allIn, false, 'must never go all-in via a partial post -- that mechanism is gone');
  assert.strictEqual(room.handPhase, 'RequestAntes', 'genuinely stuck -- exactly the case misdealStuckAntes() exists for');
});

test('B.2 (replacement): misdealStuckAntes is Dealer-level (not Table-Owner-only), gated to the genuinely stuck case', () => {
  const room = new GameTable('MD1');
  room.addPlayer('p1', 'A'); // Dealer
  room.addPlayer('p2', 'B');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'holdem-texas');
  room.startGame('p1');
  // Nobody is stuck yet -- reject.
  assert.strictEqual(room.misdealStuckAntes('p1').ok, false);
  assert.strictEqual(room.toRedactedState('p1').stuckAntePlayerIds.length, 0);
});

test('B.2 (replacement): misdealStuckAntes force-terminates and announces once a Player is genuinely stuck', () => {
  const room = new GameTable('MD2');
  room.addPlayer('p1', 'A'); // Dealer
  room.addPlayer('p2', 'B'); // will be stuck
  room.buyChips('p1', 1000);
  room.buyChips('p2', 3);
  room.setGameChoice('p1', 'holdem-texas');
  room.startGame('p1');
  const stuckIds = room.toRedactedState('p1').stuckAntePlayerIds;
  assert.strictEqual(stuckIds.length, 1);

  assert.strictEqual(room.misdealStuckAntes('p2').ok, false, 'non-Dealer rejected');

  const potBefore = room.pot;
  const result = room.misdealStuckAntes('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.handPhase, 'CycleComplete');
  assert.strictEqual(room.idle, true);
  assert.strictEqual(room.pot, potBefore, 'the misdeal itself moves no money -- same reset Function 1 uses');
  const announcements = room.drainAnnouncements().map((a) => a.text);
  assert.ok(announcements.some((t) => /misdeal/i.test(t) && t.includes('B')));
});
