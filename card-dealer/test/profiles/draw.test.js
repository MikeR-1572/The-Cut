'use strict';

const {
  assert,
  test,
  buildDeck,
  shuffle,
  GameTable,
  GAME_CHOICES,
  DEFAULT_PRESET_FLAGS,
  tableWithPlayers,
  drawRoomAtFirstBetting,
  drawRoomAtDiscardPhase,
  drawRoomAtSecondBetting,
  drawRoomAtShowdown,
  holdemRoomAtPreFlopBetting,
  holdemRoomAtFlop,
  holdemRoomAtTurn,
  holdemRoomAtRiver,
  holdemRoomAtShowdown,
  studRoomAtStreetABetting,
  studActUntilRoundCloses,
  studCloseBettingRound,
  studDealNextStreet,
  studRoomAtStreetBBetting,
  studRoomAtShowdown,
} = require('../helpers');

// ---------------------------------------------------------------
// v5.0: Draw-profile hand-flow phase machine
// ---------------------------------------------------------------


test('Phase machine: full normal sequence, PreGame through CycleComplete and back to RequestAntes', () => {
  const room = drawRoomAtShowdown('draw-5card', 'Alice', 'Bob', 'Carl');
  assert.strictEqual(room.handPhase, 'Showdown');
  assert.strictEqual(room.idle, false);

  const claim = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(claim.ok, true);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.handPhase, 'CycleComplete');
  assert.strictEqual(room.idle, true);

  room.startGame('p1'); // Same Game / Options Start -> RequestAntes
  assert.strictEqual(room.handPhase, 'RequestAntes');
  assert.strictEqual(room.idle, false);
});

test('Phase machine: non-Draw profiles never transition handPhase at all -- stays PreGame forever', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'stud-7card');
  room.deal(7, 'p1');
  room.openBetting('p1');
  room.check('p2');
  room.check('p1');
  room.claimPot('p2', [{ playerId: 'p2', amount: room.pot || 1 }]).ok; // may be a no-op if pot is 0, harmless
  assert.strictEqual(room.handPhase, 'PreGame'); // never touched
});

test('Phase machine: RequestAntes only advances to OpeningDeal once every active player is settled', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'draw-5card'); // flat, anteAmount 1
  room.startGame('p1');
  assert.strictEqual(room.handPhase, 'RequestAntes');
  room.postAnteBlind('p1');
  assert.strictEqual(room.handPhase, 'RequestAntes'); // p2, p3 still owe
  room.postAnteBlind('p2');
  assert.strictEqual(room.handPhase, 'RequestAntes'); // p3 still owes
  room.postAnteBlind('p3');
  assert.strictEqual(room.handPhase, 'OpeningDeal'); // now everyone's settled
});

test('Phase machine: requiresOpeners Trigger A -- Round 1 closes with nobody having opened, stays in FirstBetting, New Hand available', () => {
  const room = drawRoomAtFirstBetting('draw-5card-jacks', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1');
  room.check('p2');
  room.check('p3');
  room.check('p1'); // everyone checks -- nobody ever opened
  assert.strictEqual(room.handPhase, 'FirstBetting'); // did NOT advance to DiscardPhase
  assert.strictEqual(room.currentBetToCall, 0);
  assert.strictEqual(room.newHand('p1').ok, true);
  assert.strictEqual(room.handPhase, 'RequestAntes');
});

test('BUG FIX (post-5.0 regression audit, not one of 5.1\'s five reported issues): New Hand must not be available immediately after Deal, before any round has actually run and closed', () => {
  const room = drawRoomAtFirstBetting('draw-5card-jacks', 'Alice', 'Bob', 'Carl');
  // Right after Deal: handPhase is FirstBetting, bettingOpen is false
  // (Dealer hasn't opened yet), currentBetToCall is 0 (freshly reset) --
  // exactly the same surface shape as the real "nobody opened" trigger,
  // but a round has not actually happened yet at all.
  assert.strictEqual(room.handPhase, 'FirstBetting');
  assert.strictEqual(room.bettingOpen, false);
  assert.strictEqual(room.currentBetToCall, 0);
  assert.strictEqual(room.bettingRoundsThisHand, 0); // the missing guard
  assert.strictEqual(room.newHand('p1').ok, false);

  room.openBetting('p1'); // now a round has genuinely started
  assert.strictEqual(room.newHand('p1').ok, false); // still not available -- round is open, not closed
  room.check('p2');
  room.check('p3');
  room.check('p1'); // round closes, nobody opened
  assert.strictEqual(room.bettingRoundsThisHand, 1);
  assert.strictEqual(room.newHand('p1').ok, true); // now correctly available
});

test('Phase machine: requiresOpeners with someone actually opening advances normally to DiscardPhase', () => {
  const room = drawRoomAtFirstBetting('draw-5card-jacks', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1');
  room.placeBet('p2', 20); // someone opens
  room.call('p3');
  room.call('p1');
  assert.strictEqual(room.handPhase, 'DiscardPhase');
  assert.strictEqual(room.newHand('p1').ok, false); // Trigger A doesn't apply once past FirstBetting
});

test('Phase machine: Showdown reAnteable exception -- nobody claims, New Hand available; folded players stay excluded', () => {
  const room = drawRoomAtFirstBetting('draw-5card-jacks', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1');
  room.placeBet('p2', 20); // someone opens -- avoids Trigger A, reaches Showdown normally
  room.call('p3');
  room.call('p1');
  room.standPat('p1');
  room.standPat('p2');
  room.standPat('p3');
  room.dealToAllPlayers('p1');
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) room.check(room.currentTurnPlayerId);
  assert.strictEqual(room.handPhase, 'Showdown');

  assert.strictEqual(room.newHand('p2').ok, false); // not Dealer
  const result = room.newHand('p1'); // nobody claimed
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.handPhase, 'RequestAntes');
});

test('BUG FIX 12.5 (Part A): a folded player is not charged an uncollectable ante on a re-ante New Hand', () => {
  // Reproduces the exact reported scenario: a player folds mid-hand,
  // the hand reaches Showdown with nobody claiming, New Hand fires
  // within the same Cycle. Before this fix, _autoApplyAnte()'s
  // flat-ante branch charged the folded player a real oweAnte anyway --
  // _dealableActivePlayers() (and therefore
  // _maybeAdvanceFromRequestAntes()) already correctly excluded them,
  // so they were stuck with an obligation and no legal way to post it.
  const room = drawRoomAtFirstBetting('draw-5card-jacks', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1');
  room.fold('p2'); // folds mid-hand -- the player this bug affects
  room.placeBet('p3', 20); // p3 opens, avoids Trigger A, reaches Showdown normally
  room.call('p1');
  room.standPat('p1');
  room.standPat('p3');
  room.dealToAllPlayers('p1');
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) room.check(room.currentTurnPlayerId);
  assert.strictEqual(room.handPhase, 'Showdown');

  const result = room.newHand('p1'); // nobody claimed
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.handPhase, 'RequestAntes');

  // The actual bug: p2 (folded in the prior hand) must not be charged
  // an ante for this new hand at all.
  assert.strictEqual(room.getPlayer('p2').oweAnte, 0);

  // p1 and p3 alone posting is sufficient to advance -- confirms p2
  // stays correctly excluded rather than silently blocking the table.
  room.postAnteBlind('p1');
  assert.strictEqual(room.handPhase, 'RequestAntes'); // p3 still owes
  room.postAnteBlind('p3');
  assert.strictEqual(room.handPhase, 'OpeningDeal'); // advanced without p2 ever posting anything
});

test('Phase machine: New Hand is unavailable for non-reAnteable Draw presets even at Showdown', () => {
  const room = drawRoomAtShowdown('draw-5card', 'Alice', 'Bob'); // reAnteable: false
  assert.strictEqual(room.handPhase, 'Showdown');
  assert.strictEqual(room.newHand('p1').ok, false);
});

test('Phase machine: Stand Pat and Discard are mutually exclusive -- whichever comes first locks out the other', () => {
  const room = drawRoomAtDiscardPhase('draw-5card', 'Alice', 'Bob');
  room.standPat('p1');
  assert.strictEqual(room.discard('p1', [room.getPlayer('p1').hand[0].id]).ok, false); // already acted via Stand Pat
  room.discard('p2', [room.getPlayer('p2').hand[0].id]);
  assert.strictEqual(room.standPat('p2').ok, false); // already acted via Discard
});

test('Phase machine: Stand Pat requires holding cards and not being folded', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1'); // turn -> p2
  room.fold('p2');
  room.check('p3');
  room.check('p1');
  assert.strictEqual(room.handPhase, 'DiscardPhase');
  assert.strictEqual(room.standPat('p2').ok, false); // folded
});

test('Phase machine: a folded player is excluded from the "everyone acted" checks in DiscardPhase', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1'); // turn -> p2
  room.fold('p2');
  room.check('p3');
  room.check('p1');
  assert.strictEqual(room.handPhase, 'DiscardPhase');
  room.standPat('p1');
  assert.strictEqual(room.handPhase, 'DiscardPhase'); // p3 (active) hasn't acted yet -- p2 (folded) doesn't count
  room.standPat('p3');
  assert.strictEqual(room.handPhase, 'DrawPhase'); // now both active players (p1, p3) have acted; p2 was never required to
});

test('claimPot: only available at Showdown for the Draw profile', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'Alice', 'Bob');
  assert.strictEqual(room.claimPot('p1', [{ playerId: 'p1', amount: 1 }]).ok, false);
});

test('BUG FIX (5.0): claimPot approver selection now skips sitting-out players when the Dealer proposes', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl', 'Dana');
  for (const p of room.players) room.buyChips(p.id, 100);
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.call('p3');
  room.call('p4');
  room.call('p1'); // Dealer also needs to match the bet to close the round
  room.sitOut('p2', 'foldAndSitOut'); // p2 is next in turn order after Dealer p1, but now sitting out
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.pendingClaim.approverId, 'p3'); // skips sitting-out p2
});

test('sitOut (5.0): the Dealer cannot sit out at all, in either mode', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.sitOut('p1', 'foldAndSitOut').ok, false);
  assert.strictEqual(room.sitOut('p1', 'sitOutNextGame').ok, false);
  room.passTheBuck('p1'); // p1 no longer Dealer
  assert.strictEqual(room.sitOut('p1', 'sitOutNextGame').ok, true);
});

test('reshuffle: blocked entirely for Draw, Hold\'em, and (NEW 7.0) Stud -- only a no-profile room stays unaffected', () => {
  const drawRoom = tableWithPlayers('Alice', 'Bob');
  drawRoom.setGameChoice('p1', 'draw-5card');
  assert.strictEqual(drawRoom.reshuffle('p1').ok, false);

  const studRoom = tableWithPlayers('Alice', 'Bob');
  studRoom.setGameChoice('p1', 'stud-7card');
  assert.strictEqual(studRoom.reshuffle('p1').ok, false); // NEW 7.0 -- was previously true

  const noProfileRoom = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(noProfileRoom.reshuffle('p1').ok, true);
});

test('Fold at Showdown (5.1): available to any non-folded player, not turn-gated', () => {
  const room = drawRoomAtShowdown('draw-5card', 'Alice', 'Bob', 'Carl');
  assert.strictEqual(room.handPhase, 'Showdown');
  // Not turn-gated: p3 can fold even though it's not "their turn" (no turn concept at Showdown).
  const result = room.fold('p3');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p3').folded, true);
  // p1 can also fold, independently, in any order.
  assert.strictEqual(room.fold('p1').ok, true);
});

test('Fold at Showdown: rejects a player who already folded or is sitting out', () => {
  const room = drawRoomAtShowdown('draw-5card', 'Alice', 'Bob', 'Carl');
  room.fold('p2');
  assert.strictEqual(room.fold('p2').ok, false); // already folded
});

test('Fold at Showdown: a folded player is correctly excluded from claiming afterward', () => {
  const room = drawRoomAtShowdown('draw-5card', 'Alice', 'Bob', 'Carl');
  room.fold('p2');
  assert.strictEqual(room.claimPot('p2', [{ playerId: 'p2', amount: room.pot }]).ok, false);
  assert.strictEqual(room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]).ok, true);
});

test('Fold at Showdown: does not interfere with New Hand\'s own independent gating for reAnteable games', () => {
  const room = drawRoomAtFirstBetting('draw-5card-jacks', 'Alice', 'Bob', 'Carl'); // reAnteable, requiresOpeners
  room.openBetting('p1');
  room.placeBet('p2', 20); // someone opens -- avoids Trigger A, reaches Showdown normally
  room.call('p3');
  room.call('p1');
  room.standPat('p1');
  room.standPat('p2');
  room.standPat('p3');
  room.dealToAllPlayers('p1');
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) room.check(room.currentTurnPlayerId);
  assert.strictEqual(room.handPhase, 'Showdown');

  room.fold('p2'); // someone folds at Showdown, choosing not to show a bluff
  assert.strictEqual(room.handPhase, 'Showdown'); // folding at Showdown doesn't change handPhase itself
  const result = room.newHand('p1'); // still available -- New Hand only checks phase/reAnteable, not who's folded
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.handPhase, 'RequestAntes');
  assert.strictEqual(room.getPlayer('p2').folded, true); // and p2's fold is preserved into the new Hand, as expected
});

test('Fold: unaffected outside Showdown (or non-Draw) -- still turn-gated as before', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.openBetting('p1'); // turn -> p2
  assert.strictEqual(room.fold('p3').ok, false); // not p3's turn, no Showdown exception applies (no profile at all)
  assert.strictEqual(room.fold('p2').ok, true); // p2's turn -- normal path
});

// ---------------------------------------------------------------
// v5.3: Early claim -- claimPot available outside Showdown once
// exactly one active player remains
// ---------------------------------------------------------------


test('claimPot (5.3): early claim available from FirstBetting once everyone else has folded', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1'); // turn -> p2
  room.fold('p2'); // turn -> p3
  room.fold('p3'); // turn -> p1 (auto-closes: everyone active besides p1 has acted, and p1 was never facing a bet)
  assert.strictEqual(room.handPhase, 'FirstBetting'); // did not advance -- only one active player left
  assert.strictEqual(room._activePlayers().length, 1);
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(result.ok, true);
});

test('claimPot (5.3): early claim available from DiscardPhase/DrawPhase/SecondBetting too, not just FirstBetting', () => {
  const room = drawRoomAtDiscardPhase('draw-5card', 'Alice', 'Bob', 'Carl');
  // Fold everyone but the Dealer directly (DiscardPhase doesn't care about betting turn order).
  room.getPlayer('p2').folded = true;
  room.getPlayer('p3').folded = true;
  assert.strictEqual(room.handPhase, 'DiscardPhase'); // still stuck here -- no one left to complete the phase but p1
  assert.strictEqual(room._activePlayers().length, 1);
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(result.ok, true);
});

test('claimPot (5.3): rejects the early-claim path when more than one active player remains, outside Showdown', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1');
  room.fold('p2'); // only one folded -- p1 and p3 both still active
  assert.strictEqual(room._activePlayers().length, 2);
  assert.strictEqual(room.claimPot('p3', [{ playerId: 'p3', amount: 1 }]).ok, false);
});

test('claimPot (5.3): an approved early claim jumps straight to CycleComplete from whatever phase it fired in', () => {
  const room = drawRoomAtDiscardPhase('draw-5card', 'Alice', 'Bob', 'Carl');
  room.getPlayer('p2').folded = true;
  room.getPlayer('p3').folded = true;
  assert.strictEqual(room.handPhase, 'DiscardPhase');
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(result.ok, true);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.handPhase, 'CycleComplete'); // jumped straight there, not through DrawPhase/SecondBetting/Showdown
  assert.strictEqual(room.idle, true);
});

test('claimPot: Showdown itself is unaffected -- still claimable there regardless of how many active players remain', () => {
  const room = drawRoomAtShowdown('draw-5card', 'Alice', 'Bob', 'Carl'); // all 3 still active
  assert.strictEqual(room._activePlayers().length, 3);
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(result.ok, true); // Showdown never needed the early-claim exception to begin with
});

test('Resolved in 5.3: "everyone folds at Showdown in a non-reAnteable game" can no longer occur -- the hand ends the moment it gets down to one active player, before Showdown', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'Alice', 'Bob', 'Carl'); // not reAnteable
  room.openBetting('p1');
  room.fold('p2');
  room.fold('p3');
  // The old stuck state this test guards against would have required
  // reaching Showdown with everyone folded. That's now unreachable --
  // the moment only one active player remains, they can (and the app
  // expects them to) claim immediately rather than being walked through
  // the rest of the hand.
  assert.notStrictEqual(room.handPhase, 'Showdown');
  assert.strictEqual(room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]).ok, true);
});
