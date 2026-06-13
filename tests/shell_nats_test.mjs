// shell_nats_test.mjs — drives the SPA's xterm tab through the
// loom-server WS, expects the embedded NATS broker + devagent to
// route to /bin/bash on the host. Validates the entire
// SPA → WS → loom-server → NATS → devagent → pty round trip.
//
// Run :  node tests/shell_nats_test.mjs
//        (loom-server must be running with embedded NATS enabled)
//
// Wire :
//   client → 'i' + 'echo hello\r' to /api/projects/<p>/shell
//   server publishes weft.exec.<vmID>.<sid>.open + relays in/out
//   devagent.runSession spawns bash, echoes the line back
//   client receives 'o' + "hello\r\n" on the WS

import WebSocket from 'ws';

const URL = process.env.LOOM_URL ?? 'http://127.0.0.1:8080';
const PROJECT = 'shellnats-' + Date.now();
const TIMEOUT_MS = 45000;

function pass(s) { console.log(`✅ ${s}`); }
function fail(s) { console.error(`❌ ${s}`); process.exit(1); }

async function main() {
  console.log(`▶ shell-via-NATS test — ${URL} project=${PROJECT}`);

  // Ensure the project working dir exists so the workspace dir gets
  // created on first Ensure.
  await fetch(`${URL}/api/projects/${PROJECT}/files/.keep`, {
    method: 'PUT',
    body: 'placeholder',
  });

  const wsURL = URL.replace(/^http/, 'ws') + `/api/projects/${PROJECT}/shell`;
  const ws = new WebSocket(wsURL);
  let received = '';
  const timer = setTimeout(() => {
    fail(`timeout after ${TIMEOUT_MS}ms — got "${received.slice(0, 120)}"`);
  }, TIMEOUT_MS);

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('• ws open ; waiting for bash banner before sending input');
      // Delay so bash has time to print its banner + reach the
      // prompt-ready state. Without the delay the input frame
      // races bash startup and the queued bytes get discarded by
      // the pty's input buffer rotation.
      setTimeout(() => {
        const text = 'echo hello-from-test\r';
        const frame = Buffer.concat([Buffer.from('i'), Buffer.from(text, 'utf8')]);
        ws.send(frame);
        pass('input frame sent');
      }, 8000);
    });
    ws.on('message', (data) => {
      const bytes = Buffer.from(data);
      if (bytes.length === 0) return;
      if (bytes[0] === 'o'.charCodeAt(0)) {
        received += bytes.slice(1).toString('utf8');
        if (received.includes('hello-from-test')) {
          clearTimeout(timer);
          pass(`bash echoed back : "${received.split('\n').filter(l => l.includes('hello-from-test'))[0]?.trim()}"`);
          ws.close();
          resolve();
        }
      } else if (bytes[0] === 'e'.charCodeAt(0)) {
        clearTimeout(timer);
        fail(`shell exited prematurely (code ${bytes.readUInt32BE(1)})`);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.on('close', () => {
      // Resolved already if we matched, otherwise this is the
      // failure path the timer covers.
    });
  });

  console.log('\n✅ shell-via-NATS round-trip verified');
}

main().catch((e) => {
  console.error('crashed:', e);
  process.exit(2);
});
