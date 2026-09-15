'use strict';

// A request for a data model the server has switched off. The driver cannot fix
// that, so the error must say plainly that it is a server setting and how the
// operator changes it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { TriCore, TriCoreError, ENGINE_DISABLED } = require('tricoredb');
const { scriptedPeer, withPeer, refusalEnvelope } = require('../helpers/peer.js');

// The server's own wording for a switched-off module (tricore_core pipeline route stage).
const serverSays = (module) =>
  `module \`${module}\` is not enabled (switched off or not configured — turn it on in Studio → Engines or \`[modules]\`)`;

describe('engine.disabled refusals', () => {
  it('name the module, keep the code, and tell the operator how to enable it', async () => {
    await withPeer(
      scriptedPeer((rid) => refusalEnvelope(rid, serverSays('vector'), { error_code: ENGINE_DISABLED })),
      async (peer) => {
        const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
        const e = await db.vectorListCollections().then(
          () => assert.fail('the request resolved'),
          (err) => err,
        );
        assert.ok(e instanceof TriCoreError);
        assert.equal(e.code, 'engine.disabled');
        assert.equal(e.code, ENGINE_DISABLED);
        assert.equal(e.isRedirect, false);
        assert.ok(e.message.includes(serverSays('vector')), 'the server message is kept verbatim');
        assert.match(e.message, /`vector` module is switched off on the server/);
        assert.match(e.message, /add `vector` to TRICORE_MODULES/);
        assert.match(e.message, /TRICORE_MODULES=sql,document,cache,vector/);
        assert.match(e.message, /TRICORE_MODULES=all/);
        assert.match(e.message, /\[modules\] vector = true/);
        assert.equal(peer.state.requests, 1, 'nothing was retried');
        await db.close();
      },
    );
  });

  it('still explains the fix when the server message names no module', async () => {
    await withPeer(
      scriptedPeer((rid) => refusalEnvelope(rid, 'engine disabled', { error_code: ENGINE_DISABLED })),
      async (peer) => {
        const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
        const e = await db.graphListGraphs().catch((err) => err);
        assert.equal(e.code, ENGINE_DISABLED);
        assert.match(e.message, /TRICORE_MODULES=all/);
        assert.match(e.message, /\[modules\] <module> = true/);
        await db.close();
      },
    );
  });

  it('other refusals get no module hint', async () => {
    await withPeer(
      scriptedPeer((rid) => refusalEnvelope(rid, 'table `t` does not exist', { error_code: 'request.invalid' })),
      async (peer) => {
        const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
        const e = await db.execute('SELECT * FROM t').catch((err) => err);
        assert.equal(e.code, 'request.invalid');
        assert.doesNotMatch(e.message, /TRICORE_MODULES/);
        await db.close();
      },
    );
  });
});
