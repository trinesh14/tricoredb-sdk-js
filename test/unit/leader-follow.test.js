'use strict';

// Following the leader: what the driver does with a `not_leader` refusal when
// `followLeader` is on, which is the default. Two scripted peers stand in for a
// follower and a leader; a real follower's refusal was applied nowhere, which
// is what makes sending the request again safe.

const test = require('node:test');
const assert = require('node:assert/strict');

const { TriCore, Pool, TriCoreError, NOT_LEADER, OUTCOME_UNKNOWN, FEATURE_SESSION_TXN } = require('tricoredb');
const { scriptedPeer, withPeer, okEnvelope, refusalEnvelope } = require('../helpers/peer.js');

function notLeader(requestId, leader) {
  const extra = { error_code: NOT_LEADER };
  if (leader) extra.leader_hint = leader;
  return refusalEnvelope(requestId, 'not the raft leader', extra);
}

const fast = { leaderRetryDelayMs: 1 };

test('a refused request is sent to the leader, and the connection stays there', async () => {
  await withPeer(scriptedPeer((rid, n, body) => okEnvelope(rid, { served: 'leader', n, op: body.op })), async (leader) => {
    const hint = `127.0.0.1:${leader.port}`;
    await withPeer(scriptedPeer((rid) => notLeader(rid, hint)), async (follower) => {
      const db = await TriCore.connect({ host: '127.0.0.1', port: follower.port, user: 'u', secret: 's', ...fast });
      const first = await db.execute("INSERT INTO t VALUES (1, 'ada')");
      assert.equal(first.data.Json.served, 'leader');
      assert.equal(db.address, hint);
      assert.equal(follower.state.requests, 1, 'the follower saw the write once');
      assert.equal(leader.state.requests, 1, 'the leader served it');
      assert.equal(leader.state.connections, 1);

      await db.execute('INSERT INTO t VALUES (2)');
      assert.equal(follower.state.requests, 1, 'later requests go straight to the leader');
      assert.equal(leader.state.requests, 2);

      const auth = leader.state.frames.find((f) => f.tag === 1);
      assert.equal(auth.body.username, 'u', 'the new connection authenticated as the old one');
      const sent = leader.state.frames.filter((f) => f.tag === 2).map((f) => f.body.request_id);
      const refused = follower.state.frames.find((f) => f.tag === 2).body.request_id;
      assert.equal(sent[0], refused, 'the same request, not a new one');
      await db.close();
    });
  });
});

test('with no leader named, the driver waits and asks the same node again', async () => {
  await withPeer(
    scriptedPeer((rid, n) => (n < 3 ? notLeader(rid, null) : okEnvelope(rid, { ok: true }))),
    async (peer) => {
      const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port, ...fast });
      await db.execute('INSERT INTO t VALUES (1)');
      assert.equal(peer.state.requests, 3);
      assert.equal(peer.state.connections, 1);
      await db.close();
    },
  );
});

test('the retries are bounded, and the error says they happened', async () => {
  await withPeer(scriptedPeer((rid) => notLeader(rid, null)), async (peer) => {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port, leaderRetries: 2, ...fast });
    const e = await db.execute('INSERT INTO t VALUES (1)').catch((err) => err);
    assert.ok(e instanceof TriCoreError);
    assert.equal(e.code, NOT_LEADER);
    assert.match(e.message, /sent it again 2 time\(s\)/);
    assert.equal(peer.state.requests, 3, 'the first attempt and two more');
    await db.close();
  });
});

test('an unreachable leader leaves the connection where it was', async () => {
  const dead = await scriptedPeer(() => ({}));
  const nowhere = `127.0.0.1:${dead.port}`;
  await dead.close();
  await withPeer(
    scriptedPeer((rid, n) => (n === 1 ? notLeader(rid, nowhere) : okEnvelope(rid, { ok: true }))),
    async (peer) => {
      const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port, ...fast });
      await db.execute('INSERT INTO t VALUES (1)');
      assert.equal(peer.state.requests, 2, 'asked again after the leader could not be reached');
      assert.equal(db.address, `127.0.0.1:${peer.port}`);
      await db.close();
    },
  );
});

test('inside a session transaction nothing is sent again', async () => {
  const peerP = scriptedPeer(
    (rid, n) => (n === 1 ? okEnvelope(rid, { transaction: 'began' }) : notLeader(rid, null)),
    { features: FEATURE_SESSION_TXN },
  );
  await withPeer(peerP, async (peer) => {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port, ...fast });
    await db.begin();
    const e = await db.execute('INSERT INTO t VALUES (1)').catch((err) => err);
    assert.equal(e.code, NOT_LEADER);
    assert.equal(peer.state.requests, 2);
    await db.close();
  });
});

test('an outcome_unknown answer is never sent again', async () => {
  await withPeer(
    scriptedPeer((rid) => refusalEnvelope(rid, 'answer lost', { error_code: OUTCOME_UNKNOWN })),
    async (peer) => {
      const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port, ...fast });
      const e = await db.execute('INSERT INTO t VALUES (1)').catch((err) => err);
      assert.equal(e.code, OUTCOME_UNKNOWN);
      assert.equal(e.isRedirect, false);
      assert.equal(peer.state.requests, 1);
      await db.close();
    },
  );
});

test('pooled connections follow the leader too', async () => {
  await withPeer(scriptedPeer((rid) => okEnvelope(rid, { ok: true })), async (leader) => {
    const hint = `127.0.0.1:${leader.port}`;
    await withPeer(scriptedPeer((rid) => notLeader(rid, hint)), async (follower) => {
      const pool = new Pool({ host: '127.0.0.1', port: follower.port, size: 2, ...fast });
      await pool.use((db) => db.execute('INSERT INTO t VALUES (1)'));
      await pool.use((db) => db.execute('INSERT INTO t VALUES (2)'));
      assert.equal(follower.state.requests, 1);
      assert.equal(leader.state.requests, 2);
      await pool.close();
    });
  });
});
