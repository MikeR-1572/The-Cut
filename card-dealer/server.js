'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const { GameTable, MAX_PLAYERS } = require('./src/gameTable');
const { gameTables, generateGameTableCode } = require('./src/store');
const { version: APP_VERSION, buildDate: PACKAGE_BUILD_DATE } = require('./package.json');

// CHANGED 10.4 (the-cut-spec_v10-4.md Part D): previously a hardcoded
// literal here, its own comment admitting it was "the one line to
// update on release" -- missed for at least several releases (found
// stuck at 2026-08-02, predating 10.0). `version` in package.json, by
// contrast, has been correct in every build across this entire project,
// because bumping it is already a reliable, established release habit.
// Moved buildDate into package.json itself, alongside version, so it
// piggybacks on that same already-proven habit instead of asking
// anyone to remember a second, separate edit in a different file. The
// env var override is kept for anyone who wires up a real build
// pipeline later.
const APP_BUILD_DATE = process.env.BUILD_DATE || PACKAGE_BUILD_DATE;

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_NAME_LENGTH = 24;

// NEW 11.0 (Part A): heartbeat detection. Ping every 5s; a socket that
// misses 2 pings in a row (~10-12s of silence) is treated as
// disconnected. Deliberately NOT the same number as the ~30s grace
// period (Part B) -- this is purely "is the connection alive," a
// separate question from "how long do we wait for a person to come
// back." Server-level only, not Table-Owner-configurable -- see the
// project's own discussion of why: too aggressive risks false positives
// on a merely laggy connection, too lax defeats the point of having a
// heartbeat at all, and unlike the grace period this isn't a matter of
// taste a Table Owner has the context to safely tune themselves.
const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_MISSED_PINGS = 2;

// NEW 11.0 (Part D): reconnect-code rate limiting, tracked per IP, in
// memory (no new persistence layer, same ephemeral style as everything
// else in this app). Numbers per the spec's own proposed shape -- not
// locked in.
const RECONNECT_RATE_LIMIT_MAX_ATTEMPTS = 5;
const RECONNECT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RECONNECT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// --- Static file server -----------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === '/app-info.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ version: APP_VERSION, buildDate: APP_BUILD_DATE }));
    return;
  }

  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const safePath = path.normalize(decodeURIComponent(urlPath.split('?')[0]));
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- WebSocket layer -----------------------------------------------

const wss = new WebSocket.Server({ server });

/** playerId -> ws, so we can push to specific players (e.g. dealError, joined). */
const playerSockets = new Map();

// NEW 11.0 (Part B): playerId -> grace-period Timeout handle, so a
// reconnect (or a second disconnect signal for the same Player) can
// cancel/replace the pending expireDisconnectGrace() call.
const disconnectTimers = new Map();

// NEW 11.0 (Part D): ip -> { attempts: [timestamps], cooldownUntil }.
const reconnectAttemptsByIp = new Map();

function clientIp(req) {
  // Railway (and most platforms) sit behind a proxy -- the real client
  // address is the first entry of x-forwarded-for when present.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/**
 * NEW 11.0 (Part D). Whether this IP is currently in a cooldown and
 * should be rejected outright without even checking the code.
 * CHANGED 11.3 (Part A.8): no longer records the attempt itself -- that
 * moved to recordFailedReconnectAttempt() below, called only once the
 * caller knows whether this was a genuine guess (see its own comment
 * for why that distinction matters).
 */
function isReconnectRateLimited(ip) {
  const entry = reconnectAttemptsByIp.get(ip);
  return !!(entry && entry.cooldownUntil > Date.now());
}

/**
 * NEW 11.3 (Part A.8): only a code that matches nobody at all counts
 * against the per-IP limit now -- a legitimate player's own correct
 * code, rejected merely for timing (an attempt landing right as another
 * one already succeeded, or blocked by the multi-device rule), must
 * never count. With automatic retry and a repeatable manual button both
 * potentially firing several attempts within one Grace Period (Part A),
 * the old "every failed attempt counts" version risked tripping this
 * limiter against a player retrying their own correct code through no
 * fault of their own. This isn't a workaround -- it corrects what the
 * limiter was actually supposed to be measuring in the first place;
 * real guessing is still caught exactly as before.
 */
function recordFailedReconnectAttempt(ip) {
  const now = Date.now();
  let entry = reconnectAttemptsByIp.get(ip);
  if (!entry) {
    entry = { attempts: [], cooldownUntil: 0 };
    reconnectAttemptsByIp.set(ip, entry);
  }
  entry.attempts = entry.attempts.filter((t) => now - t < RECONNECT_RATE_LIMIT_WINDOW_MS);
  entry.attempts.push(now);
  if (entry.attempts.length > RECONNECT_RATE_LIMIT_MAX_ATTEMPTS) {
    entry.cooldownUntil = now + RECONNECT_RATE_LIMIT_COOLDOWN_MS;
  }
}

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

/** Broadcast a fresh redacted snapshot to every player currently in the gameTable. */
function broadcastGameTableState(gameTable) {
  for (const player of gameTable.players) {
    send(playerSockets.get(player.id), 'gameTableState', { gameTable: gameTable.toRedactedState(player.id) });
  }
}

/**
 * NEW 11.0 (Parts A-C): the single place a Player's connection is ever
 * recognized as lost, called both by a clean 'close' event (Part A: "a
 * clean, well-behaved close should still be recognized immediately") and
 * by heartbeat failure -- both route through the exact same phase-aware
 * handling now, replacing the old unconditional removePlayer() call.
 * Safe to call more than once for the same Player (e.g. a clean close
 * arriving right after a heartbeat timeout already fired): markDisconnected()
 * itself is idempotent and returns { ok: false } on the second call, so
 * this is a no-op past that point -- no duplicate timers, no duplicate
 * announcements.
 */
function handleConnectionLost(gameTableCode, playerId) {
  const gameTable = gameTables.get(gameTableCode);
  if (!gameTable) return;
  const result = gameTable.markDisconnected(playerId);
  if (!result.ok) return; // already disconnected -- nothing further to do
  playerSockets.delete(playerId);
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable);

  const timer = setTimeout(() => {
    disconnectTimers.delete(playerId);
    const expiry = gameTable.expireDisconnectGrace(playerId);
    if (!expiry.ok) return; // reconnected before the timer fired
    // GameTable persists even if now empty (spec §4.5) -- broadcasting
    // to zero remaining connected sockets is harmless.
    broadcastGameTableState(gameTable);
    broadcastAnnouncements(gameTable);
  }, gameTable.reconnectGraceSeconds * 1000);
  disconnectTimers.set(playerId, timer);
}

/**
 * NEW 8.1 (§5.10 extension): drains any plain-text announcements queued
 * by an auto-resolved (Free-price) deal interrupt and broadcasts each as
 * a one-off `announcement` message to every player -- never persisted,
 * never part of `toRedactedState`, so a client that reconnects mid-hand
 * simply never sees one that already happened. Called after
 * broadcastGameTableState() in every handler whose underlying GameTable
 * method can reach `_continueDeal()` (deal, and the three interrupt-
 * resolution actions, plus fold's own Baseball bypass) -- a no-op call
 * (nothing to send) for every other handler or every non-`dealIsInterruptable`
 * preset.
 */
function broadcastAnnouncements(gameTable) {
  const announcements = gameTable.drainAnnouncements();
  if (announcements.length === 0) return;
  for (const player of gameTable.players) {
    const socket = playerSockets.get(player.id);
    // CHANGED 9.0 (§6.11): each entry is now { text, kind } -- kind is
    // forwarded on the wire so the client can style specific
    // announcement types differently (e.g. All-In's louder notice)
    // without pattern-matching announcement text.
    for (const { text, kind } of announcements) send(socket, 'announcement', { text, kind });
  }
}

function cleanName(raw) {
  const trimmed = (typeof raw === 'string' ? raw : '').trim().slice(0, MAX_NAME_LENGTH);
  return trimmed || 'Player';
}

function gameTableForSocket(ws) {
  const { gameTableCode } = ws.meta;
  return gameTableCode ? gameTables.get(gameTableCode) : null;
}

wss.on('connection', (ws, req) => {
  ws.meta = { playerId: null, gameTableCode: null };
  // NEW 11.0 (Part A): heartbeat bookkeeping for this socket.
  ws.missedPings = 0;
  ws.on('pong', () => {
    ws.missedPings = 0;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }
    const { type, ...payload } = msg || {};

    // NEW 11.0 (Part H.2): any message against an already-established
    // table context counts as real activity -- resets the inactivity
    // clock generically, rather than sprinkling touchActivity() calls
    // through every individual game-action method in gameTable.js. This
    // is deliberately a session/connection-layer concern, not a
    // game-rule one. createGameTable/joinGameTable/reconnectToGameTable
    // aren't covered here (ws.meta isn't populated yet at this point for
    // those) -- each touches activity explicitly inside GameTable itself
    // instead (addPlayer()/reconnectPlayer()).
    //
    // EXCLUDED 11.4 (Part A): 'clientHeartbeat' is a pure connection-
    // liveness check, sent automatically every 5-8s regardless of
    // whether the player is doing anything at all -- counting it here
    // would keep resetting the clock every few seconds forever, making
    // Part H.2's entire idle-but-connected timeout impossible to ever
    // reach during normal play. Caught before this shipped, not after.
    if (ws.meta.gameTableCode && type !== 'clientHeartbeat') {
      const activeTable = gameTables.get(ws.meta.gameTableCode);
      if (activeTable) activeTable.touchActivity();
    }

    // NOTE 8.0 (ARCHITECTURE_v8.md §9): the wire protocol is now fully
    // renamed too -- `createRoom`/`joinRoom`/`roomState`/`roomCode`/the
    // broadcast payload's `room` key all became `createGameTable`/
    // `joinGameTable`/`gameTableState`/`gameTableCode`/`gameTable`,
    // landed together with the client.js phase of this refactor so both
    // sides changed in the same step -- renaming the wire protocol alone
    // first (server ahead of client, or vice versa) would have broken
    // the running app against whichever side hadn't caught up yet.
    switch (type) {
      case 'createGameTable':
        return handleCreateGameTable(ws, payload);
      case 'joinGameTable':
        return handleJoinGameTable(ws, payload);
      case 'deal':
        return handleDeal(ws, payload);
      case 'reshuffle':
        return handleReshuffle(ws);
      case 'advanceTurn':
        return handleAdvanceTurn(ws);
      case 'setTableName':
        return handleSetTableName(ws, payload);
      case 'setSuggestedBuyIn':
        return handleSetSuggestedBuyIn(ws, payload);
      case 'terminateGameCleanly':
        return handleTerminateGameCleanly(ws);
      case 'restorePlayerStacks':
        return handleRestorePlayerStacks(ws);
      case 'beginPotDistribution':
        return handleBeginPotDistribution(ws);
      case 'stageAllocation':
        return handleStageAllocation(ws, payload);
      case 'updateStagedAllocation':
        return handleUpdateStagedAllocation(ws, payload);
      case 'removeStagedAllocation':
        return handleRemoveStagedAllocation(ws, payload);
      case 'discardPotDistributionBatch':
        return handleDiscardPotDistributionBatch(ws);
      case 'commitPotDistribution':
        return handleCommitPotDistribution(ws);
      case 'revealHand':
        return handleRevealHand(ws);
      case 'discard':
        return handleDiscard(ws, payload);
      case 'dealToPlayer':
        return handleDealToPlayer(ws, payload);
      case 'dealCommunity':
        return handleDealCommunity(ws, payload);
      case 'burn':
        return handleBurn(ws);
      case 'rabbitHunt':
        return handleRabbitHunt(ws);
      case 'standPat':
        return handleStandPat(ws);
      case 'newHand':
        return handleNewHand(ws);
      case 'passTheBuck':
        return handlePassTheBuck(ws);
      case 'startGame':
        return handleStartGame(ws);
      case 'setGameChoice':
        return handleSetGameChoice(ws, payload);
      case 'setGameOption':
        return handleSetGameOption(ws, payload);
      case 'openBetting':
        return handleOpenBetting(ws);
      case 'setOpeningBettor':
        return handleSetOpeningBettor(ws, payload);
      case 'setAnteBlind':
        return handleSetAnteBlind(ws, payload);
      case 'postAnteBlind':
        return handlePostAnteBlind(ws);
      case 'misdealStuckAntes':
        return handleMisdealStuckAntes(ws);
      case 'placeBet':
        return handlePlaceBet(ws, payload);
      case 'call':
        return handleCall(ws);
      case 'check':
        return handleCheck(ws);
      case 'fold':
        return handleFold(ws);
      case 'allIn':
        return handleAllIn(ws);
      case 'declare':
        return handleDeclare(ws, payload);
      case 'payDealInterrupt':
        return handlePayDealInterrupt(ws);
      case 'buyDealInterrupt':
        return handleBuyDealInterrupt(ws);
      case 'declineDealInterrupt':
        return handleDeclineDealInterrupt(ws);
      case 'killHandStartConfirm':
        return handleKillHandStartConfirm(ws);
      case 'killHandCancelConfirm':
        return handleKillHandCancelConfirm(ws);
      case 'claimPot':
        return handleClaimPot(ws, payload);
      case 'resolveClaim':
        return handleResolveClaim(ws, payload);
      case 'buyChips':
        return handleBuyChips(ws, payload);
      case 'sitOut':
        return handleSitOut(ws, payload);
      case 'sitIn':
        return handleSitIn(ws);
      case 'reconnectToGameTable':
        return handleReconnectToGameTable(ws, payload, req);
      case 'setReconnectTimeout':
        return handleSetReconnectTimeout(ws, payload);
      case 'leaveTable':
        return handleLeaveTable(ws, payload);
      case 'removePlayerFromTable':
        return handleRemovePlayerFromTable(ws, payload);
      case 'endGame':
        return handleEndGame(ws);
      case 'restartActivityClock':
        return handleRestartActivityClock(ws);
      case 'forceDisconnectPlayer':
        return handleForceDisconnectPlayer(ws, payload);
      case 'forceInactivityWarning':
        return handleForceInactivityWarning(ws);
      case 'clientHeartbeat':
        // NEW 11.4 (Part A): the client's own active heartbeat,
        // symmetric to the server's existing one -- browsers don't
        // expose WebSocket ping/pong frames to JavaScript at all, so
        // this is an application-level message instead. No gameTable
        // lookup needed; this is a pure connection-level liveness check,
        // answered immediately regardless of whether this socket has
        // even joined a table yet.
        return send(ws, 'clientHeartbeatAck');
      default:
        return; // unknown message type: ignore
    }
  });

  // NEW 11.0 (Part A): a clean, well-behaved close (tab closed, page
  // navigated away) is recognized immediately -- no reason to wait out a
  // heartbeat timeout for the easy case -- but now routed through the
  // exact same phase-aware handleConnectionLost() the heartbeat-failure
  // path uses, instead of straight into the old, blunt removePlayer().
  // Safe even if a heartbeat timeout already fired for this same socket
  // moments earlier (see handleConnectionLost()'s own comment).
  ws.on('close', () => {
    const { playerId, gameTableCode } = ws.meta;
    if (!playerId || !gameTableCode) return;
    handleConnectionLost(gameTableCode, playerId);
  });
});

// NEW 11.0 (Part A): the heartbeat loop itself. Every player's socket is
// pinged on the same shared interval; a socket that hasn't answered with
// a pong in MAX_MISSED_PINGS consecutive intervals is treated as
// disconnected via the exact same handleConnectionLost() path a clean
// close uses, then terminated (its own 'close' event will fire from
// that, but handleConnectionLost() is idempotent -- see its own comment
// -- so this is safe).
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.missedPings >= MAX_MISSED_PINGS) {
      const { playerId, gameTableCode } = ws.meta || {};
      if (playerId && gameTableCode) handleConnectionLost(gameTableCode, playerId);
      return ws.terminate();
    }
    ws.missedPings = (ws.missedPings || 0) + 1;
    try {
      ws.ping();
    } catch {
      // Socket already in a bad state -- the next interval's missed-ping
      // count (or a 'close'/'error' event) will catch it.
    }
  });
}, HEARTBEAT_INTERVAL_MS);
// Doesn't keep the process alive on its own past a graceful shutdown.
heartbeatInterval.unref?.();

// --- Handlers, one per protocol message type ---------------------------

function handleCreateGameTable(ws, { playerName, tableName, suggestedBuyIn }) {
  const code = generateGameTableCode();
  const gameTable = new GameTable(code);
  gameTables.set(code, gameTable);

  const playerId = crypto.randomUUID();
  gameTable.addPlayer(playerId, cleanName(playerName));
  playerSockets.set(playerId, ws);
  ws.meta = { playerId, gameTableCode: code };

  // NEW 4.5 (§10.1): both optional, set at creation using the creator's
  // own permission-checked setters now that creatorId exists (set by the
  // addPlayer() call just above).
  if (typeof tableName === 'string' && tableName.trim()) {
    gameTable.setTableName(playerId, tableName);
  }
  if (suggestedBuyIn !== undefined && suggestedBuyIn !== null && suggestedBuyIn !== '') {
    const amount = Number(suggestedBuyIn);
    if (Number.isFinite(amount)) gameTable.setSuggestedBuyIn(playerId, Math.round(amount));
  }

  send(ws, 'joined', { playerId, gameTableCode: code, reconnectCode: gameTable.getPlayer(playerId).reconnectCode, isReconnect: false });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable); // FIXED (found while re-verifying the live smoke test after the review pass): Part G's "player joined" announcement was queued but never actually drained/sent here
}

function handleJoinGameTable(ws, { gameTableCode, playerName }) {
  const code = (typeof gameTableCode === 'string' ? gameTableCode : '').trim().toUpperCase();
  const gameTable = gameTables.get(code);

  if (!gameTable) {
    send(ws, 'joinError', { message: 'Table not found. Check the code and try again.' });
    return;
  }
  if (gameTable.isFull()) {
    send(ws, 'joinError', { message: `Table is full (${MAX_PLAYERS} players max).` });
    return;
  }

  const cleanedName = cleanName(playerName);
  // NEW 9.2 (§4, §10.1): case-insensitive name collision check --
  // prevents two players from being indistinguishable from each other
  // (in banners, claim proposals, turn indicators, etc.) purely by
  // capitalization.
  if (gameTable.hasPlayerNamed(cleanedName)) {
    send(ws, 'joinError', { message: 'That name is already taken at this table \u2014 try another.' });
    return;
  }

  const playerId = crypto.randomUUID();
  gameTable.addPlayer(playerId, cleanedName);
  playerSockets.set(playerId, ws);
  ws.meta = { playerId, gameTableCode: code };

  send(ws, 'joined', { playerId, gameTableCode: code, reconnectCode: gameTable.getPlayer(playerId).reconnectCode, isReconnect: false });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable); // FIXED -- same gap as handleCreateGameTable above
}

function handleDeal(ws, { cardsPerPlayer, faceUp }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const override = typeof faceUp === 'boolean' ? faceUp : undefined;
  const result = gameTable.deal(Number(cardsPerPlayer), ws.meta.playerId, override);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable);
}

function handleReshuffle(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.reshuffle(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleAdvanceTurn(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.advanceTurn(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleSetTableName(ws, { name }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.setTableName(ws.meta.playerId, name);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleSetSuggestedBuyIn(ws, { amount }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const parsed = amount === null || amount === undefined || amount === '' ? null : Number(amount);
  const result = gameTable.setSuggestedBuyIn(ws.meta.playerId, parsed === null ? null : Math.round(parsed));
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

// NEW 10.3 (the-cut-spec_v10-3.md Part A): Table Owner recovery
// functions. Same thin-wrapper pattern as every other handler in this
// file -- GameTable itself owns all the actual logic/validation.
function handleTerminateGameCleanly(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.terminateGameCleanly(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
  // BUG FIX 10.4: this handler queues an announcement via
  // _queueAnnouncement() (added in 10.3) but never drained it -- a real
  // gap that shipped in 10.3 itself, found while checking every Part A
  // handler for the same omission Part E's own new announcement just
  // exposed. The announcement was silently lost every time; the server
  // state change itself was never affected.
  broadcastAnnouncements(gameTable);
}

function handleRestorePlayerStacks(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.restorePlayerStacks(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable); // BUG FIX 10.4 -- see handleTerminateGameCleanly's own comment
}

function handleBeginPotDistribution(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.beginPotDistribution(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleStageAllocation(ws, payload) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.stageAllocation(ws.meta.playerId, payload);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleUpdateStagedAllocation(ws, { allocationId, direction, amount }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.updateStagedAllocation(ws.meta.playerId, allocationId, { direction, amount });
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleRemoveStagedAllocation(ws, { allocationId }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.removeStagedAllocation(ws.meta.playerId, allocationId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleDiscardPotDistributionBatch(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.discardPotDistributionBatch(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleCommitPotDistribution(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.commitPotDistribution(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable); // BUG FIX 10.4 -- see handleTerminateGameCleanly's own comment
}

function handleRevealHand(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.revealHand(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleDiscard(ws, { cardIds }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.discard(ws.meta.playerId, cardIds);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleStandPat(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.standPat(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleDealToPlayer(ws, { targetPlayerId, count, allPlayers }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  let result;
  if (allPlayers) {
    result = gameTable.dealToAllPlayers(ws.meta.playerId);
  } else {
    const countOverride = count === undefined || count === null || count === '' ? undefined : Number(count);
    result = gameTable.dealToPlayer(ws.meta.playerId, targetPlayerId, countOverride);
  }
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleDealCommunity(ws, { count }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const countOverride = count === undefined || count === null || count === '' ? undefined : Number(count);
  const result = gameTable.dealCommunity(ws.meta.playerId, countOverride);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleBurn(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.burn(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleRabbitHunt(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.rabbitHunt(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleNewHand(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.newHand(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handlePassTheBuck(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.passTheBuck(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleStartGame(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.startGame(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleSetGameChoice(ws, { gameChoiceId }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.setGameChoice(ws.meta.playerId, gameChoiceId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleSetGameOption(ws, { key, value }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.setGameOption(ws.meta.playerId, key, value);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleOpenBetting(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.openBetting(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
  // NEW 10.4 (Part E): openBetting() can now queue an announcement
  // (the "no one can act" bypass) -- previously this handler never
  // needed to drain any, since openBetting() itself never queued one
  // before this version.
  broadcastAnnouncements(gameTable);
}

function handleSetOpeningBettor(ws, { playerId }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.setOpeningBettor(ws.meta.playerId, playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleSetAnteBlind(ws, { playerId, amount }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.setAnteBlind(ws.meta.playerId, playerId, Number(amount));
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handlePostAnteBlind(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.postAnteBlind(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

// NEW 10.4 (the-cut-spec_v10-4.md B.2 replacement): queues an
// announcement, so this needs broadcastAnnouncements() too, same as
// deal()'s own handler.
function handleMisdealStuckAntes(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.misdealStuckAntes(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable);
}

function handlePlaceBet(ws, { amount }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.placeBet(ws.meta.playerId, Number(amount));
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleCall(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.call(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleCheck(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.check(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleFold(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.fold(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable); // NEW 8.1 -- covers the Baseball Pay-or-Fold bypass, which can resume a paused deal into another auto-resolved (Free) interrupt
}

// NEW 9.0 (§6.11)
function handleAllIn(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.allIn(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable); // NEW 9.0 -- the dramatic "[Name] is ALL IN for $[amount]!" table-wide notice
}

// NEW 8.1 (§5.11)
function handleDeclare(ws, { value }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.declare(ws.meta.playerId, value);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

// NEW 8.1 (§5.10 extension)
function handlePayDealInterrupt(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.payDealInterrupt(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable);
}

function handleBuyDealInterrupt(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.buyDealInterrupt(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable);
}

function handleDeclineDealInterrupt(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.declineDealInterrupt(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable);
}

// NEW 8.2 (§6.9)
function handleKillHandStartConfirm(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.killHandStartConfirm(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleKillHandCancelConfirm(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.killHandCancelConfirm(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleClaimPot(ws, { allocations, carryAmount }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  // NEW 8.2 (§6.5): carryAmount defaults to 0 server-side too if the
  // client omits it entirely (every pre-8.2 client build), so an older
  // cached page still sends a valid claimPot call.
  const result = gameTable.claimPot(ws.meta.playerId, allocations, Number.isInteger(carryAmount) ? carryAmount : 0);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleResolveClaim(ws, { approve }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.resolveClaim(ws.meta.playerId, !!approve);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleBuyChips(ws, { amount }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.buyChips(ws.meta.playerId, Number(amount));
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleSitOut(ws, { mode }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.sitOut(ws.meta.playerId, mode);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

function handleSitIn(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.sitIn(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

/**
 * NEW 11.0 (Part D). Two entry paths lead here on the client side (the
 * "Re-Join a Table" box, and a `?rejoin=CODE` URL param read on load) --
 * both funnel into this one message type server-side, exactly per spec
 * ("both check the same code server-side").
 */
function handleReconnectToGameTable(ws, { gameTableCode, code }, req) {
  const ip = clientIp(req);
  // Deliberately the SAME generic error for rate-limited vs. wrong-code
  // vs. table-not-found -- no distinction that would help a guesser learn
  // anything about which case they hit.
  const GENERIC_ERROR = 'Unable to reconnect with that code. Check the code and try again.';
  if (isReconnectRateLimited(ip)) return send(ws, 'reconnectError', { message: GENERIC_ERROR });

  const tableCode = (typeof gameTableCode === 'string' ? gameTableCode : '').trim().toUpperCase();
  const gameTable = gameTables.get(tableCode);
  const trimmedCode = (typeof code === 'string' ? code : '').trim().toUpperCase();
  if (!gameTable || !trimmedCode) {
    // No real table/code to even check against -- structurally the same
    // "this attempt didn't correspond to anything real" shape as a code
    // matching no player, so it counts the same way.
    recordFailedReconnectAttempt(ip);
    return send(ws, 'reconnectError', { message: GENERIC_ERROR });
  }

  const result = gameTable.reconnectPlayer(trimmedCode);
  if (!result.ok) {
    // CHANGED 11.3 (Part A.8): only count it if the code genuinely
    // matched nobody -- a correct code rejected merely for timing
    // (already reconnected, or the multi-device rule) must not.
    if (result.codeMatchedNoPlayer) recordFailedReconnectAttempt(ip);
    return send(ws, 'reconnectError', { message: GENERIC_ERROR });
  }

  const { playerId } = result;
  const existingTimer = disconnectTimers.get(playerId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    disconnectTimers.delete(playerId);
  }
  playerSockets.set(playerId, ws);
  ws.meta = { playerId, gameTableCode: tableCode };

  send(ws, 'joined', { playerId, gameTableCode: tableCode, reconnectCode: gameTable.getPlayer(playerId).reconnectCode, isReconnect: true });
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable);
}

function handleSetReconnectTimeout(ws, { seconds }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.setReconnectTimeout(ws.meta.playerId, Number(seconds));
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

/** NEW 11.0 (Part F.1). */
function handleLeaveTable(ws, { mode }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const playerId = ws.meta.playerId;
  const result = gameTable.leaveTable(playerId, mode);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  if (result.immediate) {
    // Their own seat is already gone -- tell their client to reset back
    // to the landing page. Unlike a lost connection, this was clean and
    // deliberate, so there's nothing for handleConnectionLost() to do.
    send(ws, 'leftTable', {});
    playerSockets.delete(playerId);
    ws.meta = { playerId: null, gameTableCode: null };
  }
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable);
}

/** NEW 11.0 (Part F.2). */
function handleRemovePlayerFromTable(ws, { targetPlayerId, mode }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const targetSocket = playerSockets.get(targetPlayerId);
  const result = gameTable.removePlayerFromTable(ws.meta.playerId, targetPlayerId, mode);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  const timer = disconnectTimers.get(targetPlayerId);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(targetPlayerId);
  }
  if (result.immediate) {
    send(targetSocket, 'leftTable', {});
    playerSockets.delete(targetPlayerId);
    if (targetSocket) targetSocket.meta = { playerId: null, gameTableCode: null };
  }
  broadcastGameTableState(gameTable);
  broadcastAnnouncements(gameTable);
}

/**
 * NEW 11.0 (Part F.6, reused by Part H.2's own enforcement below): the
 * actual table teardown -- every seated Player's socket is notified
 * (with a caller-supplied reason) and disassociated, every pending
 * disconnect timer for this table is cleared, and the GameTable itself
 * is deleted from the registry. Distinct from handleTerminateGameCleanly
 * (Function 1), which only force-ends the current hand and leaves
 * everything else, including every socket mapping, completely untouched.
 */
function teardownTable(gameTableCode, reasonMessage) {
  const gameTable = gameTables.get(gameTableCode);
  if (!gameTable) return;
  for (const player of gameTable.players) {
    const socket = playerSockets.get(player.id);
    send(socket, 'tableEnded', { message: reasonMessage });
    playerSockets.delete(player.id);
    const timer = disconnectTimers.get(player.id);
    if (timer) {
      clearTimeout(timer);
      disconnectTimers.delete(player.id);
    }
    if (socket) socket.meta = { playerId: null, gameTableCode: null };
  }
  gameTables.delete(gameTableCode);
  zeroConnectionSince.delete(gameTableCode);
}

function handleEndGame(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.endGame(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  teardownTable(ws.meta.gameTableCode, 'The Host has ended this table.');
}

/** NEW 11.0 (Part H.2). */
function handleRestartActivityClock(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.restartActivityClock(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

/**
 * NEW 11.1 (Testing dialog, Capability 1): terminates the target
 * Player's actual socket -- NOT a simulated state change. Calling
 * .terminate() fires that socket's own already-registered 'close'
 * handler, which routes through handleConnectionLost() exactly as a
 * genuine heartbeat failure or clean close would -- no separate/
 * duplicate disconnect-handling logic here.
 */
function handleForceDisconnectPlayer(ws, { targetPlayerId }) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const check = gameTable.canForceDisconnect(ws.meta.playerId, targetPlayerId);
  if (!check.ok) return send(ws, 'dealError', { message: check.error });
  const targetSocket = playerSockets.get(targetPlayerId);
  if (!targetSocket) return send(ws, 'dealError', { message: 'That player has no active connection to terminate.' });
  targetSocket.terminate();
}

/** NEW 11.1 (Testing dialog, Capability 2). */
function handleForceInactivityWarning(ws) {
  const gameTable = gameTableForSocket(ws);
  if (!gameTable) return;
  const result = gameTable.forceInactivityWarning(ws.meta.playerId);
  if (!result.ok) return send(ws, 'dealError', { message: result.error });
  broadcastGameTableState(gameTable);
}

// NEW 11.0 (Part H.1/H.2): table lifecycle. Checked on a shared sweep
// rather than a timer per table -- simpler, and imprecision on the order
// of this interval is completely fine at a 30-60 MINUTE timescale.
//
// FIXED 11.1 (Fix 3, Issue B): the original 60-second value here was
// reasoned correctly for H.1's timescale, but H.2's entire T-5->T-1->T-0
// sequence plays out over 5 minutes total -- a 60-second sweep could
// leave the real close lagging up to a full minute behind tableCloseAt.
// Confirmed the same category of bug as `_activePlayers()` being shared
// across callers with incompatible needs: one interval correct for one
// consumer, reused somewhere its timing assumptions didn't hold.
//
// Fix chosen: tighten the single shared interval to 5 seconds, rather
// than splitting into two separate sweeps. This app runs at most a
// handful of concurrent tables (a home-game tool, not a many-thousands-
// of-tables service) -- comparing two timestamps per table five times a
// second is negligible cost, so the "avoid polling every table every
// second forever" concern the spec raised doesn't actually bite at this
// app's real scale. Worst-case H.2 lag drops from up to 60s to up to
// 5s; H.1 (already tolerant of 30-60 minute imprecision) is completely
// unaffected by the tighter interval.
// FIXED 11.5 (Part D): a permanent, genuine test-mode override -- NOT
// another throwaway edit-and-revert hack against this file. The 11.4
// live test claimed to set TEST_SWEEP_MS/TEST_INACTIVITY_SECONDS, but
// those overrides only ever existed temporarily on a local copy of
// this file during manual verification, then got reverted before
// packaging -- the delivered test referenced environment variables
// that didn't actually exist anywhere in the shipped server, so it
// could never have exercised anything real. Wiring this in for real
// this time: harmless in production (the env var is simply never set
// there, so `Number(undefined) || fallback` always falls back to the
// genuine 5000ms default), and lets a live test exercise the ACTUAL
// shipped code path with a real, fast timescale rather than needing
// its own separate hacked copy of the server.
const LIFECYCLE_SWEEP_INTERVAL_MS = Number(process.env.TEST_SWEEP_MS) || 5 * 1000;
// Part H.1: "30-60 minutes... not fully locked" -- 45 is the midpoint,
// same "we won't know until we experience it" posture as every other
// timer in this spec.
const ZERO_CONNECTION_TIMEOUT_MS = 45 * 60 * 1000;
/** gameTableCode -> timestamp the table FIRST had zero connected players, or absent if it currently has at least one. */
const zeroConnectionSince = new Map();

function runLifecycleSweep() {
  const now = Date.now();
  for (const [code, gameTable] of gameTables) {
    // Part H.1: zero-players-CONNECTED timeout -- deliberately distinct
    // from H.2 below (idle-but-still-connected). A Player who's merely
    // mid-disconnect-grace still counts as "connected" was true a moment
    // ago, but what matters here is the CURRENT connected flag -- if
    // literally nobody currently has a live socket, the clock runs.
    const anyoneConnected = gameTable.players.some((p) => p.connected);
    if (anyoneConnected) {
      zeroConnectionSince.delete(code);
    } else {
      if (!zeroConnectionSince.has(code)) zeroConnectionSince.set(code, now);
      else if (now - zeroConnectionSince.get(code) >= ZERO_CONNECTION_TIMEOUT_MS) {
        // Nobody is connected to notify -- just wipe it.
        gameTables.delete(code);
        zeroConnectionSince.delete(code);
        continue;
      }
    }

    // Part H.2: idle-but-connected inactivity timeout. tableCloseAt is
    // the same server-computed fact toRedactedState already exposes for
    // the client's own T-5/T-1 banner and popup -- enforced here as the
    // actual, authoritative close, since a client-side timer alone could
    // never be trusted to reliably close the table on its own.
    const tableCloseAt = gameTable.lastActivityAt + gameTable.inactivityTimeoutSeconds * 1000;
    if (now >= tableCloseAt) {
      teardownTable(code, 'This table closed due to inactivity.');
    }
  }
}

const lifecycleSweepInterval = setInterval(runLifecycleSweep, LIFECYCLE_SWEEP_INTERVAL_MS);
lifecycleSweepInterval.unref?.();

server.listen(PORT, () => {
  console.log(`Card dealer server listening on http://localhost:${PORT}`);
});
