const { fork } = require('child_process');
const WebSocket = require('ws');
const child = fork('server.js', [], { env: { ...process.env, PORT: '3981' } });

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

(async () => {
  await sleep(400);
  const wsA = makeClient('ws://localhost:3981');
  await wsA.ready;
  wsA.send(JSON.stringify({ type: 'createGameTable', playerName: 'Alice' }));
  const j = await wsA.next();
  const code = j.gameTableCode;
  await wsA.next();

  const wsB = makeClient('ws://localhost:3981');
  await wsB.ready;
  wsB.send(JSON.stringify({ type: 'joinGameTable', gameTableCode: code, playerName: 'Bob' }));
  await wsB.next();
  await wsA.next();
  await wsB.next();

  async function act(actorWs, otherSockets, payload) {
    actorWs.send(JSON.stringify(payload));
    const first = await actorWs.next();
    if (first.type === 'dealError') throw new Error('dealError on ' + JSON.stringify(payload) + ': ' + first.message);
    const rest = await Promise.all(otherSockets.map((s) => s.next()));
    return [first, ...rest];
  }

  // Alice (Dealer) never buys chips -- stays at $0. Bob does.
  await act(wsB, [wsA], { type: 'buyChips', amount: 1000 });
  await act(wsA, [wsB], { type: 'setGameChoice', gameChoiceId: 'draw-5card' });
  const [s1] = await act(wsA, [wsB], { type: 'startGame' });

  const alice = s1.gameTable.players.find((p) => p.name === 'Alice');
  console.log('Alice: isDealer=' + alice.isDealer + ' sittingOut=' + alice.sittingOut + ' excludedForZeroChips=' + alice.excludedForZeroChips);

  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  child.kill();
  process.exit(1);
});
