'use strict';

/**
 * NEW 8.0 (ARCHITECTURE_v8.md §2): Draw's declarative profile table.
 * Draw, Hold'em, and Stud's phase graphs and cross-cutting capability
 * flags now live as data here (and in holdem.js/stud.js), consumed
 * generically by GameTable, rather than each being its own scattered
 * `profile === 'draw'` branch repeated across a dozen call sites.
 *
 * `bettingRoundClosedTransitions`: keyed by the exact `handPhase` value
 * a betting round just closed FROM. Each value is either a literal next
 * phase name, or a function `(gameTable) => nextPhase | null` for a
 * transition whose target depends on table state at the moment (Draw's
 * `requiresOpeners`-driven "nobody opened" stuck case, here). Returning
 * `null` means "don't advance" -- New Hand becomes the available action
 * instead, checked independently by `newHand()`'s own gate.
 */
module.exports = {
  id: 'draw',
  firstPhaseAfterAntes: 'OpeningDeal',
  bettingRoundClosedTransitions: {
    // FirstBetting has one exception: if `reAnteable` and nobody ever
    // opened (currentBetToCall stayed 0 the whole round), the phase
    // deliberately does NOT advance to DiscardPhase -- real
    // Jacks-or-Better rules kill the hand immediately here, no draw
    // phase at all. SecondBetting always advances to Showdown, no exception.
    FirstBetting: (gameTable) => (gameTable.reAnteable && gameTable.currentBetToCall === 0 ? null : 'DiscardPhase'),
    SecondBetting: () => 'Showdown',
  },
  capabilities: {
    // Drives the pending-claim lock, the early-claim shortcut, Fold at
    // Showdown, the betting-action click guard, and idle-derivation --
    // every one of these previously needed its own
    // `profile === 'draw' || 'holdem' || 'stud'` check, independently
    // extended (and independently at risk of being forgotten) at every
    // new-profile boundary. A new profile that sets this true picks up
    // all of them automatically.
    phaseGated: true,
    // Gates New Hand's availability (§5.8) -- Draw and Stud only, not Hold'em.
    usesReAnteableLoop: true,
    // Stud-only mechanisms -- see stud.js for the true values.
    usesManualOpeningBettor: false,
    usesBringIn: false,
  },
};
