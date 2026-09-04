const { fork } = require('child_process');
const WebSocket = require('ws');
const child = fork('server.js', [], { env: { ...process.env, PORT: '3972' } });

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
  const wsA = makeClient('ws://localhost:3972');
  await wsA.ready;
  wsA.send(JSON.stringify({ type: 'createGameTable', playerName: 'Alice' }));
  const j = await wsA.next();
  const code = j.gameTableCode;
  await wsA.next();

  const wsB = makeClient('ws://localhost:3972');
  await wsB.ready;
  wsB.send(JSON.stringify({ type: 'joinGameTable', gameTableCode: code, playerName: 'Bob' }));
  await wsB.next();
  await wsA.next();
  await wsB.next();

  const wsC = makeClient('ws://localhost:3972');
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

  await act(wsA, [wsB, wsC], { type: 'buyChips', amount: 1000 });
  await act(wsB, [wsA, wsC], { type: 'buyChips', amount: 1000 });
  await act(wsC, [wsA, wsB], { type: 'buyChips', amount: 1000 });
  await act(wsA, [wsB, wsC], { type: 'setGameChoice', gameChoiceId: 'holdem-texas' });
  await act(wsA, [wsB, wsC], { type: 'setGameOption', key: 'smallBlind', value: 5 });
  await act(wsA, [wsB, wsC], { type: 'setGameOption', key: 'bigBlind', value: 10 });
  await act(wsA, [wsB, wsC], { type: 'setGameOption', key: 'bettingStructure', value: 'pot-limit' });
  await act(wsA, [wsB, wsC], { type: 'startGame' });
  const namesEarly = {};
  const stateAfterStart = await new Promise((resolve) => {
    // startGame already broadcast; grab it from the last act() call instead
    resolve(null);
  });
  // Post blinds for whoever owes them -- try all three, ignore failures for those who don't owe.
  for (const [ws, others] of [
    [wsA, [wsB, wsC]],
    [wsB, [wsA, wsC]],
    [wsC, [wsA, wsB]],
  ]) {
    ws.send(JSON.stringify({ type: 'postAnteBlind' }));
    const first = await ws.next();
    if (first.type === 'gameTableState') {
      await Promise.all(others.map((s) => s.next()));
    }
    // else: dealError (didn't owe anything) -- no broadcast happened, nothing more to drain
  }
  await act(wsA, [wsB, wsC], { type: 'deal', cardsPerPlayer: 2 });
  const [s1] = await act(wsA, [wsB, wsC], { type: 'openBetting' });

  const names = {};
  s1.gameTable.players.forEach((p) => (names[p.id] = p.name));
  const nameToWs = { Alice: wsA, Bob: wsB, Carl: wsC };
  const firstActor = names[s1.gameTable.currentTurnPlayerId];
  console.log('first to act:', firstActor);

  const others1 = [wsA, wsB, wsC].filter((s) => s !== nameToWs[firstActor]);
  const [s2] = await act(nameToWs[firstActor], others1, { type: 'placeBet', amount: 30 });
  console.log(firstActor + ' raised to 30, pot now:', s2.gameTable.pot);

  const nextActorId = s2.gameTable.currentTurnPlayerId;
  const nextActorName = names[nextActorId];
  const nextActorState = s2.gameTable.players.find((p) => p.id === nextActorId);
  console.log('next to act:', nextActorName, 'already has $' + nextActorState.currentBet + ' in this street');

  const callAmount = s2.gameTable.currentBetToCall - nextActorState.currentBet;
  const expectedMax = callAmount + (s2.gameTable.pot + callAmount);
  console.log('expected Pot-Limit max (fixed formula):', expectedMax);

  const actorWs = nameToWs[nextActorName];
  actorWs.send(JSON.stringify({ type: 'placeBet', amount: expectedMax + 1 }));
  const rejectMsg = await actorWs.next();
  console.log('over-max rejected:', rejectMsg.type === 'dealError', '-', rejectMsg.message);

  actorWs.send(JSON.stringify({ type: 'placeBet', amount: expectedMax }));
  const acceptMsg = await actorWs.next();
  console.log('at-max accepted:', acceptMsg.type === 'gameTableState');

  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  child.kill();
  process.exit(1);
});
