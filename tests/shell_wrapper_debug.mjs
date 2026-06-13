import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('END\n' + recv.slice(-1500)); process.exit(0); }, 25000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      'ls -la /usr/local/bin/pandoc ; head -3 /usr/local/bin/pandoc ; echo ---direct--- ; /usr/local/bin/pandoc main.md -o main.html 2>&1 ; echo ---ls--- ; ls -la main.html 2>&1\r'
    )]));
  }, 3000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
  }
});
