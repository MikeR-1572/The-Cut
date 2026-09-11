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
  stackDeckTop,
} = require('../helpers');

// ---------------------------------------------------------------
// NEW 7.0: Stud's own handPhase state machine (§5.10) and Select
// Opening Bettor / Bring-In (§6.8)
// ---------------------------------------------------------------


test('GAME_CHOICES: all 10 Stud presets carry finalStreet and bringIn (NEW 7.0)', () => {
  const stud = GAME_CHOICES.filter((g) => g.profile === 'stud');
  assert.strictEqual(stud.length, 10);
  for (const preset of stud) {
    assert.ok(preset.finalStreet === 'D' || preset.finalStreet === 'E', `${preset.id} missing a valid finalStreet`);
    assert.strictEqual(typeof preset.dealerOptions.bringIn, 'number'); // CHANGED 8.1 (§3) -- bringIn lives in dealerOptions now, not a flat options bucket
  }
  const fiveCard = stud.find((g) => g.id === 'stud-5card');
  assert.strictEqual(fiveCard.finalStreet, 'D');
  const sevenCard = stud.find((g) => g.id === 'stud-7card');
  assert.strictEqual(sevenCard.finalStreet, 'E');
});

test('setGameChoice: resolves finalStreet, falling back to DEFAULT_PRESET_FLAGS.finalStreet if a preset omits it', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'stud-5card');
  assert.strictEqual(room.finalStreet, 'D');
  room.setGameChoice('p1', 'stud-7card');
  assert.strictEqual(room.finalStreet, 'E');
  room.setGameChoice('p1', 'draw-5card'); // non-Stud preset never sets finalStreet -- falls back to the default
  assert.strictEqual(room.finalStreet, DEFAULT_PRESET_FLAGS.finalStreet);
});

test('Phase machine (Stud, 5-Card): full sequence PreGame through Showdown to CycleComplete, ending at StreetD (no StreetE)', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  assert.strictEqual(room.handPhase, 'PreGame');
  const started = studRoomAtShowdown('stud-5card', 'Alice', 'Bob', 'Carl');
  assert.strictEqual(started.handPhase, 'Showdown');
  // 5-Card Stud: 2 initial (StreetA) + 1 each at B, C, D = 5 total, no StreetE ever touched.
  assert.strictEqual(started.getPlayer('p1').hand.length, 5);
  const claim = started.claimPot('p1', [{ playerId: 'p1', amount: started.pot }]);
  assert.strictEqual(claim.ok, true);
  started.resolveClaim(started.pendingClaim.approverId, true);
  assert.strictEqual(started.handPhase, 'CycleComplete');
  assert.strictEqual(started.idle, true);
});

test('Phase machine (Stud, 7-Card): goes through StreetE before Showdown, 7 cards total', () => {
  const room = studRoomAtShowdown('stud-7card', 'Alice', 'Bob', 'Carl');
  assert.strictEqual(room.handPhase, 'Showdown');
  assert.strictEqual(room.getPlayer('p1').hand.length, 7);
});

test('Select Opening Bettor (§6.8): openBetting is rejected until a valid selection exists', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob');
  assert.strictEqual(room.openBetting('p1').ok, false); // openingBettorId still null
  const setResult = room.setOpeningBettor('p1', 'p2');
  assert.strictEqual(setResult.ok, true);
  assert.strictEqual(room.openingBettorId, 'p2');
  assert.strictEqual(room.openBetting('p1').ok, true);
});

test('Select Opening Bettor (§6.8): Dealer-only, must target an active (not folded, not sitting out) player', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob', 'Carl');
  assert.strictEqual(room.setOpeningBettor('p2', 'p1').ok, false); // not Dealer
  room.getPlayer('p3').folded = true;
  assert.strictEqual(room.setOpeningBettor('p1', 'p3').ok, false); // folded target rejected
  assert.strictEqual(room.setOpeningBettor('p1', 'not-a-real-player').ok, false);
  assert.strictEqual(room.setOpeningBettor('p1', 'p2').ok, true);
});

test('Select Opening Bettor (§6.8): the selected player themselves acts first, not "the seat after them"', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob', 'Carl'); // p1 dealer
  room.setOpeningBettor('p1', 'p3'); // deliberately NOT the seat after the dealer
  room.openBetting('p1');
  assert.strictEqual(room.currentTurnPlayerId, 'p3'); // p3 themselves, unlike Draw/Hold'em's anchor+1 convention
});

test('Select Opening Bettor (§6.8): re-selected fresh every street -- resets to null once Deal fires for the next street', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob');
  studCloseBettingRound(room, 'p1'); // closes StreetABetting (p1 pays Bring In, p2 calls) -> StreetB
  assert.strictEqual(room.handPhase, 'StreetB');
  studDealNextStreet(room); // -> StreetBBetting -- this is what resets openingBettorId, not the round closing
  assert.strictEqual(room.openingBettorId, null); // fresh selection required for StreetB too
  assert.strictEqual(room.openBetting('p1').ok, false); // must select again before this street can open
});

test('Select Opening Bettor (§6.8): cannot be changed once betting is already open for the street', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob');
  room.setOpeningBettor('p1', 'p1');
  room.openBetting('p1');
  assert.strictEqual(room.setOpeningBettor('p1', 'p2').ok, false);
});

test('Bring In (§6.8): seeds currentBetToCall on StreetABetting only, opening bettor\'s own currentBet stays $0 (not pre-posted)', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob'); // bringIn: 1, anteAmount: 1 (already posted -> pot: 2)
  const potBeforeOpening = room.pot;
  room.setOpeningBettor('p1', 'p2');
  room.openBetting('p1');
  assert.strictEqual(room.currentBetToCall, 1);
  assert.strictEqual(room.getPlayer('p2').currentBet, 0); // not pre-posted -- a live obligation, not already-paid money
  assert.strictEqual(room.pot, potBeforeOpening); // nothing additional moved into the pot yet either -- unlike a blind
});

test('Bring In (§6.8): resets to $0 on every street after StreetABetting -- Bring In only applies once per hand', () => {
  const room = studRoomAtStreetBBetting('stud-7card', 'Alice', 'Bob'); // closes StreetA (call), deals StreetB
  room.setOpeningBettor('p1', room.turnOrder[0]);
  room.openBetting('p1');
  assert.strictEqual(room.currentBetToCall, 0); // plain $0 round, same as Draw/Hold'em's post-flop streets
});

test('Bring In (§6.8): the selected opening bettor cannot Fold their forced first action -- must Call or Raise', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob');
  room.setOpeningBettor('p1', 'p2');
  room.openBetting('p1');
  assert.strictEqual(room.toRedactedState('p1').bringInObligationId, 'p2');
  const foldResult = room.fold('p2');
  assert.strictEqual(foldResult.ok, false);
  assert.match(foldResult.error, /Bring-In/);
  const callResult = room.call('p2');
  assert.strictEqual(callResult.ok, true);
});

test('Bring In (§6.8): Fold availability returns to normal the instant the obligation resolves (via Call)', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob', 'Carl');
  room.setOpeningBettor('p1', 'p2');
  room.openBetting('p1');
  room.call('p2'); // resolves the obligation
  assert.strictEqual(room.toRedactedState('p1').bringInObligationId, null);
  // p3 (never under the obligation) could always fold; more importantly,
  // p2 themselves could fold now if action somehow returned to them later
  // this same street (e.g. after a raise) -- verified indirectly via the
  // cleared bringInObligationId, since fold()'s own guard reads that field.
  assert.strictEqual(room.fold('p3').ok, true);
});

test('Bring In (§6.8): Fold availability returns to normal the instant the obligation resolves (via Raise)', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob');
  room.buyChips('p2', 1000);
  room.setOpeningBettor('p1', 'p2');
  room.openBetting('p1');
  room.placeBet('p2', 5); // raises over the Bring In instead of calling it
  assert.strictEqual(room.toRedactedState('p1').bringInObligationId, null);
});

test('Bring In (§6.8): a player who is NOT the selected opening bettor can fold normally, even during StreetABetting', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob', 'Carl');
  room.setOpeningBettor('p1', 'p1');
  room.openBetting('p1');
  room.call('p1'); // p1 pays the Bring In, turn -> p2
  assert.strictEqual(room.fold('p2').ok, true); // p2 was never under the obligation
});

test('Stud RequestAntes: reuses the flat/universal ante mechanism unchanged, same as Draw', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card'); // anteAmount: 1, anteType: flat
  room.startGame('p1');
  assert.strictEqual(room.handPhase, 'RequestAntes');
  assert.strictEqual(room.getPlayer('p1').oweAnte, 1);
  assert.strictEqual(room.getPlayer('p2').oweAnte, 1);
});

test('newHand: rejected for Stud unless reAnteable (mirrors Draw\'s gate)', () => {
  const room = studRoomAtShowdown('stud-7card', 'Alice', 'Bob'); // reAnteable: false (default)
  assert.strictEqual(room.newHand('p1').ok, false);
});

test('newHand (reAnteable Stud, e.g. Black Mariah): available from Showdown once nobody claims, same mechanism as Draw', () => {
  const room = studRoomAtShowdown('stud-7card-black-mariah', 'Alice', 'Bob'); // reAnteable: true
  assert.strictEqual(room.handPhase, 'Showdown');
  const result = room.newHand('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.handPhase, 'RequestAntes');
  assert.strictEqual(room.idle, false);
});

test('newHand (reAnteable Stud): preserves fold status across the loop, same as Draw\'s New-Hand-within-Cycle', () => {
  const room = studRoomAtStreetABetting('stud-7card-black-mariah', 'Alice', 'Bob', 'Carl');
  room.setOpeningBettor('p1', 'p1');
  room.openBetting('p1');
  room.call('p1'); // pays Bring In, turn -> p2
  room.fold('p2'); // p2's turn now, folds -- turn -> p3
  studActUntilRoundCloses(room); // p3 (and anyone else still owed) finishes closing the round -> StreetB
  let guard = 0;
  while (room.handPhase !== 'Showdown' && guard++ < 10) {
    studDealNextStreet(room); // -> Street{X}Betting
    const opener = room.turnOrder.find((id) => !room.getPlayer(id).folded);
    studCloseBettingRound(room, opener);
  }
  assert.strictEqual(room.getPlayer('p2').folded, true);
  room.newHand('p1');
  assert.strictEqual(room.handPhase, 'RequestAntes');
  assert.strictEqual(room.getPlayer('p2').folded, true); // preserved -- same Cycle continues
});

test('claimPot (early-claim shortcut, §6.5) applies identically to Stud: available outside Showdown once one active player remains', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob', 'Carl');
  room.setOpeningBettor('p1', 'p1');
  room.openBetting('p1');
  room.call('p1');
  room.fold('p2');
  room.fold('p3'); // p1 now the sole active player, still in StreetABetting
  const result = room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.strictEqual(result.ok, true);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.handPhase, 'CycleComplete'); // jumps straight there, same as Draw/Hold'em
});

test('Fold at Showdown (§6.4) applies identically to Stud: available to any non-folded player, not turn-gated', () => {
  const room = studRoomAtShowdown('stud-7card', 'Alice', 'Bob', 'Carl');
  assert.strictEqual(room.handPhase, 'Showdown');
  const result = room.fold('p3'); // not p3's turn (Showdown isn't turn-sequential) -- still succeeds
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p3').folded, true);
});

test('pendingClaim lock applies to setOpeningBettor and Deal for Stud, same as every other Dealer\'s Rail action', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob', 'Carl');
  room.setOpeningBettor('p1', 'p1');
  room.openBetting('p1');
  room.call('p1');
  room.fold('p2');
  room.fold('p3'); // p1 sole active player
  room.claimPot('p1', [{ playerId: 'p1', amount: room.pot }]);
  assert.notStrictEqual(room.pendingClaim, null);
  assert.strictEqual(room.setOpeningBettor('p1', 'p1').ok, false);
  assert.strictEqual(room.deal(1, 'p1').ok, false);
});

test('_onBettingRoundClosed (Stud): StreetBBetting/StreetCBetting/StreetDBetting closures advance one letter at a time', () => {
  const room = studRoomAtStreetBBetting('stud-7card', 'Alice', 'Bob'); // -> StreetBBetting
  studCloseBettingRound(room, room.turnOrder[0]);
  assert.strictEqual(room.handPhase, 'StreetC');
  studDealNextStreet(room);
  assert.strictEqual(room.handPhase, 'StreetCBetting');
  studCloseBettingRound(room, room.turnOrder[0]);
  assert.strictEqual(room.handPhase, 'StreetD');
});

test('_onBettingRoundClosed (Stud, 5-Card, finalStreet D): StreetDBetting closes straight to Showdown, StreetE never appears', () => {
  const room = studRoomAtStreetABetting('stud-5card', 'Alice', 'Bob');
  let guard = 0;
  while (room.handPhase !== 'Showdown' && guard++ < 10) {
    studCloseBettingRound(room, room.turnOrder[0]);
    if (room.handPhase !== 'Showdown') {
      assert.notStrictEqual(room.handPhase, 'StreetE');
      studDealNextStreet(room);
    }
  }
  assert.strictEqual(room.handPhase, 'Showdown');
});

// ---------------------------------------------------------------
// NEW 7.2: 7-Card Stud's StreetE opening-bettor pre-fill (§6.8)
// ---------------------------------------------------------------


test('StreetE opening-bettor pre-fill: carries forward whoever opened StreetD, if still active', () => {
  const room = studRoomAtStreetBBetting('stud-7card', 'Alice', 'Bob', 'Carl'); // -> StreetBBetting
  studCloseBettingRound(room, 'p2'); // -> StreetC
  studDealNextStreet(room); // -> StreetCBetting
  studCloseBettingRound(room, 'p3'); // -> StreetD
  studDealNextStreet(room); // -> StreetDBetting
  studCloseBettingRound(room, 'p1'); // StreetD opened by p1 -> StreetE
  assert.strictEqual(room.handPhase, 'StreetE');
  studDealNextStreet(room); // -> StreetEBetting
  assert.strictEqual(room.handPhase, 'StreetEBetting');
  assert.strictEqual(room.openingBettorId, 'p1'); // pre-filled, not reset to null
});

test('StreetE opening-bettor pre-fill: falls back to null if that player folded before StreetE', () => {
  const room = studRoomAtStreetBBetting('stud-7card', 'Alice', 'Bob', 'Carl');
  studCloseBettingRound(room, 'p2'); // -> StreetC
  studDealNextStreet(room);
  studCloseBettingRound(room, 'p3'); // -> StreetD
  studDealNextStreet(room);
  room.setOpeningBettor('p1', 'p1');
  room.openBetting('p1');
  room.call('p1'); // p1 opened StreetD, pays it
  room.fold('p2');
  studActUntilRoundCloses(room); // p3 finishes closing the round -> StreetE
  assert.strictEqual(room.handPhase, 'StreetE');
  room.getPlayer('p1').folded = true; // p1 (StreetD's opener) is no longer active by StreetE
  studDealNextStreet(room); // -> StreetEBetting
  assert.strictEqual(room.openingBettorId, null); // falls back to the normal blank state
});

test('StreetE opening-bettor pre-fill: does not apply to any other street transition', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob');
  studCloseBettingRound(room, 'p1'); // -> StreetB
  studDealNextStreet(room); // -> StreetBBetting
  assert.strictEqual(room.openingBettorId, null); // still the normal unconditional reset, not a pre-fill
});

// ---------------------------------------------------------------
// NEW 8.1: Game Choice preset schema restructure (§3) -- Stud's new fields
// ---------------------------------------------------------------

test('GAME_CHOICES: every Stud preset carries bettingStartsWith', () => {
  const stud = GAME_CHOICES.filter((g) => g.profile === 'stud');
  for (const preset of stud) {
    assert.ok(
      ['Low/High', 'Low/Low', 'High/Low', 'High/High'].includes(preset.hiddenOptions.bettingStartsWith),
      `${preset.id} missing a valid bettingStartsWith`
    );
  }
  const razz = stud.find((g) => g.id === 'stud-7card-razz');
  assert.strictEqual(razz.hiddenOptions.bettingStartsWith, 'High/Low');
});

test('GAME_CHOICES: bettingStartsWith moved to hiddenOptions in 8.2 -- no longer a Dealer Option', () => {
  const stud = GAME_CHOICES.filter((g) => g.profile === 'stud');
  for (const preset of stud) {
    assert.strictEqual(preset.dealerOptions.bettingStartsWith, undefined);
  }
});

test('GAME_CHOICES: declareOptions present on every declareHighLowBoth preset, with the correct captions', () => {
  const highChicago = GAME_CHOICES.find((g) => g.id === 'stud-7card-high-chicago');
  assert.deepStrictEqual(highChicago.hiddenOptions.declareOptions, { a: 'High Hand', b: 'High Spade' });
  const lowChicago = GAME_CHOICES.find((g) => g.id === 'stud-7card-low-chicago');
  assert.deepStrictEqual(lowChicago.hiddenOptions.declareOptions, { a: 'High Hand', b: 'Low Spade' });
  const baseballHilo = GAME_CHOICES.find((g) => g.id === 'stud-7card-baseball-hilo');
  assert.deepStrictEqual(baseballHilo.hiddenOptions.declareOptions, { a: 'High', b: 'Low' });
  // stud8 splits unambiguously (qualifying-low vs. high) -- no declaration needed, so no declareOptions either.
  const stud8 = GAME_CHOICES.find((g) => g.id === 'stud-7card-stud8');
  assert.strictEqual(stud8.hiddenOptions.declareOptions, undefined);
});

test('GAME_CHOICES: declareHighLowBoth set on exactly the three split-declare presets', () => {
  const flagged = GAME_CHOICES.filter((g) => g.hiddenOptions?.declareHighLowBoth === true).map((g) => g.id);
  assert.deepStrictEqual(
    flagged.sort(),
    ['stud-7card-baseball-hilo', 'stud-7card-high-chicago', 'stud-7card-low-chicago'].sort()
  );
  const stud8 = GAME_CHOICES.find((g) => g.id === 'stud-7card-stud8');
  assert.notStrictEqual(stud8.hiddenOptions?.declareHighLowBoth, true); // unambiguous split, no declaration needed
});

test('GAME_CHOICES: dealIsInterruptable set on exactly the two Baseball presets', () => {
  const flagged = GAME_CHOICES.filter((g) => g.hiddenOptions?.dealIsInterruptable === true).map((g) => g.id);
  assert.deepStrictEqual(flagged.sort(), ['stud-7card-baseball', 'stud-7card-baseball-hilo'].sort());
});

test('GAME_CHOICES: hasKillCard/killCard set only on Black Mariah, top-level (not inside either options bucket)', () => {
  const mariah = GAME_CHOICES.find((g) => g.id === 'stud-7card-black-mariah');
  assert.strictEqual(mariah.hasKillCard, true);
  assert.strictEqual(mariah.killCard, 'Qs');
  assert.strictEqual(mariah.hiddenOptions.hasKillCard, undefined);
  assert.strictEqual(mariah.dealerOptions.hasKillCard, undefined);
  const others = GAME_CHOICES.filter((g) => g.id !== 'stud-7card-black-mariah');
  for (const preset of others) assert.notStrictEqual(preset.hasKillCard, true);
});

test('GAME_CHOICES: audible is a universal Dealer Option, present on every preset', () => {
  for (const preset of GAME_CHOICES) {
    assert.strictEqual(typeof preset.dealerOptions.audible, 'string');
  }
});

test('GAME_CHOICES: the 16-preset locked-down set, old renamed/deleted/split ids confirmed gone or renamed', () => {
  const ids = GAME_CHOICES.map((g) => g.id);
  assert.strictEqual(ids.length, 16);
  assert.ok(ids.includes('stud-7card-razz')); // renamed from stud-7card-lowball
  assert.ok(ids.includes('stud-7card-stud8')); // renamed from stud-7card-highlow
  assert.ok(ids.includes('stud-7card-high-chicago')); // split from stud-7card-chicago
  assert.ok(ids.includes('stud-7card-low-chicago')); // split from stud-7card-chicago
  assert.ok(!ids.includes('stud-7card-lowball'));
  assert.ok(!ids.includes('stud-7card-highlow'));
  assert.ok(!ids.includes('stud-7card-chicago'));
  assert.ok(!ids.includes('stud-7card-hilow')); // deleted
  assert.ok(!ids.includes('stud-7card-follow-queen-wild')); // deleted -- audible replaces it
  assert.ok(ids.includes('stud-7card-follow-queen')); // base preset survives
});

// ---------------------------------------------------------------
// NEW 8.1: Kill Hand (§6.9, hasKillCard presets only)
// ---------------------------------------------------------------

test('newHand (Kill Hand): available mid-hand for a hasKillCard preset well before Showdown', () => {
  const room = studRoomAtStreetABetting('stud-7card-black-mariah', 'Alice', 'Bob');
  assert.strictEqual(room.handPhase, 'StreetABetting');
  const result = room.newHand('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.handPhase, 'RequestAntes');
});

test('newHand (Kill Hand): window extends through the close of betting on the last face-up street (CORRECTED 8.2), for a 7-Card preset that\'s StreetD', () => {
  const room = studRoomAtStreetABetting('stud-7card-black-mariah', 'Alice', 'Bob');
  studCloseBettingRound(room, 'p1'); // -> StreetB
  studDealNextStreet(room); // -> StreetBBetting
  studCloseBettingRound(room, 'p1'); // -> StreetC
  studDealNextStreet(room); // -> StreetCBetting
  studCloseBettingRound(room, 'p1'); // -> StreetD (last face-up street's deal phase)
  assert.strictEqual(room.handPhase, 'StreetD');
  assert.strictEqual(room.newHand('p1').ok, true, 'expected Kill Hand available during StreetD (deal phase)');
});

test('newHand (Kill Hand): still available once StreetDBetting OPENS (CORRECTED 8.2 -- the 8.1 spec/build wrongly cut it off here)', () => {
  const room = studRoomAtStreetABetting('stud-7card-black-mariah', 'Alice', 'Bob');
  studCloseBettingRound(room, 'p1'); // -> StreetB
  studDealNextStreet(room);
  studCloseBettingRound(room, 'p1'); // -> StreetC
  studDealNextStreet(room);
  studCloseBettingRound(room, 'p1'); // -> StreetD
  studDealNextStreet(room); // -> StreetDBetting
  assert.strictEqual(room.handPhase, 'StreetDBetting');
  // This is the exact 8.1 bug: a Dealer who saw the kill card land
  // face-up on 6th Street had no way to act on it during that street's
  // own betting round -- the whole point of the window.
  assert.strictEqual(room.newHand('p1').ok, true);
});

test('BUG FIX 8.4 (§6.9): toRedactedState exposes killHandWindowOpen, eliminating the client-side duplicate that caused the reported regression', () => {
  // Exact reproduction of the bug report: Black Mariah, StreetDBetting
  // (right after the Queen of Spades would have landed face-up on 6th
  // Street). Before 8.4, only the SERVER's own newHand() gate agreed
  // this was a valid Kill Hand window -- the client had a second,
  // separately hand-maintained copy of this logic (railTables.js) that
  // was never updated when the server-side version was corrected in
  // 8.2/8.3, so the button vanished on screen even though the server
  // would have accepted the action. This test asserts the two can no
  // longer disagree, because there's only one computation left. Doesn't
  // actually call the real (mutating) newHand() action here -- that's
  // already covered by dedicated tests elsewhere in this file; this one
  // stays focused on the exposed field itself, across both a phase
  // where the window is open and one where it's closed.
  const room = studRoomAtStreetABetting('stud-7card-black-mariah', 'Alice', 'Bob');
  studCloseBettingRound(room, 'p1'); // -> StreetB
  studDealNextStreet(room);
  studCloseBettingRound(room, 'p1'); // -> StreetC
  studDealNextStreet(room);
  studCloseBettingRound(room, 'p1'); // -> StreetD
  studDealNextStreet(room); // -> StreetDBetting
  assert.strictEqual(room.handPhase, 'StreetDBetting');
  assert.strictEqual(room.toRedactedState('p1').killHandWindowOpen, true);

  // And once betting closes into StreetE (7th Street, dealt face-down),
  // the exposed field agrees the window has closed too.
  studCloseBettingRound(room, 'p1'); // -> StreetE
  assert.strictEqual(room.handPhase, 'StreetE');
  assert.strictEqual(room.toRedactedState('p1').killHandWindowOpen, false);
});

test('killHandWindowOpen: always false for a non-hasKillCard preset, never computed at all', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob'); // no hasKillCard
  const redacted = room.toRedactedState('p1');
  assert.strictEqual(redacted.killHandWindowOpen, false);
});

test('newHand (Kill Hand): rejected once StreetDBetting CLOSES and dealing moves to StreetE (7th Street, dealt face-down)', () => {
  const room = studRoomAtStreetABetting('stud-7card-black-mariah', 'Alice', 'Bob');
  studCloseBettingRound(room, 'p1'); // -> StreetB
  studDealNextStreet(room);
  studCloseBettingRound(room, 'p1'); // -> StreetC
  studDealNextStreet(room);
  studCloseBettingRound(room, 'p1'); // -> StreetD
  studDealNextStreet(room); // -> StreetDBetting
  studCloseBettingRound(room, 'p1'); // -> StreetE -- the last face-up street's betting has now closed
  assert.strictEqual(room.handPhase, 'StreetE');
  assert.strictEqual(room.newHand('p1').ok, false);
});

test('newHand at Showdown for a hasKillCard preset: available only via the ordinary reAnteable trigger, CHANGED 8.3', () => {
  const room = studRoomAtShowdown('stud-7card-black-mariah', 'Alice', 'Bob'); // reAnteable AND hasKillCard both true
  assert.strictEqual(room.handPhase, 'Showdown');
  assert.strictEqual(room.newHand('p1').ok, true); // still works -- but now via stuckShowdown/reAnteable alone
});

test('newHand (Kill Hand): its OWN trigger no longer applies at Showdown at all, CHANGED 8.3 (Mike\'s preference)', () => {
  // Isolates Kill Hand's trigger from the ordinary reAnteable one by
  // forcing reAnteable false -- if Kill Hand's own trigger still fired
  // at Showdown (the pre-8.3 behavior), this would still succeed. Per
  // 8.3, it must now fail: a hasKillCard preset that ISN'T reAnteable
  // has no New Hand available at Showdown at all.
  const room = studRoomAtShowdown('stud-7card-black-mariah', 'Alice', 'Bob');
  room.reAnteable = false;
  assert.strictEqual(room.handPhase, 'Showdown');
  assert.strictEqual(room.newHand('p1').ok, false);
});

test('newHand (Kill Hand): the mid-hand trigger is still independent of reAnteable -- still fires mid-hand even if reAnteable is forced false', () => {
  const room = studRoomAtStreetABetting('stud-7card-black-mariah', 'Alice', 'Bob');
  room.reAnteable = false; // isolates the Kill Hand trigger from the ordinary reAnteable-driven one
  assert.strictEqual(room.newHand('p1').ok, true);
});

test('newHand: rejected mid-hand for every other Stud preset (no hasKillCard, not reAnteable)', () => {
  const room = studRoomAtStreetABetting('stud-7card', 'Alice', 'Bob');
  assert.strictEqual(room.newHand('p1').ok, false);
});

// ---------------------------------------------------------------
// NEW 8.1: Interruptible dealing (§5.10 extension, dealIsInterruptable presets only)
// ---------------------------------------------------------------

test('deal-interrupt: a Free price auto-resolves inline, deal completes in one call, no pause', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  // NEW 12.3: pinned explicitly -- this test is about Free-price
  // auto-resolve behavior specifically, not about the preset's current
  // default (which changed from 'free' to 'pot' under Part E). Found
  // by actually running the suite against the corrected
  // game-choices.json, not called out in the spec's own list of three.
  room.gameOptions.priceForThrees = 'free';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  stackDeckTop(room, [{ suit: 'hearts', rank: '8' }, { suit: 'clubs', rank: '9' }, { suit: 'spades', rank: '3' }], ['3', '4']);
  const result = room.deal(3, 'p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.handPhase, 'StreetABetting'); // fully completed, not paused
  assert.strictEqual(room._pendingDealInterrupt, null);
  assert.strictEqual(room.getPlayer('p1').hand.length, 3);
  assert.strictEqual(room.getPlayer('p2').hand.length, 3); // both players fully dealt
});

test('deal-interrupt: a non-Free price pauses the deal exactly at the triggering card, remaining recipients not yet dealt', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForFours = 'bringInX2';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  stackDeckTop(room, [{ suit: 'hearts', rank: '8' }, { suit: 'clubs', rank: '9' }, { suit: 'spades', rank: '4' }], ['3', '4']);
  const result = room.deal(3, 'p1');
  assert.strictEqual(result.ok, true); // the deal ACTION succeeded -- it's just not finished yet
  assert.strictEqual(room.handPhase, 'StreetA'); // no phase transition until the whole deal completes
  assert.deepStrictEqual(room._pendingDealInterrupt, { playerId: 'p1', triggerRank: '4' });
  assert.strictEqual(room.getPlayer('p1').hand.length, 3);
  assert.strictEqual(room.getPlayer('p2').hand.length, 0); // paused before p2 got anything
});

test('deal-interrupt: a face-DOWN 3/4 never triggers a pause at all', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForThrees = 'bringInX2'; // would pause if face-up
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  // 7-Card pattern: down, down, up, up, up, up, down -- position 0 is
  // down. Stack a 3 as the very FIRST card dealt (down, never triggers).
  stackDeckTop(room, [{ suit: 'spades', rank: '3' }, { suit: 'hearts', rank: '8' }, { suit: 'clubs', rank: '9' }], ['3', '4']);
  const result = room.deal(3, 'p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.handPhase, 'StreetABetting'); // completed, no pause
  assert.strictEqual(room._pendingDealInterrupt, null);
});

test('deal-interrupt: non-interruptible presets never pause, even on a face-up 3/4', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card'); // NOT dealIsInterruptable
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  stackDeckTop(room, [{ suit: 'hearts', rank: '8' }, { suit: 'clubs', rank: '9' }, { suit: 'spades', rank: '4' }], ['3', '4']);
  const result = room.deal(3, 'p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.handPhase, 'StreetABetting');
  assert.strictEqual(room._pendingDealInterrupt, null);
});

test('payDealInterrupt: pays the priced amount straight into the pot, resumes and completes the deal', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForThrees = 'bringInX2'; // bringIn (1) x2 = 2
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  stackDeckTop(room, [{ suit: 'hearts', rank: '8' }, { suit: 'clubs', rank: '9' }, { suit: 'spades', rank: '3' }], ['3', '4']);
  room.deal(3, 'p1');
  const potBefore = room.pot;
  const chipsBefore = room.getPlayer('p1').chips;
  const result = room.payDealInterrupt('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.pot, potBefore + 2);
  assert.strictEqual(room.getPlayer('p1').chips, chipsBefore - 2);
  assert.strictEqual(room._pendingDealInterrupt, null);
  assert.strictEqual(room.handPhase, 'StreetABetting'); // resumed and finished
  assert.strictEqual(room.getPlayer('p2').hand.length, 3);
  assert.strictEqual(room.getPlayer('p1').hand.length, 3); // Pay never adds a card
});

test('payDealInterrupt: rejected for the wrong player, or when the pending trigger is a 4 not a 3', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForFours = 'bringInX2';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  stackDeckTop(room, [{ suit: 'hearts', rank: '8' }, { suit: 'clubs', rank: '9' }, { suit: 'spades', rank: '4' }], ['3', '4']);
  room.deal(3, 'p1');
  assert.strictEqual(room.payDealInterrupt('p2').ok, false); // wrong player
  assert.strictEqual(room.payDealInterrupt('p1').ok, false); // right player, wrong rank (pending is a 4)
});

test('buyDealInterrupt: pays, deals exactly one extra card per extraCardUpOrDown, resumes and completes', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForFours = 'bringInX4'; // bringIn (1) x4 = 4
  room.gameOptions.extraCardUpOrDown = 'down';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  stackDeckTop(room, [{ suit: 'hearts', rank: '8' }, { suit: 'clubs', rank: '9' }, { suit: 'spades', rank: '4' }], ['3', '4']);
  room.deal(3, 'p1');
  const potBefore = room.pot;
  const chipsBefore = room.getPlayer('p1').chips;
  const result = room.buyDealInterrupt('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.pot, potBefore + 4);
  assert.strictEqual(room.getPlayer('p1').chips, chipsBefore - 4);
  assert.strictEqual(room.getPlayer('p1').hand.length, 4); // 3 original + 1 bought
  assert.strictEqual(room.getPlayer('p1').hand[3].faceUp, false); // extraCardUpOrDown: 'down'
  assert.strictEqual(room.handPhase, 'StreetABetting');
});

test('buyDealInterrupt: bought card doesn\'t advance street numbering -- the extra card just sits in the hand', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForFours = 'bringInX4';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  stackDeckTop(room, [{ suit: 'hearts', rank: '8' }, { suit: 'clubs', rank: '9' }, { suit: 'spades', rank: '4' }], ['3', '4']);
  room.deal(3, 'p1');
  room.buyDealInterrupt('p1');
  assert.strictEqual(room.handPhase, 'StreetABetting'); // still just StreetABetting, no new phase invented for the extra card
});

test('declineDealInterrupt: no payment, no extra card, not a fold -- resumes and completes normally', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForFours = 'bringInX4';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  stackDeckTop(room, [{ suit: 'hearts', rank: '8' }, { suit: 'clubs', rank: '9' }, { suit: 'spades', rank: '4' }], ['3', '4']);
  room.deal(3, 'p1');
  const potBefore = room.pot;
  const chipsBefore = room.getPlayer('p1').chips;
  const result = room.declineDealInterrupt('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.pot, potBefore);
  assert.strictEqual(room.getPlayer('p1').chips, chipsBefore);
  assert.strictEqual(room.getPlayer('p1').hand.length, 3); // no extra card
  assert.strictEqual(room.getPlayer('p1').folded, false); // not a fold
  assert.strictEqual(room.handPhase, 'StreetABetting');
});

test('declineDealInterrupt: rejected for a pending 3 (Pay/Fold is that pair, not Buy/Decline)', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForThrees = 'bringInX2';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  stackDeckTop(room, [{ suit: 'hearts', rank: '8' }, { suit: 'clubs', rank: '9' }, { suit: 'spades', rank: '3' }], ['3', '4']);
  room.deal(3, 'p1');
  assert.strictEqual(room.declineDealInterrupt('p1').ok, false);
});

test('fold during a deal-interrupt: the Baseball-specific bypass -- resolves the Pay-or-Fold pause and resumes, even though no betting round is open', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForThrees = 'bringInX2';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  stackDeckTop(room, [{ suit: 'hearts', rank: '8' }, { suit: 'clubs', rank: '9' }, { suit: 'spades', rank: '3' }], ['3', '4']);
  room.deal(3, 'p1');
  assert.strictEqual(room.bettingOpen, false); // no betting round open at all during a deal-interrupt pause
  const result = room.fold('p1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.getPlayer('p1').folded, true);
  assert.strictEqual(room._pendingDealInterrupt, null);
  assert.strictEqual(room.handPhase, 'StreetABetting'); // resumed and completed despite p1 now being folded
});

test('deal-interrupt: multiple triggers on the same street resolve strictly in deal order, one at a time', () => {
  const room = tableWithPlayers('Alice', 'Bob', 'Carl');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForThrees = 'bringInX2';
  room.gameOptions.priceForFours = 'bringInX4';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
  // 3 recipients x 3 cards = 9 pops, dealt p1,p1,p1,p2,p2,p2,p3,p3,p3 in
  // that order. Rig p1's 3rd card (index 2, the first face-up "up" card)
  // as a 3, and p2's 3rd card (index 5) as a 4 -- two separate pauses on
  // the same street.
  const filler = (n) => Array.from({ length: n }, (_, i) => ({ suit: 'hearts', rank: String(5 + (i % 3)) }));
  stackDeckTop(
    room,
    [...filler(2), { suit: 'spades', rank: '3' }, ...filler(2), { suit: 'clubs', rank: '4' }, ...filler(3)],
    ['3', '4']
  );
  const r1 = room.deal(3, 'p1');
  assert.strictEqual(r1.ok, true);
  assert.deepStrictEqual(room._pendingDealInterrupt, { playerId: 'p1', triggerRank: '3' });
  assert.strictEqual(room.getPlayer('p2').hand.length, 0);
  assert.strictEqual(room.getPlayer('p3').hand.length, 0);

  room.payDealInterrupt('p1'); // resolves p1's pause -- should immediately hit p2's 4 and pause again
  assert.deepStrictEqual(room._pendingDealInterrupt, { playerId: 'p2', triggerRank: '4' });
  assert.strictEqual(room.getPlayer('p2').hand.length, 3); // p2 fully dealt up to and including the trigger card
  assert.strictEqual(room.getPlayer('p3').hand.length, 0); // still not reached

  room.declineDealInterrupt('p2'); // resolves p2's pause -- nothing left to trigger, deal completes
  assert.strictEqual(room._pendingDealInterrupt, null);
  assert.strictEqual(room.getPlayer('p3').hand.length, 3);
  assert.strictEqual(room.handPhase, 'StreetABetting');
});

// ---------------------------------------------------------------
// NEW 8.1: Declare phase (§5.11, declareHighLowBoth presets only)
// ---------------------------------------------------------------

function studRoomAtDeclare(gameChoiceId, ...names) {
  const room = studRoomAtStreetABetting(gameChoiceId, ...names);
  let guard = 0;
  while (room.handPhase !== 'Declare' && room.handPhase !== 'Showdown' && guard++ < 10) {
    studCloseBettingRound(room, room.turnOrder[0]);
    if (room.handPhase !== 'Declare' && room.handPhase !== 'Showdown') studDealNextStreet(room);
  }
  return room;
}

test('Declare: reached after the final betting round for a declareHighLowBoth preset, not Showdown directly', () => {
  const room = studRoomAtDeclare('stud-7card-high-chicago', 'Alice', 'Bob');
  assert.strictEqual(room.handPhase, 'Declare');
});

test('Declare: never reached for stud-7card-stud8 -- goes straight to Showdown despite also splitting the pot', () => {
  const room = studRoomAtDeclare('stud-7card-stud8', 'Alice', 'Bob');
  assert.strictEqual(room.handPhase, 'Showdown');
});

test('declare: accepts "a"/"b"/"both" only, rejects anything else', () => {
  const room = studRoomAtDeclare('stud-7card-high-chicago', 'Alice', 'Bob');
  assert.strictEqual(room.declare('p1', 'medium').ok, false);
  assert.strictEqual(room.declare('p1', 'a').ok, true);
});

test('declare: one-shot -- cannot be changed once submitted, even to the same value', () => {
  const room = studRoomAtDeclare('stud-7card-high-chicago', 'Alice', 'Bob');
  room.declare('p1', 'a');
  const second = room.declare('p1', 'b');
  assert.strictEqual(second.ok, false);
  assert.strictEqual(room.getPlayer('p1').declaration, 'a'); // unchanged
});

test('Declare -> Showdown once every active player has declared', () => {
  const room = studRoomAtDeclare('stud-7card-high-chicago', 'Alice', 'Bob');
  room.declare('p1', 'a');
  assert.strictEqual(room.handPhase, 'Declare'); // still waiting on p2
  room.declare('p2', 'b');
  assert.strictEqual(room.handPhase, 'Showdown');
});

test('Declare: a fold removes that player from the "every active player" count, letting the phase complete without them', () => {
  const room = studRoomAtDeclare('stud-7card-high-chicago', 'Alice', 'Bob', 'Carl');
  room.declare('p1', 'a');
  room.fold('p3'); // Declare isn't turn-gated, same as Showdown -- any active player can fold anytime
  assert.strictEqual(room.handPhase, 'Declare'); // still waiting on p2
  room.declare('p2', 'both');
  assert.strictEqual(room.handPhase, 'Showdown');
});

test('declare: rejected outside the Declare phase, and for folded/sitting-out players', () => {
  const room = studRoomAtStreetABetting('stud-7card-high-chicago', 'Alice', 'Bob');
  assert.strictEqual(room.declare('p1', 'a').ok, false); // wrong phase
  const declareRoom = studRoomAtDeclare('stud-7card-high-chicago', 'Alice', 'Bob', 'Carl');
  declareRoom.getPlayer('p3').folded = true;
  assert.strictEqual(declareRoom.declare('p3', 'a').ok, false);
});

test('declaration is redacted from other players until Show Cards, always visible to the declaring player themselves', () => {
  const room = studRoomAtDeclare('stud-7card-high-chicago', 'Alice', 'Bob');
  room.declare('p1', 'a');
  const forSelf = room.toRedactedState('p1');
  const forOther = room.toRedactedState('p2');
  assert.strictEqual(forSelf.players.find((p) => p.id === 'p1').declaration, 'a');
  assert.strictEqual(forOther.players.find((p) => p.id === 'p1').declaration, null); // hidden until Show Cards
  room.revealHand('p1');
  const forOtherAfterReveal = room.toRedactedState('p2');
  assert.strictEqual(forOtherAfterReveal.players.find((p) => p.id === 'p1').declaration, 'a');
});

// ---------------------------------------------------------------
// BUG FIX 8.2 (§5.10 extension): Baseball face-up/down determination
// keyed off street, not card count -- an extra bought card must not
// desync later streets' face-up/down for the buyer specifically.
// ---------------------------------------------------------------

function stackDeck(room, cards, ranksToClear) {
  for (const rank of ranksToClear) room.deck = room.deck.filter((c) => c.rank !== rank);
  for (let i = cards.length - 1; i >= 0; i--) {
    room.deck.push({ suit: cards[i].suit, rank: cards[i].rank, id: `rig-${i}-${Math.random()}`, faceUp: false });
  }
}

function actUntilClosed(room) {
  let guard = 0;
  while (room.bettingOpen && guard++ < 10) {
    const p = room.getPlayer(room.currentTurnPlayerId);
    const r = p.currentBet < room.currentBetToCall ? room.call(p.id) : room.check(p.id);
    if (!r.ok) throw new Error(`act failed: ${r.error}`);
  }
}

test('Baseball: a player who bought an extra card still gets every later street dealt correctly face-up/down, keyed off street not hand size', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForFours = 'bringInX4'; // force a real pause, not an auto-resolved Free
  // NEW 12.3: pinned explicitly -- this test rigs only rank '4' via
  // stackDeck's ranksToClear, leaving natural 3s in the deck across
  // several later streets (closeAndDeal is called four more times
  // below). Baseball's new default priceForThrees is 'pot' (Part E),
  // no longer 'free' -- a stray, un-rigged natural 3 landing face-up
  // on any of those streets would now genuinely pause the deal instead
  // of being harmless, silently shorting the hand for the rest of this
  // test. Confirmed empirically: intermittently flaky (~1 in 3-5 runs)
  // before this pin, 30+ consecutive clean runs after. Same pattern
  // already used once for a related flakiness case in 8.3 (see the
  // fully-controlled-deck comment further down this file).
  room.gameOptions.priceForThrees = 'free';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);

  // Rig p1's 3rd initial card (StreetA's first face-up "up" card) as a 4.
  stackDeck(room, [{ suit: 'hearts', rank: '8' }, { suit: 'hearts', rank: '9' }, { suit: 'spades', rank: '4' }], ['4']);
  room.deal(3, 'p1'); // pauses on p1's 4
  room.buyDealInterrupt('p1'); // p1 buys -> 4 cards total (1 more than their real street count)

  function closeAndDeal(count) {
    room.setOpeningBettor('p1', 'p1');
    room.openBetting('p1');
    actUntilClosed(room);
    room.deal(count, 'p1');
  }
  closeAndDeal(1); // StreetB
  closeAndDeal(1); // StreetC
  closeAndDeal(1); // StreetD
  closeAndDeal(1); // StreetE -- 7th street, dealt face-down

  const p1Hand = room.getPlayer('p1').hand;
  const p2Hand = room.getPlayer('p2').hand;
  assert.strictEqual(p1Hand.length, 8); // 7 real street cards + 1 bought
  assert.strictEqual(p2Hand.length, 7); // no bought card

  // p2 (no bought card) must match the preset's pattern exactly.
  assert.deepStrictEqual(
    p2Hand.map((c) => c.faceUp),
    [false, false, true, true, true, true, false]
  );
  // p1's real street cards (skipping the bought one at index 3) must
  // ALSO match the pattern exactly -- this is the regression check: the
  // pre-8.2 bug indexed by hand.length, which would have drifted p1's
  // StreetD card (index 6 in the array below) to read the WRONG pattern
  // slot once the bought card shifted everything by one.
  const p1RealStreetCards = [p1Hand[0], p1Hand[1], p1Hand[2], p1Hand[4], p1Hand[5], p1Hand[6], p1Hand[7]];
  assert.deepStrictEqual(
    p1RealStreetCards.map((c) => c.faceUp),
    [false, false, true, true, true, true, false]
  );
  // The bought card itself: extraCardUpOrDown defaults to 'down' for this preset.
  assert.strictEqual(p1Hand[3].faceUp, false);
});

// ---------------------------------------------------------------
// NEW 8.2: Kill Hand's table-wide "about to kill" confirmation notice (§6.9)
// ---------------------------------------------------------------

test('killHandStartConfirm: Dealer-only, hasKillCard presets only', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'stud-7card-black-mariah');
  assert.strictEqual(room.killHandStartConfirm('p2').ok, false); // not the Dealer
  assert.strictEqual(room.killHandStartConfirm('p1').ok, true);
  assert.strictEqual(room.killHandConfirmPending, true);

  const nonKillRoom = tableWithPlayers('Alice', 'Bob');
  nonKillRoom.setGameChoice('p1', 'stud-7card'); // no hasKillCard
  assert.strictEqual(nonKillRoom.killHandStartConfirm('p1').ok, false);
});

test('killHandCancelConfirm: clears the pending flag, Dealer-only', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  room.setGameChoice('p1', 'stud-7card-black-mariah');
  room.killHandStartConfirm('p1');
  assert.strictEqual(room.killHandCancelConfirm('p2').ok, false); // not the Dealer
  assert.strictEqual(room.killHandConfirmPending, true); // unchanged by the rejected attempt
  assert.strictEqual(room.killHandCancelConfirm('p1').ok, true);
  assert.strictEqual(room.killHandConfirmPending, false);
});

test('newHand (Kill Hand confirm path): clears killHandConfirmPending as a side effect of actually killing the hand', () => {
  const room = studRoomAtStreetABetting('stud-7card-black-mariah', 'Alice', 'Bob');
  room.killHandStartConfirm('p1');
  assert.strictEqual(room.killHandConfirmPending, true);
  room.newHand('p1');
  assert.strictEqual(room.killHandConfirmPending, false);
});

test('killHandConfirmPending: reset to false on every fresh RequestAntes entry, as a safety net', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-black-mariah');
  room.killHandStartConfirm('p1'); // set before the hand even starts, an edge case the safety net covers
  room.startGame('p1');
  assert.strictEqual(room.killHandConfirmPending, false);
});

// ---------------------------------------------------------------
// BUG FIX 8.3 (§5.10 extension): a bought Baseball extra card can itself
// chain into a fresh interrupt.
// ---------------------------------------------------------------

test('Baseball chaining: a bought extra card that is itself a face-up 4 pauses again, blocking the main deal queue from resuming', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForFours = 'bringInX4'; // not free -- forces a real pause both times
  room.gameOptions.extraCardUpOrDown = 'up'; // so the bought card can actually chain
  // NEW 12.3: pinned explicitly, same reasoning as the test above --
  // only rank '4' is rigged out of the deck; a stray natural 3 landing
  // face-up would now genuinely pause under the new 'pot' default
  // instead of being harmless.
  room.gameOptions.priceForThrees = 'free';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);

  stackDeckTop(
    room,
    [{ suit: 'hearts', rank: '8' }, { suit: 'hearts', rank: '9' }, { suit: 'clubs', rank: '4' }, { suit: 'spades', rank: '4' }],
    ['4']
  );
  room.deal(3, 'p1'); // pauses on p1's 3rd initial card (the first trigger)
  assert.deepStrictEqual(room._pendingDealInterrupt, { playerId: 'p1', triggerRank: '4' });

  const potBefore = room.pot;
  room.buyDealInterrupt('p1'); // buys -> the bought card is ALSO a face-up 4 -- must chain into a NEW pause
  assert.deepStrictEqual(room._pendingDealInterrupt, { playerId: 'p1', triggerRank: '4' }); // a NEW pause, not cleared
  assert.strictEqual(room.getPlayer('p1').hand.length, 4); // the chained card WAS dealt
  assert.strictEqual(room.getPlayer('p1').hand[3].faceUp, true);
  assert.strictEqual(room.getPlayer('p2').hand.length, 0); // main queue correctly NOT resumed yet
  assert.strictEqual(room.pot, potBefore + room.gameOptions.bigBet); // only ONE payment made so far

  room.buyDealInterrupt('p1'); // resolve the chained pause too
  assert.strictEqual(room._pendingDealInterrupt, null);
  assert.strictEqual(room.getPlayer('p1').hand.length, 5); // 3 initial + 2 bought
  assert.strictEqual(room.getPlayer('p2').hand.length, 3); // main queue finally resumed and completed
  assert.strictEqual(room.handPhase, 'StreetABetting');
  assert.strictEqual(room.pot, potBefore + room.gameOptions.bigBet * 2); // two separate payments
});

test('Baseball chaining: a bought extra card dealt FACE-DOWN (the preset default) never chains, even if its rank is 3 or 4', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball'); // extraCardUpOrDown defaults to 'down'
  room.gameOptions.priceForFours = 'bringInX4';
  // NEW 12.3: pinned explicitly, same reasoning as the two tests above
  // -- only rank '4' is rigged out; p2's three initial cards are dealt
  // from the natural remaining deck once the queue resumes after
  // buyDealInterrupt, and a stray natural 3 among them would now
  // genuinely pause under the new 'pot' default.
  room.gameOptions.priceForThrees = 'free';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);

  stackDeckTop(
    room,
    [{ suit: 'hearts', rank: '8' }, { suit: 'hearts', rank: '9' }, { suit: 'clubs', rank: '4' }, { suit: 'spades', rank: '4' }],
    ['4']
  );
  room.deal(3, 'p1');
  room.buyDealInterrupt('p1'); // the bought card is a 4, but dealt face-down -- must NOT chain
  assert.strictEqual(room._pendingDealInterrupt, null); // fully resolved, no new pause
  assert.strictEqual(room.getPlayer('p1').hand[3].faceUp, false);
  assert.strictEqual(room.getPlayer('p2').hand.length, 3); // main queue resumed and completed normally
  assert.strictEqual(room.handPhase, 'StreetABetting');
});

test('Baseball chaining: a Free-priced chained card auto-resolves recursively, queuing its own announcement, without ever pausing', () => {
  const room = tableWithPlayers('Alice', 'Bob');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'stud-7card-baseball');
  room.gameOptions.priceForFours = 'free'; // both the original AND the chained 4 auto-resolve
  room.gameOptions.extraCardUpOrDown = 'up';
  room.startGame('p1');
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);

  // Deck is FULLY controlled here (both '3' and '4' cleared, then every
  // card that will actually be dealt is stacked explicitly) -- an
  // earlier version of this test only rigged 4 cards and left the rest
  // of the deck to natural shuffle order, which could (rarely, but
  // really) deal a stray natural 3 or 4 into the chain and produce a
  // THIRD auto-resolved announcement, making the test flaky/order-
  // dependent rather than actually wrong. A 'K' terminates the chain
  // deliberately -- it isn't a 3 or 4, so the second bought card doesn't
  // trigger a third level.
  stackDeckTop(
    room,
    [
      { suit: 'hearts', rank: '8' }, // p1 card 1 (down)
      { suit: 'hearts', rank: '9' }, // p1 card 2 (down)
      { suit: 'clubs', rank: '4' }, // p1 card 3 (up) -- triggers the FIRST interrupt
      { suit: 'spades', rank: '4' }, // 1st bought card (up, per extraCardUpOrDown) -- triggers the SECOND (chained) interrupt
      { suit: 'diamonds', rank: 'K' }, // 2nd bought card (up) -- terminates the chain, not a 3/4
      { suit: 'hearts', rank: '6' }, // p2 card 1 (down)
      { suit: 'hearts', rank: '7' }, // p2 card 2 (down)
      { suit: 'diamonds', rank: 'Q' }, // p2 card 3 (up) -- not a 3/4, no stray trigger
    ],
    ['3', '4']
  );
  // CHANGED 11.0: drain and discard the setup-phase announcements (both
  // players' own "has joined the table" notices, NEW 11.0 Part G) before
  // exercising the deal-interrupt chain this test actually cares about --
  // a real server.js session would already have broadcast (and thus
  // drained) those long before this deal() ever happened.
  room.drainAnnouncements();
  const result = room.deal(3, 'p1'); // both 4s are Free -- the whole chain resolves inline, no pause at all
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room._pendingDealInterrupt, null);
  assert.strictEqual(room.handPhase, 'StreetABetting'); // fully completed in one call
  assert.strictEqual(room.getPlayer('p1').hand.length, 5); // 3 initial + 2 auto-bought (chained)
  assert.strictEqual(room.getPlayer('p2').hand.length, 3);
  const announcements = room.drainAnnouncements();
  assert.strictEqual(announcements.length, 2); // one for the original trigger, one for the chained card
});

