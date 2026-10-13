# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Against server 0.1.0-rc.3 and later, a `begin()` inside an open session
  transaction opens a nested block (a savepoint) instead of being refused: its
  `commit()` releases it and its `rollback()` undoes only that block. Those
  calls answer with `nested_depth` and no `transaction`, so
  `TransactionSummary.transaction` is now optional. `inTransaction` stays true
  until the outermost block ends; before this, ending a nested block made it
  report false while the outer block was still open, which would have let a
  pool hand the connection on mid-transaction.

## [0.3.0] - 2026-10-13

### Added

- A typed method for each of the 116 operations added in TriCoreDB server
  0.1.0-rc.3. **They need server 0.1.0-rc.3 or later: an older server answers
  them with an error.** Methods from earlier releases are unchanged.
  - Cache (53): multi get and set, conditional and compare-and-swap writes,
    stale-while-revalidate reads, sorted sets, fencing locks, bitmaps,
    HyperLogLog, list moves and blocking pops, set algebra, pipelines,
    transactions and scripts, publish and poll, namespace limits, statistics,
    whole-database purge and flush.
  - Document (13): replace, insert many, delete many, bulk write, transactions,
    collection options (schema, defaults, versioning), rename, explain, index
    rebuild, TTL purge.
  - Vector (21): batch upsert and delete, text upsert and embedding, named
    vectors, aliases, batch, multi-query and by-example search, filtered
    update, delete and count, partitions, collection copy, rename and
    configuration, index rebuild, statistics and recall.
  - Graph (29): bulk add and remove, in-place updates, CSV import, Cypher
    writes, transactions, depth-first walks, subgraphs, k-shortest and all
    paths, PageRank, centrality, communities, components, triangles,
    similarity, cycle detection, indexes and constraints, statistics, schema
    and consistency checks.
- `DocBulk`: builders for the items of `documentBulkWrite`.
- `CacheExpiry`: what `cacheSetIf` and `cacheGetEx` do with a key's deadline.
- `TriCore.txn`: the open document or graph transaction. While it is set every
  request carries it as `options.txn`. The begin methods set it; commit and
  rollback clear it. A pooled connection left with one is closed rather than
  handed to the next borrower, and a request inside one is not sent to another
  node on `not_leader`.
- `vectorSearch` accepts the server's search options (`using`, `offset`,
  `exact`, `namespace`, ...). A call without them sends what it always sent.
- `VectorMetric` includes `l1` and `linf`.

### Notes

- `cacheZRangeByScore` sends an infinite bound as the largest finite double,
  because JSON has no infinity and the server stores no infinite score.
- `cacheHotKeys` returns the server's response as is: the operation is refused
  unless the server sets `[cache] hot_keys`.

## [0.2.0] - 2026-09-17

### Added

- Following the leader: a request refused with `not_leader` is sent again,
  to the leader the refusal names (over a new connection that replaces the
  current one) or, while no leader is known, to the same node after a pause.
  On by default; `followLeader: false` restores the previous behaviour.
  `leaderRetries` (5) and `leaderRetryDelayMs` (250) bound it. Never inside
  a session transaction.
- `OUTCOME_UNKNOWN`: the code of a request a follower handed to the leader
  and lost the answer to. It is never resent.
- `TriCore.address`: the `host:port` a connection is talking to.

### Changed

- A `not_leader` error message now says whether the driver already retried.

## [0.1.1] - 2026-09-15

### Changed

- `package.json` declares `"type": "commonjs"`, so Node.js does not have to
  detect the module format of the package root. The ESM and CommonJS builds
  and their exports are unchanged.
- Publishing is pinned to the public npm registry.
- The package is managed through the `tricoredb` npm organization.

## [0.1.0] - 2026-09-15

First release.

### Added

- Native TriCoreDB protocol client for Node.js 18 and later, with zero runtime
  dependencies. Tested on every major version from 18 to 26 against a
  TriCoreDB container.
- TypeScript source with generated type definitions, published as both ESM and
  CommonJS.
- SQL: `query()` and `execute()` with server-side `?` / `$n` parameters.
  `bigint`, exact decimals (as strings), `Date` and binary data round-trip
  exactly.
- Session transactions (`begin`, `commit`, `rollback`, `withTransaction`) and
  single-request transaction scripts (`transaction`).
- Connection pool (`Pool`) that never returns a connection with an open
  transaction.
- Documents, vectors, graphs, cache (keys, lists, sets, hashes, streams), LLM
  context and admin operations — all 82 operations of the TriCoreDB conformance
  suite.
- Typed errors with stable codes (`err.code`) and cluster redirect hints
  (`err.isRedirect`, `err.leaderHint`).
- A call to a data model that is switched off on the server fails with code
  `engine.disabled` (exported as `ENGINE_DISABLED`), and the message says the
  operator must enable the module — for the container, with `TRICORE_MODULES`.
- TLS and mutual TLS.

### Security

- Operations that need a server capability which was not granted (server-side
  parameters, session transactions) fail with a clear error instead of silently
  falling back.
- A failed login is reported as `AuthError`.

[Unreleased]: https://github.com/trinesh14/tricoredb-sdk-js/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/trinesh14/tricoredb-sdk-js/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/trinesh14/tricoredb-sdk-js/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/trinesh14/tricoredb-sdk-js/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/trinesh14/tricoredb-sdk-js/releases/tag/v0.1.0
