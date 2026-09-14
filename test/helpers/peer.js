'use strict';

// A scripted peer that speaks real frame bytes on a real socket, for proofs a
// well-behaved server can never produce (redirects, hostile frames).

const net = require('node:net');

const TAG = {
  HELLO: 0, AUTH: 1, REQUEST: 2, RESPONSE: 3, PING: 4, PONG: 5, ERROR: 6, CLOSE: 7,
  HELLO_OK: 8, AUTH_OK: 9, BYE: 10,
};

function frame(tag, body) {
  const b = body === null || body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  const h = Buffer.alloc(6);
  h.writeUInt8(1, 0);
  h.writeUInt8(tag, 1);
  h.writeUInt32BE(b.length, 2);
  return Buffer.concat([h, b]);
}

function headerOnly(version, tag, declaredLength) {
  const h = Buffer.alloc(6);
  h.writeUInt8(version, 0);
  h.writeUInt8(tag, 1);
  h.writeUInt32BE(declaredLength, 2);
  return h;
}

/** Parse frames off a socket and hand each `{tag, body}` to `onFrame(frame, sock)`. */
function listen(onFrame) {
  const state = { connections: 0, requests: 0, frames: [] };
  const srv = net.createServer((sock) => {
    state.connections += 1;
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 6) {
        const len = buf.readUInt32BE(2);
        if (buf.length < 6 + len) return;
        const tag = buf.readUInt8(1);
        const body = len ? JSON.parse(buf.subarray(6, 6 + len).toString('utf8')) : null;
        buf = buf.subarray(6 + len);
        const f = { tag, body };
        state.frames.push(f);
        if (tag === TAG.REQUEST) state.requests += 1;
        onFrame(f, sock, state);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        state,
        close: () => new Promise((r) => { srv.close(() => r()); }),
      });
    });
  });
}

/**
 * A peer that completes HELLO (granting `features`) and AUTH for real and
 * answers each REQUEST with `reply(requestId, n, body)`.
 */
function scriptedPeer(reply, { features = 0 } = {}) {
  return listen((f, sock, state) => {
    if (f.tag === TAG.HELLO) sock.write(frame(TAG.HELLO_OK, { ok: true, features }));
    else if (f.tag === TAG.AUTH) sock.write(frame(TAG.AUTH_OK, { ok: true, session_id: 's1' }));
    else if (f.tag === TAG.CLOSE) sock.write(frame(TAG.BYE, {}));
    else if (f.tag === TAG.PING) sock.write(frame(TAG.PONG, null));
    else if (f.tag === TAG.REQUEST) sock.write(frame(TAG.RESPONSE, reply(f.body.request_id, state.requests, f.body)));
  });
}

/** Completes HELLO, then answers every later frame with `after()` (possibly nothing). */
function hostilePeer(after) {
  let greeted = false;
  return listen((f, sock) => {
    if (f.tag === TAG.HELLO && !greeted) {
      greeted = true;
      sock.write(frame(TAG.HELLO_OK, { ok: true, features: 0 }));
    } else {
      const out = after();
      if (out.length) sock.write(out);
    }
  });
}

/** Answers the Nth frame received (HELLO included) with `frames[N]`. */
function sequencePeer(frames) {
  let i = 0;
  return listen((_f, sock) => {
    const out = i < frames.length ? frames[i++] : Buffer.alloc(0);
    if (out.length) sock.write(out);
  });
}

function diagnostics(extra) {
  return { module: null, region_id: 'local', route: '', cache: '', elapsed_ms: 0, warnings: [], ...extra };
}

function okEnvelope(requestId, json) {
  return { request_id: requestId, status: 'ok', data: { Json: json }, diagnostics: diagnostics() };
}

function refusalEnvelope(requestId, message, extraDiagnostics) {
  return {
    request_id: requestId,
    status: 'error',
    data: { Message: message },
    diagnostics: diagnostics(extraDiagnostics),
  };
}

/** Run `fn(peer)` and always close the listener. */
async function withPeer(peerPromise, fn) {
  const peer = await peerPromise;
  try {
    return await fn(peer);
  } finally {
    await peer.close();
  }
}

/** Reject after `ms`: a hang must fail the test, not stall it. */
function deadline(promise, ms, what) {
  let timer;
  const bomb = new Promise((_r, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms (it hung)`)), ms);
  });
  return Promise.race([promise, bomb]).finally(() => clearTimeout(timer));
}

module.exports = {
  TAG, frame, headerOnly, scriptedPeer, hostilePeer, sequencePeer,
  okEnvelope, refusalEnvelope, withPeer, deadline,
};
