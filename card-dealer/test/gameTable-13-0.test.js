'use strict';

const fs = require('fs');
const path = require('path');
const { assert, test, tableWithPlayers } = require('./helpers');
const { GAME_CHOICES } = require('../src/gameTable');

// ---------------------------------------------------------------
// v13.0: Home Game Favorites, Pick-a-Card, 7-27 / 15-35
// (the-cut-spec_v13-0.md Part E, tests 1-14).
// ---------------------------------------------------------------

const VALID_MENU_GROUPS = ['draw', 'stud', 'stud-variants', 'holdem', 'home-favorites'];

function payAntes(room) {
  for (const p of room.players) if (p.oweAnte > 0) room.postAnteBlind(p.id);
}

/** A room for the given game, everyone bought in, antes paid -- OpeningDeal for vying, PickDraw for pickcard. */
function roomFor(gameChoiceId, names, options = {}) {
  const room = tableWithPlayers(...names);
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', gameChoiceId);
  for (const [k, v] of Object.entries(options)) {
    const r = room.setGameOption('p1', k, v);
    assert.ok(r.ok, `setGameOption ${k}: ${r.error}`);
  }
  const started = room.startGame('p1');
  assert.ok(started.ok, started.error);
  payAntes(room);
  return room;
}

/** vying room dealt and past the Initial Reveal (everyone reveals their first card), sitting at InitialBetting. */
function vyingAtInitialBetting(gameChoiceId, names, options = {}) {
  const room = roomFor(gameChoiceId, names, options);
  assert.strictEqual(room.handPhase, 'OpeningDeal');
  assert.ok(room.deal(99, 'p1').ok);
  if (room.handPhase === 'InitialReveal') {
    for (const p of room.players) room.revealComplete(p.id, [p.hand[0].id]);
  }
  assert.strictEqual(room.handPhase, 'InitialBetting');
  return room;
}

function checkAround(room) {
  let guard = 0;
  while (room.bettingOpen && guard++ < 50) assert.ok(room.check(room.currentTurnPlayerId).ok);
}

/** Opens the drawing round and has each turn-holder act per `decide(player) -> 'draw' | 'pass'`. */
function playDrawRound(room, decide) {
  assert.ok(room.openDrawingRound('p1').ok);
  let guard = 0;
  while (room.handPhase === 'DrawRound' && room.drawRoundOpen && guard++ < 50) {
    const id = room.drawTurnPlayerId;
    const r = decide(room.getPlayer(id)) === 'draw' ? room.drawCard(id) : room.passDraw(id);
    assert.ok(r.ok, r.error);
  }
}

// ---- 1. menuGroup --------------------------------------------------

test('13.0 E.1: every game-choices.json entry has a valid menuGroup', () => {
  for (const g of GAME_CHOICES) {
    assert.ok(VALID_MENU_GROUPS.includes(g.menuGroup), `${g.id} has menuGroup ${JSON.stringify(g.menuGroup)}`);
  }
});

test('13.0 E.1: existing entries keep their 12.x groups; Home Game Favorites holds 7-27, 15-35, Pick-a-Card in that order', () => {
  const byId = Object.fromEntries(GAME_CHOICES.map((g) => [g.id, g.menuGroup]));
  assert.strictEqual(byId['draw-5card'], 'draw');
  assert.strictEqual(byId['stud-5card'], 'stud');
  assert.strictEqual(byId['stud-7card'], 'stud');
  for (const g of GAME_CHOICES.filter((x) => x.id.startsWith('stud-7card-'))) assert.strictEqual(g.menuGroup, 'stud-variants');
  for (const g of GAME_CHOICES.filter((x) => x.profile === 'holdem')) assert.strictEqual(g.menuGroup, 'holdem');
  const home = GAME_CHOICES.filter((g) => g.menuGroup === 'home-favorites').map((g) => g.id);
  assert.deepStrictEqual(home, ['home-7-27', 'home-15-35', 'home-pick-a-card']);
});

test('13.0 E.1: the client groups Select by menuGroup alone, with Home Game Favorites last', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const fnMatch = /function selectGroupKeyFor\(gameChoice\) \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(fnMatch, 'selectGroupKeyFor() not found');
  assert.ok(!/startsWith|profile/.test(fnMatch[1]), 'selectGroupKeyFor() must not derive the group from id or profile');
  const groupsMatch = /const SELECT_MENU_GROUPS = \[([\s\S]*?)\];/.exec(src);
  assert.ok(groupsMatch, 'SELECT_MENU_GROUPS not found');
  const keys = [...groupsMatch[1].matchAll(/key: '([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(keys, VALID_MENU_GROUPS);
  assert.ok(groupsMatch[1].includes("label: 'Home Game Favorites'"));
});

// ---- 2-4. Pick-a-Card ------------------------------------------------

test('13.0 E.2: Pick-a-Card, $0 ante -> PickDraw at once -> one draw each, clockwise -> CycleComplete with no claim', () => {
  const room = roomFor('home-pick-a-card', ['A', 'B', 'C']);
  assert.strictEqual(room.handPhase, 'PickDraw', 'a $0 ante skips straight past RequestAntes');
  const order = [];
  while (room.handPhase === 'PickDraw') {
    order.push(room.pickTurnPlayerId);
    assert.ok(room.pickCard(room.pickTurnPlayerId, 1).ok);
  }
  assert.deepStrictEqual(order, ['p2', 'p3', 'p1'], 'starts left of the Dealer and goes clockwise');
  assert.strictEqual(room.handPhase, 'CycleComplete');
  assert.strictEqual(room.idle, true);
  for (const p of room.players) assert.strictEqual(p.hand.length, 1);
  assert.strictEqual(room.toRedactedState('p1').claimWindowOpen, false);
});

test('13.0 E.3: Pick-a-Card, ante > 0 -> Showdown with a normal claim, including a two-way split', () => {
  const room = roomFor('home-pick-a-card', ['A', 'B', 'C'], { anteAmount: 5 });
  assert.strictEqual(room.handPhase, 'PickDraw');
  while (room.handPhase === 'PickDraw') room.pickCard(room.pickTurnPlayerId, 1);
  assert.strictEqual(room.handPhase, 'Showdown');
  assert.strictEqual(room.pot, 15);
  const claim = room.claimPot('p2', [{ playerId: 'p2', amount: 8 }, { playerId: 'p3', amount: 7 }]);
  assert.ok(claim.ok, claim.error);
  const approver = room.pendingClaim.approverId;
  assert.ok(room.resolveClaim(approver, true).ok);
  assert.strictEqual(room.handPhase, 'CycleComplete');
  assert.strictEqual(room.getPlayer('p2').chips, 1000 - 5 + 8);
  assert.strictEqual(room.getPlayer('p3').chips, 1000 - 5 + 7);
});

test('13.0 E.4: Pick-a-Card range is enforced; the drawn card is the one at that position from the top', () => {
  const room = roomFor('home-pick-a-card', ['A', 'B']);
  const id = room.pickTurnPlayerId;
  assert.strictEqual(room.pickCard(id, 0).ok, false);
  assert.strictEqual(room.pickCard(id, room.deck.length + 1).ok, false);
  assert.strictEqual(room.pickCard(id, 2.5).ok, false);
  assert.strictEqual(room.pickCard('p1', 1).ok, false, 'not your turn');
  const state = room.toRedactedState(id);
  assert.deepStrictEqual(state.pickRange, { min: 1, max: room.deck.length });
  const expected = room.deck[room.deck.length - 3]; // 3rd from the top (deal() pops from the end)
  assert.ok(room.pickCard(id, 3).ok);
  const got = room.getPlayer(id).hand[0];
  assert.strictEqual(got.id, expected.id);
  assert.strictEqual(got.faceUp, true, 'When Drawn = face up');
});

test('13.0 E.4: Pick-a-Card Reveal = At Showdown draws face down, then every card turns up once the last player draws', () => {
  const room = roomFor('home-pick-a-card', ['A', 'B', 'C'], { anteAmount: 1, reveal: 'at-showdown' });
  room.pickCard(room.pickTurnPlayerId, 1);
  const first = room.players.find((p) => p.hand.length === 1);
  assert.strictEqual(first.hand[0].faceUp, false);
  assert.deepStrictEqual(room.toRedactedState('p1').players.find((p) => p.id === first.id).hand, [{ faceUp: false }]);
  while (room.handPhase === 'PickDraw') room.pickCard(room.pickTurnPlayerId, 1);
  assert.strictEqual(room.handPhase, 'Showdown');
  for (const p of room.players) assert.strictEqual(p.hand[0].faceUp, true);
});

test('13.0 C.2: Pick-a-Card has no deal and no betting', () => {
  const room = roomFor('home-pick-a-card', ['A', 'B'], { anteAmount: 1 });
  assert.strictEqual(room.deal(1, 'p1').ok, false);
  assert.strictEqual(room.openBetting('p1').ok, false);
});

test('13.0 C.2: Pick-a-Card needs 2 players with chips to start', () => {
  const room = tableWithPlayers('A', 'B');
  room.buyChips('p1', 100);
  room.setGameChoice('p1', 'home-pick-a-card');
  assert.strictEqual(room.startGame('p1').ok, false);
});

// ---- 5-6. Phases and Initial Reveal --------------------------------

test('13.0 E.5: 7-27, 3 players -- every phase in order, including the Initial Reveal', () => {
  const room = roomFor('home-7-27', ['A', 'B', 'C']);
  const seen = [room.handPhase];
  const track = () => {
    if (seen[seen.length - 1] !== room.handPhase) seen.push(room.handPhase);
  };
  assert.ok(room.deal(5, 'p1').ok); // client count is ignored: Initial Deal says 2
  for (const p of room.players) assert.strictEqual(p.hand.length, 2);
  for (const p of room.players) for (const c of p.hand) assert.strictEqual(c.faceUp, false);
  track();
  for (const p of room.players) room.revealComplete(p.id, [p.hand[0].id]);
  track();
  room.openBetting('p1');
  checkAround(room);
  track();
  assert.strictEqual(room.drawRoundNumber, 1);
  playDrawRound(room, () => 'draw');
  track();
  room.openBetting('p1');
  checkAround(room);
  track();
  assert.strictEqual(room.drawRoundNumber, 2);
  playDrawRound(room, () => 'pass');
  track();
  for (const p of room.players) assert.ok(room.declare(p.id, 'a').ok);
  track();
  assert.deepStrictEqual(seen, ['OpeningDeal', 'InitialReveal', 'InitialBetting', 'DrawRound', 'DrawBetting', 'DrawRound', 'Declare', 'Showdown']);
  assert.strictEqual(room.pot, 3);
  assert.ok(room.claimPot('p2', [{ playerId: 'p2', amount: 3 }]).ok);
  assert.ok(room.resolveClaim(room.pendingClaim.approverId, true).ok);
  assert.strictEqual(room.handPhase, 'CycleComplete');
});

test('13.0 E.5: 15-35 deals 3; "2 down, no reveal" skips the Initial Reveal', () => {
  const r15 = roomFor('home-15-35', ['A', 'B']);
  r15.deal(2, 'p1');
  for (const p of r15.players) assert.strictEqual(p.hand.length, 3);
  assert.strictEqual(r15.handPhase, 'InitialReveal');
  const r = roomFor('home-7-27', ['A', 'B'], { initialDeal: '2-down-0-reveal' });
  r.deal(2, 'p1');
  assert.strictEqual(r.handPhase, 'InitialBetting');
});

test('13.0 E.6: Initial Reveal -- zero cards rejected; selection private until all done; all flip together', () => {
  const room = roomFor('home-7-27', ['A', 'B', 'C']);
  room.deal(2, 'p1');
  assert.strictEqual(room.revealComplete('p1', []).ok, false);
  const p1 = room.getPlayer('p1');
  assert.ok(room.revealComplete('p1', [p1.hand[1].id]).ok);
  assert.strictEqual(room.revealComplete('p1', [p1.hand[0].id]).ok, false, 'final once complete');
  assert.ok(room.revealComplete('p2', [room.getPlayer('p2').hand[0].id, room.getPlayer('p2').hand[1].id]).ok, 'more than one is allowed');

  const view = room.toRedactedState('p3');
  const p1View = view.players.find((p) => p.id === 'p1');
  assert.strictEqual(p1View.revealDone, true);
  assert.deepStrictEqual(p1View.hand, [{ faceUp: false }, { faceUp: false }], 'no card shown before everyone is done');
  assert.ok(!JSON.stringify(view).includes('revealSelection'));
  assert.strictEqual(p1.hand[1].faceUp, false);

  assert.ok(room.revealComplete('p3', [room.getPlayer('p3').hand[0].id]).ok);
  assert.strictEqual(room.handPhase, 'InitialBetting');
  assert.strictEqual(p1.hand[1].faceUp, true);
  assert.strictEqual(p1.hand[0].faceUp, false);
  assert.ok(room.getPlayer('p2').hand.every((c) => c.faceUp));
  assert.strictEqual(room.fold('p1').ok, false, 'no fold outside a betting round');
});

// ---- 7-8. Frozen, no-draw rounds -----------------------------------

test('13.0 E.7: two passes in a row freeze; a draw in between resets; frozen players still bet, declare and claim', () => {
  const room = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C']);
  room.openBetting('p1');
  checkAround(room);
  // Round 1: p2 passes, others draw.
  playDrawRound(room, (p) => (p.id === 'p2' ? 'pass' : 'draw'));
  assert.strictEqual(room.getPlayer('p2').consecutivePasses, 1);
  room.openBetting('p1');
  checkAround(room);
  // Round 2: p2 draws (reset), p3 passes.
  playDrawRound(room, (p) => (p.id === 'p3' ? 'pass' : 'draw'));
  assert.strictEqual(room.getPlayer('p2').consecutivePasses, 0);
  assert.strictEqual(room.getPlayer('p2').frozen, false);
  room.openBetting('p1');
  checkAround(room);
  // Round 3: p3 passes again -> frozen.
  playDrawRound(room, (p) => (p.id === 'p3' ? 'pass' : 'draw'));
  assert.strictEqual(room.getPlayer('p3').frozen, true);
  assert.strictEqual(room.toRedactedState('p1').players.find((p) => p.id === 'p3').frozen, true);
  // A betting round: the frozen player still bets.
  room.openBetting('p1');
  let frozenBet = false;
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) {
    const id = room.currentTurnPlayerId;
    if (id === 'p3' && !frozenBet) {
      assert.ok(room.placeBet('p3', room.getPlayer('p3').currentBet + 1).ok);
      frozenBet = true;
    } else if (room.currentBetToCall > room.getPlayer(id).currentBet) room.call(id);
    else room.check(id);
  }
  assert.ok(frozenBet);
  // Round 4: the rail skips p3 entirely.
  const visited = [];
  room.openDrawingRound('p1');
  while (room.drawRoundOpen) {
    visited.push(room.drawTurnPlayerId);
    room.passDraw(room.drawTurnPlayerId);
  }
  assert.ok(!visited.includes('p3'));
  assert.strictEqual(room.handPhase, 'Declare');
  assert.ok(room.declare('p3', 'b').ok);
});

test('13.0 E.8: a drawing round where nobody draws goes straight to Declare with no betting round', () => {
  const room = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C']);
  room.openBetting('p1');
  checkAround(room);
  const roundsBefore = room.bettingRoundsThisHand;
  playDrawRound(room, () => 'pass');
  assert.strictEqual(room.handPhase, 'Declare');
  assert.strictEqual(room.bettingRoundsThisHand, roundsBefore);
});

test('13.0 E.8: everyone frozen when a betting round closes -> Declare, no DrawRound to open', () => {
  const room = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C']);
  for (const p of room.players) p.frozen = true;
  room.openBetting('p1');
  checkAround(room);
  assert.strictEqual(room.handPhase, 'Declare');
});

// ---- 9. Last player standing -----------------------------------------

test('13.0 E.9: early claim works mid-DrawRound; Declare is never entered with one participant', () => {
  const room = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C']);
  room.openBetting('p1');
  // p2 bets, p3 and p1 fold.
  assert.ok(room.placeBet('p2', 1).ok);
  room.fold('p3');
  room.fold('p1');
  assert.strictEqual(room.handPhase, 'Showdown', 'one participant left -> Showdown, never DrawRound/Declare');
  assert.ok(room.toRedactedState('p2').claimWindowOpen);

  const room2 = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C']);
  room2.openBetting('p1');
  checkAround(room2);
  assert.strictEqual(room2.handPhase, 'DrawRound');
  room2.openDrawingRound('p1');
  room2.sitOut('p3', 'foldAndSitOut');
  room2.sitOut('p2', 'foldAndSitOut');
  assert.ok(room2.toRedactedState('p1').claimWindowOpen, 'early claim available mid-DrawRound');
  assert.notStrictEqual(room2.handPhase, 'Declare');
});

// ---- 10. Fixed-Limit single bet ---------------------------------------

test('13.0 E.10: every bet and raise equals fixedBet in every round; Raise Cap enforced', () => {
  const room = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C'], { fixedBet: 5, raiseCap: 2 });
  room.openBetting('p1');
  assert.strictEqual(room.placeBet('p2', 10).ok, false, 'a bet must equal the fixed amount');
  assert.ok(room.placeBet('p2', 5).ok);
  assert.strictEqual(room.placeBet('p3', 15).ok, false, 'a raise is exactly one fixed amount');
  assert.ok(room.placeBet('p3', 10).ok);
  assert.ok(room.placeBet('p1', 15).ok);
  assert.strictEqual(room.placeBet('p2', 20).ok, false, 'Raise Cap 2 reached');
  room.call('p2');
  room.call('p3');
  assert.strictEqual(room.handPhase, 'DrawRound');
  playDrawRound(room, () => 'draw');
  assert.strictEqual(room.handPhase, 'DrawBetting');
  room.openBetting('p1');
  assert.strictEqual(room.placeBet(room.currentTurnPlayerId, 6).ok, false);
  assert.ok(room.placeBet(room.currentTurnPlayerId, 5).ok, 'same amount in a later round');
});

test('13.0 E.10: server rejects fixedBet < 1, raiseCap < 1 / No Cap, anteAmount < 0 or fractional (anteAmount check is global)', () => {
  const room = tableWithPlayers('A', 'B');
  room.setGameChoice('p1', 'home-7-27');
  assert.strictEqual(room.setGameOption('p1', 'fixedBet', 0).ok, false);
  assert.strictEqual(room.setGameOption('p1', 'fixedBet', 1.5).ok, false);
  assert.strictEqual(room.setGameOption('p1', 'raiseCap', 0).ok, false);
  assert.strictEqual(room.setGameOption('p1', 'raiseCap', 'no-cap').ok, false);
  assert.strictEqual(room.setGameOption('p1', 'anteAmount', -1).ok, false);
  assert.ok(room.setGameOption('p1', 'anteAmount', 0).ok);
  assert.ok(room.setGameOption('p1', 'fixedBet', 3).ok);
  assert.strictEqual(room.setGameOption('p1', 'overUnder', 'something-else').ok, false);
  assert.ok(room.setGameOption('p1', 'overUnder', 'under-trumps').ok);
  room.setGameChoice('p1', 'draw-5card');
  assert.strictEqual(room.setGameOption('p1', 'anteAmount', -2).ok, false);
  assert.strictEqual(room.setGameOption('p1', 'anteAmount', 2.5).ok, false);
  assert.ok(room.setGameOption('p1', 'anteAmount', 3).ok);
});

// ---- 11. Folded Hands and Show All -------------------------------------

test('13.0 E.11: Folded Hands "muck" removes the folded cards; "leave" keeps them', () => {
  const muck = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C'], { foldedHands: 'muck' });
  muck.openBetting('p1');
  muck.placeBet('p2', 1);
  muck.fold('p3');
  assert.strictEqual(muck.getPlayer('p3').hand.length, 0);
  assert.strictEqual(muck.toRedactedState('p1').players.find((p) => p.id === 'p3').hand.length, 0);

  const leave = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C']);
  leave.openBetting('p1');
  leave.placeBet('p2', 1);
  const before = leave.getPlayer('p3').hand.map((c) => `${c.id}:${c.faceUp}`);
  leave.fold('p3');
  assert.deepStrictEqual(leave.getPlayer('p3').hand.map((c) => `${c.id}:${c.faceUp}`), before);
});

test('13.0 E.11: Show All -- only with "leave", only after the claim is approved; turns every face-down card up', () => {
  const room = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C']);
  room.openBetting('p1');
  room.placeBet('p2', 1);
  room.fold('p3');
  room.fold('p1');
  assert.strictEqual(room.handPhase, 'Showdown');
  assert.strictEqual(room.showAll('p1').ok, false, 'not before the claim');
  assert.strictEqual(room.toRedactedState('p1').showAllAvailable, false);
  room.claimPot('p2', [{ playerId: 'p2', amount: room.pot }]);
  assert.strictEqual(room.showAll('p1').ok, false, 'not while the claim is pending');
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.strictEqual(room.toRedactedState('p2').showAllAvailable, true);
  assert.strictEqual(room.showAll('p2').ok, false, 'Dealer only');
  assert.ok(room.showAll('p1').ok);
  for (const p of room.players) for (const c of p.hand) assert.strictEqual(c.faceUp, true);
  assert.strictEqual(room.toRedactedState('p1').showAllAvailable, false, 'gone once used');

  const muck = vyingAtInitialBetting('home-7-27', ['A', 'B'], { foldedHands: 'muck' });
  muck.openBetting('p1');
  muck.placeBet('p2', 1);
  muck.fold('p1');
  muck.claimPot('p2', [{ playerId: 'p2', amount: muck.pot }]);
  muck.resolveClaim(muck.pendingClaim.approverId, true);
  assert.strictEqual(muck.showAll('p1').ok, false, 'never with "muck"');
});

// ---- 12. Leaving mid-phase -------------------------------------------------

test('13.0 E.12: sit-out or grace expiry never hangs PickDraw; the skipped player draws no card', () => {
  const room = roomFor('home-pick-a-card', ['A', 'B', 'C'], { anteAmount: 1 });
  assert.strictEqual(room.pickTurnPlayerId, 'p2');
  room.markDisconnected('p2');
  room.expireDisconnectGrace('p2');
  assert.strictEqual(room.pickTurnPlayerId, 'p3');
  room.sitOut('p3', 'foldAndSitOut');
  assert.strictEqual(room.pickTurnPlayerId, 'p1');
  room.pickCard('p1', 1);
  assert.strictEqual(room.handPhase, 'Showdown');
  assert.strictEqual(room.getPlayer('p2').hand.length, 0);
});

test('13.0 E.12: grace expiry while holding the Drawing Rail counts as a Pass; the rail moves on', () => {
  const room = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C']);
  room.openBetting('p1');
  checkAround(room);
  room.openDrawingRound('p1');
  assert.strictEqual(room.drawTurnPlayerId, 'p2');
  room.markDisconnected('p2');
  room.expireDisconnectGrace('p2');
  assert.strictEqual(room.getPlayer('p2').consecutivePasses, 1);
  assert.strictEqual(room.drawTurnPlayerId, 'p3');
});

test('13.0 E.12: a sit-out during the Initial Reveal stops the phase waiting on that player', () => {
  const room = roomFor('home-7-27', ['A', 'B', 'C']);
  room.deal(2, 'p1');
  room.revealComplete('p1', [room.getPlayer('p1').hand[0].id]);
  room.revealComplete('p2', [room.getPlayer('p2').hand[0].id]);
  assert.strictEqual(room.handPhase, 'InitialReveal');
  room.sitOut('p3', 'foldAndSitOut');
  assert.strictEqual(room.handPhase, 'InitialBetting');
});

test('13.0 E.12: an all-in player who sits out while holding the Drawing Rail never hangs the round', () => {
  const room = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C']);
  room.openBetting('p1');
  checkAround(room);
  room.openDrawingRound('p1');
  assert.strictEqual(room.drawTurnPlayerId, 'p2');
  room.getPlayer('p2').allIn = true; // all-in players can still hold the rail (drawing is free)
  room.sitOut('p2', 'foldAndSitOut');
  assert.strictEqual(room.drawTurnPlayerId, 'p3');
});

// ---- 13. Empty deck ------------------------------------------------------

test('13.0 E.13: empty deck during DrawRound -- Draw 1 Card rejected, Pass still works (and counts toward frozen)', () => {
  const room = vyingAtInitialBetting('home-7-27', ['A', 'B']);
  room.openBetting('p1');
  checkAround(room);
  room.openDrawingRound('p1');
  room.discardPile.push(...room.deck.splice(0));
  assert.strictEqual(room.toRedactedState('p1').drawCardAvailable, false);
  const id = room.drawTurnPlayerId;
  assert.strictEqual(room.drawCard(id).ok, false);
  assert.ok(room.passDraw(id).ok);
  assert.strictEqual(room.getPlayer(id).consecutivePasses, 1);
});

// ---- 14. Regression ---------------------------------------------------------

test('13.0 E.14: existing presets are unaffected -- profiles, phase entry, and no Show All', () => {
  const draw = tableWithPlayers('A', 'B');
  for (const p of draw.players) draw.buyChips(p.id, 100);
  draw.setGameChoice('p1', 'draw-5card');
  draw.startGame('p1');
  payAntes(draw);
  assert.strictEqual(draw.handPhase, 'OpeningDeal');
  assert.ok(draw.deal(5, 'p1').ok);
  assert.strictEqual(draw.handPhase, 'FirstBetting');
  assert.strictEqual(draw.toRedactedState('p1').showAllAvailable, false);
  assert.strictEqual(draw.toRedactedState('p1').initialDealCount, null);
  for (const g of GAME_CHOICES.filter((x) => !x.id.startsWith('home-'))) {
    assert.ok(['draw', 'stud', 'holdem'].includes(g.profile));
  }
});

test('13.0 E.7b: frozen and the pass count are cleared at the start of the next hand', () => {
  const room = vyingAtInitialBetting('home-7-27', ['A', 'B', 'C']);
  room.openBetting('p1');
  checkAround(room);
  playDrawRound(room, (p) => (p.id === 'p3' ? 'pass' : 'draw'));
  room.openBetting('p1');
  checkAround(room);
  playDrawRound(room, (p) => (p.id === 'p3' ? 'pass' : 'draw'));
  assert.strictEqual(room.getPlayer('p3').frozen, true);
  // End the hand: everyone but p2 folds, p2 claims, claim approved.
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 20) {
    const id = room.currentTurnPlayerId;
    if (id === 'p2') room.check(id); else room.fold(id);
  }
  room.claimPot('p2', [{ playerId: 'p2', amount: room.pot }]);
  assert.ok(room.resolveClaim(room.pendingClaim.approverId, true).ok);
  // Next hand.
  assert.ok(room.startGame('p1').ok);
  payAntes(room);
  for (const p of room.players) {
    assert.strictEqual(p.frozen, false, `${p.id} still frozen in the new hand`);
    assert.strictEqual(p.consecutivePasses, 0, `${p.id} pass count carried over`);
  }
});
