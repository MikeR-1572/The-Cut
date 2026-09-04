'use strict';

const assert = require('assert');
const { test } = require('./helpers');
const { createPlayer, buyChips, snapshot, restore } = require('../src/player');

/**
 * NEW 8.0 (ARCHITECTURE_v8.md §4, §10 sequencing item 1): direct unit
 * tests for the Player/Bank module, tested in isolation from GameTable
 * for the first time -- previously (and still, for the identity-shape
 * and integration-level behavior) exercised only indirectly via
 * `tableWithPlayers`/`buyChips` tests in gameTable-core.test.js. Those
 * integration-level tests stay where they are; this file covers the
 * module's own public functions directly, including snapshot()/
 * restore(), which nothing in gameTable-core.test.js exercises at all
 * since no feature calls them yet.
 */

test('createPlayer: returns the full expected shape, isDealer only true for the first player', () => {
  const p1 = createPlayer('p1', 'Alice', true);
  const p2 = createPlayer('p2', 'Bob', false);
  assert.strictEqual(p1.id, 'p1');
  assert.strictEqual(p1.name, 'Alice');
  assert.strictEqual(p1.isDealer, true);
  assert.strictEqual(p2.isDealer, false);
  assert.strictEqual(p1.chips, 0);
  assert.strictEqual(p1.totalBuyIn, 0);
  assert.deepStrictEqual(p1.hand, []);
  assert.strictEqual(p1.folded, false);
  assert.strictEqual(p1.sittingOut, false);
  assert.strictEqual(p1.oweAnte, 0);
});

test('createPlayer: each call returns a fresh, independent object -- no shared references between players', () => {
  const p1 = createPlayer('p1', 'Alice', true);
  const p2 = createPlayer('p2', 'Bob', false);
  p1.hand.push({ id: 'card1' });
  assert.deepStrictEqual(p2.hand, []); // p2's hand array is NOT the same array as p1's
});

test('buyChips: adds to both chips and totalBuyIn identically', () => {
  const p = createPlayer('p1', 'Alice', true);
  buyChips(p, 500);
  assert.strictEqual(p.chips, 500);
  assert.strictEqual(p.totalBuyIn, 500);
  buyChips(p, 200);
  assert.strictEqual(p.chips, 700);
  assert.strictEqual(p.totalBuyIn, 700);
});

test('buyChips: totalBuyIn keeps accumulating even after chips are later spent, unlike chips itself', () => {
  const p = createPlayer('p1', 'Alice', true);
  buyChips(p, 500);
  p.chips -= 300; // simulates a hand being lost -- buyChips() itself is never called for this
  buyChips(p, 100); // a second buy-in
  assert.strictEqual(p.chips, 300); // 500 - 300 + 100
  assert.strictEqual(p.totalBuyIn, 600); // 500 + 100, unaffected by the loss in between
});

test('snapshot: captures chips/totalBuyIn only, keyed by player id, for every player passed in', () => {
  const p1 = createPlayer('p1', 'Alice', true);
  const p2 = createPlayer('p2', 'Bob', false);
  buyChips(p1, 500);
  buyChips(p2, 300);
  const snap = snapshot([p1, p2]);
  assert.deepStrictEqual(snap, {
    p1: { chips: 500, totalBuyIn: 500 },
    p2: { chips: 300, totalBuyIn: 300 },
  });
});

test('snapshot: does not capture hand-specific fields (folded, currentBet, hand, etc.) -- bank state only', () => {
  const p1 = createPlayer('p1', 'Alice', true);
  buyChips(p1, 500);
  p1.folded = true;
  p1.currentBet = 50;
  p1.hand.push({ id: 'card1' });
  const snap = snapshot([p1]);
  assert.deepStrictEqual(Object.keys(snap.p1).sort(), ['chips', 'totalBuyIn']);
});

test('restore: restores chips/totalBuyIn from a prior snapshot, by id', () => {
  const p1 = createPlayer('p1', 'Alice', true);
  buyChips(p1, 500);
  const snap = snapshot([p1]);
  p1.chips = 0; // simulate losing everything after the snapshot was taken
  buyChips(p1, 200); // and buying back in again
  assert.strictEqual(p1.chips, 200);
  assert.strictEqual(p1.totalBuyIn, 700);
  restore([p1], snap);
  assert.strictEqual(p1.chips, 500);
  assert.strictEqual(p1.totalBuyIn, 500);
});

test('restore: a player missing from the snapshot (joined afterward) is left completely untouched, not zeroed', () => {
  const p1 = createPlayer('p1', 'Alice', true);
  buyChips(p1, 500);
  const snap = snapshot([p1]);
  const p2 = createPlayer('p2', 'Bob', false); // joins AFTER the snapshot was taken
  buyChips(p2, 300);
  restore([p1, p2], snap);
  assert.strictEqual(p1.chips, 500); // restored
  assert.strictEqual(p2.chips, 300); // untouched -- never punished for not being part of the snapshot
});

test('restore: matches players by id, not array order or index, so a reordered/reshuffled players array still restores correctly', () => {
  const p1 = createPlayer('p1', 'Alice', true);
  const p2 = createPlayer('p2', 'Bob', false);
  buyChips(p1, 500);
  buyChips(p2, 300);
  const snap = snapshot([p1, p2]);
  p1.chips = 999;
  p2.chips = 999;
  restore([p2, p1], snap); // deliberately reversed order from how the snapshot was taken
  assert.strictEqual(p1.chips, 500);
  assert.strictEqual(p2.chips, 300);
});
