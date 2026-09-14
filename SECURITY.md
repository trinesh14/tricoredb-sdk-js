# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/trinesh14/tricoredb-sdk-js/security/advisories/new)
for this repository. Include the SDK version, Node.js version, a description of
the issue and, if possible, a minimal reproduction.

You can expect an acknowledgement within a few working days. Please give us a
reasonable window to release a fix before disclosing publicly.

## Using the driver safely

- **Never hardcode credentials.** Read the password from the environment or a
  secret manager, not from source code.
- **Use TLS outside a trusted network.** Without it, the password and all data
  travel in clear text. Do not enable `dangerAcceptInvalidCerts` in production.
- **Bind values as parameters** (`?` / `$1`). Never build SQL by string
  concatenation from user input. Identifiers (table and column names) cannot be
  parameters — validate them against an allow-list.
- **Connect with a least-privilege user** rather than an administrator.
- The driver has **zero runtime dependencies**, which keeps its supply-chain
  surface to Node.js itself.
