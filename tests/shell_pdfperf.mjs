import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('END\n' + recv.slice(-800)); process.exit(0); }, 90000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      'cd /workspace/demo && time pdflatex -interaction=nonstopmode quick.tex >/tmp/pl.log 2>&1\r'
    )]));
  }, 4000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.match(/real\s+\d/m)) {
      clearTimeout(t);
      console.log('SHELL :\n' + recv.slice(-600));
      process.exit(0);
    }
  }
});
