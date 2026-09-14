'use strict';

// Exact values survive the round trip, and authentication failures are errors.
// Every assertion reads the value back from a real server.

const test = require('node:test');
const assert = require('node:assert/strict');

const { TriCore, AuthError } = require('tricoredb');
const { startServer, unavailable } = require('../helpers/server.js');

test('exact types round-trip through server-side parameters', { skip: unavailable() || false }, async () => {
  const server = await startServer({ mode: 'dev' });
  try {
    const db = await TriCore.connect(server.opts);
    assert.equal(db.features.serverParams, true);
    await db.execute('CREATE TABLE exact_t (id INT PRIMARY KEY, d DECIMAL, b BLOB, n BIGINT, s TEXT)');

    // A DECIMAL sent as text keeps every digit; a JSON number would round through a double.
    const decimal = '0.123456789012345678';
    // Bytes that are not valid UTF-8, plus a NUL, a quote and a backslash.
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x27, 0x5c, 0x68, 0x69, 0x00]);
    const big = 9223372036854775807n;
    const injection = "'; DROP TABLE exact_t; --";

    await db.execute('INSERT INTO exact_t VALUES (?, ?, ?, ?, ?)', [1, decimal, bytes, big, injection]);

    const rows = await db.query('SELECT d, b, n, s FROM exact_t WHERE id = ?', [1]);
    const [d, b, n, s] = rows.rows[0];
    assert.equal(d, decimal, 'decimal digits survive');
    assert.equal(b.toLowerCase(), `0x${bytes.toString('hex')}`, 'every byte survives');
    assert.equal(n, big.toString(), 'i64 max survives');
    assert.equal(s, injection, 'a SQL-shaped string is stored as data');

    const still = await db.query('SELECT COUNT(*) FROM exact_t');
    assert.equal(still.rows[0][0], '1', 'the table still exists');

    await db.close();
  } finally {
    await server.stop();
  }
});

test('a wrong password is an AuthError, not a connection', { skip: unavailable({ needCli: true }) || false }, async () => {
  const server = await startServer({ mode: 'password' });
  try {
    await assert.rejects(
      () => TriCore.connect({ ...server.opts, secret: 'definitely-not-the-secret' }),
      (err) => err instanceof AuthError,
    );
    const ok = await TriCore.connect(server.opts);
    await ok.ping();
    await ok.close();
  } finally {
    await server.stop();
  }
});
