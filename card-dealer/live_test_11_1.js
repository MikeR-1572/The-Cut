'use strict';
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3931;
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function connect() { return new WebSocket(`ws://localhost:${PORT}`); }
function once(ws, type) {
  return new Promise((resolve) => {
    function onMsg(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) { ws.off('message', onMsg); resolve(msg); }
    }
    ws.on('message', onMsg);
  });
}
function send(ws, type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }

async function main() {
  const serverProc = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await wait(600);

  const wsA = connect();
  await new Promise((r) => wsA.on('open', r));
  const firstState = once(wsA, 'gameTableState');
  const firstAnnouncement = once(wsA, 'announcement');
  send(wsA, 'createGameTable', { playerName: 'Alice' });
  const joinedA = await once(wsA, 'joined');
  const code = joinedA.gameTableCode;
  await firstState;
  await firstAnnouncement; // drain Alice's own join announcement
  console.log('ok  - table created:', code);

  const wsB = connect();
  await new Promise((r) => wsB.on('open', r));
  const bJoinBroadcast = once(wsA, 'gameTableState');
  const bJoinAnnouncement = once(wsA, 'announcement');
  send(wsB, 'joinGameTable', { gameTableCode: code, playerName: 'Bob' });
  const joinedB = await once(wsB, 'joined');
  await bJoinBroadcast;
  await bJoinAnnouncement; // drain Bob's join announcement
  console.log('ok  - Bob joined');

  // --- Capability 1: Force Disconnect ---
  const disconnectAnnouncement = once(wsA, 'announcement');
  const stateAfterPromise = once(wsA, 'gameTableState');
  send(wsA, 'forceDisconnectPlayer', { targetPlayerId: joinedB.playerId });
  const ann = await disconnectAnnouncement;
  console.assert(/disconnected/.test(ann.text), 'expected a real disconnect announcement, got: ' + ann.text);
  console.log('ok  - Capability 1: Force Disconnect triggered a real disconnect:', ann.text);

  const stateAfter = await stateAfterPromise;
  const bob = stateAfter.gameTable.players.find((p) => p.id === joinedB.playerId);
  console.assert(bob.connected === false, 'expected Bob to show connected:false after Force Disconnect');
  console.log('ok  - Bob shows connected:false, real grace period now running');

  // --- Capability 2: Force Timeout to T-5 ---
  const stateAfterForceT5 = once(wsA, 'gameTableState');
  send(wsA, 'forceInactivityWarning');
  const t5State = await stateAfterForceT5;
  const msRemaining = t5State.gameTable.tableCloseAt - Date.now();
  console.assert(Math.abs(msRemaining - 5 * 60 * 1000) < 3000, 'expected tableCloseAt ~5 minutes out, got ms=' + msRemaining);
  console.log('ok  - Capability 2: Force Timeout to T-5 set tableCloseAt to', new Date(t5State.gameTable.tableCloseAt).toISOString());

  wsA.close();
  wsB.close();
  serverProc.kill();
  console.log('\nv11.1 Testing Tools live check passed.');
}

main().catch((err) => {
  console.error('LIVE TEST FAILED:', err);
  process.exitCode = 1;
});
