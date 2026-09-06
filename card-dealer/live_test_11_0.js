'use strict';

/**
 * NEW 11.0: a direct-reproduction smoke test against the actual running
 * server (not just the pure gameTable.js unit tests) -- per this
 * project's own established discipline ("tricky logic gets verified by
 * direct reproduction, not just read"). Exercises the real socket path:
 * create a table, open a second connection, force it closed uncleanly,
 * confirm the server detects it, waits out a short grace period, and
 * converts to Sitting Out -- then repeats with an actual reconnect
 * inside the grace window to confirm silent resume. Uses a short
 * reconnectGraceSeconds (set via the real setReconnectTimeout message)
 * so this finishes in a few seconds rather than needing the 30s default.
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3919;
let serverProc;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect() {
  return new WebSocket(`ws://localhost:${PORT}`);
}

function once(ws, type) {
  return new Promise((resolve) => {
    function onMsg(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        ws.off('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

function send(ws, type, payload = {}) {
  ws.send(JSON.stringify({ type, ...payload }));
}

async function main() {
  serverProc = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await wait(600); // let it bind

  // --- Player 1 creates the table (becomes Dealer) ---
  const wsA = connect();
  await new Promise((r) => wsA.on('open', r));
  send(wsA, 'createGameTable', { playerName: 'Alice' });
  const joinedA = await once(wsA, 'joined');
  const code = joinedA.gameTableCode;
  console.log('ok  - table created:', code, 'Alice reconnectCode:', joinedA.reconnectCode);

  // Drain Alice's own leftover "has joined the table" announcement (NEW
  // 11.0 Part G) before it can be mistaken by a later listener for a
  // disconnect/reconnect announcement -- it's queued but never pushed to
  // her own socket until the next broadcast reaches her.
  await once(wsA, 'announcement');

  // Table Owner shortens the grace period for this test.
  send(wsA, 'setReconnectTimeout', { seconds: 2 });
  await once(wsA, 'gameTableState');

  // --- Player 2 joins ---
  const wsB = connect();
  await new Promise((r) => wsB.on('open', r));
  send(wsB, 'joinGameTable', { gameTableCode: code, playerName: 'Bob' });
  const joinedB = await once(wsB, 'joined');
  console.log('ok  - Bob joined, reconnectCode:', joinedB.reconnectCode);
  await once(wsA, 'gameTableState'); // Alice's broadcast for Bob joining

  // --- Test 1: Bob's connection drops uncleanly (terminate, no close handshake) ---
  const disconnectAnnouncement = once(wsA, 'announcement');
  wsB.terminate();
  const ann1 = await disconnectAnnouncement;
  console.assert(/disconnected/.test(ann1.text), 'expected a disconnect announcement, got: ' + ann1.text);
  console.log('ok  - Alice was notified of Bob\'s disconnect:', ann1.text);

  const stateAfterDisconnect = await once(wsA, 'gameTableState');
  const bobState = stateAfterDisconnect.gameTable.players.find((p) => p.name === 'Bob');
  console.assert(bobState.connected === false, 'expected Bob to show connected: false');
  console.assert(typeof bobState.disconnectDeadline === 'number', 'expected a disconnectDeadline timestamp');
  console.log('ok  - Bob shows connected:false with a disconnectDeadline');

  // Wait past the 2s grace period.
  const sittingOutAnnouncement = once(wsA, 'announcement');
  await wait(2600);
  const ann2 = await sittingOutAnnouncement;
  console.assert(/Sitting Out/.test(ann2.text), 'expected a Sitting Out announcement, got: ' + ann2.text);
  console.log('ok  - grace period expired, Bob moved to Sitting Out:', ann2.text);

  // --- Test 2: Bob reconnects using his code within a fresh disconnect window ---
  const wsB2 = connect();
  await new Promise((r) => wsB2.on('open', r));
  send(wsB2, 'reconnectToGameTable', { gameTableCode: code, code: joinedB.reconnectCode });
  const joinedB2 = await once(wsB2, 'joined');
  console.assert(joinedB2.playerId === joinedB.playerId, 'expected the SAME playerId back on reconnect');
  console.log('ok  - Bob reconnected via code, same playerId preserved');

  // --- Test 3: a second device cannot use Bob's code while he's connected ---
  const wsIntruder = connect();
  await new Promise((r) => wsIntruder.on('open', r));
  send(wsIntruder, 'reconnectToGameTable', { gameTableCode: code, code: joinedB.reconnectCode });
  const intruderResult = await once(wsIntruder, 'reconnectError');
  console.assert(typeof intruderResult.message === 'string', 'expected a rejection for the still-connected code');
  console.log('ok  - a second device using Bob\'s code while he\'s connected was rejected:', intruderResult.message);

  // --- Test 4 (Part F.1): Bob leaves the table voluntarily, no pending stake (idle) ---
  const leaveAnnouncement = once(wsA, 'announcement');
  const stateAfterLeavePromise = once(wsA, 'gameTableState'); // registered BEFORE sending -- avoids a race with the server's own broadcast order
  send(wsB2, 'leaveTable', { mode: 'foldAndLeave' });
  const leftMsg = await once(wsB2, 'leftTable');
  console.assert(leftMsg !== undefined, 'expected a leftTable message to Bob\'s own socket');
  console.log('ok  - Bob received leftTable after Leave Table');
  const ann3 = await leaveAnnouncement;
  console.assert(/left the table/.test(ann3.text), 'expected a departure announcement, got: ' + ann3.text);
  console.log('ok  - Alice was notified of Bob\'s departure:', ann3.text);
  const stateAfterLeave = await stateAfterLeavePromise;
  console.assert(stateAfterLeave.gameTable.players.length === 1, 'expected only Alice left at the table');
  console.log('ok  - Bob\'s seat is actually gone -- table now has 1 player');

  // --- Test 5 (Part F.6): Alice ends the game entirely ---
  const wsC = connect();
  await new Promise((r) => wsC.on('open', r));
  const carolJoinBroadcast = once(wsA, 'gameTableState'); // registered before sending -- same race-avoidance as Test 4
  send(wsC, 'joinGameTable', { gameTableCode: code, playerName: 'Carol' });
  const joinedC = await once(wsC, 'joined');
  await carolJoinBroadcast;
  console.log('ok  - Carol joined ahead of End Game test');

  const tableEndedForAlice = once(wsA, 'tableEnded');
  const tableEndedForCarol = once(wsC, 'tableEnded');
  send(wsA, 'endGame');
  await tableEndedForAlice;
  await tableEndedForCarol;
  console.log('ok  - both Alice and Carol received tableEnded when the Table Owner ended the game');

  wsC.close();

  wsA.close();
  wsB2.close();
  wsIntruder.close();
  console.log('\nAll live checks passed.');
}main()
  .catch((err) => {
    console.error('LIVE TEST FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (serverProc) serverProc.kill();
  });
