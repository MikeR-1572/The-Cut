(() => {
  'use strict';

  /**
   * NEW 8.0 (ARCHITECTURE_v8.md §2): the client-side half of the
   * declarative per-profile tables -- the server owns phase transitions
   * and capability flags (src/profiles/*.js); this owns what the
   * Dealer's Rail actually shows for each phase. Loaded before
   * client.js (see index.html), which consumes it via the single
   * generic `renderPhaseGatedRail()` function.
   *
   * No shared module system exists between the Node server and the
   * browser client (vanilla JS, no bundler, no build step -- deliberate
   * tech-stack choice) -- so this is a parallel, hand-authored table,
   * not a literal shared file with src/profiles/*.js. Kept in sync by
   * convention (matching phase names, matching conditions) the same way
   * `game-choices.json`'s Stud presets and the client's Select dialog
   * groupings already stay in sync without a shared module.
   *
   * Each profile exports a single `phaseView(gameTable)` function returning
   * a small, normalized description of what's relevant for the CURRENT
   * handPhase only -- undefined/absent keys mean "not applicable this
   * phase," which `renderPhaseGatedRail()` in client.js treats as
   * "hidden." This directly targets the exact bug class that recurred
   * three times (6.2, 7.1, 7.2): every phase's content is now decided
   * in exactly one place per profile, read generically, rather than
   * each rail-render function individually remembering which controls
   * apply to which phase.
   *
   * Deliberately NOT covered here (computed generically in client.js
   * instead, since the rule is byte-identical across all three
   * profiles, not genuinely profile-specific data):
   *   - rabbitHuntGroup visibility (always `gameTable.rabbitHuntAvailable`)
   *   - Pass the Buck visibility/text (always PreGame/CycleComplete)
   *   - Set Ante/Blind visibility (always `anteType === 'manual' && RequestAntes`)
   *   - Advance Turn / Burn / Reshuffle (always hidden for every
   *     phase-gated profile -- Shuffle suppressed since 5.0, §4.1/§6.2;
   *     burn-before-street unresolved, §14)
   */

  const RAIL_TABLES = {
    /**
     * Draw (§5.8). `deal` covers the Opening Deal; `drawGroup` reuses
     * the same DOM elements as Stud's old flexible "Deal to Specific
     * Player" control, relabeled "Draw" -- single button, no target
     * picker, since DrawPhase only ever begins once every active player
     * has already Discarded/Stood Pat (§5.2, 5.1).
     */
    draw: {
      phaseView(gameTable) {
        const phase = gameTable.handPhase;
        if (phase === 'RequestAntes') {
          return {
            deal: {
              visible: true,
              active: false,
              count: gameTable.gameOptions?.cardsPerPlayer,
              title: 'Waiting for every active player to pay their ante',
            },
          };
        }
        if (phase === 'OpeningDeal') {
          return {
            deal: {
              visible: true,
              active: true,
              count: gameTable.gameOptions?.cardsPerPlayer,
              title: 'Deal cards to every active player',
            },
          };
        }
        if (phase === 'FirstBetting') {
          // Mirrors GameTable.newHand()'s own Trigger A exactly (src/gameTable.js) --
          // keep in sync if either changes. "Nobody could open": requiresOpeners,
          // a round actually happened and closed (bettingRoundsThisHand >= 1) with
          // currentBetToCall still 0.
          const stuck =
            gameTable.requiresOpeners && gameTable.bettingRoundsThisHand >= 1 && !gameTable.bettingOpen && gameTable.currentBetToCall === 0;
          return {
            newHand: stuck,
            openBetting: stuck ? undefined : { visible: !gameTable.bettingOpen },
          };
        }
        if (phase === 'DiscardPhase') return { drawGroup: { visible: true, active: false } };
        if (phase === 'DrawPhase') return { drawGroup: { visible: true, active: true } };
        if (phase === 'SecondBetting') return { openBetting: { visible: !gameTable.bettingOpen } };
        if (phase === 'Showdown') return { newHand: gameTable.reAnteable };
        return {}; // PreGame, CycleComplete
      },
    },

    /**
     * Hold'em (§5.9). `deal` covers hole cards; `dealCommunity` covers
     * Flop/Turn/River, relabeled per street (always phase-fixed counts
     * 3/1/1, no manual override). No New-Hand-within-Cycle loop exists
     * for this profile at all -- `newHand` is simply never returned.
     */
    holdem: {
      phaseView(gameTable) {
        const phase = gameTable.handPhase;
        if (phase === 'RequestAntes') {
          return {
            deal: {
              visible: true,
              active: false,
              count: gameTable.gameOptions?.cardsPerPlayer,
              title: 'Waiting for both blinds to be posted',
            },
          };
        }
        if (phase === 'PreFlop') {
          return {
            deal: {
              visible: true,
              active: true,
              count: gameTable.gameOptions?.cardsPerPlayer,
              title: 'Deal hole cards to every active player',
            },
          };
        }
        const streetLabels = { Flop: 'The Flop', Turn: 'The Turn', River: 'The River' };
        if (streetLabels[phase]) {
          return { dealCommunity: { visible: true, label: streetLabels[phase] } };
        }
        const bettingPhases = ['PreFlopBetting', 'FlopBetting', 'TurnBetting', 'RiverBetting'];
        if (bettingPhases.includes(phase)) return { openBetting: { visible: !gameTable.bettingOpen } };
        return {};
      },
    },

    /**
     * Stud (§5.10, §6.8). `deal`'s count is dynamic -- 2 or 3 (from
     * `finalStreet`) on the initial StreetA multi-card deal, 1 on every
     * street after that, computed the SAME way for `RequestAntes` (not
     * yet active) as for the real StreetA deal itself -- this shared
     * computation, reached unconditionally rather than nested inside an
     * "is a street currently active" check, is the direct fix for the
     * v7.2/8.0 regression where RequestAntes kept showing the retired
     * editable input with a stale count (master spec §10.6). Also
     * covers Select Opening Bettor (`openingBettor`), re-derived fresh
     * every render from `gameTable.handPhase`/`gameTable.bettingOpen`/
     * `gameTable.openingBettorId` -- never a separate stored client flag to
     * forget to reset.
     */
    stud: {
      phaseView(gameTable) {
        const phase = gameTable.handPhase;
        const isSevenCard = gameTable.finalStreet === 'E';

        // NEW 8.1 (§6.9): computed once, independent of which specific
        // phase branch below applies, then merged into every branch's
        // return value (including the catch-all at the end, so Kill
        // Hand stays visible even while a betting round is actively
        // open within its window -- the window is phase-based, not
        // bettingOpen-based). Mirrors gameTable.js#newHand's own gate
        // exactly. Mid-hand: hasKillCard presets get the restyled,
        // confirmation-gated button (REPLACING the ordinary version
        // entirely) anywhere in the Kill Hand window.
        // CHANGED 8.3, Mike's preference: Kill Hand is NEVER shown at
        // Showdown anymore, regardless of hasKillCard -- a "nobody
        // qualifies" situation there is always the plain, undecorated
        // New Hand button (via reAnteable alone), even for Black Mariah,
        // which happens to be both reAnteable and hasKillCard.
        // BUG FIX 8.4 (§6.9): now reads `gameTable.killHandWindowOpen`
        // directly instead of re-deriving the window client-side -- the
        // prior hand-maintained copy of this window logic never received
        // the 8.2/8.3 corrections (the "close of betting, not just
        // opens" fix, and the pattern-array-scanning fix), causing a
        // real regression Mike found in testing: the button vanished the
        // instant StreetDBetting opened for Black Mariah, even though
        // the server-side computation was already correct by then.
        // There is now exactly one implementation of this window
        // (stud.js's `isWithinKillHandWindow`, consulted server-side and
        // exposed here) -- nothing left to keep "in sync by hand."
        let newHandView;
        if (gameTable.hasKillCard && phase !== 'Showdown' && gameTable.killHandWindowOpen) {
          newHandView = { visible: true, style: 'kill', killCard: gameTable.killCard };
        } else if (gameTable.reAnteable && phase === 'Showdown') {
          newHandView = { visible: true, style: 'normal' };
        }

        if (phase === 'RequestAntes') {
          return {
            deal: {
              visible: true,
              active: false,
              count: isSevenCard ? 3 : 2,
              title: 'Waiting for every active player to pay their ante',
            },
          };
        }
        const dealMatch = /^Street([A-E])$/.exec(phase);
        if (dealMatch) {
          const count = dealMatch[1] === 'A' ? (isSevenCard ? 3 : 2) : 1;
          return {
            deal: { visible: true, active: true, count, title: 'Deal this street\u2019s card(s) to every active player' },
            newHand: newHandView,
          };
        }
        if (phase === 'Showdown') return { newHand: newHandView };
        const studBettingPhases = ['StreetABetting', 'StreetBBetting', 'StreetCBetting', 'StreetDBetting', 'StreetEBetting'];
        if (studBettingPhases.includes(phase) && !gameTable.bettingOpen) {
          // CHANGED 8.1 (§6.8): the hint text now reads off the active
          // preset's `bettingStartsWith` ("Low/High", "Low/Low",
          // "High/Low", "High/High") instead of the 7.2 hardcoded
          // Low-then-High assumption, which was silently wrong for Razz
          // (High/Low -- the Bring-In goes to the HIGHEST card, every
          // later street opens with the LOWEST). First half of the value
          // applies on StreetABetting (the Bring-In street); second half
          // applies to every street after.
          const [firstHalf, laterHalf] = (gameTable.gameOptions?.bettingStartsWith || 'Low/High').split('/');
          const hint = `${phase === 'StreetABetting' ? firstHalf : laterHalf} Hand Opens Betting`;
          // CHANGED 10.4 (the-cut-spec_v10-4.md Part E, Standing
          // Convention): previously `enabled: !!gameTable.openingBettorId`
          // alone -- indistinguishable, from the Dealer's own point of
          // view, between "you haven't picked an opener yet" (correctly
          // disabled) and "nobody at the table CAN act, the requirement
          // is bypassed server-side" (was ALSO stuck disabled, with an
          // empty dropdown and no explanation -- the live-confirmed
          // lockup). Reads `gameTable.anyHandParticipantCanAct`
          // (server-computed, the same question openBetting() itself
          // now checks) to tell the two cases apart.
          const nobodyCanAct = !gameTable.anyHandParticipantCanAct;
          return {
            openingBettor: { visible: true, hint },
            openBetting: {
              visible: true,
              enabled: nobodyCanAct || !!gameTable.openingBettorId,
              title: nobodyCanAct
                ? 'No one can act -- betting will be skipped for this street'
                : gameTable.openingBettorId
                  ? 'Open a new betting round'
                  : 'Select an opening bettor first',
            },
            newHand: newHandView,
          };
        }
        return { newHand: newHandView }; // covers mid-round (bettingOpen === true) phases within the Kill Hand window too
      },
    },
  };

  window.RAIL_TABLES = RAIL_TABLES;
})();
