'use strict';

// Excludes visually ambiguous characters (0/O, 1/I/L) so codes are easy
// to read aloud / type on a phone (Open Decision #5).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/**
 * Single in-memory GameTable registry for the whole process. No
 * persistence. RENAMED 8.0 (ARCHITECTURE_v8.md §9): `rooms` -> `gameTables`,
 * `generateRoomCode` -> `generateGameTableCode` -- internal/JS-variable
 * naming only; the human-facing concept ("Table Code") is unchanged.
 */
const gameTables = new Map();

function generateGameTableCode() {
  let code;
  do {
    code = Array.from(
      { length: CODE_LENGTH },
      () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join('');
  } while (gameTables.has(code)); // regenerate on collision
  return code;
}

module.exports = { gameTables, generateGameTableCode };
