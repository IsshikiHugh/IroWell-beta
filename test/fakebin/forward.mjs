// A forward of the fake ssh (test/fakebin/ssh): listens on localhost:<local> as ssh does (both loopback
// addresses, one of them is enough) and pipes each connection to this machine's <remote>. With the same
// number on both sides that would be this listener itself, connecting to itself without end: there the
// "server" has nothing on the port, and the connection is closed.
import net from 'node:net';

const [local, remote] = process.argv.slice(2).map(Number);
let bound = 0, tried = 0;
const done = () => {
  if (++tried < 2) return;
  if (!bound) process.exit(1);
  console.log('listening');
};
for (const host of ['127.0.0.1', '::1']) {
  const s = net.createServer((a) => {
    if (local === remote) return a.destroy();
    const b = net.connect(remote, '127.0.0.1');
    a.pipe(b).pipe(a);
    a.on('error', () => b.destroy());
    b.on('error', () => a.destroy());
  });
  s.on('error', done);
  s.listen({ port: local, host, exclusive: true }, () => { bound++; done(); });
}
