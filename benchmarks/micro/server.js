// Upstream stub for the micro-benchmark: GET /json, POST /echo, GET /404.
// Runs in its own process so it doesn't compete with the client's event loop.
const http = require('node:http');

const body = JSON.stringify({
  id: 1,
  name: 'Mock Service Response',
  data: { status: 'success', message: 'Response from mock service', value: 0.5 },
});

const server = http.createServer((req, res) => {
  // Drain the request body (POST /echo sends one) before responding, like a real upstream would.
  req.on('data', () => {});
  req.on('end', () => {
    const status = req.url.startsWith('/404') ? 404 : 200;
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
});
server.keepAliveTimeout = 60_000;
server.listen(0, '127.0.0.1', () => {
  process.send?.({ port: server.address().port });
});
process.on('disconnect', () => server.close(() => process.exit(0)));
