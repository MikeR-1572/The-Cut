'use strict';

const fs = require('fs');
const path = require('path');
const { assert, test, tableWithPlayers } = require('./helpers');
const { GAME_CHOICES } = require('../src/gameTable');

// ---------------------------------------------------------------
// v13.1: 13.0 play-test findings (the-cut-spec_v13-1.md Part G).
// ---------------------------------------------------------------

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
  assert.ok(room.startGame('p1').ok);
  payAntes(room);
  return room;
}

/** 7-27, dealt, revealed, initial betting checked around -> sitting at the 1st DrawRound. */
function atFirstDrawRound(names, options = {}) {
  const room = startedRoom('home-7-27', names, options);
  room.deal(2, 'p1');
  for (const p of room.players) room.revealComplete(p.id, [p.hand[0].id]);
  room.openBetting('p1');
  let guard = 0;
  while (room.bettingOpen && guard++ < 30) room.check(room.currentTurnPlayerId);
  assert.strictEqual(room.handPhase, 'DrawRound');
  return room;
}

/** One drawing round where p2 does `p2Action` and everyone else draws; then the betting round (if any) is checked around. */
function roundWithP2(room, p2Action) {
  room.openDrawingRound('p1');
  let guard = 0;
  while (room.drawRoundOpen && guard++ < 20) {
    const id = room.drawTurnPlayerId;
    if (id === 'p2' ? p2Action === 'pass' : false) room.passDraw(id);
    else room.drawCard(id);
  }
  if (room.handPhase === 'DrawBetting') {
    room.openBetting('p1');
    guard = 0;
    while (room.bettingOpen && guard++ < 30) room.check(room.currentTurnPlayerId);
  }
}

// ---- 1. Freeze After ------------------------------------------------

test('13.1 G.1: Freeze After defaults to 3 -- two passes in a row do not freeze, the third does', () => {
  const room = atFirstDrawRound(['A', 'B', 'C']);
  assert.strictEqual(room.gameOptions.freezeAfter, 3);
  roundWithP2(room, 'pass');
  roundWithP2(room, 'pass');
  assert.strictEqual(room.getPlayer('p2').frozen, false, 'two passes are not enough at the default');
  roundWithP2(room, 'pass');
  assert.strictEqual(room.getPlayer('p2').frozen, true, 'the third consecutive pass freezes');
});

test('13.1 G.1: Freeze After = Never -- five passes in a row never freeze; an all-pass round still goes to Declare', () => {
  const room = atFirstDrawRound(['A', 'B', 'C'], { freezeAfter: 'never' });
  for (let i = 0; i < 5; i++) roundWithP2(room, 'pass');
  assert.strictEqual(room.getPlayer('p2').consecutivePasses, 5);
  assert.strictEqual(room.getPlayer('p2').frozen, false);
  room.openDrawingRound('p1');
  while (room.drawRoundOpen) room.passDraw(room.drawTurnPlayerId);
  assert.strictEqual(room.handPhase, 'Declare');
});

test('13.1 G.1: Freeze After accepts only 2-5 or Never; the select\'s string "4" is stored as the number 4', () => {
  const room = tableWithPlayers('A', 'B');
  room.setGameChoice('p1', 'home-7-27');
  for (const bad of [1, 6, 'x', 0, 2.5, '']) {
    assert.strictEqual(room.setGameOption('p1', 'freezeAfter', bad).ok, false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.ok(room.setGameOption('p1', 'freezeAfter', '4').ok);
  assert.strictEqual(room.gameOptions.freezeAfter, 4);
  assert.ok(room.setGameOption('p1', 'freezeAfter', 'never').ok);
  assert.strictEqual(room.gameOptions.freezeAfter, 'never');
});

// ---- 2. gameChoiceSeq -------------------------------------------------

test('13.1 G.2: gameChoiceSeq goes up on every Select, including a re-pick of the same game', () => {
  const room = tableWithPlayers('A', 'B');
  assert.strictEqual(room.toRedactedState('p1').gameChoiceSeq, 0);
  room.setGameChoice('p1', 'home-7-27');
  assert.strictEqual(room.toRedactedState('p2').gameChoiceSeq, 1);
  room.setGameChoice('p1', 'home-7-27');
  assert.strictEqual(room.toRedactedState('p2').gameChoiceSeq, 2, 'same game again still counts');
  assert.strictEqual(room.setGameChoice('p2', 'draw-5card').ok, false);
  assert.strictEqual(room.gameChoiceSeq, 2, 'a rejected Select does not count');
});

// ---- 3. Remembered options ----------------------------------------------

test('13.1 G.3: Select restores the options last started for that game; hiddenOptions stay fresh', () => {
  const room = startedRoom('home-7-27', ['A', 'B'], { fixedBet: 5, overUnder: 'under-trumps' });
  room.terminateGameCleanly('p1');
  assert.ok(room.idle);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameChoice('p1', 'home-7-27');
  assert.strictEqual(room.gameOptions.fixedBet, 5);
  assert.strictEqual(room.gameOptions.overUnder, 'under-trumps');
  assert.strictEqual(room.gameOptions.bettingStructure, 'fixed-limit');
});

test('13.1 G.3: options edited but never started are not remembered; a never-played game gets catalog defaults', () => {
  const room = tableWithPlayers('A', 'B');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'home-7-27');
  room.setGameOption('p1', 'fixedBet', 9);
  room.setGameChoice('p1', 'draw-5card');
  room.setGameChoice('p1', 'home-7-27');
  const preset = GAME_CHOICES.find((g) => g.id === 'home-7-27');
  assert.strictEqual(room.gameOptions.fixedBet, preset.dealerOptions.fixedBet);
  room.setGameChoice('p1', 'home-15-35');
  for (const [k, v] of Object.entries(GAME_CHOICES.find((g) => g.id === 'home-15-35').dealerOptions)) {
    assert.deepStrictEqual(room.gameOptions[k], v, `${k} should be the catalog default`);
  }
});

test('13.1 G.3: remembered options survive Pass the Buck (they belong to the table)', () => {
  const room = startedRoom('draw-5card', ['A', 'B'], { anteAmount: 7 });
  room.terminateGameCleanly('p1');
  room.passTheBuck('p1');
  const dealer = room.getDealer().id;
  assert.notStrictEqual(dealer, 'p1');
  room.setGameChoice(dealer, 'home-7-27');
  room.setGameChoice(dealer, 'draw-5card');
  assert.strictEqual(room.gameOptions.anteAmount, 7);
});

// ---- 4. Restore Defaults -------------------------------------------------

test('13.1 G.4: restoreDefaultOptions -- idle Dealer only; every Dealer option back to the catalog default', () => {
  const room = tableWithPlayers('A', 'B');
  for (const p of room.players) room.buyChips(p.id, 1000);
  room.setGameChoice('p1', 'home-7-27');
  room.setGameOption('p1', 'fixedBet', 4);
  room.setGameOption('p1', 'freezeAfter', 'never');
  room.setGameOption('p1', 'foldedHands', 'muck');
  assert.strictEqual(room.restoreDefaultOptions('p2').ok, false, 'Dealer only');
  assert.ok(room.restoreDefaultOptions('p1').ok);
  const preset = GAME_CHOICES.find((g) => g.id === 'home-7-27');
  for (const [k, v] of Object.entries(preset.dealerOptions)) assert.deepStrictEqual(room.gameOptions[k], v, k);
  room.startGame('p1');
  assert.strictEqual(room.restoreDefaultOptions('p1').ok, false, 'not during a hand');
});

// ---- 5. Show All visibility ----------------------------------------------

test('13.1 G.5: Show All -- folded hands left on the table are visible to every player, still marked dealt down', () => {
  const room = atFirstDrawRound(['A', 'B', 'C']);
  // Fold p3 and p1 in the next betting round so p2 wins with folded hands left on the table.
  roundWithP2(room, 'draw');
  // roundWithP2 checked the betting round around; open the next drawing round, all pass -> Declare.
  room.openDrawingRound('p1');
  while (room.drawRoundOpen) room.passDraw(room.drawTurnPlayerId);
  room.fold('p3'); // Showdown/Declare fold path
  for (const id of ['p1', 'p2']) room.declare(id, 'a');
  room.claimPot('p2', [{ playerId: 'p2', amount: room.pot }]);
  room.resolveClaim(room.pendingClaim.approverId, true);
  assert.ok(room.showAll('p1').ok);
  const folded = room.getPlayer('p3');
  const downIds = folded.hand.filter((c) => !c.faceUp).map((c) => c.id);
  assert.ok(downIds.length > 0, 'the folded hand still has dealt-down cards');
  for (const viewer of ['p1', 'p2']) {
    const seen = room.toRedactedState(viewer).players.find((p) => p.id === 'p3').hand;
    assert.deepStrictEqual(seen.map((c) => c.id), folded.hand.map((c) => c.id), `${viewer} sees p3's whole hand`);
    for (const c of seen) if (downIds.includes(c.id)) assert.strictEqual(c.faceUp, false);
  }
});

// ---- 6. Catalog options are all accepted -----------------------------------

test('13.1 G.6: every catalog default value is accepted by the server; new-game options all have an explicit Options label', () => {
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const labelsBlock = /const OPTION_DISPLAY_LABELS = \{([\s\S]*?)\n  \};/.exec(clientSrc);
  assert.ok(labelsBlock, 'OPTION_DISPLAY_LABELS not found');
  const labelled = new Set([...labelsBlock[1].matchAll(/^\s+([A-Za-z]+):/gm)].map((m) => m[1]));
  for (const preset of GAME_CHOICES) {
    const room = tableWithPlayers('A', 'B');
    assert.ok(room.setGameChoice('p1', preset.id).ok);
    for (const [key, value] of Object.entries(preset.dealerOptions || {})) {
      // Older games' keys use optionDisplayLabel()'s camelCase fallback;
      // every option on the 13.x profiles is labelled explicitly, so a
      // leftover (e.g. 13.0's naturalsWin) shows up here.
      if ((preset.profile === 'vying' || preset.profile === 'pickcard') && key !== 'raiseCap') {
        // (raiseCap is the one shared pre-13.x key, labelled by the fallback.)
        assert.ok(labelled.has(key), `${preset.id}: "${key}" has no Options label (leftover option?)`);
      }
      const r = room.setGameOption('p1', key, value);
      assert.ok(r.ok, `${preset.id}: ${key}=${JSON.stringify(value)} rejected: ${r.error}`);
    }
  }
});

test('13.1 B.1/B.2: 7-27 and 15-35 have no Naturals option and default Over / Under to Nearest Wins', () => {
  for (const id of ['home-7-27', 'home-15-35']) {
    const g = GAME_CHOICES.find((x) => x.id === id);
    assert.ok(!('naturalsWin' in g.dealerOptions), `${id} still has naturalsWin`);
    assert.strictEqual(g.dealerOptions.overUnder, 'nearest');
    assert.strictEqual(g.dealerOptions.freezeAfter, 3);
  }
  const room = tableWithPlayers('A', 'B');
  room.setGameChoice('p1', 'home-7-27');
  assert.strictEqual(room.setGameOption('p1', 'naturalsWin', 'yes').ok, false);
});

// ---- Part A / Part 0 ---------------------------------------------------------

test('13.1 A.1/A.4: player-facing wording -- "Fixed Bet" error and one "All In" spelling', () => {
  const room = tableWithPlayers('A', 'B');
  room.setGameChoice('p1', 'home-7-27');
  assert.strictEqual(room.setGameOption('p1', 'fixedBet', 0).error, 'Fixed Bet must be a whole number of at least 1.');
  const allIn = startedRoom('draw-5card', ['A', 'B']);
  allIn.deal(5, 'p1');
  allIn.openBetting('p1');
  const actor = allIn.currentTurnPlayerId;
  assert.ok(allIn.allIn(actor).ok);
  assert.ok(allIn.streetActionLog.some((e) => /^is All In for \$\d+$/.test(e.text)));
  const broke = tableWithPlayers('A', 'B');
  assert.strictEqual(broke.allIn('p1').ok, false);
});

test('13.1 Part 0: package.json and package-lock.json both say 13.1.0', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.strictEqual(pkg.version, '13.1.0');
  assert.strictEqual(lock.version, pkg.version);
  assert.strictEqual(lock.packages[''].version, pkg.version);
});
