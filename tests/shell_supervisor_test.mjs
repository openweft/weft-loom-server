import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('TIMEOUT\n' + recv.slice(-600)); process.exit(0); }, 20000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from('ps aux | head -20 && cat /var/log/weft-tools.log 2>&1; crun list\r')]));
  }, 12000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.includes('crun list') && recv.length > 600) {
      clearTimeout(t);
      console.log('SHELL :\n' + recv.slice(-600));
      process.exit(0);
    }
  }
});
