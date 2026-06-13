import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('END\n' + recv.slice(-1500)); process.exit(0); }, 60000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      'cd /workspace/demo ; rm -f t.pdf t.aux t.log ; pdflatex -interaction=nonstopmode -jobname=t quick.tex 2>&1 | tail -3 ; echo "==DONE==" ; sync ; ls -la t.pdf ; grep -c %%EOF t.pdf ; tail -c 20 t.pdf | od -c | head -2\r'
    )]));
  }, 5000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.includes('==DONE==') && recv.match(/0000/)) {
      clearTimeout(t);
      console.log('SHELL :\n' + recv.slice(-1000));
      process.exit(0);
    }
  }
});
