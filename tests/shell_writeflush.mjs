import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('END\n' + recv.slice(-700)); process.exit(0); }, 30000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      'cd /workspace/demo && apptainer exec --bind /workspace /opt/tools/.current/texlive/rootfs sh -c "echo -n \\"ABCDEFGH\\" > /workspace/demo/wfsync.bin && sync" ; ls -la wfsync.bin ; od -c wfsync.bin | head -2\r'
    )]));
  }, 4000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
  }
});
