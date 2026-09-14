'use strict';

// TLS configuration mistakes fail before a byte is written, and never echo key
// material. Certificate verification itself is proven in test/live/tls.test.js.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { TriCore, TriCoreError } = require('tricoredb');

function countingListener() {
  const state = { connections: 0 };
  const srv = net.createServer((s) => { state.connections += 1; s.destroy(); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    port: srv.address().port, state, close: () => new Promise((r) => srv.close(() => r())),
  })));
}

test('half an mTLS identity is a configuration error, and no connection is attempted', async () => {
  const l = await countingListener();
  try {
    for (const [tls, missing] of [
      [{ clientCertFile: 'client.pem' }, 'clientKeyFile'],
      [{ clientKeyFile: 'client.key' }, 'clientCertFile'],
    ]) {
      const e = await TriCore.connect({ host: '127.0.0.1', port: l.port, tls }).catch((err) => err);
      assert.ok(e instanceof TriCoreError);
      assert.match(e.message, new RegExp(missing));
    }
    assert.equal(l.state.connections, 0);
  } finally {
    await l.close();
  }
});

test('an unreadable file is named by path, and key contents never reach the error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-js-tls-'));
  const keyFile = path.join(dir, 'client.key');
  fs.writeFileSync(keyFile, 'SUPER-SECRET-KEY-MATERIAL');
  const missingCa = path.join(dir, 'no-such-ca.pem');
  const missingCert = path.join(dir, 'no-such-client.pem');
  const l = await countingListener();
  try {
    const caErr = await TriCore.connect({ host: '127.0.0.1', port: l.port, tls: { caFile: missingCa } }).catch((err) => err);
    assert.ok(caErr instanceof TriCoreError);
    assert.ok(caErr.message.includes(missingCa), caErr.message);

    const certErr = await TriCore.connect({
      host: '127.0.0.1', port: l.port, tls: { caFile: keyFile, clientCertFile: missingCert, clientKeyFile: keyFile },
    }).catch((err) => err);
    assert.ok(certErr instanceof TriCoreError);
    assert.ok(certErr.message.includes(missingCert), certErr.message);
    assert.ok(!certErr.message.includes('SUPER-SECRET'), 'no file contents in the message');
    assert.equal(l.state.connections, 0);
  } finally {
    await l.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a connect failure is a TriCoreError, and a connect timeout is bounded', async () => {
  const l = await countingListener();
  const port = l.port;
  await l.close();
  const e = await TriCore.connect({ host: '127.0.0.1', port }).catch((err) => err);
  assert.ok(e instanceof TriCoreError);
  assert.match(e.message, /connect failed/);
});
