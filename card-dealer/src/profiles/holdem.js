'use strict';

/**
 * NEW 8.0 (ARCHITECTURE_v8.md §2): Hold'em's declarative profile table.
 * See draw.js's header comment for the general shape/reasoning shared
 * across all three profile tables.
 *
 * Hold'em's `bettingRoundClosedTransitions` is a plain, unconditional
 * lookup -- no per-transition function needed, unlike Draw's or Stud's --
 * since blinds guarantee live money every hand: there's no "nobody
 * opened" case to special-case the way Draw's `requiresOpeners` presets
 * need, for any of Hold'em's four streets.
 */
module.exports = {
  id: 'holdem',
  firstPhaseAfterAntes: 'PreFlop',
  bettingRoundClosedTransitions: {
    PreFlopBetting: 'Flop',
    FlopBetting: 'Turn',
    TurnBetting: 'River',
    RiverBetting: 'Showdown',
  },
  capabilities: {
    phaseGated: true,
    // Hold'em has no New-Hand-within-Cycle loop at all -- confirmed by
    // Mike: no "nobody opened" case (blinds guarantee live money) and no
    // "nobody claims at Showdown" case either, so RequestAntes always
    // clears fold status unconditionally on entry here, unlike Draw's
    // conditional version.
    usesReAnteableLoop: false,
    usesManualOpeningBettor: false,
    usesBringIn: false,
  },
};
