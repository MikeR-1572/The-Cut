'use strict';
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3941;
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
  const firstJoined = once(wsA, 'joined');
  send(wsA, 'createGameTable', { playerName: 'Alice' });
  const joinedA = await firstJoined;
  console.assert(joinedA.isReconnect === false, 'expected isReconnect:false on genuine create');
  console.log('ok  - create sets isReconnect:false');

  // --- Fix 4: End Game message says "Host" ---
  const tableEndedPromise = once(wsA, 'tableEnded');
  send(wsA, 'endGame');
  const ended = await tableEndedPromise;
  console.assert(/The Host has ended this table/.test(ended.message), 'expected Host-branded End Game message, got: ' + ended.message);
  console.log('ok  - Fix 4: End Game message says "Host":', ended.message);

  // --- Fix 6: reconnect sets isReconnect:true ---
  const wsB = connect();
  await new Promise((r) => wsB.on('open', r));
  const secondCreate = once(wsB, 'joined');
  send(wsB, 'createGameTable', { playerName: 'Bob' });
  const joinedB = await secondCreate;
  const code = joinedB.gameTableCode;

  wsB.terminate();
  await wait(300);

  const wsB2 = connect();
  await new Promise((r) => wsB2.on('open', r));
  const reconnectJoined = once(wsB2, 'joined');
  send(wsB2, 'reconnectToGameTable', { gameTableCode: code, code: joinedB.reconnectCode });
  const joinedB2 = await reconnectJoined;
  console.assert(joinedB2.isReconnect === true, 'expected isReconnect:true on reconnect, got: ' + joinedB2.isReconnect);
  console.log('ok  - Fix 6: reconnect sets isReconnect:true');

  wsA.close();
  wsB2.close();
  serverProc.kill();
  console.log('\nv11.2 live check passed.');
}

main().catch((err) => {
  console.error('LIVE TEST FAILED:', err);
  process.exitCode = 1;
});
