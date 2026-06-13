import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('END\n' + recv.slice(-1500)); process.exit(0); }, 300000); // 5 min
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      'cd /workspace/demo && time pdflatex -interaction=nonstopmode test.tex > /tmp/pdflatex.log 2>&1 ; ls -la test.pdf ; tail -5 /tmp/pdflatex.log\r'
    )]));
  }, 4000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.match(/test\.pdf.*\d+/m) && recv.includes('real')) {
      clearTimeout(t);
      console.log('SHELL :\n' + recv.slice(-1000));
      process.exit(0);
    }
  }
});
