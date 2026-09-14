'use strict';

// Server-side params and session transactions exist only when the handshake
// granted them. Without the bit the driver refuses by name and sends nothing.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TriCore, TriCoreError, bindParams, FEATURES, FEATURE_CORRELATION_ID, FEATURE_SERVER_PARAMS, FEATURE_SESSION_TXN,
} = require('tricoredb');
const { TAG, scriptedPeer, withPeer, okEnvelope } = require('../helpers/peer.js');

const requests = (peer) => peer.state.frames.filter((f) => f.tag === TAG.REQUEST);

test('HELLO announces every known bit and records what was granted', async () => {
  assert.equal(FEATURES, FEATURE_CORRELATION_ID | FEATURE_SERVER_PARAMS | FEATURE_SESSION_TXN);
  await withPeer(scriptedPeer((rid) => okEnvelope(rid, {}), { features: FEATURE_SERVER_PARAMS }), async (peer) => {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    const hello = peer.state.frames.find((f) => f.tag === TAG.HELLO).body;
    assert.equal(hello.features, FEATURES);
    assert.equal(hello.protocol, 'tricore');
    assert.deepEqual(hello.version, { major: 1, minor: 0 });
    assert.deepEqual(db.features, { mask: FEATURE_SERVER_PARAMS, correlationId: false, serverParams: true, sessionTxn: false });
    await db.close();
  });
});

test('without SERVER_PARAMS, bound arguments are refused by name and nothing is sent', async () => {
  await withPeer(scriptedPeer((rid) => okEnvelope(rid, {}), { features: FEATURE_SESSION_TXN }), async (peer) => {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    for (const call of [
      () => db.execute('INSERT INTO t VALUES (?)', [1]),
      () => db.query('SELECT * FROM t WHERE id = ?', [1]),
    ]) {
      const e = await call().then(() => assert.fail('resolved'), (err) => err);
      assert.ok(e instanceof TriCoreError);
      assert.match(e.message, /SERVER_PARAMS/);
      assert.equal(e.notSent, true);
    }
    assert.equal(requests(peer).length, 0, 'no statement reached the server, rendered or otherwise');

    await db.execute(bindParams('INSERT INTO t VALUES (?, ?)', [1, "O'Brien"]));
    assert.deepEqual(requests(peer)[0].body.op, { Sql: { Exec: { sql: "INSERT INTO t VALUES (1, 'O''Brien')" } } });
    await db.close();
  });
});

test('without SESSION_TXN, begin() and withTransaction() are refused by name and nothing is sent', async () => {
  await withPeer(scriptedPeer((rid) => okEnvelope(rid, {}), { features: FEATURE_SERVER_PARAMS }), async (peer) => {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    await assert.rejects(db.begin(), /SESSION_TXN/);
    let ran = false;
    await assert.rejects(db.withTransaction(async () => { ran = true; }), /SESSION_TXN/);
    assert.equal(ran, false);
    assert.equal(db.inTransaction, false);
    assert.equal(requests(peer).length, 0);

    await db.transaction([['INSERT INTO t VALUES (?)', [1]], 'DELETE FROM t']);
    assert.deepEqual(requests(peer)[0].body.op, {
      Sql: { Exec: { sql: 'BEGIN; INSERT INTO t VALUES (1); DELETE FROM t; COMMIT' } },
    });
    await db.close();
  });
});

test('with SERVER_PARAMS, values travel as typed params and a BigInt stays exact on the wire', async () => {
  await withPeer(scriptedPeer((rid) => okEnvelope(rid, {}), { features: FEATURES }), async (peer) => {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    const when = new Date(Date.UTC(2026, 0, 31, 12, 0, 0));
    const view = Buffer.from([1, 2, 3, 4, 5, 6]).subarray(2, 4);
    await db.execute('INSERT INTO t VALUES (?, ?, ?, ?, ?)', [9223372036854775807n, view, when, 'x', null]);
    const [req] = requests(peer);
    assert.ok(
      req.raw.includes('"params":[9223372036854775807,"0x0304","2026-01-31T12:00:00.000Z","x",null]'),
      `raw frame: ${req.raw}`,
    );
    assert.equal(req.body.op.Sql.Exec.sql, 'INSERT INTO t VALUES (?, ?, ?, ?, ?)');

    await assert.rejects(db.execute('INSERT INTO t VALUES (?)', [9007199254740993]), /BigInt/);
    assert.equal(requests(peer).length, 1, 'the imprecise number was not sent');
    await db.close();
  });
});

test('a database name in the second position still means the database', async () => {
  await withPeer(scriptedPeer((rid) => okEnvelope(rid, {}), { features: FEATURES }), async (peer) => {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    await db.execute('CREATE TABLE t (id INT)', 'analytics');
    await db.execute('INSERT INTO t VALUES (?)', [1], 'analytics');
    const [a, b] = requests(peer).map((f) => f.body);
    assert.equal(a.database, 'analytics');
    assert.deepEqual(a.op, { Sql: { Exec: { sql: 'CREATE TABLE t (id INT)' } } });
    assert.equal(b.database, 'analytics');
    assert.deepEqual(b.op.Sql.Exec.params, [1]);
    await db.close();
  });
});
