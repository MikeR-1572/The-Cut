const { fork } = require('child_process');
const WebSocket = require('ws');
const child = fork('server.js', [], { env: { ...process.env, PORT: '3961' } });

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
  const wsA = makeClient('ws://localhost:3961');
  await wsA.ready;
  wsA.send(JSON.stringify({ type: 'createGameTable', playerName: 'Alice' }));
  const j = await wsA.next();
  const code = j.gameTableCode;
  await wsA.next();

  const wsB = makeClient('ws://localhost:3961');
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

  await act(wsA, [wsB], { type: 'buyChips', amount: 400 });
  await act(wsB, [wsA], { type: 'buyChips', amount: 175 });
  await act(wsA, [wsB], { type: 'setGameChoice', gameChoiceId: 'stud-7card' });
  await act(wsA, [wsB], { type: 'setGameOption', key: 'anteAmount', value: 0 });
  await act(wsA, [wsB], { type: 'setGameOption', key: 'bringIn', value: 5 });
  await act(wsA, [wsB], { type: 'startGame' });
  const [s1] = await act(wsA, [wsB], { type: 'deal', cardsPerPlayer: 3 });
  console.log('handPhase after deal:', s1.gameTable.handPhase);

  const bobId = s1.gameTable.players.find((p) => p.name === 'Bob').id;
  await act(wsA, [wsB], { type: 'setOpeningBettor', playerId: bobId });
  const [s1b] = await act(wsA, [wsB], { type: 'openBetting' });
  console.log('turn player:', s1b.gameTable.currentTurnPlayerId, 'players:', s1b.gameTable.players.map((p) => p.id + '=' + p.name));

  const turnIsAlice = s1b.gameTable.currentTurnPlayerId === s1b.gameTable.players.find((p) => p.name === 'Alice').id;
  const actorWs = turnIsAlice ? wsA : wsB;
  const otherWs = turnIsAlice ? wsB : wsA;
  const [s2] = await act(actorWs, [otherWs], { type: 'allIn' });
  console.log('allIn result ok, pot:', s2.gameTable.pot);
  console.log('bettingStructure exposed:', s2.gameTable.bettingStructure);

  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  child.kill();
  process.exit(1);
});
