// sync_test.mjs — headless integration test for the loom-server WS
// sync. Spins up two Yjs clients connecting to the same project
// room, has each insert text, and asserts the other sees the
// updates within a deadline. Exits non-zero on any divergence.
//
// Why : the WebView / Safari diagnostic loop was costing one
// human-test per code change. This script runs in ~3s and tells
// us whether the WS relay + the Yjs protocol agree on the
// document content — independent of any browser quirks.
//
// Run :
//   node tests/sync_test.mjs                       # default port 8080
//   LOOM_URL=http://127.0.0.1:9090 node tests/sync_test.mjs

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { WebSocket } from 'ws';

// Node.js doesn't have a WebSocket global ; y-websocket auto-detects
// and uses the polyfill the caller injects.
globalThis.WebSocket = WebSocket;

const baseURL = process.env.LOOM_URL ?? 'http://127.0.0.1:8080';
const wsBaseURL = baseURL.replace(/^http/, 'ws');
const project = process.env.LOOM_PROJECT ?? 'demo';
// Pick a unique room per run so the relay's in-memory state from a
// prior test doesn't leak into this one (would show up as duplicate
// "hellohello world" content).
const room = process.env.LOOM_ROOM ?? 'test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
const wsURL = `${wsBaseURL}/api/projects/${encodeURIComponent(project)}/sync`;

const TIMEOUT = 5000;

function pass(msg) {
  console.log(`✅ ${msg}`);
}
function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exitCode = 1;
}

async function waitFor(predicate, timeoutMs = TIMEOUT, every = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, every));
  }
  return false;
}

function makeClient(name) {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(wsURL, room, ydoc, {
    WebSocketPolyfill: WebSocket,
    connect: true,
  });
  const ytext = ydoc.getText('file:sync-test.txt');
  let updateCount = 0;
  ydoc.on('update', () => {
    updateCount++;
  });
  provider.on('status', (e) => {
    console.log(`[${name}] status=${e.status}`);
  });
  return {
    name,
    ydoc,
    ytext,
    provider,
    get updateCount() {
      return updateCount;
    },
    text: () => ytext.toString(),
    destroy: () => {
      provider.disconnect();
      provider.destroy();
      ydoc.destroy();
    },
  };
}

async function main() {
  console.log(`▶ loom sync test — WS ${wsURL} room=${room}`);
  const A = makeClient('A');
  const B = makeClient('B');

  // 1. Wait for both providers to declare themselves synced.
  const aSynced = await waitFor(() => A.provider.synced);
  const bSynced = await waitFor(() => B.provider.synced);
  if (!aSynced) fail('A never received sync');
  else pass('A synced with relay');
  if (!bSynced) fail('B never received sync');
  else pass('B synced with relay');

  // 2. A inserts "hello" ; B should see "hello" within TIMEOUT.
  A.ytext.insert(0, 'hello');
  console.log(`[A] inserted "hello" → ytext="${A.text()}"`);
  const sawA = await waitFor(() => B.text() === 'hello');
  if (sawA) pass('B saw A\'s insert');
  else fail(`B did NOT see A's insert (B.text="${B.text()}", A.text="${A.text()}", A.updates=${A.updateCount}, B.updates=${B.updateCount})`);

  // 3. B inserts " world" ; A should see "hello world".
  B.ytext.insert(B.text().length, ' world');
  console.log(`[B] inserted " world" → ytext="${B.text()}"`);
  const sawB = await waitFor(() => A.text() === 'hello world');
  if (sawB) pass('A saw B\'s insert');
  else fail(`A did NOT see B's insert (A.text="${A.text()}", B.text="${B.text()}")`);

  // 4. Multi-keystroke test : A types "ABC" character by character.
  const startLen = A.text().length;
  A.ytext.insert(startLen, 'A');
  await new Promise((r) => setTimeout(r, 30));
  A.ytext.insert(startLen + 1, 'B');
  await new Promise((r) => setTimeout(r, 30));
  A.ytext.insert(startLen + 2, 'C');
  console.log(`[A] inserted A,B,C → ytext="${A.text()}"`);
  const sawMulti = await waitFor(() => B.text() === A.text());
  if (sawMulti) pass(`B saw all 3 of A's keystrokes ("${B.text()}")`);
  else fail(`B saw partial : A.text="${A.text()}", B.text="${B.text()}"`);

  // 5. Reverse multi-keystroke : B types "XYZ".
  const startLen2 = B.text().length;
  B.ytext.insert(startLen2, 'X');
  await new Promise((r) => setTimeout(r, 30));
  B.ytext.insert(startLen2 + 1, 'Y');
  await new Promise((r) => setTimeout(r, 30));
  B.ytext.insert(startLen2 + 2, 'Z');
  console.log(`[B] inserted X,Y,Z → ytext="${B.text()}"`);
  const sawReverse = await waitFor(() => A.text() === B.text());
  if (sawReverse) pass(`A saw all 3 of B's keystrokes ("${A.text()}")`);
  else fail(`A saw partial : B.text="${B.text()}", A.text="${A.text()}"`);

  // 6. Convergence : after both done, both should have identical text.
  if (A.text() === B.text()) pass(`Convergence : both at "${A.text()}"`);
  else fail(`Divergence : A="${A.text()}" vs B="${B.text()}"`);

  A.destroy();
  B.destroy();
  // Give NATS the time to flush before exit.
  await new Promise((r) => setTimeout(r, 200));
  if (process.exitCode === 1) {
    console.error('\n❌ some assertions failed');
  } else {
    console.log('\n✅ all assertions passed');
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('crashed:', e);
  process.exit(2);
});
