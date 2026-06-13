import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let received = '';
const timer = setTimeout(() => { console.log('OUTPUT:', received); process.exit(0); }, 30000);
ws.on('open', () => {
  setTimeout(() => {
    const text = 'ls /workspace\r';
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(text)]));
    console.log('sent ls');
  }, 18000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    received += b.slice(1).toString('utf8');
    if (received.includes('main.tex') || received.includes('main.md')) {
      clearTimeout(timer);
      console.log('FOUND main.tex/md in shell output');
      console.log(received.split('\n').slice(-6).join('\n'));
      process.exit(0);
    }
  }
});
