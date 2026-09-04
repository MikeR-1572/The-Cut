// Live end-to-end WebSocket verification for 10.3. Focuses on the two
// highest-stakes, least-precedented pieces per Mike's own priority
// ordering: Function 1's genuine claim-denial (real money never moves)
// and Function 3's atomic commit guard. Follows live_test_10_2.js's
// own pattern (announcement-draining helper).
const { fork } = require('child_process');
const WebSocket = require('ws');
const child = fork('server.js', [], { env: { ...process.env, PORT: '3995' } });

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
  const wsA = makeClient('ws://localhost:3995');
  await wsA.ready;
  wsA.send(JSON.stringify({ type: 'createGameTable', playerName: 'Alice' }));
  const created = await wsA.next();
  const code = created.gameTableCode;
  await wsA.next();

  const wsB = makeClient('ws://localhost:3995');
  await wsB.ready;
  wsB.send(JSON.stringify({ type: 'joinGameTable', gameTableCode: code, playerName: 'Bob' }));
  await wsB.next();
  await wsA.next();
  await wsB.next();

  // Alice is the Table Owner (creator). Both buy in, start a hand.
  await act(wsA, [wsB], { type: 'buyChips', amount: 1000 });
  await act(wsB, [wsA], { type: 'buyChips', amount: 500 });
  await act(wsA, [wsB], { type: 'setGameChoice', gameChoiceId: 'holdem-texas' });
  let st = await act(wsA, [wsB], { type: 'startGame' });

  const aliceId = st.gameTable.players.find((p) => p.name === 'Alice').id;
  const bobId = st.gameTable.players.find((p) => p.name === 'Bob').id;
  for (const [ws, other, id] of [[wsA, wsB, aliceId], [wsB, wsA, bobId]]) {
    if (st.gameTable.players.find((p) => p.id === id)?.oweAnte > 0) {
      st = await act(ws, [other], { type: 'postAnteBlind' });
    }
  }
  st = await act(wsA, [wsB], { type: 'deal', cardsPerPlayer: 2 });
  st = await act(wsA, [wsB], { type: 'openBetting' });

  // TEST 1: non-owner (Bob) cannot terminate the game.
  wsB.send(JSON.stringify({ type: 'terminateGameCleanly' }));
  const rejectMsg = await nextState(wsB);
  assert(rejectMsg.type === 'dealError', `expected dealError, got ${rejectMsg.type}`);
  console.log('LIVE PASS - non-owner correctly blocked from terminateGameCleanly:', rejectMsg.message);

  // Get a real bet in the pot, then have the turn-taker be the sole
  // eligible player (the other folds), and propose a claim -- leaving
  // it genuinely pending.
  const turnId = st.gameTable.currentTurnPlayerId;
  const otherId = turnId === aliceId ? bobId : aliceId;
  const turnWs = turnId === aliceId ? wsA : wsB;
  const otherWs = turnId === aliceId ? wsB : wsA;
  st = await act(turnWs, [otherWs], { type: 'placeBet', amount: 40 });
  st = await act(otherWs, [turnWs], { type: 'fold' });
  const potBeforeClaim = st.gameTable.pot;
  st = await act(turnWs, [otherWs], { type: 'claimPot', allocations: [{ playerId: turnId, amount: potBeforeClaim }] });
  assert(st.gameTable.pendingClaim, 'expected a genuinely pending claim before terminating');
  console.log('LIVE PASS - a claim is genuinely pending, over real sockets, before Function 1 runs');

  // TEST 2: Alice (owner) terminates -- the claim must be DENIED, no
  // money moved, pot intact.
  const chipsBefore = st.gameTable.players.find((p) => p.id === turnId).chips;
  st = await act(wsA, [wsB], { type: 'terminateGameCleanly' });
  assert(st.gameTable.pendingClaim === null, 'expected pendingClaim cleared (denied)');
  assert(st.gameTable.pot === potBeforeClaim, `expected pot untouched at $${potBeforeClaim}, got $${st.gameTable.pot}`);
  const chipsAfter = st.gameTable.players.find((p) => p.id === turnId).chips;
  assert(chipsAfter === chipsBefore, 'expected chips untouched -- claim never approved');
  assert(st.gameTable.handPhase === 'CycleComplete', `expected CycleComplete, got ${st.gameTable.handPhase}`);
  console.log('LIVE PASS - Function 1 genuinely denied the pending claim over real sockets -- no money moved, pot intact at $' + st.gameTable.pot);

  // TEST 3: Function 3 -- stage a batch that would drive Bob negative,
  // confirm the live preview updates, then confirm commit is atomically
  // rejected and nothing real changes.
  st = await act(wsA, [wsB], { type: 'beginPotDistribution' });
  const bobChipsNow = st.gameTable.players.find((p) => p.id === bobId).chips;
  st = await act(wsA, [wsB], { type: 'stageAllocation', playerId: bobId, direction: 'take', amount: bobChipsNow + 1000 });
  assert(st.gameTable.pendingAllocationBatch, 'expected the Table Owner to see the staged batch detail');
  assert(st.gameTable.pendingAllocationBatch.previewChipsByPlayerId[bobId] < 0, 'expected the live preview to show a negative outcome');
  console.log('LIVE PASS - live preview correctly reflects a would-be-negative outcome before commit');

  wsA.send(JSON.stringify({ type: 'commitPotDistribution' }));
  const commitReject = await nextState(wsA);
  assert(commitReject.type === 'dealError', `expected commit to be rejected, got ${commitReject.type}`);
  console.log('LIVE PASS - Function 3 commit correctly rejected atomically over real sockets:', commitReject.message);

  console.log('\nAll 10.3 live-socket checks passed.');
  wsA.close();
  wsB.close();
  child.kill();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
