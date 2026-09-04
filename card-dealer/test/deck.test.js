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
// Deck
// ---------------------------------------------------------------


test('buildDeck: 52 cards, no jokers', () => {
  assert.strictEqual(buildDeck(false).length, 52);
});

test('buildDeck: 54 cards with jokers', () => {
  assert.strictEqual(buildDeck(true).length, 54);
});

test('buildDeck: all card ids unique', () => {
  const ids = buildDeck(true).map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('shuffle: same cards, different-ish order, mutates in place', () => {
  const deck = buildDeck(false);
  const before = deck.map((c) => c.id);
  const returned = shuffle(deck);
  assert.strictEqual(returned, deck);
  const after = deck.map((c) => c.id);
  assert.deepStrictEqual([...before].sort(), [...after].sort());
  assert.notDeepStrictEqual(before, after);
});
