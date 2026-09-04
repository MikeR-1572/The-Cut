const { fork } = require('child_process');
const WebSocket = require('ws');
const child = fork('server.js', [], { env: { ...process.env, PORT: '3991' } });

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
  const wsA = makeClient('ws://localhost:3991');
  await wsA.ready;
  wsA.send(JSON.stringify({ type: 'createGameTable', playerName: 'Alice' }));
  const j = await wsA.next();
  const code = j.gameTableCode;
  await wsA.next();

  const wsB = makeClient('ws://localhost:3991');
  await wsB.ready;
  wsB.send(JSON.stringify({ type: 'joinGameTable', gameTableCode: code, playerName: 'Bob' }));
  await wsB.next();
  await wsA.next();
  await wsB.next();

  const wsC = makeClient('ws://localhost:3991');
  await wsC.ready;
  wsC.send(JSON.stringify({ type: 'joinGameTable', gameTableCode: code, playerName: 'Carl' }));
  await wsC.next();
  await wsA.next();
  await wsB.next();
  await wsC.next();

  async function act(actorWs, otherSockets, payload) {
    actorWs.send(JSON.stringify(payload));
    const first = await actorWs.next();
    if (first.type === 'dealError') throw new Error('dealError on ' + JSON.stringify(payload) + ': ' + first.message);
    const rest = await Promise.all(otherSockets.map((s) => s.next()));
    return [first, ...rest];
  }

  await act(wsA, [wsB, wsC], { type: 'buyChips', amount: 50 });
  await act(wsB, [wsA, wsC], { type: 'buyChips', amount: 1000 });
  await act(wsC, [wsA, wsB], { type: 'buyChips', amount: 1000 });
  await act(wsA, [wsB, wsC], { type: 'setGameChoice', gameChoiceId: 'holdem-texas' });
  await act(wsA, [wsB, wsC], { type: 'setGameOption', key: 'smallBlind', value: 0 });
  await act(wsA, [wsB, wsC], { type: 'setGameOption', key: 'bigBlind', value: 0 });
  await act(wsA, [wsB, wsC], { type: 'startGame' });
  await act(wsA, [wsB, wsC], { type: 'deal', cardsPerPlayer: 2 });
  const [s1] = await act(wsA, [wsB, wsC], { type: 'openBetting' });

  const names = {};
  s1.gameTable.players.forEach((p) => (names[p.id] = p.name));
  const nameToWs = { Alice: wsA, Bob: wsB, Carl: wsC };
  const firstActor = names[s1.gameTable.currentTurnPlayerId];
  console.log('first to act (short stack):', firstActor);

  const others1 = [wsA, wsB, wsC].filter((s) => s !== nameToWs[firstActor]);
  await act(nameToWs[firstActor], others1, { type: 'allIn' });
  console.log(firstActor + ' went all-in');

  const others = ['Alice', 'Bob', 'Carl'].filter((n) => n !== firstActor);
  for (const name of others) {
    const ws = nameToWs[name];
    const otherWs = [wsA, wsB, wsC].filter((s) => s !== ws);
    await act(ws, otherWs, { type: 'fold' });
    console.log(name + ' folded');
  }

  const [s2] = await act(nameToWs[firstActor], others1, { type: 'claimPot', allocations: [{ playerId: s1.gameTable.currentTurnPlayerId, amount: s1.gameTable.pot }] });
  console.log('claim succeeded, pot:', s2.gameTable.pot);

  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  child.kill();
  process.exit(1);
});
