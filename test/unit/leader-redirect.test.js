'use strict';

// What the driver does with a `not_leader` refusal. A single-node server can
// never produce one, so a scripted peer returns the envelope the server's
// request pipeline builds. This proves the driver's half only.

const test = require('node:test');
const assert = require('node:assert/strict');

const { TriCore, Pool, Response, TriCoreError, NOT_LEADER, FEATURE_SESSION_TXN } = require('tricoredb');
const { scriptedPeer, withPeer, okEnvelope, refusalEnvelope } = require('../helpers/peer.js');

// Deliberately non-local, so a driver that "followed" it would fail rather than reach this peer.
const LEADER_ADDR = '10.9.9.7:8427';

function notLeader(requestId, leader) {
  const extra = { error_code: NOT_LEADER };
  if (leader !== null) extra.leader_hint = leader;
  return refusalEnvelope(requestId, 'not the raft leader — send writes to `n2`', extra);
}

test('a not_leader refusal is a typed error with code, leaderHint and isRedirect', async () => {
  await withPeer(scriptedPeer((rid) => notLeader(rid, LEADER_ADDR)), async (peer) => {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    const e = await db.execute("INSERT INTO t VALUES (1, 'ada')").then(
      () => assert.fail('the write resolved'),
      (err) => err,
    );
    assert.ok(e instanceof TriCoreError);
    assert.equal(e.code, 'not_leader');
    assert.equal(e.code, NOT_LEADER);
    assert.equal(e.leaderHint, LEADER_ADDR);
    assert.equal(e.isRedirect, true);
    assert.ok(e.message.includes('not the raft leader — send writes to `n2`'));
    assert.ok(e.message.includes(LEADER_ADDR) && !e.leaderHint.includes('n2'));
    assert.equal(peer.state.connections, 1, 'no second connection was opened');
    assert.equal(peer.state.requests, 1, 'the write was re-sent nowhere');
    await db.close();
  });
});

test('mid-election there is no hint, and the refusal is still a redirect', async () => {
  await withPeer(scriptedPeer((rid) => notLeader(rid, null)), async (peer) => {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    const e = await db.execute('INSERT INTO t VALUES (1)').catch((err) => err);
    assert.ok(e instanceof TriCoreError);
    assert.equal(e.code, 'not_leader');
    assert.equal(e.leaderHint, null);
    assert.equal(e.isRedirect, true);
    assert.match(e.message, /wait and try again/);
    assert.equal(peer.state.requests, 1);
    await db.close();
  });
});

test('refusals that are not redirects stay that way, and an uncoded refusal gets no invented code', async () => {
  await withPeer(
    scriptedPeer((rid) => refusalEnvelope(rid, 'index memory limit reached', { error_code: 'storage_capacity' })),
    async (peer) => {
      const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
      const e = await db.execute('INSERT INTO t VALUES (1)').catch((err) => err);
      assert.equal(e.code, 'storage_capacity');
      assert.equal(e.isRedirect, false);
      assert.equal(e.leaderHint, null);
      await db.close();
    },
  );
  await withPeer(scriptedPeer((rid) => refusalEnvelope(rid, 'no such table: t')), async (peer) => {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    const e = await db.execute('INSERT INTO t VALUES (1)').catch((err) => err);
    assert.equal(e.code, null);
    assert.equal(e.isRedirect, false);
    assert.equal(e.message, 'no such table: t (server status: error)');
    await db.close();
  });
});

test('a redirect inside an open session transaction says the block is over and re-sends nothing', async () => {
  const peerP = scriptedPeer(
    (rid, n) => (n === 1 ? okEnvelope(rid, { transaction: 'began' }) : notLeader(rid, LEADER_ADDR)),
    { features: FEATURE_SESSION_TXN },
  );
  await withPeer(peerP, async (peer) => {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    await db.begin();
    assert.equal(db.inTransaction, true);
    const e = await db.execute("INSERT INTO t VALUES (1, 'ada')").catch((err) => err);
    assert.equal(e.code, 'not_leader');
    assert.match(e.message, /session transaction is over/);
    assert.equal(peer.state.connections, 1);
    assert.equal(peer.state.requests, 2, 'BEGIN + the statement, nothing more');
    await db.close();
  });
});

test('a coded refusal does not retire a pooled connection', async () => {
  await withPeer(scriptedPeer((rid) => notLeader(rid, LEADER_ADDR)), async (peer) => {
    const pool = new Pool({ host: '127.0.0.1', port: peer.port, size: 2 });
    await assert.rejects(pool.use((db) => db.execute('INSERT INTO t VALUES (1)')), TriCoreError);
    const stats = pool.stats();
    assert.equal(stats.created, 1, 'the connection was kept');
    assert.equal(stats.idle, 1, 'and returned to the pool');
    assert.equal(peer.state.connections, 1, 'no reconnect was needed');
    await pool.close();
  });
});

test('Response exposes errorCode, leaderHint and isRedirect', () => {
  const redirect = new Response(notLeader('r1', LEADER_ADDR));
  assert.equal(redirect.errorCode, 'not_leader');
  assert.equal(redirect.leaderHint, LEADER_ADDR);
  assert.equal(redirect.isRedirect, true);

  const election = new Response(notLeader('r1', null));
  assert.equal(election.leaderHint, null);
  assert.equal(election.isRedirect, true);

  const fine = new Response(okEnvelope('r1', { ok: true }));
  assert.equal(fine.errorCode, null);
  assert.equal(fine.isRedirect, false);
});
