// Root-cause fix for the harness hang described in run.mjs and
// tests/upstream/README.md: axios' own test fixture (tests/setup/server.js,
// upstream's file, not modified here) reuses a handful of FIXED ports
// (8020, 8030, 8040) across roughly 200 of this file's tests, one
// `startHTTPServer`/`stopHTTPServer` pair at a time. In a busy/shared
// sandbox, the next test's `server.listen(8020, ...)` can call back
// (`listen(port, cb)`'s callback only ever fires on success, never with an
// error - a real bug in the fixture itself) before the previous test's
// server has actually finished releasing the port, and then just... never
// call back at all: a silent, indefinite hang, since nothing is listening
// for the `'error'` event `EADDRINUSE` would otherwise arrive on.
//
// Every test that matters reads the ACTUAL bound port back off
// `server.address().port` before building its request URL, so which literal
// port number the OS handed out is irrelevant - except a couple of spots
// that hardcode the literal 8020/8030/8040 in a string instead (a redirect
// `Location` header, one raw `https.createServer(...).listen(SERVER_PORT,
// ...)`); those are listed in expected-failures.strategy-*.json as a
// harness limitation, not fixed here.
//
// This patches `net.Server.prototype.listen` so any of those three fixed
// ports is transparently swapped for 0 (let the OS pick a free ephemeral
// port instead) - every one of ~200 affected tests gets its own port, so
// they can never collide or wait on each other's cleanup in the first
// place.
'use strict';

const net = require('node:net');

const FIXED_TEST_PORTS = new Set([8020, 8030, 8040]);

const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function patchedListen(...args) {
  if (typeof args[0] === 'number' && FIXED_TEST_PORTS.has(args[0])) {
    args[0] = 0;
  }
  return originalListen.apply(this, args);
};
