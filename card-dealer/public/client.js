(() => {
  'use strict';

  const SUIT_GLYPH = { hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663', spades: '\u2660', joker: '\u2605' };
  const RED_SUITS = new Set(['hearts', 'diamonds']);

  // NEW 8.1 (§6.9): parses a short preset-authored card code (e.g. "Qs")
  // into a human-readable name ("Queen of Spades") for Kill Hand's
  // confirmation dialog -- per Mike's explicit call, the dialog should
  // read naturally rather than surface the raw preset string. Suit is
  // always the last character; rank is everything before it.
  const KILL_CARD_RANK_NAMES = {
    2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten',
    J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace',
  };
  const KILL_CARD_SUIT_NAMES = { s: 'Spades', h: 'Hearts', d: 'Diamonds', c: 'Clubs' };
  function formatKillCardName(code) {
    if (!code || typeof code !== 'string') return code || '';
    const suitChar = code.slice(-1).toLowerCase();
    const rankChar = code.slice(0, -1).toUpperCase();
    const rankName = KILL_CARD_RANK_NAMES[rankChar] || rankChar;
    const suitName = KILL_CARD_SUIT_NAMES[suitChar] || suitChar;
    return `${rankName} of ${suitName}`;
  }

  const state = {
    ws: null,
    playerId: null,
    gameTableCode: null,
    lastGameTable: null, // last gameTableState.gameTable payload received (used for chip-sound diffing too)
    discardSelection: new Set(), // card ids currently selected for Discard
    gameChoices: [], // fetched once from /game-choices.json (v4.0)
    gameOptionsEditorFor: null, // gameChoiceId the Options dialog fields were last built for -- rebuild only when it changes
    appInfo: null, // fetched once from /app-info.json (v4.1, About button)
    pendingAutoOpenOptions: false, // v4.1: Select auto-opens Options once the new gameChoiceId lands
    wasShowingTurnActions: false, // NEW 5.1 (bug fix) -- edge-triggered Bet/Raise box clearing; see renderBettingRail
    myReconnectCode: null, // NEW 11.0 (Part D) -- this Player's own code, shown so they don't have to ask the Host for it
    isReconnect: false, // NEW 11.2 (Fix 6) -- set from the 'joined' message's own field

    // NEW 11.3 (Part A/B): reconnect resilience + landing-page socket robustness.
    messageQueue: [], // Part B.2 -- queued sends while state.ws isn't open
    connectingAttempt: null, // Part B.2 -- the in-flight "opening a fresh main socket" WebSocket, if any
    pendingLobbyButton: null, // Part B.2 -- which lobby button (if any) is showing "Connecting…"
    reconnectFlowActive: false, // Part A -- true from disconnect detection until success or a deliberate leave
    // NEW 11.4 (Part A): the client's own active heartbeat.
    clientHeartbeatTimer: null,
    clientHeartbeatAckTimeout: null,
    reconnectAttemptInFlight: false, // Part A.4 -- the shared "one attempt in flight" flag
    reconnectGraceDeadline: null, // Part A.5 -- Date.now() + the Grace Period, captured once at disconnect
    reconnectExpired: false, // Part A.5 -- flips once, switches the popup from countdown to "Rejoin" mode
    reconnectWillFold: false, // Part A.5 -- computed once at disconnect from the last known betting state
    reconnectTimer: null, // Part A.4 -- the automatic-retry interval handle
    reconnectCountdownTicker: null, // Part A.5 -- the popup's own 1s re-render interval
    deliberatelyLeaving: false, // Part A -- set on leftTable/tableEnded so the resulting close doesn't ALSO start the reconnect flow
  };

  // ---- DOM refs ----
  const el = {
    viewLobby: document.getElementById('view-lobby'),
    viewGameTableTop: document.getElementById('view-gametabletop'),
    lobbyError: document.getElementById('lobby-error'),

    createName: document.getElementById('create-name'),
    createTableName: document.getElementById('create-table-name'),
    createSuggestedBuyin: document.getElementById('create-suggested-buyin'),
    btnCreateGameTable: document.getElementById('btn-create-game-table'),

    joinCode: document.getElementById('join-code'),
    joinName: document.getElementById('join-name'),
    btnJoinGameTable: document.getElementById('btn-join-game-table'),

    // NEW 11.0 (Part D)
    rejoinCode: document.getElementById('rejoin-code'),
    rejoinTableCode: document.getElementById('rejoin-table-code'),
    btnRejoinGameTable: document.getElementById('btn-rejoin-game-table'),

    tableNameDisplay: document.getElementById('table-name-display'),
    gameTableCodeDisplay: document.getElementById('game-table-code-display'),
    deckCount: document.getElementById('deck-count'),
    gameTableTopSurface: document.getElementById('gametabletop-surface'),
    seats: document.getElementById('seats'),
    communityCards: document.getElementById('community-cards'),
    burnPile: document.getElementById('burn-pile'),
    rabbitHuntCardsEl: document.getElementById('rabbit-hunt-cards'),
    tableError: document.getElementById('table-error'),
    tableAnnouncement: document.getElementById('table-announcement'), // NEW 8.1 (§5.10 extension)
    tableNotice: document.getElementById('table-notice'), // NEW 8.2 (§5.10 extension, §6.9)
    phaseBanner: document.getElementById('phase-banner'),

    gameRailDescription: document.getElementById('game-rail-description'),
    btnSameGame: document.getElementById('btn-same-game'),
    btnOpenSelectDialog: document.getElementById('btn-open-select-dialog'),
    btnOpenOptionsDialog: document.getElementById('btn-open-options-dialog'),
    btnOpenRulesDialog: document.getElementById('btn-open-rules-dialog'),

    potAmount: document.getElementById('pot-amount'),
    potsRow: document.getElementById('pots-row'), // NEW 9.0 (§6.10)
    btnOpenClaimDialog: document.getElementById('btn-open-claim-dialog'),

    claimBanner: document.getElementById('claim-banner'),
    claimBannerBody: document.getElementById('claim-banner-body'),
    claimBannerActions: document.getElementById('claim-banner-actions'),
    btnApproveClaim: document.getElementById('btn-approve-claim'),
    btnRejectClaim: document.getElementById('btn-reject-claim'),

    dealerRail: document.getElementById('dealer-rail'),
    rabbitHuntGroup: document.getElementById('rabbit-hunt-group'),
    btnRabbitHunt: document.getElementById('btn-rabbit-hunt'),
    dealSectionDivider: document.getElementById('deal-section-divider'),
    dealGroup: document.getElementById('deal-group'),
    cardsPerPlayer: document.getElementById('cards-per-player'),
    btnDeal: document.getElementById('btn-deal'),
    newHandGroup: document.getElementById('new-hand-group'),
    btnNewHand: document.getElementById('btn-new-hand'),
    drawSectionDivider: document.getElementById('draw-section-divider'),
    dealToPlayerGroup: document.getElementById('deal-to-player-group'),
    dealTargetSelect: document.getElementById('deal-target-select'),
    dealTargetCount: document.getElementById('deal-target-count'),
    btnDealToPlayer: document.getElementById('btn-deal-to-player'),
    dealCommunityGroup: document.getElementById('deal-community-group'),
    dealCommunityCount: document.getElementById('deal-community-count'),
    btnDealCommunity: document.getElementById('btn-deal-community'),
    bettingSectionDivider: document.getElementById('betting-section-divider'),
    setAnteGroup: document.getElementById('set-ante-group'),
    anteTargetSelect: document.getElementById('ante-target-select'),
    anteAmount: document.getElementById('ante-amount'),
    btnSetAnte: document.getElementById('btn-set-ante'),
    // NEW 10.4 (the-cut-spec_v10-4.md B.2 replacement / 10.4 Completion Gap 2).
    misdealGroup: document.getElementById('misdeal-group'),
    btnMisdeal: document.getElementById('btn-misdeal'),
    openBettingGroup: document.getElementById('open-betting-group'),
    btnOpenBetting: document.getElementById('btn-open-betting'),
    openingBettorGroup: document.getElementById('opening-bettor-group'),
    openingBettorHint: document.getElementById('opening-bettor-hint'),
    openingBettorSelect: document.getElementById('opening-bettor-select'),
    gameSectionDivider: document.getElementById('game-section-divider'),
    reshuffleAdvanceTurnGroup: document.getElementById('reshuffle-advance-turn-group'),
    btnReshuffle: document.getElementById('btn-reshuffle'),
    btnAdvanceTurn: document.getElementById('btn-advance-turn'),
    btnBurn: document.getElementById('btn-burn'),
    passBuckGroup: document.getElementById('pass-buck-group'),
    btnPassBuck: document.getElementById('btn-pass-buck'),

    playerRail: document.getElementById('player-rail'),
    tableBody: document.getElementById('table-body'), // NEW 9.3 -- needed so the collapse toggle can actually resize the grid track, not just the rail's own content
    btnPlayerRailToggle: document.getElementById('btn-player-rail-toggle'), // BUG FIX 9.3 -- was assigned as el.playerRailToggle but used everywhere as el.btnPlayerRailToggle, leaving the real property undefined; .addEventListener on it threw at page load, before Create/Join Room's own listeners ever attached, breaking the entire landing page
    ownChipReadout: document.getElementById('own-chip-readout'),
    ownReconnectCodeReadout: document.getElementById('own-reconnect-code-readout'), // NEW 11.0 (Part D)
    btnOpenBuyDialog: document.getElementById('btn-open-buy-dialog'),
    btnSitToggle: document.getElementById('btn-sit-toggle'),

    // NEW 11.0 (Part F.1)
    btnLeaveTable: document.getElementById('btn-leave-table'),
    leaveTableDialog: document.getElementById('leave-table-choice-dialog'),
    leaveTableDialogHint: document.getElementById('leave-table-dialog-hint'),
    btnLeaveFold: document.getElementById('btn-leave-fold'),
    btnLeaveAtCycleClose: document.getElementById('btn-leave-at-cycle-close'),
    btnLeaveCancel: document.getElementById('btn-leave-cancel'),

    // NEW 11.0 (Part H.2)
    inactivityBanner: document.getElementById('inactivity-banner'),
    inactivityPopup: document.getElementById('inactivity-popup'),
    inactivityPopupHint: document.getElementById('inactivity-popup-hint'),
    btnRestartActivityClock: document.getElementById('btn-restart-activity-clock'),
    btnOpenAboutDialog: document.getElementById('btn-open-about-dialog'),

    buyDialog: document.getElementById('buy-chips-dialog'),
    buyAmountInput: document.getElementById('buy-amount-input'),
    btnBuyCancel: document.getElementById('btn-buy-cancel'),
    btnBuyConfirm: document.getElementById('btn-buy-confirm'),

    // NEW 10.4 (the-cut-spec_v10-4.md Part A §5): Table Owner Tools.
    tableOwnerRailGroup: document.getElementById('table-owner-rail-group'),
    tableOwnerSectionDivider: document.getElementById('table-owner-section-divider'), // FIXED (11.0 review finding #2)
    tableOwnerSectionLabel: document.getElementById('table-owner-section-label'),
    btnOpenTableOwnerDialog: document.getElementById('btn-open-table-owner-dialog'),
    tableOwnerDialog: document.getElementById('table-owner-dialog'),
    btnToTerminate: document.getElementById('btn-to-terminate'),
    btnToRestore: document.getElementById('btn-to-restore'),
    toDistributionSection: document.getElementById('to-distribution-section'),
    toDistributionHint: document.getElementById('to-distribution-hint'),
    btnToBeginDistribution: document.getElementById('btn-to-begin-distribution'),
    toDistributionWorkspace: document.getElementById('to-distribution-workspace'),
    toPreviewPotNow: document.getElementById('to-preview-pot-now'),
    toPreviewPotAfter: document.getElementById('to-preview-pot-after'),
    toAllocList: document.getElementById('to-alloc-list'),
    toAllocPlayer: document.getElementById('to-alloc-player'),
    toAllocDirection: document.getElementById('to-alloc-direction'),
    toAllocAmount: document.getElementById('to-alloc-amount'),
    btnToAllocAdd: document.getElementById('btn-to-alloc-add'),
    btnToDiscardBatch: document.getElementById('btn-to-discard-batch'),
    btnToCommitBatch: document.getElementById('btn-to-commit-batch'),
    btnToClose: document.getElementById('btn-to-close'),

    // NEW 11.0 (Part F.2/F.6)
    toRemovePlayerSelect: document.getElementById('to-remove-player'),
    btnToRemovePlayer: document.getElementById('btn-to-remove-player'),
    btnToEndGame: document.getElementById('btn-to-end-game'),

    // NEW 11.0 (Part B/D): Table Owner Settings.
    btnOpenSettingsDialog: document.getElementById('btn-open-settings-dialog'),
    settingsDialog: document.getElementById('settings-dialog'),
    settingsReconnectTimeout: document.getElementById('settings-reconnect-timeout'),
    btnSettingsSaveTimeout: document.getElementById('btn-settings-save-timeout'),
    settingsReconnectCodes: document.getElementById('settings-reconnect-codes'),
    btnSettingsClose: document.getElementById('btn-settings-close'),

    // NEW 11.1 (Testing dialog)
    btnOpenTestingDialog: document.getElementById('btn-open-testing-dialog'),
    testingDialog: document.getElementById('testing-dialog'),
    testingForceDisconnectSelect: document.getElementById('testing-force-disconnect-select'),
    btnTestingForceDisconnect: document.getElementById('btn-testing-force-disconnect'),
    btnTestingForceInactivity: document.getElementById('btn-testing-force-inactivity'),
    btnTestingClose: document.getElementById('btn-testing-close'),

    // NEW 11.1 (Fix 2): reusable app-styled confirm, replacing window.confirm()
    // NEW 11.3 (Part A.5): Connection Lost / Reconnect popup.
    reconnectDialog: document.getElementById('reconnect-dialog'),
    reconnectDialogSubheading: document.getElementById('reconnect-dialog-subheading'), // NEW 11.5 (Part A.1)
    reconnectDialogMessage: document.getElementById('reconnect-dialog-message'),
    reconnectDialogCountdown: document.getElementById('reconnect-dialog-countdown'),

    appConfirmDialog: document.getElementById('app-confirm-dialog'),
    appConfirmMessage: document.getElementById('app-confirm-message'),
    btnAppConfirmOk: document.getElementById('btn-app-confirm-ok'),
    btnAppConfirmCancel: document.getElementById('btn-app-confirm-cancel'),

    suggestedBuyinDialog: document.getElementById('suggested-buyin-dialog'),
    suggestedBuyinInput: document.getElementById('suggested-buyin-input'),
    btnSuggestedBuyinCancel: document.getElementById('btn-suggested-buyin-cancel'),
    btnSuggestedBuyinSave: document.getElementById('btn-suggested-buyin-save'),

    sitoutDialog: document.getElementById('sitout-choice-dialog'),
    sitoutDialogHint: document.getElementById('sitout-dialog-hint'),
    btnSitoutFold: document.getElementById('btn-sitout-fold'),
    btnSitoutNext: document.getElementById('btn-sitout-next'),
    btnSitoutCancel: document.getElementById('btn-sitout-cancel'),

    studWarningDialog: document.getElementById('stud-warning-dialog'),
    btnStudWarningCancel: document.getElementById('btn-stud-warning-cancel'),
    btnStudWarningStart: document.getElementById('btn-stud-warning-start'),

    claimDialog: document.getElementById('claim-pot-dialog'),
    claimPotTotal: document.getElementById('claim-pot-total'),
    claimAllocList: document.getElementById('claim-alloc-list'),
    claimCarryCheck: document.getElementById('claim-carry-check'), // NEW 8.2 (§6.5)
    claimCarryAmount: document.getElementById('claim-carry-amount'), // NEW 8.2 (§6.5)
    claimRemaining: document.getElementById('claim-remaining'),
    btnClaimDialogCancel: document.getElementById('btn-claim-dialog-cancel'),
    btnClaimDialogConfirm: document.getElementById('btn-claim-dialog-confirm'),

    rulesDialog: document.getElementById('rules-dialog'),
    rulesIndex: document.getElementById('rules-index'),
    btnRulesClose: document.getElementById('btn-rules-close'),

    selectDialog: document.getElementById('select-dialog'),
    selectIndex: document.getElementById('select-index'),
    btnSelectClose: document.getElementById('btn-select-close'),

    optionsDialog: document.getElementById('options-dialog'),
    gameOptionsList: document.getElementById('game-options-list'),
    btnOptionsConfirm: document.getElementById('btn-options-confirm'),
    btnOptionsCancel: document.getElementById('btn-options-cancel'), // NEW 10.4 (Part C)
    optionsGameName: document.getElementById('options-game-name'), // NEW 8.2 (§10.5)
    fixedLimitBetsDisplay: document.getElementById('fixed-limit-bets-display'), // NEW 9.2 (§6.10)
    btnOptionsRules: document.getElementById('btn-options-rules'), // NEW 8.2 (§10.5)

    aboutDialog: document.getElementById('about-dialog'),
    aboutBody: document.getElementById('about-body'),
    btnAboutClose: document.getElementById('btn-about-close'),

    bettingRail: document.getElementById('betting-rail'),
    bettingRailShared: document.getElementById('betting-rail-shared'),
    raiseCapIndicator: document.getElementById('raise-cap-indicator'), // NEW 9.2 (§6.10)
    personalTurnActions: document.getElementById('personal-turn-actions'),
    betAmount: document.getElementById('bet-amount'),
    btnPlaceBet: document.getElementById('btn-place-bet'),
    btnCall: document.getElementById('btn-call'),
    btnCheck: document.getElementById('btn-check'),
    personalFoldAction: document.getElementById('personal-fold-action'),
    btnFold: document.getElementById('btn-fold'),
    btnAllIn: document.getElementById('btn-all-in'), // NEW 9.0 (§6.11)
    raiseLimitsHint: document.getElementById('raise-limits-hint'), // NEW 9.0 (§6.10)
    allInDialog: document.getElementById('all-in-dialog'),
    allInDialogText: document.getElementById('all-in-dialog-text'),
    btnAllInCancel: document.getElementById('btn-all-in-cancel'),
    btnAllInConfirm: document.getElementById('btn-all-in-confirm'),
    personalAnteAction: document.getElementById('personal-ante-action'),
    personalAnteLabel: document.getElementById('personal-ante-label'),
    btnPostAnte: document.getElementById('btn-post-ante'),
    personalDiscardAction: document.getElementById('personal-discard-action'),
    personalDiscardLabel: document.getElementById('personal-discard-label'),
    btnDiscard: document.getElementById('btn-discard'),
    btnStandPat: document.getElementById('btn-stand-pat'),
    // NEW 8.1 (§5.11), GENERALIZED 8.2
    personalDeclareAction: document.getElementById('personal-declare-action'),
    btnDeclareA: document.getElementById('btn-declare-a'),
    btnDeclareB: document.getElementById('btn-declare-b'),
    btnDeclareBoth: document.getElementById('btn-declare-both'),
    // NEW 8.1 (§6.9)
    killHandDialog: document.getElementById('kill-hand-dialog'),
    killHandDialogText: document.getElementById('kill-hand-dialog-text'),
    btnKillHandCancel: document.getElementById('btn-kill-hand-cancel'),
    btnKillHandConfirm: document.getElementById('btn-kill-hand-confirm'),
    // NEW 8.1 (§5.10 extension)
    payOrFoldDialog: document.getElementById('pay-or-fold-dialog'),
    payOrFoldDialogText: document.getElementById('pay-or-fold-dialog-text'),
    btnDealInterruptFold: document.getElementById('btn-deal-interrupt-fold'),
    btnDealInterruptPay: document.getElementById('btn-deal-interrupt-pay'),
    buyOrDeclineDialog: document.getElementById('buy-or-decline-dialog'),
    buyOrDeclineDialogText: document.getElementById('buy-or-decline-dialog-text'),
    btnDealInterruptDecline: document.getElementById('btn-deal-interrupt-decline'),
    btnDealInterruptBuy: document.getElementById('btn-deal-interrupt-buy'),
  };

  // ---- connection ----

  /**
   * CHANGED 11.3 (Part B.2): the main connection, used at initial page
   * load. `onOpen`/`onFailed` let callers (specifically the sessionStorage
   * auto-reconnect-on-load path, Part A.7) hook the outcome without this
   * function needing to know about them itself.
   */
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);
    state.ws = ws;

    ws.addEventListener('open', () => {
      // CHANGED 11.3 (Part B.2): flush anything send() queued while this
      // connection was opening, in the exact order it was queued.
      const queued = state.messageQueue;
      state.messageQueue = [];
      for (const raw of queued) ws.send(raw);
      restorePendingLobbyButton();

      // NEW 11.0 (Part D): safe to auto-submit only once the socket is
      // actually open. Fields are pre-filled at page load by
      // maybeAutoFillRejoinFromUrl() below; this just performs the
      // actual submit once there's a live socket.
      if (state.autoRejoinPending) {
        state.autoRejoinPending = false;
        el.btnRejoinGameTable.click();
      }
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerMessage(msg);
    });

    ws.addEventListener('close', () => {
      // CHANGED 11.3 (Part A): a lost connection while genuinely seated
      // at a table now starts the real reconnect-resilience flow
      // (Part A) instead of just telling the player to refresh. A lost
      // connection while still on the landing page needs no special
      // handling at all anymore -- Part B.2 made send() itself
      // transparently reconnect on the next click, so there's nothing
      // to alarm the player about here. `deliberatelyLeaving` guards
      // against this ALSO firing right after a real Leave Table/End
      // Game teardown, which already handles its own navigation.
      if (!el.viewGameTableTop.hidden && state.playerId && !state.deliberatelyLeaving) {
        startReconnectFlow();
      }
    });
  }

  /**
   * NEW 11.3 (Part B.2): send() itself is now robust to a not-open
   * socket -- rather than a separate background reconnect ticker
   * guessing when to proactively reopen an idle landing-page socket
   * (confirmed root cause: the shared heartbeat loop pings every
   * connected socket, landing-page ones included, so one left idle for
   * 20-30s while a player looks up their code was just as subject to
   * the same ~10-12s detection window and termination as an in-table
   * one -- and send()'s old silent readyState guard meant a click on a
   * now-dead socket did visibly nothing at all). A not-open socket now
   * transparently opens a fresh one, queues the message, and flushes it
   * the instant that connection's own 'open' handler (above) fires --
   * one unified mechanism that also incidentally covers the rarer
   * "clicked before the very first handshake finished" case.
   */
  function send(type, payload = {}) {
    const raw = JSON.stringify({ type, ...payload });
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(raw);
      return;
    }
    state.messageQueue.push(raw);
    if (!state.ws || state.ws.readyState !== WebSocket.CONNECTING) {
      connect();
    }
  }

  /**
   * NEW 11.3 (Part B.2): shows "Connecting…" on whichever lobby button
   * triggered a send() that had to queue -- so a click never again just
   * silently evaporates. Restored automatically once the queued message
   * actually flushes (see connect()'s own 'open' handler), or after a
   * short safety timeout in case the connection never opens at all.
   */
  function markLobbyButtonConnecting(button) {
    if (state.pendingLobbyButton) return; // already showing on some button
    state.pendingLobbyButton = button;
    button.dataset.originalLabel = button.textContent;
    button.textContent = 'Connecting\u2026';
    button.disabled = true;
    state.pendingLobbyButtonTimeout = setTimeout(restorePendingLobbyButton, 6000);
  }

  function restorePendingLobbyButton() {
    if (!state.pendingLobbyButton) return;
    clearTimeout(state.pendingLobbyButtonTimeout);
    const button = state.pendingLobbyButton;
    button.textContent = button.dataset.originalLabel;
    button.disabled = false;
    state.pendingLobbyButton = null;
  }

  // ---- Reconnect Resilience (NEW 11.3, Part A) ----

  const RECONNECT_RETRY_INTERVAL_MS = 2500; // A.4: "every 2-3 seconds"
  const RECONNECT_ATTEMPT_TIMEOUT_MS = 3500; // A.4: "on the order of 3-4 seconds"
  const SESSION_STORAGE_KEY = 'theCutSession'; // A.7

  function saveSessionForReconnect() {
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ gameTableCode: state.gameTableCode, reconnectCode: state.myReconnectCode }));
    } catch {
      // sessionStorage unavailable (private browsing, etc.) -- the rest
      // of the app works fine without it; this is a pure enhancement.
    }
  }

  function clearSessionForReconnect() {
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // see saveSessionForReconnect()'s own comment
    }
  }

  function loadSessionForReconnect() {
    try {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.gameTableCode && parsed.reconnectCode) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * NEW 11.3 (Part A.4): the one underlying reconnect operation, shared
   * verbatim by the automatic timer and the manual button -- they differ
   * only in what triggers each attempt, never in what the attempt itself
   * does. `onSettled(success)` lets a caller (specifically the
   * sessionStorage-on-load path, Part A.7) react to the outcome; the
   * disconnect-flow's own timer/button just ignore it and let the
   * ongoing flow keep ticking either way.
   *
   * Deliberately its own dedicated WebSocket per attempt, NOT a call
   * through send()/connect() -- this needs its own short, independent
   * timeout (a connection that hangs silently, rather than actively
   * refusing, must not be allowed to block the shared in-flight flag
   * far longer than the intended retry cadence) and its own
   * success/failure branch, neither of which send()'s generic queue-
   * and-flush mechanism was built to provide.
   */
  function attemptReconnectOnce(gameTableCode, reconnectCode, onSettled) {
    if (state.reconnectAttemptInFlight) return; // shared in-flight rule (A.4)
    state.reconnectAttemptInFlight = true;
    renderReconnectDialog();

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const attemptWs = new WebSocket(`${protocol}//${location.host}`);
    let settled = false;

    function finish(success) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      state.reconnectAttemptInFlight = false;
      renderReconnectDialog();
      if (onSettled) onSettled(success);
    }

    const timeoutHandle = setTimeout(() => {
      try {
        attemptWs.close();
      } catch {
        // already closed/closing -- nothing further to do
      }
      finish(false);
    }, RECONNECT_ATTEMPT_TIMEOUT_MS);

    attemptWs.addEventListener('open', () => {
      attemptWs.send(JSON.stringify({ type: 'reconnectToGameTable', gameTableCode, code: reconnectCode }));
    });
    attemptWs.addEventListener('message', (event) => {
      if (settled) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'joined') {
        adoptSocket(attemptWs);
        handleServerMessage(msg); // sets state.playerId, calls showTableView(), etc.
        finish(true);
      } else if (msg.type === 'reconnectError') {
        try {
          attemptWs.close();
        } catch {
          // already closing
        }
        finish(false);
      }
    });
    attemptWs.addEventListener('close', () => finish(false));
  }

  /**
   * NEW 11.3 (Part A.4): promotes a successful reconnect attempt's own
   * socket to be the app's main connection going forward -- wired with
   * the exact same message/close handling connect()'s own socket uses,
   * so ongoing play continues normally through it.
   */
  function adoptSocket(ws) {
    state.ws = ws;
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerMessage(msg);
    });
    ws.addEventListener('close', () => {
      if (!el.viewGameTableTop.hidden && state.playerId && !state.deliberatelyLeaving) {
        startReconnectFlow();
      }
    });
  }

  /**
   * NEW 11.3 (Part A): called once, the moment the main socket is
   * detected lost while genuinely seated at a table. Runs the automatic
   * timer AND leaves the manual button live for the ENTIRE Grace
   * Period, per A.3's own correction -- an earlier draft staged these
   * as sequential phases (silent auto-retry, then manual-only once that
   * "failed"), which was wrong: if background-tab throttling can
   * suppress the automatic timer (the same throttling responsible for a
   * real share of disconnects during same-machine multi-tab testing),
   * that's exactly the scenario where an automatic-only phase might
   * silently not be running, with no way for the player to know. A
   * manual click reliably works in that exact case, since clicking a
   * tab necessarily brings it into focus first.
   */
  function startReconnectFlow() {
    if (state.reconnectFlowActive) return;
    state.reconnectFlowActive = true;
    state.reconnectExpired = false;
    stopClientHeartbeat(); // NEW 11.4 (Part A) -- no longer genuinely connected; restarted fresh on the next successful 'joined'

    // A.5: the outcome (fold vs. checked-through) is already fully
    // determined by the last known betting state at the moment of
    // disconnect -- computed once here, mirroring the exact same
    // "amount owed" figure the ordinary betting rail's own "$YY to You"
    // UI is built from, and the server's own _isFacingABet().
    const gameTable = state.lastGameTable;
    const me = gameTable?.players.find((p) => p.id === state.playerId);
    state.reconnectWillFold = !!(gameTable && me && gameTable.bettingOpen && gameTable.currentBetToCall - me.currentBet > 0);

    const graceSeconds = gameTable?.reconnectTimeoutSeconds || 30;
    state.reconnectGraceDeadline = Date.now() + graceSeconds * 1000;

    renderReconnectDialog();
    el.reconnectDialog.showModal();

    const doAttempt = () => attemptReconnectOnce(state.gameTableCode, state.myReconnectCode);
    doAttempt(); // don't wait a full interval for the very first try
    state.reconnectTimer = setInterval(doAttempt, RECONNECT_RETRY_INTERVAL_MS);
    state.reconnectCountdownTicker = setInterval(renderReconnectDialog, 1000);
  }

  function stopReconnectFlow() {
    if (!state.reconnectFlowActive) return;
    state.reconnectFlowActive = false;
    clearInterval(state.reconnectTimer);
    clearInterval(state.reconnectCountdownTicker);
    state.reconnectTimer = null;
    state.reconnectCountdownTicker = null;
    if (el.reconnectDialog.open) el.reconnectDialog.close();
  }

  // ---- Client-side active heartbeat (NEW 11.4, Part A) ----

  const CLIENT_HEARTBEAT_INTERVAL_MS = 6000; // "every 5-8 seconds"
  const CLIENT_HEARTBEAT_ACK_TIMEOUT_MS = 6000; // "a reasonable window"

  /**
   * NEW 11.4 (Part A): symmetric to the server's own heartbeat. The
   * server actively pings every client and can tell within 10-15s if a
   * pong doesn't return -- the client had no equivalent of its own,
   * since browsers don't expose WebSocket ping/pong frames to
   * JavaScript at all. Confirmed live: with wifi disabled entirely, the
   * client-side socket just sits idle waiting for data that will never
   * arrive, and detecting that purely by absence falls back to the OS's
   * own TCP dead-peer detection -- hours by default on Windows, nowhere
   * close to the 10-15s the server already achieves. This is a plain
   * application-level message (`clientHeartbeat`/`clientHeartbeatAck`)
   * for exactly that reason. Only runs while genuinely connected at a
   * table (started from the 'joined' handler, which fires for both an
   * original join/create AND a successful reconnect) -- never during a
   * reconnect ATTEMPT itself, which already has its own dedicated
   * short timeout (attemptReconnectOnce()) and doesn't need a second,
   * redundant one layered on top.
   */
  function startClientHeartbeat() {
    stopClientHeartbeat();
    state.clientHeartbeatTimer = setInterval(() => {
      const ws = state.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (state.clientHeartbeatAckTimeout) return; // one in flight already -- skip this tick, same shared-flag shape as A.4's reconnect attempts
      state.clientHeartbeatAckTimeout = setTimeout(() => {
        state.clientHeartbeatAckTimeout = null;
        // No ack within the window -- don't wait for the browser to
        // eventually notice on its own. Closing here triggers the exact
        // same 'close' handler already driving startReconnectFlow() (Part
        // A of the-cut-spec_v11-3.md) -- no new reconnect logic needed.
        try {
          ws.close();
        } catch {
          // already closed/closing
        }
      }, CLIENT_HEARTBEAT_ACK_TIMEOUT_MS);
      try {
        ws.send(JSON.stringify({ type: 'clientHeartbeat' }));
      } catch {
        // send() failing here means the socket is already on its way
        // out -- the ack timeout above will close it shortly regardless.
      }
    }, CLIENT_HEARTBEAT_INTERVAL_MS);
  }

  function stopClientHeartbeat() {
    clearInterval(state.clientHeartbeatTimer);
    state.clientHeartbeatTimer = null;
    clearTimeout(state.clientHeartbeatAckTimeout);
    state.clientHeartbeatAckTimeout = null;
  }

  /**
   * NEW 11.3 (Part A.5): purely a render from already-known state --
   * ticks on its own timer (see startReconnectFlow()) rather than only
   * re-running when something else happens to change, since the whole
   * point is a live countdown with nothing else necessarily occurring
   * in between ticks.
   */
  /**
   * CHANGED 11.5 (Part A): restructured per the spec's own four
   * sub-parts. A.1: a second heading line, driven by the exact same
   * reconnectExpired flag as everything else here. A.2: the
   * Grace-Period-active message/countdown content is UNCHANGED --
   * confirmed correct as-is via screenshot review, no merging. A.3:
   * the post-expiry message is shortened -- the "you can still
   * reconnect at any time" half is now redundant given A.1's new
   * heading already says reconnection is ongoing. A.4: no more manual
   * button/disabled-state logic at all -- automatic retry alone runs
   * indefinitely, exactly as it already did.
   */
  function renderReconnectDialog() {
    if (!state.reconnectFlowActive) return;
    const msRemaining = state.reconnectGraceDeadline - Date.now();
    if (!state.reconnectExpired && msRemaining <= 0) {
      state.reconnectExpired = true;
      clearInterval(state.reconnectCountdownTicker);
      state.reconnectCountdownTicker = null;
    }

    if (!state.reconnectExpired) {
      el.reconnectDialogSubheading.textContent = 'Attempting Reconnection';
      const secondsLeft = Math.max(0, Math.ceil(msRemaining / 1000));
      el.reconnectDialogCountdown.textContent = `${secondsLeft}s remaining`;
      el.reconnectDialogMessage.textContent = state.reconnectWillFold
        ? "You'll be folded."
        : "You'll be checked through, but you can't reveal or claim the pot while disconnected.";
    } else {
      el.reconnectDialogSubheading.textContent = 'Still Attempting Reconnection';
      el.reconnectDialogCountdown.textContent = '';
      el.reconnectDialogMessage.textContent = "You've been moved to Sitting Out.";
    }
  }

  // Never closable by Escape -- this reflects an unavoidable state, not
  // something to dismiss while the underlying problem persists.
  el.reconnectDialog.addEventListener('cancel', (event) => event.preventDefault());

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'joined':
        state.playerId = msg.playerId;
        state.gameTableCode = msg.gameTableCode;
        state.myReconnectCode = msg.reconnectCode; // NEW 11.0 (Part D)
        // FIXED 11.2 (Fix 6): the server now says explicitly whether this
        // was a reconnect or a genuine create/join -- the client itself
        // can never tell the difference on its own (its local state is
        // equally empty either way), which is exactly why the Buy Chips
        // prompt below was incorrectly firing on every reconnect too.
        state.isReconnect = msg.isReconnect === true;
        saveSessionForReconnect(); // NEW 11.3 (Part A.7)
        stopReconnectFlow(); // NEW 11.3 (Part A) -- a no-op unless this WAS a recovery from a lost connection
        startClientHeartbeat(); // NEW 11.4 (Part A) -- (re)starts fresh on every successful join/reconnect
        showTableView();
        break;
      case 'gameTableState': {
        const isFirstGameTableState = !state.lastGameTable;
        maybePlayChipSound(state.lastGameTable, msg.gameTable);
        state.lastGameTable = msg.gameTable;
        state.pendingGuardedButton = null; // NEW 9.2 (§6.6) -- a successful action resolved whatever was pending
        renderGameTable(msg.gameTable);
        // CHANGED 11.2 (Fix 6): was gated on isFirstGameTableState alone,
        // which is equally true for a reconnecting client (its own local
        // state starts just as empty) -- now also requires that this
        // wasn't a reconnect, per the 'joined' message's own new field.
        if (isFirstGameTableState && !state.isReconnect) maybeShowSuggestedBuyInPrompt(msg.gameTable);
        break;
      }
      case 'joinError':
        showLobbyError(msg.message);
        break;
      case 'reconnectError': // NEW 11.0 (Part D)
        showLobbyError(msg.message);
        break;
      case 'leftTable': // NEW 11.0 (Part F.1/F.2)
        state.deliberatelyLeaving = true; // NEW 11.3 (Part A) -- don't let the resulting close ALSO start the reconnect flow
        clearSessionForReconnect(); // NEW 11.3 (Part A.7)
        stopClientHeartbeat(); // NEW 11.4 (Part A)
        showTableError('You left the table. Returning to the lobby\u2026');
        setTimeout(() => window.location.href = '/', 1500);
        break;
      case 'tableEnded': // NEW 11.0 (Part F.6/H.2)
        state.deliberatelyLeaving = true; // NEW 11.3 (Part A)
        clearSessionForReconnect(); // NEW 11.3 (Part A.7)
        stopClientHeartbeat(); // NEW 11.4 (Part A)
        showTableError(msg.message || 'This table has ended. Returning to the lobby\u2026');
        setTimeout(() => window.location.href = '/', 1500);
        break;
      case 'clientHeartbeatAck': // NEW 11.4 (Part A)
        clearTimeout(state.clientHeartbeatAckTimeout);
        state.clientHeartbeatAckTimeout = null;
        break;
      case 'dealError':
        showTableError(msg.message);
        // NEW 9.2 (§6.6): the 6.1 click-guard fix assumed every server
        // response -- success or rejection -- triggers a fresh render
        // that would reset a disabled button. That assumption breaks
        // for a rejection specifically, since nothing about game state
        // changed, so there's often no accompanying state broadcast at
        // all to reset anything. Explicit re-enable here instead of
        // relying on an incidental future render. The Bet/Raise amount
        // field is deliberately left populated (not cleared) so the
        // rejected value can be seen and adjusted.
        if (state.pendingGuardedButton) {
          state.pendingGuardedButton.disabled = false;
          state.pendingGuardedButton = null;
        }
        break;
      case 'announcement':
        showTableAnnouncement(msg.text, msg.kind); // NEW 9.0 (§6.11): kind drives the All-In notice's distinct styling
        break;
      default:
        break;
    }
  }

  // ---- chip sounds (client-side, diffed from consecutive gameTableState payloads -- spec §8) ----

  let audioCtx = null;
  function getAudioCtx() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  document.addEventListener('pointerdown', () => getAudioCtx(), { once: true });
  document.addEventListener('keydown', () => getAudioCtx(), { once: true });

  function playTone(freq, duration, type, gainPeak, startDelay) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const now = ctx.currentTime + (startDelay || 0);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(gainPeak, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  function playBetSound() {
    playTone(1200, 0.08, 'square', 0.07);
  }
  function playClaimSound() {
    playTone(700, 0.12, 'triangle', 0.1, 0);
    playTone(1050, 0.16, 'triangle', 0.1, 0.09);
  }

  /** pot increased -> bet sound (covers bet/call/raise/ante); pot reset to 0 alongside a stack increase -> claim sound. */
  function maybePlayChipSound(prevGameTable, nextGameTable) {
    if (!prevGameTable) return;
    if (nextGameTable.pot > prevGameTable.pot) {
      playBetSound();
      return;
    }
    if (prevGameTable.pot > 0 && nextGameTable.pot === 0) {
      const someoneGrew = nextGameTable.players.some((p) => {
        const before = prevGameTable.players.find((pp) => pp.id === p.id);
        return before && p.chips > before.chips;
      });
      if (someoneGrew) playClaimSound();
    }
  }

  let phaseBannerFlashTimer = null;
  let phaseBannerLastPhase = undefined;

  /**
   * NEW 6.1 (§10.7): replaces the 5.0 betting-complete toast and
   * standalone Showdown banner with one persistent, handPhase+profile-
   * driven banner covering every phase. Text is looked up by BOTH
   * together, not handPhase alone -- Draw and Hold'em share phase names
   * like 'RequestAntes' but need different text. Flexible-toolbox
   * profiles (Stud, no profile) never leave 'PreGame', so they always
   * read the PreGame/CycleComplete text -- not a special case, just a
   * natural consequence of the lookup table.
   */
  const PHASE_BANNER_TEXT = {
    draw: {
      PreGame: "THE CUT \u2013 Dealer's Choice",
      RequestAntes: 'Pay Antes',
      OpeningDeal: 'Opening Deal',
      FirstBetting: '1st Betting Round',
      DiscardPhase: 'Discard',
      DrawPhase: 'Draw Cards',
      SecondBetting: '2nd Betting Round',
      Showdown: '♣♥ SHOWDOWN ♦♠',
      CycleComplete: "THE CUT \u2013 Dealer's Choice",
    },
    holdem: {
      PreGame: "THE CUT \u2013 Dealer's Choice",
      RequestAntes: 'Pay Blinds',
      PreFlop: 'Pre-Flop Deal',
      PreFlopBetting: 'Pre-Flop Betting Round',
      Flop: 'The Flop',
      FlopBetting: 'Flop Betting Round',
      Turn: 'The Turn',
      TurnBetting: 'Turn Betting Round',
      River: 'The River',
      RiverBetting: 'River Betting Round',
      Showdown: '♣♥ SHOWDOWN ♦♠',
      CycleComplete: "THE CUT \u2013 Dealer's Choice",
    },
    // NEW 7.0 (§10.7): Stud needs a THIRD lookup axis -- profile + variant
    // (5-Card vs. 7-Card), not just profile + handPhase like Draw/Hold'em
    // -- since the same handPhase value ('StreetA', etc.) means a
    // different literal street number between the two variants. Split
    // into two sibling tables, chosen by gameTable.finalStreet ('D' -> 5-Card,
    // 'E' -> 7-Card) in phaseBannerText() below.
    stud5: {
      PreGame: "THE CUT \u2013 Dealer's Choice",
      RequestAntes: 'Pay Antes',
      StreetA: '2nd Street',
      StreetABetting: '2nd Street Betting Round',
      StreetB: '3rd Street',
      StreetBBetting: '3rd Street Betting Round',
      StreetC: '4th Street',
      StreetCBetting: '4th Street Betting Round',
      StreetD: '5th Street',
      StreetDBetting: '5th Street Betting Round',
      Declare: 'Declare', // BUG FIX 8.2 (§10.7) -- was missing entirely, fell through to Showdown's text
      Showdown: '♣♥ SHOWDOWN ♦♠',
      CycleComplete: "THE CUT \u2013 Dealer's Choice",
    },
    stud7: {
      PreGame: "THE CUT \u2013 Dealer's Choice",
      RequestAntes: 'Pay Antes',
      StreetA: '3rd Street',
      StreetABetting: '3rd Street Betting Round',
      StreetB: '4th Street',
      StreetBBetting: '4th Street Betting Round',
      StreetC: '5th Street',
      StreetCBetting: '5th Street Betting Round',
      StreetD: '6th Street',
      StreetDBetting: '6th Street Betting Round',
      StreetE: '7th Street',
      StreetEBetting: '7th Street Betting Round',
      Declare: 'Declare', // BUG FIX 8.2 (§10.7) -- was missing entirely, fell through to Showdown's text
      Showdown: '♣♥ SHOWDOWN ♦♠',
      CycleComplete: "THE CUT \u2013 Dealer's Choice",
    },
  };

  function phaseBannerText(gameTable) {
    // NEW 7.0: with a Stud Game Choice active, gameTable.finalStreet is real
    // ('D' or 'E'); before any Game Choice is selected, it's still the
    // constructor default and never actually looked up (handPhase stays
    // 'PreGame' the whole time, caught by the fallback below either way).
    const table = gameTable.profile === 'stud' ? PHASE_BANNER_TEXT[gameTable.finalStreet === 'D' ? 'stud5' : 'stud7'] : PHASE_BANNER_TEXT[gameTable.profile];
    if (table && table[gameTable.handPhase]) return table[gameTable.handPhase];
    return "THE CUT \u2013 Dealer's Choice"; // flexible-toolbox profiles: handPhase never leaves PreGame
  }

  /**
   * Called every render. Detects a handPhase transition (compared to the
   * last render, not the last gameTableState -- same value either way in
   * practice, but this keeps the check colocated with rendering rather
   * than needing its own diff hook alongside maybePlayChipSound). On a
   * genuine transition, flashes reverse-color for ~1.5s before settling.
   * Showdown's settled state is the pre-existing decorated/pulsing style
   * (phase-banner--showdown), not the plain one every other phase uses --
   * the reverse-color flash on transition-in still applies universally,
   * including into Showdown; only what it settles into afterward differs.
   */
  function renderPhaseBanner(gameTable) {
    el.phaseBanner.textContent = phaseBannerText(gameTable);

    const isShowdown = gameTable.handPhase === 'Showdown' && (gameTable.profile === 'draw' || gameTable.profile === 'holdem' || gameTable.profile === 'stud');
    const transitioned = phaseBannerLastPhase !== undefined && phaseBannerLastPhase !== gameTable.handPhase;
    phaseBannerLastPhase = gameTable.handPhase;

    el.phaseBanner.classList.toggle('phase-banner--showdown', isShowdown);

    if (transitioned) {
      el.phaseBanner.classList.add('phase-banner--flash');
      clearTimeout(phaseBannerFlashTimer);
      phaseBannerFlashTimer = setTimeout(() => {
        el.phaseBanner.classList.remove('phase-banner--flash');
      }, 1500);
    }
  }

  /**
   * NEW 4.5 (§10.1): auto-opens Buy Chips, pre-filled with the shortfall,
   * the moment a player's client receives its FIRST gameTableState after
   * creating or joining -- including the creator themselves. Only fires
   * at that one moment (the caller only invokes this when
   * `isFirstGameTableState` was true) -- it deliberately does not re-trigger
   * later if the player's stack drops below the suggestion during play.
   * Freely editable/dismissable; declining does nothing further.
   */
  function maybeShowSuggestedBuyInPrompt(gameTable) {
    if (typeof gameTable.suggestedBuyIn !== 'number' || gameTable.suggestedBuyIn <= 0) return;
    const me = gameTable.players.find((p) => p.id === state.playerId);
    if (!me || me.chips >= gameTable.suggestedBuyIn) return;
    el.buyAmountInput.value = gameTable.suggestedBuyIn - me.chips;
    el.buyDialog.showModal();
  }

  // ---- lobby actions ----

  /**
   * NEW 11.3 (Part B.2): used by each lobby button so a click that has
   * to wait for a fresh connection shows "Connecting…" immediately,
   * rather than the button appearing to do nothing.
   */
  function sendFromLobbyButton(button, type, payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      markLobbyButtonConnecting(button);
    }
    send(type, payload);
  }

  el.btnCreateGameTable.addEventListener('click', () => {
    hideLobbyError();
    const payload = { playerName: el.createName.value };
    const tableName = el.createTableName.value.trim();
    if (tableName) payload.tableName = tableName;
    const suggestedBuyin = el.createSuggestedBuyin.value.trim();
    if (suggestedBuyin) payload.suggestedBuyIn = parseInt(suggestedBuyin, 10);
    sendFromLobbyButton(el.btnCreateGameTable, 'createGameTable', payload);
  });

  el.btnJoinGameTable.addEventListener('click', () => {
    hideLobbyError();
    const code = el.joinCode.value.trim();
    if (!code) {
      showLobbyError('Enter a table code to join.');
      return;
    }
    sendFromLobbyButton(el.btnJoinGameTable, 'joinGameTable', { gameTableCode: code, playerName: el.joinName.value });
  });

  // NEW 11.0 (Part D): the "Re-Join a Table" path -- same wire message
  // whether the code came from typing here or from a `?rejoin=` URL
  // param (see maybeAutoFillRejoinFromUrl() below).
  el.btnRejoinGameTable.addEventListener('click', () => {
    hideLobbyError();
    const code = el.rejoinCode.value.trim();
    const tableCode = el.rejoinTableCode.value.trim();
    if (!code || !tableCode) {
      showLobbyError('Enter both your reconnect code and the table code.');
      return;
    }
    sendFromLobbyButton(el.btnRejoinGameTable, 'reconnectToGameTable', { gameTableCode: tableCode, code });
  });

  /**
   * NEW 11.0 (Part D): a secondary convenience for anyone who bookmarked
   * or texted themselves a direct link -- `?rejoin=CODE&table=TABLECODE`,
   * read once on page load. Both entry methods check the same code
   * server-side; this just pre-fills (and auto-submits) the same form
   * the person could otherwise type into by hand.
   */
  function maybeAutoFillRejoinFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('rejoin');
    const tableCode = params.get('table');
    if (!code) return;
    el.rejoinCode.value = code.trim().toUpperCase();
    if (tableCode) el.rejoinTableCode.value = tableCode.trim().toUpperCase();
    if (code && tableCode) state.autoRejoinPending = true; // submitted once the socket opens -- see connect()
  }

  [el.createName, el.joinCode, el.joinName].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        (input === el.createName ? el.btnCreateGameTable : el.btnJoinGameTable).click();
      }
    });
  });

  function showLobbyError(message) {
    el.lobbyError.textContent = message;
    el.lobbyError.hidden = false;
  }
  function hideLobbyError() {
    el.lobbyError.hidden = true;
  }

  /**
   * NEW 11.1 (Fix 2): app-styled replacement for window.confirm(), used
   * at every site the native browser confirm used to appear (nine of
   * them, per the spec) -- no native confirm() left anywhere in the app
   * after this. Returns a Promise<boolean>: true if the affirmative
   * button was clicked, false for Cancel, Escape, or any other
   * dismissal. Labels are customizable since a couple of call sites are
   * a genuine two-option choice (e.g. "Fold Now" vs "Wait Until Cycle
   * Closes"), not a plain destructive yes/no.
   */
  function appConfirm(message, { confirmLabel = 'Confirm', cancelLabel = 'Cancel' } = {}) {
    return new Promise((resolve) => {
      el.appConfirmMessage.textContent = message;
      el.btnAppConfirmOk.textContent = confirmLabel;
      el.btnAppConfirmCancel.textContent = cancelLabel;
      let settled = false;
      function cleanup(result) {
        if (settled) return;
        settled = true;
        el.btnAppConfirmOk.removeEventListener('click', onOk);
        el.btnAppConfirmCancel.removeEventListener('click', onCancel);
        el.appConfirmDialog.removeEventListener('close', onClose);
        if (el.appConfirmDialog.open) el.appConfirmDialog.close();
        resolve(result);
      }
      function onOk() {
        cleanup(true);
      }
      function onCancel() {
        cleanup(false);
      }
      function onClose() {
        cleanup(false); // Escape, or any other native close path -- treated the same as Cancel
      }
      el.btnAppConfirmOk.addEventListener('click', onOk);
      el.btnAppConfirmCancel.addEventListener('click', onCancel);
      el.appConfirmDialog.addEventListener('close', onClose);
      el.appConfirmDialog.showModal();
    });
  }

  // ---- table actions ----

  el.btnDeal.addEventListener('click', () => {
    hideTableError();
    // CHANGED 7.1 (§10.6): for Draw/Hold'em/Stud, the count is no longer
    // editable -- it's fully determined by the active preset (and, for
    // Stud, the current street), computed during render and stashed on
    // the button itself. The flexible-toolbox path (no profile at all)
    // is the one remaining case where the input stays live -- there's no
    // preset to determine a count for a gameTable with no Game Choice.
    const auto = el.btnDeal.dataset.autoCount;
    const n = auto !== undefined ? parseInt(auto, 10) : parseInt(el.cardsPerPlayer.value, 10);
    // RETIRED 7.2 (§6.8): the face-up/face-down override is gone -- each
    // street's pattern is already fully determined by the active preset,
    // same reasoning that already retired the cards-per-player override.
    send('deal', { cardsPerPlayer: n });
  });

  el.btnReshuffle.addEventListener('click', () => {
    hideTableError();
    send('reshuffle');
  });

  el.btnAdvanceTurn.addEventListener('click', () => {
    hideTableError();
    send('advanceTurn');
  });

  el.btnBurn.addEventListener('click', () => {
    hideTableError();
    send('burn');
  });

  el.btnRabbitHunt.addEventListener('click', () => {
    hideTableError();
    send('rabbitHunt');
  });

  el.btnNewHand.addEventListener('click', () => {
    hideTableError();
    // NEW 8.1 (§6.9): Kill Hand reuses the exact same `newHand` action --
    // the only difference is a confirmation step first, gated by whether
    // the button is CURRENTLY in its restyled state (set during render,
    // see renderPhaseGatedRail's newHandView handling above).
    const killCard = el.btnNewHand.dataset.killCard;
    if (killCard) {
      el.killHandDialogText.textContent = `Kill this hand because the ${formatKillCardName(killCard)} appeared? This cannot be undone \u2014 the pot carries over to a new hand.`;
      el.killHandDialog.showModal();
      // NEW 8.2 (§6.9): signals every OTHER player with a table-wide
      // notice the instant this dialog opens, before anything's actually
      // confirmed -- see renderKillHandNotice() for how they see it.
      send('killHandStartConfirm');
      return;
    }
    send('newHand');
  });

  el.btnKillHandCancel.addEventListener('click', () => {
    el.killHandDialog.close();
    send('killHandCancelConfirm'); // NEW 8.2 -- clears the table-wide notice; "no other indication anything was attempted"
  });

  el.btnKillHandConfirm.addEventListener('click', () => {
    el.killHandDialog.close();
    hideTableError();
    send('newHand'); // newHand() itself clears killHandConfirmPending server-side as a side effect
  });

  // NEW 8.1 (§5.10 extension): these dialogs are opened automatically by
  // renderDealInterrupt(), never by a button click -- Fold (the other
  // half of Pay-or-Fold) reuses the ordinary Fold button/action, not a
  // dedicated button here, per spec ("the existing Fold primitive,
  // unchanged").
  el.btnDealInterruptPay.addEventListener('click', () => {
    hideTableError();
    send('payDealInterrupt');
  });
  el.btnDealInterruptFold.addEventListener('click', () => {
    hideTableError();
    send('fold');
  });
  el.btnDealInterruptBuy.addEventListener('click', () => {
    hideTableError();
    send('buyDealInterrupt');
  });
  el.btnDealInterruptDecline.addEventListener('click', () => {
    hideTableError();
    send('declineDealInterrupt');
  });

  // NEW 4.4 §5.2: "All Players" (the ALL_PLAYERS_VALUE sentinel, an
  // empty string) disables the count override -- Auto always means each
  // eligible player's own individually correct count in that mode, never
  // a single shared number, to avoid over-dealing someone who discarded
  // fewer cards than others.
  el.dealTargetSelect.addEventListener('change', () => {
    const isAllPlayers = el.dealTargetSelect.value === ALL_PLAYERS_VALUE;
    el.dealTargetCount.disabled = isAllPlayers;
    if (isAllPlayers) el.dealTargetCount.value = '';
  });

  el.btnDealToPlayer.addEventListener('click', () => {
    hideTableError();
    // NEW 5.1 (§5.2): Draw is a single button -- always deals to every
    // player who needs cards, ignoring the dropdown entirely (it's
    // hidden and not populated for Draw, so its .value would be stale).
    if (state.lastGameTable?.profile === 'draw') {
      send('dealToPlayer', { allPlayers: true });
      return;
    }
    const targetPlayerId = el.dealTargetSelect.value;
    if (targetPlayerId === ALL_PLAYERS_VALUE) {
      send('dealToPlayer', { allPlayers: true });
      return;
    }
    const payload = { targetPlayerId };
    const countRaw = el.dealTargetCount.value.trim();
    if (countRaw !== '') payload.count = parseInt(countRaw, 10);
    send('dealToPlayer', payload);
    el.dealTargetCount.value = '';
  });

  el.btnDealCommunity.addEventListener('click', () => {
    hideTableError();
    const payload = {};
    const countRaw = el.dealCommunityCount.value.trim();
    if (countRaw !== '') payload.count = parseInt(countRaw, 10);
    send('dealCommunity', payload);
    el.dealCommunityCount.value = '';
  });

  // CHANGED 5.0 §6.3: no longer accepts a target at all -- pure "next
  // active seat," full stop. Click repeatedly to skip further if needed.
  el.btnPassBuck.addEventListener('click', () => {
    hideTableError();
    send('passTheBuck');
  });

  el.btnOpenBetting.addEventListener('click', () => {
    hideTableError();
    send('openBetting');
  });

  // NEW 7.0 (§6.8): fires immediately on selection -- no separate confirm
  // button, matching the spec's "a dropdown... defaulting to null"
  // framing. An empty selection (back to the blank option) is simply
  // ignored client-side; there's no meaningful "un-select" action to send.
  el.openingBettorSelect.addEventListener('change', () => {
    hideTableError();
    const playerId = el.openingBettorSelect.value;
    if (!playerId) return;
    send('setOpeningBettor', { playerId });
  });

  el.btnSetAnte.addEventListener('click', () => {
    hideTableError();
    const playerId = el.anteTargetSelect.value;
    const amount = parseInt(el.anteAmount.value, 10);
    if (!playerId) return;
    if (!Number.isInteger(amount) || amount < 0) {
      showTableError('Enter a non-negative whole-dollar ante/blind amount.');
      return;
    }
    send('setAnteBlind', { playerId, amount });
    el.anteAmount.value = '';
  });

  // NEW 10.4 (B.2 replacement / 10.4 Completion Gap 2): a genuine
  // emergency-bail-out action, not a routine one -- a confirm() gut
  // check, matching Terminate/Restore's own pattern, rather than firing
  // silently on a single click.
  el.btnMisdeal.addEventListener('click', async () => {
    if (!(await appConfirm('Misdeal this hand? A seated player owes more than they have and can never post.'))) return;
    send('misdealStuckAntes');
  });

  // CHANGED 5.0 §10.2: the box now means "raise BY this much," not
  // "raise TO this total." The actual amount sent to placeBet (which
  // still expects an absolute total, unchanged server-side) is computed
  // as currentBetToCall + entered. When currentBetToCall is 0 (the
  // opening-bet case), this collapses to exactly what was typed, so
  // "Bet" needs no separate handling.
  el.btnPlaceBet.addEventListener('click', () => {
    hideTableError();
    // NEW 9.2 (§6.10, §10.2): Fixed-Limit has no text box at all -- the
    // amount is exactly one deterministic value, precomputed at render
    // time and stashed on the button itself (see renderBettingRail).
    const fixedAmount = el.btnPlaceBet.dataset.fixedAmount;
    let amount;
    if (fixedAmount) {
      amount = parseInt(fixedAmount, 10);
    } else {
      // CHANGED 9.2 (§6.10, §10.2), REVERSED from 5.0: the box now asks
      // for the total ("Raise To") again, not an increment -- the
      // shared betting-rail figures already show what's owed, so
      // there's no remaining mental-math reason to keep them split.
      const entered = parseInt(el.betAmount.value, 10);
      if (!Number.isInteger(entered) || entered <= 0) {
        showTableError('Enter an amount greater than zero.');
        return;
      }
      amount = entered;
    }
    el.btnPlaceBet.disabled = true;
    state.pendingGuardedButton = el.btnPlaceBet; // NEW 9.2 (§6.6) -- explicit re-enable on rejection, see the dealError handler
    send('placeBet', { amount });
  });

  el.btnCall.addEventListener('click', () => {
    hideTableError();
    el.btnCall.disabled = true;
    state.pendingGuardedButton = el.btnCall; // NEW 9.2 (§6.6)
    send('call');
  });

  el.btnCheck.addEventListener('click', () => {
    hideTableError();
    el.btnCheck.disabled = true;
    state.pendingGuardedButton = el.btnCheck; // NEW 9.2 (§6.6)
    send('check');
  });

  el.btnFold.addEventListener('click', () => {
    hideTableError();
    el.btnFold.disabled = true;
    state.pendingGuardedButton = el.btnFold; // NEW 9.2 (§6.6)
    send('fold');
  });

  // NEW 9.0 (§6.11): confirmation-gated, same chip-dialog pattern as Kill
  // Hand -- given this is plausibly the single highest-stakes, most
  // irreversible click in the app.
  el.btnAllIn.addEventListener('click', async () => {
    hideTableError();
    const gameTable = state.lastGameTable;
    const me = gameTable?.players.find((p) => p.id === state.playerId);
    if (!me) return;
    // NEW 11.5 (Part C): a generic (not hand-aware -- this app never
    // judges hand strength, by design) warning shown only in a
    // ReAnteable game, gating in front of the existing All-In dialog
    // below rather than replacing or changing it. If 3+ players are
    // already all-in and this hand doesn't reach a conclusion, a new
    // hand can be dealt mid-cycle and a Player who committed everything
    // here would have nothing left to cover its ante -- excluded from
    // that deal per the existing dealing-eligibility rules. The app
    // can't know whether THIS particular All-In is actually safe, so
    // this leaves the judgment call to the Player rather than trying to
    // be smart about it.
    if (gameTable?.reAnteable) {
      const proceed = await appConfirm(
        "This is a re-ante game \u2014 if this hand doesn't reach a conclusion, a new hand may be dealt and you won't have enough chips to cover the new ante. You'll be excluded from that deal if it happens. Go All-In anyway?",
        { confirmLabel: 'Go All-In', cancelLabel: 'Cancel' }
      );
      if (!proceed) return;
    }
    el.allInDialogText.textContent = `Commit your entire remaining stack ($${me.chips}) to this hand. This cannot be undone.`;
    el.allInDialog.showModal();
  });
  el.btnAllInCancel.addEventListener('click', () => el.allInDialog.close());
  el.btnAllInConfirm.addEventListener('click', () => {
    el.allInDialog.close();
    el.btnAllIn.disabled = true;
    send('allIn');
  });

  el.btnPostAnte.addEventListener('click', () => {
    hideTableError();
    send('postAnteBlind');
  });

  el.btnDiscard.addEventListener('click', () => {
    hideTableError();
    if (state.discardSelection.size === 0) return;
    send('discard', { cardIds: [...state.discardSelection] });
    state.discardSelection.clear();
  });

  el.btnStandPat.addEventListener('click', () => {
    hideTableError();
    state.discardSelection.clear();
    send('standPat');
  });

  // NEW 8.1 (§5.11), GENERALIZED 8.2 -- generic 'a'/'b' values now, not
  // literal 'high'/'low' (Chicago's split was never actually High/Low).
  el.btnDeclareA.addEventListener('click', () => {
    hideTableError();
    send('declare', { value: 'a' });
  });
  el.btnDeclareB.addEventListener('click', () => {
    hideTableError();
    send('declare', { value: 'b' });
  });
  el.btnDeclareBoth.addEventListener('click', () => {
    hideTableError();
    send('declare', { value: 'both' });
  });

  el.btnApproveClaim.addEventListener('click', () => {
    hideTableError();
    send('resolveClaim', { approve: true });
  });

  el.btnRejectClaim.addEventListener('click', () => {
    hideTableError();
    send('resolveClaim', { approve: false });
  });

  function showTableError(message) {
    el.tableError.textContent = message;
    el.tableError.hidden = false;
  }
  function hideTableError() {
    el.tableError.hidden = true;
  }

  /**
   * NEW 8.1 (§5.10 extension): the "brief, non-blocking table
   * announcement" spec calls for when a Free-price deal interrupt
   * auto-resolves. Auto-dismisses after a few seconds rather than
   * requiring a click -- it's a courtesy notice, not something blocking
   * or requiring acknowledgment (unlike every dialog in this app, which
   * all require an explicit click to close). A second announcement
   * arriving while one is still showing simply replaces it and restarts
   * the timer, rather than queuing -- these are meant to be read in
   * passing, not stacked up.
   */
  let announcementTimer = null;
  function showTableAnnouncement(text, kind) {
    el.tableAnnouncement.textContent = text;
    el.tableAnnouncement.hidden = false;
    // NEW 9.0 (§6.11): All-In gets a visually distinct, "louder" treatment
    // than the routine Baseball-interrupt notices this banner otherwise
    // shows -- meant to land as a genuine moment, per spec. Toggled via
    // classList rather than a separate element, so every other call site
    // (unchanged, kind undefined) keeps its existing plain styling.
    el.tableAnnouncement.classList.toggle('is-allin', kind === 'allin');
    if (announcementTimer) clearTimeout(announcementTimer);
    announcementTimer = setTimeout(
      () => {
        el.tableAnnouncement.hidden = true;
        el.tableAnnouncement.classList.remove('is-allin');
        announcementTimer = null;
      },
      kind === 'allin' ? 6000 : 5000 // NEW 9.0: lingers a beat longer -- a bigger moment than a routine table notice
    );
  }

  // ---- Buy Chips dialog (v3.2: plain amount, no denominations) ----

  el.btnOpenBuyDialog.addEventListener('click', () => {
    hideTableError();
    el.buyAmountInput.value = '';
    el.buyDialog.showModal();
    el.buyAmountInput.focus();
  });
  el.btnBuyCancel.addEventListener('click', () => el.buyDialog.close());
  el.btnBuyConfirm.addEventListener('click', () => {
    const amount = parseInt(el.buyAmountInput.value, 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      showTableError('Enter a buy-in amount greater than zero.');
      return;
    }
    send('buyChips', { amount });
    el.buyDialog.close();
  });

  // ---- Suggested Buy-In editor (NEW 4.5 §10.1) ----
  // CHANGED 6.2 (§10.2 item 5): the header entry point (btnEditSuggestedBuyin)
  // is removed -- underlying dialog/Save/Cancel logic below stays dormant,
  // ready for a future Table/Game Management interface to trigger it.
  el.btnSuggestedBuyinCancel.addEventListener('click', () => el.suggestedBuyinDialog.close());
  el.btnSuggestedBuyinSave.addEventListener('click', () => {
    hideTableError();
    const raw = el.suggestedBuyinInput.value.trim();
    const amount = raw === '' ? null : parseInt(raw, 10);
    if (amount !== null && (!Number.isInteger(amount) || amount < 0)) {
      showTableError('Enter a non-negative whole number, or leave it blank to turn the suggestion off.');
      return;
    }
    send('setSuggestedBuyIn', { amount });
    el.suggestedBuyinDialog.close();
  });

  // ---- Sit Out / Sit In (spec §9) ----

  /**
   * CHANGED 5.1: simplified to a direct `!gameTable.idle` check -- idle is now
   * a precisely-maintained signal for Draw (PreGame/CycleComplete only)
   * and remains the old independently-triggered flag for every other
   * profile, either way a more accurate "is a hand actually in progress"
   * test than the previous ad-hoc bettingOpen/handCount heuristic.
   */
  function isMidHand(gameTable, me) {
    return !!me && !gameTable.idle;
  }

  // NEW 9.2 (§10.2): click-to-toggle, deliberately not hover-to-reveal
  // (undiscoverable, and unreliable for a panel a player needs to click
  // inside -- a drifting mouse could snap it shut mid-click on Buy Chips
  // or Sit Out). Purely local UI state -- not synced to the server, not
  // persisted across reconnects, matching "have they seen the control
  // this time at this table," not a permanent onboarding flag.
  el.btnPlayerRailToggle.addEventListener('click', () => {
    state.playerRailCollapsed = !state.playerRailCollapsed;
    el.playerRail.classList.toggle('is-collapsed', state.playerRailCollapsed);
    // BUG FIX 9.3 (§10.2): the 9.2 build only ever changed the rail's
    // OWN width, which does nothing to `.table-body`'s fixed 3-column
    // grid track sizing (`190px 1fr 190px`) -- the middle `1fr` track
    // never grew, so nothing was actually reclaimed, just an empty gap
    // where the rail's content used to be. Toggling this class on the
    // grid CONTAINER itself (not just the rail) is what actually shrinks
    // the left track and lets the middle track expand into the freed
    // space -- see .table-body.rail-collapsed in style.css.
    el.tableBody.classList.toggle('rail-collapsed', state.playerRailCollapsed);
    el.btnPlayerRailToggle.setAttribute('aria-expanded', String(!state.playerRailCollapsed));
    el.btnPlayerRailToggle.textContent = state.playerRailCollapsed ? '\u203a' : '\u2039';
    clearPlayerRailHint(); // clicking it is itself one of the two ways the one-time hint clears
  });

  function clearPlayerRailHint() {
    el.btnPlayerRailToggle.classList.remove('has-hint');
  }

  el.btnSitToggle.addEventListener('click', () => {
    hideTableError();
    const me = state.lastGameTable?.players.find((p) => p.id === state.playerId);
    if (!me) return;

    if (me.sittingOut) {
      if (me.sitInPending) return; // v4.2: already queued, button is disabled anyway
      send('sitIn');
      return;
    }
    if (isMidHand(state.lastGameTable, me)) {
      // NEW 5.1 (§9): context-aware -- an already-folded player has
      // nothing left to fold, so "Fold and Sit Out" (functionally a
      // no-op fold, still correct/harmless server-side) is relabeled
      // "Confirm Sit Out" and "Sit Out Next Game" is hidden entirely,
      // since there's no remaining decision this hand to defer.
      if (me.folded) {
        el.sitoutDialogHint.textContent = "You've folded this hand. Sit out now?";
        el.btnSitoutFold.textContent = 'Confirm Sit Out';
        el.btnSitoutFold.title = 'Sit out immediately';
        el.btnSitoutNext.hidden = true;
      } else {
        el.sitoutDialogHint.textContent = "You're mid-hand. What would you like to do?";
        el.btnSitoutFold.textContent = 'Fold and Sit Out';
        el.btnSitoutFold.title = 'Fold this hand and sit out immediately';
        el.btnSitoutNext.hidden = false;
      }
      el.sitoutDialog.showModal();
    } else {
      send('sitOut', { mode: 'foldAndSitOut' });
    }
  });

  el.btnSitoutFold.addEventListener('click', () => {
    send('sitOut', { mode: 'foldAndSitOut' });
    el.sitoutDialog.close();
  });
  el.btnSitoutNext.addEventListener('click', () => {
    send('sitOut', { mode: 'sitOutNextGame' });
    el.sitoutDialog.close();
  });
  el.btnSitoutCancel.addEventListener('click', () => el.sitoutDialog.close());

  // ---- Leave Table (NEW 11.0, the-cut-spec_v11-0.md Part F.1) ----

  el.btnLeaveTable.addEventListener('click', async () => {
    hideTableError();
    const me = state.lastGameTable?.players.find((p) => p.id === state.playerId);
    if (!me) return;
    if (me.pending) {
      // FIXED (11.0 review finding #1): the chip-loss/immediate-fold
      // consequence now lives in the dialog's own static HTML body text
      // (#leave-table-dialog-hint / #leave-table-dialog-consequence),
      // not just a button tooltip -- no need to set it here.
      el.leaveTableDialog.showModal();
    } else {
      if (!(await appConfirm('Leave the table? Your chips will be lost.'))) return;
      send('leaveTable', { mode: 'foldAndLeave' }); // mode ignored server-side -- no pending stake
    }
  });
  el.btnLeaveFold.addEventListener('click', () => {
    send('leaveTable', { mode: 'foldAndLeave' });
    el.leaveTableDialog.close();
  });
  el.btnLeaveAtCycleClose.addEventListener('click', () => {
    send('leaveTable', { mode: 'leaveAtCycleClose' });
    el.leaveTableDialog.close();
  });
  el.btnLeaveCancel.addEventListener('click', () => el.leaveTableDialog.close());

  // ---- Game Rules modal (v4.0 §10.3) ----

  el.btnOpenRulesDialog.addEventListener('click', () => {
    buildRulesIndex();
    el.rulesDialog.showModal();
    const activeId = state.lastGameTable?.gameChoiceId;
    const target = activeId
      ? el.rulesIndex.querySelector(`[data-game-choice-id="${activeId}"]`)
      : el.rulesIndex.firstElementChild;
    if (target) target.scrollIntoView({ block: 'start' });
  });
  el.btnRulesClose.addEventListener('click', () => el.rulesDialog.close());

  function buildRulesIndex() {
    const activeId = state.lastGameTable?.gameChoiceId;
    el.rulesIndex.innerHTML = '';
    const profileLabel = { draw: 'Draw', stud: 'Stud', holdem: "Hold'em" };
    for (const choice of state.gameChoices) {
      const entry = document.createElement('div');
      entry.className = 'rules-entry' + (choice.id === activeId ? ' is-active' : '');
      entry.dataset.gameChoiceId = choice.id;

      const heading = document.createElement('h4');
      heading.textContent = choice.displayName;

      const profileTag = document.createElement('p');
      profileTag.className = 'rules-entry-profile';
      profileTag.textContent = profileLabel[choice.profile] || choice.profile;

      const rulesText = document.createElement('p');
      rulesText.textContent = choice.rules;

      entry.append(heading, profileTag, rulesText);
      el.rulesIndex.appendChild(entry);
    }
  }

  // ---- Select Game Choice modal (NEW 4.1 -- replaces the old inline dropdown) ----

  el.btnOpenSelectDialog.addEventListener('click', () => {
    if (!state.lastGameTable?.idle) return; // button is also disabled in this state; belt and suspenders
    buildSelectIndex();
    el.selectDialog.showModal();
  });
  el.btnSelectClose.addEventListener('click', () => el.selectDialog.close());

  function buildSelectIndex() {
    const activeId = state.lastGameTable?.gameChoiceId;
    const activeProfile = state.gameChoices.find((g) => g.id === activeId)?.profile;
    el.selectIndex.innerHTML = '';
    const groups = { draw: 'Draw', stud: 'Stud', holdem: "Hold'em" };
    for (const [profileKey, label] of Object.entries(groups)) {
      const presets = state.gameChoices.filter((g) => g.profile === profileKey);
      if (presets.length === 0) continue;

      const presetList = document.createElement('div');
      presetList.className = 'select-group-list';
      const startExpanded = profileKey === activeProfile;
      presetList.hidden = !startExpanded;

      const groupLabel = document.createElement('button');
      groupLabel.type = 'button';
      groupLabel.className = 'select-group-label' + (startExpanded ? ' is-expanded' : '');
      groupLabel.textContent = label;
      groupLabel.setAttribute('aria-expanded', String(startExpanded));
      groupLabel.addEventListener('click', () => {
        const nowExpanded = presetList.hidden; // about to toggle open
        presetList.hidden = !nowExpanded;
        groupLabel.classList.toggle('is-expanded', nowExpanded);
        groupLabel.setAttribute('aria-expanded', String(nowExpanded));
      });
      el.selectIndex.appendChild(groupLabel);

      for (const preset of presets) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'select-entry' + (preset.id === activeId ? ' is-active' : '');
        button.title = preset.description; // full description still available on hover
        button.textContent = preset.displayName; // v4.2: one line per game, no description sub-line
        button.addEventListener('click', () => {
          hideTableError();
          state.pendingAutoOpenOptions = true; // Select auto-opens Options once this lands (§10.4)
          send('setGameChoice', { gameChoiceId: preset.id });
          el.selectDialog.close();
        });
        presetList.appendChild(button);
      }
      el.selectIndex.appendChild(presetList);
    }
  }

  // ---- Options modal: visible to everyone, editable by the Dealer only.
  // CHANGED 4.3 (§10.5): single button, label/behavior depends on viewer + idle. ----

  /**
   * NEW 7.0 (§14 "7+ player warning"): client-side-only courtesy prompt,
   * checked at the moment the Dealer actually starts the hand (not at
   * Select time -- seat count can change in between). Real 7-Card Stud
   * can run out of cards with too many players seated. If the condition
   * doesn't apply, sends startGame immediately, same as before; if it
   * does, shows the confirm dialog and defers the actual send until
   * "Start Anyway" is clicked.
   */
  function startGameWithStudWarning() {
    const gameTable = state.lastGameTable;
    const seatedCount = gameTable?.players?.length || 0;
    if (gameTable?.profile === 'stud' && gameTable?.finalStreet === 'E' && seatedCount >= 7) {
      el.studWarningDialog.showModal();
      return;
    }
    hideTableError();
    send('startGame');
  }

  el.btnStudWarningCancel.addEventListener('click', () => {
    el.studWarningDialog.close();
  });

  el.btnStudWarningStart.addEventListener('click', () => {
    el.studWarningDialog.close();
    hideTableError();
    send('startGame');
  });

  el.btnOpenOptionsDialog.addEventListener('click', () => {
    if (!state.lastGameTable?.gameOptions) return;
    renderOptionsDialogFields(state.lastGameTable, isViewerDealer(state.lastGameTable));
    el.optionsDialog.showModal();
  });

  // NEW 8.2 (§10.5): opens the EXACT SAME Game Rules modal the Game
  // Rail's own Game Rules button already opens (§10.4) -- not a second,
  // separate modal -- scrolled to the currently active preset, same
  // behavior as the Game Rail's button. A stateless trigger; Options'
  // own dialog stays open underneath (both are <dialog> elements, so
  // this one simply layers on top).
  el.btnOptionsRules.addEventListener('click', () => {
    buildRulesIndex();
    el.rulesDialog.showModal();
    const activeId = state.lastGameTable?.gameChoiceId;
    const target = activeId
      ? el.rulesIndex.querySelector(`[data-game-choice-id="${activeId}"]`)
      : el.rulesIndex.firstElementChild;
    if (target) target.scrollIntoView({ block: 'start' });
  });

  el.btnOptionsConfirm.addEventListener('click', () => {
    const gameTable = state.lastGameTable;
    const isDealerAndIdle = !!gameTable && isViewerDealer(gameTable) && gameTable.idle;
    if (isDealerAndIdle) {
      startGameWithStudWarning();
    }
    el.optionsDialog.close();
  });

  // NEW 10.4 (the-cut-spec_v10-4.md Part C): closes Options and reopens
  // Select Game Choice, letting the Dealer pick a different game --
  // reuses the exact same, already-safe open path btnOpenSelectDialog
  // itself uses. No new server-side logic: setGameChoice() already
  // supports being called again at any time while idle, and nothing is
  // committed by merely having viewed Options -- the hand only actually
  // begins on the separate, explicit Start action.
  el.btnOptionsCancel.addEventListener('click', () => {
    el.optionsDialog.close();
    buildSelectIndex();
    el.selectDialog.showModal();
  });

  // NEW 4.4 §10.4: Same Game -- same startGame action as Options'
  // "Start" button, without reopening the Select/Options flow.
  el.btnSameGame.addEventListener('click', () => {
    startGameWithStudWarning();
  });

  function isViewerDealer(gameTable) {
    return !!gameTable.players.find((p) => p.id === state.playerId)?.isDealer;
  }

  // ---- Inactivity close warning (NEW 11.0, Part H.2) ----

  const INACTIVITY_BANNER_WINDOW_MS = 5 * 60 * 1000;
  const INACTIVITY_POPUP_WINDOW_MS = 60 * 1000;

  /**
   * Purely derived from gameTable.tableCloseAt -- the one fact the
   * server computes and exposes (Standing Convention). Ticks on its own
   * (see the setInterval below) rather than only re-running when a new
   * gameTableState happens to arrive, since the table could sit
   * perfectly idle -- no new broadcasts at all -- right through the
   * T-5/T-1 thresholds otherwise.
   */
  function renderInactivityWarning(gameTable) {
    if (!gameTable || typeof gameTable.tableCloseAt !== 'number') {
      el.inactivityBanner.hidden = true;
      if (el.inactivityPopup.open) el.inactivityPopup.close();
      return;
    }
    const msRemaining = gameTable.tableCloseAt - Date.now();
    const secondsRemaining = Math.max(0, Math.round(msRemaining / 1000));

    if (msRemaining > INACTIVITY_BANNER_WINDOW_MS) {
      el.inactivityBanner.hidden = true;
    } else {
      el.inactivityBanner.hidden = false;
      const minutes = Math.max(1, Math.ceil(secondsRemaining / 60));
      el.inactivityBanner.textContent = `This table will close in about ${minutes} minute${minutes === 1 ? '' : 's'} due to inactivity. Start a hand to keep it open.`;
    }

    const isOwner = gameTable.creatorId === state.playerId;
    if (isOwner && msRemaining <= INACTIVITY_POPUP_WINDOW_MS && msRemaining > 0) {
      el.inactivityPopupHint.textContent = `This table will close in ${secondsRemaining}s due to inactivity.`;
      if (!el.inactivityPopup.open) el.inactivityPopup.showModal();
    } else if (el.inactivityPopup.open && (msRemaining > INACTIVITY_POPUP_WINDOW_MS || msRemaining <= 0)) {
      // Real activity pushed tableCloseAt back out, or (for a non-owner,
      // or once time is actually up) the popup shouldn't be showing.
      el.inactivityPopup.close();
    }
  }

  el.btnRestartActivityClock.addEventListener('click', () => {
    send('restartActivityClock');
    el.inactivityPopup.close();
  });

  // Ticks independently of state broadcasts -- see renderInactivityWarning()'s
  // own comment for why relying only on new gameTableState messages
  // wouldn't reliably cross the T-5/T-1 thresholds on a truly idle table.
  // CHANGED 11.1 (Fix 3, Issue A): was 5000ms, which was fine for the
  // T-5 banner's coarse "about N minutes" wording but the wrong
  // granularity for the T-1 popup's own live per-second countdown text.
  // Dropped to 1000ms -- this is a pure re-render from already-known
  // state, no new network call, so the tighter tick costs nothing.
  setInterval(() => {
    if (state.lastGameTable) renderInactivityWarning(state.lastGameTable);
  }, 1000);

  /**
   * NEW 11.4 (Part B): a lightweight, dedicated 1s ticker for the
   * "Disconnected (Ns)" badge, mirroring the exact same pattern already
   * used for the reconnect dialog's own countdown
   * (renderReconnectDialog(), the-cut-spec_v11-3.md Part A.5) and the
   * inactivity banner/popup just above -- a pure text refresh from
   * already-known state (the deadline stashed on the element itself),
   * independent of server broadcast timing. Only touches badges
   * currently in the DOM; a no-op the overwhelming majority of the time
   * when nobody's disconnected.
   */
  function updateDisconnectedBadgeText(badgeEl) {
    const deadline = Number(badgeEl.dataset.disconnectDeadline);
    const name = badgeEl.dataset.playerName;
    const secondsLeft = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    badgeEl.title = `${name} disconnected -- the table will wait ${secondsLeft}s more before moving them to Sitting Out`;
    badgeEl.textContent = `Disconnected (${secondsLeft}s)`;
  }
  setInterval(() => {
    document.querySelectorAll('.seat-disconnected-badge').forEach(updateDisconnectedBadgeText);
  }, 1000);

  // ---- About modal (NEW 4.1 §10.7) ----

  el.btnOpenAboutDialog.addEventListener('click', () => {
    el.aboutBody.textContent = state.appInfo
      ? `Version ${state.appInfo.version} \u2014 built ${state.appInfo.buildDate}`
      : 'Version info unavailable.';
    el.aboutDialog.showModal();
  });
  el.btnAboutClose.addEventListener('click', () => el.aboutDialog.close());

  // ---- Table Owner Tools (NEW 10.4, the-cut-spec_v10-4.md Part A §5) ----

  el.btnOpenTableOwnerDialog.addEventListener('click', () => {
    el.tableOwnerDialog.showModal();
  });
  el.btnToClose.addEventListener('click', () => el.tableOwnerDialog.close());

  /**
   * FIXED 11.1 (v11.1 spec Fix 1). The "please stand by" banner
   * (`tableOwnerDistributionInProgress`, driven by `_pendingAllocationBatch`
   * being open) was only ever cleared by the explicit "Discard Batch"
   * button or a commit -- closing the dialog by any OTHER means (Escape,
   * or this dialog's own Close button) left a batch open indefinitely,
   * and the banner with it. The native `close` event fires for every one
   * of those paths uniformly (there's no backdrop-click-to-close
   * anywhere in this app to also worry about), so a single listener here
   * covers all of them: a batch should never outlive the dialog that
   * owns it. Harmless/no-op if nothing was ever staged (the server-side
   * discard handler already tolerates an empty batch).
   */
  el.tableOwnerDialog.addEventListener('close', () => {
    if (state.lastGameTable?.tableOwnerDistributionInProgress) {
      send('discardPotDistributionBatch');
    }
  });

  // Terminate/Restore are destructive, owner-only, one-shot actions --
  // an app-styled confirm() gut-check rather than a second custom dialog
  // layer, matching the emergency-tool nature of both (§1/§2's own
  // "genuine emergencies only" framing).
  el.btnToTerminate.addEventListener('click', async () => {
    if (!(await appConfirm('Force-end the current hand? The pot is left untouched.'))) return;
    send('terminateGameCleanly');
  });
  el.btnToRestore.addEventListener('click', async () => {
    if (!(await appConfirm('Restore every stack to the start of the current hand and clear the pot?'))) return;
    send('restorePlayerStacks');
  });

  el.btnToBeginDistribution.addEventListener('click', () => {
    send('beginPotDistribution');
  });
  el.btnToAllocAdd.addEventListener('click', () => {
    const playerId = el.toAllocPlayer.value;
    const direction = el.toAllocDirection.value;
    const amount = Number(el.toAllocAmount.value);
    if (!playerId || !Number.isInteger(amount) || amount <= 0) return;
    send('stageAllocation', { playerId, direction, amount });
    el.toAllocAmount.value = '';
  });
  el.btnToDiscardBatch.addEventListener('click', () => {
    send('discardPotDistributionBatch');
  });
  el.btnToCommitBatch.addEventListener('click', async () => {
    if (!(await appConfirm('Apply this entire batch now? This cannot be undone.'))) return;
    send('commitPotDistribution');
  });

  // ---- Table Owner Settings (NEW 11.0, the-cut-spec_v11-0.md Part B/D) ----

  el.btnOpenSettingsDialog.addEventListener('click', () => {
    if (state.lastGameTable) renderSettingsDialog(state.lastGameTable);
    el.settingsDialog.showModal();
  });
  el.btnSettingsClose.addEventListener('click', () => el.settingsDialog.close());
  el.btnSettingsSaveTimeout.addEventListener('click', () => {
    const seconds = Number(el.settingsReconnectTimeout.value);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    send('setReconnectTimeout', { seconds });
  });

  /**
   * NEW 11.0 (Part B/D): populates the current reconnect timeout and the
   * live reconnect-code list. `gameTable.reconnectCodes` is only ever
   * populated (non-null) when this client IS the Table Owner -- the
   * server never sends it to anyone else -- so this renders an empty
   * list rather than erroring for any caller that isn't the Table Owner
   * (the dialog itself is only reachable via the TO-only rail button
   * anyway, but this stays defensive regardless).
   */
  function renderSettingsDialog(gameTable) {
    el.settingsReconnectTimeout.value = gameTable.reconnectTimeoutSeconds;
    el.settingsReconnectCodes.innerHTML = '';
    const codes = gameTable.reconnectCodes || {};
    for (const player of gameTable.players) {
      const row = document.createElement('p');
      row.className = 'to-section-hint';
      row.textContent = `${player.name}: ${codes[player.id] || '\u2014'}`;
      el.settingsReconnectCodes.appendChild(row);
    }
  }

  // ---- Table Owner Testing (NEW 11.1, the-cut-spec_v11-1.md) ----

  el.btnOpenTestingDialog.addEventListener('click', () => {
    if (state.lastGameTable) renderTestingDialog(state.lastGameTable);
    el.testingDialog.showModal();
  });
  el.btnTestingClose.addEventListener('click', () => el.testingDialog.close());

  el.btnTestingForceDisconnect.addEventListener('click', () => {
    const targetPlayerId = el.testingForceDisconnectSelect.value;
    if (!targetPlayerId) return;
    send('forceDisconnectPlayer', { targetPlayerId });
  });

  el.btnTestingForceInactivity.addEventListener('click', () => {
    send('forceInactivityWarning');
  });

  /**
   * NEW 11.1: populates the Force Disconnect dropdown with every
   * currently-connected seated player (the Table Owner's own seat
   * included, per the spec's literal "any currently-connected, seated
   * player" -- not excluded, since testing one's own reconnect flow is
   * itself a legitimate use). Rebuilt each render, same simple-rebuild
   * justification as toAllocPlayer's/toRemovePlayerSelect's own comments.
   */
  function renderTestingDialog(gameTable) {
    const previousSelection = el.testingForceDisconnectSelect.value;
    el.testingForceDisconnectSelect.innerHTML = '';
    for (const player of gameTable.players) {
      if (player.connected === false) continue;
      const option = document.createElement('option');
      option.value = player.id;
      option.textContent = player.name;
      el.testingForceDisconnectSelect.appendChild(option);
    }
    if ([...el.testingForceDisconnectSelect.options].some((o) => o.value === previousSelection)) {
      el.testingForceDisconnectSelect.value = previousSelection;
    }
    el.btnTestingForceDisconnect.disabled = el.testingForceDisconnectSelect.options.length === 0;
  }

  // ---- Remove Player / End Game (NEW 11.0, the-cut-spec_v11-0.md Part F.2/F.6) ----

  el.btnToRemovePlayer.addEventListener('click', async () => {
    const targetPlayerId = el.toRemovePlayerSelect.value;
    if (!targetPlayerId) return;
    const gameTable = state.lastGameTable;
    const target = gameTable?.players.find((p) => p.id === targetPlayerId);
    if (!target) return;
    if (target.pending) {
      // Mirrors Leave Table's own choice, decided by the Table Owner on
      // the target Player's behalf since they aren't the one clicking.
      // Genuine two-option choice, not a plain destructive yes/no --
      // appConfirm()'s customizable labels replace what Cancel/OK used
      // to mean implicitly under window.confirm().
      const foldNow = await appConfirm(
        `${target.name} has a pending stake in the current hand. Fold them and remove them now (forfeiting their stake), or remove them once the current cycle closes instead (their hand stays live until then)?`,
        { confirmLabel: 'Fold and Remove Now', cancelLabel: 'Remove After This Cycle' }
      );
      send('removePlayerFromTable', { targetPlayerId, mode: foldNow ? 'foldAndLeave' : 'leaveAtCycleClose' });
      return;
    }
    if (!(await appConfirm(`Remove ${target.name} from the table?`))) return;
    send('removePlayerFromTable', { targetPlayerId, mode: 'foldAndLeave' });
  });

  el.btnToEndGame.addEventListener('click', async () => {
    if (!(await appConfirm('End this table for everyone? Every player will be disconnected and the table will cease to exist. This cannot be undone.'))) return;
    send('endGame');
  });

  // ---- Claim Pot builder (split pots, spec §6.2; multi-pot NEW 9.0 §6.10) ----

  /** NEW 9.0 (§6.10): mirrors the server's _currentClaimablePot() -- the highest-id unclaimed pot, or null in the ordinary single-pot case. */
  function currentClaimablePot(gameTable) {
    if (!Array.isArray(gameTable.pots) || gameTable.pots.length === 0) return null;
    const unclaimed = gameTable.pots.filter((p) => !p.claimed);
    if (unclaimed.length === 0) return null;
    return unclaimed.reduce((top, p) => (p.id > top.id ? p : top), unclaimed[0]);
  }

  /**
   * CHANGED 10.1 (the-cut-spec_v10-1.md §8.2, defects 7/9): reads
   * `gameTable.claimEligiblePlayerIds` directly -- the server's own
   * _currentClaimEligiblePlayerIds() answer, already filtered against
   * provenLosers and (in the ordinary single-pot case) dealt-in status --
   * instead of independently re-deriving eligibility from
   * folded/sittingOut plus the pot's raw eligiblePlayerIds. That
   * re-derivation never excluded provenLosers at all, and in the
   * ordinary single-pot case never excluded a never-dealt $0-chip
   * Player either.
   */
  function eligibleClaimRecipients(gameTable) {
    const eligibleIds = gameTable.claimEligiblePlayerIds || [];
    return gameTable.players.filter((p) => eligibleIds.includes(p.id));
  }

  el.btnOpenClaimDialog.addEventListener('click', () => {
    hideTableError();
    const gameTable = state.lastGameTable;
    if (!gameTable) return;
    const pot = currentClaimablePot(gameTable);
    const potAmount = pot ? pot.amount : gameTable.pot;

    // v4.2 §6.0: with exactly one eligible player, there's nothing to
    // build -- go straight to a 100%-of-pot proposal, still subject to
    // the normal approval step.
    const eligible = eligibleClaimRecipients(gameTable);
    if (eligible.length === 1) {
      send('claimPot', { allocations: [{ playerId: eligible[0].id, amount: potAmount }] });
      return;
    }

    buildClaimAllocList(gameTable);
    el.claimPotTotal.textContent = potAmount;
    el.claimCarryCheck.checked = false; // NEW 8.2 -- always starts unchecked, per spec ("never auto-checked")
    updateClaimRemaining();
    el.claimDialog.showModal();
  });

  function buildClaimAllocList(gameTable) {
    el.claimAllocList.innerHTML = '';
    const pot = currentClaimablePot(gameTable);
    const potAmount = pot ? pot.amount : gameTable.pot;
    const eligible = eligibleClaimRecipients(gameTable);
    // Proposer's own row first (spec §6.2/§10.2) -- the common case (claiming
    // the whole pot yourself) should take zero clicks beyond confirming.
    const ordered = [
      ...eligible.filter((p) => p.id === state.playerId),
      ...eligible.filter((p) => p.id !== state.playerId),
    ];

    ordered.forEach((player) => {
      const isProposer = player.id === state.playerId;
      const row = document.createElement('div');
      row.className = 'claim-alloc-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'claim-alloc-check';
      checkbox.dataset.playerId = player.id;
      checkbox.checked = isProposer;

      const name = document.createElement('span');
      name.className = 'claim-alloc-name';
      name.textContent = player.name + (isProposer ? ' (you)' : '');

      const amount = document.createElement('input');
      amount.type = 'number';
      amount.min = '0';
      amount.placeholder = '$0';
      amount.className = 'mono-input claim-alloc-amount';
      amount.dataset.playerId = player.id;
      amount.disabled = !isProposer;
      if (isProposer) amount.value = potAmount; // defaults to 100% of the pot

      const fracHalf = document.createElement('button');
      fracHalf.type = 'button';
      fracHalf.className = 'btn btn-secondary claim-alloc-frac';
      fracHalf.textContent = '1/2';
      fracHalf.disabled = !isProposer;
      fracHalf.addEventListener('click', () => {
        // CHANGED 9.2: rounds down (Math.floor), not Math.round -- fixed
        // to match what the spec has always asserted all three quick-fill
        // buttons do; 1/2 and 1/4 previously rounded to nearest instead,
        // a real (if minor) mismatch only noticed while adding 1/3.
        amount.value = Math.floor(potAmount * 0.5);
        updateClaimRemaining();
      });

      // NEW 9.2 (§6.5): requested for three-way splits, positioned
      // between 1/2 and 1/4. Rounds down like the other two -- not new
      // rounding logic, the exact-total submission gate remains the
      // correctness backstop for any remainder.
      const fracThird = document.createElement('button');
      fracThird.type = 'button';
      fracThird.className = 'btn btn-secondary claim-alloc-frac';
      fracThird.textContent = '1/3';
      fracThird.disabled = !isProposer;
      fracThird.addEventListener('click', () => {
        amount.value = Math.floor(potAmount / 3);
        updateClaimRemaining();
      });

      const fracQuarter = document.createElement('button');
      fracQuarter.type = 'button';
      fracQuarter.className = 'btn btn-secondary claim-alloc-frac';
      fracQuarter.textContent = '1/4';
      fracQuarter.disabled = !isProposer;
      fracQuarter.addEventListener('click', () => {
        amount.value = Math.floor(potAmount * 0.25);
        updateClaimRemaining();
      });

      checkbox.addEventListener('change', () => {
        amount.disabled = !checkbox.checked;
        fracHalf.disabled = !checkbox.checked;
        fracThird.disabled = !checkbox.checked;
        fracQuarter.disabled = !checkbox.checked;
        if (!checkbox.checked) amount.value = '';
        updateClaimRemaining();
      });
      amount.addEventListener('input', updateClaimRemaining);

      const fracGroup = document.createElement('div');
      fracGroup.className = 'claim-alloc-fracs';
      fracGroup.append(fracHalf, fracThird, fracQuarter);

      row.append(checkbox, name, amount, fracGroup);
      el.claimAllocList.appendChild(row);
    });
  }

  function checkedClaimRows() {
    return [...el.claimAllocList.querySelectorAll('.claim-alloc-row')].filter(
      (row) => row.querySelector('.claim-alloc-check').checked
    );
  }

  /**
   * CHANGED 8.2 (§6.5): now also accounts for Carry to Next Game. When
   * checked, its dollar amount is always auto-computed here as
   * `pot - (sum of currently-checked player rows)` -- never manually
   * typed, clamped to a minimum of $0 for display (a negative figure
   * would mean the player rows already over-allocate past the pot,
   * which the existing "Remaining" indicator below already flags on its
   * own). Unchecking it removes it from the total entirely, reverting
   * to the original strict all-player-rows-must-sum-to-100% requirement.
   * CHANGED 9.0 (§6.10): `pot` here means the CURRENT claimable pot's own
   * amount once side pots exist, not the hand's overall total -- see
   * currentClaimablePot().
   */
  function updateClaimRemaining() {
    const gameTable = state.lastGameTable;
    const pot = gameTable ? (currentClaimablePot(gameTable)?.amount ?? gameTable.pot) : 0;
    const playerAllocated = checkedClaimRows().reduce((sum, row) => {
      const n = parseInt(row.querySelector('.claim-alloc-amount').value, 10);
      return sum + (Number.isInteger(n) && n > 0 ? n : 0);
    }, 0);
    const carryChecked = el.claimCarryCheck.checked;
    const carryAmount = carryChecked ? Math.max(0, pot - playerAllocated) : 0;
    el.claimCarryAmount.textContent = `$${carryAmount}`;
    const totalAllocated = playerAllocated + carryAmount;
    const remaining = pot - totalAllocated;
    el.claimRemaining.textContent = `Remaining: $${remaining}`;
    // NEW 8.2: a claim with carry covering the WHOLE pot and zero player
    // rows checked is valid on its own -- confirm no longer strictly
    // requires at least one checked player row, just SOME allocation
    // (player rows and/or carry) that exactly balances the pot.
    const isZero = (checkedClaimRows().length > 0 || carryChecked) && remaining === 0;
    el.claimRemaining.classList.toggle('is-zero', isZero);
    el.btnClaimDialogConfirm.disabled = !isZero;
  }

  el.claimCarryCheck.addEventListener('change', updateClaimRemaining);

  el.btnClaimDialogCancel.addEventListener('click', () => el.claimDialog.close());
  el.btnClaimDialogConfirm.addEventListener('click', () => {
    const allocations = checkedClaimRows().map((row) => ({
      playerId: row.querySelector('.claim-alloc-check').dataset.playerId,
      amount: parseInt(row.querySelector('.claim-alloc-amount').value, 10),
    }));
    const carryAmount = el.claimCarryCheck.checked ? parseInt(el.claimCarryAmount.textContent.replace('$', ''), 10) : 0;
    send('claimPot', { allocations, carryAmount });
    el.claimDialog.close();
  });

  // ---- rendering ----

  function showTableView() {
    el.viewLobby.hidden = true;
    el.viewGameTableTop.hidden = false;
    el.gameTableCodeDisplay.textContent = state.gameTableCode;
  }

  function renderGameTable(gameTable) {
    el.deckCount.textContent = gameTable.deckCount;

    const me = gameTable.players.find((p) => p.id === state.playerId);
    const isDealer = !!me?.isDealer;

    renderTableName(gameTable);
    renderGameRail(gameTable, isDealer);
    renderCommunityCards(gameTable);
    renderBurnPile(gameTable);
    renderRabbitHuntCards(gameTable);
    renderPhaseBanner(gameTable);
    renderTable(gameTable);
    renderDealerRail(gameTable, isDealer);
    renderPlayerRail(gameTable, me);
    renderPot(gameTable, me);
    renderClaimBanner(gameTable);
    renderBettingRail(gameTable, me);
    renderDealInterrupt(gameTable, me);
    renderTableNotice(gameTable, me);
    renderInactivityWarning(gameTable); // NEW 11.0 (Part H.2)
    renderTableOwnerControls(gameTable);
  }

  /** v3.3: rename permission belongs to the gameTable's original creator, not the current Dealer (spec §4.6). */
  function renderTableName(gameTable) {
    el.tableNameDisplay.textContent = gameTable.name;
  }

  /**
   * Game Rail (v4.1 §10.4): description text + Select/Options/Game
   * Rules buttons. Select is Dealer-only and only enabled while idle;
   * Options is visible to everyone (view-only for non-Dealers) and only
   * enabled once a Game Choice is active.
   */
  function renderGameRail(gameTable, isDealer) {
    const choice = state.gameChoices.find((g) => g.id === gameTable.gameChoiceId);
    el.gameRailDescription.textContent = choice ? choice.description : '';

    el.btnOpenSelectDialog.hidden = !isDealer;
    el.btnOpenSelectDialog.disabled = !gameTable.idle || !!gameTable.pendingClaim;
    el.btnOpenSelectDialog.title = gameTable.pendingClaim
      ? 'A claim is pending approval'
      : gameTable.idle
        ? 'Choose the Game Choice for the next hand'
        : 'Only available between hands (no hand in progress)';

    // BUG FIX (5.1 §5.8 dev note): must be recomputed here, unconditionally,
    // on every render -- this function always runs regardless of isDealer,
    // unlike the Dealer's Rail dispatcher, which early-returns for
    // non-Dealers and therefore never got a chance to update this if it
    // lived there. That's exactly what caused Same Game to persist visible
    // on a former Dealer's screen after Pass the Buck: the line simply
    // stopped executing for them the moment they were no longer Dealer,
    // freezing at whatever it last was while they still held the role.
    el.btnSameGame.hidden = !(isDealer && gameTable.idle && gameTable.gameChoiceId);
    // CHANGED 11.0 (Part I/Standing Convention): also disabled while
    // anyone's disconnected -- startGame() itself now rejects this
    // server-side (see _anyoneDisconnected()'s own comment); the client
    // reads the same server-computed answer rather than re-deriving it.
    el.btnSameGame.disabled = !!gameTable.pendingClaim || gameTable.anyoneDisconnected; // NEW 6.1 (§6.5)
    el.btnSameGame.title = gameTable.anyoneDisconnected
      ? 'Waiting for a disconnected player to reconnect (or for their grace period to expire) before starting a new hand'
      : 'Start a fresh hand of the current Game Choice';

    el.btnOpenOptionsDialog.disabled = !gameTable.gameOptions;

    // v4.1: Select auto-opens Options once the new choice actually lands.
    if (state.pendingAutoOpenOptions && gameTable.gameChoiceId) {
      state.pendingAutoOpenOptions = false;
      renderOptionsDialogFields(gameTable, isDealer);
      if (!el.optionsDialog.open) el.optionsDialog.showModal();
    } else if (el.optionsDialog.open) {
      // Keep an already-open Options dialog's read-only values in sync.
      renderOptionsDialogFields(gameTable, isDealer);
    }
  }

  /**
   * NEW 4.4 (§10.5): human-readable labels for Options popup fields,
   * replacing raw option keys. A lookup table rather than hardcoded text
   * per field, since more option keys will likely appear as Stud/Hold'em
   * get built out -- falls back to auto-splitting camelCase for any key
   * not yet in the table, so a new option never renders as a raw,
   * unreadable key even before this list is updated for it.
   */
  const OPTION_DISPLAY_LABELS = {
    cardsPerPlayer: 'Cards Per Player',
    maxDiscards: 'Max Discards',
    anteType: 'Ante Type',
    anteAmount: 'Ante Amount',
    pattern: 'Card Pattern',
    communityPattern: 'Community Card Pattern',
    smallBlind: 'Small Blind',
    bigBlind: 'Big Blind',
    bringIn: 'Bring In', // NEW 7.0 (§6.8)
    smallBet: 'Small Bet', // NEW 7.0 -- accepted, not enforced (§12)
    bigBet: 'Big Bet', // NEW 7.0 -- accepted, not enforced (§12)
    lowHandRules: 'Low Hand Rules', // NEW 8.1 (§3) -- standardized as always a Dealer Option
    threesUpOrDownWild: '3s Wild When', // NEW 8.1, RELABELED 8.2 (§10.5) -- "Threes Wild When" found too stiff in 8.1 testing
    priceForThrees: 'Price For a 3', // NEW 8.1
    priceForFours: 'Price For a 4', // NEW 8.1
    extraCardUpOrDown: 'Extra Card Dealt', // NEW 8.1
    audible: "Dealer's Audible", // NEW 8.1 (§3) -- universal free-text table talk
  };
  function optionDisplayLabel(key) {
    if (OPTION_DISPLAY_LABELS[key]) return OPTION_DISPLAY_LABELS[key];
    // Fallback: camelCase -> "Camel Case"
    return key
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, (c) => c.toUpperCase());
  }

  // NEW 8.1 (§3): known enum-valued Dealer Options render as a <select>
  // instead of a free-text/number input -- these fields aren't actually
  // free-form (the server does no validation on them either, per Mike's
  // Q6 call, but a constrained dropdown avoids a Dealer typo silently
  // mismatching a value the app string-compares against, e.g.
  // `_resolvePriceAmount`). Values themselves stay exactly as the JSON
  // delivers them (camelCase for prices) -- only DISPLAYED text is
  // reformatted, via `optionValueLabel`/`PRICE_DISPLAY_LABELS` below.
  // NOTE 8.2: bettingStartsWith removed from this map -- reclassified to
  // hiddenOptions (§3), so it's already filtered out of the Options
  // dialog entirely before this map would ever be consulted for it.
  const ENUM_OPTION_VALUES = {
    lowHandRules: ['Ace-to-Five', 'Deuce-to-Seven', 'Stud 8'],
    threesUpOrDownWild: ['face up only', 'face down only', 'either'],
    priceForThrees: ['free', 'smallBet', 'bigBet', 'bigBetX2', 'bigBetX4', 'pot'],
    priceForFours: ['free', 'smallBet', 'bigBet', 'bigBetX2', 'bigBetX4', 'pot'],
    extraCardUpOrDown: ['up', 'down'],
    bettingStructure: ['no-limit', 'pot-limit', 'fixed-limit'], // NEW 9.1 (§3, §6.10)
  };

  /** NEW 9.1 (§10.5): dropdown display text for bettingStructure's raw stored values. */
  const BETTING_STRUCTURE_DISPLAY_LABELS = {
    'no-limit': 'No-Limit',
    'pot-limit': 'Pot-Limit',
    'fixed-limit': 'Fixed-Limit',
  };

  /**
   * NEW 8.2 (§10.5): the label lookup now extends to dropdown OPTION
   * text, not just field labels -- a stored value and its displayed
   * text can differ when the raw value doesn't read naturally on its
   * own. Currently one instance: threesUpOrDownWild's "either" reads
   * oddly as a literal dropdown word, so it's mapped to "Face Up or
   * Down" here; "face up only"/"face down only" just need plain Title
   * Case, no separate mapping needed. The stored value in
   * `dealerOptions` is unchanged either way -- only the rendered text differs.
   */
  const THREES_WILD_DISPLAY_LABELS = {
    'face up only': 'Face Up Only',
    'face down only': 'Face Down Only',
    either: 'Face Up or Down',
  };

  /** Reuses PRICE_DISPLAY_LABELS (defined further below, alongside describePrice) for the two price fields; threesUpOrDownWild's own three values are mapped above; every other enum value is already human-readable as delivered. */
  function optionValueLabel(key, value) {
    if ((key === 'priceForThrees' || key === 'priceForFours') && PRICE_DISPLAY_LABELS[value]) {
      return PRICE_DISPLAY_LABELS[value] === 'the pot' ? 'Pot' : PRICE_DISPLAY_LABELS[value];
    }
    if (key === 'threesUpOrDownWild' && THREES_WILD_DISPLAY_LABELS[value]) {
      return THREES_WILD_DISPLAY_LABELS[value];
    }
    if (key === 'bettingStructure' && BETTING_STRUCTURE_DISPLAY_LABELS[value]) {
      return BETTING_STRUCTURE_DISPLAY_LABELS[value];
    }
    return value;
  }

  /**
   * Builds/refreshes the Options dialog's fields AND the confirm
   * button's label/behavior (v4.3 §10.5):
   *   non-Dealer, any state       -> "Close", read-only
   *   Dealer, idle === true       -> "Start", editable
   *   Dealer, idle === false      -> "Close", read-only (mid-hand)
   * Rebuilt only when the active Game Choice changes (to avoid
   * clobbering an in-progress edit); values refreshed in place otherwise.
   * CHANGED 4.4 (§10.5): the hint paragraph is gone entirely, and each
   * field shows a human-readable label instead of the raw option key.
   * CHANGED 8.1 (§3, Game Choice preset schema restructure): only shows
   * `dealerOptions`-bucket keys now -- `hiddenOptions` keys (cardsPerPlayer,
   * pattern, anteType, communityPattern, declareHighLowBoth,
   * dealIsInterruptable) are "never shown to or editable by the Dealer at
   * runtime" per spec, so they're filtered out here entirely, not just
   * disabled. The runtime `gameTable.gameOptions` object itself stays
   * flat and merged (unchanged, §3) -- this filter reads the ORIGINAL
   * preset's bucket split from `state.gameChoices` (fetched once at
   * startup, §10.4.1) purely to decide what to DISPLAY, and falls back
   * to showing every key if that preset can't be found for any reason
   * (defensive -- matches the pre-8.1 behavior rather than showing nothing).
   */
  function renderOptionsDialogFields(gameTable, isDealer) {
    const editable = isDealer && gameTable.idle;
    el.btnOptionsConfirm.textContent = editable ? 'Start' : 'Close';
    el.btnOptionsConfirm.title = editable
      ? "Save any changes and apply this Dealer's ante/blind"
      : 'Close';
    // CHANGED 11.0 (Part I/Standing Convention): "Start" specifically
    // (not "Close") is also disabled while anyone's disconnected --
    // startGame() itself now rejects this server-side; the client reads
    // the same server-computed answer rather than leaving the button
    // clickable and rejected after the fact.
    if (editable && gameTable.anyoneDisconnected) {
      el.btnOptionsConfirm.disabled = true;
      el.btnOptionsConfirm.title = 'Waiting for a disconnected player to reconnect (or for their grace period to expire) before starting a new hand';
    } else {
      el.btnOptionsConfirm.disabled = false;
    }
    // NEW 10.4 (Part C): only makes sense in the same state Start does
    // -- backing out to pick a different game before the hand exists is
    // meaningless once Options is in its read-only ("Close") state.
    el.btnOptionsCancel.hidden = !editable;

    if (!gameTable.gameOptions) {
      el.gameOptionsList.innerHTML = '';
      el.optionsGameName.textContent = '';
      return;
    }

    const preset = state.gameChoices.find((g) => g.id === gameTable.gameChoiceId);
    // NEW 8.2 (§10.5): plain, non-interactive display of the active
    // preset's displayName -- the same value already shown in the Game
    // Rail's own description, just repeated here since Options is a
    // separate, frequently-reopened view.
    el.optionsGameName.textContent = preset?.displayName || '';
    const dealerOptionKeys = preset?.dealerOptions ? new Set(Object.keys(preset.dealerOptions)) : null;
    const visibleKeys = Object.keys(gameTable.gameOptions).filter((key) => !dealerOptionKeys || dealerOptionKeys.has(key));

    if (state.gameOptionsEditorFor !== gameTable.gameChoiceId) {
      state.gameOptionsEditorFor = gameTable.gameChoiceId;
      el.gameOptionsList.innerHTML = '';
      for (const key of visibleKeys) {
        const value = gameTable.gameOptions[key];
        const row = document.createElement('div');
        row.className = 'game-option-row';

        const label = document.createElement('span');
        label.className = 'game-option-key';
        label.textContent = optionDisplayLabel(key);

        let input;
        if (ENUM_OPTION_VALUES[key]) {
          input = document.createElement('select');
          for (const enumValue of ENUM_OPTION_VALUES[key]) {
            const option = document.createElement('option');
            option.value = enumValue;
            option.textContent = optionValueLabel(key, enumValue);
            input.appendChild(option);
          }
          input.value = value;
          input.addEventListener('change', () => {
            hideTableError();
            send('setGameOption', { key, value: input.value });
          });
        } else {
          input = document.createElement('input');
          input.className = 'mono-input';
          input.type = typeof value === 'number' ? 'number' : 'text';
          // NEW 9.1: raiseCap's "no-cap" stored value displays as "No Cap"
          // -- still sends the raw "no-cap" string back if somehow edited
          // (it's disabled whenever showing this, per raiseCapLockedByStructure below).
          input.value = key === 'raiseCap' && value === 'no-cap' ? 'No Cap' : Array.isArray(value) ? value.join(',') : value;
          input.addEventListener('change', () => {
            hideTableError();
            const raw = input.value;
            const sendValue = Array.isArray(value) ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
            send('setGameOption', { key, value: sendValue });
          });
        }
        input.dataset.optionKey = key;
        // NEW 9.1 (§3): raiseCap is dependent on bettingStructure -- shows
        // "No Cap" and stays disabled (not Dealer-editable) under
        // No-Limit, regardless of the general editable/idle state.
        const raiseCapLockedByStructure = key === 'raiseCap' && gameTable.gameOptions.bettingStructure === 'no-limit';
        input.disabled = !editable || raiseCapLockedByStructure;

        row.append(label, input);
        el.gameOptionsList.appendChild(row);
      }
    } else {
      el.gameOptionsList.querySelectorAll('[data-option-key]').forEach((input) => {
        const raiseCapLockedByStructure =
          input.dataset.optionKey === 'raiseCap' && gameTable.gameOptions.bettingStructure === 'no-limit';
        input.disabled = !editable || raiseCapLockedByStructure;
        if (document.activeElement === input) return;
        const value = gameTable.gameOptions[input.dataset.optionKey];
        input.value =
          input.dataset.optionKey === 'raiseCap' && value === 'no-cap'
            ? 'No Cap'
            : Array.isArray(value)
              ? value.join(',')
              : value;
      });
    }

    // NEW 9.2 (§6.10), extended to Stud/Draw in 9.4: Fixed-Limit's Small
    // Bet/Big Bet, shown read-only once that structure is selected.
    // Hold'em: computed/live-recomputed from smallBlind/bigBlind (fully
    // derived, never independently set). Stud/Draw: reflects the
    // directly-configured smallBet/bigBet Dealer Options instead, since
    // neither has blinds to derive anything from. Hidden entirely under
    // No-Limit/Pot-Limit, where these figures don't apply. Always
    // refreshed on every call, not gated behind the rebuild-vs-update
    // branching above, since it's not part of the per-key options loop.
    const isFixedLimitStructure = gameTable.gameOptions.bettingStructure === 'fixed-limit';
    el.fixedLimitBetsDisplay.hidden = !isFixedLimitStructure;
    if (isFixedLimitStructure) {
      let smallBet;
      let bigBet;
      if (gameTable.profile === 'holdem') {
        const bigBlind = Number(gameTable.gameOptions.bigBlind) || 0;
        smallBet = bigBlind;
        bigBet = bigBlind * 2;
      } else {
        smallBet = Number(gameTable.gameOptions.smallBet) || 0;
        bigBet = Number(gameTable.gameOptions.bigBet) || 0;
      }
      el.fixedLimitBetsDisplay.textContent = `Small Bet: $${smallBet} \u00b7 Big Bet: $${bigBet}`;
    }
  }

  /** Community cards are never redacted -- always full data, always face-up (v4.0 §5.4). */
  function renderCommunityCards(gameTable) {
    el.communityCards.innerHTML = '';
    const cards = gameTable.communityCards || [];
    cards.forEach((card, idx) => {
      el.communityCards.appendChild(renderCard(card, idx, cards.length));
    });
  }

  /**
   * Shared burn pile visual (v4.2 §5.5) -- reuses the seat-muck face-down
   * pattern, but a single pile for the whole table. Count only; the
   * burned cards themselves are never visible to anyone. Gated by
   * burnAvailable, same as the Burn button itself.
   */
  function renderBurnPile(gameTable) {
    el.burnPile.innerHTML = '';
    if (!gameTable.burnAvailable || !gameTable.burnedThisHand) return;

    const cardsEl = document.createElement('div');
    cardsEl.className = 'burn-pile-cards';
    const visibleCount = Math.min(gameTable.burnedThisHand, 3);
    for (let c = 0; c < visibleCount; c++) {
      cardsEl.appendChild(renderCardBack(c, visibleCount));
    }
    const label = document.createElement('span');
    label.className = 'burn-pile-label';
    label.textContent = `${gameTable.burnedThisHand} burned`;
    el.burnPile.title = `${gameTable.burnedThisHand} card${gameTable.burnedThisHand === 1 ? '' : 's'} burned this hand`;
    el.burnPile.append(cardsEl, label);
  }

  function renderPot(gameTable, me) {
    // NEW 9.0 (§6.10): once side pots exist, show the horizontal
    // Main Pot / Side Pot N row instead of the single figure -- an
    // ordinary hand with no uneven all-in never populates gameTable.pots,
    // so this looks completely unchanged for the overwhelming majority
    // of hands.
    const hasPots = Array.isArray(gameTable.pots) && gameTable.pots.length > 0;
    el.potAmount.hidden = hasPots;
    el.potsRow.hidden = !hasPots;
    if (hasPots) {
      el.potsRow.innerHTML = '';
      const unclaimed = gameTable.pots.filter((p) => !p.claimed);
      const currentId = unclaimed.length ? Math.max(...unclaimed.map((p) => p.id)) : -1;
      for (const pot of gameTable.pots) {
        const chip = document.createElement('div');
        chip.className = 'pot-chip';
        if (pot.claimed) chip.classList.add('is-claimed');
        else if (pot.id === currentId) chip.classList.add('is-claimable');
        // CHANGED 10.1 (the-cut-spec_v10-1.md §8.2/§8.3 defect 9): reads
        // `pot.liveEligiblePlayerIds` (eligiblePlayerIds minus
        // provenLosers, server-computed) instead of the raw
        // `pot.eligiblePlayerIds` -- the latter is a contribution-
        // threshold fact only and was never filtered against a Player
        // excluded after losing a higher pot, so this text used to keep
        // showing them as eligible after they no longer were.
        chip.title = `Eligible: ${pot.liveEligiblePlayerIds
          .map((id) => gameTable.players.find((p) => p.id === id)?.name || id)
          .join(', ')}`;
        const label = document.createElement('span');
        label.className = 'pot-chip-label';
        label.textContent = pot.label + (pot.claimed ? ' \u2014 Claimed' : '');
        const amount = document.createElement('span');
        amount.className = 'pot-chip-amount';
        amount.textContent = `$${pot.amount}`;
        chip.append(label, amount);
        el.potsRow.appendChild(chip);
      }
    } else {
      el.potAmount.textContent = `$${gameTable.pot}`;
    }

    // CHANGED 10.1 (the-cut-spec_v10-1.md §8.2, defects 7/8/9): reads
    // `gameTable.claimEligiblePlayerIds` and `gameTable.claimWindowOpen`
    // directly -- both server-computed (see _currentClaimEligiblePlayerIds()/
    // _claimWindowOpen()'s own doc comments) -- instead of independently
    // re-deriving eligibility from folded/sittingOut/provenLosers/pot
    // data, and instead of never checking hand phase or the early-claim
    // condition at all (this control was previously enabled purely off
    // the player's own pot eligibility, ignoring whether there was
    // actually anything currently claimable -- a display gap, since
    // claimPot() itself always caught it server-side, but exactly the
    // "client guessing instead of being told" pattern §8.2 exists to end).
    const claimEligibleIds = gameTable.claimEligiblePlayerIds || [];
    const canClaim = !!me && !!gameTable.claimWindowOpen && claimEligibleIds.includes(me.id);
    el.btnOpenClaimDialog.disabled = !canClaim;
    el.btnOpenClaimDialog.title = canClaim
      ? 'Propose claiming the pot'
      : !gameTable.claimWindowOpen
        ? 'Nothing is currently claimable'
        : "You're not eligible to claim the pot right now";

    // CHANGED 10.4 (the-cut-spec_v10-4.md Standing Convention / B.3):
    // reads `me.canBuyChips` directly -- the server's own _canBuyChips()
    // answer, covering BOTH the pending gate and the RequestAntes-
    // specific one (10.3's own fix). Previously reconstructed only the
    // pending half here, so a Player who owed or had posted an
    // ante/blind still saw this control enabled and had to click it to
    // discover it was rejected -- exactly the gap the new Standing
    // Convention exists to close: a Player should be able to SEE an
    // action isn't available, not learn it from a bounced request.
    if (el.btnOpenBuyDialog) {
      const canBuyChips = !!me && me.canBuyChips;
      el.btnOpenBuyDialog.disabled = !canBuyChips;
      el.btnOpenBuyDialog.title = canBuyChips
        ? 'Buy more chips'
        : me && me.pending
          ? "Can't buy chips while your outcome for this hand is still pending"
          : "Can't buy chips -- you're already committed to the hand being formed";
    }
  }

  /**
   * Rabbit Hunt reveals (v4.3 §5.6/§10.9) -- real face-up cards, never
   * redacted, kept in their own area distinct from community cards/hands.
   */
  function renderRabbitHuntCards(gameTable) {
    el.rabbitHuntCardsEl.innerHTML = '';
    const cards = gameTable.rabbitHuntCards || [];
    cards.forEach((card, idx) => {
      el.rabbitHuntCardsEl.appendChild(renderCard(card, idx, cards.length));
    });
  }

  /**
   * v3.3 (§6.2 fixed wording): always "[Proposer] is claiming the pot:
   * [Player] $[amount], ...", one line, whether there's one recipient or
   * several -- no separate "splitting" language, since the recipient
   * list itself already makes a split obvious when there is one.
   * CHANGED 7.1 (§6.5): everyone who ISN'T the approver -- including, as
   * of 7.1, the proposer themselves -- now also sees who they're waiting
   * on ("...Waiting for [Approver] to approve."). Previously this group
   * saw an identical line to the approver's own, just missing the
   * prompt, with no indication of who was actually being waited on --
   * confusing given the whole Dealer's Rail is locked (§6.5, 6.1) with
   * nothing else on screen explaining why.
   */
  // NEW 8.1 (§5.10 extension): price enum -> human-readable display
  // label. Per Mike's call (Q5), the JSON's internal values (`bigBet`,
  // `bigBetX2`, etc.) stay exactly as delivered -- only the DISPLAYED
  // text gets proper spacing/casing. `free` prices never reach this
  // dialog at all (they auto-resolve server-side, no pause), so it's
  // only listed here for completeness.
  const PRICE_DISPLAY_LABELS = {
    free: 'Free',
    smallBet: 'Small Bet',
    bigBet: 'Big Bet',
    bigBetX2: 'Big Bet x2',
    bigBetX4: 'Big Bet x4',
    pot: 'the pot',
  };

  /** Mirrors GameTable#_resolvePriceAmount exactly -- kept in sync by hand, same convention as every other server-gating mirror in this file. */
  function resolvePriceAmount(gameTable, priceValue) {
    const smallBet = gameTable.gameOptions?.smallBet || 0;
    const bigBet = gameTable.gameOptions?.bigBet || 0;
    switch (priceValue) {
      case 'smallBet':
        return smallBet;
      case 'bigBet':
        return bigBet;
      case 'bigBetX2':
        return bigBet * 2;
      case 'bigBetX4':
        return bigBet * 4;
      case 'pot':
        return gameTable.pot;
      default:
        return 0;
    }
  }

  function describePrice(gameTable, priceValue) {
    const label = PRICE_DISPLAY_LABELS[priceValue] || priceValue;
    if (priceValue === 'pot') return `${label} ($${gameTable.pot})`;
    return `${label} ($${resolvePriceAmount(gameTable, priceValue)})`;
  }

  /**
   * NEW 8.1 (§5.10 extension): shows the affected player's Pay-or-Fold
   * or Buy-or-Decline dialog the instant a state update reveals
   * `pendingDealInterrupt.playerId === me.id`, and closes it (safe
   * no-op if already closed) the instant that's no longer true --
   * whether because THIS player's own action just resolved it, or
   * because a later state update simply confirms it's already resolved.
   * No dedicated "waiting on someone else" indicator for every other
   * player -- the paused deal is otherwise silent, same as the spec's
   * own framing ("no separate Dealer action anywhere in this sequence").
   */
  function renderDealInterrupt(gameTable, me) {
    const pending = gameTable.pendingDealInterrupt;
    const isMine = !!pending && !!me && pending.playerId === me.id;

    if (!(isMine && pending.triggerRank === '3') && el.payOrFoldDialog.open) el.payOrFoldDialog.close();
    if (!(isMine && pending.triggerRank === '4') && el.buyOrDeclineDialog.open) el.buyOrDeclineDialog.close();
    if (!isMine) return;

    if (pending.triggerRank === '3') {
      const priceDesc = describePrice(gameTable, gameTable.gameOptions?.priceForThrees);
      el.payOrFoldDialogText.textContent = `A face-up 3 was dealt to you. Pay ${priceDesc} into the pot, or Fold?`;
      if (!el.payOrFoldDialog.open) el.payOrFoldDialog.showModal();
    } else if (pending.triggerRank === '4') {
      const priceDesc = describePrice(gameTable, gameTable.gameOptions?.priceForFours);
      el.buyOrDeclineDialogText.textContent = `A face-up 4 was dealt to you. Buy an extra card for ${priceDesc}, or Decline?`;
      if (!el.buyOrDeclineDialog.open) el.buyOrDeclineDialog.showModal();
    }
  }

  /**
   * NEW 8.2 (§5.10 extension, §6.9): the table-wide, persistent (never
   * auto-dismissing -- purely state-driven) notice for everyone who
   * ISN'T the one player already seeing their own dedicated dialog for
   * whatever's happening -- the affected player in a Baseball
   * deal-interrupt pause (already handled by their own Pay/Fold or
   * Buy/Decline dialog, renderDealInterrupt above), or the Dealer
   * themselves during a Kill Hand confirmation (already seeing their own
   * confirm dialog). Two conditions, mutually exclusive in practice
   * (`hasKillCard` and `dealIsInterruptable` never both apply to the
   * same preset today) but checked independently rather than assuming
   * that stays true forever -- Kill Hand takes priority if somehow both
   * were ever true at once, simply because it's checked first.
   * Dollar amounts use the raw computed figure (spec's own "$[amount]"
   * wording), via the same `resolvePriceAmount` the affected player's
   * own dialog text is built from -- never left vague.
   */
  function renderTableNotice(gameTable, me) {
    const isDealer = !!me?.isDealer;
    const isOwner = gameTable.creatorId === state.playerId;

    // NEW 10.4 (the-cut-spec_v10-4.md §3.3 fallback, Standing
    // Convention): mutually exclusive with the two branches below by
    // construction -- Kill Hand/Baseball interrupts only ever happen
    // mid-hand, Pot Distribution only ever happens while idle (§3.2).
    // The Table Owner themselves sees the real staged-batch detail
    // elsewhere (the Table Owner Tools dialog itself), not this generic
    // notice.
    if (gameTable.tableOwnerDistributionInProgress && !isOwner) {
      el.tableNotice.textContent = 'Host functions have been invoked, please stand by.';
      el.tableNotice.hidden = false;
      return;
    }

    if (gameTable.killHandConfirmPending && !isDealer) {
      const dealer = gameTable.players.find((p) => p.isDealer);
      const dealerName = dealer ? dealer.name : 'The Dealer';
      el.tableNotice.textContent = `${dealerName} is about to kill this hand (${formatKillCardName(gameTable.killCard)}).`;
      el.tableNotice.hidden = false;
      return;
    }

    const pending = gameTable.pendingDealInterrupt;
    if (pending && pending.playerId !== me?.id) {
      const player = gameTable.players.find((p) => p.id === pending.playerId);
      const name = player ? player.name : 'A player';
      if (pending.triggerRank === '3') {
        const amount = resolvePriceAmount(gameTable, gameTable.gameOptions?.priceForThrees);
        el.tableNotice.textContent = `${name} was dealt a 3 and is deciding whether to Pay $${amount} or Fold.`;
      } else {
        const amount = resolvePriceAmount(gameTable, gameTable.gameOptions?.priceForFours);
        el.tableNotice.textContent = `${name} was dealt a 4 and is deciding whether to Buy an extra card for $${amount} or Decline.`;
      }
      el.tableNotice.hidden = false;
      return;
    }

    el.tableNotice.hidden = true;
  }

  function renderClaimBanner(gameTable) {
    const claim = gameTable.pendingClaim;
    if (!claim) {
      el.claimBanner.hidden = true;
      return;
    }
    const proposer = gameTable.players.find((p) => p.id === claim.proposerId);
    const approver = gameTable.players.find((p) => p.id === claim.approverId);
    const isApprover = claim.approverId === state.playerId;

    el.claimBanner.hidden = false;
    el.claimBannerBody.innerHTML = '';

    const proposerName = proposer ? proposer.name : 'A player';
    const approverName = approver ? approver.name : 'the approver';
    const allocParts = claim.allocations.map((a) => {
      const recipient = gameTable.players.find((p) => p.id === a.playerId);
      return `${recipient ? recipient.name : 'Unknown'} $${a.amount}`;
    });
    // NEW 8.3 (§6.5), Mike's preference: Carry to Next Game is now named
    // inline here too, worded exactly like another split recipient --
    // previously it silently vanished from both banners' text even
    // though it was a real part of the claim.
    if (claim.carryAmount > 0) {
      allocParts.push(`Carry to Next Game $${claim.carryAmount}`);
    }
    const allocText = allocParts.join(', ');

    // NEW 9.0 (§6.10): once side pots exist, name which pot this claim is
    // for -- otherwise a Side Pot claim resolving reads identically to a
    // Main Pot claim, with nothing on screen distinguishing the two.
    const claimedPot = claim.potId !== null && Array.isArray(gameTable.pots) ? gameTable.pots.find((p) => p.id === claim.potId) : null;
    const potPhrase = claimedPot ? claimedPot.label : 'the pot';

    const line = document.createElement('p');
    line.textContent = isApprover
      ? `${proposerName} is claiming ${potPhrase}: ${allocText}. Approve?`
      : `${proposerName} is claiming ${potPhrase}: ${allocText}. Waiting for ${approverName} to approve.`;
    el.claimBannerBody.appendChild(line);

    el.claimBannerActions.hidden = !isApprover;
  }

  function renderBettingRail(gameTable, me) {
    // CHANGED 10.1: `currentTurnPlayerId` is already fully
    // server-authoritative -- only ever set to a Player _canAct() itself
    // approved (_nextTurnPlayerId()). Re-checking folded/sittingOut here
    // was always redundant with that guarantee; dropped rather than left
    // as a second, independently-maintained copy of the same fact.
    const showTurnActions = !!me && gameTable.bettingOpen && me.id === gameTable.currentTurnPlayerId;
    const showAnteAction = !!me && me.oweAnte > 0;

    // BUG FIX (standalone, post-5.2 -- see BUGFIX_v5-2-Fold-at-Showdown.md):
    // computed here, at the top of the function, specifically so it can
    // feed into el.bettingRail's own hidden condition below. The 5.2 fix
    // originally computed this near the bottom of the function (right
    // next to personalFoldAction.hidden, where it's ALSO still used) --
    // that leaf-level assignment was correct in isolation, but the
    // PARENT container's hidden condition, set earlier in the function,
    // had no way to know about it yet. A hidden parent hides every
    // descendant regardless of the descendant's own hidden attribute, so
    // Fold stayed structurally unreachable at Showdown even though its
    // own visibility logic was right. Same failure class as the bugs 5.2
    // itself was fixing -- correct leaf-level logic, stale container gate.
    // BUG FIX 8.1 (§6.4): 'stud' was missing from this check -- Stud
    // players could never see the Fold button at Showdown at all, even
    // though the server has accepted Fold there since 7.0 (fold()'s own
    // gate already correctly includes Stud via isPhaseGated()). A
    // client-side-only gap, found while extending this same function
    // for Declare's analogous non-turn-gated visibility.
    // CHANGED 8.1 (§5.11): also covers Declare -- "not folded-gated
    // separately from Fold's existing Showdown-phase rule," per spec;
    // fold()'s own server-side gate already treats the two identically.
    const showFoldAtShowdown =
      !!me &&
      (gameTable.profile === 'draw' || gameTable.profile === 'holdem' || gameTable.profile === 'stud') &&
      (gameTable.handPhase === 'Showdown' || gameTable.handPhase === 'Declare') &&
      !me.folded &&
      !me.sittingOut;

    // v4.0 §10.1: Discard/Stand Pat are Draw-profile-specific -- hidden
    // entirely for Stud/Hold'em/no-Game-Choice-yet.
    // CHANGED 5.0 (§5.7/§5.8): for Draw, both are now gated by
    // handPhase === 'DiscardPhase' and locked out together once this
    // player has acted via EITHER one (discardPhaseActed) -- replacing
    // the old discardWindowOpen-based visibility for this profile only.
    // Non-Draw profiles (if a future preset ever needs Discard) keep the
    // pre-5.0 discardWindowOpen-based behavior untouched; Stand Pat is
    // Draw-only regardless.
    const isDraw = gameTable.profile === 'draw';
    let showDiscardAction = false;
    let showStandPatAction = false;
    if (!!me && isDraw && (me.handCount || 0) > 0 && !me.folded) {
      showDiscardAction = gameTable.handPhase === 'DiscardPhase' && !me.discardPhaseActed;
      showStandPatAction = showDiscardAction;
    } else if (!!me && (me.handCount || 0) > 0 && gameTable.profile !== 'draw') {
      const hasDiscarded = (me.discardCountThisHand || 0) > 0;
      showDiscardAction = gameTable.discardWindowOpen !== false && !hasDiscarded && !me.folded && !!gameTable.gameOptions?.maxDiscards;
    }

    // NEW 8.1 (§5.11): Declare -- player-submitted, not turn-gated, same
    // shape as ante collection/Discard above. `declaration` is one-shot
    // (Mike's call) -- once set, hides for that player even though the
    // phase itself is still open for everyone else.
    // CHANGED 10.1: `me.isHandParticipant` (server-computed) replaces the
    // inline `!me.folded && !me.sittingOut` -- same value today, but no
    // longer a second independent copy of that combination.
    const showDeclareAction =
      !!me && gameTable.profile === 'stud' && gameTable.handPhase === 'Declare' && me.isHandParticipant && me.declaration === null;

    // BUG FIX: showFoldAtShowdown is now included here -- previously
    // Fold's own leaf-level hidden flag could be false while this parent
    // container was still true, hiding it regardless. See the note above.
    // CHANGED 8.1: showDeclareAction included too, same reasoning --
    // Declare's own leaf-level visibility would otherwise be correct
    // while this parent container hid it anyway.
    el.bettingRail.hidden = !(
      gameTable.bettingOpen ||
      showAnteAction ||
      showDiscardAction ||
      showStandPatAction ||
      showFoldAtShowdown ||
      showDeclareAction
    );

    if (gameTable.bettingOpen) {
      const turnPlayer = gameTable.players.find((p) => p.id === gameTable.currentTurnPlayerId);
      // CHANGED 7.1 (§6.8): reads "Bring In" instead of "Total Bet" while
      // Stud's Bring-In obligation is still unresolved -- "Total Bet"
      // implies money someone actually placed, but nobody's paid the
      // Bring In yet at this exact moment, only been forced to face it.
      // Reverts to "Total Bet" the instant the selected opening bettor
      // calls or raises over it (bringInObligationId clears), same
      // number either way -- the "$YY to You"/"$ZZ to [Name]" figures
      // below are unaffected, since those were already accurate.
      const totalBetLabel = gameTable.profile === 'stud' && gameTable.bringInObligationId ? 'Bring In' : 'Total Bet';
      const parts = [`${totalBetLabel}: $${gameTable.currentBetToCall}`];
      if (me) {
        const toYou = Math.max(0, gameTable.currentBetToCall - me.currentBet);
        parts.push(`$${toYou} to You`);
      }
      if (turnPlayer && turnPlayer.id !== state.playerId) {
        const toThem = Math.max(0, gameTable.currentBetToCall - turnPlayer.currentBet);
        parts.push(`$${toThem} to ${turnPlayer.name}`);
      }
      el.bettingRailShared.textContent = parts.join(' \u00b7 ');

      // NEW 9.2 (§6.10), extended to Stud/Draw in 9.4: persistent
      // table-wide indicator, not a fading toast -- "raise cap reached"
      // is true for the rest of the current betting round, relevant to
      // everyone who might still act, not just whoever was looking at
      // the instant it triggered. Clears automatically once bettingOpen
      // goes false (the round closes), same lifecycle as
      // raiseCountThisRound's own server-side reset.
      const isPhaseGatedNow = gameTable.profile === 'draw' || gameTable.profile === 'holdem' || gameTable.profile === 'stud';
      const structureNow = gameTable.bettingStructure || 'no-limit';
      const capNow = gameTable.raiseCap;
      // CHANGED 10.1: `p.isHandParticipant` (server-computed) replaces
      // the inline folded/sittingOut combination -- see the matching
      // server-side raise-cap heads-up fix (the-cut-spec_v10-1.md §8.3
      // defect 4) this display hint now stays consistent with.
      const headsUpNow = gameTable.players.filter((p) => p.isHandParticipant).length === 2;
      const capReachedNow =
        isPhaseGatedNow &&
        gameTable.currentBetToCall > 0 &&
        (structureNow === 'pot-limit' || structureNow === 'fixed-limit') &&
        capNow !== 'no-cap' &&
        !headsUpNow &&
        gameTable.raiseCountThisRound >= (typeof capNow === 'number' ? capNow : 3);
      el.raiseCapIndicator.hidden = !capReachedNow;
      if (capReachedNow) el.raiseCapIndicator.textContent = 'Raise cap reached \u2014 no further raises this round';
    } else {
      el.bettingRailShared.textContent = '';
      el.raiseCapIndicator.hidden = true;
    }

    // BUG FIX (5.1 §10.2, logged in the spec as unresolved -- root cause
    // found here): the box must clear to blank every time it becomes
    // this player's turn, not just after submitting. The previous
    // implementation tracked "the last currentTurnPlayerId we cleared
    // for" and compared by value -- which fails to re-clear when the
    // SAME player's turn recurs within a single round after someone
    // else raises and reopens the action (confirmed via a live trace:
    // currentTurnPlayerId returns to an identical value in that exact
    // case, e.g. p2 -> p3 raises -> p1 -> back to p2, same id both
    // times). Fixed by switching to an edge-triggered check instead --
    // clear only on the false-to-true transition of showTurnActions
    // itself, which is guaranteed to happen between ANY two of this
    // player's turns for any reason (a new round starting also passes
    // through bettingOpen === false first, so this covers that case too
    // without needing to enumerate every specific state combination).
    if (showTurnActions && !state.wasShowingTurnActions) {
      el.betAmount.value = '';
    }
    state.wasShowingTurnActions = showTurnActions;

    el.personalTurnActions.hidden = !showTurnActions;
    if (showTurnActions) {
      // CHANGED 9.4 (§6.10, §6.11): extended from Hold'em-only to every
      // phase-gated profile -- mirrors the server's own generalization
      // (_validateBetOrRaise, _legalMaxBetOrRaiseTotal, _fixedLimitSize).
      const isPhaseGatedProfile = gameTable.profile === 'draw' || gameTable.profile === 'holdem' || gameTable.profile === 'stud';
      const amountToCall = Math.max(0, gameTable.currentBetToCall - me.currentBet);
      const ownStackCap = me.currentBet + me.chips;

      // NEW 9.1 (§6.10): mirrors the server's proactive opponent-ceiling
      // cap -- a voluntary Bet/Raise can never exceed the largest amount
      // any single remaining non-folded opponent could still possibly
      // cover. All-In stays exempt (unchanged).
      // CHANGED 10.1: `p.isHandParticipant` replaces the inline
      // folded/sittingOut combination -- matches the server's own fix to
      // this exact calculation (the-cut-spec_v10-1.md §8.3 defect 6); a
      // never-dealt $0-chip Player no longer wrongly counts as an
      // opponent here either.
      const opponents = isPhaseGatedProfile
        ? gameTable.players.filter((p) => p.id !== me.id && p.isHandParticipant)
        : [];
      const opponentCeiling =
        opponents.length > 0
          ? Math.max(...opponents.map((p) => (p.bettingCapped ? p.totalContributedThisHand : p.totalContributedThisHand + p.chips)))
          : Infinity;

      const structure = isPhaseGatedProfile ? gameTable.bettingStructure || 'no-limit' : null;
      const isFixedLimit = structure === 'fixed-limit';

      let minLegalTotal = 1;
      let maxLegalTotal = Math.min(ownStackCap - 1, opponentCeiling); // No-Limit default: own stack (minus one -- a full-stack bet is All-In's job), further capped by opponentCeiling
      let structuralMax = Infinity; // No-Limit: no structural ceiling beyond the player's own stack -- All-In is never redundant there
      if (isPhaseGatedProfile) {
        if (isFixedLimit) {
          // CHANGED 9.4 (§6.10): profile-aware Fixed-Limit size, was
          // Hold'em-only (bigBlind-derived) inline math -- mirrors the
          // server's own _fixedLimitSize(). Stud/Draw use their own
          // directly-configured smallBet/bigBet, since neither has
          // blinds to derive anything from.
          let fixedSize;
          if (gameTable.profile === 'holdem') {
            const bigBlind = gameTable.gameOptions?.bigBlind || 0;
            const isSmall = gameTable.handPhase === 'PreFlopBetting' || gameTable.handPhase === 'FlopBetting';
            fixedSize = isSmall ? bigBlind : bigBlind * 2;
          } else {
            const smallBet = gameTable.gameOptions?.smallBet || 0;
            const bigBet = gameTable.gameOptions?.bigBet || 0;
            if (gameTable.profile === 'draw') {
              fixedSize = gameTable.handPhase === 'FirstBetting' ? smallBet : bigBet;
            } else {
              // Stud: A/B streets are Small Bet, C onward Big Bet -- the
              // same single rule covers 5-Card and 7-Card both, since
              // 5-Card simply never reaches streets past D.
              const m = /^Street([A-E])Betting$/.exec(gameTable.handPhase);
              const letter = m ? m[1] : null;
              fixedSize = letter === 'A' || letter === 'B' ? smallBet : bigBet;
            }
          }
          minLegalTotal = gameTable.currentBetToCall > 0 ? gameTable.currentBetToCall + fixedSize : fixedSize;
          maxLegalTotal = minLegalTotal; // exactly one legal size, no range
          structuralMax = minLegalTotal; // NOT clamped by ownStackCap -- see the All-In redundancy check below
        } else {
          minLegalTotal =
            gameTable.currentBetToCall > 0
              ? gameTable.currentBetToCall + (gameTable.minRaiseIncrement || 0)
              : gameTable.gameOptions?.bigBlind || 1; // Draw/Stud: bigBlind is always undefined here, correctly falling back to $1 (§6.10's $0 floor + the "must be > 0" rule already enforced elsewhere)
          if (structure === 'pot-limit') {
            const potAfterCall = gameTable.pot + amountToCall;
            // BUG FIX 9.5 (§6.10): structuralMax = amountToCall (the
            // client's own mirror of the server's callAmount) +
            // potAfterCall -- was `gameTable.currentBetToCall +
            // potAfterCall`, the exact same double-counting bug as the
            // server's own pre-9.5 formula (potAfterCall already
            // includes amountToCall once; adding currentBetToCall on
            // top re-added the player's own current-street contribution
            // a second time). This client-side copy is a separate
            // duplication of the server's own calculation (used only
            // for the live "Legal: $X-$Y" hint and the All-In-redundancy
            // check below, never for actual validation, which the
            // server always performs independently) -- CONFIRMED with
            // Mike this fix applies here too, unlike Minimum Raise
            // (unchanged just above, and on the server -- see
            // _validateBetOrRaise's own comment for why the two
            // formulas are genuinely different, not the same bug twice).
            // structuralMax is the pot-limit ceiling BEFORE the
            // ownStackCap clamp -- needed unclamped for the All-In
            // redundancy check below; maxLegalTotal (the UI range, WITH
            // the clamp) is derived from it right after.
            structuralMax = amountToCall + potAfterCall;
            maxLegalTotal = Math.min(structuralMax, ownStackCap - 1, opponentCeiling);
          }
        }
      }

      // NEW 9.0 (§6.11), extended to Stud/Draw in 9.4: All-In is shown
      // whenever it's this player's turn and they have chips left --
      // NEW 9.4: EXCEPT when it would be redundant with the already-
      // correctly-capped ordinary Raise/Bet button (own stack doesn't
      // exceed the legal maximum under Fixed-Limit/Pot-Limit -- clicking
      // either button would produce the identical result). Label always
      // shows the live dollar amount so the commitment is visible before
      // the click.
      // Redundant specifically when the player's OWN stack exceeds the
      // STRUCTURAL legal maximum (unclamped by their own stack) --
      // ordinary Raise/Bet is already capped there in that case, so
      // All-In would produce the identical result. Deliberately compared
      // against structuralMax, not maxLegalTotal -- maxLegalTotal
      // already has the ownStackCap-1 clamp baked in for Pot-Limit,
      // which would make this comparison vacuously true every time and
      // hide All-In incorrectly. When the stack is the binding
      // constraint instead (ownStackCap <= structuralMax), that's the
      // genuine short-stack case All-In exists for -- never redundant
      // then.
      const allInWouldBeRedundant = isPhaseGatedProfile && structure !== 'no-limit' && ownStackCap > structuralMax;
      el.btnAllIn.hidden = !isPhaseGatedProfile || allInWouldBeRedundant;
      if (isPhaseGatedProfile && !allInWouldBeRedundant) {
        el.btnAllIn.disabled = me.chips <= 0;
        el.btnAllIn.textContent = `All In ($${me.chips})`;
      }

      // NEW 9.0 (§6.11), Option B (Mike's decision): once a player can't
      // cover the Call/Raise amount owed, those ordinary buttons are
      // disabled/relabeled rather than silently capped -- they're routed
      // to the dedicated All-In button to actually commit. This mirrors
      // the server-side rejection in call()/placeBet() exactly (an
      // amount that would commit the player's entire stack is rejected
      // there too), so a click here never round-trips to a server error.
      const callWouldBeAllIn = isPhaseGatedProfile && amountToCall > 0 && amountToCall >= me.chips;
      el.btnCall.disabled = gameTable.currentBetToCall <= 0 || amountToCall <= 0 || callWouldBeAllIn;
      // NEW 9.3 (§6.10, §10.2): "Call $[amount]" -- Call has never had a
      // text box (always a single deterministic "pay the current bet"
      // amount, in every profile, under every betting structure), so
      // this is pure clarity, not removing an input the way 9.2's
      // Fixed-Limit Bet/Raise change was. Reuses amountToCall, the exact
      // same figure already computed for the shared rail's "$YY to You"
      // -- no new computation, applies universally (not gated to any
      // one betting structure the way the Fixed-Limit label change is).
      el.btnCall.textContent = callWouldBeAllIn ? 'Call (use All In)' : `Call $${amountToCall}`;
      el.btnCall.title = callWouldBeAllIn ? "Calling would commit your entire stack \u2014 use All In instead." : 'Match the current bet to call';

      el.btnCheck.disabled = gameTable.currentBetToCall !== me.currentBet;

      const betWouldBeAllIn = isPhaseGatedProfile && minLegalTotal >= ownStackCap;
      // CHANGED 11.4 (Part D.3): was a client-side reconstruction
      // (`minLegalTotal > opponentCeiling`) of the same check the server
      // already performs authoritatively in _validateBetOrRaise() --
      // replaced with reading `canBetOrRaise` directly, per the Standing
      // Convention and the same established pattern already used for
      // Buy Chips's own `canBuyChips`: the server computes the real
      // answer once, the client never re-derives it. Gated server-side
      // behind GATE_BETTING_BUTTONS_WHEN_UNCALLABLE -- when that flag is
      // off (the Beta-window revert), `canBetOrRaise` is unconditionally
      // true, so this naturally falls back to the pre-11.4 behavior
      // (buttons stay enabled; a blocked Bet is rejected on click).
      const betExceedsOpponentCeiling = isPhaseGatedProfile && me.canBetOrRaise === false;
      // NEW 9.2 (§6.10), extended 9.4: proactive raise-cap prevention --
      // once the cap is already reached (and heads-up doesn't waive it),
      // Bet/Raise is unusable for this reason too, checked before the
      // player can even attempt it, rather than offered and rejected
      // after the fact. Only applies to a RAISE (currentBetToCall > 0),
      // never the opening Bet itself, matching the server's own
      // raiseCountThisRound semantics (incremented on Raise, not the
      // opening Bet).
      // CHANGED 10.1: `p.isHandParticipant` replaces the inline
      // folded/sittingOut combination -- same fix as headsUpNow above.
      const isHeadsUp = gameTable.players.filter((p) => p.isHandParticipant).length === 2;
      const cap = gameTable.raiseCap;
      const raiseCapReached =
        isPhaseGatedProfile &&
        gameTable.currentBetToCall > 0 &&
        (structure === 'pot-limit' || structure === 'fixed-limit') &&
        cap !== 'no-cap' &&
        !isHeadsUp &&
        gameTable.raiseCountThisRound >= (typeof cap === 'number' ? cap : 3);
      const betUnusable = betWouldBeAllIn || betExceedsOpponentCeiling || raiseCapReached;
      el.btnPlaceBet.disabled = betUnusable; // NEW 6.1 (§6.6) -- re-enabled fresh each render; see the click guard below
      // CHANGED 9.2 (§10.2), REVERSED from 5.0: "Raise" -> "Raise To" --
      // matches the box asking for a total again, not an increment.
      // "Bet" (opening, currentBetToCall === 0) is unchanged.
      const verb = gameTable.currentBetToCall > 0 ? 'Raise To' : 'Bet';

      // NEW 9.2 (§6.10, §10.2), extended to Stud/Draw in 9.4: Fixed-Limit
      // loses the text box entirely -- every amount is exactly one
      // deterministic value, already known before the player acts, so a
      // free-text box would imply a choice that doesn't exist. The
      // amount goes directly into the button's own label instead, and is
      // stashed on the button (see the click handler above) so no input
      // needs to be read at all.
      el.betAmount.hidden = isFixedLimit;
      if (isFixedLimit && !betUnusable) {
        el.btnPlaceBet.dataset.fixedAmount = String(minLegalTotal);
        el.btnPlaceBet.textContent = gameTable.currentBetToCall > 0 ? `Raise To $${minLegalTotal}` : `Bet $${minLegalTotal}`;
      } else {
        delete el.btnPlaceBet.dataset.fixedAmount;
        // CHANGED 11.4 (Part D.2): betExceedsOpponentCeiling now means
        // specifically "not even $1 is possible" (see canBetOrRaise's
        // own comment) -- "(use All In)" is actively wrong advice in
        // that exact case (All-In would just get silently refunded),
        // so this label branch now distinguishes it from the OTHER
        // reason the button might be unusable (betWouldBeAllIn/
        // raiseCapReached), where "(use All In)" or a plain disabled
        // state remains the right label.
        el.btnPlaceBet.textContent = betExceedsOpponentCeiling ? verb : betUnusable ? `${verb} (use All In)` : verb;
      }
      el.btnPlaceBet.title = betWouldBeAllIn
        ? 'Any legal bet/raise here would commit your entire stack \u2014 use All In instead.'
        : betExceedsOpponentCeiling
          ? 'No player can cover any additional bets. You must Check to continue.'
          : raiseCapReached
            ? 'No more raises are allowed this round \u2014 the raise cap has been reached.'
            : 'Bet or raise to the entered total';

      // CHANGED 11.4 (Part D.3): All-In is disabled alongside Bet/Raise
      // in this exact state -- both are equally impossible to legally
      // complete (an All-In here would just get silently refunded by
      // _checkUncalledBetRefund() rather than genuinely committing
      // anything), so per the Standing Convention there's no reason to
      // leave it clickable only to bounce off that a moment later.
      if (isPhaseGatedProfile && !allInWouldBeRedundant && betExceedsOpponentCeiling) {
        el.btnAllIn.disabled = true;
        el.btnAllIn.title = 'No player can cover any additional bets. You must Check to continue.';
      }

      // NEW 9.0 (§6.10): "the betting UI should compute and display the
      // current legal minimum and maximum raise as live numbers whenever
      // it's the acting player's turn and raising is possible" -- the
      // spec's own UI-surfacing note. Hidden once Bet/Raise itself is
      // unusable since there's no legal range left to show.
      // CHANGED 9.2: Fixed-Limit's own amount now lives directly in the
      // button label (above) -- repeating it here would be redundant, so
      // this hint is now No-Limit/Pot-Limit only, where a genuine range
      // (not one deterministic number) actually needs surfacing.
      if (isPhaseGatedProfile && !betUnusable && !isFixedLimit) {
        el.raiseLimitsHint.hidden = false;
        el.raiseLimitsHint.textContent = `Legal: $${minLegalTotal}\u2013$${maxLegalTotal}`;
      } else {
        el.raiseLimitsHint.hidden = true;
      }
    } else {
      el.btnAllIn.hidden = true;
      el.raiseLimitsHint.hidden = true;
      el.betAmount.hidden = false; // reset for the next turn-actions render
    }

    // BUG FIX 5.2 (§5.8/§6.4): Fold has its own visibility, entirely
    // independent of showTurnActions -- it needs to render both during a
    // normal turn-gated betting round AND, separately, during Showdown
    // for any non-folded, non-sitting-out player regardless of turn.
    // (showFoldAtShowdown itself is computed once, at the top of this
    // function now, so it can also feed el.bettingRail's own gate above.)
    el.personalFoldAction.hidden = !(showTurnActions || showFoldAtShowdown);
    el.btnFold.disabled = false; // NEW 6.1 (§6.6) -- re-enabled fresh each render; see the click guard below
    el.btnFold.title = showTurnActions ? 'Fold your hand this round' : 'Fold your hand without revealing it';
    // NEW 7.0 (§6.8): the selected opening bettor's forced first action on
    // Stud's StreetABetting can't be folded -- mirrors the server-side
    // rejection in fold(), disabled here too so the click never round-trips.
    // Cleared the instant they act (call/raise), same moment
    // bringInObligationId itself clears server-side.
    if (gameTable.profile === 'stud' && gameTable.bringInObligationId === me.id) {
      el.btnFold.disabled = true;
      el.btnFold.title = "The Bring-In can't be folded -- call or raise.";
    }

    el.personalAnteAction.hidden = !showAnteAction;
    if (showAnteAction) {
      // NEW 8.3 (§10.2.1): preset-type-specific wording, replacing the
      // old generic "Ante/blind" hedge now that both variants have their
      // own precise text. `anteType: 'blind'` presets compare the owed
      // amount against smallBlind/bigBlind to determine which specific
      // blind this player owes -- unambiguous in every real
      // configuration, since blinds are auto-assigned per seat and a
      // given player owes exactly one or the other, never an arbitrary
      // amount (spec's own reasoning). `flat`/`manual` presets simplify
      // to plain "Ante" wording, dropping the "/blind" hedge entirely.
      if (gameTable.gameOptions?.anteType === 'blind') {
        const isSmallBlind = me.oweAnte === gameTable.gameOptions?.smallBlind;
        el.personalAnteLabel.textContent = `Blind owed: $${me.oweAnte}`;
        el.btnPostAnte.textContent = isSmallBlind ? 'Bet Small Blind' : 'Bet Big Blind';
        el.btnPostAnte.title = `Pay your owed ${isSmallBlind ? 'small' : 'big'} blind into the pot`;
      } else {
        el.personalAnteLabel.textContent = `Ante owed: $${me.oweAnte}`;
        el.btnPostAnte.textContent = 'Post Ante';
        el.btnPostAnte.title = 'Pay your owed ante into the pot';
      }
    }

    el.personalDiscardAction.hidden = !(showDiscardAction || showStandPatAction);
    el.btnDiscard.hidden = !showDiscardAction;
    el.btnStandPat.hidden = !showStandPatAction;
    if (showDiscardAction) {
      const maxDiscards = gameTable.gameOptions?.maxDiscards;
      el.personalDiscardLabel.textContent =
        typeof maxDiscards === 'number'
          ? `Click your cards to select (up to ${maxDiscards}), then Discard -- or Stand Pat to keep your hand as dealt.`
          : 'Click your cards to select, then Discard -- or Stand Pat to keep your hand as dealt.';
    }

    // NEW 8.1 (§5.11), CHANGED 8.2: Declare -- button TEXT is now
    // dynamic (declareOptions.a/b, §3), re-synced every render this
    // action is visible. "Both" stays the literal word always -- no
    // per-preset caption needed (spec's own wording).
    el.personalDeclareAction.hidden = !showDeclareAction;
    if (showDeclareAction) {
      const declareOptions = gameTable.gameOptions?.declareOptions;
      el.btnDeclareA.textContent = declareOptions?.a || 'A';
      el.btnDeclareA.title = `Declare ${declareOptions?.a || 'A'}`;
      el.btnDeclareB.textContent = declareOptions?.b || 'B';
      el.btnDeclareB.title = `Declare ${declareOptions?.b || 'B'}`;
    }

    // NEW 5.2 (§5.7): freshly re-sync the live Discard/Stand Pat
    // enablement on every render, not just on the click handler that
    // changes selection -- covers the case where a fresh DiscardPhase
    // begins with an empty selection (Stand Pat should already read as
    // the active choice from the very first render, not just after the
    // player clicks a card).
    updateDiscardButtonState();
  }

  function renderPlayerRail(gameTable, me) {
    if (!me) return;

    // NEW 9.2 (§10.2): the one-time hint clears the moment this
    // player's first hand in this room begins (RequestAntes entry) --
    // whichever happens first with the click handler above. Tracked
    // with a simple once-only flag; harmless to call repeatedly.
    if (gameTable.handPhase === 'RequestAntes' && !state.playerRailHintClearedByPhase) {
      state.playerRailHintClearedByPhase = true;
      clearPlayerRailHint();
    }

    el.ownChipReadout.innerHTML = '';
    const total = document.createElement('div');
    total.className = 'own-chip-total';
    total.textContent = `$${me.chips}`;
    const buyin = document.createElement('div');
    buyin.className = 'own-chip-buyin';
    buyin.textContent = `$${me.totalBuyIn} bought in total`;
    el.ownChipReadout.append(total, buyin);

    // NEW 11.0 (Part D): shown once known -- state.myReconnectCode is
    // set from the 'joined' message, which covers both an original join
    // and a reconnect (the code is the same one either way).
    el.ownReconnectCodeReadout.textContent = state.myReconnectCode
      ? `Your reconnect code: ${state.myReconnectCode} (if you get disconnected, use this to rejoin)`
      : '';

    if (me.sitInPending) {
      el.btnSitToggle.textContent = 'Rejoining next hand\u2026';
      el.btnSitToggle.disabled = true;
      el.btnSitToggle.title = "You'll be seated again automatically once the current hand wraps up.";
    } else {
      el.btnSitToggle.textContent = me.sittingOut ? 'Sit In' : 'Sit Out';
      el.btnSitToggle.disabled = false;
      el.btnSitToggle.title = me.sittingOut ? 'Rejoin the table' : 'Sit out for now';
    }
  }

  /**
   * NEW 10.4 (the-cut-spec_v10-4.md Part A §5): drives both the
   * Table-Owner-only entry point button and, when the dialog is open,
   * its full contents -- terminate/restore always available (idle-
   * independent, emergency tools), Distribution's begin/workspace
   * split on whether `pendingAllocationBatch` is currently populated
   * (null when no batch is open, per §3.1). The batch detail itself is
   * `null` for a non-owner by construction (server-side, see
   * toRedactedState's own comment) -- this function is a no-op render
   * for anyone but the Table Owner beyond hiding the entry point.
   */
  function renderTableOwnerControls(gameTable) {
    const isOwner = gameTable.creatorId === state.playerId;
    // NEW 11.0 (Part B): keep the Settings dialog's contents live if the
    // Table Owner happens to have it open while a broadcast arrives
    // (e.g. watching the reconnect-code list while someone's mid-disconnect).
    if (isOwner && el.settingsDialog.open) renderSettingsDialog(gameTable);
    // NEW 11.1: keep the Testing dialog's Force Disconnect list live too
    // (e.g. if a listed player disconnects on their own while the Table
    // Owner has this dialog open).
    if (isOwner && el.testingDialog.open) renderTestingDialog(gameTable);
    // FIXED 10.4 (the-cut-spec_v10-4.md, 10.4 Completion Gap 1): the
    // button itself is gated directly, not just its wrapping
    // `tableOwnerRailGroup` -- explicitly requested rather than relying
    // on the parent's `hidden` to cascade, and cheap enough that there's
    // no reason not to also do it directly.
    el.btnOpenTableOwnerDialog.hidden = !isOwner;
    el.tableOwnerRailGroup.hidden = !isOwner;
    el.tableOwnerSectionDivider.hidden = !isOwner; // FIXED (11.0 review finding #2)
    el.tableOwnerSectionLabel.hidden = !isOwner;
    if (!isOwner) return;

    // NEW 11.0 (Part F.2): Remove Player's target dropdown -- every
    // OTHER seated player (never includes the Table Owner themselves;
    // they'd use Leave Table for that). Rebuilt each render, same
    // simple-rebuild justification as toAllocPlayer's own comment.
    const previousRemoveSelection = el.toRemovePlayerSelect.value;
    el.toRemovePlayerSelect.innerHTML = '';
    for (const player of gameTable.players) {
      if (player.id === state.playerId) continue;
      const option = document.createElement('option');
      option.value = player.id;
      option.textContent = player.name;
      el.toRemovePlayerSelect.appendChild(option);
    }
    if ([...el.toRemovePlayerSelect.options].some((o) => o.value === previousRemoveSelection)) {
      el.toRemovePlayerSelect.value = previousRemoveSelection;
    }
    el.btnToRemovePlayer.disabled = el.toRemovePlayerSelect.options.length === 0;

    const batch = gameTable.pendingAllocationBatch;
    const idle = !!gameTable.idle;

    // Terminate/Restore: emergency tools, always available regardless of
    // idle state (that's the whole point -- they're what GETS the table
    // back to idle). No client-side gating beyond ownership.
    el.btnToTerminate.disabled = false;
    el.btnToRestore.disabled = false;

    // Distribution: gated to idle for both opening and every staging
    // edit, per Mike's own explicit confirmation (§3.2) -- these are
    // emergency unlock functions, always invoked at an already
    // (fatally) idle table.
    el.btnToBeginDistribution.hidden = !!batch;
    el.btnToBeginDistribution.disabled = !idle;
    el.btnToBeginDistribution.title = idle
      ? 'Start building a pot-distribution batch'
      : 'Only available while idle (no hand in progress)';
    el.toDistributionWorkspace.hidden = !batch;
    el.toDistributionHint.hidden = !!batch;

    if (!batch) return;

    el.toPreviewPotNow.textContent = String(gameTable.pot);
    el.toPreviewPotAfter.textContent = String(batch.previewPot);

    el.toAllocList.innerHTML = '';
    if (batch.allocations.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'to-alloc-empty';
      empty.textContent = 'Nothing staged yet.';
      el.toAllocList.appendChild(empty);
    }
    for (const entry of batch.allocations) {
      const player = gameTable.players.find((p) => p.id === entry.playerId);
      const row = document.createElement('div');
      row.className = 'to-alloc-row';
      const label = document.createElement('span');
      label.textContent = `${entry.direction === 'take' ? 'Take' : 'Give'} $${entry.amount} ${entry.direction === 'take' ? 'from' : 'to'} ${player ? player.name : entry.playerId}`;
      const btnRemove = document.createElement('button');
      btnRemove.type = 'button';
      btnRemove.className = 'btn btn-secondary btn-small';
      btnRemove.textContent = 'Remove';
      btnRemove.title = 'Remove this staged allocation';
      btnRemove.addEventListener('click', () => {
        send('removeStagedAllocation', { allocationId: entry.id });
      });
      row.append(label, btnRemove);
      el.toAllocList.appendChild(row);
    }

    // Player select for the add-allocation form -- rebuilt each render;
    // simple enough (no in-progress typed value to preserve, unlike
    // e.g. the ante/deal-target selects) that a full rebuild is fine.
    const previousPlayerSelection = el.toAllocPlayer.value;
    el.toAllocPlayer.innerHTML = '';
    for (const player of gameTable.players) {
      const option = document.createElement('option');
      option.value = player.id;
      option.textContent = player.name;
      el.toAllocPlayer.appendChild(option);
    }
    if ([...el.toAllocPlayer.options].some((o) => o.value === previousPlayerSelection)) {
      el.toAllocPlayer.value = previousPlayerSelection;
    }
  }

  /**
   * Single oval table: the viewer's seat is anchored bottom-center, every
   * other player fills the remaining perimeter positions in turn order
   * (going clockwise from the viewer). Own cards render face-up and are
   * click-selectable for Discard; every other seat renders `handCount`
   * face-down backs (or a revealed hand face-up).
   */
  function renderTable(gameTable) {
    const ordered = seatOrder(gameTable.players, state.playerId);
    const n = ordered.length;

    el.seats.innerHTML = '';
    ordered.forEach((player, i) => {
      el.seats.appendChild(buildSeat(player, i, n, gameTable));
    });
    updateDiscardButtonState();
  }

  /** Rotate the player list so the viewer is first; keep everyone else's relative order. */
  function seatOrder(players, viewerId) {
    const idx = players.findIndex((p) => p.id === viewerId);
    if (idx === -1) return players;
    return [...players.slice(idx), ...players.slice(0, idx)];
  }

  /**
   * Position i of n evenly around an ellipse, i=0 anchored at
   * bottom-center, going clockwise -- matching turnOrder's own single,
   * consistent traversal direction (also used by betting order, Pass
   * the Buck, and blind assignment).
   * BUG FIX 5.0 (§10.2): the sign on the x term was wrong -- despite this
   * same comment always claiming clockwise, the old formula actually
   * placed seats counterclockwise, so turn progression and Pass the Buck
   * both visually appeared to move to the Dealer's right even though the
   * underlying server-side turnOrder logic was internally consistent and
   * had never actually been wrong. One-line fix; no server-side change needed.
   */
  function seatPosition(i, n) {
    const RX = 44; // % of gametabletop-surface width
    const RY = 39; // % of gametabletop-surface height
    const theta = (i * 2 * Math.PI) / n;
    return {
      x: 50 - RX * Math.sin(theta),
      y: 50 + RY * Math.cos(theta),
    };
  }

  function buildSeat(player, i, n, gameTable) {
    const isYou = player.id === state.playerId;
    const { x, y } = seatPosition(i, n);

    // NEW 10.0 (the-cut-spec_v10-0.md §4.1): a player excluded from all
    // remaining pots after losing one needs its own visible state --
    // dimmed like Folded, but a genuinely distinct reason, so it must
    // not collapse into (or be masked by) the Folded state. Guarded on
    // `!player.folded` since Folded already covers the dimmed treatment
    // and takes display priority in the rare case both are true at once
    // (e.g. a lost-side-pot player later Sits Out via foldAndSitOut).
    const lostASidePot = !player.folded && (gameTable.provenLosers || []).includes(player.id);

    const seat = document.createElement('div');
    seat.className =
      'seat' +
      (player.id === gameTable.currentTurnPlayerId ? ' is-turn' : '') +
      (isYou ? ' is-you' : '') +
      (player.folded ? ' is-folded' : '') +
      (lostASidePot ? ' is-lost-side-pot' : '') +
      (player.sittingOut ? ' is-sitting-out' : '');
    seat.style.left = `${x}%`;
    seat.style.top = `${y}%`;

    const info = document.createElement('div');
    info.className = 'seat-info';

    // v4.2 §10.2: avatar removed (purely decorative). The Dealer marker
    // now lives in that slot -- content only for the Dealer's own seat,
    // an empty same-size spacer for everyone else, so the row stays aligned.
    const dealerMarker = document.createElement('span');
    dealerMarker.className = 'seat-dealer-marker' + (player.isDealer ? ' is-dealer' : '');
    if (player.isDealer) {
      dealerMarker.textContent = 'D';
      dealerMarker.title = `${player.name} is the Dealer`;
    }

    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = player.name + (isYou ? ' (you)' : '');

    const chips = document.createElement('span');
    chips.className = 'seat-chips';
    chips.textContent = `$${player.chips}`;

    info.append(dealerMarker, name, chips);
    if (player.allIn) {
      // NEW 9.0 (§3, §6.11): persistent seat badge for the rest of the
      // hand -- distinct from Folded, since an all-in player is
      // emphatically not folded and remains eligible for any pot(s)
      // they contributed to.
      const allInBadge = document.createElement('span');
      allInBadge.className = 'seat-allin-badge';
      allInBadge.title = `${player.name} is all in this hand`;
      allInBadge.textContent = 'All In';
      info.appendChild(allInBadge);
    }
    if (player.folded) {
      const foldedBadge = document.createElement('span');
      foldedBadge.className = 'seat-folded-badge';
      foldedBadge.title = `${player.name} has folded this round`;
      foldedBadge.textContent = 'Folded';
      info.appendChild(foldedBadge);
    }
    if (lostASidePot) {
      // NEW 10.0 (the-cut-spec_v10-0.md §4.1): its own badge, not the
      // Folded one -- the underlying reason differs (didn't win a pot vs.
      // voluntarily/forced out) even though acting/claiming restrictions
      // match Folded exactly.
      const lostPotBadge = document.createElement('span');
      lostPotBadge.className = 'seat-lost-pot-badge';
      lostPotBadge.title = `${player.name} didn't win a portion of a pot this hand and is out of the rest of it`;
      lostPotBadge.textContent = 'Out of Hand';
      info.appendChild(lostPotBadge);
    }
    if (player.connected === false) {
      // NEW 11.0 (Part A/B/G): a disconnected Player who hasn't yet hit
      // their grace-period expiry. Distinct from the "Sitting Out"
      // badge below, which fires only once the grace period actually
      // runs out -- this is the "still waiting for them" state. Reads
      // the server-computed deadline directly (Standing Convention),
      // never re-derives it from a locally-ticking clock.
      const disconnectedBadge = document.createElement('span');
      disconnectedBadge.className = 'seat-sitting-out-badge seat-disconnected-badge';
      // CHANGED 11.4 (Part B): the deadline/name are stashed on the
      // element itself so updateDisconnectedBadgeText()'s own dedicated
      // 1s ticker (below) can refresh just this badge's text/title
      // directly, independent of whether anything else at the table
      // happens to trigger a fresh gameTableState broadcast in the
      // meantime -- confirmed live: the badge was freezing at its
      // initial value and jumping straight to 0 at expiry otherwise,
      // since nothing else may broadcast while everyone's simply
      // waiting on the one disconnected player.
      disconnectedBadge.dataset.disconnectDeadline = String(player.disconnectDeadline);
      disconnectedBadge.dataset.playerName = player.name;
      updateDisconnectedBadgeText(disconnectedBadge);
      info.appendChild(disconnectedBadge);
    }
    if (player.pendingDeparture) {
      // NEW 11.0 (Part F.4): takes priority over the plain Sitting Out
      // badge below -- they're sittingOut===true underneath (reusing
      // that machinery, see _deferDeparture()'s own comment), but this
      // is the more accurate status: they're not coming back.
      const departureBadge = document.createElement('span');
      departureBadge.className = 'seat-sitting-out-badge';
      departureBadge.title = `${player.name} will leave the table once the current cycle closes`;
      departureBadge.textContent = 'Leaving Table';
      info.appendChild(departureBadge);
    } else if (player.sitInPending) {
      // v4.2 §9: takes priority over the plain "Sitting Out" badge --
      // they're still sittingOut===true underneath, but visually this is
      // the more accurate, more reassuring status.
      const returningBadge = document.createElement('span');
      returningBadge.className = 'seat-sitting-out-badge';
      returningBadge.title = `${player.name} will rejoin at the start of the next hand`;
      returningBadge.textContent = 'Returning Next Hand';
      info.appendChild(returningBadge);
    } else if (player.sittingOut) {
      // CORRECTED 9.6 (§9): sittingOut now means ONLY a voluntary Sit
      // Out or a disconnect -- a $0-chip player is a separate, distinct
      // condition (below), never sittingOut. The 9.2-era "Buy chips to
      // rejoin" special case that used to live in THIS branch is gone;
      // it could never fire correctly here anymore.
      const sittingBadge = document.createElement('span');
      sittingBadge.className = 'seat-sitting-out-badge';
      sittingBadge.title = `${player.name} is sitting out`;
      sittingBadge.textContent = 'Sitting Out';
      info.appendChild(sittingBadge);
    } else if (player.excludedForZeroChips) {
      // NEW 9.6 (§9): a distinct badge for the $0-chips case -- reads
      // the server's own computed signal directly (toRedactedState),
      // rather than re-deriving "excluded because of $0 chips" from
      // chips/allIn/folded/sittingOut itself on the client.
      const zeroChipsBadge = document.createElement('span');
      zeroChipsBadge.className = 'seat-sitting-out-badge';
      zeroChipsBadge.title = `${player.name} has $0 chips -- buying in returns them to the table automatically`;
      zeroChipsBadge.textContent = 'Buy chips to rejoin';
      info.appendChild(zeroChipsBadge);
    }
    if (player.oweAnte > 0) {
      const anteBadge = document.createElement('span');
      anteBadge.className = 'seat-ante-badge';
      anteBadge.title = `${player.name} owes an ante/blind of $${player.oweAnte}`;
      anteBadge.textContent = `Owes $${player.oweAnte}`;
      info.appendChild(anteBadge);
    }
    if (isYou && !player.revealed && (player.handCount || 0) > 0) {
      const showBtn = document.createElement('button');
      showBtn.className = 'seat-show-cards';
      showBtn.type = 'button';
      showBtn.title = 'Reveal your hand to everyone at the table';
      showBtn.textContent = 'Show Cards';
      showBtn.addEventListener('click', () => {
        hideTableError();
        send('revealHand');
      });
      info.appendChild(showBtn);
    }
    if (player.revealed) {
      const revealedBadge = document.createElement('span');
      revealedBadge.className = 'seat-revealed-badge';
      revealedBadge.title = `${player.name} has shown their hand`;
      revealedBadge.textContent = 'Revealed';
      info.appendChild(revealedBadge);
    }

    const buyin = document.createElement('div');
    buyin.className = 'seat-buyin';
    buyin.textContent = `$${player.totalBuyIn} bought in`;

    // v4.0: the server always sends a `hand` array now, per-card redacted --
    // a hidden card is a bare { faceUp:false } stub, a visible one (yours,
    // revealed, or a Stud up-card) carries real suit/rank/id. One unified
    // per-card path replaces the old whole-hand isYou/revealed branching.
    const handEl = document.createElement('div');
    handEl.className = 'seat-hand';
    const hand = player.hand || [];
    hand.forEach((entry, idx) => {
      const isRealCard = entry && typeof entry.suit === 'string';
      const cardEl = isRealCard ? renderCard(entry, idx, hand.length) : renderCardBack(idx, hand.length);
      if (isYou && isRealCard) {
        cardEl.classList.add('is-selectable');
        cardEl.title = 'Click to select for Discard';
        if (state.discardSelection.has(entry.id)) cardEl.classList.add('is-selected-discard');
        cardEl.addEventListener('click', () => toggleDiscardSelection(entry.id, cardEl));
      }
      handEl.appendChild(cardEl);
    });

    // Discard pile visual (v4.1 §10.5): face-down count only, separate
    // from the kept hand, swept away the moment this seat is redealt.
    // CHANGED 5.0 (§5.7): a player who Stood Pat gets the literal text
    // "Stand Pat" in this same slot instead -- there's no count to show,
    // just the declaration itself, visible to everyone at the table.
    const muckEl = document.createElement('div');
    muckEl.className = 'seat-muck';
    if (player.standingPat) {
      muckEl.classList.add('seat-stand-pat');
      muckEl.textContent = 'Stand Pat';
      muckEl.title = `${player.name} is standing pat -- keeping their hand as dealt`;
    } else if (player.mucked > 0) {
      const muckCards = document.createElement('div');
      muckCards.className = 'seat-muck-cards';
      const visibleCount = Math.min(player.mucked, 3);
      for (let c = 0; c < visibleCount; c++) {
        muckCards.appendChild(renderCardBack(c, visibleCount));
      }
      const muckCount = document.createElement('span');
      muckCount.className = 'seat-muck-count';
      muckCount.textContent = `${player.mucked} discarded`;
      muckEl.title = `${player.name} discarded ${player.mucked} card${player.mucked === 1 ? '' : 's'} this hand`;
      muckEl.append(muckCards, muckCount);
    }

    // NEW 8.2 (§5.11): the declaration label -- IMPLEMENTED here for the
    // first time; 8.1 stored `declaration` correctly but never surfaced
    // it anywhere on screen. Same visibility rule as the revealed hand
    // itself (server already redacts `player.declaration` to null for
    // anyone who hasn't used Show Cards, §3) -- a player who never shows
    // simply has no label here at all (blank, not "Undeclared"), same
    // reasoning as an unshown hand not being eligible for a Claim Pot
    // allocation either. Reads its caption from the active preset's
    // declareOptions.a/b (§3) -- "Both" is always the literal word.
    const declareEl = document.createElement('div');
    declareEl.className = 'seat-declaration';
    if (player.declaration) {
      const declareOptions = gameTable.gameOptions?.declareOptions;
      const captionMap = { a: declareOptions?.a, b: declareOptions?.b, both: 'Both' };
      const caption = captionMap[player.declaration] || player.declaration;
      declareEl.textContent = `Declared: ${caption}`;
      declareEl.title = `${player.name} declared "${caption}"`;
    }

    seat.append(info, buyin, handEl, muckEl, declareEl);
    return seat;
  }

  function renderCard(card, index, total) {
    const div = document.createElement('div');
    const isRed = RED_SUITS.has(card.suit);
    // card.faceUp true means this specific card is visible to the whole
    // table (a Stud up-card, or your own card dealt face-up) -- a subtle
    // visual cue distinct from "you can see it because it's your hand".
    // NEW 7.1, REVISED 7.2 (§10.2): the down-card marker is the mirror
    // case -- any currently-visible card that WAS dealt face-down
    // (faceUp === false) gets its own distinct treatment (a solid dot in
    // the bottom-left corner, see .card--down in style.css) so it reads
    // as a real system alongside the public marker, not a variant of it.
    // No server change needed -- faceUp is already set once at deal time
    // and never mutated, including through reveal.
    const visibilityClass = card.faceUp ? ' card--public' : ' card--down';
    div.className = 'card' + (isRed ? ' is-red' : '') + visibilityClass;
    div.style.setProperty('--tilt', `${fanTilt(index, total)}deg`);

    const rankLabel = card.rank || SUIT_GLYPH.joker;
    const glyph = SUIT_GLYPH[card.suit] || '';

    const top = document.createElement('div');
    top.className = 'card-index';
    top.innerHTML = `<span>${rankLabel}</span>`;

    const center = document.createElement('div');
    center.className = 'card-suit-glyph';
    center.textContent = glyph;

    const bottom = document.createElement('div');
    bottom.className = 'card-index bottom';
    bottom.innerHTML = `<span>${rankLabel}</span>`;

    div.append(top, center, bottom);
    return div;
  }

  /** Face-down equivalent of renderCard -- never carries rank/suit data. */
  function renderCardBack(index, total) {
    const div = document.createElement('div');
    div.className = 'card-back';
    div.style.setProperty('--tilt', `${fanTilt(index, total)}deg`);

    const mark = document.createElement('span');
    mark.className = 'card-back-mark';
    mark.textContent = SUIT_GLYPH.clubs;
    div.appendChild(mark);
    return div;
  }

  function fanTilt(index, total) {
    const mid = (total - 1) / 2;
    return (index - mid) * 4;
  }

  function toggleDiscardSelection(cardId, cardEl) {
    if (state.discardSelection.has(cardId)) {
      state.discardSelection.delete(cardId);
      cardEl.classList.remove('is-selected-discard');
    } else {
      state.discardSelection.add(cardId);
      cardEl.classList.add('is-selected-discard');
    }
    updateDiscardButtonState();
  }

  /**
   * NEW 5.2 (§5.7): live-reflects the player's current, unsubmitted card
   * selection -- 0 selected means Stand Pat is the valid action (Discard
   * would be rejected server-side, since its minimum is 1 card); 1+
   * selected means Discard is. Purely a client-side enablement rule (no
   * new server behavior) that keeps a player from clicking into an error
   * the server would otherwise correctly reject.
   */
  function updateDiscardButtonState() {
    const count = state.discardSelection.size;
    el.btnDiscard.disabled = count === 0;
    el.btnDiscard.textContent = count > 0 ? `Discard (${count})` : 'Discard';
    if (!el.btnStandPat.hidden) el.btnStandPat.disabled = count > 0;
  }

  const ALL_PLAYERS_VALUE = ''; // sentinel for the "All Players" option in dealTargetSelect

  /**
   * NEW 5.0: dispatcher. Draw runs on the phase machine (§5.8);
   * everything else keeps the pre-5.0 flexible-toolbox model untouched.
   * Same Game's visibility lives in renderGameRail() instead of here --
   * see the BUG FIX note there for why (this function early-returns for
   * non-Dealers, which is exactly what broke it previously).
   * NEW 5.2 (§5.8, resolves §14.4): before any Game Choice is selected,
   * the rail shows only Pass the Buck -- checked first, since `profile`
   * isn't known yet at this point (no choice picked) and this treatment
   * applies uniformly no matter which profile ends up chosen.
   */
  // NEW 8.0 (ARCHITECTURE_v8.md §7 item 1): every control that
  // applyPendingClaimLock() can lock, listed once, here. This is what
  // makes the missing-disabled-reset bug class (Hold'em's Flop button
  // 6.2, Stud's Select Opening Bettor 7.1, New Hand 7.2) structurally
  // impossible going forward -- see renderDealerRail() below for how.
  function lockableControls() {
    return [el.btnNewHand, el.btnDeal, el.btnDealToPlayer, el.btnOpenBetting, el.btnDealCommunity, el.btnReshuffle, el.btnPassBuck, el.openingBettorSelect];
  }

  function renderDealerRail(gameTable, isDealer) {
    el.dealerRail.hidden = !isDealer;
    if (!isDealer) return;

    // STRUCTURAL FIX 8.0 (ARCHITECTURE_v8.md §7 item 1): every lockable
    // control resets to enabled HERE, unconditionally, before any
    // profile-specific rendering runs -- the one choke point every
    // subsequent render passes through, regardless of profile. Prior to
    // 8.0, each profile's rail-render function had to individually
    // remember to reset a control's `disabled` state back to false once
    // whatever had disabled it no longer applied -- forgetting that,
    // three separate times (6.2, 7.1, 7.2), was always the actual bug.
    // Now every render starts from a clean baseline: profile-specific
    // code below is free to disable a control for its own real reasons
    // (wrong phase, no opening bettor selected yet, etc.), but never has
    // to remember to RE-enable one. applyPendingClaimLock(), called last
    // via each render path, is the only thing that can lock a control
    // back down -- and since a cleared pendingClaim just means it's
    // never called, nothing needs a separate unlock step either.
    for (const control of lockableControls()) control.disabled = false;

    if (!gameTable.gameChoiceId) {
      renderPassTheBuckOnlyRail(gameTable);
    } else {
      const table = window.RAIL_TABLES[gameTable.profile];
      if (table) {
        renderPhaseGatedRail(gameTable, table);
      } else {
        renderFlexibleToolboxRail(gameTable);
      }
    }

    // NEW 10.4 (B.2 replacement / 10.4 Completion Gap 2): cross-cutting,
    // not profile-specific -- applied unconditionally after whichever
    // branch above ran, rather than duplicated into railTables.js's
    // three per-profile tables plus the flexible-toolbox renderer.
    // Reads `stuckAntePlayerIds` directly (server-computed) rather than
    // re-deriving "who's stuck" from oweAnte/chips client-side, per the
    // Standing Convention.
    const stuckIds = gameTable.stuckAntePlayerIds || [];
    el.misdealGroup.hidden = stuckIds.length === 0;
    if (stuckIds.length > 0) {
      const names = stuckIds.map((id) => gameTable.players.find((p) => p.id === id)?.name || id).join(', ');
      el.btnMisdeal.title = `${names} ${stuckIds.length === 1 ? 'owes' : 'owe'} more than they can post -- misdeal this hand`;
    }
  }

  /**
   * NEW 5.2 (§5.8): before any Game Choice is selected, everything is
   * hidden except Pass the Buck -- previously this fell through to the
   * pre-5.0 flexible-toolbox rail (since `gameTable.profile !== 'draw'` is
   * also true before a choice is made), showing Deal, Open Betting
   * Round, Reshuffle, Advance Turn, and Burn all at once with nothing
   * to actually act on yet.
   */
  function renderPassTheBuckOnlyRail(gameTable) {
    el.rabbitHuntGroup.hidden = true;
    el.dealSectionDivider.hidden = true;
    el.dealGroup.hidden = true;
    el.newHandGroup.hidden = true;
    el.drawSectionDivider.hidden = true;
    el.dealToPlayerGroup.hidden = true;
    el.dealCommunityGroup.hidden = true;
    el.bettingSectionDivider.hidden = true;
    el.setAnteGroup.hidden = true;
    el.openBettingGroup.hidden = true;
    el.openingBettorGroup.hidden = true;
    el.gameSectionDivider.hidden = true;
    el.reshuffleAdvanceTurnGroup.hidden = true;
    el.btnBurn.hidden = true;

    el.passBuckGroup.hidden = false;
    el.btnPassBuck.disabled = !gameTable.idle;
    el.btnPassBuck.title = gameTable.idle
      ? 'Move the Dealer role to the next active seat'
      : 'Only available between hands (no hand in progress)';
    applyPendingClaimLock(gameTable);
  }

  /**
   * NEW 6.1 (§6.5), CHANGED 8.0: while a claim is pending approval,
   * every Dealer's Rail action locks -- New Hand, Deal/Draw, Open
   * Betting Round, Deal Community Cards, Reshuffle, Pass the Buck, and
   * (7.0) Stud's Select Opening Bettor -- across every profile, since
   * `pendingClaim` is a gameTable-level concept, not tied to `handPhase`.
   * Pass the Buck is deliberately included, per Mike's call, to avoid
   * the confusion of the Dealer role visibly changing mid-claim even
   * though the approver itself wouldn't actually be affected. Called at
   * the end of every Dealer's Rail render path; Same Game/Select live
   * on the Game Rail instead, so renderGameRail applies this same check
   * separately. The Approve/Reject buttons on the claim banner are
   * exempt by construction -- they're never part of this function.
   * CHANGED 8.0: this function's role narrows to LOCKING only -- it
   * never needs to unlock anything anymore, since renderDealerRail()
   * already resets every control to enabled before any profile-specific
   * code (including this) runs. Still called from every render path,
   * still the only place `disabled = true` for these reasons happens.
   */
  function applyPendingClaimLock(gameTable) {
    if (!gameTable.pendingClaim) return;
    for (const control of lockableControls()) control.disabled = true;
  }

  /** Shared between both rail modes -- ante target list is profile-agnostic. */
  /**
   * NEW 7.1 (§10.6): shared by Draw/Hold'em/Stud's rail functions --
   * hides the now-non-editable count input and labels the Deal button
   * with the exact count it's about to send, computed from the active
   * preset (and, for Stud, the current street) rather than left for the
   * Dealer to type. Stashes the count on the button itself so the click
   * handler can read it without re-deriving it.
   */
  function setAutoDealCount(n) {
    el.cardsPerPlayer.hidden = true;
    el.btnDeal.dataset.autoCount = String(n);
    el.btnDeal.textContent = `Deal ${n} Card${n === 1 ? '' : 's'}`;
  }

  function populateAnteTargetSelect(gameTable) {
    el.anteTargetSelect.innerHTML = '';
    for (const player of gameTable.players) {
      const option = document.createElement('option');
      option.value = player.id;
      option.textContent = player.name;
      el.anteTargetSelect.appendChild(option);
    }
  }

  /**
   * Shared between both rail modes. NEW 4.4 §5.2: "All Players" is the
   * default first entry; the count override only applies to a specific
   * pick. Preserves the Dealer's current selection across re-renders
   * (e.g. another player's fold status changing) rather than silently
   * resetting back to All Players every time.
   */
  function populateDealTargetSelect(gameTable) {
    const previousDealTarget = el.dealTargetSelect.value;
    el.dealTargetSelect.innerHTML = '';
    const allPlayersOption = document.createElement('option');
    allPlayersOption.value = ALL_PLAYERS_VALUE;
    allPlayersOption.textContent = 'All Players';
    el.dealTargetSelect.appendChild(allPlayersOption);
    for (const player of gameTable.players) {
      if (!player.folded) {
        const option = document.createElement('option');
        option.value = player.id;
        option.textContent = player.name + (player.id === state.playerId ? ' (you)' : '');
        el.dealTargetSelect.appendChild(option);
      }
    }
    const stillValid = [...el.dealTargetSelect.options].some((o) => o.value === previousDealTarget);
    el.dealTargetSelect.value = stillValid ? previousDealTarget : ALL_PLAYERS_VALUE;
    el.dealTargetCount.disabled = el.dealTargetSelect.value === ALL_PLAYERS_VALUE;
  }

  /**
   * NEW 8.0 (ARCHITECTURE_v8.md \u00a72): the single generic Dealer's Rail
   * renderer for every phase-gated profile (Draw, Hold'em, Stud) --
   * replaces the three separate renderDrawPhaseRail/renderHoldemPhaseRail/
   * renderStudPhaseRail functions. Consumes `table.phaseView(gameTable)`
   * (public/js/railTables.js) for the genuinely profile-specific content
   * (what Deal/New Hand/Open Betting/etc. mean for the CURRENT phase),
   * and computes the handful of rules that are byte-identical across all
   * three profiles -- rabbitHuntGroup, Pass the Buck, Set Ante/Blind,
   * and "never relevant to any phase-gated profile" (Advance Turn, Burn,
   * Reshuffle) -- directly here, once, rather than duplicated three times.
   */
  function renderPhaseGatedRail(gameTable, table) {
    const view = table.phaseView(gameTable) || {};
    const phase = gameTable.handPhase;

    el.rabbitHuntGroup.hidden = !gameTable.rabbitHuntAvailable;

    // Never relevant to any phase-gated profile. The four dividers and
    // four-section grouping from 4.3/4.4 are retired along with them
    // (\u00a710.8, RETIRED 5.0) -- with normally only one phase's controls
    // visible at a time, they no longer serve their original purpose of
    // separating a crowded rail. The standalone Shuffle button is
    // suppressed entirely as of 5.0 (\u00a74.1/\u00a76.2/\u00a710.8) -- using it ad
    // hoc could desync handPhase from reality now that phase is a real,
    // server-enforced concept. Advance Turn/Burn: advanceTurnRequired is
    // always false for every Draw preset so far, and burn-before-street
    // is an open question for Hold'em/Stud, not implemented (\u00a714).
    el.dealSectionDivider.hidden = true;
    el.drawSectionDivider.hidden = true;
    el.bettingSectionDivider.hidden = true;
    el.gameSectionDivider.hidden = true;
    el.btnAdvanceTurn.hidden = true;
    el.btnBurn.hidden = true;
    el.reshuffleAdvanceTurnGroup.hidden = true;

    // Pass the Buck: PreGame/CycleComplete only (\u00a76.3), identical rule
    // and text for every phase-gated profile.
    const passBuckAvailable = phase === 'PreGame' || phase === 'CycleComplete';
    el.passBuckGroup.hidden = !passBuckAvailable;
    el.btnPassBuck.disabled = !passBuckAvailable;
    el.btnPassBuck.title = passBuckAvailable
      ? 'Move the Dealer role to the next active seat'
      : 'Only available between hands (no hand in progress)';

    // Set Ante/Blind (manual ante type): only actionable during
    // RequestAntes, identical rule for every phase-gated profile.
    el.setAnteGroup.hidden = !(gameTable.gameOptions?.anteType === 'manual' && phase === 'RequestAntes');
    populateAnteTargetSelect(gameTable);

    // Deal (hand cards) -- RequestAntes/OpeningDeal for Draw,
    // RequestAntes/PreFlop for Hold'em, RequestAntes/StreetX for Stud.
    // CHANGED 8.0 (\u00a710.6 regression fix): `view.deal` is now returned
    // for RequestAntes unconditionally by every profile's phaseView(),
    // with its own real count -- not nested inside an "is a deal phase
    // currently active" check the way Stud's 7.1 fix accidentally was.
    // That's what makes the v7.2 regression (Stud's RequestAntes still
    // showing the retired editable input) structurally resolved here,
    // not just patched again: a table keyed on every handPhase needs an
    // explicit RequestAntes entry from the start.
    el.dealGroup.hidden = !view.deal?.visible;
    if (view.deal?.visible) {
      el.btnDeal.disabled = !view.deal.active;
      el.btnDeal.title = view.deal.title || '';
      if (typeof view.deal.count === 'number') setAutoDealCount(view.deal.count);
    }

    // New Hand / Kill Hand (§6.9). `view.newHand` is either a plain
    // boolean (Draw -- always the ordinary style) or an object
    // `{visible, style, killCard}` (Stud -- may be the restyled,
    // confirmation-gated Kill Hand variant). Normalized here so the rest
    // of this block is uniform either way. `dataset.killCard` (cleared
    // to '' for the ordinary style) is what the click handler reads to
    // decide whether to show the confirmation dialog.
    const newHandView = view.newHand;
    const newHandVisible = typeof newHandView === 'object' ? !!newHandView?.visible : !!newHandView;
    const isKillHand = typeof newHandView === 'object' && newHandView?.style === 'kill';
    el.newHandGroup.hidden = !newHandVisible;
    if (newHandVisible) {
      el.btnNewHand.classList.toggle('btn-kill-hand', isKillHand);
      el.btnNewHand.classList.toggle('btn-primary', !isKillHand);
      el.btnNewHand.textContent = isKillHand ? 'Kill Hand' : 'New Hand';
      el.btnNewHand.title = isKillHand
        ? 'End this hand because the kill card appeared \u2014 requires confirmation'
        : 'Reshuffle and request a fresh ante for another Hand in this Cycle';
      el.btnNewHand.dataset.killCard = isKillHand ? newHandView.killCard || '' : '';
      // CHANGED 11.0 (Part I/Standing Convention): also disabled while
      // anyone's disconnected -- newHand() itself now rejects this
      // server-side; the client reads the same server-computed answer.
      if (gameTable.anyoneDisconnected) {
        el.btnNewHand.disabled = true;
        el.btnNewHand.title = 'Waiting for a disconnected player to reconnect (or for their grace period to expire) before starting a new hand';
      }
    }
    // NEW 8.2 (§6.9): Kill Hand repositioned to the very bottom of the
    // Dealer's Rail, separated from the last ordinary button by generous
    // spacing -- found in 8.1 testing to sit too close to routine
    // controls, risking an accidental click given how destructive the
    // action is. `#new-hand-group` shares one DOM element with the
    // ORDINARY New Hand button (only the styling/text/title differ,
    // above) -- rather than duplicate the markup, this physically
    // re-parents the same element to the end of the rail specifically
    // when in Kill Hand's restyled state, and restores it to its natural
    // early position (right after Deal) otherwise. `.kill-hand-position`
    // supplies the actual spacing (CSS); appendChild on an
    // already-attached node just moves it, no clone needed, and is cheap
    // enough to do unconditionally on every render.
    el.newHandGroup.classList.toggle('kill-hand-position', isKillHand);
    if (isKillHand) {
      el.dealerRail.appendChild(el.newHandGroup);
    } else if (el.newHandGroup.nextSibling !== el.drawSectionDivider) {
      el.dealerRail.insertBefore(el.newHandGroup, el.drawSectionDivider);
    }

    // Draw's "Draw" button -- reuses the dealToPlayerGroup markup,
    // relabeled. Never applies to Hold'em/Stud.
    el.dealToPlayerGroup.hidden = !view.drawGroup?.visible;
    if (view.drawGroup?.visible) {
      el.dealTargetSelect.hidden = true;
      el.dealTargetCount.hidden = true;
      el.btnDealToPlayer.textContent = 'Draw';
      el.btnDealToPlayer.disabled = !view.drawGroup.active;
    }

    // Hold'em's community cards -- Flop/Turn/River, relabeled per
    // street; no manual count override. Never applies to Draw/Stud.
    el.dealCommunityGroup.hidden = !view.dealCommunity?.visible;
    if (view.dealCommunity?.visible) {
      el.dealCommunityCount.hidden = true;
      el.btnDealCommunity.textContent = view.dealCommunity.label;
      el.btnDealCommunity.title = `Deal ${view.dealCommunity.label}`;
    }

    // Open Betting Round.
    el.openBettingGroup.hidden = !view.openBetting?.visible;
    if (view.openBetting?.visible) {
      el.btnOpenBetting.disabled = !(view.openBetting.enabled ?? true);
      el.btnOpenBetting.title = view.openBetting.title || 'Open a new betting round';
      el.btnOpenBetting.textContent = 'Open Betting Round';
    }

    // Stud's Select Opening Bettor (\u00a76.8). Never applies to Draw/Hold'em.
    el.openingBettorGroup.hidden = !view.openingBettor?.visible;
    if (view.openingBettor?.visible) {
      el.openingBettorHint.textContent = view.openingBettor.hint;
      populateOpeningBettorSelect(gameTable);
    }

    applyPendingClaimLock(gameTable);
  }

  /**
   * CHANGED 10.1 (the-cut-spec_v10-1.md §8.2, defect 5): reads
   * `gameTable.eligibleOpeningBettorIds` directly -- the server's own
   * _canAct() answer -- instead of independently re-deriving the same
   * eligibility from folded/sittingOut/allIn/bettingCapped. That
   * re-derivation was confirmed live to have drifted from the server's
   * own check (missing the "was this Player actually dealt into the
   * current hand" condition), letting a Dealer select a never-dealt
   * $0-chip Player here and have the server actually accept it. Per
   * §8.2's client requirement, this function no longer inspects any
   * individual status field at all -- it only reads the precomputed list.
   */
  function populateOpeningBettorSelect(gameTable) {
    el.openingBettorSelect.innerHTML = '';
    const blankOption = document.createElement('option');
    blankOption.value = '';
    blankOption.textContent = '\u2014 Select \u2014';
    el.openingBettorSelect.appendChild(blankOption);
    const eligibleIds = gameTable.eligibleOpeningBettorIds || [];
    for (const player of gameTable.players) {
      if (eligibleIds.includes(player.id)) {
        const option = document.createElement('option');
        option.value = player.id;
        option.textContent = player.name + (player.id === state.playerId ? ' (you)' : '');
        el.openingBettorSelect.appendChild(option);
      }
    }
    el.openingBettorSelect.value = gameTable.openingBettorId || '';
  }


  /** Pre-5.0 flexible-toolbox model -- now only reachable when no Game Choice is active at all, since Draw, Hold'em, and (NEW 7.0) Stud all run their own phase-gated rail. Kept for that edge case and any future profile that doesn't adopt the phase machine. */
  function renderFlexibleToolboxRail(gameTable) {
    el.openBettingGroup.hidden = false;
    el.openingBettorGroup.hidden = true; // Stud-only (§6.8) -- Stud never reaches this function as of 7.0
    el.btnOpenBetting.disabled = gameTable.bettingOpen;
    el.btnOpenBetting.textContent = gameTable.bettingOpen ? 'Betting Round Open' : 'Open Betting Round';

    // v4.0 §10.1: profile-gated primitives. Stud never reaches this
    // function as of 7.0 (it has its own phase rail), so these checks are
    // now effectively dead for a gameTable with an active Game Choice -- kept
    // as-is since a gameTable with NO Game Choice at all can still land here.
    // RETIRED 7.2: the face-up/face-down override dropdown itself is gone
    // (§6.8) -- no element left to hide/show here.
    el.dealCommunityGroup.hidden = gameTable.profile !== 'holdem';

    // v4.2 §10.4: gated per the active preset's flags.
    el.btnAdvanceTurn.hidden = !gameTable.advanceTurnRequired;
    el.btnBurn.hidden = !gameTable.burnAvailable;
    el.setAnteGroup.hidden = gameTable.gameOptions?.anteType !== 'manual';

    el.rabbitHuntGroup.hidden = !gameTable.rabbitHuntAvailable;
    el.newHandGroup.hidden = true; // New Hand belongs to the phase machine now (Draw/Stud, §5.8/§5.10)

    el.dealGroup.hidden = false;
    el.btnDeal.disabled = false;
    el.btnDeal.title = 'Deal cards to every active player';
    // UNCHANGED 7.1: this is the one remaining path where the count stays
    // editable -- a gameTable with no Game Choice at all has no preset to
    // determine a count from, so there's nothing to auto-derive.
    el.cardsPerPlayer.hidden = false;
    delete el.btnDeal.dataset.autoCount;
    el.btnDeal.textContent = 'Deal';
    el.btnDealToPlayer.textContent = 'Deal';

    el.dealToPlayerGroup.hidden = gameTable.profile !== 'stud'; // dead as of 7.0 (Stud never reaches this function) but harmless
    el.dealTargetSelect.hidden = false;
    el.dealTargetCount.hidden = false;

    el.dealSectionDivider.hidden = true;
    el.drawSectionDivider.hidden = true;
    el.bettingSectionDivider.hidden = true;
    el.gameSectionDivider.hidden = true;
    el.reshuffleAdvanceTurnGroup.hidden = false;
    el.btnReshuffle.textContent = 'Reshuffle';

    if (gameTable.idle && document.activeElement !== el.cardsPerPlayer && typeof gameTable.gameOptions?.cardsPerPlayer === 'number') {
      el.cardsPerPlayer.value = gameTable.gameOptions.cardsPerPlayer;
    }

    populateAnteTargetSelect(gameTable);
    populateDealTargetSelect(gameTable);
    el.btnDealToPlayer.disabled = el.dealTargetSelect.options.length <= 1;

    el.passBuckGroup.hidden = false;
    el.btnPassBuck.disabled = !gameTable.idle;
    el.btnPassBuck.title = gameTable.idle
      ? 'Move the Dealer role to the next active seat'
      : 'Only available between hands (no hand in progress)';
    applyPendingClaimLock(gameTable);
  }

  /** Fetched once from the static file the server also loads at startup (single source of truth). */
  function loadGameChoices() {
    fetch('/game-choices.json')
      .then((r) => r.json())
      .then((data) => {
        state.gameChoices = data;
      })
      .catch(() => {
        // Non-fatal: the Game Choice selector/rules modal will just stay
        // empty. Core dealing/betting works fine without this data.
      });
  }

  /** Fetched once for the About modal (v4.1 §10.7). */
  function loadAppInfo() {
    fetch('/app-info.json')
      .then((r) => r.json())
      .then((data) => {
        state.appInfo = data;
      })
      .catch(() => {
        // Non-fatal: About will just show "unavailable."
      });
  }

  /**
   * NEW 9.6 (§10.4.2): every dialog in the app is draggable, universal
   * scope -- Options, Buy Chips, Game Rules, and every confirmation
   * dialog (Kill Hand, All-In, Baseball's interrupts, claim approval)
   * alike, one consistent behavior everywhere rather than different
   * rules per dialog. Implemented once, generically, over every
   * `dialog.chip-dialog` in the document, rather than wiring each of
   * the 13 dialogs individually -- native HTML `<dialog>` elements
   * aren't draggable out of the box, so this is genuinely new
   * pointer-event tracking, not a CSS-only fix.
   *
   * The drag-handle region is each dialog's own `<h3>` title -- a
   * dedicated strip at the top, never the dialog body -- so a drag
   * gesture can never be accidentally triggered by clicking a button, a
   * text field, or any other interactive control the dialog contains.
   *
   * Position resets to centered every time a dialog opens fresh (a
   * reasonable default, not explicitly confirmed with Mike -- flagged
   * in the 9.6 README for correction if a different behavior is
   * wanted). The simplest correct place to reset is on the dialog's
   * native `close` event, not on open -- it fires regardless of HOW the
   * dialog closed (close(), Escape, or a form submission), and a dialog
   * must close before it can ever be reopened, so resetting there is
   * equivalent in effect to resetting on open, with one listener per
   * dialog instead of needing to touch every individual showModal()
   * call site scattered across the codebase.
   *
   * Dragging is bounds-constrained (also not explicitly confirmed,
   * flagged the same way) -- DRAG_MIN_VISIBLE pixels of the dialog
   * always stay on-screen in every direction, keeping the drag handle
   * and the dialog's own footer controls (Cancel/Confirm, etc.) always
   * reachable regardless of how far it's been dragged.
   */
  const DRAG_MIN_VISIBLE = 60;
  function makeDialogsDraggable() {
    document.querySelectorAll('dialog.chip-dialog').forEach((dialog) => {
      const handle = dialog.querySelector('h3');
      if (!handle) return;
      handle.classList.add('dialog-drag-handle');

      let dragging = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;

      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; // primary button/touch only
        const rect = dialog.getBoundingClientRect();
        // Switches from the browser's native centered positioning to
        // explicit fixed coordinates the moment a drag actually starts.
        // position: fixed set explicitly rather than relying on the
        // UA stylesheet's own default for a modal <dialog> (which is
        // fixed in every current browser, but not worth assuming).
        dialog.style.position = 'fixed';
        dialog.style.margin = '0';
        dialog.style.left = `${rect.left}px`;
        dialog.style.top = `${rect.top}px`;
        startLeft = rect.left;
        startTop = rect.top;
        startX = e.clientX;
        startY = e.clientY;
        dragging = true;
        handle.setPointerCapture(e.pointerId);
      });

      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const rect = dialog.getBoundingClientRect();
        let newLeft = startLeft + (e.clientX - startX);
        let newTop = startTop + (e.clientY - startY);
        newLeft = Math.max(DRAG_MIN_VISIBLE - rect.width, Math.min(newLeft, window.innerWidth - DRAG_MIN_VISIBLE));
        newTop = Math.max(0, Math.min(newTop, window.innerHeight - DRAG_MIN_VISIBLE));
        dialog.style.left = `${newLeft}px`;
        dialog.style.top = `${newTop}px`;
      });

      handle.addEventListener('pointerup', (e) => {
        dragging = false;
        if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      });

      dialog.addEventListener('close', () => {
        dialog.style.left = '';
        dialog.style.top = '';
        dialog.style.margin = '';
        dialog.style.position = '';
      });
    });
  }

  loadGameChoices();
  loadAppInfo();
  makeDialogsDraggable();

  // NEW 11.3 (Part A.7): a full page reload of this same tab wipes
  // in-memory state but not sessionStorage -- check for a cached
  // session before showing anything else, and attempt reconnect
  // immediately rather than making the player go through the landing
  // page at all. Takes priority over the `?rejoin=` URL-param path
  // below; only falls through to it if nothing was cached.
  const cachedSession = loadSessionForReconnect();
  if (cachedSession) {
    // Pre-filled regardless of outcome, per A.7's own explicit
    // requirement -- no reason to make the player retype something the
    // browser still has, even if the automatic attempt below doesn't
    // pan out.
    el.rejoinCode.value = cachedSession.reconnectCode;
    el.rejoinTableCode.value = cachedSession.gameTableCode;
    attemptReconnectOnce(cachedSession.gameTableCode, cachedSession.reconnectCode, (success) => {
      if (!success) {
        // A.7's fallback cases: the table/session genuinely ended, or
        // this cached pair is otherwise stale -- fields stay pre-filled
        // (already set above) and an ordinary fresh lobby connection
        // takes over normally.
        clearSessionForReconnect();
        connect();
      }
    });
  } else {
    maybeAutoFillRejoinFromUrl(); // NEW 11.0 (Part D)
    connect();
  }
})();
