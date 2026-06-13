import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('END\n' + recv.slice(-800)); process.exit(0); }, 60000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      "cat > test.tex <<'EOF'\n\\documentclass{article}\n\\begin{document}\nHello from weft-loom Apptainer!\n\\end{document}\nEOF\npdflatex -interaction=nonstopmode test.tex 2>&1 | tail -20 && ls -la test.pdf\r"
    )]));
  }, 12000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.includes('Output written') || recv.includes('test.pdf')) {
      clearTimeout(t);
      console.log('SHELL :\n' + recv.slice(-800));
      process.exit(0);
    }
  }
});
