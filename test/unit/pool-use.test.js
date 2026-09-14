'use strict';

// Pool.use: what counts as a torn connection. A refusal that arrived as a whole
// frame proves the stream is healthy, so it must neither retire the connection
// nor skip the rollback of an open session transaction.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Pool, PoolTimeout, TriCoreError, ProtocolError, FEATURE_SESSION_TXN,
} = require('tricoredb');
const { isBrokenConnectionError } = require('../../dist/cjs/pool.js');
const {
  TAG, headerOnly, hostilePeer, scriptedPeer, withPeer, okEnvelope, refusalEnvelope,
} = require('../helpers/peer.js');

// Refusal prose chosen to contain every word the torn-stream regex looks for.
const PROSE = 'duplicate key; the server asks you to reconnect later (socket closed, EPIPE)';

function sqlOf(body) {
  const exec = body && body.op && body.op.Sql && body.op.Sql.Exec;
  return exec ? exec.sql : null;
}

function txnPeer() {
  return scriptedPeer((rid, _n, body) => {
    const sql = sqlOf(body);
    if (sql === 'BEGIN') return okEnvelope(rid, { transaction: 'began' });
    if (sql === 'ROLLBACK') return okEnvelope(rid, { transaction: 'rolled_back' });
    return refusalEnvelope(rid, PROSE, { error_code: 'constraint_violation' });
  }, { features: FEATURE_SESSION_TXN });
}

const sent = (peer) => peer.state.frames.filter((f) => f.tag === TAG.REQUEST).map((f) => sqlOf(f.body));

test('"reconnect" contains ECONN, and a coded refusal is still not a torn stream', () => {
  assert.match('reconnect', /ECONN/i, 'the accident this guards against is real');
  const refusal = new TriCoreError(PROSE, { code: 'constraint_violation' });
  assert.equal(isBrokenConnectionError(refusal), false);
  assert.equal(isBrokenConnectionError(new TriCoreError('x', { code: 'not_leader', leaderHint: '10.0.0.1:8427' })), false);

  assert.equal(isBrokenConnectionError(new ProtocolError('connection closed mid-frame')), true);
  assert.equal(isBrokenConnectionError(new ProtocolError('bad frame', { code: 'weird' })), true);
  assert.equal(isBrokenConnectionError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), true);
  assert.equal(isBrokenConnectionError(new TriCoreError('socket error: read ECONNRESET')), true);
  assert.equal(isBrokenConnectionError(new Error('application bug')), false);
});

test('a coded refusal inside an open transaction rolls back and keeps the connection', async () => {
  await withPeer(txnPeer(), async (peer) => {
    const pool = new Pool({ host: '127.0.0.1', port: peer.port, size: 2 });
    const e = await pool.use(async (db) => {
      await db.begin();
      assert.equal(db.inTransaction, true);
      await db.execute('INSERT INTO t VALUES (1)');
    }).then(() => assert.fail('use() resolved'), (err) => err);

    assert.equal(e.code, 'constraint_violation');
    assert.equal(e.message, `${PROSE} (server status: error)`);
    assert.deepEqual(sent(peer), ['BEGIN', 'INSERT INTO t VALUES (1)', 'ROLLBACK'], 'the block was rolled back');
    assert.deepEqual(pool.stats(), { size: 2, created: 1, idle: 1, inUse: 0, waiting: 0 });

    const second = await pool.use(async (db) => {
      assert.equal(db.inTransaction, false);
      return (await db.begin()).transaction;
    }).catch((err) => err);
    assert.ok(second instanceof TriCoreError && /still open/.test(second.message));
    assert.equal(peer.state.connections, 1, 'the same socket served both borrows');
    await pool.close();
  });
});

test('a coded refusal outside a transaction returns the connection to the pool', async () => {
  await withPeer(scriptedPeer((rid) => refusalEnvelope(rid, PROSE, { error_code: 'validation' })), async (peer) => {
    const pool = new Pool({ host: '127.0.0.1', port: peer.port, size: 1 });
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(pool.use((db) => db.execute('SELEC 1')), (err) => err.code === 'validation');
    }
    assert.equal(pool.stats().created, 1);
    assert.equal(pool.stats().idle, 1);
    assert.equal(peer.state.connections, 1, 'no reconnect across three refusals');
    await pool.close();
  });
});

test('an application error with a block open rolls back, and the callback error propagates', async () => {
  await withPeer(txnPeer(), async (peer) => {
    const pool = new Pool({ host: '127.0.0.1', port: peer.port, size: 1 });
    const boom = new Error('application bug');
    await assert.rejects(pool.use(async (db) => { await db.begin(); throw boom; }), (err) => err === boom);
    assert.deepEqual(sent(peer), ['BEGIN', 'ROLLBACK']);
    assert.equal(pool.stats().idle, 1);
    await pool.close();
  });
});

test('a callback that returns with a block open is refused by name and rolled back', async () => {
  await withPeer(txnPeer(), async (peer) => {
    const pool = new Pool({ host: '127.0.0.1', port: peer.port, size: 1 });
    await assert.rejects(pool.use(async (db) => { await db.begin(); }), /still open/);
    assert.deepEqual(sent(peer), ['BEGIN', 'ROLLBACK']);
    assert.equal(pool.stats().idle, 1);
    await pool.close();
  });
});

test('a genuinely torn stream retires the connection', async () => {
  await withPeer(hostilePeer(() => headerOnly(1, TAG.RESPONSE, 0xffffffff)), async (peer) => {
    const pool = new Pool({ host: '127.0.0.1', port: peer.port, size: 1 });
    await assert.rejects(pool.use((db) => db.ping()), ProtocolError);
    await new Promise((r) => setImmediate(r));
    assert.equal(pool.stats().created, 0, 'the poisoned connection was not returned');
    assert.equal(pool.stats().idle, 0);
    await pool.close();
  });
});

test('an exhausted pool times out with PoolTimeout', async () => {
  await withPeer(scriptedPeer((rid) => okEnvelope(rid, {})), async (peer) => {
    const pool = new Pool({ host: '127.0.0.1', port: peer.port, size: 1 });
    await pool.use(async () => {
      const t0 = Date.now();
      await assert.rejects(pool.use(async () => {}, 300), PoolTimeout);
      assert.ok(Date.now() - t0 >= 250);
    });
    assert.throws(() => new Pool({ size: 0 }), /pool size must be >= 1/);
    await pool.close();
    await assert.rejects(pool.use(async () => {}), /pool is closed/);
  });
});
