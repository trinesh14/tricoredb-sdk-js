'use strict';

// The README's examples, run against a real server. If an example here stops
// working, the README is wrong — fix both together.
//
// Hooks live inside `describe`: a top-level `test.before()` is not run before
// the tests on Node 19, which left `db` undefined. Scoped hooks behave the same
// on every supported version.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { TriCore, Pool, DocFilter, DocStage, TriCoreError } = require('tricoredb');
const { startServer, unavailable } = require('../helpers/server.js');

describe('README examples', { skip: unavailable() || false }, () => {
  let server;
  let db;

  before(async () => {
    server = await startServer({ mode: 'dev' });
    db = await TriCore.connect(server.opts);
  });

  after(async () => {
    if (db) await db.close();
    if (server) await server.stop();
  });

  it('quick start', async () => {
    await db.execute('CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY, name TEXT)');
    await db.execute('INSERT INTO users VALUES (?, ?)', [1, 'Ada']);
    const rows = await db.query('SELECT id, name FROM users WHERE id = ?', [1]);
    assert.deepEqual(rows.dicts(), [{ id: '1', name: 'Ada' }]);
    assert.deepEqual(rows.columns, ['id', 'name']);
    assert.equal(rows.length, 1);

    const res = await db.execute('UPDATE users SET name = ? WHERE id = ?', ['Grace', 1]);
    assert.ok(Array.isArray(res.warnings));
    const updated = await db.query('SELECT name FROM users WHERE id = ?', [1]);
    assert.equal(updated.rows[0][0], 'Grace');
  });

  it('transactions', async () => {
    await db.execute('CREATE TABLE accounts (id INT PRIMARY KEY, balance INT)');
    await db.execute('INSERT INTO accounts VALUES (1, 500)');
    await db.execute('INSERT INTO accounts VALUES (2, 0)');

    await db.begin();
    try {
      await db.execute('UPDATE accounts SET balance = balance - ? WHERE id = ?', [100, 1]);
      await db.execute('UPDATE accounts SET balance = balance + ? WHERE id = ?', [100, 2]);
      await db.commit();
    } catch (err) {
      await db.rollback();
      throw err;
    }
    const balances = await db.query('SELECT id, balance FROM accounts ORDER BY id');
    assert.deepEqual(balances.rows, [['1', '400'], ['2', '100']]);

    await db.execute('CREATE TABLE orders (id INT PRIMARY KEY, status TEXT)');
    await db.execute('CREATE TABLE stock (sku TEXT PRIMARY KEY, qty INT)');
    await db.execute("INSERT INTO stock VALUES ('A-1', 5)");
    const orderId = await db.withTransaction(async (tx) => {
      await tx.execute('INSERT INTO orders VALUES (?, ?)', [42, 'pending']);
      await tx.execute('UPDATE stock SET qty = qty - 1 WHERE sku = ?', ['A-1']);
      return 42;
    });
    assert.equal(orderId, 42);
    assert.equal((await db.query("SELECT qty FROM stock WHERE sku = 'A-1'")).rows[0][0], '4');

    await db.execute('CREATE TABLE t (id INT PRIMARY KEY)');
    await db.execute('INSERT INTO t VALUES (0)');
    await db.transaction([['INSERT INTO t VALUES (?)', [1]], 'DELETE FROM t WHERE id = 0']);
    assert.deepEqual((await db.query('SELECT id FROM t')).rows, [['1']]);
  });

  it('connection pool', async () => {
    const pool = new Pool({ ...server.opts, size: 8 });
    const rows = await pool.use((c) => c.query('SELECT COUNT(*) FROM users'));
    assert.equal(rows.rows[0][0], '1');
    const stats = pool.stats();
    assert.equal(stats.size, 8);
    assert.equal(stats.inUse, 0);
    await pool.close();
  });

  it('documents', async () => {
    await db.documentCreateCollection('people');
    const id = await db.documentInsert('people', { name: 'Ada', city: 'London', visits: 3 });
    assert.equal(typeof id, 'string');
    await db.documentInsert('people', { name: 'Alan', city: 'London', visits: 12 });
    const doc = await db.documentGet('people', id);
    assert.equal(doc.name, 'Ada');

    const londoners = await db.documentFind('people', DocFilter.eq('city', 'London'), { limit: 10 });
    assert.equal(londoners.length, 2);

    await db.documentUpdateOne('people', id, { set: { city: 'Paris' }, inc: { visits: 1 } });
    const moved = await db.documentGet('people', id);
    assert.equal(moved.city, 'Paris');
    assert.equal(moved.visits, 4);

    const many = await db.documentUpdateMany('people', DocFilter.gt('visits', 10), { set: { vip: true } });
    assert.equal(many.modified, 1);
    await db.documentCreateIndex('people', 'by_city', 'city', { unique: false });

    const perCity = await db.documentAggregate('people', [
      DocStage.group(DocStage.byField('city'), [DocStage.countDocs('n'), DocStage.sum('total', 'visits')]),
      DocStage.sort([{ field: 'n', descending: true }]),
    ]);
    assert.equal(perCity.length, 2);
  });

  it('vectors', async () => {
    await db.vectorCreateCollection('embeddings', 3, { metric: 'cosine' });
    await db.vectorUpsert('embeddings', 'doc-1', [0.1, 0.2, 0.3], { title: 'Intro' });
    await db.vectorUpsert('embeddings', 'doc-2', [0.9, -0.1, 0.0], { title: 'Other' });
    const hits = await db.vectorSearch('embeddings', [0.1, 0.2, 0.25], 5);
    assert.equal(hits[0].id, 'doc-1');
    assert.equal(typeof hits[0].score, 'number');
    assert.deepEqual(hits[0].metadata, { title: 'Intro' });
  });

  it('graphs', async () => {
    await db.graphCreate('social');
    await db.graphAddNode('social', 'ada', { labels: ['person'], properties: { name: 'Ada' } });
    await db.graphAddNode('social', 'grace', { labels: ['person'], properties: { name: 'Grace' } });
    await db.graphAddEdge('social', 'e1', 'ada', 'grace', 'knows', { properties: { since: 1843 } });

    const friends = await db.graphNeighbors('social', 'ada', { direction: 'outgoing' });
    assert.deepEqual(friends.map((f) => f.node_id), ['grace']);
    const path = await db.graphShortestPath('social', 'ada', 'grace');
    assert.equal(path.found, true);
    assert.deepEqual(path.node_path, ['ada', 'grace']);

    const result = await db.graphQuery('social', 'MATCH (p:person) RETURN p.name ORDER BY p.name');
    assert.deepEqual(result.columns, ['p.name']);
    assert.deepEqual(result.rows, [['Ada'], ['Grace']]);
  });

  it('cache', async () => {
    await db.cacheSet('sessions', 'user:1', JSON.stringify({ id: 1 }), 60_000);
    const raw = await db.cacheGet('sessions', 'user:1');
    assert.ok(Buffer.isBuffer(raw));
    assert.equal(await db.cacheGetText('sessions', 'user:1'), '{"id":1}');
    assert.equal(await db.cacheIncr('counters', 'page:home'), 1);
    assert.equal(await db.cacheDelete('sessions', 'user:1'), true);
    assert.equal(await db.cacheDelete('sessions', 'user:1'), false);
  });

  it('llm context', async () => {
    const context = await db.llmContext(
      [{ sql: 'SELECT * FROM users LIMIT 20' }, { collection: 'people', limit: 10 }],
      { format: 'json', maxRows: 50, redactSensitive: true },
    );
    assert.ok(context !== null && context !== undefined);
    const schema = await db.llmSchema({ format: 'json' });
    assert.ok(schema !== null && schema !== undefined);
  });

  it('errors carry a stable code', async () => {
    const err = await db.execute('INSERT INTO no_such_table VALUES (1)').then(
      () => assert.fail('the statement should have been refused'),
      (e) => e,
    );
    assert.ok(err instanceof TriCoreError);
    assert.equal(typeof err.code, 'string');
    assert.equal(err.isRedirect, false);
  });
});
