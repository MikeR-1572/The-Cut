// Live end-to-end WebSocket verification for 10.2. Focuses on item 1
// (the most severe of the six-to-eight §9.3 defects -- a never-dealt
// Player could be handed a REAL, actionable turn, completely bypassing
// turn-order logic) since it's the one live-confirmed by Mike as an
// actual submittable bet, not just a display glitch. Follows
// live_test_10_1.js's own pattern (announcement-draining helper).
const { fork } = require('child_process');
const WebSocket = require('ws');
const child = fork('server.js', [], { env: { ...process.env, PORT: '3994' } });

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
async function act(ws, others, payload) {
  ws.send(JSON.stringify(payload));
  const mine = await nextState(ws);
  for (const o of others) await nextState(o);
  return mine;
}

(async () => {
  await sleep(400);
  const wsA = makeClient('ws://localhost:3994');
  await wsA.ready;
  wsA.send(JSON.stringify({ type: 'createGameTable', playerName: 'Alice' }));
  const created = await wsA.next();
  const code = created.gameTableCode;
  await wsA.next();

  const wsB = makeClient('ws://localhost:3994'); // seated directly after Alice (the Dealer) -- never buys chips
  await wsB.ready;
  wsB.send(JSON.stringify({ type: 'joinGameTable', gameTableCode: code, playerName: 'Phantom' }));
  await wsB.next();
  await wsA.next();
  await wsB.next();

  const wsC = makeClient('ws://localhost:3994'); // real second player
  await wsC.ready;
  wsC.send(JSON.stringify({ type: 'joinGameTable', gameTableCode: code, playerName: 'Carl' }));
  await wsC.next();
  await wsA.next();
  await wsB.next();
  await wsC.next();

  // Alice and Carl buy chips; Bob (Phantom) never does.
  await act(wsA, [wsB, wsC], { type: 'buyChips', amount: 1000 });
  await act(wsC, [wsA, wsB], { type: 'buyChips', amount: 1000 });
  await act(wsA, [wsB, wsC], { type: 'setGameChoice', gameChoiceId: 'draw-5card' });
  await act(wsA, [wsB, wsC], { type: 'setGameOption', key: 'anteAmount', value: 0 });
  await act(wsA, [wsB, wsC], { type: 'startGame' });
  const st = await act(wsA, [wsB, wsC], { type: 'deal', cardsPerPlayer: 5 });

  const phantomId = st.gameTable.players.find((p) => p.name === 'Phantom').id;
  const phantomState = st.gameTable.players.find((p) => p.id === phantomId);
  assert(phantomState.handCount === 0, `expected Phantom to have 0 cards, got ${phantomState.handCount}`);
  console.log('LIVE PASS - Phantom (never bought chips) correctly received no cards');

  const openResult = await act(wsA, [wsB, wsC], { type: 'openBetting' });
  assert(openResult.type === 'gameTableState', `expected openBetting to succeed, got ${openResult.type}: ${openResult.message || ''}`);
  assert(
    openResult.gameTable.currentTurnPlayerId !== phantomId,
    'THE BUG: openBetting() handed the first-actor turn to the never-dealt Phantom player'
  );
  console.log('LIVE PASS - openBetting() did NOT hand the first-actor turn to the never-dealt Phantom player');

  // Confirm the actual current actor really can act (sanity check the
  // turn landed on a real, legitimate player).
  const actualActor = openResult.gameTable.currentTurnPlayerId;
  const actorName = openResult.gameTable.players.find((p) => p.id === actualActor)?.name;
  assert(actorName === 'Alice' || actorName === 'Carl', `expected a real player to act, got ${actorName}`);
  console.log(`LIVE PASS - first real actor is ${actorName}, as expected`);

  console.log('\nAll 10.2 live-socket checks passed.');
  wsA.close();
  wsB.close();
  wsC.close();
  child.kill();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
