import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('END\n' + recv.slice(-1500)); process.exit(0); }, 60000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      'cd /workspace/demo && apptainer exec /opt/tools/.current/texlive/rootfs sh -c "pdfinfo .weft-loom/*/main.pdf | head -10 ; echo --- ; pdftotext .weft-loom/*/main.pdf - | head -20"\r'
    )]));
  }, 5000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
  }
});
