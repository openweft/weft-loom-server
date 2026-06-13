import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080/api/projects/demo/shell');
let recv = '';
const t = setTimeout(() => { console.log('END\n' + recv.slice(-600)); process.exit(0); }, 25000);
ws.on('open', () => {
  setTimeout(() => {
    ws.send(Buffer.concat([Buffer.from('i'), Buffer.from('which pkgx pkgm && pkgx --version\r')]));
  }, 11000);
});
ws.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] === 'o'.charCodeAt(0)) {
    recv += b.slice(1).toString('utf8');
    if (recv.includes('pkgx 2.10') || recv.includes('pkgm not found') || recv.includes('command not found')) {
      clearTimeout(t);
      console.log('SHELL :\n' + recv.slice(-500));
      process.exit(0);
    }
  }
});
