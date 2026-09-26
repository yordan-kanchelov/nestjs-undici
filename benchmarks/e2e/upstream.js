// A minimal mock backend for the A/B check: same response shape as
// apps/mock-service, but plain node:http with no request logging, so it
// doesn't cap its own throughput under load. Forked by run.js; sends
// `process.send('ready')` once listening.
// Usage: node upstream.js <port>
'use strict';
const http = require('node:http');

const body = JSON.stringify({
  id: 1,
  name: 'Mock Service Response',
  timestamp: new Date().toISOString(),
  data: { status: 'success', message: 'Response from mock service', value: 0.5 },
});

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
});
server.keepAliveTimeout = 60_000;
server.listen(Number(process.argv[2]), '127.0.0.1', () => process.send?.('ready'));
