# tricoredb

Official Node.js client for [TriCoreDB](https://hub.docker.com/r/trinesh14/tricoredb) —
SQL, documents, vectors, graphs and cache over one native connection.

[![npm](https://img.shields.io/npm/v/tricoredb.svg?cacheSeconds=3600)](https://www.npmjs.com/package/tricoredb)
[![node](https://img.shields.io/node/v/tricoredb.svg?cacheSeconds=86400)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/tricoredb.svg?cacheSeconds=86400)](LICENSE)

- **Zero runtime dependencies** — nothing to audit but Node.js itself
- **Written in TypeScript** — full type definitions, generated from the source
- **ESM and CommonJS** — works with `import` and `require`
- **Server-side parameters** — values never become part of the SQL text
- **Exact values** — `bigint`, decimals and binary data survive the round trip
- **Transactions, connection pooling, TLS and mutual TLS**

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Running a server](#running-a-server)
- [Quick start](#quick-start)
- [Connecting](#connecting)
- [SQL](#sql)
- [Transactions](#transactions)
- [Connection pool](#connection-pool)
- [Documents](#documents)
- [Vectors](#vectors)
- [Graphs](#graphs)
- [Cache](#cache)
- [LLM context](#llm-context)
- [Errors](#errors)
- [TLS](#tls)
- [Security](#security)
- [Compatibility](#compatibility)

## Requirements

- Node.js **18** or later (tested on every major version from 18 to 26)
- A TriCoreDB server speaking protocol 1.0 (`tricore-server` 0.1.0-rc.1 or later) —
  see [Running a server](#running-a-server)

## Installation

```bash
npm install tricoredb
```

## Running a server

The quickest way is the official Docker image,
[`trinesh14/tricoredb`](https://hub.docker.com/r/trinesh14/tricoredb).

**Local development** (no TLS, no encryption — this machine only). Set
`TRICORE_ADMIN_PASSWORD` in your shell first, then create the admin and start
the server:

```bash
docker run --rm -v tricoredb-dev:/var/lib/tricoredb -e TRICORE_ADMIN_PASSWORD --entrypoint /usr/local/bin/tricore trinesh14/tricoredb:0.1.0-rc.1-r2 auth init-admin --user admin --password-env TRICORE_ADMIN_PASSWORD --data-dir /var/lib/tricoredb/data
docker run -d --name tricoredb-dev -p 127.0.0.1:8427:8427 -e TRICORE_TLS=off -e TRICORE_ENCRYPTION=off -e TRICORE_MODULES=all -v tricoredb-dev:/var/lib/tricoredb trinesh14/tricoredb:0.1.0-rc.1-r2
```

The [Quick start](#quick-start) below then connects as `admin` with that
password.

**Anything else:** the image's default is **TLS on** and an **encrypted data
volume**. Follow the quick start on the
[Docker Hub page](https://hub.docker.com/r/trinesh14/tricoredb) to create the
certificate and key, then connect with TLS:

```js
const db = await TriCore.connect({
  host: 'localhost',
  port: 8427,
  user: 'admin',
  secret: process.env.TRICOREDB_PASSWORD,
  tls: { caFile: 'tricoredb-ca.crt', serverName: 'localhost' },
});
```

Without the `tls` option, a client cannot connect to a TLS server.

`TRICORE_MODULES=all` enables every data model. The image's default is `sql`,
`document` and `cache`; a call to a disabled model fails with
[`engine.disabled`](#disabled-data-models).

## Quick start

```js
import { TriCore } from 'tricoredb';

const db = await TriCore.connect({
  host: '127.0.0.1',
  port: 8427,
  user: process.env.TRICOREDB_USER,
  secret: process.env.TRICOREDB_PASSWORD,
});

await db.execute('CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY, name TEXT)');
await db.execute('INSERT INTO users VALUES (?, ?)', [1, 'Ada']);

const rows = await db.query('SELECT id, name FROM users WHERE id = ?', [1]);
console.log(rows.dicts()); // [ { id: '1', name: 'Ada' } ]

await db.close();
```

CommonJS:

```js
const { TriCore } = require('tricoredb');
```

TypeScript types ship with the package — no `@types` install needed:

```ts
import { TriCore, type ConnectOptions, type Rows } from 'tricoredb';
```

## Connecting

```js
const db = await TriCore.connect(options);
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | `'127.0.0.1'` | Server host |
| `port` | `number` | `8427` | Server port |
| `user` | `string \| null` | — | Username. Omit to skip authentication. |
| `secret` | `string` | — | Password |
| `clientName` | `string` | — | Name reported to the server |
| `timeout` | `number` | — | Milliseconds for connect, TLS, handshake and authentication. `0` disables it. |
| `readTimeoutMs` | `number \| null` | `null` | Deadline for each reply. A timed-out connection is unusable afterwards. |
| `tls` | `TlsOptions \| null` | — | Enables TLS. See [TLS](#tls). |
| `features` | `number` | `FEATURES` | Capabilities to request during the handshake |
| `followLeader` | `boolean` | `true` | Send a `not_leader` refusal again, to the leader (see [Cluster redirects](#cluster-redirects)) |
| `leaderRetries` | `number` | `5` | How many times a refused request is sent again |
| `leaderRetryDelayMs` | `number` | `250` | First pause before asking again; doubles up to 2000 |

```js
await db.ping();               // round-trip check
db.features;                   // { serverParams, sessionTxn, correlationId, mask }
await db.close();
```

Every data method takes an optional **last** argument, `database`, which
defaults to `'main'`.

## SQL

### Queries and statements

```js
const rows = await db.query('SELECT id, name FROM users WHERE name = ?', ['Ada']);
rows.columns;   // ['id', 'name']
rows.rows;      // [['1', 'Ada']]
rows.dicts();   // [{ id: '1', name: 'Ada' }]
rows.length;    // 1
for (const row of rows) console.log(row);

const res = await db.execute('UPDATE users SET name = ? WHERE id = ?', ['Grace', 1]);
res.warnings;   // non-fatal server warnings
```

- `query()` returns `Rows`. **Every cell is a string** — convert to the type you
  need (`Number(...)`, `BigInt(...)`, a decimal library, …).
- `execute()` returns a `Response` for statements that do not return rows.

### Parameters

Use `?` placeholders (or `$1`, `$2`, …). Values are sent separately from the SQL
text and bound by the server, so they can never change what the statement means.

| JavaScript value | Sent as | Use for |
| --- | --- | --- |
| `null`, `undefined` | `NULL` | |
| `boolean` | boolean | `BOOL` |
| `number` (safe integer) | integer | `INT`, `BIGINT` |
| `number` (fractional) | number | `DOUBLE` |
| `bigint` | exact integer | `BIGINT` beyond 2⁵³ |
| `string` | text | `TEXT`, and **exact** `DECIMAL` values (`'19.99'`) |
| `Date` | ISO-8601 text | `TIMESTAMP` |
| `Uint8Array` / `Buffer` | `0x…` hex | `BLOB` |

- An integer `number` outside the safe range is **rejected** rather than silently
  rounded — pass a `bigint` instead.
- Send exact decimals as **strings**. A JavaScript `number` is a binary float.
- Identifiers (table and column names) cannot be parameters. Validate them
  against an allow-list.

## Transactions

A session transaction spans several calls on the same connection:

```js
await db.begin();
try {
  await db.execute('UPDATE accounts SET balance = balance - ? WHERE id = ?', [100, 1]);
  await db.execute('UPDATE accounts SET balance = balance + ? WHERE id = ?', [100, 2]);
  await db.commit();
} catch (err) {
  await db.rollback();
  throw err;
}
```

`withTransaction` does the same: it commits when the callback resolves, and
rolls back and re-throws when it throws.

```js
const orderId = await db.withTransaction(async (tx) => {
  await tx.execute('INSERT INTO orders VALUES (?, ?)', [42, 'pending']);
  await tx.execute('UPDATE stock SET qty = qty - 1 WHERE sku = ?', ['A-1']);
  return 42;
});
```

A pre-declared unit can also run atomically in a single request:

```js
await db.transaction([
  ['INSERT INTO t VALUES (?)', [1]],
  'DELETE FROM t WHERE id = 0',
]);
```

If the server does not support session transactions, `begin()` fails with a
clear error instead of silently running each statement on its own.

A schema change (for example `CREATE TABLE`) that commits while a transaction
is open aborts that transaction: the next statement fails and asks for
`ROLLBACK`. Retry the transaction after rolling back. Avoid running migrations
while transactions are in flight.

## Connection pool

```js
import { Pool } from 'tricoredb';

const pool = new Pool({ host: '127.0.0.1', port: 8427, user, secret, size: 8 });

const rows = await pool.use((db) => db.query('SELECT COUNT(*) FROM users'));

pool.stats(); // { size, created, idle, inUse, waiting }
await pool.close();
```

- `pool.use(fn, timeoutMs = 10000)` borrows a connection for the duration of
  `fn` and returns it afterwards. It rejects with `PoolTimeout` if none frees up
  in time.
- A connection is never returned to the pool with a transaction still open; use
  `db.withTransaction()` inside the callback.

## Documents

```js
import { DocFilter, DocStage } from 'tricoredb';

await db.documentCreateCollection('people');
const id = await db.documentInsert('people', { name: 'Ada', city: 'London', visits: 3 });
const doc = await db.documentGet('people', id);

const londoners = await db.documentFind('people', DocFilter.eq('city', 'London'), { limit: 10 });

await db.documentUpdateOne('people', id, { set: { city: 'Paris' }, inc: { visits: 1 } });
await db.documentUpdateMany('people', DocFilter.gt('visits', 10), { set: { vip: true } });
await db.documentCreateIndex('people', 'by_city', 'city', { unique: false });

const perCity = await db.documentAggregate('people', [
  DocStage.group(DocStage.byField('city'), [DocStage.countDocs('n'), DocStage.sum('total', 'visits')]),
  DocStage.sort([{ field: 'n', descending: true }]),
]);
```

Filters: `all`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `inList`, `contains`, `and`.
Stages: `match`, `group`, `sort`, `skip`, `limit`, `project`, `count`.

Also: `documentUpdate`, `documentDelete`, `documentListCollections`,
`documentDropCollection`, `documentDropIndex`, `documentListIndexes`,
`documentAnalyze`.

### Batches, options and transactions

These need server 0.1.0-rc.3 or later; an older server answers them with an error.

```js
import { DocBulk } from 'tricoredb';

const ids = await db.documentInsertMany('people', [{ name: 'Lin' }, { _id: 'kay', name: 'Kay' }]);
await db.documentReplace('people', 'kay', { name: 'Kay', city: 'Oslo' }, { return: 'After' });

// One atomic batch: every item lands or none does.
await db.documentBulkWrite('people', [
  DocBulk.insert({ name: 'Tim' }, { id: 'tim' }),
  DocBulk.updateOne('kay', { inc: { visits: 1 } }),
  DocBulk.delete(ids[0]),
]);

// A transaction spans requests on this connection until it commits or rolls back.
await db.documentBeginTransaction();          // sets db.txn
try {
  await db.documentUpdate('people', 'kay', { city: 'Bergen' });
  await db.documentCommitTransaction();
} catch (err) {
  await db.documentRollbackTransaction();     // a refused commit leaves it open
  throw err;
}
```

| Group | Methods |
| --- | --- |
| Writes | `documentReplace`, `documentInsertMany`, `documentDeleteMany`, `documentBulkWrite` (items from `DocBulk`: `insert`, `updateOne`, `replace`, `delete`) |
| Transactions | `documentBeginTransaction`, `documentCommitTransaction`, `documentRollbackTransaction` |
| Collections | `documentRenameCollection`, `documentSetCollectionOptions`, `documentGetCollectionOptions` (schema, defaults, versioning), `documentPurgeExpired` |
| Indexes and plans | `documentRebuildIndex`, `documentExplain` |

## Vectors

```js
await db.vectorCreateCollection('embeddings', 3, { metric: 'cosine' }); // 'cosine' | 'dot' | 'l2'
await db.vectorUpsert('embeddings', 'doc-1', [0.1, 0.2, 0.3], { title: 'Intro' });

const hits = await db.vectorSearch('embeddings', [0.1, 0.2, 0.25], 5);
// [{ id, score, metadata }], best first
```

Also: `vectorGet`, `vectorDelete`, `vectorListCollections`,
`vectorDescribeCollection`, `vectorListVectors`, `vectorDropCollection`.

### Batches, named vectors and more searches

These need server 0.1.0-rc.3 or later; an older server answers them with an error.

```js
await db.vectorUpsertMany('embeddings', [
  { id: 'doc-2', vector: [0.3, 0.1, 0.9], metadata: { lang: 'en' } },
  { id: 'doc-3', vector: [0.2, 0.2, 0.2] },
]);
const perQuery = await db.vectorSearchBatch('embeddings', [[0.1, 0.2, 0.3], [0.9, 0, 0]], 5, { filter: { lang: 'en' } });
const similar = await db.vectorSearchByExamples('embeddings', ['doc-1'], 5);
const english = await db.vectorCount('embeddings', { filter: { lang: 'en' } });

await db.vectorAddNamedVector('embeddings', 'title', 2, 'dot');
await db.vectorUpsertNamed('embeddings', 'doc-1', { default: [0.1, 0.2, 0.3], title: [1, 2] });
const byTitle = await db.vectorSearch('embeddings', [1, 2], 5, { using: 'title' });
```

| Group | Methods |
| --- | --- |
| Writes | `vectorUpsertMany`, `vectorUpsertText`, `vectorUpsertNamed`, `vectorDeleteMany`, `vectorDeleteByFilter`, `vectorUpdateByFilter` |
| Searches | `vectorSearchBatch`, `vectorSearchMulti`, `vectorSearchByExamples`, and the options of `vectorSearch` (`using`, `offset`, `exact`, `namespace`, ...) |
| Reads | `vectorCount`, `vectorListPartitions`, `vectorEmbed`, `vectorListAliases` |
| Collections | `vectorAddNamedVector`, `vectorSetAlias`, `vectorSetCollectionConfig`, `vectorCopyCollection`, `vectorRenameCollection` |
| Index | `vectorRebuildIndex`, `vectorIndexStats`, `vectorMeasureRecall` |

## Graphs

```js
await db.graphCreate('social');
await db.graphAddNode('social', 'ada', { labels: ['person'], properties: { name: 'Ada' } });
await db.graphAddNode('social', 'grace', { labels: ['person'], properties: { name: 'Grace' } });
await db.graphAddEdge('social', 'e1', 'ada', 'grace', 'knows', { properties: { since: 1843 } });

const friends = await db.graphNeighbors('social', 'ada', { direction: 'outgoing' });
const path = await db.graphShortestPath('social', 'ada', 'grace');
const result = await db.graphQuery('social', 'MATCH (p:person) RETURN p.name ORDER BY p.name');
// { columns: ['p.name'], rows: [['Ada'], ['Grace']], count, truncated }
```

Also: `graphGetNode`, `graphGetEdge`, `graphDeleteNode`, `graphDeleteEdge`,
`graphTraverse`, `graphWeightedShortestPath`, `graphDegree`, `graphListNodes`,
`graphListEdges`, `graphListGraphs`, `graphDrop`.

### Batches, algorithms, schema and Cypher writes

These need server 0.1.0-rc.3 or later; an older server answers them with an error.

```js
await db.graphAddMany('social', {
  nodes: [{ id: 'lin', labels: ['person'] }, { id: 'kay', labels: ['person'] }],
  edges: [{ id: 'e2', from: 'lin', to: 'kay', label: 'knows' }],
});
const ranks = await db.graphPageRank('social', { limit: 10 });       // { ranks: [{ id, score }], ... }
const parts = await db.graphConnectedComponents('social');

await db.graphCreateConstraint('social', 'unique_name', 'person', 'name', 'unique');
await db.graphExecute('social', "CREATE (n:person {name: 'Tim'})");

await db.graphBeginTransaction('social');     // sets db.txn; graphExecute is queued until the commit
await db.graphExecute('social', "CREATE (n:person {name: 'Una'})");
await db.graphCommitTransaction('social');
```

| Group | Methods |
| --- | --- |
| Writes | `graphAddMany`, `graphRemoveMany`, `graphUpdateNode`, `graphUpdateEdge`, `graphImportCsv`, `graphCopy`, `graphExecute` (Cypher writes) |
| Transactions | `graphBeginTransaction`, `graphCommitTransaction`, `graphRollbackTransaction` |
| Walks and paths | `graphDfs`, `graphSubgraph`, `graphKShortestPaths`, `graphAllPaths` |
| Algorithms | `graphPageRank`, `graphCentrality`, `graphCommunities`, `graphConnectedComponents`, `graphTriangleCount`, `graphNodeSimilarity`, `graphDetectCycle` |
| Schema | `graphCreateNodeIndex`, `graphCreateConstraint`, `graphDropSchemaObject`, `graphListSchemaObjects`, `graphFindNodes` |
| Inspection | `graphStats`, `graphSchema`, `graphCheckConsistency` |

## Cache

Keys and values are binary-safe. Values accept `Buffer`, `Uint8Array` or `string`.

```js
await db.cacheSet('sessions', 'user:1', JSON.stringify({ id: 1 }), 60_000); // TTL in ms
const raw = await db.cacheGet('sessions', 'user:1');       // Buffer | null
const text = await db.cacheGetText('sessions', 'user:1');  // string | null
await db.cacheIncr('counters', 'page:home');
await db.cacheDelete('sessions', 'user:1');                // true if it existed
```

| Group | Methods |
| --- | --- |
| Keys | `cacheSet`, `cacheSetNx`, `cacheGet`, `cacheGetText`, `cacheDelete`, `cacheExists`, `cacheTtl`, `cacheExpire`, `cachePersist`, `cacheIncr`, `cacheKeys`, `cacheClearNamespace` |
| Lists | `cacheLPush`, `cacheRPush`, `cacheLPop`, `cacheRPop`, `cacheLRange`, `cacheLLen`, `cacheLIndex` |
| Sets | `cacheSAdd`, `cacheSRem`, `cacheSIsMember`, `cacheSCard`, `cacheSMembers` |
| Hashes | `cacheHSet`, `cacheHSetText`, `cacheHGet`, `cacheHDel`, `cacheHGetAll`, `cacheHExists`, `cacheHLen` |
| Streams | `cacheXAdd`, `cacheXAddText`, `cacheXLen`, `cacheXRange`, `cacheXRead`, `cacheXDel`, `cacheXTrim` |

The groups below need server 0.1.0-rc.3 or later; an older server answers them
with an error.

```js
import { CacheExpiry } from 'tricoredb';

await db.cacheMSet('sessions', [['user:1', 'a'], ['user:2', 'b']]);
const values = await db.cacheMGet('sessions', ['user:1', 'user:9']);   // [Buffer, null]
await db.cacheSetIf('sessions', 'user:1', 'c', 'IfPresent', CacheExpiry.keep());

await db.cacheZAdd('scores', 'board', [{ member: 'ada', score: 12 }, { member: 'lin', score: 7 }]);
const top = await db.cacheZRangeWithScores('scores', 'board', 0, 9, { rev: true });

const lock = await db.cacheLockAcquire('locks', 'report', 'worker-1', 30_000);
if (lock.acquired) {
  // pass lock.token to whatever the lock protects, then:
  await db.cacheLockRelease('locks', 'report', 'worker-1');
}
```

| Group | Methods |
| --- | --- |
| Keys | `cacheMGet`, `cacheMSet`, `cacheSetIf`, `cacheCompareAndSwap`, `cacheGetDel`, `cacheGetSet`, `cacheGetEx`, `cacheAppend`, `cacheExpireAt` |
| Freshness | `cacheSetFresh`, `cacheGetFresh`, `cacheSetMissing`, `cacheWarm` |
| Sorted sets | `cacheZAdd`, `cacheZRem`, `cacheZScore`, `cacheZCard`, `cacheZRank`, `cacheZRange`, `cacheZRangeWithScores`, `cacheZRangeByScore`, `cacheZRangeByScoreWithScores`, `cacheZIncrBy` |
| Locks | `cacheLockAcquire`, `cacheLockRenew`, `cacheLockRelease` |
| Bitmaps | `cacheSetBit`, `cacheGetBit`, `cacheBitCount`, `cacheBitPos`, `cacheBitOp` |
| HyperLogLog | `cachePfAdd`, `cachePfCount`, `cachePfMerge` |
| Lists | `cacheLMove`, `cacheLTrim`, `cacheBLPop`, `cacheBRPop` |
| Sets and hashes | `cacheSUnion`, `cacheSInter`, `cacheSDiff`, `cacheSRandMember`, `cacheHIncrBy` |
| Batches and scripts | `cachePipeline`, `cacheTransaction`, `cacheScriptLoad`, `cacheScriptRun` |
| Pub/Sub | `cachePublish`, `cachePoll` |
| Administration | `cacheStats`, `cacheHotKeys`, `cacheSetNamespaceLimit`, `cacheGetNamespaceLimit`, `cachePurgeExpired`, `cacheFlushDatabase` |

`cachePipeline`, `cacheTransaction` and `cacheScriptLoad` take operations in
the server's wire form, such as `{ Incr: { namespace: 'n', key: 'k', by: 1 } }`,
and each result is `{ ok: <response data> }` or `{ error: '...' }`.
`cacheFlushDatabase` and `cachePurgeExpired` act on the whole database named in
their last argument. `cacheHotKeys` is refused unless the server sets
`[cache] hot_keys`.

## LLM context

Build compact context for a language model from your data:

```js
const context = await db.llmContext(
  [{ sql: 'SELECT * FROM orders LIMIT 20' }, { collection: 'people', limit: 10 }],
  { format: 'json', maxRows: 50, redactSensitive: true },
);
const schema = await db.llmSchema({ format: 'json' });
```

## Errors

All errors extend `TriCoreError`.

| Class | When |
| --- | --- |
| `TriCoreError` | The server refused a request, or a general failure |
| `AuthError` | Authentication failed |
| `ProtocolError` | The server sent something the driver cannot interpret |
| `Timeout` | No reply within `readTimeoutMs`. Discard the connection. |
| `PoolTimeout` | No pooled connection became free in time |

Branch on `err.code`, never on the message text:

```js
import { TriCoreError } from 'tricoredb';

try {
  await db.execute('INSERT INTO users VALUES (?, ?)', [1, 'Ada']);
} catch (err) {
  if (err instanceof TriCoreError && err.code === 'state.conflict') {
    // a concurrent transaction won — retry the transaction
  }
  throw err;
}
```

| Code | Meaning |
| --- | --- |
| `perm.denied` | Not authorized for this operation or database |
| `request.invalid` | The server refused the request (bad SQL, type mismatch, …) |
| `request.malformed` | The request could not be interpreted |
| `engine.disabled` | That data model is disabled on the server |
| `limit.exceeded` | A resource limit was reached |
| `state.conflict` | Transaction conflict — retrying the transaction may succeed |
| `not_leader` | This cluster node cannot serve the request (see below) |
| `outcome_unknown` | Handed to the leader, answer lost: may have been applied |
| `internal` | Server fault |

### Disabled data models

A server can switch data models off. A client cannot turn one back on, so an
`engine.disabled` error (`ENGINE_DISABLED`) says who can, and how:

```text
invalid request: module `graph` is not enabled (...) (server status: error)
[engine.disabled: the `graph` module is switched off on the server, and a client cannot
enable it. The server operator must turn it on: for the TriCoreDB container, add `graph`
to TRICORE_MODULES (for example TRICORE_MODULES=sql,document,cache,graph), or set
TRICORE_MODULES=all, and recreate the container; for a server using a config file, set
[modules] graph = true and restart.]
```

### Cluster redirects

On a replicated cluster, only the leader accepts writes. A follower refuses
with `not_leader`, and the driver handles that itself (`followLeader`, on by
default):

- when the refusal names the leader, the driver opens a connection there,
  authenticated as before, sends the request again, and keeps using that
  connection;
- while an election is in progress (no leader named), it waits and asks the
  same node again, pausing 250 ms, then 500 ms, up to 2 s;
- it gives up after `leaderRetries` (5) and throws the last refusal.

This is safe because a `not_leader` refusal was applied nowhere. The driver
never resends a request inside a session transaction (the transaction belongs
to its connection), and never resends `outcome_unknown` (`OUTCOME_UNKNOWN`):
a follower handed that request to the leader and lost the answer, so it may
have been applied. Check before sending it again.

Following uses the address the server reports, so it must be reachable from
your application; with TLS, the leader's certificate is checked against that
host name. When it is not reachable (for example through a single port
forward), the driver keeps the connection it has and waits, and the error
explains what happened. To handle redirects yourself:

```js
const db = await TriCore.connect({ host, user, secret, followLeader: false });
try {
  await db.execute('INSERT INTO t VALUES (1)');
} catch (err) {
  if (err.isRedirect) {
    console.log(err.leaderHint); // 'host:port', or null while an election is in progress
  }
}
```

`db.address` is the `host:port` a connection is talking to now.

## TLS

```js
const db = await TriCore.connect({
  host: 'db.example.com',
  port: 8427,
  user,
  secret,
  tls: {
    caFile: '/etc/ssl/tricoredb-ca.pem',
    serverName: 'db.example.com',
  },
});
```

| Option | Description |
| --- | --- |
| `caFile` | PEM CA bundle to trust |
| `serverName` | Name expected in the server certificate (SNI) |
| `clientCertFile`, `clientKeyFile` | Client certificate and key, for mutual TLS |
| `dangerAcceptInvalidCerts` | Skips certificate verification. **Development only.** |

## Security

- Load credentials from the environment or a secret manager — never commit them.
- Use TLS whenever traffic leaves a trusted network.
- Always pass user input as parameters, never by string concatenation.
- Connect with a least-privilege user.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Compatibility

| tricoredb | Node.js | TriCoreDB protocol |
| --- | --- | --- |
| 0.1.x, 0.2.x | 18 – 26 | 1.0 |
| 0.3.x | 18 – 26 | 1.0 |

0.3 adds methods for the operations of server 0.1.0-rc.3. They need that server
or a later one; the methods of earlier releases work against older servers as
before.

This package follows [semantic versioning](https://semver.org). See
[CHANGELOG.md](CHANGELOG.md) for release notes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
