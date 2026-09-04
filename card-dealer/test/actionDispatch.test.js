'use strict';

const assert = require('assert');
const { test } = require('./helpers');
const { installActionDispatch, ACTION_METHODS } = require('../src/actionDispatch');
const { GameTable } = require('../src/gameTable');

/**
 * NEW 8.0 (ARCHITECTURE_v8.md §3, §10 sequencing item 1): direct unit
 * tests for the action-dispatch wrapper itself, independent of
 * GameTable's actual game-rule behavior (already covered everywhere
 * else). Uses a small fake constructor/prototype rather than GameTable
 * for most of these -- isolates what this module is actually
 * responsible for (wrapping, record shape, the `onAction` hook, arity
 * preservation) from whether any particular GameTable action's business
 * logic is correct.
 */

function FakeTable() {
  this.onAction = null;
  this.log = [];
}
FakeTable.prototype.doThing = function (requesterId, amount) {
  if (amount < 0) return { ok: false, error: 'negative' };
  this.log.push(amount);
  return { ok: true };
};

test('installActionDispatch: wrapped method still calls through and performs its real mutation', () => {
  const proto = FakeTable.prototype;
  installActionDispatch(proto, { doThing: 0 }); // custom manifest -- see actionDispatch.js's manifest param doc
  const t = new FakeTable();
  const result = t.doThing('p1', 50);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(t.log, [50]); // the real mutation still happened
  assert.strictEqual(result.action.actorId, 'p1');
  assert.deepStrictEqual(result.action.args, [50]);
});

test('installActionDispatch: throws at load time if a listed method is missing from the prototype', () => {
  function Incomplete() {}
  // Deliberately does NOT define `deal` on the prototype.
  assert.throws(() => installActionDispatch(Incomplete.prototype), /does not exist/);
});

test('installActionDispatch (via the real GameTable): every action attaches a structured .action record on success', () => {
  const gt = new GameTable('ABC');
  gt.addPlayer('p1', 'Alice');
  gt.addPlayer('p2', 'Bob');
  const result = gt.buyChips('p1', 500);
  assert.strictEqual(result.ok, true);
  assert.ok(result.action, 'expected an .action record to be attached');
  assert.strictEqual(result.action.type, 'buyChips');
  assert.strictEqual(result.action.actorId, 'p1');
  assert.deepStrictEqual(result.action.args, [500]);
  assert.strictEqual(result.action.ok, true);
  assert.strictEqual(result.action.error, null);
  assert.strictEqual(typeof result.action.at, 'number');
});

test('installActionDispatch (via the real GameTable): a REJECTED action still attaches a record, with ok:false and the error message', () => {
  const gt = new GameTable('ABC');
  gt.addPlayer('p1', 'Alice');
  const result = gt.buyChips('p1', -50); // rejected: not a positive whole number
  assert.strictEqual(result.ok, false);
  assert.ok(result.action);
  assert.strictEqual(result.action.ok, false);
  assert.strictEqual(typeof result.action.error, 'string');
});

test('installActionDispatch (via the real GameTable): forwards every record to onAction when set', () => {
  const gt = new GameTable('ABC');
  gt.addPlayer('p1', 'Alice');
  const seen = [];
  gt.onAction = (record) => seen.push(record);
  gt.buyChips('p1', 100);
  gt.buyChips('p1', 200);
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].type, 'buyChips');
  assert.deepStrictEqual(seen[0].args, [100]);
  assert.deepStrictEqual(seen[1].args, [200]);
});

test('installActionDispatch (via the real GameTable): does nothing extra, doesn\'t throw, when onAction is unset', () => {
  const gt = new GameTable('ABC');
  gt.addPlayer('p1', 'Alice');
  assert.strictEqual(gt.onAction, undefined); // never set on a fresh GameTable
  const result = gt.buyChips('p1', 100); // should not throw despite no listener
  assert.strictEqual(result.ok, true);
});

test('installActionDispatch: deal() is the one method whose actor is argument index 1, not 0 -- confirmed against the real manifest', () => {
  assert.strictEqual(ACTION_METHODS.deal, 1);
  // Every other manifest entry puts the actor first.
  const others = Object.entries(ACTION_METHODS).filter(([name]) => name !== 'deal');
  assert.ok(others.length > 0);
  assert.ok(others.every(([, actorIndex]) => actorIndex === 0));
});

test('installActionDispatch: preserves the wrapped method\'s original declared arity (.length), not the wrapper\'s own', () => {
  const gt = new GameTable('ABC');
  // Cross-checked against the two dedicated arity-shape tests already
  // in gameTable-core.test.js (passTheBuck.length, dealToAllPlayers.length) --
  // this test exists at the module level instead, checking the general
  // mechanism rather than those two specific methods.
  assert.strictEqual(gt.passTheBuck.length, 1);
  assert.strictEqual(gt.dealToAllPlayers.length, 1);
  assert.strictEqual(gt.placeBet.length, 2); // requesterId, amount
  assert.strictEqual(gt.deal.length, 3); // cardsPerPlayer, requesterId, faceUpOverride
});

test('installActionDispatch: addPlayer/removePlayer are deliberately NOT wrapped -- no .action record attached', () => {
  const gt = new GameTable('ABC');
  const player = gt.addPlayer('p1', 'Alice'); // returns the player object directly, not {ok, error}
  assert.strictEqual(player.id, 'p1');
  assert.strictEqual(player.action, undefined); // no dispatch record -- see actionDispatch.js's own header comment for why
});
