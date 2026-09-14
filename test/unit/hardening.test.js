'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { TriCore, Pool, TriCoreError, AuthError, ProtocolError, Timeout } = require('tricoredb');

const TAG = { HELLO: 0, ERROR: 6, HELLO_OK: 8 };

function hostilePeer(after) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let greeted = false;
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        while (buf.length >= 6) {
          const len = buf.readUInt32BE(2);
          if (buf.length < 6 + len) return;
          const tag = buf.readUInt8(1);
          buf = buf.subarray(6 + len);
          if (tag === TAG.HELLO && !greeted) {
            greeted = true;
            const body = Buffer.from(JSON.stringify({ ok: true, features: 0 }), 'utf8');
            const h = Buffer.alloc(6);
            h.writeUInt8(1, 0); h.writeUInt8(TAG.HELLO_OK, 1); h.writeUInt32BE(body.length, 2);
            sock.write(Buffer.concat([h, body]));
          } else {
            sock.write(after());
          }
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function hostilePeerRaw(next) {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 6) {
        const len = buf.readUInt32BE(2);
        if (buf.length < 6 + len) return;
        buf = buf.subarray(6 + len);
        const out = next();
        if (out.length) sock.write(out);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function silentPeer() {
  return hostilePeer(() => Buffer.alloc(0));
}

function headerOnly(version, tag, declaredLength) {
  const h = Buffer.alloc(6);
  h.writeUInt8(version, 0); h.writeUInt8(tag, 1); h.writeUInt32BE(declaredLength, 2);
  return h;
}

async function rejectsWith(label, fn, wantType = TriCoreError) {
  try {
    await fn();
    assert.fail(`${label}: expected rejection`);
  } catch (e) {
    assert.ok(e instanceof wantType, `${label}: wrong error type ${e && e.constructor && e.constructor.name}`);
  }
}

function deadline(promise, ms, what) {
  let timer;
  const bomb = new Promise((_r, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms (it hung)`)), ms);
  });
  return Promise.race([promise, bomb]).finally(() => clearTimeout(timer));
}

test('frame ceilings and version checks are enforced', async () => {
  const case1 = await hostilePeer(() => headerOnly(1, 3, 0xffffffff));
  try {
    const db = await TriCore.connect({ host: '127.0.0.1', port: case1.port });
    await rejectsWith('oversized response is refused', () => deadline(db.ping(), 4000, 'oversized response'), ProtocolError);
    await db.close().catch(() => {});
  } finally {
    case1.srv.close();
  }

  const case2 = await hostilePeer(() => headerOnly(1, 6, 1024 * 1024));
  try {
    const db = await TriCore.connect({ host: '127.0.0.1', port: case2.port });
    await rejectsWith('oversized control frame is refused', () => deadline(db.ping(), 4000, 'oversized control frame'), ProtocolError);
    await db.close().catch(() => {});
  } finally {
    case2.srv.close();
  }

  const case3 = await hostilePeer(() => headerOnly(99, 5, 0));
  try {
    const db = await TriCore.connect({ host: '127.0.0.1', port: case3.port });
    await rejectsWith('unsupported frame version is refused', () => deadline(db.ping(), 4000, 'unsupported version'), ProtocolError);
    await db.close().catch(() => {});
  } finally {
    case3.srv.close();
  }
});

test('read deadlines and close behavior are typed and fatal', async () => {
  const peer = await silentPeer();
  try {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port, readTimeoutMs: 800 });
    await rejectsWith('read deadline ends as Timeout', () => deadline(db.ping(), 5000, 'read deadline'), Timeout);
    await rejectsWith('timed-out connection is fatal', () => deadline(db.ping(), 3000, 'reuse after timeout'), TriCoreError);
    await db.close().catch(() => {});
  } finally {
    peer.srv.close();
  }

  const peer2 = await silentPeer();
  try {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer2.port });
    let settled = false;
    db.ping().then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(settled, false);
    await db.close().catch(() => {});
  } finally {
    peer2.srv.close();
  }
});

test('HELLO/AUTH refusals are handled as protocol and auth errors, not success', async () => {
  const peer = await hostilePeerRaw(() => {
    const b = Buffer.alloc(6); b.writeUInt8(1, 0); b.writeUInt8(8, 1); b.writeUInt32BE(0, 2);
    return Buffer.concat([b, Buffer.from(JSON.stringify({ ok: false, message: 'protocol mismatch' }), 'utf8')]);
  });
  try {
    await rejectsWith('HELLO_OK ok=false is a protocol refusal', () => TriCore.connect({ host: '127.0.0.1', port: peer.port }), ProtocolError);
  } finally {
    peer.srv.close();
  }

  const peer2 = await hostilePeerRaw(() => {
    const payload1 = Buffer.from(JSON.stringify({ ok: true, features: 0 }), 'utf8');
    const h1 = Buffer.alloc(6); h1.writeUInt8(1, 0); h1.writeUInt8(8, 1); h1.writeUInt32BE(payload1.length, 2);
    const payload2 = Buffer.from(JSON.stringify({ ok: false, message: 'bad password' }), 'utf8');
    const h2 = Buffer.alloc(6); h2.writeUInt8(1, 0); h2.writeUInt8(9, 1); h2.writeUInt32BE(payload2.length, 2);
    return Buffer.concat([h1, payload1, h2, payload2]);
  });
  try {
    const e = await TriCore.connect({ host: '127.0.0.1', port: peer2.port, user: 'u', secret: 'p' }).catch((err) => err);
    assert.ok(e instanceof AuthError);
  } finally {
    peer2.srv.close();
  }
});

test('feature bitmap and request ids are handled correctly', async () => {
  const peer = await hostilePeerRaw(() => {
    const payload = Buffer.from(JSON.stringify({ ok: true, features: 0 }), 'utf8');
    const h = Buffer.alloc(6); h.writeUInt8(1, 0); h.writeUInt8(8, 1); h.writeUInt32BE(payload.length, 2);
    return Buffer.concat([h, payload]);
  });
  try {
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    assert.equal(db.grantedFeatures, 0);
    await db.close();
  } finally {
    peer.srv.close();
  }

  const serverBinary = process.platform === 'win32' ? 'tricore-server.exe' : 'tricore-server';
  const repoRoot = path.resolve(__dirname, '..', '..');
  const candidates = [process.env.TRICORE_SERVER_BIN, path.join(repoRoot, 'target', 'release', serverBinary), path.join(repoRoot, 'target', 'debug', serverBinary)];
  const bin = candidates.find((c) => c && fs.existsSync(c));
  if (!bin) {
    test.skip('no tricore-server binary available for live request-id checks');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-node-hardening-'));
  const dataDir = path.join(dir, 'data').replace(/\\/g, '/');
  const cfg = `[server]\nhost = "127.0.0.1"\nport = 0\nnode_id = "sdk-node-hardening"\nregion_id = "test"\nshutdown_grace_secs = 1\n\n[modules]\nsql = true\ndocument = false\ncache = true\nvector = false\ngraph = false\nllm = false\ncluster = true\n\n[storage]\ndata_dir = "${dataDir}"\nfsync = false\n\n[security]\nauth_mode = "password"\ndev_auth = true\n\n[tls]\nenabled = false\n`;
  const file = path.join(dir, 'tricore.hardening.toml');
  fs.writeFileSync(file, cfg, 'utf8');

  const proc = spawn(bin, ['--config', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const waited = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`server did not report a port within 30s.\n${out}\n${err}`)), 30000);
    proc.stdout.on('data', (c) => {
      out += c.toString();
      const m = /listening on\s+([0-9.]+):(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ host: m[1], port: Number(m[2]) }); }
    });
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!out && code !== 0) reject(new Error(`server exited ${code}\n${out}\n${err}`));
    });
  });

  try {
    const opts = { host: waited.host, port: waited.port, user: 'alice', secret: 'pw' };
    const a = await TriCore.connect(opts);
    const b = await TriCore.connect(opts);
    const ra = await a.request({ Admin: 'Ping' });
    const rb = await b.request({ Admin: 'Ping' });
    assert.ok(ra.requestId && rb.requestId);
    assert.notEqual(ra.requestId, rb.requestId);
    await a.close();
    await b.close();
  } finally {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
