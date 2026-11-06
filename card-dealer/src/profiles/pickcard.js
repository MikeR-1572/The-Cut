'use strict';

/**
 * NEW 13.0 (the-cut-spec_v13-0.md Part C): Pick-a-Card's profile table.
 *
 * No deal and no betting at all. After antes, `PickDraw` hands a
 * Pick-a-Card Drawing Rail to each participant in turn (clockwise from
 * the position anchor's left); each picks a card position in the deck.
 * Once the last participant has drawn, the hand moves to `Showdown`
 * (or straight to `CycleComplete` when the pot is $0). All of that is
 * driven by gameTable.js (`_beginPickDraw()` / `pickCard()`), not by a
 * betting-round transition -- so `bettingRoundClosedTransitions` is
 * deliberately empty: no betting round can ever open in this profile.
 */
module.exports = {
  id: 'pickcard',
  firstPhaseAfterAntes: 'PickDraw',
  bettingRoundClosedTransitions: {},
  capabilities: {
    phaseGated: true,
    usesReAnteableLoop: false,
    usesManualOpeningBettor: false,
    usesBringIn: false,
  },
};
