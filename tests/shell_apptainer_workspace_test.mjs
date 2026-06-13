import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('TIMEOUT\n' + recv.slice(-600)); process.exit(0); }, 35000);
ws.on('open', () => {
  setTimeout(() => {
    // Write a file from INSIDE the apptainer container, into the bind-mounted /workspace
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from(
      'apptainer exec --bind /workspace --pwd /workspace/demo /opt/tools/.current/alpine/rootfs sh -c "apk info -L busybox | head -5 > apptainer-output.txt && cat apptainer-output.txt"\r'
    )]));
  }, 12000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.includes('/bin/busybox') || recv.includes('busybox-1')) {
      clearTimeout(t);
      console.log('SHELL :\n' + recv.slice(-600));
      process.exit(0);
    }
  }
});
