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

wss.on('connection', (ws) => {
  ws.meta = { playerId: null, gameTableCode: null };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }
    const { type, ...payload } = msg || {};

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
      default:
        return; // unknown message type: ignore
    }
  });

  ws.on('close', () => {
    const { playerId, gameTableCode } = ws.meta;
    if (!playerId || !gameTableCode) return;
    playerSockets.delete(playerId);
    const gameTable = gameTables.get(gameTableCode);
    if (!gameTable) return;
    gameTable.removePlayer(playerId);
    // GameTable persists even if now empty (spec §4.5) -- we simply stop broadcasting.
    if (gameTable.players.length > 0) broadcastGameTableState(gameTable);
  });
});

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

  send(ws, 'joined', { playerId, gameTableCode: code });
  broadcastGameTableState(gameTable);
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

  send(ws, 'joined', { playerId, gameTableCode: code });
  broadcastGameTableState(gameTable);
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

server.listen(PORT, () => {
  console.log(`Card dealer server listening on http://localhost:${PORT}`);
});
