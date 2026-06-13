import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('END\n' + recv.slice(-1000)); process.exit(0); }, 25000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      'ls /opt/tools/.current/pandoc/rootfs/bin/ | head ; which pandoc ; cat /usr/local/bin/pandoc ; apptainer exec --bind /workspace --pwd /workspace/demo /opt/tools/.current/pandoc/rootfs pandoc --version 2>&1 | head -5\r'
    )]));
  }, 4000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
  }
});
