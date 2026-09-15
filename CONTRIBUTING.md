# Contributing

Thanks for helping improve the TriCoreDB JavaScript SDK.

## Setup

```bash
npm ci
npm run build
```

Requires Node.js 18 or later.

## Checks

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | TypeScript, including the published type declarations (`test/types`) |
| `npm run test:unit` | Hermetic tests against scripted peers. No server needed. |
| `npm run test:live` | Tests against a real `tricore-server`. Skipped, and reported as skipped, when no binary is available. |
| `npm test` | Build, then every suite |
| `npm run conformance` | The cross-SDK conformance matrix (all 82 operations) |
| `npm run pack:dry-run` | Shows exactly what would be published |
| `npm run test:docker` | Unit and live suites on Node 18–26, each against a fresh TriCoreDB container (needs Docker and a `tricoredb:local` image) |

Live tests find the server through `TRICORE_SERVER_BIN` and the CLI through
`TRICORE_CLI_BIN`, or a built checkout through `TRICORE_REPO`. Each test starts
its own server on an ephemeral port with a temporary data directory.

## Guidelines

- **No runtime dependencies.** The package ships with none, and that is a
  feature.
- **Source is TypeScript.** Types are generated from the implementation; do not
  hand-edit `.d.ts` files.
- **Assert what the server returns.** A test that only checks that a call did
  not throw proves little.
- **Never degrade silently.** If an operation needs a capability the server did
  not grant, fail with a clear error instead of falling back.
- Keep the public API stable. Breaking changes require a major version and a
  `CHANGELOG.md` entry.

## Pull requests

1. Add or update tests for the change.
2. Run `npm run typecheck` and `npm test`.
3. Add a line to `CHANGELOG.md` under *Unreleased*.
