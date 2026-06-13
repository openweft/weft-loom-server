import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('TIMEOUT\n' + recv.slice(-800)); process.exit(0); }, 40000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      'pandoc main.md -o main.html && cat main.html | head -10\r'
    )]));
  }, 12000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.includes('<h1') || recv.includes('Hello from weft-loom')) {
      clearTimeout(t);
      console.log('SHELL :\n' + recv.slice(-700));
      process.exit(0);
    }
  }
});
