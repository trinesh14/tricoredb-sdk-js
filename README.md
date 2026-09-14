# TriCoreDB JavaScript SDK

A standalone Node.js client for TriCoreDB with SQL, document, vector, graph, cache, LLM, and admin APIs.

## Install

```bash
npm install tricoredb
```

## Connect

```js
const { TriCore } = require('tricoredb');

async function main() {
  const db = await TriCore.connect({
    host: '127.0.0.1',
    port: 8427,
    user: 'alice',
    secret: 'pw',
  });

  const rows = await db.query('SELECT 1 AS n');
  console.log(rows.rows[0][0]);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## SQL with parameters

The driver sends server-side parameters by default when the server grants `SERVER_PARAMS`. A `Date` becomes an ISO string and `Uint8Array`/`Buffer` become `0x` + hex.

```js
const { TriCore } = require('tricoredb');

const db = await TriCore.connect({ host: '127.0.0.1', port: 8427 });
await db.execute('INSERT INTO t VALUES (?, ?, ?)', [42, 'hello', Buffer.from([0xde, 0xad])]);
const rows = await db.query('SELECT * FROM t WHERE id = ?', [42]);
console.log(rows.rows);
await db.close();
```

## Transactions

```js
const { TriCore } = require('tricoredb');

const db = await TriCore.connect({ host: '127.0.0.1', port: 8427 });
await db.begin();
await db.execute('INSERT INTO t VALUES (1, 100)');
await db.commit();
await db.close();
```

The driver also supports one-request scripts and pooled transactions:

```js
const { Pool } = require('tricoredb');

const pool = new Pool({ host: '127.0.0.1', port: 8427, size: 4 });
await pool.use(async (db) => {
  const res = await db.withTransaction(async (tx) => {
    await tx.execute('INSERT INTO t VALUES (2, 200)');
    return 'ok';
  });
  console.log(res);
});
await pool.close();
```

## Pool

Use a pool when you want concurrency without overlapping requests on one socket:

```js
const { Pool } = require('tricoredb');

const pool = new Pool({ host: '127.0.0.1', port: 8427, size: 8 });
const rows = await pool.use(async (db) => db.query('SELECT 1 AS n'));
console.log(rows.rows);
await pool.close();
```

## Data models

### Documents

```js
const { DocFilter } = require('tricoredb');

await db.documentCreateCollection('people');
await db.documentInsert('people', { name: 'Ada', age: 36 });
const docs = await db.documentFind('people', DocFilter.eq('name', 'Ada'));
```

### Vectors

```js
await db.vectorCreateCollection('embeddings', 3, { metric: 'cosine' });
await db.vectorUpsert('embeddings', 'ada', [0.1, 0.2, 0.3], { role: 'engineer' });
const hits = await db.vectorSearch('embeddings', [0.1, 0.2, 0.3], 5);
```

### Graphs

```js
await db.graphCreate('friends');
await db.graphAddNode('friends', 'ada', { labels: ['person'], properties: { name: 'Ada' } });
await db.graphAddNode('friends', 'grace', { labels: ['person'], properties: { name: 'Grace' } });
await db.graphAddEdge('friends', 'e1', 'ada', 'grace', 'knows');
```

### Cache

```js
await db.cacheSet('app', 'hello', Buffer.from('world'), 60_000);
const value = await db.cacheGetText('app', 'hello');
```

### LLM context

```js
const bundle = await db.llmContext({ sql: 'SELECT * FROM t LIMIT 5' }, { format: 'json' });
```

### Admin

```js
await db.adminPing();
const status = await db.adminStatus();
```

## Errors and redirects

The SDK exposes stable error codes and leader hints. If the server replies with `not_leader`, the error sets `code` to `not_leader`, `leaderHint` to the hinted host:port value when one exists, and `isRedirect` to `true`. The driver does not follow the hint automatically.

```js
try {
  await db.execute('INSERT INTO t VALUES (1)');
} catch (err) {
  if (err.isRedirect) {
    console.log(err.code, err.leaderHint);
  }
}
```

## TLS

```js
const db = await TriCore.connect({
  host: 'example.com',
  port: 8427,
  tls: {
    caFile: '/path/to/ca.pem',
    serverName: 'example.com',
  },
});
```

For local development, set `dangerAcceptInvalidCerts: true` only when you deliberately want to skip hostname and certificate checks.

## License

This project is licensed under the Apache License 2.0.
