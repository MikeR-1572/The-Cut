// Live end-to-end WebSocket verification for 10.1. Focuses on the
// single most severe fix this session found (openBetting()'s
// minimum-active-player gate blocking a hand dead when a legitimately
// all-in Player survives to a later street -- confirmed via direct
// reproduction, not just traced) plus a live re-check of sitOut/pending
// behavior touched extensively this session, since the in-process suite
// alone is never sufficient per project convention. Follows
// live_test_10_0.js's own pattern.
const { fork } = require('child_process');
const WebSocket = require('ws');
const child = fork('server.js', [], { env: { ...process.env, PORT: '3993' } });

function makeClient(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (waiters.length) waiters.shift()(m);
    else queue.push(m);
  });
  ws.next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));
  ws.ready = new Promise((r) => ws.on('open', r));
  return ws;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function assert(cond, msg) {
  if (!cond) throw new Error('LIVE TEST FAILED: ' + msg);
}
async function nextState(ws) {
  let msg = await ws.next();
  while (msg.type === 'announcement') msg = await ws.next();
  return msg;
}
async function act(ws, other, payload) {
  ws.send(JSON.stringify(payload));
  const mine = await nextState(ws);
  await nextState(other);
  return mine;
}

(async () => {
  await sleep(400);
  const wsA = makeClient('ws://localhost:3993');
  await wsA.ready;
  wsA.send(JSON.stringify({ type: 'createGameTable', playerName: 'Alice' }));
  const created = await wsA.next();
  const code = created.gameTableCode;
  await wsA.next();

  const wsB = makeClient('ws://localhost:3993');
  await wsB.ready;
  wsB.send(JSON.stringify({ type: 'joinGameTable', gameTableCode: code, playerName: 'Bob' }));
  await wsB.next();
  await wsA.next();
  await wsB.next();

  await act(wsA, wsB, { type: 'buyChips', amount: 100 });
  await act(wsB, wsA, { type: 'buyChips', amount: 1000 });
  await act(wsA, wsB, { type: 'setGameChoice', gameChoiceId: 'holdem-texas' });
  let st = await act(wsA, wsB, { type: 'startGame' });

  const aliceId = st.gameTable.players.find((p) => p.name === 'Alice').id;
  const bobId = st.gameTable.players.find((p) => p.name === 'Bob').id;
  for (const [ws, other, id] of [
    [wsA, wsB, aliceId],
    [wsB, wsA, bobId],
  ]) {
    if (st.gameTable.players.find((p) => p.id === id)?.oweAnte > 0) {
      st = await act(ws, other, { type: 'postAnteBlind' });
    }
  }

  st = await act(wsA, wsB, { type: 'deal', cardsPerPlayer: 2 });
  st = await act(wsA, wsB, { type: 'openBetting' });

  let guard = 0;
  while (st.gameTable.bettingOpen && guard++ < 10) {
    const turnId = st.gameTable.currentTurnPlayerId;
    const ws = turnId === aliceId ? wsA : wsB;
    const other = ws === wsA ? wsB : wsA;
    st = await act(ws, other, turnId === aliceId ? { type: 'allIn' } : { type: 'call' });
  }
  const aliceState = st.gameTable.players.find((p) => p.name === 'Alice');
  assert(
    aliceState.chips === 0 && aliceState.allIn === true,
    `expected Alice all-in with $0, got chips=${aliceState.chips} allIn=${aliceState.allIn}`
  );
  console.log('LIVE PASS - Alice went genuinely all-in pre-flop, Bob called');

  st = await act(wsA, wsB, { type: 'dealCommunity' });
  assert(st.gameTable.handPhase === 'FlopBetting', `expected FlopBetting, got ${st.gameTable.handPhase}`);

  const openResult = await act(wsA, wsB, { type: 'openBetting' });
  assert(
    openResult.type === 'gameTableState',
    `expected openBetting to SUCCEED on the flop, got ${openResult.type}: ${openResult.message || ''}`
  );
  console.log('LIVE PASS - openBetting() succeeded on the flop with an all-in survivor from pre-flop (previously a hard dead end)');

  wsA.send(JSON.stringify({ type: 'buyChips', amount: 50 }));
  const buyResult = await nextState(wsA);
  assert(
    buyResult.type === 'dealError' && /pending/i.test(buyResult.message),
    `expected buyChips still rejected for pending Alice, got ${JSON.stringify(buyResult)}`
  );
  console.log("LIVE PASS - buyChips still correctly rejected for the pending all-in player after this session's changes");

  console.log('\nAll 10.1 live-socket checks passed.');
  wsA.close();
  wsB.close();
  child.kill();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
