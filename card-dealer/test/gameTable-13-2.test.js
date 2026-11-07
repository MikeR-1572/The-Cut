'use strict';

const fs = require('fs');
const path = require('path');
const { assert, test, tableWithPlayers } = require('./helpers');
const { GAME_CHOICES } = require('../src/gameTable');

// ---------------------------------------------------------------
// v13.2: 13.1 play-test findings (Part A) and 7-Card No Peek (Part B).
// the-cut-spec_v13-2.md Part C, tests 1-17.
// ---------------------------------------------------------------

const NO_PEEK = 'stud-7card-no-peek';

function payAntes(room) {
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
}

function startedRoom(gameChoiceId, names, options = {}) {
  const room = tableWithPlayers(...names);
  for (const p of room.players) room.buyChips(p.id, 1000);
  assert.ok(room.setGameChoice('p1', gameChoiceId).ok);
  for (const [k, v] of Object.entries(options)) {
    const r = room.setGameOption('p1', k, v);
    assert.ok(r.ok, `setGameOption ${k}: ${r.error}`);
  }
  const started = room.startGame('p1');
  assert.ok(started.ok, started.error);
  payAntes(room);
  return room;
}

/** No Peek, dealt: sitting in the 1st Reveal with p2 (Dealer p1's left) holding the Reveal Rail. */
function noPeekDealt(names, options = {}) {
  const room = startedRoom(NO_PEEK, names, options);
  assert.strictEqual(room.handPhase, 'OpeningDeal');
  assert.ok(room.deal(3, 'p1').ok);
  assert.strictEqual(room.handPhase, 'Reveal');
  return room;
}

function checkAround(room) {
  let guard = 0;
  while (room.bettingOpen && guard++ < 50) assert.ok(room.check(room.currentTurnPlayerId).ok);
}

/** From the 1st Reveal: p2 reveals (auto-ends), Dealer opens betting, everyone checks -> 2nd Reveal. */
function pastFirstReveal(room) {
  assert.ok(room.revealNext('p2').ok);
  assert.ok(room.openBetting('p1').ok);
  checkAround(room);
}

const hasIdentity = (c) => typeof c.rank === 'string' || typeof c.suit === 'string';

// =============================== Part A ===============================

test('13.2 C.1: consecutivePasses is exposed; it resets on a Draw and on the next hand', () => {
  const room = startedRoom('home-7-27', ['A', 'B', 'C'], { initialDeal: '2-down-0-reveal' });
  room.deal(2, 'p1');
  room.openBetting('p1');
  checkAround(room);
  room.openDrawingRound('p1');
  room.passDraw('p2');
  const seen = () => room.toRedactedState('p3').players.find((p) => p.id === 'p2').consecutivePasses;
  assert.strictEqual(seen(), 1);
  room.drawCard(room.drawTurnPlayerId);
  room.drawCard(room.drawTurnPlayerId);
  room.openBetting('p1');
  checkAround(room);
  room.openDrawingRound('p1');
  room.drawCard('p2');
  assert.strictEqual(seen(), 0, 'a Draw resets it');
  room.passDraw(room.drawTurnPlayerId);
  room.passDraw(room.drawTurnPlayerId);
  assert.strictEqual(room.toRedactedState('p1').players.find((p) => p.id === 'p3').consecutivePasses, 1);
  room.terminateGameCleanly('p1');
  assert.ok(room.startGame('p1').ok);
  for (const p of room.toRedactedState('p1').players) assert.strictEqual(p.consecutivePasses, 0, 'reset each hand');
});

test('13.2 C.2: Pick-a-Card, $0 pot, At Showdown -- waits at Showdown until everyone has shown, then CycleComplete', () => {
  const room = startedRoom('home-pick-a-card', ['A', 'B', 'C'], { reveal: 'at-showdown' });
  while (room.handPhase === 'PickDraw') room.pickCard(room.pickTurnPlayerId, 1);
  assert.strictEqual(room.handPhase, 'Showdown', 'stays at Showdown');
  assert.strictEqual(room.toRedactedState('p1').claimWindowOpen, false, 'no claim');
  room.revealHand('p1');
  room.revealHand('p2');
  assert.strictEqual(room.handPhase, 'Showdown');
  room.revealHand('p3');
  assert.strictEqual(room.handPhase, 'CycleComplete');
});

test('13.2 C.2: a participant who sits out is dropped from the wait; When Drawn still goes straight to CycleComplete', () => {
  const room = startedRoom('home-pick-a-card', ['A', 'B', 'C'], { reveal: 'at-showdown' });
  while (room.handPhase === 'PickDraw') room.pickCard(room.pickTurnPlayerId, 1);
  room.revealHand('p1');
  room.revealHand('p2');
  room.sitOut('p3', 'foldAndSitOut');
  assert.strictEqual(room.handPhase, 'CycleComplete');

  const drawn = startedRoom('home-pick-a-card', ['A', 'B']);
  while (drawn.handPhase === 'PickDraw') drawn.pickCard(drawn.pickTurnPlayerId, 1);
  assert.strictEqual(drawn.handPhase, 'CycleComplete');
});

test('13.2 C.3: wording -- "Is Deciding", "Draw Card", "Go All In anyway?"', () => {
  const root = path.join(__dirname, '..', 'public');
  const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(client.includes("verb = 'Is Deciding';"));
  assert.ok(!client.includes("verb = 'Is Drawing';"));
  assert.ok(client.includes('Go All In anyway?'));
  assert.ok(!client.includes('Go All-In anyway?'));
  assert.ok(/id="btn-draw-card"[^>]*>Draw Card</.test(html));
  assert.ok(html.includes('may Draw Card or Pass'));
  assert.ok(client.includes('Drawing Round`'), 'Open Nth Drawing Round label still present');
  assert.ok(/Open \$\{ordinal\(gameTable\.drawRoundNumber \|\| 1\)\}\\nDrawing Round/.test(client), 'breaks after the ordinal');
});

// =============================== Part B ===============================

test('13.2 C.4: catalog -- stud-variants, last in its group, defaults as B.1', () => {
  const variants = GAME_CHOICES.filter((g) => g.menuGroup === 'stud-variants');
  assert.strictEqual(variants.length, 9);
  const g = variants[variants.length - 1];
  assert.strictEqual(g.id, NO_PEEK);
  assert.strictEqual(g.displayName, '7-Card No Peek');
  assert.strictEqual(g.profile, 'nopeek');
  assert.strictEqual(g.description, '7-Card No Peek - Flip cards over to match or beat high hand');
  assert.deepStrictEqual(g.hiddenOptions, { anteType: 'flat', bettingStructure: 'fixed-limit' });
  assert.deepStrictEqual(g.dealerOptions, { anteAmount: 1, fixedBet: 1, raiseCap: 3, flipUntil: 'tie-or-best', foldedHands: 'leave', audible: '' });
});

test('13.2 C.5: at most 7 players -- 8 dealt in is rejected with the B.2 message; 7 is allowed', () => {
  const eight = tableWithPlayers('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H');
  for (const p of eight.players) eight.buyChips(p.id, 100);
  eight.setGameChoice('p1', NO_PEEK);
  const r = eight.startGame('p1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, '7-Card No Peek allows at most 7 players — someone will need to sit out.');
  eight.sitOut('p8', 'foldAndSitOut');
  assert.ok(eight.startGame('p1').ok, '7 is allowed');
});

test('13.2 C.6: hidden from the owner; Reveal Next shows the leftmost card to everyone; Show Cards is rejected', () => {
  const room = noPeekDealt(['A', 'B', 'C']);
  for (const p of room.players) assert.strictEqual(p.hand.length, 7);
  const own = room.toRedactedState('p2').players.find((p) => p.id === 'p2').hand;
  assert.strictEqual(own.length, 7);
  assert.ok(own.every((c) => !hasIdentity(c)), "the owner's redacted hand has no rank or suit");
  const r = room.revealHand('p2');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'In 7-Card No Peek, cards are revealed one at a time from the Reveal Rail.');
  const leftmost = room.getPlayer('p2').hand[0];
  assert.ok(room.revealNext('p2').ok);
  for (const viewer of ['p1', 'p2', 'p3']) {
    const seen = room.toRedactedState(viewer).players.find((p) => p.id === 'p2').hand;
    assert.strictEqual(seen[0].id, leftmost.id, `${viewer} sees the revealed card`);
    assert.ok(seen.slice(1).every((c) => !hasIdentity(c)), `${viewer} sees nothing else`);
  }
  assert.strictEqual(room.toRedactedState('p1').players.find((p) => p.id === 'p2').faceDownCount, 6);
});

test('13.2 C.7: 1st Reveal -- the first Reveal Next ends the turn; the revealer is the pre-selected opener', () => {
  const room = noPeekDealt(['A', 'B', 'C']);
  assert.strictEqual(room.revealTurnPlayerId, 'p2', "starts at the Dealer's left");
  assert.strictEqual(room.toRedactedState('p1').revealRoundNumber, 1);
  room.revealNext('p2');
  assert.strictEqual(room.handPhase, 'RevealBetting');
  const s = room.toRedactedState('p1');
  assert.strictEqual(s.revealEndedBy, 'first');
  assert.strictEqual(s.preselectedOpeningBettorId, 'p2');
  assert.strictEqual(s.openingBettorId, 'p2');
  assert.strictEqual(s.rejectAvailable, false, 'no Reject after the automatic 1st Reveal');
  room.openBetting('p1');
  assert.strictEqual(room.currentTurnPlayerId, 'p2');
  assert.strictEqual(room.currentBetToCall, 0, '$0 to call');
  assert.strictEqual(room.highHandPlayerId, 'p2');
});

test('13.2 C.8 (CHANGED, buildfix): Open Betting is available at once, with no Reveal Next needed; the Dealer can Reject it', () => {
  const room = noPeekDealt(['A', 'B', 'C']);
  pastFirstReveal(room);
  assert.strictEqual(room.revealTurnPlayerId, 'p3');
  assert.strictEqual(room.toRedactedState('p3').openBettingAvailable, true);
  assert.ok(room.revealOpenBetting('p3').ok, 'allowed before any Reveal Next');
  assert.strictEqual(room.handPhase, 'RevealBetting');
  assert.strictEqual(room.toRedactedState('p1').preselectedOpeningBettorId, 'p3');
  assert.ok(room.rejectRevealOpen('p1').ok);
  assert.strictEqual(room.handPhase, 'Reveal');
  assert.strictEqual(room.revealTurnPlayerId, 'p3', 'Reject returns the rail to the same revealer');
});

test('13.2 BUILDFIX: a player with no face-down cards is never given the Reveal Rail', () => {
  const room = noPeekDealt(['A', 'B', 'C', 'D']);
  assert.ok(room.revealNext('p2').ok); // 1st Reveal ends; p2 will hold the high hand
  assert.ok(room.openBetting('p1').ok);
  for (const c of room.getPlayer('p3').hand) c.faceUp = true; // p3 has nothing left to reveal
  checkAround(room);
  assert.strictEqual(room.handPhase, 'Reveal');
  assert.strictEqual(room.revealTurnPlayerId, 'p4', 'p3 skipped: no face-down cards');
});

test('13.2 BUILDFIX: when nobody but the high-hand holder has a face-down card, the hand goes to Showdown', () => {
  const room = noPeekDealt(['A', 'B', 'C']);
  assert.ok(room.revealNext('p2').ok);
  assert.ok(room.openBetting('p1').ok); // p2 becomes the high-hand holder, still with 6 face-down cards
  for (const id of ['p1', 'p3']) for (const c of room.getPlayer(id).hand) c.faceUp = true;
  checkAround(room);
  assert.strictEqual(room.handPhase, 'Showdown');
});

test('13.2 BUILDFIX: a rejected Open Betting from a revealer with no face-down cards left folds them', () => {
  const room = noPeekDealt(['A', 'B', 'C']);
  pastFirstReveal(room);
  assert.strictEqual(room.revealTurnPlayerId, 'p3');
  for (const c of room.getPlayer('p3').hand) c.faceUp = true;
  assert.ok(room.revealOpenBetting('p3').ok);
  assert.ok(room.rejectRevealOpen('p1').ok);
  assert.strictEqual(room.getPlayer('p3').folded, true);
  assert.notStrictEqual(room.revealTurnPlayerId, 'p3');
});

test('13.2 C.9: Reject returns the rail to the same revealer; revealed cards stay up; the Reveal Next count is kept', () => {
  const room = noPeekDealt(['A', 'B', 'C']);
  pastFirstReveal(room);
  room.revealNext('p3');
  room.revealNext('p3');
  room.revealOpenBetting('p3');
  assert.strictEqual(room.toRedactedState('p1').rejectAvailable, true);
  assert.strictEqual(room.rejectRevealOpen('p2').ok, false, 'Dealer only');
  assert.ok(room.rejectRevealOpen('p1').ok);
  assert.strictEqual(room.handPhase, 'Reveal');
  assert.strictEqual(room.revealTurnPlayerId, 'p3');
  assert.strictEqual(room.revealRoundNumber, 2, 'same reveal, not a new one');
  assert.strictEqual(room.getPlayer('p3').hand.filter((c) => c.faceUp).length, 2);
  assert.ok(room.revealOpenBetting('p3').ok, 'count kept: Open Betting allowed without another Reveal Next');
  room.openBetting('p1');
  assert.strictEqual(room.rejectRevealOpen('p1').ok, false, 'not once betting is open');
});

test('13.2 C.10: Fold during a reveal (with zero Reveal Nexts) pre-selects the nearest participant counterclockwise; muck vs leave', () => {
  const room = noPeekDealt(['A', 'B', 'C', 'D']);
  pastFirstReveal(room);
  assert.strictEqual(room.revealTurnPlayerId, 'p3');
  assert.ok(room.fold('p3').ok, 'fold before any Reveal Next');
  assert.strictEqual(room.handPhase, 'RevealBetting');
  assert.strictEqual(room.toRedactedState('p1').revealEndedBy, 'fold');
  assert.strictEqual(room.toRedactedState('p1').preselectedOpeningBettorId, 'p2', 'counterclockwise from p3 is p2');
  assert.strictEqual(room.getPlayer('p3').hand.length, 7, 'Left on Table keeps the cards');
  assert.ok(room.getPlayer('p3').hand.every((c) => !c.faceUp), 'still hidden');

  const muck = noPeekDealt(['A', 'B', 'C', 'D'], { foldedHands: 'muck' });
  pastFirstReveal(muck);
  muck.fold('p3');
  assert.strictEqual(muck.getPlayer('p3').hand.length, 0, 'Mucked on Fold removes them');

  const wrap = noPeekDealt(['A', 'B', 'C']);
  wrap.fold('p2'); // 1st revealer folds: counterclockwise from p2 is p1 (the Dealer)
  assert.strictEqual(wrap.toRedactedState('p1').preselectedOpeningBettorId, 'p1');
});

test('13.2 C.11: next revealer goes clockwise from the last revealer, skipping the high-hand holder; a beaten player gets the rail again', () => {
  const room = noPeekDealt(['A', 'B', 'C', 'D']);
  pastFirstReveal(room); // p2 high hand
  const order = ['p2'];
  for (let i = 0; i < 4; i++) {
    const id = room.revealTurnPlayerId;
    order.push(id);
    room.revealNext(id);
    room.revealOpenBetting(id);
    room.openBetting('p1');
    assert.strictEqual(room.highHandPlayerId, id);
    checkAround(room);
  }
  assert.deepStrictEqual(order, ['p2', 'p3', 'p4', 'p1', 'p2'], 'p2 (beaten) gets the rail again');

  // Skipping: high-hand holder p3 sits directly after the last revealer.
  const skip = noPeekDealt(['A', 'B', 'C']);
  pastFirstReveal(skip); // high p2, last revealer p2 -> next p3
  skip.revealNext('p3');
  skip.revealOpenBetting('p3');
  skip.openBetting('p1');
  checkAround(skip); // high p3, last revealer p3 -> next p1
  assert.strictEqual(skip.revealTurnPlayerId, 'p1');
  skip.fold('p1'); // fold: last revealer p1, high p3 -> pre-select counterclockwise = p3
  skip.openBetting('p1');
  checkAround(skip);
  assert.strictEqual(skip.handPhase, 'Reveal');
  assert.strictEqual(skip.revealTurnPlayerId, 'p2', 'clockwise from p1 is p2; p3 holds the high hand and is skipped');
});

test('13.2 C.12: endings -- one participant left goes to Showdown (claim); everyone out of face-down cards goes to Showdown with a split claim', () => {
  const room = noPeekDealt(['A', 'B']);
  pastFirstReveal(room);
  assert.strictEqual(room.revealTurnPlayerId, 'p1');
  room.fold('p1');
  assert.strictEqual(room.handPhase, 'Showdown');
  assert.ok(room.toRedactedState('p2').claimWindowOpen);

  const tie = noPeekDealt(['A', 'B', 'C']);
  tie.revealNext('p2');
  for (const p of tie.players) for (const c of p.hand) c.faceUp = true;
  tie.openBetting('p1');
  checkAround(tie);
  assert.strictEqual(tie.handPhase, 'Showdown');
  const half = tie.pot / 3;
  assert.ok(tie.claimPot('p2', [{ playerId: 'p2', amount: half }, { playerId: 'p3', amount: half }, { playerId: 'p1', amount: half }]).ok);
  assert.ok(tie.resolveClaim(tie.pendingClaim.approverId, true).ok);
  assert.strictEqual(tie.handPhase, 'CycleComplete');
});

test('13.2 C.13: Fixed-Limit single bet -- every bet and raise is the Fixed Bet; Raise Cap applies; No Cap rejected', () => {
  const room = noPeekDealt(['A', 'B', 'C'], { fixedBet: 4, raiseCap: 1 });
  room.revealNext('p2');
  room.openBetting('p1');
  assert.strictEqual(room.placeBet('p2', 8).ok, false);
  assert.ok(room.placeBet('p2', 4).ok);
  assert.ok(room.placeBet('p3', 8).ok);
  assert.strictEqual(room.placeBet('p1', 12).ok, false, 'Raise Cap 1 reached');
  const opts = tableWithPlayers('A', 'B');
  opts.setGameChoice('p1', NO_PEEK);
  assert.strictEqual(opts.setGameOption('p1', 'raiseCap', 'no-cap').ok, false);
  assert.strictEqual(opts.setGameOption('p1', 'flipUntil', 'x').ok, false);
  assert.ok(opts.setGameOption('p1', 'flipUntil', 'best').ok);
});

test('13.2 C.14: Select Opening Bettor works for No Peek only during RevealBetting with betting not open', () => {
  const room = noPeekDealt(['A', 'B', 'C']);
  assert.strictEqual(room.setOpeningBettor('p1', 'p3').ok, false, 'not during a reveal');
  room.revealNext('p2');
  assert.ok(room.setOpeningBettor('p1', 'p3').ok);
  assert.strictEqual(room.toRedactedState('p1').openingBettorId, 'p3');
  assert.strictEqual(room.toRedactedState('p1').preselectedOpeningBettorId, 'p2', 'the pre-selection is still reported');
  room.openBetting('p1');
  assert.strictEqual(room.currentTurnPlayerId, 'p3');
  assert.strictEqual(room.setOpeningBettor('p1', 'p2').ok, false, 'not once betting is open');
});

test('13.2 C.15: a revealer whose grace expires is folded and the hand moves on', () => {
  const room = noPeekDealt(['A', 'B', 'C', 'D']);
  pastFirstReveal(room);
  assert.strictEqual(room.revealTurnPlayerId, 'p3');
  room.markDisconnected('p3');
  room.expireDisconnectGrace('p3');
  assert.strictEqual(room.getPlayer('p3').folded, true);
  assert.strictEqual(room.handPhase, 'RevealBetting');
  assert.strictEqual(room.toRedactedState('p1').revealEndedBy, 'fold');
  assert.strictEqual(room.toRedactedState('p1').preselectedOpeningBettorId, 'p2');

  const sitter = noPeekDealt(['A', 'B', 'C', 'D']);
  pastFirstReveal(sitter);
  sitter.sitOut('p3', 'foldAndSitOut');
  assert.strictEqual(sitter.handPhase, 'RevealBetting', 'a sit-out is treated as Fold too');
});

test('13.2 C.16: Show All after the claim (Left on Table) -- every unrevealed card visible to everyone, owner included, still dealt down', () => {
  const room = noPeekDealt(['A', 'B', 'C']);
  pastFirstReveal(room);
  room.fold('p3'); // Reveal 2: p3 folds with 7 hidden cards
  room.openBetting('p1');
  room.placeBet(room.currentTurnPlayerId, 1);
  room.fold(room.currentTurnPlayerId);
  assert.strictEqual(room.handPhase, 'Showdown');
  const winner = room.players.find((p) => !p.folded).id;
  room.claimPot(winner, [{ playerId: winner, amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.ok(room.showAll('p1').ok);
  const hidden = room.getPlayer('p3').hand;
  for (const viewer of ['p1', 'p2', 'p3']) {
    const seen = room.toRedactedState(viewer).players.find((p) => p.id === 'p3').hand;
    assert.deepStrictEqual(seen.map((c) => c.id), hidden.map((c) => c.id), `${viewer} sees every card`);
    assert.ok(seen.every((c) => c.faceUp === false && hasIdentity(c)), 'identities visible, still marked dealt down');
  }
});

test('13.2 B.7: profile audit -- No Peek rejects the Discard / Deal to Player / Deal to All / Deal Community primitives', () => {
  const room = noPeekDealt(['A', 'B']);
  const card = room.getPlayer('p2').hand[0];
  assert.strictEqual(room.discard('p2', [card.id]).ok, false);
  assert.strictEqual(room.dealToPlayer('p1', 'p2').ok, false);
  assert.strictEqual(room.dealToAllPlayers('p1').ok, false);
  assert.strictEqual(room.dealCommunity('p1', 1).ok, false);
});

// In normal play the seat right after the last revealer is never the
// high-hand holder (every player between the holder and the revealer has
// folded, or the revealer IS the holder), so C.11's skip can't be seen
// through play alone. This sets the state up directly to pin the rule.
test('13.2 C.11b: the next revealer skips the high-hand holder when the holder is next clockwise (state set directly)', () => {
  const room = noPeekDealt(['A', 'B', 'C', 'D']);
  room.revealNext('p2'); // last revealer p2
  room.openBetting('p1');
  room.highHandPlayerId = 'p3'; // p3 is next clockwise after p2
  checkAround(room);
  assert.strictEqual(room.handPhase, 'Reveal');
  assert.strictEqual(room.revealTurnPlayerId, 'p4', 'p3 holds the high hand and is skipped');
});

test('13.2 BUILDFIX: No Peek cards stay hidden after the Dealer selects a different game; the next game deals normally', () => {
  const room = noPeekDealt(['A', 'B', 'C']);
  // End the hand quickly: p2 reveals (1st Reveal), betting checks around, then the next two revealers fold.
  pastFirstReveal(room);
  assert.ok(room.fold(room.revealTurnPlayerId).ok);
  if (room.handPhase === 'RevealBetting') {
    assert.ok(room.openBetting('p1').ok);
    checkAround(room);
    assert.ok(room.fold(room.revealTurnPlayerId).ok);
  }
  const winner = room.players.find((p) => !p.folded);
  assert.ok(room.claimPot(winner.id, [{ playerId: winner.id, amount: room.pot }]).ok);
  assert.ok(room.resolveClaim(room.pendingClaim.approverId, true).ok);
  assert.strictEqual(room.handPhase, 'CycleComplete');
  // Dealer picks another game; the No Peek cards are still on the table.
  assert.ok(room.setGameChoice('p1', 'draw-5card').ok);
  for (const owner of room.players) {
    const own = room.toRedactedState(owner.id).players.find((p) => p.id === owner.id).hand;
    assert.ok(own.filter((c) => !c.faceUp).every((c) => !hasIdentity(c)), `${owner.name} sees a hidden No Peek card after Select`);
    if (owner.hand.length) assert.strictEqual(room.revealHand(owner.id).ok, false);
  }
  assert.strictEqual(room.toRedactedState('p1').cardsHiddenFromOwner, true);
  // Starting the new game clears the table; Draw cards are visible to their owner as usual.
  assert.ok(room.startGame('p1').ok);
  payAntes(room);
  assert.strictEqual(room.toRedactedState('p1').cardsHiddenFromOwner, false);
  assert.ok(room.deal(5, 'p1').ok);
  const mine = room.toRedactedState('p2').players.find((p) => p.id === 'p2').hand;
  assert.ok(mine.length > 0 && mine.every(hasIdentity), 'Draw owner should see their own cards');
});
