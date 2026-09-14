'use strict';

// Request ids are unique per request and round-trip through a real server.

const test = require('node:test');
const assert = require('node:assert/strict');

const { TriCore } = require('tricoredb');
const { startServer, unavailable } = require('../helpers/server.js');

test('two connections get distinct request ids back from the server', { skip: unavailable() || false }, async () => {
  const server = await startServer({ mode: 'dev' });
  try {
    const a = await TriCore.connect(server.opts);
    const b = await TriCore.connect(server.opts);
    const ra = await a.request({ Admin: 'Ping' });
    const rb = await b.request({ Admin: 'Ping' });
    assert.ok(ra.requestId, 'first response carries a request id');
    assert.ok(rb.requestId, 'second response carries a request id');
    assert.notEqual(ra.requestId, rb.requestId);
    await a.close();
    await b.close();
  } finally {
    await server.stop();
  }
});
