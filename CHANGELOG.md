# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

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
- TLS and mutual TLS.

### Security

- Operations that need a server capability which was not granted (server-side
  parameters, session transactions) fail with a clear error instead of silently
  falling back.
- A failed login is reported as `AuthError`.

[Unreleased]: https://github.com/trinesh14/tricoredb-sdk-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/trinesh14/tricoredb-sdk-js/releases/tag/v0.1.0
