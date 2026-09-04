'use strict';

/**
 * NEW 8.0 (ARCHITECTURE_v8.md §2): Stud's declarative profile table. See
 * draw.js's header comment for the general shape/reasoning shared
 * across all three profile tables.
 *
 * Stud's `bettingRoundClosedTransitions` is generated programmatically
 * below rather than hand-written per street, since all five StreetX
 * Betting phases share the exact same letter-increment logic -- the one
 * genuine piece of per-transition conditional behavior is `finalStreet`
 * (preset-level, 'D' for 5-Card or 'E' for 7-Card): whichever street's
 * letter matches it closes the hand's LAST betting round instead of
 * advancing to another street.
 *
 * CHANGED 8.1 (§5.11): that final-street closure now branches a second
 * time -- to `Declare` for `declareHighLowBoth` presets (High/Low
 * Chicago, Baseball Hi/Lo), or straight to `Showdown` for every other
 * preset, exactly as it always has. Written generically (checked
 * against whichever letter equals `finalStreet`, not hardcoded to
 * `StreetE` specifically) so a hypothetical future 5-Card
 * `declareHighLowBoth` preset would pick this up automatically too,
 * even though no current 5-Card preset sets that flag.
 */
const STREET_LETTERS = ['A', 'B', 'C', 'D', 'E'];

const bettingRoundClosedTransitions = {};
for (let i = 0; i < STREET_LETTERS.length; i++) {
  const letter = STREET_LETTERS[i];
  bettingRoundClosedTransitions[`Street${letter}Betting`] = (gameTable) => {
    if (letter === gameTable.finalStreet) {
      return gameTable.gameOptions?.declareHighLowBoth ? 'Declare' : 'Showdown';
    }
    const nextLetter = STREET_LETTERS[STREET_LETTERS.indexOf(letter) + 1];
    return `Street${nextLetter}`;
  };
}

module.exports = {
  id: 'stud',
  firstPhaseAfterAntes: 'StreetA',
  bettingRoundClosedTransitions,
  STREET_LETTERS, // exposed for reference; isWithinKillHandWindow below is the actual Kill Hand consumer
  /**
   * NEW 8.1, CORRECTED 8.2 (§6.9): Kill Hand's mid-hand availability
   * window -- `StreetABetting` through the CLOSE OF BETTING on the last
   * street whose card is dealt face up per the active preset's
   * `pattern` (§3), inclusive of that street's own Betting phase.
   *
   * The 8.1 spec (and this function's own 8.1 implementation) had this
   * wrong two ways, both fixed here:
   *   1. It cut the window off once the last face-up street's Betting
   *      phase OPENED, not once it CLOSED -- backwards from the whole
   *      point of the window, which is to let the Dealer catch the kill
   *      card during that street's own betting round, exactly when
   *      everyone's attention is on the board.
   *   2. It derived the cutoff from "the penultimate street" (`finalStreet`
   *      minus one), which only coincidentally matches "the last face-up
   *      street" for every CURRENT preset's pattern (7-Card Stud's last
   *      card happens to be dealt down). A hypothetical 5-Card
   *      `hasKillCard` preset's pattern (`down, up, up, up, up`) has its
   *      LAST card face-up, not its penultimate one -- "penultimate"
   *      would have silently cut the window one street too short for
   *      that case. Deriving the cutoff from `pattern` itself, scanning
   *      for the last `'up'` entry, is correct regardless of preset shape.
   *
   * Only ever consulted for `hasKillCard` presets (gameTable.js checks
   * that flag before calling this at all, and also allows Showdown
   * independently of this window -- see gameTable.js#newHand).
   */
  isWithinKillHandWindow(gameTable) {
    const pattern = gameTable.gameOptions?.pattern;
    if (!Array.isArray(pattern)) return false;
    let lastUpIndex = -1;
    for (let i = pattern.length - 1; i >= 0; i--) {
      if (pattern[i] === 'up') {
        lastUpIndex = i;
        break;
      }
    }
    if (lastUpIndex < 0) return false; // defensive -- no face-up card at all would mean no window makes sense
    const initialCount = gameTable.finalStreet === 'E' ? 3 : 2;
    const lettersAfterA = ['B', 'C', 'D', 'E'];
    const lastUpLetter = lastUpIndex < initialCount ? 'A' : lettersAfterA[lastUpIndex - initialCount];
    const lastUpIdx = STREET_LETTERS.indexOf(lastUpLetter);
    const phases = ['StreetABetting'];
    for (let i = 1; i <= lastUpIdx; i++) {
      phases.push(`Street${STREET_LETTERS[i]}`, `Street${STREET_LETTERS[i]}Betting`);
    }
    return phases.includes(gameTable.handPhase);
  },
  capabilities: {
    phaseGated: true,
    // reAnteable Stud variants (e.g. Black Mariah) reuse Draw's exact
    // New-Hand-within-Cycle mechanism, unchanged -- but only the
    // Showdown/"nobody claims" trigger applies for Stud, never a
    // "nobody opened" trigger, since the Dealer-selected opening bettor
    // (usesManualOpeningBettor, below) always faces a live Bring-In on
    // the first street. That distinction is handled in newHand()'s own
    // gate, not this flag -- this flag only says the loop exists at all.
    usesReAnteableLoop: true,
    // Genuinely new mechanisms, Stud-only: who opens each betting round
    // depends on up-card strength, a card-value judgment the server
    // never evaluates, so the Dealer selects manually every street
    // (§6.8); the first betting round seeds a Bring-In obligation
    // instead of computing blinds.
    usesManualOpeningBettor: true,
    usesBringIn: true,
  },
};
