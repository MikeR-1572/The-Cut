'use strict';

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

/**
 * Build a standard 52-card deck, optionally with 2 jokers.
 * Order returned is unshuffled (suit-major); callers should shuffle().
 */
function buildDeck(includeJokers) {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${suit}-${rank}`, faceUp: false });
    }
  }
  if (includeJokers) {
    deck.push({ suit: 'joker', rank: null, id: 'joker-1', faceUp: false });
    deck.push({ suit: 'joker', rank: null, id: 'joker-2', faceUp: false });
  }
  return deck;
}

/**
 * Fisher-Yates shuffle. Mutates and returns the given array.
 */
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

module.exports = { buildDeck, shuffle, SUITS, RANKS };
