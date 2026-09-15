'use strict';

// Starts a private tricore-server for one live test file: ephemeral port, its own
// temp data dir, observability on port 0. Never builds; stops by PID only.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = process.env.TRICORE_REPO || 'D:/TRICORE DB/tricore/tricore-db';

function findBinary(name, envVar) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [];
  if (process.env[envVar]) candidates.push(process.env[envVar]);
  for (const profile of ['release', 'debug']) candidates.push(path.join(REPO, 'target', profile, exe));
  return candidates.find((c) => fs.existsSync(c)) || null;
}

const serverBinary = () => findBinary('tricore-server', 'TRICORE_SERVER_BIN');
const cliBinary = () => findBinary('tricore', 'TRICORE_CLI_BIN');

/**
 * An already-running server to test against instead of starting one, e.g. a
 * TriCoreDB container. Set TRICORE_TEST_HOST (and optionally _PORT, _USER,
 * _SECRET). The server must use real authentication, since the tests exercise a
 * wrong-password refusal.
 */
const external = process.env.TRICORE_TEST_HOST
  ? {
      host: process.env.TRICORE_TEST_HOST,
      port: Number(process.env.TRICORE_TEST_PORT || 8427),
      user: process.env.TRICORE_TEST_USER || 'admin',
      secret: process.env.TRICORE_TEST_SECRET || '',
    }
  : null;

/** Why live tests cannot run here, or null when they can. */
function unavailable({ needCli = false } = {}) {
  if (external) return null;
  if (!serverBinary()) return 'no tricore-server binary (set TRICORE_SERVER_BIN or TRICORE_REPO)';
  if (needCli && !cliBinary()) return 'no tricore CLI binary (set TRICORE_CLI_BIN or TRICORE_REPO)';
  return null;
}

function writeConfig(dir, { mode, tls }) {
  const dataDir = path.join(dir, 'data').replace(/\\/g, '/');
  fs.mkdirSync(dataDir, { recursive: true });
  const fwd = (p) => p.replace(/\\/g, '/');
  const tlsBlock = tls
    ? `[tls]\nenabled = true\ncert_file = "${fwd(tls.certFile)}"\nkey_file = "${fwd(tls.keyFile)}"\n` +
      (tls.caFile ? `ca_file = "${fwd(tls.caFile)}"\nrequire_client_cert = true\n` : '')
    : '[tls]\nenabled = false\n';
  const cfg = `[server]
host = "127.0.0.1"
port = 0
node_id = "sdk-js-${path.basename(dir)}"
region_id = "test"
shutdown_grace_secs = 1

[modules]
sql = true
document = true
cache = true
vector = true
graph = true
llm = true
cluster = true

[storage]
data_dir = "${dataDir}"
fsync = false

[security]
auth_mode = "password"
dev_auth = ${mode === 'dev' ? 'true' : 'false'}

${tlsBlock}
[observability]
port = 0
`;
  const file = path.join(dir, 'tricore.test.toml');
  fs.writeFileSync(file, cfg, 'utf8');
  return { file, dataDir };
}

function seedAdmin(dataDir, user, secret) {
  const r = spawnSync(
    cliBinary(),
    ['auth', 'init-admin', '--user', user, '--password-env', 'TRICORE_JS_TEST_SECRET', '--data-dir', dataDir],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, TRICORE_JS_TEST_SECRET: secret } },
  );
  if (r.error || r.status !== 0) {
    throw new Error(`init-admin failed (${r.error ? r.error.message : `exit ${r.status}`}):\n${r.stdout}${r.stderr}`);
  }
}

/**
 * Start a server. `mode: 'dev'` accepts any credentials; `mode: 'password'`
 * seeds a real administrator first. Resolves `{ host, port, user, secret, stop }`.
 */
async function startServer({ mode = 'dev', tls = null } = {}) {
  if (external) {
    if (tls) throw new Error('TLS tests start their own server; unset TRICORE_TEST_HOST to run them');
    return { ...external, pid: null, opts: { ...external }, async stop() {} };
  }
  const bin = serverBinary();
  if (!bin) throw new Error(unavailable());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-js-'));
  const { file, dataDir } = writeConfig(dir, { mode, tls });
  const user = mode === 'dev' ? 'sdk_js' : 'admin';
  const secret = mode === 'dev' ? 'pw' : crypto.randomBytes(18).toString('base64url');
  if (mode === 'password') seedAdmin(dataDir, user, secret);

  const proc = spawn(bin, ['--config', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => proc.once('exit', r));
  const killByPid = () => {
    try {
      process.kill(proc.pid);
    } catch {
      // already gone
    }
  };

  const { host, port } = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      killByPid();
      reject(new Error(`server did not report a port within 30s\n${out}\n${err}`));
    }, 30000);
    proc.stdout.on('data', (c) => {
      out += c.toString();
      const m = /listening on\s+([0-9.]+):(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ host: m[1], port: Number(m[2]) });
      }
    });
    proc.stderr.on('data', (c) => {
      err += c.toString();
    });
    proc.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}\n${out}\n${err}`));
    });
  });

  return {
    host,
    port,
    user,
    secret,
    pid: proc.pid,
    opts: { host, port, user, secret },
    async stop() {
      killByPid();
      await exited;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may still hold a handle; the temp dir is disposable.
      }
    },
  };
}

module.exports = { startServer, unavailable, serverBinary, cliBinary };
