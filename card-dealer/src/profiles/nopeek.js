'use strict';

/**
 * NEW 13.2 (the-cut-spec_v13-2.md Part B): 7-Card No Peek.
 *
 * Phase graph:
 *   RequestAntes -> OpeningDeal -> Reveal -> RevealBetting
 *   -> (Reveal -> RevealBetting)* -> Showdown
 *
 * A reveal ends by player action (gameTable._endReveal()), never by a
 * betting-round transition. A closed RevealBetting round goes to
 * gameTable._nopeekPhaseAfterBetting(): the next Reveal, or Showdown
 * when only one participant is left or nobody has a face-down card left.
 *
 * usesManualOpeningBettor is false: the opener is pre-selected
 * automatically when a reveal ends; the Dealer's override goes through
 * setOpeningBettor(), allowed for nopeek during RevealBetting (B.6).
 */
module.exports = {
  id: 'nopeek',
  firstPhaseAfterAntes: 'OpeningDeal',
  bettingRoundClosedTransitions: {
    RevealBetting: (gameTable) => gameTable._nopeekPhaseAfterBetting(),
  },
  capabilities: {
    phaseGated: true,
    usesReAnteableLoop: false,
    usesManualOpeningBettor: false,
    usesBringIn: false,
  },
};
