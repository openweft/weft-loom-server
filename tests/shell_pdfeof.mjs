import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('END\n' + recv.slice(-1500)); process.exit(0); }, 30000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      'cd /workspace/demo && rm -f t.pdf t.aux t.log && pdflatex -interaction=nonstopmode -jobname=t quick.tex >/tmp/p.log 2>&1 ; sync ; ls -la t.pdf ; echo SIZE=$(stat -c%s t.pdf) ; grep -c "%%EOF" t.pdf ; tail -c 20 t.pdf | od -c\r'
    )]));
  }, 4000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.includes('SIZE=')) {
      clearTimeout(t);
      console.log('SHELL :\n' + recv.slice(-800));
      process.exit(0);
    }
  }
});
