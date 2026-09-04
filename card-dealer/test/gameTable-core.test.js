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
} = require('./helpers');

// ---------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------


test('Room: first player to join is auto-Dealer', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.getPlayer('p1').isDealer, true);
  assert.strictEqual(room.getPlayer('p2').isDealer, false);
  assert.strictEqual(room.currentTurnPlayerId, 'p1');
});

test('Room: new players start at $0 chips, $0 totalBuyIn, not sitting out, no ante owed', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  const p1 = room.getPlayer('p1');
  assert.strictEqual(p1.chips, 0);
  assert.strictEqual(p1.totalBuyIn, 0);
  assert.strictEqual(p1.sittingOut, false);
  assert.strictEqual(p1.oweAnte, 0);
});

test('Room: no denominations/chipBreakdown fields exist anywhere (removed in 3.2, still gone in 3.3)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.denominations, undefined);
  assert.strictEqual(room.getPlayer('p1').chipBreakdown, undefined);
  assert.strictEqual(room.toRedactedState('p1').denominations, undefined);
  assert.strictEqual(room.toRedactedState('p1').potBreakdown, undefined);
});

test('Room: jokers are always off as of v3.3 -- no way to enable them', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.includeJokers, false);
  assert.strictEqual(room.deck.length, 52); // no jokers mixed in
  assert.strictEqual(room.toRedactedState('p1').includeJokers, false);
});

test('Room: creatorId is set to the first player and survives a Pass the Buck', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  assert.strictEqual(room.creatorId, 'p1');
  room.passTheBuck('p1'); // moves to next active seat -- p2
  assert.strictEqual(room.creatorId, 'p1'); // unaffected by who holds Dealer now
  assert.strictEqual(room.getPlayer('p2').isDealer, true);
  assert.strictEqual(room.toRedactedState('p1').creatorId, 'p1');
});

test('Room: deal rejects non-Dealer, distributes correctly, rejects when short or under min players', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  assert.strictEqual(room.deal(2, 'p2').ok, false);
  const before = room.deck.length;
  const result = room.deal(5, 'p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').hand.length, 5);
  assert.strictEqual(room.deck.length, before - 10);

  const solo = tableWithPlayers('Alice');
  solo.buyChips('p1', 1000);
  assert.strictEqual(solo.deal(2, 'p1').ok, false);
});

test('Room: passTheBuck moves role to the next active seat, rejects non-Dealer sender', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.passTheBuck('p2').ok, false);
  const result = room.passTheBuck('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').isDealer, false);
  assert.strictEqual(room.getPlayer('p2').isDealer, true);
});

test('Room: advanceTurn cycles through turnOrder', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.advanceTurn('p1');
  assert.strictEqual(room.currentTurnPlayerId, 'p2');
  room.advanceTurn('p1');
  assert.strictEqual(room.currentTurnPlayerId, 'p3');
  room.advanceTurn('p1');
  assert.strictEqual(room.currentTurnPlayerId, 'p1');
});

test('Room: removePlayer auto-promotes next Dealer and fixes turn order', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.removePlayer('p1');
  assert.strictEqual(room.getPlayer('p2').isDealer, true);
  assert.deepStrictEqual(room.turnOrder, ['p2', 'p3']);
});

test('Room: toRedactedState reveals own hand fully; others redacted per-card (v4.0), not as a whole', () => {
  const room = tableWithPlayers('Alice', 'Bob'); // no Game Choice active -> deals private by default
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.deal(3, 'p1');
  const forP1 = room.toRedactedState('p1');
  const p2ViewFromP1 = forP1.players.find((p) => p.id === 'p2');
  assert.strictEqual(forP1.players.find((p) => p.id === 'p1').hand.length, 3);
  assert.strictEqual(p2ViewFromP1.hand.length, 3); // array always present now, same length as the real hand
  assert.strictEqual(p2ViewFromP1.hand.every((c) => c.faceUp === false && c.suit === undefined), true); // fully redacted stubs
  assert.strictEqual(p2ViewFromP1.handCount, 3);
});

test('Table name (v3.3): only the room creator can set it, blank falls back to code', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.setTableName('p2', 'Bobs Table').ok, false);
  room.setTableName('p1', '  Friday Night  ');
  assert.strictEqual(room.toRedactedState('p1').name, 'Friday Night');
  room.setTableName('p1', '   ');
  assert.strictEqual(room.toRedactedState('p1').name, room.code);
});

test('Table name: the Dealer role alone no longer grants rename permission', () => {
  const room = tableWithPlayers('Alice', 'Bob'); // p1 creator + Dealer
  room.passTheBuck('p1'); // p2 is now Dealer, but not the creator
  assert.strictEqual(room.setTableName('p2', 'Bobs Table').ok, false); // Dealer, but not creator
  assert.strictEqual(room.setTableName('p1', 'Still Mine').ok, true); // creator, even without Dealer
});

// ---------------------------------------------------------------
// Buy-in (v3.2: plain amount, no denominations)
// ---------------------------------------------------------------


test('buyChips: adds a plain amount to chips and totalBuyIn', () => {
  const room = tableWithPlayers('Alice');
  const result = room.buyChips('p1', 300);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').chips, 300);
  assert.strictEqual(room.getPlayer('p1').totalBuyIn, 300);
});

test('buyChips: repeated buys accumulate; rejects non-positive/non-integer amounts', () => {
  const room = tableWithPlayers('Alice');
  room.buyChips('p1', 100);
  room.buyChips('p1', 50);
  assert.strictEqual(room.getPlayer('p1').chips, 150);
  assert.strictEqual(room.getPlayer('p1').totalBuyIn, 150);
  assert.strictEqual(room.buyChips('p1', 0).ok, false);
  assert.strictEqual(room.buyChips('p1', -10).ok, false);
  assert.strictEqual(room.buyChips('p1', 12.5).ok, false);
});

// ---------------------------------------------------------------
// Discard (NEW 3.2)
// ---------------------------------------------------------------


test('discard: moves chosen cards from hand to the discard pile, self-service, not turn-gated', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.deal(3, 'p1');
  const hand = room.getPlayer('p2').hand;
  const idsToDiscard = [hand[0].id, hand[1].id];
  const result = room.discard('p2', idsToDiscard); // not p2's turn, no round even open -- still allowed
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').hand.length, 1);
  assert.strictEqual(room.discardPile.length, 2);
});

test('discard: rejects discarding a card the player does not hold, or an empty selection', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.deal(2, 'p1');
  assert.strictEqual(room.discard('p1', []).ok, false);
  assert.strictEqual(room.discard('p1', ['not-a-real-card-id']).ok, false);
  assert.strictEqual(room.discardPile.length, 0);
});

test('discard: discard pile stays separate from the deck until reshuffle folds it back in', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.deal(2, 'p1');
  const deckBefore = room.deck.length;
  room.discard('p1', [room.getPlayer('p1').hand[0].id]);
  assert.strictEqual(room.deck.length, deckBefore); // discard pile, not the deck
  assert.strictEqual(room.discardPile.length, 1);
  room.reshuffle('p1');
  assert.strictEqual(room.discardPile.length, 0); // folded back into the deck
});

// ---------------------------------------------------------------
// Ante/Blind (NEW 3.2)
// ---------------------------------------------------------------


test('setAnteBlind: Dealer-only, sets a specific amount for a specific player', () => {
  const room = tableWithPlayers('Alice', 'Bob'); // p1 Dealer
  assert.strictEqual(room.setAnteBlind('p2', 'p2', 5).ok, false); // non-Dealer
  const result = room.setAnteBlind('p1', 'p2', 5);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').oweAnte, 5);
});

test('setAnteBlind: 0 clears it; rejects negative/non-integer amounts', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setAnteBlind('p1', 'p2', 5);
  room.setAnteBlind('p1', 'p2', 0);
  assert.strictEqual(room.getPlayer('p2').oweAnte, 0);
  assert.strictEqual(room.setAnteBlind('p1', 'p2', -5).ok, false);
  assert.strictEqual(room.setAnteBlind('p1', 'p2', 2.5).ok, false);
});

test('postAnteBlind: pays the owed amount into the pot, not turn-gated', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p2', 100);
  room.setAnteBlind('p1', 'p2', 5);
  const result = room.postAnteBlind('p2');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').chips, 95);
  assert.strictEqual(room.getPlayer('p2').oweAnte, 0);
  assert.strictEqual(room.pot, 5);
});

test('postAnteBlind: rejects when nothing owed or insufficient chips', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.postAnteBlind('p2').ok, false); // owes nothing
  room.setAnteBlind('p1', 'p2', 50);
  assert.strictEqual(room.postAnteBlind('p2').ok, false); // has $0 chips, owes $50
});

// ---------------------------------------------------------------
// Sitting Out (NEW 3.2)
// ---------------------------------------------------------------


test('sitOut(foldAndSitOut): applies immediately when no hand is in progress', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  const result = room.sitOut('p3', 'foldAndSitOut');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p3').sittingOut, true);
});

test('sitOut(foldAndSitOut): folds out of an open round immediately, regardless of whose turn it is', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.openBetting('p1'); // turn -> p2
  const result = room.sitOut('p3', 'foldAndSitOut'); // not p3's turn
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p3').folded, true);
  assert.strictEqual(room.getPlayer('p3').sittingOut, true);
});

test('sitOut(foldAndSitOut): if it is currently their turn, the turn moves on', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.openBetting('p1'); // turn -> p2
  room.sitOut('p2', 'foldAndSitOut');
  assert.strictEqual(room.currentTurnPlayerId, 'p3');
});

test('sitOut(sitOutNextGame): does not sit out immediately; applies at the next reshuffle/deal', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  const result = room.sitOut('p2', 'sitOutNextGame');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').sittingOut, false); // not yet
  room.reshuffle('p1');
  assert.strictEqual(room.getPlayer('p2').sittingOut, true); // now applied
});

test('sitOut: rejects an invalid mode or sitting out twice', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.sitOut('p2', 'nonsense').ok, false);
  room.sitOut('p2', 'foldAndSitOut');
  assert.strictEqual(room.sitOut('p2', 'foldAndSitOut').ok, false);
});

test('sitIn: opts back in; rejects if not currently sitting out', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.sitIn('p2').ok, false);
  room.sitOut('p2', 'foldAndSitOut');
  const result = room.sitIn('p2');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').sittingOut, false);
});

// ---------------------------------------------------------------
// NEW 9.2 (§9): automatic sitting-out for $0 chips
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// CORRECTED 9.6 (§9): $0-chip exclusion from dealing/ante -- computed
// fresh from `chips` every time, NEVER a persisted sittingOut flag.
// Supersedes 9.2's original (and, on this specific point, WRONG)
// implementation, which reused sittingOut for this and needed a
// Dealer-specific carve-out (9.4) that shouldn't have been necessary.
// ---------------------------------------------------------------

test('CORRECTED 9.6: a $0-chip player is excluded from dealing/ante, but sittingOut itself stays false -- it was never actually "sitting out"', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  // p3 (Carl) never buys chips -- stays at $0.
  room.setGameChoice('p1', 'draw-5card');
  room.startGame('p1');
  assert.strictEqual(room.getPlayer('p3').sittingOut, false); // NOT sitting out -- corrected from 9.2
  assert.strictEqual(room.toRedactedState('p1').players.find((p) => p.id === 'p3').excludedForZeroChips, true); // the real, separate signal
  room.postAnteBlind('p1');
  room.postAnteBlind('p2');
  const dealResult = room.deal(5, 'p1');
  assert.strictEqual(dealResult.ok, true);
  assert.strictEqual(room.getPlayer('p3').hand.length, 0); // never dealt in
  assert.strictEqual(room.getPlayer('p1').hand.length, 5);
});

test('CORRECTED 9.6: a $0-chip Dealer needs NO special handling at all -- stays Dealer, isn\'t dealt in, owes nothing, and every Dealer-role action remains fully available', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p2', 1000);
  room.buyChips('p3', 1000);
  // p1 (Alice, Dealer) never buys chips -- stays at $0.
  room.setGameChoice('p1', 'draw-5card');
  room.startGame('p1');
  assert.strictEqual(room.getPlayer('p1').isDealer, true); // no automatic handoff -- corrected from 9.4
  assert.strictEqual(room.getPlayer('p1').sittingOut, false);
  assert.strictEqual(room.toRedactedState('p1').players.find((p) => p.id === 'p1').excludedForZeroChips, true);
  room.postAnteBlind('p2');
  room.postAnteBlind('p3');
  const dealResult = room.deal(5, 'p1'); // the $0 Dealer can still Deal, to the two funded players
  assert.strictEqual(dealResult.ok, true);
  assert.strictEqual(room.getPlayer('p1').hand.length, 0); // not dealt in themselves
  assert.strictEqual(room.getPlayer('p2').hand.length, 5);
  assert.strictEqual(room.getPlayer('p3').hand.length, 5);
});

test('NEW 9.2 (unchanged in spirit): an all-in player mid-hand is never excluded -- the $0 check is never continuous, only ever relevant at the next RequestAntes', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 30);
  room.buyChips('p2', 1000);
  room.buyChips('p3', 1000);
  room.setGameChoice('p1', 'holdem-texas');
  room.setGameOption('p1', 'smallBlind', 0);
  room.setGameOption('p1', 'bigBlind', 0);
  room.startGame('p1');
  room.deal(2, 'p1');
  room.openBetting('p1');
  room.allIn('p1'); // p1's chips is now genuinely $0, mid-hand
  assert.strictEqual(room.getPlayer('p1').chips, 0);
  assert.strictEqual(room.getPlayer('p1').sittingOut, false);
  assert.strictEqual(room.toRedactedState('p1').players.find((p) => p.id === 'p1').excludedForZeroChips, false); // allIn -- not the same as being excluded from the NEXT hand
});

test('CORRECTED 9.6: buying chips simply removes the $0 exclusion -- there\'s no sittingOut interaction to auto-clear anymore', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.startGame('p1');
  assert.strictEqual(room.toRedactedState('p1').players.find((p) => p.id === 'p3').excludedForZeroChips, true);
  room.buyChips('p3', 500);
  assert.strictEqual(room.toRedactedState('p1').players.find((p) => p.id === 'p3').excludedForZeroChips, false);
  assert.strictEqual(room.getPlayer('p3').sittingOut, false); // was never true to begin with
});

test('CORRECTED 9.6: buying chips is a no-op for a player who is genuinely, voluntarily sitting out -- a manual Sit In is still required', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.sitOut('p3', 'foldAndSitOut'); // manual, unrelated to chip count
  room.buyChips('p3', 100); // buying more chips doesn't un-sit-out a voluntary sitter
  assert.strictEqual(room.getPlayer('p3').sittingOut, true);
});

// ---------------------------------------------------------------
// NEW 9.2 (§4, §10.1): case-insensitive join-time name collision
// ---------------------------------------------------------------

test('NEW 9.2: hasPlayerNamed matches case-insensitively', () => {
  const room = tableWithPlayers('Chris');
  assert.strictEqual(room.hasPlayerNamed('chris'), true);
  assert.strictEqual(room.hasPlayerNamed('CHRIS'), true);
  assert.strictEqual(room.hasPlayerNamed('  Chris  '), true);
  assert.strictEqual(room.hasPlayerNamed('Christine'), false);
  assert.strictEqual(room.hasPlayerNamed('Bob'), false);
});

test('Sitting out: deal skips sitting-out players entirely', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.sitOut('p3', 'foldAndSitOut');
  room.deal(3, 'p1');
  assert.strictEqual(room.getPlayer('p1').hand.length, 3);
  assert.strictEqual(room.getPlayer('p2').hand.length, 3);
  assert.strictEqual(room.getPlayer('p3').hand.length, 0);
});

test('Sitting out: advanceTurn and the betting rotation both skip sitting-out players', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.sitOut('p2', 'foldAndSitOut');
  room.openBetting('p1'); // would normally start at p2, but p2 is sitting out -> p3
  assert.strictEqual(room.currentTurnPlayerId, 'p3');
});

test('Sitting out: cannot propose or receive a claim allocation', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 100);
  room.buyChips('p2', 100);
  room.buyChips('p3', 100);
  room.openBetting('p1'); // turn -> p2
  room.placeBet('p2', 20);
  room.call('p3');
  room.call('p1');
  room.sitOut('p3', 'foldAndSitOut'); // sits out after the round already closed
  assert.strictEqual(room.claimPot('p3', [{ playerId: 'p1', amount: 60 }]).ok, false); // proposer sitting out
  assert.strictEqual(
    room.claimPot('p1', [{ playerId: 'p3', amount: 60 }]).ok,
    false
  ); // recipient sitting out
});

// ---------------------------------------------------------------
// Betting: first-to-act, bet cap, auto-close
// ---------------------------------------------------------------


test('Betting: openBetting is Dealer-only, rejects double-open, first-to-act is left of Dealer', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  assert.strictEqual(room.openBetting('p2').ok, false);
  const result = room.openBetting('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.currentTurnPlayerId, 'p2');
  assert.strictEqual(room.openBetting('p1').ok, false);
});

test('Betting: placeBet moves chips, sets currentBetToCall, advances turn', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 300);
  room.buyChips('p2', 300);
  room.openBetting('p1'); // action -> p2
  const result = room.placeBet('p2', 20);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').chips, 280);
  assert.strictEqual(room.pot, 20);
  assert.strictEqual(room.currentBetToCall, 20);
  assert.strictEqual(room.currentTurnPlayerId, 'p1');
});

test('Betting: a Bet/Raise for the player\'s entire stack is rejected -- must use All-In instead (CHANGED 9.4, extended from Hold\'em-only)', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 500);
  room.buyChips('p2', 100); // shortest
  room.buyChips('p3', 300);
  room.openBetting('p1');
  assert.strictEqual(room.placeBet('p2', 150).ok, false); // exceeds their own stack entirely
  const fullStack = room.placeBet('p2', 100); // exactly their entire stack -- Option B, must use All-In
  assert.strictEqual(fullStack.ok, false);
  assert.match(fullStack.error, /All-In/);
  const belowStack = room.placeBet('p2', 80);
  assert.strictEqual(belowStack.ok, true);
  assert.strictEqual(room.getPlayer('p2').chips, 20);
  assert.strictEqual(room.getPlayer('p2').folded, false);
});

test('Betting: the opponent-ceiling cap ignores sitting-out players (they are not "active")', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 500);
  room.buyChips('p2', 10); // would be the shortest, but is sitting out
  room.buyChips('p3', 300);
  room.sitOut('p2', 'foldAndSitOut');
  room.openBetting('p1'); // skips p2, action -> p3
  const result = room.placeBet('p3', 250); // well within p1's $500 ceiling; p2's sat-out $10 is correctly ignored
  assert.strictEqual(result.ok, true);
});

test('Check: legal only when nothing is owed; rejected out of turn, while folded, or sitting out', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.openBetting('p1'); // turn -> p2
  assert.strictEqual(room.check('p1').ok, false);
  assert.strictEqual(room.check('p2').ok, true);
  assert.strictEqual(room.currentTurnPlayerId, 'p3');
});

test('Fold: marks player, skipped by rotation, stays seated', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.openBetting('p1'); // turn -> p2
  room.fold('p2');
  assert.strictEqual(room.getPlayer('p2').folded, true);
  assert.strictEqual(room.turnOrder.includes('p2'), true);
  assert.strictEqual(room.currentTurnPlayerId, 'p3');
});

// ---------------------------------------------------------------
// Automatic betting-round closure
// ---------------------------------------------------------------


test('Auto-close: a full round of checks closes the round on its own', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.openBetting('p1');
  room.check('p2');
  assert.strictEqual(room.bettingOpen, true);
  room.check('p3');
  assert.strictEqual(room.bettingOpen, true);
  room.check('p1');
  assert.strictEqual(room.bettingOpen, false);
});

test('Auto-close: a bet followed by calls all the way around closes the round', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 300);
  room.buyChips('p2', 300);
  room.buyChips('p3', 300);
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.call('p3');
  assert.strictEqual(room.bettingOpen, true);
  room.call('p1');
  assert.strictEqual(room.bettingOpen, false);
});

test('Auto-close: a re-raise reopens the requirement for everyone else to respond again', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 300);
  room.buyChips('p2', 300);
  room.buyChips('p3', 300);
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.placeBet('p3', 50); // re-raise
  room.call('p1');
  assert.strictEqual(room.bettingOpen, true); // p2 still owes a response
  room.call('p2');
  assert.strictEqual(room.bettingOpen, false);
});

test('Auto-close: folding down to one active player closes the round without awarding the pot', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 300);
  room.buyChips('p2', 300);
  room.buyChips('p3', 300);
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.fold('p3');
  assert.strictEqual(room.bettingOpen, true);
  room.fold('p1');
  assert.strictEqual(room.bettingOpen, false);
  assert.strictEqual(room.pot, 20);
  assert.strictEqual(room.pendingClaim, null);
});

// ---------------------------------------------------------------
// Claiming the pot (split pots, v3.2)
// ---------------------------------------------------------------


test('claimPot: single-winner allocation works exactly as a simple claim', () => {
  const room = tableWithPlayers('Alice', 'Bob'); // p1 Dealer
  room.buyChips('p1', 300);
  room.buyChips('p2', 300);
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.call('p1');
  const result = room.claimPot('p2', [{ playerId: 'p2', amount: 40 }]);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(room.pendingClaim.allocations, [{ playerId: 'p2', amount: 40 }]);
});

test('claimPot: split-pot allocation across multiple players', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 100);
  room.buyChips('p2', 100);
  room.buyChips('p3', 100);
  room.openBetting('p1');
  room.placeBet('p2', 30);
  room.call('p3');
  room.call('p1'); // pot = 90
  const result = room.claimPot('p1', [
    { playerId: 'p2', amount: 45 },
    { playerId: 'p3', amount: 45 },
  ]);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(room.pendingClaim.approverId, 'p2'); // Dealer proposed -> next in turn order approves
});

test('claimPot: rejects allocations that do not sum exactly to the pot', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 100);
  room.buyChips('p2', 100);
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.call('p1'); // pot = 40
  assert.strictEqual(
    room.claimPot('p2', [{ playerId: 'p2', amount: 30 }]).ok,
    false
  );
  assert.strictEqual(
    room.claimPot('p2', [
      { playerId: 'p2', amount: 20 },
      { playerId: 'p1', amount: 30 },
    ]).ok,
    false
  );
});

test('claimPot: rejects a folded proposer, folded/sitting-out recipients, duplicate recipients', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 100);
  room.buyChips('p2', 100);
  room.buyChips('p3', 100);
  room.openBetting('p1'); // turn -> p2
  room.placeBet('p2', 20);
  room.fold('p3'); // turn -> p1
  room.call('p1'); // pot = 40
  assert.strictEqual(room.claimPot('p3', [{ playerId: 'p2', amount: 40 }]).ok, false); // p3 folded, can't propose
  assert.strictEqual(room.claimPot('p2', [{ playerId: 'p3', amount: 40 }]).ok, false); // p3 folded, can't receive
  assert.strictEqual(
    room.claimPot('p2', [
      { playerId: 'p1', amount: 20 },
      { playerId: 'p1', amount: 20 },
    ]).ok,
    false
  ); // duplicate recipient
});

test('claimPot: rejects when pot is empty or a claim is already pending', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.claimPot('p1', [{ playerId: 'p1', amount: 10 }]).ok, false);
  room.buyChips('p1', 100);
  room.buyChips('p2', 100);
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.call('p1');
  room.claimPot('p2', [{ playerId: 'p2', amount: 40 }]);
  assert.strictEqual(room.claimPot('p1', [{ playerId: 'p1', amount: 40 }]).ok, false);
});

test('resolveClaim(approve): pays every allocated player, only this clears the pot', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 100);
  room.buyChips('p2', 100);
  room.buyChips('p3', 100);
  room.openBetting('p1');
  room.placeBet('p2', 30);
  room.call('p3');
  room.call('p1'); // pot = 90
  room.claimPot('p1', [
    { playerId: 'p2', amount: 45 },
    { playerId: 'p3', amount: 45 },
  ]);
  const result = room.resolveClaim('p2', true); // approver is next-in-order after Dealer p1
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').chips, 70 + 45);
  assert.strictEqual(room.getPlayer('p3').chips, 70 + 45);
  assert.strictEqual(room.pot, 0);
  assert.strictEqual(room.pendingClaim, null);
});

test('resolveClaim(reject): pot and stacks untouched', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 100);
  room.buyChips('p2', 100);
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.call('p1'); // pot = 40
  room.claimPot('p2', [{ playerId: 'p2', amount: 40 }]);
  const result = room.resolveClaim('p1', false);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.pot, 40);
  assert.strictEqual(room.getPlayer('p2').chips, 80); // unchanged
});

// ---------------------------------------------------------------
// Reshuffle: pot persists, discard pile folds back in
// ---------------------------------------------------------------


test('Reshuffle: does NOT reset the pot, chips, or totalBuyIn; resets round state and discard pile', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 300);
  room.buyChips('p2', 300);
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.call('p1'); // pot = 40, auto-closed
  room.deal(2, 'p1');
  room.discard('p1', [room.getPlayer('p1').hand[0].id]);
  room.revealHand('p1');

  const result = room.reshuffle('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.pot, 40);
  assert.strictEqual(room.bettingOpen, false);
  assert.strictEqual(room.currentBetToCall, 0);
  assert.strictEqual(room.getPlayer('p1').currentBet, 0);
  assert.strictEqual(room.getPlayer('p1').folded, false);
  assert.strictEqual(room.getPlayer('p1').revealed, false);
  assert.strictEqual(room.discardPile.length, 0);
  assert.strictEqual(room.getPlayer('p1').chips, 280);
  assert.strictEqual(room.getPlayer('p1').totalBuyIn, 300);
});

// ---------------------------------------------------------------
// Show Cards
// ---------------------------------------------------------------


test('Show Cards: revealHand works regardless of turn/folded, no approval needed', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.deal(2, 'p1');
  room.getPlayer('p2').folded = true;
  assert.strictEqual(room.revealHand('p2').ok, true);
  assert.strictEqual(room.getPlayer('p2').revealed, true);
});

test('Show Cards: revealed hand visible to everyone; reshuffle resets it', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.deal(3, 'p1');
  room.revealHand('p2');
  const forP1 = room.toRedactedState('p1');
  assert.strictEqual(forP1.players.find((p) => p.id === 'p2').hand.length, 3);
  room.reshuffle('p1');
  assert.strictEqual(room.getPlayer('p2').revealed, false);
});

// ---------------------------------------------------------------
// v4.0: Game Choices / Profiles
// ---------------------------------------------------------------


test('GAME_CHOICES: 16 presets loaded, covering all three profiles', () => {
  const draw = GAME_CHOICES.filter((g) => g.profile === 'draw');
  const stud = GAME_CHOICES.filter((g) => g.profile === 'stud');
  const holdem = GAME_CHOICES.filter((g) => g.profile === 'holdem');
  assert.strictEqual(GAME_CHOICES.length, 16);
  assert.strictEqual(draw.length, 3);
  assert.strictEqual(stud.length, 10);
  assert.strictEqual(holdem.length, 3);
});

test('setGameChoice: Dealer-only, resolves profile and a fresh copy of the preset options', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.setGameChoice('p2', 'draw-5card').ok, false);
  const result = room.setGameChoice('p1', 'holdem-texas');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.gameChoiceId, 'holdem-texas');
  assert.strictEqual(room.profile, 'holdem');
  // CHANGED 8.1 (§3): gameOptions is still one flat merged object at
  // runtime -- setGameChoice() merges the preset's hiddenOptions and
  // dealerOptions together, same shape every pre-8.1 test already expects.
  assert.deepStrictEqual(room.gameOptions, {
    cardsPerPlayer: 2,
    communityPattern: [3, 1, 1],
    anteType: 'blind',
    smallBlind: 5,
    bigBlind: 10,
    audible: '',
    bettingStructure: 'no-limit', // NEW 9.0 (§6.10)
    raiseCap: 'no-cap', // NEW 9.0 (§6.10), default CHANGED 9.1 -- dependent on bettingStructure, "no-cap" under No-Limit
  });
  // mutating the resolved options must not mutate the preset source
  room.gameOptions.smallBlind = 999;
  const preset = GAME_CHOICES.find((g) => g.id === 'holdem-texas');
  assert.strictEqual(preset.dealerOptions.smallBlind, 5);
});

test('setGameChoice: rejects an unknown id', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.setGameChoice('p1', 'not-a-real-preset').ok, false);
});

test('setGameOption: overrides one resolved value without touching gameChoiceId/profile', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'draw-5card');
  const result = room.setGameOption('p1', 'maxDiscards', 2);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.gameOptions.maxDiscards, 2);
  assert.strictEqual(room.gameChoiceId, 'draw-5card');
  assert.strictEqual(room.profile, 'draw');
});

test('setGameOption: rejects unknown keys, non-Dealer senders, and no active Game Choice', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.setGameOption('p1', 'maxDiscards', 2).ok, false); // no Game Choice yet
  room.setGameChoice('p1', 'draw-5card');
  assert.strictEqual(room.setGameOption('p2', 'maxDiscards', 2).ok, false); // not Dealer
  assert.strictEqual(room.setGameOption('p1', 'notARealOption', 2).ok, false);
});

// ---------------------------------------------------------------
// v4.0: Per-card visibility (Deal faceUp override, Stud pattern)
// ---------------------------------------------------------------


test('Deal: with no Game Choice active, cards default to face-down', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.deal(3, 'p1');
  assert.strictEqual(room.getPlayer('p1').hand.every((c) => c.faceUp === false), true);
});

test('Deal: Stud pattern sets each card position face-up/down automatically', () => {
  // NEW 7.0: Stud is phase-gated now -- deal() only fires within a
  // Street* phase, and each subsequent street requires its betting round
  // to close first. Uses the studRoomAtStreetBBetting helper (StreetA's
  // 2-card initial deal + StreetB's 1-card single deal = 3 cards total
  // for 5-Card Stud), same total the original test dealt manually.
  const room = studRoomAtStreetBBetting('stud-5card', 'Alice', 'Bob'); // pattern: down, up, up, up, up
  const hand = room.getPlayer('p1').hand;
  assert.deepStrictEqual(hand.map((c) => c.faceUp), [false, true, true]);
});

test('Deal: explicit faceUp override applies uniformly to every card in that action, ignoring the pattern', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-5card'); // position 0 would normally be down
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1', true); // override: force face-up for this action
  const hand = room.getPlayer('p1').hand;
  assert.deepStrictEqual(hand.map((c) => c.faceUp), [true, true]);
});

test('toRedactedState: a face-up card in another player\'s hand is visible to everyone; the rest stays hidden', () => {
  const room = studRoomAtStreetBBetting('stud-5card', 'Alice', 'Bob'); // down, up, up, up, up -- 3 cards dealt so far

  const forP1 = room.toRedactedState('p1');
  const p2View = forP1.players.find((p) => p.id === 'p2').hand;
  assert.strictEqual(p2View[0].faceUp, false);
  assert.strictEqual(p2View[0].suit, undefined); // hidden card: no data leaked
  assert.strictEqual(p2View[1].faceUp, true);
  assert.strictEqual(typeof p2View[1].suit, 'string'); // visible up-card: real data
});

test('Community cards: always full visibility to everyone, never redacted', () => {
  const room = holdemRoomAtFlop('holdem-texas', 'Alice', 'Bob');
  const forP2 = room.toRedactedState('p2');
  assert.strictEqual(forP2.communityCards.length, 3);
  assert.strictEqual(forP2.communityCards.every((c) => c.faceUp === true && typeof c.suit === 'string'), true);
});

// ---------------------------------------------------------------
// v4.0: Deal to Specific Player
// ---------------------------------------------------------------


test('dealToPlayer: Dealer-only, targets a non-folded player, auto-calculates count from the preset', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card'); // dealToPlayer stays ungated regardless of handPhase; cardsPerPlayer: 7
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(7, 'p1'); // -> StreetABetting; dealing all 7 in one action is fine, deal() doesn't enforce per-street counts
  room.discard('p2', room.getPlayer('p2').hand.slice(0, 3).map((c) => c.id)); // p2 now has 4 cards
  assert.strictEqual(room.dealToPlayer('p2', 'p2').ok, false); // not Dealer
  const result = room.dealToPlayer('p1', 'p2'); // auto-calc: 7 - 4 = 3
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').hand.length, 7);
});

test('dealToPlayer: Dealer can override the auto-calculated count', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(7, 'p1');
  const result = room.dealToPlayer('p1', 'p2', 1); // override: just 1, regardless of preset math
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').hand.length, 8);
});

test('dealToPlayer: rejects a folded target, but has no other eligibility check (spec §5.2/§12)', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card');
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(7, 'p1'); // -> StreetABetting
  // p1 (Dealer) is also selected as opening bettor here so the Bring-In
  // obligation lands on them, not p2 -- p2 needs to be free to fold below,
  // and the Bring-In can't be folded (§6.8), so it can't sit with p2.
  room.setOpeningBettor('p1', 'p1');
  room.openBetting('p1');
  room.call('p1'); // pays the Bring-In, clears the obligation, turn moves to p2
  room.fold('p2');
  assert.strictEqual(room.dealToPlayer('p1', 'p2', 1).ok, false); // folded -> rejected
  // p3 never discarded anything, yet the server still allows dealing to them --
  // no "did they actually discard" check exists, by design.
  assert.strictEqual(room.dealToPlayer('p1', 'p3', 1).ok, true);
});

test('dealToPlayer: new cards default private unless the active Stud pattern says otherwise', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-5card'); // down, up, up, up, up
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(2, 'p1'); // positions 0,1 -> down, up
  const result = room.dealToPlayer('p1', 'p2'); // position 2 -> up
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').hand[2].faceUp, true);
});

// ---------------------------------------------------------------
// v4.0: Deal Community Cards
// ---------------------------------------------------------------


/** Drives an open betting round to close, calling if something's owed (correct for PreFlopBetting per §6.7), checking otherwise. */
function actUntilRoundCloses(room) {
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) {
    const p = room.getPlayer(room.currentTurnPlayerId);
    if (p.currentBet < room.currentBetToCall) room.call(p.id);
    else room.check(p.id);
  }
}

test('dealCommunity: infers flop/turn/river street size from how many community cards already exist', () => {
  const room = holdemRoomAtPreFlopBetting('holdem-texas', 'Alice', 'Bob', 'Carl'); // communityPattern: [3,1,1]
  assert.strictEqual(room.dealCommunity('p2').ok, false); // not Dealer (also wrong phase -- either reason rejects)
  room.openBetting('p1');
  actUntilRoundCloses(room);
  assert.strictEqual(room.handPhase, 'Flop');

  room.dealCommunity('p1'); // flop -> 3
  assert.strictEqual(room.communityCards.length, 3);
  assert.strictEqual(room.handPhase, 'FlopBetting');

  room.openBetting('p1');
  actUntilRoundCloses(room);
  room.dealCommunity('p1'); // turn -> 1
  assert.strictEqual(room.communityCards.length, 4);

  room.openBetting('p1');
  actUntilRoundCloses(room);
  room.dealCommunity('p1'); // river -> 1
  assert.strictEqual(room.communityCards.length, 5);
});

test('dealCommunity: Dealer can override the inferred count', () => {
  const room = holdemRoomAtPreFlopBetting('holdem-texas', 'Alice', 'Bob');
  room.openBetting('p1');
  actUntilRoundCloses(room);
  const result = room.dealCommunity('p1', 5); // override: all 5 at once
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.communityCards.length, 5);
});

test('dealCommunity: cards are always face-up, no down option', () => {
  const room = holdemRoomAtFlop('holdem-texas', 'Alice', 'Bob');
  assert.strictEqual(room.communityCards.every((c) => c.faceUp === true), true);
});

// ---------------------------------------------------------------
// v4.0: Burn
// ---------------------------------------------------------------


test('burn: Dealer-only, moves the top card of the deck to the discard pile unseen', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  const deckBefore = room.deck.length;
  assert.strictEqual(room.burn('p2').ok, false); // not Dealer
  const result = room.burn('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.deck.length, deckBefore - 1);
  assert.strictEqual(room.discardPile.length, 1);
});

test('burn: general-purpose, works with no Game Choice active at all', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.profile, null);
  assert.strictEqual(room.burn('p1').ok, true);
});

// ---------------------------------------------------------------
// v4.0: Advance
// ---------------------------------------------------------------


test('passTheBuck (default target): moves the Dealer button to the next non-sitting-out seat', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  const result = room.passTheBuck('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').isDealer, false);
  assert.strictEqual(room.getPlayer('p2').isDealer, true);
});

test('passTheBuck (default target): skips a sitting-out seat when moving the button', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.sitOut('p2', 'foldAndSitOut');
  room.passTheBuck('p1');
  assert.strictEqual(room.getPlayer('p3').isDealer, true); // p2 skipped
});

test('passTheBuck (4.3): gated by idle, not directly by bettingOpen -- a new room is idle, so an open (but never-dealt) round does not block it', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  assert.strictEqual(room.idle, true); // new room starts idle
  room.openBetting('p1'); // opening betting does not by itself touch idle
  assert.strictEqual(room.idle, true);
  assert.strictEqual(room.passTheBuck('p1').ok, true); // idle is still true -> allowed
});

test('passTheBuck (4.3): rejected once idle is false (a Deal happened), including while a claim is pending', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 100);
  room.buyChips('p2', 100);
  room.deal(1, 'p1'); // idle -> false
  assert.strictEqual(room.idle, false);
  assert.strictEqual(room.passTheBuck('p1').ok, false);

  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.call('p1');
  room.claimPot('p2', [{ playerId: 'p2', amount: 40 }]);
  assert.strictEqual(room.passTheBuck('p1').ok, false); // pending claim -> still not idle

  room.resolveClaim('p1', false); // rejected claim does NOT affect idle (spec §4.1)
  assert.strictEqual(room.idle, false);
  assert.strictEqual(room.passTheBuck('p1').ok, false);
});

test('passTheBuck (4.3): usable again once idle is restored by an approved claim, even before Reshuffle', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 100);
  room.buyChips('p2', 100);
  room.deal(1, 'p1');
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.call('p1');
  room.claimPot('p2', [{ playerId: 'p2', amount: 40 }]);
  room.resolveClaim('p1', true); // approved -> idle true immediately
  assert.strictEqual(room.idle, true);
  assert.strictEqual(room.passTheBuck('p1').ok, true);
});

test('passTheBuck (4.3): Reshuffle always restores idle, independent of any claim', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.deal(1, 'p1');
  assert.strictEqual(room.idle, false);
  room.reshuffle('p1');
  assert.strictEqual(room.idle, true);
});

test('BUG FIX (4.4): passTheBuck no longer applies any ante/blind for blind-type Game Choices -- pure role transfer', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.setGameChoice('p1', 'holdem-texas'); // anteType: blind, smallBlind:5, bigBlind:10
  room.passTheBuck('p1'); // p1 -> p2 is new Dealer
  assert.strictEqual(room.getPlayer('p2').isDealer, true);
  assert.strictEqual(room.getPlayer('p3').oweAnte, 0);
  assert.strictEqual(room.getPlayer('p1').oweAnte, 0);
});

test('BUG FIX (4.4): passTheBuck no longer applies any ante/blind for flat-ante Game Choices -- pure role transfer', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.setGameChoice('p1', 'draw-5card'); // anteType: flat, anteAmount: 1
  room.passTheBuck('p1');
  assert.strictEqual(room.getPlayer('p1').oweAnte, 0);
  assert.strictEqual(room.getPlayer('p2').oweAnte, 0);
  assert.strictEqual(room.getPlayer('p3').oweAnte, 0);
});

test('passTheBuck (default target): no auto-ante assignment at all when no Game Choice is active', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.passTheBuck('p1');
  assert.strictEqual(room.players.every((p) => p.oweAnte === 0), true);
});

// ---------------------------------------------------------------
// v4.0: Discard -- folded rejection + maxDiscards enforcement
// ---------------------------------------------------------------


test('discard: rejects a folded player (new restriction in 4.0)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.deal(2, 'p1');
  room.openBetting('p1'); // turn -> p2
  room.fold('p2');
  assert.strictEqual(room.discard('p2', [room.getPlayer('p2').hand[0].id]).ok, false);
});

test('discard: enforces maxDiscards when a Game Choice defines one', () => {
  const room = drawRoomAtDiscardPhase('draw-5card', 'Alice', 'Bob'); // maxDiscards: 4
  const hand = room.getPlayer('p2').hand;
  const tooMany = room.discard('p2', hand.map((c) => c.id)); // all 5, exceeds max of 4
  assert.strictEqual(tooMany.ok, false);
  const okDiscard = room.discard('p2', hand.slice(0, 4).map((c) => c.id)); // exactly 4
  assert.strictEqual(okDiscard.ok, true);
  assert.strictEqual(room.getPlayer('p2').discardCountThisHand, 4);
});

test('discard (5.0): once per hand -- a second discard is rejected even with allowance remaining, via discardPhaseActed', () => {
  const room = drawRoomAtDiscardPhase('draw-5card', 'Alice', 'Bob'); // maxDiscards: 4
  const hand = room.getPlayer('p2').hand;
  const first = room.discard('p2', hand.slice(0, 2).map((c) => c.id)); // 2 of 4 allowed
  assert.strictEqual(first.ok, true);
  assert.strictEqual(room.getPlayer('p2').discardPhaseActed, true);
  const second = room.discard('p2', [hand[2].id]); // trying again -- rejected, once per hand
  assert.strictEqual(second.ok, false);
  assert.strictEqual(room.getPlayer('p2').discardCountThisHand, 2); // unchanged by the rejected attempt
});

test('discard (4.1): still unrestricted (multiple actions allowed) when no maxDiscards is defined', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card'); // no maxDiscards -- the once-per-hand rule is scoped to maxDiscards presets
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(7, 'p1');
  const hand = room.getPlayer('p2').hand;
  room.discard('p2', [hand[0].id]);
  const second = room.discard('p2', [hand[1].id]); // second action, still fine (no restriction active)
  assert.strictEqual(second.ok, true);
});

test('mucked pile (4.1): grows on discard, visible in redacted state, swept on redraw', () => {
  const room = drawRoomAtDiscardPhase('draw-5card', 'Alice', 'Bob');
  const hand = room.getPlayer('p2').hand;
  room.discard('p2', hand.slice(0, 2).map((c) => c.id));
  assert.strictEqual(room.getPlayer('p2').mucked, 2);
  assert.strictEqual(room.toRedactedState('p1').players.find((p) => p.id === 'p2').mucked, 2);

  room.standPat('p1'); // dealer stands pat so DrawPhase's completion doesn't need p1 to discard too
  room.dealToPlayer('p1', 'p2'); // redraw -- sweeps the muck pile
  assert.strictEqual(room.getPlayer('p2').mucked, 0);
});

test('mucked pile: resets on New Hand, same lifecycle as discardCountThisHand', () => {
  const room = drawRoomAtFirstBetting('draw-5card-jacks', 'Alice', 'Bob', 'Carl'); // reAnteable, requiresOpeners
  room.openBetting('p1'); // turn -> p2
  room.placeBet('p2', 20); // someone actually opens -- avoids Trigger A, advances normally
  room.call('p3');
  room.call('p1');
  assert.strictEqual(room.handPhase, 'DiscardPhase');

  room.discard('p2', [room.getPlayer('p2').hand[0].id]);
  assert.strictEqual(room.getPlayer('p2').mucked, 1);
  assert.strictEqual(room.getPlayer('p2').discardCountThisHand, 1);

  // Drive the rest of the hand to Showdown, then trigger New Hand (nobody claims).
  room.standPat('p1');
  room.standPat('p3');
  room.dealToAllPlayers('p1');
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) room.check(room.currentTurnPlayerId);
  assert.strictEqual(room.handPhase, 'Showdown');

  room.newHand('p1');
  assert.strictEqual(room.getPlayer('p2').mucked, 0);
  assert.strictEqual(room.getPlayer('p2').discardCountThisHand, 0);
});

test('setGameChoice: Stud now uses the phase machine, same as Draw/Hold\'em -- reshuffle stays blocked (NEW 7.0)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-5card');
  room.startGame('p1'); // -> RequestAntes, idle -> false (phase-derived, same mechanism as Draw/Hold'em)
  assert.strictEqual(room.idle, false);
  assert.strictEqual(room.setGameChoice('p1', 'stud-7card').ok, false); // blocked mid-hand
  assert.strictEqual(room.reshuffle('p1').ok, false); // NEW 7.0: no longer available for Stud at all
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id); // -> StreetA
  room.deal(2, 'p1'); // -> StreetABetting
  assert.strictEqual(room.setGameChoice('p1', 'stud-7card').ok, false); // still blocked mid-hand
});

test('setGameChoice: gated by idle, for Draw this now means PreGame/CycleComplete specifically', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  assert.strictEqual(room.setGameChoice('p1', 'draw-5card').ok, true); // idle by default -> fine
  room.startGame('p1'); // -> RequestAntes, idle -> false
  assert.strictEqual(room.idle, false);
  assert.strictEqual(room.setGameChoice('p1', 'stud-5card').ok, false); // blocked mid-hand
  // Switch to a non-Draw profile to demonstrate the same gate still applies there via the old idle mechanism.
  for (const p of room.players) { if (p.oweAnte > 0) room.postAnteBlind(p.id); }
  room.deal(room.gameOptions.cardsPerPlayer, 'p1'); // -> FirstBetting
  assert.strictEqual(room.setGameChoice('p1', 'stud-5card').ok, false); // still blocked
});

test('idle (4.1): true on room creation, false only after Deal', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  assert.strictEqual(room.idle, true);
  room.deal(1, 'p1');
  assert.strictEqual(room.idle, false);
});

test('discard: no limit enforced when the active Game Choice has no maxDiscards (e.g. Stud)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card'); // no maxDiscards key
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(7, 'p1');
  const hand = room.getPlayer('p2').hand;
  const result = room.discard('p2', hand.map((c) => c.id)); // discard all 7, no cap defined
  assert.strictEqual(result.ok, true);
});

test('discardCountThisHand resets on Deal and on Reshuffle', () => {
  const room = tableWithPlayers('Alice', 'Bob'); // no Game Choice active -> fully ungated
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.deal(5, 'p1');
  room.discard('p2', room.getPlayer('p2').hand.slice(0, 2).map((c) => c.id));
  assert.strictEqual(room.getPlayer('p2').discardCountThisHand, 2);
  room.deal(1, 'p1'); // any new Deal call resets everyone
  assert.strictEqual(room.getPlayer('p2').discardCountThisHand, 0);

  room.discard('p2', [room.getPlayer('p2').hand[0].id]);
  assert.strictEqual(room.getPlayer('p2').discardCountThisHand, 1);
  room.reshuffle('p1');
  assert.strictEqual(room.getPlayer('p2').discardCountThisHand, 0);
});

// ---------------------------------------------------------------
// v4.0: Reshuffle folds community cards back in, preserves Game Choice
// ---------------------------------------------------------------


test('Reshuffle: community cards fold back into the deck and reset to empty', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  // NEW 7.0: reshuffle() is now blocked for all three primary profiles
  // (Draw, Hold'em, Stud), since all three run on the phase machine --
  // the only room left where reshuffle stays available is one with no
  // Game Choice selected at all, so that's what this exercises now.
  room.dealCommunity('p1', 5);
  const deckBefore = room.deck.length;
  room.reshuffle('p1');
  assert.strictEqual(room.communityCards.length, 0);
  assert.strictEqual(room.deck.length, deckBefore + 5);
});

test('reshuffle: blocked for Stud, same as Draw and Hold\'em (NEW 7.0 -- was previously unblocked)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'stud-7card');
  assert.strictEqual(room.reshuffle('p1').ok, false);
  // gameChoiceId/profile/gameOptions are untouched by the rejected call --
  // there's nothing to "persist across reshuffle" for Stud any more, since
  // reshuffle never runs while a Stud Game Choice is active (§12) -- this
  // replaces the pre-7.0 version of this test, which relied on Stud still
  // being a flexible-toolbox profile where reshuffle stayed available.
  assert.strictEqual(room.gameChoiceId, 'stud-7card');
  assert.strictEqual(room.profile, 'stud');
  assert.deepStrictEqual(room.gameOptions.pattern, ['down', 'down', 'up', 'up', 'up', 'up', 'down']);
});

// ---------------------------------------------------------------
// v4.2: Game Choice preset flags (reAnteable / advanceTurnRequired / burnAvailable)
// ---------------------------------------------------------------


test('Game Choice flags: confirmed values resolve exactly for the 3 Draw presets', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'draw-5card');
  assert.strictEqual(room.reAnteable, false);
  assert.strictEqual(room.advanceTurnRequired, false);
  assert.strictEqual(room.burnAvailable, false);

  room.setGameChoice('p1', 'draw-5card-jacks');
  assert.strictEqual(room.reAnteable, true);
  assert.strictEqual(room.advanceTurnRequired, false);
  assert.strictEqual(room.burnAvailable, false);
});

test('Game Choice flags: Stud/Hold\'em presets fall back to DEFAULT_PRESET_FLAGS (not yet determined)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'stud-7card');
  assert.strictEqual(room.reAnteable, DEFAULT_PRESET_FLAGS.reAnteable);
  assert.strictEqual(room.advanceTurnRequired, DEFAULT_PRESET_FLAGS.advanceTurnRequired);
  assert.strictEqual(room.burnAvailable, DEFAULT_PRESET_FLAGS.burnAvailable);
  assert.strictEqual(room.advanceTurnRequired, true); // sanity-check the literal default
  assert.strictEqual(room.burnAvailable, true);
});

test('Game Choice flags: before any Game Choice is selected, defaults match "always on" pre-4.2 behavior', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.reAnteable, false);
  assert.strictEqual(room.advanceTurnRequired, true);
  assert.strictEqual(room.burnAvailable, true);
});

// ---------------------------------------------------------------
// v4.2: Burn pile visual count
// ---------------------------------------------------------------


test('burnedThisHand: increments on burn(), resets on Deal and Reshuffle', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.burn('p1');
  room.burn('p1');
  assert.strictEqual(room.burnedThisHand, 2);
  room.deal(1, 'p1');
  assert.strictEqual(room.burnedThisHand, 0);

  room.burn('p1');
  room.reshuffle('p1');
  assert.strictEqual(room.burnedThisHand, 0);
});

test('burnedThisHand: visible in redacted state to everyone', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.burn('p1');
  assert.strictEqual(room.toRedactedState('p2').burnedThisHand, 1);
});

// ---------------------------------------------------------------
// v4.2: Advance auto-applies flat antes too (see the fixed test above);
// setAnteBlind remains server-unrestricted regardless of reAnteable
// ---------------------------------------------------------------


test('setAnteBlind: still works server-side even when reAnteable is false (UI-gated only, not server-enforced)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'draw-5card'); // reAnteable: false
  const result = room.setAnteBlind('p1', 'p2', 7);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').oweAnte, 7);
});

// ---------------------------------------------------------------
// v4.2: Sit In queues via idle instead of taking effect immediately
// ---------------------------------------------------------------


test('sitIn (4.2): takes effect immediately while idle', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.sitOut('p2', 'foldAndSitOut');
  assert.strictEqual(room.idle, true);
  const result = room.sitIn('p2');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').sittingOut, false);
  assert.strictEqual(room.getPlayer('p2').sitInPending, false);
});

test('sitIn (4.2): queues via sitInPending when a hand is in progress, resolves on the next Reshuffle', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.sitOut('p3', 'foldAndSitOut');
  room.deal(1, 'p1'); // idle -> false (p1, p2 still active)
  const result = room.sitIn('p3');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p3').sittingOut, true); // NOT yet -- still queued
  assert.strictEqual(room.getPlayer('p3').sitInPending, true);

  room.reshuffle('p1'); // idle -> true, resolves the queue
  assert.strictEqual(room.getPlayer('p3').sittingOut, false);
  assert.strictEqual(room.getPlayer('p3').sitInPending, false);
});

test('sitIn (4.2): also resolves on an approved claim, even before Reshuffle', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 100);
  room.buyChips('p2', 100);
  room.sitOut('p3', 'foldAndSitOut');
  room.deal(1, 'p1');
  room.sitIn('p3'); // queued
  room.openBetting('p1');
  room.placeBet('p2', 20);
  room.call('p1');
  room.claimPot('p2', [{ playerId: 'p2', amount: 40 }]);
  room.resolveClaim('p1', true); // idle -> true
  assert.strictEqual(room.getPlayer('p3').sittingOut, false);
  assert.strictEqual(room.getPlayer('p3').sitInPending, false);
});

test('sitIn (4.2): rejects a duplicate request while already pending', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.sitOut('p3', 'foldAndSitOut');
  room.deal(1, 'p1');
  room.sitIn('p3');
  assert.strictEqual(room.sitIn('p3').ok, false);
});

// ---------------------------------------------------------------
// v4.3: Reshuffle bug fix -- bettingRoundsThisHand/discardWindowOpen
// must reset on Reshuffle too, not just Deal (the reported deadlock)
// ---------------------------------------------------------------


test('BUG FIX (4.3): Reshuffle resets bettingRoundsThisHand and discardWindowOpen -- the Deal button no longer vanishes permanently', () => {
  // Historical regression test for a 4.1-4.2 bug. As of 5.0/6.0/7.0, this
  // failure mode is structurally impossible for Draw, Hold'em, or Stud --
  // the phase machine (handPhase) replaced these fields as each profile's
  // gating mechanism, and Reshuffle is blocked outright for all three now
  // anyway. The fields themselves, and Reshuffle resetting them, remain
  // real and exercised for a room with no Game Choice active at all (the
  // only scenario left where the pre-5.0 flexible-toolbox model still
  // applies), so the regression coverage moves there.
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.deal(7, 'p1');
  room.openBetting('p1'); // bettingRoundsThisHand -> 1
  room.check('p2');
  room.check('p3');
  room.check('p1'); // auto-closes
  room.openBetting('p1'); // bettingRoundsThisHand -> 2, discardWindowOpen closes
  room.check('p2');
  room.check('p3');
  room.check('p1');
  assert.strictEqual(room.bettingRoundsThisHand, 2);
  assert.strictEqual(room.discardWindowOpen, false);

  room.reshuffle('p1');
  assert.strictEqual(room.bettingRoundsThisHand, 0);
  assert.strictEqual(room.discardWindowOpen, true);
});

// ---------------------------------------------------------------
// v4.3: Pass the Buck (merged Transfer Dealer + Advance)
// ---------------------------------------------------------------


test('passTheBuck (5.0): no longer accepts a target at all -- always moves to the next active seat', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.sitOut('p2', 'foldAndSitOut'); // next active seat should skip p2
  const result = room.passTheBuck('p1'); // no second argument possible anymore
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p3').isDealer, true); // p2 skipped, landed on p3
  assert.strictEqual(room.passTheBuck.length, 1); // requesterId only, by construction
});

test('passTheBuck: for Draw, gated by handPhase (PreGame/CycleComplete) rather than idle directly', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  room.startGame('p1'); // -> RequestAntes
  assert.strictEqual(room.passTheBuck('p1').ok, false); // not PreGame/CycleComplete
  for (const p of room.players) { if (p.oweAnte > 0) room.postAnteBlind(p.id); }
  room.deal(room.gameOptions.cardsPerPlayer, 'p1'); // -> FirstBetting
  assert.strictEqual(room.passTheBuck('p1').ok, false); // still not idle-equivalent for Draw
});

test('passTheBuck: for non-Draw profiles, still gated by the old idle mechanism', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.deal(1, 'p1'); // idle -> false (non-Draw deal is ungated)
  assert.strictEqual(room.passTheBuck('p1').ok, false);
  room.reshuffle('p1'); // idle -> true (reshuffle not blocked for non-Draw)
  assert.strictEqual(room.passTheBuck('p1').ok, true);
});

test('BUG FIX (4.4, still true in 5.0): passTheBuck applies no ante/blind, blind-type or flat-type', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl', 'Dana');
  room.setGameChoice('p1', 'holdem-texas'); // anteType: blind, non-Draw profile -- idle-gated, ungated here
  const result = room.passTheBuck('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p2').isDealer, true);
  assert.strictEqual(room.getPlayer('p3').oweAnte, 0);
  assert.strictEqual(room.getPlayer('p1').oweAnte, 0);
});

// ---------------------------------------------------------------
// v4.3: Start Game
// ---------------------------------------------------------------


test('startGame: applies the ante/blind for the CURRENT Dealer without moving the role', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000); // NEW 9.2: $0-chip players are auto-sat-out at RequestAntes
  room.setGameChoice('p1', 'holdem-texas');
  const result = room.startGame('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').isDealer, true); // unchanged
  assert.strictEqual(room.getPlayer('p2').oweAnte, 5); // seat after the still-current Dealer
  assert.strictEqual(room.getPlayer('p3').oweAnte, 10);
});

test('startGame: works for flat-ante games too, applies to every active player', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000); // NEW 9.2: $0-chip players are auto-sat-out at RequestAntes
  room.setGameChoice('p1', 'draw-5card');
  room.startGame('p1');
  assert.strictEqual(room.getPlayer('p1').oweAnte, 1);
  assert.strictEqual(room.getPlayer('p2').oweAnte, 1);
  assert.strictEqual(room.getPlayer('p3').oweAnte, 1);
});

test('startGame: Dealer-only, requires an active Game Choice, gated for Draw by handPhase not idle directly', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  assert.strictEqual(room.startGame('p2').ok, false); // not Dealer
  assert.strictEqual(room.startGame('p1').ok, false); // no Game Choice yet
  room.setGameChoice('p1', 'draw-5card');
  room.startGame('p1'); // -> RequestAntes
  assert.strictEqual(room.startGame('p1').ok, false); // not PreGame/CycleComplete anymore
});

test('startGame: performs a full reset as one atomic step with the ante, even mid-Cycle', () => {
  const room = drawRoomAtShowdown('draw-5card', 'Alice', 'Bob', 'Carl');
  // Claim and approve to reach CycleComplete (the state startGame needs).
  const claimResult = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(claimResult.ok, true);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.handPhase, 'CycleComplete');
  assert.strictEqual(room.getPlayer('p1').hand.length, 5); // still holding cards from the finished hand

  const result = room.startGame('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').hand.length, 0); // hands cleared
  assert.strictEqual(room.bettingRoundsThisHand, 0); // reset
  assert.strictEqual(room.discardWindowOpen, true); // reset
  assert.strictEqual(room.getPlayer('p1').folded, false); // folded cleared (unlike New Hand)
  assert.strictEqual(room.handPhase, 'RequestAntes'); // NOT dealt yet -- that's now a separate step (5.0)
  assert.strictEqual(room.getPlayer('p1').isDealer, true); // role unchanged
});

test('startGame (4.4): clears rabbitHuntAvailable/rabbitHuntCards as part of the reset', () => {
  // CHANGED 8.3: needs a genuine Hold'em early-claim-before-River fixture
  // to get rabbitHuntAvailable true in the first place, now that it's
  // Hold'em-only -- see profiles/holdem.test.js for the dedicated Rabbit
  // Hunt coverage; this test just confirms startGame's own reset
  // behavior still works once that flag is set, which is still a
  // perfectly generic (non-Hold'em-specific) concern.
  const room = holdemRoomAtPreFlopBetting('holdem-texas', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1'); // turn -> p1 (UTG)
  room.fold('p1'); // turn -> p2
  room.fold('p2'); // turn -> p3, only p3 active now
  room.claimPot('p3', [{ playerId: 'p3', amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  room.rabbitHunt('p1'); // Dealer-only -- p1 is still Dealer despite having folded
  assert.strictEqual(room.rabbitHuntCards.length, 1);

  room.setGameChoice('p1', 'draw-5card'); // p1 is still Dealer -- folding doesn't transfer that role
  room.startGame('p1');
  assert.strictEqual(room.rabbitHuntAvailable, false);
  assert.strictEqual(room.rabbitHuntCards.length, 0);
});

// ---------------------------------------------------------------
// v4.3: setGameOption now idle-gated too
// ---------------------------------------------------------------


test('setGameOption: rejected once a hand is in progress, matching setGameChoice\'s existing gate', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.buyChips('p1', 1000);
  room.buyChips('p2', 1000);
  room.setGameChoice('p1', 'draw-5card');
  assert.strictEqual(room.setGameOption('p1', 'maxDiscards', 2).ok, true); // idle -> fine
  room.startGame('p1'); // idle -> false (RequestAntes)
  assert.strictEqual(room.setGameOption('p1', 'maxDiscards', 3).ok, false);
  for (const p of room.players) { if (p.oweAnte > 0) room.postAnteBlind(p.id); }
  room.deal(room.gameOptions.cardsPerPlayer, 'p1'); // FirstBetting -- still not idle
  assert.strictEqual(room.setGameOption('p1', 'maxDiscards', 3).ok, false);
});

// ---------------------------------------------------------------
// v4.4: Deal now skips folded players
// ---------------------------------------------------------------


test('BUG FIX/NEW RULE (4.4): Deal skips folded players -- a no-op in the ordinary case', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.deal(2, 'p1');
  assert.strictEqual(room.getPlayer('p1').hand.length, 2);
  assert.strictEqual(room.getPlayer('p2').hand.length, 2);
  assert.strictEqual(room.getPlayer('p3').hand.length, 2);
});

test('Deal: actually skips a folded player when one exists (only reachable in practice via Redeal)', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.openBetting('p1'); // turn -> p2
  room.fold('p2');
  // Force back to a state where Deal can run again despite the fold,
  // to exercise the skip directly (Redeal is the real-world path to this).
  room.bettingOpen = false;
  const result = room.deal(2, 'p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').hand.length, 2);
  assert.strictEqual(room.getPlayer('p2').hand.length, 0); // folded -- skipped
  assert.strictEqual(room.getPlayer('p3').hand.length, 2);
});

// ---------------------------------------------------------------
// v4.4: Deal to All Players
// ---------------------------------------------------------------


test('dealToAllPlayers: deals each eligible player their own correct auto-calculated count', () => {
  const room = drawRoomAtDiscardPhase('draw-5card', 'Alice', 'Bob', 'Carl'); // cardsPerPlayer: 5
  room.discard('p2', room.getPlayer('p2').hand.slice(0, 2).map((c) => c.id)); // p2 now has 3
  room.discard('p3', [room.getPlayer('p3').hand[0].id]); // p3 now has 4
  room.standPat('p1'); // dealer stands pat -- completes DiscardPhase -> DrawPhase
  assert.strictEqual(room.handPhase, 'DrawPhase');

  const result = room.dealToAllPlayers('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').hand.length, 5); // already full -- untouched
  assert.strictEqual(room.getPlayer('p2').hand.length, 5); // +2
  assert.strictEqual(room.getPlayer('p3').hand.length, 5); // +1
});

test('dealToAllPlayers: excludes folded and sitting-out players', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'Alice', 'Bob', 'Carl');
  room.openBetting('p1'); // turn -> p2
  room.fold('p2'); // turn -> p3
  room.check('p3');
  room.check('p1'); // round 1 auto-closes
  assert.strictEqual(room.handPhase, 'DiscardPhase');
  room.discard('p3', [room.getPlayer('p3').hand[0].id]);
  room.standPat('p1');
  assert.strictEqual(room.handPhase, 'DrawPhase');
  room.sitOut('p3', 'foldAndSitOut'); // p3 already discarded, but sits out before the draw itself
  room.dealToAllPlayers('p1');
  assert.strictEqual(room.getPlayer('p2').hand.length, 5); // folded -- excluded from the draw, but folding never touched their original hand
  assert.strictEqual(room.getPlayer('p3').hand.length, 4); // sitting out now -- excluded despite having discarded
});

test('dealToAllPlayers: Dealer-only, requires cardsPerPlayer, rejects when nobody needs cards (non-Draw)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  assert.strictEqual(room.dealToAllPlayers('p2').ok, false); // not Dealer
  assert.strictEqual(room.dealToAllPlayers('p1').ok, false); // no Game Choice -> no cardsPerPlayer
  room.setGameChoice('p1', 'stud-7card'); // dealToAllPlayers stays ungated regardless of handPhase
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  room.deal(7, 'p1'); // -> StreetABetting
  assert.strictEqual(room.dealToAllPlayers('p1').ok, false); // everyone's already full, non-Draw rejects
});

test('dealToAllPlayers (5.0): everyone Standing Pat is a valid no-op that still advances DrawPhase -> SecondBetting', () => {
  // The edge case my dealToAllPlayers() fix addresses: if every active
  // player Stands Pat, nobody needs cards, but the Dealer must still be
  // able to click Draw to advance the phase -- DrawPhase's only exit.
  const room = drawRoomAtDiscardPhase('draw-5card', 'Alice', 'Bob', 'Carl');
  for (const p of room._activePlayers()) room.standPat(p.id);
  assert.strictEqual(room.handPhase, 'DrawPhase');
  const result = room.dealToAllPlayers('p1');
  assert.strictEqual(result.ok, true); // succeeds despite dealing zero cards
  assert.strictEqual(room.handPhase, 'SecondBetting');
});

test('dealToAllPlayers: no override possible -- always each player\'s own correct count', () => {
  // dealToAllPlayers() intentionally has no count parameter at all; this
  // test documents that by construction rather than a runtime check.
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'draw-5card');
  assert.strictEqual(room.dealToAllPlayers.length, 1); // requesterId only
});

test('BUG FIX (4.4): folded status persists across multiple betting rounds within the same hand', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.openBetting('p1'); // round 1, turn -> p2
  room.fold('p2'); // turn -> p3
  room.check('p3');
  room.check('p1'); // round 1 auto-closes (p2 excluded from "everyone acted")
  assert.strictEqual(room.getPlayer('p2').folded, true);

  room.openBetting('p1'); // round 2 -- before the fix, this incorrectly un-folded p2
  assert.strictEqual(room.getPlayer('p2').folded, true); // still folded
  assert.strictEqual(room.currentTurnPlayerId, 'p3'); // action skips the still-folded p2 entirely
});

// ---------------------------------------------------------------
// v4.5: requiresOpeners flag resolution
// ---------------------------------------------------------------


test('Game Choice flags: requiresOpeners resolves correctly for Draw presets', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'draw-5card');
  assert.strictEqual(room.requiresOpeners, false);
  room.setGameChoice('p1', 'draw-5card-jacks');
  assert.strictEqual(room.requiresOpeners, true);
  room.setGameChoice('p1', 'draw-5card-jacks-trips');
  assert.strictEqual(room.requiresOpeners, true);
});

test('Game Choice flags: requiresOpeners falls back to false for Stud/Hold\'em (not yet determined)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'stud-7card');
  assert.strictEqual(room.requiresOpeners, DEFAULT_PRESET_FLAGS.requiresOpeners);
  assert.strictEqual(room.requiresOpeners, false);
});

test('Game Choice flags: requiresOpeners defaults false before any Game Choice is selected', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.requiresOpeners, false);
});

// ---------------------------------------------------------------
// v4.5: Suggested Buy In
// ---------------------------------------------------------------


test('setSuggestedBuyIn: room creator only, mirrors setTableName\'s permission pattern', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.suggestedBuyIn, null);
  assert.strictEqual(room.setSuggestedBuyIn('p2', 50).ok, false); // not the creator
  const result = room.setSuggestedBuyIn('p1', 50);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.suggestedBuyIn, 50);
});

test('setSuggestedBuyIn: null/undefined/empty clears it; 0 also clears it', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setSuggestedBuyIn('p1', 50);
  room.setSuggestedBuyIn('p1', null);
  assert.strictEqual(room.suggestedBuyIn, null);
  room.setSuggestedBuyIn('p1', 50);
  room.setSuggestedBuyIn('p1', 0);
  assert.strictEqual(room.suggestedBuyIn, null);
});

test('setSuggestedBuyIn: rejects negative or non-integer amounts', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  assert.strictEqual(room.setSuggestedBuyIn('p1', -5).ok, false);
  assert.strictEqual(room.setSuggestedBuyIn('p1', 12.5).ok, false);
});

test('suggestedBuyIn: visible in redacted state to everyone (not just the creator)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setSuggestedBuyIn('p1', 50);
  assert.strictEqual(room.toRedactedState('p2').suggestedBuyIn, 50);
});

// ---------------------------------------------------------------
// v5.3: Generalized claim-approval fallback
// ---------------------------------------------------------------


test('claimPot approver (5.3): still prefers an active player first when one exists, unchanged from before', () => {
  const room = drawRoomAtShowdown('draw-5card', 'Alice', 'Bob', 'Carl'); // p1 dealer, all 3 active
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.pendingClaim.approverId, 'p2'); // next active seat, as before
});

test('claimPot approver (5.3): falls back to the first folded player to the Dealer\'s left when no active player exists', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'Alice', 'Bob', 'Carl', 'Dana'); // p1 dealer
  room.openBetting('p1');
  room.fold('p2');
  room.fold('p3');
  room.fold('p4');
  assert.strictEqual(room._activePlayers().length, 1); // only the Dealer, p1, remains active
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.pendingClaim.approverId, 'p2'); // falls back to the first folded seat to the left
});

test('claimPot approver (5.3): a sitting-out player is skipped in BOTH the active-first search and the folded fallback', () => {
  const room = drawRoomAtFirstBetting('draw-5card', 'Alice', 'Bob', 'Carl', 'Dana'); // p1 dealer
  room.getPlayer('p3').folded = true; // p3 folded -- would be first in the fallback search except p2 is checked first
  room.getPlayer('p4').folded = true;
  room.getPlayer('p2').sittingOut = true; // sitting out, not folded -- must be skipped entirely, not used as fallback
  assert.strictEqual(room._activePlayers().length, 1);
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.pendingClaim.approverId, 'p3'); // skips sitting-out p2, lands on folded p3
});

test('claimPot approver (5.3): new open gap -- no eligible approver at all if every other seat is sitting out, none folded', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  room.buyChips('p1', 100);
  room.openBetting('p1'); // non-Draw, generic room -- approver fallback logic is profile-agnostic
  room.check('p2');
  room.check('p3');
  room.check('p1');
  room.sitOut('p2', 'sitOutNextGame');
  room.sitOut('p3', 'sitOutNextGame');
  // sitOutNextGame doesn't take effect until the next Deal/Reshuffle, so
  // directly flip their status to simulate the fully-stuck state for
  // this test (both sitting out, right now, neither folded).
  room.getPlayer('p2').sittingOut = true;
  room.getPlayer('p3').sittingOut = true;
  room.pot = 10; // force a claimable pot for this scenario
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: 10 }]);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /no eligible player/i);
});

// ---------------------------------------------------------------
// NEW 8.2: Claim Pot's Carry to Next Game (§6.5)
// ---------------------------------------------------------------

test('claimPot: carryAmount defaults to 0, matching every pre-8.2 call exactly', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.pot = 50;
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: 50 }]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.pendingClaim.carryAmount, 0);
});

test('claimPot: accepts an explicit carryAmount, validated as part of the sum-to-pot check', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.pot = 100;
  const short = room.claimPot('p1', [{ playerId: 'p1', amount: 50 }], 40); // 50 + 40 = 90, not 100
  assert.strictEqual(short.ok, false);
  assert.match(short.error, /must sum exactly to the pot/i);
  const exact = room.claimPot('p1', [{ playerId: 'p1', amount: 60 }], 40); // 60 + 40 = 100
  assert.strictEqual(exact.ok, true);
  assert.strictEqual(room.pendingClaim.carryAmount, 40);
});

test('claimPot: rejects a negative or non-integer carryAmount', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.pot = 100;
  assert.strictEqual(room.claimPot('p1', [{ playerId: 'p1', amount: 100 }], -10).ok, false);
  assert.strictEqual(room.claimPot('p1', [{ playerId: 'p1', amount: 100 }], 1.5).ok, false);
});

test('claimPot: a claim with NO player allocations at all is valid as long as carryAmount covers the whole pot', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.pot = 100;
  const result = room.claimPot('p1', [], 100);
  assert.strictEqual(result.ok, true);
});

test('resolveClaim: on approval, the carried amount stays in the pot instead of resetting to $0', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.pot = 100;
  room.claimPot('p1', [{ playerId: 'p1', amount: 60 }], 40);
  const chipsBefore = room.getPlayer('p1').chips;
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.pot, 40); // carried, not zeroed
  assert.strictEqual(room.getPlayer('p1').chips, chipsBefore + 60); // player allocation still moves to chips normally
});

test('resolveClaim: rejecting a claim with a carryAmount leaves the pot completely untouched, same as any other rejected claim', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.pot = 100;
  room.claimPot('p1', [{ playerId: 'p1', amount: 60 }], 40);
  room.resolveClaim(room.pendingClaim.approverId, false);
  assert.strictEqual(room.pot, 100);
});

test('resolveClaim: a normal claim with NO carryAmount still resets the pot to exactly $0, unchanged from pre-8.2 behavior', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.pot = 100;
  room.claimPot('p1', [{ playerId: 'p1', amount: 100 }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.pot, 0);
});

test('claimPot: available regardless of profile/preset -- not gated to split-pot/declareHighLowBoth presets specifically', () => {
  const room = drawRoomAtShowdown('draw-5card', 'Alice', 'Bob'); // an ordinary, non-split-pot preset, at a phase where claimPot is normally allowed
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: 1 }], room.pot - 1);
  assert.strictEqual(result.ok, true);
});

