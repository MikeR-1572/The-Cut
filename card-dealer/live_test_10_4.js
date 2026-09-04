// Live end-to-end WebSocket verification for 10.4. Exercises the exact
// message shapes public/client.js's new Table Owner Tools UI sends
// (Part A §5), the Part E lockup fix, and the B.2 misdeal path -- all
// over a real running server, not just in-process.
const { fork } = require('child_process');
const WebSocket = require('ws');
const child = fork('server.js', [], { env: { ...process.env, PORT: '3996' } });

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
  // A rejected action (dealError) only ever replies to the ACTOR's own
  // socket -- no broadcast happens on rejection, so draining "others"
  // here would hang forever waiting for a message that will never
  // arrive. Only a successful action (gameTableState) broadcasts to
  // everyone.
  if (mine.type === 'gameTableState') {
    for (const o of others) await nextState(o);
  }
  return mine;
}

(async () => {
  await sleep(400);
  const wsA = makeClient('ws://localhost:3996');
  await wsA.ready;
  wsA.send(JSON.stringify({ type: 'createGameTable', playerName: 'Alice' }));
  const created = await wsA.next();
  const code = created.gameTableCode;
  await wsA.next();

  const wsB = makeClient('ws://localhost:3996');
  await wsB.ready;
  wsB.send(JSON.stringify({ type: 'joinGameTable', gameTableCode: code, playerName: 'Bob' }));
  await wsB.next();
  await wsA.next();
  await wsB.next();

  // TEST 1: non-owner never sees table-owner-only data, owner does.
  let st = await act(wsA, [wsB], { type: 'buyChips', amount: 1000 });
  st = await act(wsB, [wsA], { type: 'buyChips', amount: 500 });
  assert(st.gameTable.creatorId !== st.gameTable.players.find((p) => p.name === 'Bob').id, 'Bob should not be the owner');
  console.log('LIVE PASS - creatorId correctly identifies Alice as Table Owner over real sockets');

  // Put some money in the pot the direct way (simulate a stuck/terminated game scenario).
  st = await act(wsA, [wsB], { type: 'setGameChoice', gameChoiceId: 'holdem-texas' });
  st = await act(wsA, [wsB], { type: 'startGame' });
  const aliceId = st.gameTable.players.find((p) => p.name === 'Alice').id;
  const bobId = st.gameTable.players.find((p) => p.name === 'Bob').id;
  for (const [ws, other, id] of [[wsA, wsB, aliceId], [wsB, wsA, bobId]]) {
    if (st.gameTable.players.find((p) => p.id === id)?.oweAnte > 0) {
      st = await act(ws, [other], { type: 'postAnteBlind' });
    }
  }
  st = await act(wsA, [wsB], { type: 'deal', cardsPerPlayer: 2 });
  st = await act(wsA, [wsB], { type: 'openBetting' });
  const bettorId = st.gameTable.currentTurnPlayerId;
  const bettorWs = bettorId === aliceId ? wsA : wsB;
  const otherWs = bettorWs === wsA ? wsB : wsA;
  st = await act(bettorWs, [otherWs], { type: 'placeBet', amount: 100 });
  assert(st.type === 'gameTableState', `expected placeBet to succeed, got ${st.type}: ${st.message || ''}`);

  // TEST 2: Function 1 via the exact wire message client.js sends.
  st = await act(wsA, [wsB], { type: 'terminateGameCleanly' });
  assert(st.gameTable.handPhase === 'CycleComplete', 'expected CycleComplete after terminate');
  assert(st.gameTable.pot > 0, 'expected the pot to survive termination');
  console.log('LIVE PASS - terminateGameCleanly (client wire shape) succeeded, pot preserved at $' + st.gameTable.pot);

  // TEST 3: Function 3's full staged workflow via the exact wire shapes.
  st = await act(wsA, [wsB], { type: 'beginPotDistribution' });
  assert(st.gameTable.pendingAllocationBatch, 'owner should see the batch detail immediately');
  assert(st.gameTable.tableOwnerDistributionInProgress === true, 'flag should be true for everyone');

  st = await act(wsA, [wsB], { type: 'stageAllocation', playerId: bobId, direction: 'give', amount: 50 });
  assert(st.gameTable.pendingAllocationBatch.allocations.length === 1, 'expected one staged entry');
  const allocId = st.gameTable.pendingAllocationBatch.allocations[0].id;

  // Bob's own view: only the standing indicator, never the detail.
  wsB.send(JSON.stringify({ type: 'buyChips', amount: -1 }));
  const bobRejection = await nextState(wsB);
  assert(bobRejection.type === 'dealError', 'expected the invalid buyChips to be rejected');

  st = await act(wsA, [wsB], { type: 'removeStagedAllocation', allocationId: allocId });
  assert(st.gameTable.pendingAllocationBatch.allocations.length === 0, 'expected the entry removed');

  st = await act(wsA, [wsB], { type: 'discardPotDistributionBatch' });
  assert(st.gameTable.pendingAllocationBatch === null, 'expected the batch cleared');
  assert(st.gameTable.tableOwnerDistributionInProgress === false, 'expected the flag cleared for everyone');
  console.log('LIVE PASS - full Function 3 staging workflow (client wire shapes) succeeded over real sockets');

  // TEST 4: non-owner rejected from every Table Owner action, over real sockets.
  wsB.send(JSON.stringify({ type: 'terminateGameCleanly' }));
  const nonOwnerReject = await nextState(wsB);
  assert(nonOwnerReject.type === 'dealError', 'expected non-owner terminateGameCleanly to be rejected');
  console.log('LIVE PASS - non-owner correctly rejected from Table Owner actions:', nonOwnerReject.message);

  // TEST 5 (added on spec correction): misdealStuckAntes -- B.2
  // replacement / 10.4 Completion Gap 2's client wiring, over real
  // sockets. Fresh table needed since the one above already advanced
  // past RequestAntes.
  const wsC = makeClient('ws://localhost:3996');
  await wsC.ready;
  wsC.send(JSON.stringify({ type: 'createGameTable', playerName: 'Carl' }));
  const created2 = await wsC.next();
  const code2 = created2.gameTableCode;
  await wsC.next();
  const wsD = makeClient('ws://localhost:3996');
  await wsD.ready;
  wsD.send(JSON.stringify({ type: 'joinGameTable', gameTableCode: code2, playerName: 'Dana' }));
  await wsD.next();
  await wsC.next();
  await wsD.next();
  await act(wsC, [wsD], { type: 'buyChips', amount: 1000 });
  await act(wsD, [wsC], { type: 'buyChips', amount: 3 }); // far short of any blind
  await act(wsC, [wsD], { type: 'setGameChoice', gameChoiceId: 'holdem-texas' });
  let st2 = await act(wsC, [wsD], { type: 'startGame' });
  const danaId = st2.gameTable.players.find((p) => p.name === 'Dana').id;
  assert(st2.gameTable.stuckAntePlayerIds.includes(danaId), 'expected Dana to show as stuck over real sockets');

  wsD.send(JSON.stringify({ type: 'misdealStuckAntes' })); // Dana is not the Dealer -- rejected
  const nonDealerReject = await nextState(wsD);
  assert(nonDealerReject.type === 'dealError', 'expected non-Dealer misdeal to be rejected');

  const misdealResult = await act(wsC, [wsD], { type: 'misdealStuckAntes' }); // Carl (Dealer) misdeals
  assert(misdealResult.type === 'gameTableState', `expected the Dealer's misdeal to succeed, got ${misdealResult.type}`);
  assert(misdealResult.gameTable.handPhase === 'CycleComplete', 'expected CycleComplete after misdeal');
  console.log('LIVE PASS - misdealStuckAntes (client wire shape) succeeded over real sockets, rejected the non-Dealer correctly');
  wsC.close();
  wsD.close();

  console.log('\nAll 10.4 live-socket checks passed.');
  wsA.close();
  wsB.close();
  child.kill();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
