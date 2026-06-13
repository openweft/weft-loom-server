import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let received = '';
const t = setTimeout(() => { console.log('TIMEOUT\n' + received); process.exit(0); }, 30000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from('ls /workspace\r')]));
  }, 18000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    received += b.slice(1).toString('utf8');
    if (received.includes('main.tex') || received.includes('main.md')) {
      clearTimeout(t);
      console.log('FOUND files in /workspace');
      console.log(received.split('\n').slice(-8).join('\n'));
      process.exit(0);
    }
  }
});
