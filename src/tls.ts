import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

import { TriCoreError } from './errors.js';
import type { TlsOptions } from './types.js';

/**
 * `tls.connect` options for a TLS session. Verification stays on unless
 * `dangerAcceptInvalidCerts`; `ca` replaces Node's root store, so no `caFile`
 * means an empty store and a typo'd path fails closed. Errors name paths,
 * never file contents.
 */
export function tlsConnectOptions(opts: TlsOptions): ConnectionOptions {
  const {
    caFile = null,
    serverName = 'localhost',
    dangerAcceptInvalidCerts = false,
    clientCertFile = null,
    clientKeyFile = null,
  } = opts;

  if ((clientCertFile === null) !== (clientKeyFile === null)) {
    const missing = clientKeyFile === null ? 'clientKeyFile' : 'clientCertFile';
    throw new TriCoreError(`tls ${missing} is required alongside the other (both are needed for mTLS)`);
  }

  const read = (path: string, label: string): Buffer => {
    try {
      return readFileSync(path);
    } catch (e) {
      throw new TriCoreError(`tls ${label} \`${path}\`: ${(e as Error).message}`);
    }
  };

  const out: ConnectionOptions = {
    servername: serverName,
    rejectUnauthorized: !dangerAcceptInvalidCerts,
    ca: caFile ? [read(caFile, 'caFile')] : [],
  };
  if (clientCertFile && clientKeyFile) {
    out.cert = read(clientCertFile, 'clientCertFile');
    out.key = read(clientKeyFile, 'clientKeyFile');
  }
  return out;
}
