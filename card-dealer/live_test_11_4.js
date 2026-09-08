'use strict';
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3961;
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
  const serverProc = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), TEST_SWEEP_MS: '500', TEST_INACTIVITY_SECONDS: '5' },
    stdio: 'ignore',
  });
  await wait(600);

  // --- Part A: clientHeartbeat -> clientHeartbeatAck ---
  const wsA = connect();
  await new Promise((r) => wsA.on('open', r));
  const ackPromise = once(wsA, 'clientHeartbeatAck');
  send(wsA, 'clientHeartbeat');
  await ackPromise;
  console.log('ok  - Part A: clientHeartbeat gets a clientHeartbeatAck');

  // --- Part A / H.2 interaction: sending ONLY heartbeats (no real
  // activity) for the whole inactivity window must NOT keep the table
  // alive -- if the exclusion were missing, the heartbeats sent below
  // would keep resetting the clock and the table would never close. ---
  const firstJoined = once(wsA, 'joined');
  send(wsA, 'createGameTable', { playerName: 'Alice' });
  await firstJoined;

  const tableEndedPromise = once(wsA, 'tableEnded');
  const heartbeatLoop = setInterval(() => send(wsA, 'clientHeartbeat'), 1000);
  const raced = await Promise.race([
    tableEndedPromise.then((m) => ({ hit: true, m })),
    wait(7000).then(() => ({ hit: false })),
  ]);
  clearInterval(heartbeatLoop);
  console.assert(raced.hit && /inactivity/i.test(raced.m.message || ''), 'expected the table to auto-close on schedule DESPITE ongoing heartbeats, got: ' + JSON.stringify(raced));
  console.log('ok  - Part A/H.2: table closed on schedule despite continuous heartbeats -- heartbeats do not reset the inactivity clock:', raced.hit && raced.m.message);

  wsA.close();
  serverProc.kill();
  console.log('\nv11.4 server-side live check passed.');
}

main().catch((err) => {
  console.error('LIVE TEST FAILED:', err);
  process.exitCode = 1;
});
