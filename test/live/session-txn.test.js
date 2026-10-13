'use strict';

// Session transactions against a real server with real authentication.

const test = require('node:test');
const assert = require('node:assert/strict');

const { TriCore, Pool, FEATURES, FEATURE_SESSION_TXN } = require('tricoredb');
const { startServer, unavailable } = require('../helpers/server.js');

const TABLE = 'txn_t';
const skip = unavailable({ needCli: true });

async function count(db) {
  return Number((await db.query(`SELECT COUNT(*) FROM ${TABLE}`)).rows[0][0]);
}

test('session transactions commit, roll back and refuse misuse by name', { skip: skip || false }, async () => {
  const server = await startServer({ mode: 'password' });
  const opts = server.opts;
  try {
    const db = await TriCore.connect(opts);
    assert.equal(db.features.sessionTxn, true);
    assert.notEqual(db.grantedFeatures & FEATURE_SESSION_TXN, 0);
    await db.execute(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, v INT)`);

    let out = await db.begin();
    assert.equal(out.transaction, 'began');
    assert.equal(db.inTransaction, true);
    await db.execute(`INSERT INTO ${TABLE} VALUES (1, 100)`);
    assert.equal(await count(db), 1);
    out = await db.rollback();
    assert.equal(out.transaction, 'rolled_back');
    assert.equal(await count(db), 0);

    await db.begin();
    await db.execute(`INSERT INTO ${TABLE} VALUES (2, 200)`);
    out = await db.commit();
    assert.equal(out.transaction, 'committed');
    const other = await TriCore.connect(opts);
    assert.equal(await count(other), 1);

    // A failed statement aborts the block: later statements and COMMIT are refused.
    await db.begin();
    await db.execute(`INSERT INTO ${TABLE} VALUES (3, 300)`);
    await assert.rejects(() => db.execute('INSERT INTO no_such_table VALUES (1, 1)'), /no_such_table|aborted/i);
    await assert.rejects(() => db.execute(`INSERT INTO ${TABLE} VALUES (4, 400)`), /aborted|ROLLBACK/i);
    await assert.rejects(() => db.commit(), /rolled back/i);
    assert.equal(db.inTransaction, false);
    assert.equal(await count(db), 1);

    // Isolation: another connection does not see uncommitted writes, and cannot commit them.
    await db.begin();
    await db.execute(`INSERT INTO ${TABLE} VALUES (5, 500)`);
    assert.equal(await count(db), 2);
    assert.equal(await count(other), 1);
    await assert.rejects(() => other.commit(), /no transaction is open|COMMIT is refused/i);
    await db.commit();
    assert.equal(await count(other), 2);

    // A BEGIN inside an open block opens a nested block backed by a savepoint
    // (server 0.1.0-rc.3 and later; 0.1.0-rc.2 refused it). Rolling the inner
    // block back undoes only what it wrote, and the outer block stays open.
    const ids = async (conn) => (await conn.query(`SELECT id FROM ${TABLE} ORDER BY id`)).rows.map((r) => r[0]);
    await db.begin();
    await db.execute(`INSERT INTO ${TABLE} VALUES (60, 6000)`);
    assert.equal((await db.begin()).nested_depth, 1);
    assert.equal(db.inTransaction, true);
    await db.execute(`INSERT INTO ${TABLE} VALUES (61, 6100)`);
    assert.deepEqual(await ids(db), ['2', '5', '60', '61']);
    assert.equal((await db.rollback()).nested_depth, 0);
    assert.equal(db.inTransaction, true, 'the outer block is still open');
    assert.deepEqual(await ids(db), ['2', '5', '60'], 'only the inner block was undone');
    assert.deepEqual(await ids(other), ['2', '5'], 'nothing is committed yet');
    assert.equal((await db.commit()).transaction, 'committed');
    assert.equal(db.inTransaction, false);
    assert.deepEqual(await ids(other), ['2', '5', '60']);

    // A nested block that commits keeps its writes only if the outer one does.
    await db.begin();
    await db.begin();
    await db.execute(`INSERT INTO ${TABLE} VALUES (62, 6200)`);
    assert.equal((await db.commit()).nested_depth, 0);
    assert.equal(db.inTransaction, true);
    assert.equal((await db.rollback()).transaction, 'rolled_back');
    assert.equal(db.inTransaction, false);
    assert.deepEqual(await ids(other), ['2', '5', '60']);

    // withTransaction inside an open block is a nested block: a throw undoes
    // its own writes and leaves the outer block open.
    await db.begin();
    await db.execute(`DELETE FROM ${TABLE} WHERE id = 60`);
    await assert.rejects(
      () => db.withTransaction(async (tx) => {
        await tx.execute(`INSERT INTO ${TABLE} VALUES (63, 6300)`);
        throw new Error('inner failure');
      }),
      /inner failure/,
    );
    assert.equal(db.inTransaction, true);
    assert.deepEqual(await ids(db), ['2', '5']);
    await db.commit();
    assert.deepEqual(await ids(other), ['2', '5']);

    // withTransaction rolls back on a thrown error and re-throws that error.
    const boom = new Error('application error after a write');
    await assert.rejects(
      () => db.withTransaction(async (tx) => {
        await tx.execute(`INSERT INTO ${TABLE} VALUES (7, 700)`);
        throw boom;
      }),
      /application error after a write/,
    );
    assert.equal(db.inTransaction, false);
    assert.equal(await count(db), 2);

    const result = await db.withTransaction(async (tx) => {
      await tx.execute(`INSERT INTO ${TABLE} VALUES (8, 800)`);
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(await count(other), 3);

    // Without the SESSION_TXN bit, begin() is refused by name; one-request scripts still work.
    const plain = await TriCore.connect({ ...opts, features: FEATURES & ~FEATURE_SESSION_TXN });
    assert.equal(plain.features.sessionTxn, false);
    await assert.rejects(() => plain.begin(), /SESSION_TXN/i);
    const script = await plain.transaction([`INSERT INTO ${TABLE} VALUES (10, 1000)`, `DELETE FROM ${TABLE} WHERE id = 10`]);
    assert.equal(script.transaction, 'committed');
    await plain.close();

    // A pooled connection is never returned with a transaction still open.
    const pool = new Pool({ ...opts, size: 2 });
    await assert.rejects(
      () => pool.use(async (c) => {
        await c.begin();
        await c.execute(`INSERT INTO ${TABLE} VALUES (11, 1100)`);
      }),
      /still open|rolled back/i,
    );
    assert.equal(await count(other), 3);
    await pool.close();

    await other.close();
    await db.close();
  } finally {
    await server.stop();
  }
});
