import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('TIMEOUT\n' + recv.slice(-300)); process.exit(0); }, 30000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from('pwd && ls\r')]));
  }, 16000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.includes('main.tex')) {
      clearTimeout(t);
      console.log('SHELL CWD :\n' + recv.slice(-280));
      process.exit(0);
    }
  }
});
