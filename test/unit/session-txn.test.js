'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const { TriCore, Pool, TriCoreError, FEATURES, FEATURE_SESSION_TXN } = require('tricoredb');

const USER = 'admin';
const PASSWORD = 'txn-secret';
const PASSWORD_ENV = 'TRICORE_TXN_TEST_PW';
const TABLE = 'txn_t';

function binary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const repoRoot = path.resolve(__dirname, '..', '..');
  for (const dir of ['release', 'debug']) {
    const p = path.join(repoRoot, 'target', dir, exe);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no ${exe} under ${path.join(repoRoot, 'target')}; build it first`);
}

function writeConfig(dir) {
  const dataDir = path.join(dir, 'data').replace(/\\/g, '/');
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = `[server]\nhost = "127.0.0.1"\nport = 0\nnode_id = "sdk-node-session-txn"\nregion_id = "test"\nshutdown_grace_secs = 1\n\n[modules]\nsql = true\ndocument = false\ncache = false\nvector = false\ngraph = false\nllm = false\ncluster = true\n\n[storage]\ndata_dir = "${dataDir}"\nfsync = false\n\n[security]\nauth_mode = "password"\ndev_auth = false\n\n[tls]\nenabled = false\n`;
  const file = path.join(dir, 'tricore.session-txn.toml');
  fs.writeFileSync(file, cfg, 'utf8');
  return { file, dataDir };
}

function seedAdmin(dataDir) {
  const r = spawnSync(binary('tricore'), ['auth', 'init-admin', '--user', USER, '--password-env', PASSWORD_ENV, '--data-dir', dataDir], {
    encoding: 'utf8',
    env: { ...process.env, [PASSWORD_ENV]: PASSWORD },
  });
  if (r.status !== 0) throw new Error(`init-admin failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
}

function startServer(configFile) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary('tricore-server'), ['--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; proc.kill();
      reject(new Error(`server did not report a port within 30s.\n${out}\n${err}`));
    }, 30000);
    proc.stdout.on('data', (c) => {
      out += c.toString();
      const m = /listening on\s+([0-9.]+):(\d+)/.exec(out);
      if (m && !settled) { settled = true; clearTimeout(timer); resolve({ proc, host: m[1], port: Number(m[2]) }); }
    });
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    proc.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`server exited ${code}\n${out}\n${err}`)); }
    });
  });
}

async function count(db) {
  return Number((await db.query(`SELECT COUNT(*) FROM ${TABLE}`)).rows[0][0]);
}

test('session transactions are honored and rolled back properly', async () => {
  const bin = (() => {
    try { return binary('tricore-server'); } catch { return null; }
  })();
  if (!bin) {
    console.log('  skip - no tricore-server binary available for session transaction checks');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-node-session-txn-'));
  const { file, dataDir } = writeConfig(dir);
  seedAdmin(dataDir);
  const server = await startServer(file);
  const opts = { host: server.host, port: server.port, user: USER, secret: PASSWORD };

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

    await db.begin();
    await db.execute(`INSERT INTO ${TABLE} VALUES (3, 300)`);
    await assert.rejects(() => db.execute('INSERT INTO no_such_table VALUES (1, 1)'), /no_such_table|aborted/i);
    await assert.rejects(() => db.execute(`INSERT INTO ${TABLE} VALUES (4, 400)`), /aborted|ROLLBACK/i);
    await assert.rejects(() => db.commit(), /COMMIT.*rolled back|rolled back/i);
    assert.equal(db.inTransaction, false);
    assert.equal(await count(db), 1);

    await db.begin();
    await db.execute(`INSERT INTO ${TABLE} VALUES (3, 300)`);
    await db.execute('INSERT INTO no_such_table VALUES (1, 1)').catch(() => {});
    out = await db.rollback();
    assert.equal(out.transaction, 'rolled_back');
    await db.execute(`INSERT INTO ${TABLE} VALUES (9, 900)`);
    assert.equal(await count(db), 2);
    await db.execute(`DELETE FROM ${TABLE} WHERE id = 9`);

    await db.begin();
    await db.execute(`INSERT INTO ${TABLE} VALUES (5, 500)`);
    assert.equal(await count(db), 2);
    assert.equal(await count(other), 1);
    await assert.rejects(() => other.commit(), /no transaction is open|COMMIT is refused/i);
    await db.commit();
    assert.equal(await count(other), 2);

    await db.begin();
    await db.execute(`INSERT INTO ${TABLE} VALUES (6, 600)`);
    await assert.rejects(() => db.begin(), /already open|BEGIN is refused/i);
    await db.rollback();
    assert.equal(await count(db), 2);

    const boom = new Error('application error after a write');
    await assert.rejects(() => db.withTransaction(async (tx) => {
      await tx.execute(`INSERT INTO ${TABLE} VALUES (7, 700)`);
      throw boom;
    }), /application error after a write/);
    assert.equal(db.inTransaction, false);
    assert.equal(await count(db), 2);

    const result = await db.withTransaction(async (tx) => {
      await tx.execute(`INSERT INTO ${TABLE} VALUES (8, 800)`);
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(await count(other), 3);

    const plain = await TriCore.connect({ ...opts, features: FEATURES & ~FEATURE_SESSION_TXN });
    assert.equal(plain.features.sessionTxn, false);
    await assert.rejects(() => plain.begin(), /SESSION_TXN|transaction\(\[\.\.\.\]\)/i);
    const script = await plain.transaction([`INSERT INTO ${TABLE} VALUES (10, 1000)`, `DELETE FROM ${TABLE} WHERE id = 10`]);
    assert.equal(script.transaction, 'committed');
    await assert.rejects(() => plain.execute('BEGIN'), /BEGIN; <statements>; COMMIT/i);
    await plain.close();

    const pool = new Pool({ ...opts, size: 2 });
    await assert.rejects(() => pool.use(async (c) => {
      await c.begin();
      await c.execute(`INSERT INTO ${TABLE} VALUES (11, 1100)`);
    }), /still open|rolled back/i);
    assert.equal(await count(other), 3);
    await pool.close();

    await other.close();
    await db.close();
  } finally {
    try { server.proc.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
