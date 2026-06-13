import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('END\n' + recv.slice(-800)); process.exit(0); }, 180000);
ws.on('open', () => {
  setTimeout(() => {
    // Write tex via printf (single line, avoids heredoc complexity)
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      'printf "\\\\documentclass{article}\\n\\\\begin{document}\\nHello from weft-loom Apptainer pdflatex!\\n\\\\end{document}\\n" > /workspace/demo/test.tex && cd /workspace/demo && time pdflatex -interaction=nonstopmode test.tex 2>&1 | tail -5 ; ls -la test.pdf\r'
    )]));
  }, 8000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.match(/test\.pdf$|\d bytes\)|Output written/m)) {
      clearTimeout(t);
      console.log('SHELL :\n' + recv.slice(-1000));
      process.exit(0);
    }
  }
});
