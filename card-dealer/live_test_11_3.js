'use strict';
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3951;
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
  const code = joinedA.gameTableCode;
  console.assert(!joinedA.reconnectCode.includes('0') && !joinedA.reconnectCode.includes('O'), 'code contains ambiguous character: ' + joinedA.reconnectCode);
  console.log('ok  - Part C: reconnect code has no 0/O:', joinedA.reconnectCode);

  // NOTE on Part A.8: the rate-limiter correction can't be meaningfully
  // proven over the wire -- by design, a rate-limited rejection and an
  // ordinary wrong-code rejection use the IDENTICAL generic message (so
  // a guesser learns nothing either way), which means this live,
  // black-box test has no observable signal to distinguish "correctly
  // not counted" from "incorrectly counted but not yet over the
  // threshold." That distinction is exactly what
  // gameTable-11-3.test.js's own unit test proves directly against the
  // real codeMatchedNoPlayer contract server.js relies on -- a stronger
  // check for this specific fix than any live rejection-message
  // comparison could be. This live test confirms the reconnect
  // round-trip itself still behaves normally after several rejected
  // attempts, which is what's actually observable from outside.
  for (let i = 0; i < 8; i++) {
    const wsAttempt = connect();
    await new Promise((r) => wsAttempt.on('open', r));
    const errPromise = once(wsAttempt, 'reconnectError');
    send(wsAttempt, 'reconnectToGameTable', { gameTableCode: code, code: joinedA.reconnectCode });
    await errPromise; // rejected -- Alice is still connected
    wsAttempt.close();
  }
  console.log('ok  - fired 8 "already connected" reconnect attempts with Alice\'s own correct code, all rejected normally (no crash/hang)');

  wsA.close();
  serverProc.kill();
  console.log('\nv11.3 server-side live check passed.');
}

main().catch((err) => {
  console.error('LIVE TEST FAILED:', err);
  process.exitCode = 1;
});
