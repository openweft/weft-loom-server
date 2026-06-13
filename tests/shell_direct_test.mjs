import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('TIMEOUT\n' + recv.slice(-500)); process.exit(0); }, 25000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from('which apk ; ls -la /usr/local/bin/apk ; apk --version 2>&1 | head -3\r')]));
  }, 14000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.includes('apk-tools')) {
      clearTimeout(t);
      console.log('SHELL :\n' + recv.slice(-500));
      process.exit(0);
    }
  }
});
