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
// v6.0: Hold'em hand-flow phase machine
// ---------------------------------------------------------------


test('Phase machine (Hold\'em): full sequence PreGame through Showdown to CycleComplete', () => {
  const room = holdemRoomAtShowdown('holdem-texas', 'Alice', 'Bob', 'Carl');
  assert.strictEqual(room.handPhase, 'Showdown');
  assert.strictEqual(room.communityCards.length, 5);
  const claim = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(claim.ok, true);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.handPhase, 'CycleComplete');
  assert.strictEqual(room.idle, true);
});

test('Betting order (§6.6): PreFlopBetting starts left of Big Blind, not left of Dealer', () => {
  const room = holdemRoomAtPreFlopBetting('holdem-texas', 'Alice', 'Bob', 'Carl');
  // p1 dealer, p2 small blind, p3 big blind -- UTG (left of BB) wraps to p1.
  room.openBetting('p1');
  assert.strictEqual(room.currentTurnPlayerId, 'p1');
});

test('Betting order (§6.6): FlopBetting/TurnBetting/RiverBetting all start left of the Dealer, not Big Blind', () => {
  const room = holdemRoomAtFlop('holdem-texas', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1'); // dealer p1 -> left of dealer is p2
  assert.strictEqual(room.currentTurnPlayerId, 'p2');
});

test('Hold\'em RequestAntes: always clears fold status (no New-Hand-within-Cycle loop exists)', () => {
  const room = holdemRoomAtShowdown('holdem-texas', 'Alice', 'Bob', 'Carl');
  room.fold('p2');
  const claim = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  room.startGame('p1'); // only entry point into RequestAntes for Hold'em
  assert.strictEqual(room.getPlayer('p2').folded, false); // cleared, unlike Draw's New Hand path
});

test('newHand: rejected for Hold\'em -- no New-Hand-within-Cycle loop exists for this profile', () => {
  const room = holdemRoomAtShowdown('holdem-texas', 'Alice', 'Bob');
  assert.strictEqual(room.newHand('p1').ok, false);
});

test('reshuffle: blocked for Hold\'em, same as Draw', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'holdem-texas');
  assert.strictEqual(room.reshuffle('p1').ok, false);
});

test('claimPot: early claim available for Hold\'em outside Showdown once one active player remains', () => {
  const room = holdemRoomAtPreFlopBetting('holdem-texas', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1'); // turn -> p1 (UTG)
  room.fold('p1'); // turn -> p2
  room.fold('p2'); // turn -> p3, only p3 active now, round auto-closes
  assert.strictEqual(room.handPhase, 'PreFlopBetting'); // not at Showdown
  assert.strictEqual(room._activePlayers().length, 1);
  assert.strictEqual(room.claimPot('p3', [{ playerId: 'p3', amount: room.pot }]).ok, true);
});

test('Fold at Showdown: works identically for Hold\'em', () => {
  const room = holdemRoomAtShowdown('holdem-texas', 'Alice', 'Bob', 'Carl');
  assert.strictEqual(room.fold('p2').ok, true);
  assert.strictEqual(room.getPlayer('p2').folded, true);
});

// ---------------------------------------------------------------
// v6.1: blind-seeding fix (§6.7) and pendingClaim lock (§6.5)
// ---------------------------------------------------------------


test('BUG FIX (6.1 §6.7): PreFlopBetting seeds currentBetToCall/currentBet from the blinds -- UTG cannot check for free', () => {
  const room = holdemRoomAtPreFlopBetting('holdem-texas', 'Alice', 'Bob', 'Carl'); // p1 dealer, p2 SB $5, p3 BB $10
  room.openBetting('p1');
  assert.strictEqual(room.currentBetToCall, 10); // seeded at the Big Blind
  assert.strictEqual(room.getPlayer('p2').currentBet, 5); // Small Blind's own contribution
  assert.strictEqual(room.getPlayer('p3').currentBet, 10); // Big Blind's own contribution
  assert.strictEqual(room.getPlayer('p1').currentBet, 0); // never posted anything
  assert.strictEqual(room.currentTurnPlayerId, 'p1'); // UTG
  assert.strictEqual(room.check('p1').ok, false); // cannot check -- must face the Big Blind
  assert.strictEqual(room.call('p1').ok, true);
});

test('PreFlopBetting: the Big Blind itself CAN check if action reaches them unraised (already matches currentBetToCall)', () => {
  const room = holdemRoomAtPreFlopBetting('holdem-texas', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1');
  room.call('p1'); // UTG calls
  assert.strictEqual(room.getPlayer('p2').currentBet, 5);
  room.call('p2'); // small blind calls up to 10
  assert.strictEqual(room.check('p3').ok, true); // big blind's option -- already at 10, may check
});

test('FlopBetting/TurnBetting/RiverBetting: unaffected by the blind seeding, reset to a plain $0 round as always', () => {
  const room = holdemRoomAtFlop('holdem-texas', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1');
  assert.strictEqual(room.currentBetToCall, 0);
  assert.strictEqual(room.players.every((p) => p.currentBet === 0), true);
});

test('pendingClaim lock (6.1 §6.5): locks Dealer\'s Rail actions across every profile while a claim is pending', () => {
  const room = drawRoomAtShowdown('draw-5card', 'Alice', 'Bob', 'Carl');
  room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.notStrictEqual(room.pendingClaim, null);
  assert.strictEqual(room.newHand('p1').ok, false);
  assert.strictEqual(room.startGame('p1').ok, false);
  assert.strictEqual(room.setGameChoice('p1', 'draw-5card-jacks').ok, false);
  assert.strictEqual(room.deal(5, 'p1').ok, false);
  assert.strictEqual(room.openBetting('p1').ok, false);
  assert.strictEqual(room.dealCommunity('p1').ok, false);
  assert.strictEqual(room.reshuffle('p1').ok, false);
  assert.strictEqual(room.passTheBuck('p1').ok, false); // deliberately included per Mike's call
});

test('pendingClaim lock: releases once the claim resolves (approved or rejected)', () => {
  const room = drawRoomAtShowdown('draw-5card', 'Alice', 'Bob', 'Carl');
  room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, false); // rejected
  assert.strictEqual(room.pendingClaim, null);
  assert.strictEqual(room.fold('p2').ok, true); // an action available at Showdown, unlocked again now
});

test('pendingClaim lock: applies identically for Hold\'em, Stud, and a no-profile room (NEW 7.0: Stud joins the phase machine)', () => {
  const holdemRoom = holdemRoomAtShowdown('holdem-texas', 'Alice', 'Bob');
  holdemRoom.claimPot('p1', [{ playerId: 'p1', amount: holdemRoom.pot }]);
  assert.strictEqual(holdemRoom.newHand('p1').ok, false); // newHand rejects for a different reason too (holdem never has it), but pendingClaim itself is the first gate

  const studRoom = studRoomAtShowdown('stud-7card', 'Alice', 'Bob');
  const studClaim = studRoom.claimPot('p1', [{ playerId: 'p1', amount: studRoom.pot }]);
  assert.strictEqual(studClaim.ok, true);
  assert.notStrictEqual(studRoom.pendingClaim, null);
  assert.strictEqual(studRoom.reshuffle('p1').ok, false); // already blocked for Stud regardless, but confirms the lock doesn't interfere
  assert.strictEqual(studRoom.passTheBuck('p1').ok, false); // locked while pending, even between-hand actions

  const noProfileRoom = tableWithPlayers('Alice', 'Bob');
  noProfileRoom.deal(2, 'p1');
  noProfileRoom.pot = 10;
  noProfileRoom.claimPot('p2', [{ playerId: 'p2', amount: 10 }]);
  assert.notStrictEqual(noProfileRoom.pendingClaim, null);
  assert.strictEqual(noProfileRoom.reshuffle('p1').ok, false); // locked even for the true flexible-toolbox (no-profile) case
});

test('BUG FIX (6.2 §6.5 item 1): dealToPlayer/dealToAllPlayers now join the pending-claim lock -- reachable via an early claim firing mid-DrawPhase', () => {
  const room = drawRoomAtDiscardPhase('draw-5card', 'Alice', 'Bob', 'Carl');
  room.getPlayer('p2').folded = true;
  room.getPlayer('p3').folded = true; // p1 now the sole active player, still in DiscardPhase
  const claimResult = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(claimResult.ok, true);
  assert.notStrictEqual(room.pendingClaim, null);
  assert.strictEqual(room.dealToPlayer('p1', 'p1').ok, false);
  assert.strictEqual(room.dealToAllPlayers('p1').ok, false);
});

// ---------------------------------------------------------------
// CHANGED 8.3 (§14 item 17): Rabbit Hunt narrowed to Hold'em only, and
// only when the hand ended via an early claim before the River was
// dealt. Moved here from gameTable-core.test.js, which is where this
// coverage lived back when Rabbit Hunt was generic to every profile.
// ---------------------------------------------------------------

/** Everyone checks around PreFlopBetting -> Flop dealt, WITHOUT claiming -- for tests that need to reach a specific later street before an early claim. */
function holdemCheckThroughPreFlop(room) {
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) room.check(room.currentTurnPlayerId);
  room.dealCommunity('p1');
}

test('rabbitHunt: unavailable by default, opens the instant an early claim (before the River) is approved for Hold\'em', () => {
  const room = holdemRoomAtPreFlopBetting('holdem-texas', 'Alice', 'Bob', 'Carl');
  assert.strictEqual(room.rabbitHuntAvailable, false);
  assert.strictEqual(room.rabbitHunt('p1').ok, false);

  room.openBetting('p1'); // turn -> p1 (UTG)
  room.fold('p1');
  room.fold('p2'); // p3 sole active player, still PreFlopBetting -- well before the River
  room.claimPot('p3', [{ playerId: 'p3', amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.rabbitHuntAvailable, true);
});

test('rabbitHunt: unavailable for Draw or Stud, even on an early claim -- narrowed to Hold\'em only, CHANGED 8.3', () => {
  const drawRoom = drawRoomAtFirstBetting('draw-5card', 'Alice', 'Bob', 'Carl');
  drawRoom.openBetting('p1');
  drawRoom.check('p1');
  drawRoom.check('p2');
  drawRoom.getPlayer('p3').folded = false; // still active; fold the others to trigger early-claim eligibility
  drawRoom.getPlayer('p1').folded = true;
  drawRoom.getPlayer('p2').folded = true;
  drawRoom.claimPot('p3', [{ playerId: 'p3', amount: drawRoom.pot }]);
  drawRoom.resolveClaim(drawRoom.pendingClaim.approverId, true);
  assert.strictEqual(drawRoom.rabbitHuntAvailable, false);

  const studRoom = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob', 'Carl');
  studRoom.setOpeningBettor('p1', 'p1');
  studRoom.openBetting('p1');
  studRoom.call('p1');
  studRoom.fold('p2');
  studRoom.fold('p3');
  studRoom.claimPot('p1', [{ playerId: 'p1', amount: studRoom.pot }]);
  studRoom.resolveClaim(studRoom.pendingClaim.approverId, true);
  assert.strictEqual(studRoom.rabbitHuntAvailable, false);
});

test('rabbitHunt: unavailable for Hold\'em on a full run to Showdown -- every community card is already visible, nothing to hunt', () => {
  const room = holdemRoomAtShowdown('holdem-texas', 'Alice', 'Bob');
  room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.rabbitHuntAvailable, false);
});

test('rabbitHunt: unavailable for Hold\'em on a late early claim once the River is genuinely dealt (5 community cards) -- CHANGED 8.3, was available for any early claim before', () => {
  const room = holdemRoomAtRiver('holdem-texas', 'Alice', 'Bob', 'Carl'); // dealCommunity() already ran -- 5 real cards, not just the phase name
  assert.strictEqual(room.communityCards.length, 5);
  room.openBetting('p1'); // turn -> p2 (post-flop street)
  room.fold('p2');
  room.fold('p3'); // p1 sole active, but the river is genuinely already showing
  room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.rabbitHuntAvailable, false);
});

test('BUG FIX 8.4 (§5.9/§14 item 17, specification bug): a fold-down that closes the betting round mid-TurnBetting lands handPhase on "River" WITHOUT the river card actually being dealt -- rabbitHunt must still be offered', () => {
  // Exact reproduction of the reported scenario: a player (Chris, here
  // p3) checks during TurnBetting: the other two players then fold IN
  // RESPONSE, in turn order, each already having acted earlier in the
  // same round. The round closes the moment the second fold leaves
  // exactly one active player who's already acted -- landing handPhase
  // on the phase NAME 'River' (the phase Hold'em's transition table
  // advances to unconditionally once TurnBetting closes) without
  // dealCommunity() ever having been called for it. The pre-8.4 spec's
  // phase-name check (`!['River', 'RiverBetting', 'Showdown'].includes(...)`)
  // treated reaching this phase NAME as "already shown" and wrongly
  // withheld Rabbit Hunt -- checking `communityCards.length < 5` instead
  // can't be fooled by a phase name that doesn't reflect what's actually
  // been dealt.
  const room = holdemRoomAtTurn('holdem-texas', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1'); // turn -> p2
  room.fold('p2'); // turn -> p3 (Chris)
  room.check('p3'); // Chris checks -- turn -> p1
  room.fold('p1'); // folds in response -- p2 and p3 (Chris) are the only ones who'd acted; only p3 remains active
  assert.strictEqual(room.handPhase, 'River'); // the phase NAME, misleadingly
  assert.strictEqual(room.communityCards.length, 4); // but the river card itself was never dealt
  assert.deepStrictEqual(room._activePlayers().map((p) => p.id), ['p3']);

  room.claimPot('p3', [{ playerId: 'p3', amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.rabbitHuntAvailable, true); // the actual bug -- this was false before the 8.4 fix
});

test('rabbitHunt: available for an early claim on Flop or Turn, not just PreFlop -- "before the River" means any phase up through TurnBetting', () => {
  const room = holdemRoomAtFlop('holdem-texas', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1'); // turn -> p2 (post-flop starts left of Dealer, not UTG)
  room.fold('p2');
  room.fold('p3'); // p1 sole active, FlopBetting
  room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.rabbitHuntAvailable, true);
});

test('rabbitHunt: Dealer-only, one card per click, face-up, appended in order', () => {
  const room = holdemRoomAtPreFlopBetting('holdem-texas', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1');
  room.fold('p1');
  room.fold('p2'); // p3 sole active
  room.claimPot('p3', [{ playerId: 'p3', amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, true);

  assert.strictEqual(room.rabbitHunt('p3').ok, false); // not Dealer (p1 still is)
  const deckBefore = room.deck.length;
  room.rabbitHunt('p1');
  room.rabbitHunt('p1');
  assert.strictEqual(room.rabbitHuntCards.length, 2);
  assert.strictEqual(room.rabbitHuntCards.every((c) => c.faceUp === true), true);
  assert.strictEqual(room.deck.length, deckBefore - 2);
});

test('rabbitHunt: window closes the instant Deal happens, not just Reshuffle', () => {
  const room = holdemRoomAtPreFlopBetting('holdem-texas', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1');
  room.fold('p1');
  room.fold('p2');
  room.claimPot('p3', [{ playerId: 'p3', amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  room.rabbitHunt('p1');

  room.setGameChoice('p1', 'holdem-texas'); // Same Game -- reshuffle + fresh RequestAntes
  room.startGame('p1');
  assert.strictEqual(room.rabbitHuntAvailable, false);
  assert.strictEqual(room.rabbitHuntCards.length, 0);
});

test('Reshuffle: reset logic for rabbitHuntAvailable/rabbitHuntCards is unchanged, even though no normal flow reaches it for a no-profile room anymore', () => {
  // CHANGED 8.3: pre-8.3, this test used a bare (no-profile) room and
  // reached this state via a completely normal claim/resolve flow --
  // that's no longer possible, since resolveClaim() only ever sets
  // rabbitHuntAvailable true for Hold'em now, and Hold'em itself can
  // never reach reshuffle() at all (blocked since 5.0/6.0, phase-gated).
  // The two fields are set directly here instead, purely to confirm
  // reshuffle()'s own unconditional reset logic (untouched by this
  // release) still works correctly -- there's no longer any real,
  // reachable end-to-end path that would exercise it together with a
  // genuine Rabbit Hunt session, which is itself a real, intentional
  // consequence of narrowing Rabbit Hunt to Hold'em only.
  const room = tableWithPlayers('Alice', 'Bob');
  room.rabbitHuntAvailable = true;
  room.rabbitHuntCards = [room.deck.pop(), room.deck.pop()];
  const deckBefore = room.deck.length;
  room.reshuffle('p1');
  assert.strictEqual(room.rabbitHuntAvailable, false);
  assert.strictEqual(room.rabbitHuntCards.length, 0);
  assert.strictEqual(room.deck.length, deckBefore + 2); // folded back in, not lost
});


