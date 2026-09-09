'use strict';
// FIXED 11.5 (Part D): this file previously used console.assert(),
// which in Node.js only prints a warning on failure and never affects
// the exit code -- proven adversarially during the 11.5 review by
// deliberately breaking the real exclusion under test and observing
// byte-for-byte identical "passed" output and exit code 0. It also
// assumed TEST_SWEEP_MS/TEST_INACTIVITY_SECONDS environment-variable
// overrides that only ever existed on a temporary, reverted local copy
// of server.js/gameTable.js -- never in the actually-shipped code, so
// this test could never have exercised anything real. Both are fixed
// here: real assert() calls that genuinely fail the process, and
// genuine, permanent env-var support now wired into server.js/
// gameTable.js themselves (see their own comments).
const assert = require('assert');
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
  try {
    await wait(600);

    // --- Part A: clientHeartbeat -> clientHeartbeatAck ---
    const wsA = connect();
    await new Promise((r) => wsA.on('open', r));
    const ackPromise = once(wsA, 'clientHeartbeatAck');
    send(wsA, 'clientHeartbeat');
    await ackPromise; // if this never resolves, the test hangs and the harness reports a real failure -- no assertion even needed here
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
    assert.strictEqual(raced.hit, true, 'expected the table to auto-close despite ongoing heartbeats, but it never closed within 7s -- got: ' + JSON.stringify(raced));
    assert.ok(/inactivity/i.test(raced.m.message || ''), 'expected a tableEnded message citing inactivity, got: ' + JSON.stringify(raced.m));
    console.log('ok  - Part A/H.2: table closed on schedule despite continuous heartbeats -- heartbeats do not reset the inactivity clock:', raced.m.message);

    wsA.close();
    console.log('\nv11.4 server-side live check passed.');
  } finally {
    // FIXED 11.5 (Part D): moved into a finally block -- confirmed
    // during the adversarial re-check that a failed assertion left the
    // spawned server process running, which kept the whole test hanging
    // until an external timeout killed it, masking the real (correct)
    // nonzero exit this test had already set via the catch handler below.
    serverProc.kill();
  }
}

main().catch((err) => {
  console.error('LIVE TEST FAILED:', err);
  process.exitCode = 1;
});
