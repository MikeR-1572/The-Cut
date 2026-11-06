'use strict';

/**
 * NEW 13.0 (the-cut-spec_v13-0.md Part D): the profile shared by 7-27
 * and 15-35 (and, from 13.1, reusable pieces for No Peeky).
 *
 * Phase graph:
 *   RequestAntes -> OpeningDeal -> [InitialReveal] -> InitialBetting
 *   -> DrawRound -> (DrawBetting -> DrawRound)* -> Declare -> Showdown
 *
 * Both betting rounds close into the same decision, owned by
 * gameTable._vyingPhaseAfterBetting(): the next DrawRound if anyone is
 * still eligible to draw, otherwise Declare (or Showdown, if only one
 * participant is left). DrawRound's own exit (DrawBetting if anyone
 * drew, Declare if nobody did) is decided in gameTable._endDrawRound(),
 * since a drawing round isn't a betting round.
 */
module.exports = {
  id: 'vying',
  firstPhaseAfterAntes: 'OpeningDeal',
  bettingRoundClosedTransitions: {
    InitialBetting: (gameTable) => gameTable._vyingPhaseAfterBetting(),
    DrawBetting: (gameTable) => gameTable._vyingPhaseAfterBetting(),
  },
  capabilities: {
    phaseGated: true,
    usesReAnteableLoop: false,
    usesManualOpeningBettor: false,
    usesBringIn: false,
  },
};
