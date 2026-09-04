// Live end-to-end WebSocket verification for 10.0 -- per project
// convention, in-process test suite passing is never sufficient on its
// own. Follows live_test_97.js's own pattern (each client only awaits
// its OWN next message; a Promise.all across every socket would hang
// forever the moment one action produces a dealError, since dealError
// only ever broadcasts to the acting player's own socket -- the
// documented harness gotcha from the handoff briefing).
const { fork } = require('child_process');
const WebSocket = require('ws');
const child = fork('server.js', [], { env: { ...process.env, PORT: '3992' } });

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

(async () => {
  await sleep(400);
  const wsA = makeClient('ws://localhost:3992');
  await wsA.ready;
  wsA.send(JSON.stringify({ type: 'createGameTable', playerName: 'Alice' }));
  const created = await wsA.next();
  const code = created.gameTableCode;
  await wsA.next(); // Alice's own initial gameTableState

  const wsB = makeClient('ws://localhost:3992');
  await wsB.ready;
  wsB.send(JSON.stringify({ type: 'joinGameTable', gameTableCode: code, playerName: 'Bob' }));
  await wsB.next(); // Bob's join ack
  await wsA.next(); // Alice's state update on Bob joining
  await wsB.next(); // Bob's own state update

  // Alice is Dealer (first player). Buy chips, start game, deal, open betting.
  wsA.send(JSON.stringify({ type: 'buyChips', amount: 500 }));
  await wsA.next();
  await wsB.next();
  wsB.send(JSON.stringify({ type: 'buyChips', amount: 500 }));
  await wsA.next();
  await wsB.next();

  wsA.send(JSON.stringify({ type: 'setGameChoice', gameChoiceId: 'draw-5card' }));
  await wsA.next();
  await wsB.next();
  wsA.send(JSON.stringify({ type: 'setGameOption', key: 'anteAmount', value: 0 }));
  await wsA.next();
  await wsB.next();
  wsA.send(JSON.stringify({ type: 'startGame' }));
  await wsA.next();
  await wsB.next();
  wsA.send(JSON.stringify({ type: 'deal', cardsPerPlayer: 5 }));
  await wsA.next();
  await wsB.next();
  wsA.send(JSON.stringify({ type: 'openBetting' }));
  const afterOpenA = await wsA.next();
  await wsB.next();

  const gt1 = afterOpenA.gameTable;
  const turnPlayerId = gt1.currentTurnPlayerId;
  const turnIsAlice = turnPlayerId === gt1.players.find((p) => p.name === 'Alice').id;
  const turnSocket = turnIsAlice ? wsA : wsB;
  const otherSocket = turnIsAlice ? wsB : wsA;

  // TEST 1: the player to act is pending (mid-hand, not folded, no side-pot loss).
  const meState = gt1.players.find((p) => p.id === turnPlayerId);
  assert(meState.pending === true, `expected active mid-hand player to be pending, got ${meState.pending}`);
  console.log('LIVE PASS - mid-hand active player correctly shows pending: true');

  // TEST 2: buyChips is rejected server-side for that pending player, over a real socket.
  turnSocket.send(JSON.stringify({ type: 'buyChips', amount: 100 }));
  const rejectMsg = await turnSocket.next();
  assert(rejectMsg.type === 'dealError', `expected dealError, got ${rejectMsg.type}`);
  assert(/pending/i.test(rejectMsg.message), `expected a pending-related error, got: ${rejectMsg.message}`);
  console.log('LIVE PASS - buyChips correctly rejected mid-hand for a pending player:', rejectMsg.message);

  // TEST 3: that same player folds, becomes eligible to buy chips immediately (§5.3/§5.5).
  turnSocket.send(JSON.stringify({ type: 'fold' }));
  const afterFoldTurn = await turnSocket.next();
  await otherSocket.next();
  const foldedState = afterFoldTurn.gameTable.players.find((p) => p.id === turnPlayerId);
  assert(foldedState.folded === true, 'expected the acting player to now be folded');
  assert(foldedState.pending === false, 'expected a folded player to no longer be pending');

  turnSocket.send(JSON.stringify({ type: 'buyChips', amount: 100 }));
  const afterBuy = await turnSocket.next();
  await otherSocket.next(); // drain the OTHER socket's own broadcast of this same buyChips success -- forgetting this leaves a stale message in its queue for the next assertion to wrongly consume
  assert(afterBuy.type === 'gameTableState', `expected buyChips to succeed post-fold, got ${afterBuy.type}: ${afterBuy.message || ''}`);
  console.log('LIVE PASS - buyChips correctly allowed mid-hand once folded, hand still live for the other player');

  // TEST 4: the Dealer (Alice) cannot Sit Out directly.
  wsA.send(JSON.stringify({ type: 'sitOut', mode: 'foldAndSitOut' }));
  const dealerSitOutResult = await wsA.next();
  assert(dealerSitOutResult.type === 'dealError', `expected dealError for Dealer sitOut, got ${dealerSitOutResult.type}`);
  assert(/Pass the Buck/i.test(dealerSitOutResult.message), `expected Pass-the-Buck error, got: ${dealerSitOutResult.message}`);
  console.log('LIVE PASS - Dealer correctly blocked from Sit Out directly:', dealerSitOutResult.message);

  console.log('\nAll 10.0 live-socket checks passed.');
  wsA.close();
  wsB.close();
  child.kill();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
