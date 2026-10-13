'use strict';

// The operations added for server 0.1.0-rc.3, against a real server. Every
// name this file creates starts with `js_rc3`, and it removes what it created,
// so it can share a server (TRICORE_TEST_HOST) with other suites.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { TriCore, TriCoreError, CacheExpiry, DocBulk, DocFilter } = require('tricoredb');
const { startServer, unavailable } = require('../helpers/server.js');

const NS = 'js_rc3';
// FlushDatabase and PurgeExpired reach a whole database, so they get their own.
const SCRATCH_DB = 'js_rc3_scratch';
const text = (b) => (b === null ? null : b.toString('utf8'));
const texts = (bs) => bs.map(text);
const refused = (p) => p.then(() => assert.fail('the request resolved'), (e) => {
  assert.ok(e instanceof TriCoreError, String(e));
  return e;
});

describe('operations added for 0.1.0-rc.3', { skip: unavailable() || false }, () => {
  let server;
  let db;

  before(async () => {
    server = await startServer({ mode: 'dev' });
    db = await TriCore.connect(server.opts);
    await db.cacheClearNamespace(NS);
  });

  after(async () => {
    if (db) {
      await db.cacheClearNamespace(NS).catch(() => undefined);
      await db.close();
    }
    if (server) await server.stop();
  });

  describe('cache', () => {
    it('multi get and set, conditional writes and atomic read-modify ops', async () => {
      assert.equal(await db.cacheMSet(NS, [['a', 'A'], ['b', Buffer.from([0, 255])]]), 2);
      assert.deepEqual(await db.cacheMGet(NS, ['a', 'absent', 'b', 'a']), [
        Buffer.from('A'), null, Buffer.from([0, 255]), Buffer.from('A'),
      ]);
      assert.match((await refused(db.cacheMSet(NS, [['a', '1'], ['a', '2']]))).message, /appears more than once/);
      assert.equal(await db.cacheGetText(NS, 'a'), 'A', 'a refused batch wrote nothing');

      assert.equal(await db.cacheSetIf(NS, 'a', 'no', 'IfAbsent'), false);
      assert.equal(await db.cacheSetIf(NS, 'fresh-key', 'yes', 'IfAbsent'), true);
      assert.equal(await db.cacheSetIf(NS, 'absent', 'no', 'IfPresent'), false);
      assert.equal(await db.cacheExists(NS, 'absent'), false);
      assert.equal(await db.cacheSetIf(NS, 'a', 'A2', 'IfPresent', CacheExpiry.set(60000)), true);
      assert.ok((await db.cacheTtl(NS, 'a')) > 0);
      assert.equal(await db.cacheSetIf(NS, 'a', 'A3', 'Always', CacheExpiry.keep()), true);
      assert.ok((await db.cacheTtl(NS, 'a')) > 0, 'Keep left the deadline in place');
      assert.equal(await db.cacheSetIf(NS, 'a', 'A4', 'Always'), true);
      assert.equal(await db.cacheTtl(NS, 'a'), null, 'the default clears the deadline');

      assert.equal(await db.cacheAppend(NS, 'log', 'ab'), 2);
      assert.equal(await db.cacheAppend(NS, 'log', 'cd'), 4);
      assert.equal(text(await db.cacheGetSet(NS, 'log', 'new')), 'abcd');
      assert.equal(text(await db.cacheGetEx(NS, 'log', CacheExpiry.set(60000))), 'new');
      assert.ok((await db.cacheTtl(NS, 'log')) > 0);
      assert.equal(text(await db.cacheGetEx(NS, 'log', CacheExpiry.clear())), 'new');
      assert.equal(await db.cacheTtl(NS, 'log'), null);
      assert.equal(text(await db.cacheGetDel(NS, 'log')), 'new');
      assert.equal(await db.cacheGetDel(NS, 'log'), null);

      assert.deepEqual(await db.cacheCompareAndSwap(NS, 'cas', null, 'v1'), { swapped: true, current: null, currentIsBinary: false });
      assert.deepEqual(await db.cacheCompareAndSwap(NS, 'cas', 'wrong', 'v2'), {
        swapped: false, current: Buffer.from('v1'), currentIsBinary: false,
      });
      assert.equal(await db.cacheGetText(NS, 'cas'), 'v1');
      assert.equal((await db.cacheCompareAndSwap(NS, 'b', 'wrong', 'x')).currentIsBinary, true);
      assert.equal((await db.cacheCompareAndSwap(NS, 'cas', 'v1', null)).swapped, true);
      assert.equal(await db.cacheExists(NS, 'cas'), false, 'a null value deletes');

      const far = Date.now() + 3600000;
      assert.deepEqual(await db.cacheExpireAt(NS, 'a', far), { updated: true, deleted: false });
      assert.ok((await db.cacheTtl(NS, 'a')) > 3000000);
      assert.deepEqual(await db.cacheExpireAt(NS, 'absent', far), { updated: false, deleted: false });
      assert.deepEqual(await db.cacheExpireAt(NS, 'a', 1000), { updated: true, deleted: true });
      assert.equal(await db.cacheExists(NS, 'a'), false);
    });

    it('freshness, negative caching and warming', async () => {
      const w = await db.cacheSetFresh(NS, 'f', 'body', 60000);
      assert.equal(w.set, true);
      assert.ok(w.freshUntilMs > Date.now());
      assert.deepEqual(await db.cacheGetFresh(NS, 'f', 'me', 1000), {
        state: 'fresh', value: Buffer.from('body'), refresh: false, lease: false, retryAfterMs: null,
      });
      await db.cacheSetFresh(NS, 'bin', Buffer.from([255, 254, 0]), 60000);
      assert.deepEqual((await db.cacheGetFresh(NS, 'bin', 'me', 1000)).value, Buffer.from([255, 254, 0]));

      await db.cacheSetFresh(NS, 'old', 'stale-body', 0, 60000);
      const first = await db.cacheGetFresh(NS, 'old', 'me', 5000);
      assert.deepEqual([first.state, text(first.value), first.refresh], ['stale', 'stale-body', true]);
      assert.equal((await db.cacheGetFresh(NS, 'old', 'you', 5000)).refresh, false, 'one refresher at a time');

      const miss = await db.cacheGetFresh(NS, 'nothing', 'me', 5000);
      assert.deepEqual([miss.state, miss.value, miss.lease], ['miss', null, true]);
      const waiting = await db.cacheGetFresh(NS, 'nothing', 'you', 5000);
      assert.equal(waiting.lease, false);
      assert.ok(waiting.retryAfterMs > 0);

      await db.cacheSetMissing(NS, 'gone', 60000);
      assert.equal((await db.cacheGetFresh(NS, 'gone', 'me', 1000)).state, 'missing');

      assert.deepEqual(await db.cacheWarm(NS, [['f', 'other'], ['warm', 'w']]), { written: 1, alreadyCached: 1 });
      assert.equal(await db.cacheGetText(NS, 'warm'), 'w');
      assert.equal(text((await db.cacheGetFresh(NS, 'f', 'me', 1000)).value), 'body', 'a live value is left alone');
    });

    it('sorted sets', async () => {
      assert.deepEqual(await db.cacheZAdd(NS, 'z', [
        { member: 'a', score: 1.5 }, { member: 'b', score: 2 }, { member: 'c', score: 3 },
      ]), { added: 3, updated: 0 });
      assert.deepEqual(await db.cacheZAdd(NS, 'z', [{ member: 'a', score: 9 }, { member: 'd', score: 4 }]), { added: 1, updated: 1 });
      assert.equal(await db.cacheZCard(NS, 'z'), 4);
      assert.equal(await db.cacheZScore(NS, 'z', 'a'), 9);
      assert.equal(await db.cacheZScore(NS, 'z', 'nobody'), null);
      assert.equal(await db.cacheZRank(NS, 'z', 'a'), 3);
      assert.equal(await db.cacheZRank(NS, 'z', 'a', { rev: true }), 0);
      assert.equal(await db.cacheZRank(NS, 'z', 'nobody'), null);
      assert.deepEqual(texts(await db.cacheZRange(NS, 'z', 0, -1)), ['b', 'c', 'd', 'a']);
      assert.deepEqual(await db.cacheZRangeWithScores(NS, 'z', 0, 1, { rev: true }), [
        { member: Buffer.from('a'), score: 9 }, { member: Buffer.from('d'), score: 4 },
      ]);
      assert.deepEqual(texts(await db.cacheZRangeByScore(NS, 'z', { value: 2, exclusive: true }, 4)), ['c', 'd']);
      assert.deepEqual(texts(await db.cacheZRangeByScore(NS, 'z', -Infinity, Infinity, { rev: true, limit: [1, 2] })), ['d', 'c']);
      assert.deepEqual(await db.cacheZRangeByScoreWithScores(NS, 'z', 2, 2), [{ member: Buffer.from('b'), score: 2 }]);
      assert.equal(await db.cacheZIncrBy(NS, 'z', 'b', 0.25), 2.25);
      assert.equal(await db.cacheZRem(NS, 'z', ['a', 'nobody']), 1);
      assert.equal(await db.cacheZCard(NS, 'z'), 3);
    });

    it('locks hand out a fencing token that only rises', async () => {
      const mine = await db.cacheLockAcquire(NS, 'lock', 'me', 30000);
      assert.deepEqual([mine.acquired, mine.holder], [true, 'me']);
      assert.ok(mine.token >= 1 && mine.expiresAtMs > Date.now());
      const theirs = await db.cacheLockAcquire(NS, 'lock', 'you', 30000);
      assert.deepEqual([theirs.acquired, theirs.token, theirs.holder], [false, null, 'me']);
      assert.equal((await db.cacheLockAcquire(NS, 'lock', 'me', 30000)).token, mine.token, 'a retried acquire keeps its token');
      const renewed = await db.cacheLockRenew(NS, 'lock', 'me', 30000);
      assert.deepEqual([renewed.renewed, renewed.token], [true, mine.token]);
      assert.deepEqual(await db.cacheLockRenew(NS, 'lock', 'you', 30000), { renewed: false, token: null, expiresAtMs: null });
      assert.equal(await db.cacheLockRelease(NS, 'lock', 'you'), false);
      assert.equal(await db.cacheLockRelease(NS, 'lock', 'me'), true);
      const next = await db.cacheLockAcquire(NS, 'lock', 'you', 30000);
      assert.ok(next.acquired && next.token > mine.token);
      await db.cacheLockRelease(NS, 'lock', 'you');
    });

    it('bitmaps and HyperLogLog', async () => {
      assert.equal(await db.cacheSetBit(NS, 'bm', 7, true), 0);
      assert.equal(await db.cacheSetBit(NS, 'bm', 7, true), 1);
      assert.equal(await db.cacheSetBit(NS, 'bm', 9, true), 0);
      assert.equal(await db.cacheGetBit(NS, 'bm', 7), 1);
      assert.equal(await db.cacheGetBit(NS, 'bm', 8), 0);
      assert.deepEqual(await db.cacheGet(NS, 'bm'), Buffer.from([0x01, 0x40]));
      assert.equal(await db.cacheBitCount(NS, 'bm'), 2);
      assert.equal(await db.cacheBitCount(NS, 'bm', [1, 1]), 1);
      assert.equal(await db.cacheBitPos(NS, 'bm', true), 7);
      assert.equal(await db.cacheBitPos(NS, 'bm', true, [1, 1]), 9);
      await db.cacheSetBit(NS, 'bm2', 0, true);
      assert.equal(await db.cacheBitOp(NS, 'Or', 'bm3', ['bm', 'bm2']), 2);
      assert.deepEqual(await db.cacheGet(NS, 'bm3'), Buffer.from([0x81, 0x40]));
      assert.equal(await db.cacheBitOp(NS, 'And', 'bm4', ['bm', 'bm2']), 2);
      assert.equal(await db.cacheBitCount(NS, 'bm4'), 0);

      assert.equal(await db.cachePfAdd(NS, 'h1', ['a', 'b', 'c']), true);
      assert.equal(await db.cachePfAdd(NS, 'h1', ['a']), false);
      await db.cachePfAdd(NS, 'h2', ['c', 'd']);
      assert.equal(await db.cachePfCount(NS, ['h1']), 3);
      assert.equal(await db.cachePfCount(NS, ['h1', 'h2']), 4);
      await db.cachePfMerge(NS, 'h3', ['h1', 'h2']);
      assert.equal(await db.cachePfCount(NS, ['h3']), 4);
    });

    it('lists, sets and hashes', async () => {
      await db.cacheRPush(NS, 'l1', ['1', '2', '3', '4']);
      assert.equal(text(await db.cacheLMove(NS, 'l1', 'l2', 'Left', 'Right')), '1');
      assert.equal(text(await db.cacheLMove(NS, 'l1', 'l2', 'Right', 'Left')), '4');
      assert.deepEqual(texts(await db.cacheLRange(NS, 'l2', 0, -1)), ['4', '1']);
      assert.equal(await db.cacheLMove(NS, 'empty', 'l2', 'Left', 'Right'), null);
      assert.deepEqual(await db.cacheLTrim(NS, 'l2', 0, 0), { length: 1, removed: 1 });
      assert.deepEqual(texts(await db.cacheLRange(NS, 'l2', 0, -1)), ['4']);

      assert.deepEqual(await db.cacheBLPop(NS, ['empty', 'l1'], 100), { key: 'l1', value: Buffer.from('2') });
      assert.deepEqual(await db.cacheBRPop(NS, ['l1'], 100), { key: 'l1', value: Buffer.from('3') });
      const started = Date.now();
      assert.equal(await db.cacheBLPop(NS, ['empty'], 150), null);
      assert.ok(Date.now() - started >= 100, 'it waited for the timeout');

      await db.cacheSAdd(NS, 's1', ['a', 'b', 'c']);
      await db.cacheSAdd(NS, 's2', ['b', 'c', 'd']);
      assert.deepEqual(texts(await db.cacheSUnion(NS, ['s1', 's2'])), ['a', 'b', 'c', 'd']);
      assert.deepEqual(texts(await db.cacheSInter(NS, ['s1', 's2'])), ['b', 'c']);
      assert.deepEqual(texts(await db.cacheSDiff(NS, ['s1', 's2'])), ['a']);
      assert.deepEqual(await db.cacheSInter(NS, ['s1', 'absent']), []);
      const one = await db.cacheSRandMember(NS, 's1');
      assert.equal(one.length, 1);
      assert.ok(['a', 'b', 'c'].includes(text(one[0])));
      assert.equal((await db.cacheSRandMember(NS, 's1', 10)).length, 3);
      assert.equal((await db.cacheSRandMember(NS, 's1', -7)).length, 7);

      assert.equal(await db.cacheHIncrBy(NS, 'h', 'n', 5), 5);
      assert.equal(await db.cacheHIncrBy(NS, 'h', 'n', -2), 3);
      assert.equal(text(await db.cacheHGet(NS, 'h', 'n')), '3');
    });

    it('pipeline, transaction and scripts', async () => {
      const piped = await db.cachePipeline([
        { Set: { namespace: NS, key: 'p', value: [49], ttl_ms: null } },
        { Get: { namespace: NS, key: 'p' } },
        { LPush: { namespace: NS, key: 'p', values: [[1]] } },
        { Incr: { namespace: NS, key: 'pc', by: 2 } },
        'Ping',
      ]);
      assert.equal(piped.length, 5);
      assert.deepEqual(piped[1], { ok: { CacheValue: [49] } });
      assert.match(piped[2].error, /holds a string/);
      assert.deepEqual(piped[3], { ok: { Json: { value: 2 } } }, 'a failed operation does not stop the rest');

      const tx = await db.cacheTransaction([
        { Incr: { namespace: NS, key: 'pc', by: 3 } },
        { Get: { namespace: NS, key: 'p' } },
      ]);
      assert.deepEqual(tx, [{ ok: { Json: { value: 5 } } }, { ok: { CacheValue: [49] } }]);

      assert.deepEqual(await db.cacheScriptLoad('js_rc3_script', [
        { Set: { namespace: NS, key: '$1', value: [1], ttl_ms: null } },
        { Incr: { namespace: NS, key: '$2', by: 1 } },
      ]), { loaded: 'js_rc3_script', ops: 2 });
      const run = await db.cacheScriptRun('js_rc3_script', ['sk', 'sc']);
      assert.deepEqual(run.results, [{ ok: { Json: { set: true } } }, { ok: { Json: { value: 1 } } }]);
      assert.equal(run.ops[0].Set.key, 'sk');
      assert.equal(await db.cacheExists(NS, 'sk'), true);
      assert.match((await refused(db.cacheScriptRun('js_rc3_script'))).message, /uses \$1 but was given 0/);
      assert.match((await refused(db.cacheScriptRun('js_rc3_no_such_script'))).message, /no cache script/);
    });

    it('publish and poll', async () => {
      const first = await db.cachePublish('js_rc3_chan', 'hello');
      const second = await db.cachePublish('js_rc3_chan', 'again');
      assert.ok(second > first);
      const all = await db.cachePoll(['js_rc3_chan'], { after: first - 1 });
      assert.deepEqual(all.messages.map((m) => [m.id, m.channel, m.message]), [
        [first, 'js_rc3_chan', 'hello'], [second, 'js_rc3_chan', 'again'],
      ]);
      assert.equal(all.next, second);
      const page = await db.cachePoll(['js_rc3_ch*'], { after: first - 1, limit: 1 });
      assert.deepEqual(page.messages.map((m) => m.message), ['hello']);
      assert.deepEqual((await db.cachePoll(['js_rc3_chan'], { after: second })).messages, []);
    });

    it('namespace limits, stats, and whole-database purge and flush', async () => {
      const limited = 'js_rc3_limited';
      assert.deepEqual(await db.cacheSetNamespaceLimit(limited, { maxKeys: 1, maxBytes: 1000 }), {
        namespace: limited, max_keys: 1, max_bytes: 1000, keys: 0, bytes: 0,
      });
      await db.cacheSet(limited, 'one', 'x');
      assert.match((await refused(db.cacheSet(limited, 'two', 'y'))).message, /limit|max/i);
      const held = await db.cacheGetNamespaceLimit(limited);
      assert.deepEqual([held.max_keys, held.keys, held.bytes], [1, 1, 1]);
      const lifted = await db.cacheSetNamespaceLimit(limited);
      assert.deepEqual([lifted.max_keys, lifted.max_bytes], [null, null]);
      await db.cacheSet(limited, 'two', 'y');
      assert.equal(await db.cacheClearNamespace(limited), 2);

      const stats = await db.cacheStats();
      assert.equal(typeof stats.hits, 'number');
      assert.equal(typeof stats.misses, 'number');
      assert.equal(typeof stats.eviction.policy, 'string');

      await db.cacheSet(NS, 'brief', 'x', 1, SCRATCH_DB);
      await db.cacheSet(NS, 'kept', 'x', null, SCRATCH_DB);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(await db.cachePurgeExpired(SCRATCH_DB), 1);
      assert.equal(await db.cacheFlushDatabase(SCRATCH_DB), 1);
      assert.equal(await db.cacheFlushDatabase(SCRATCH_DB), 0);
    });

    it('hot keys answer, or are refused by name where tracking is off', async () => {
      // Whether `[cache] hot_keys` is set is the server's configuration.
      const out = await db.cacheHotKeys({ limit: 3 }).catch((e) => e);
      if (out instanceof Error) {
        assert.ok(out instanceof TriCoreError);
        assert.match(out.message, /hot_keys: tracking is off/);
      } else {
        assert.equal(typeof out, 'object');
      }
    });
  });

  describe('document', () => {
    const C = 'js_rc3_people';

    before(async () => {
      await db.documentDropCollection(C).catch(() => undefined);
      await db.documentDropCollection(`${C}_renamed`).catch(() => undefined);
      await db.documentCreateCollection(C);
    });

    after(async () => {
      db.txn = null;
      await db.documentDropCollection(C).catch(() => undefined);
      await db.documentDropCollection(`${C}_renamed`).catch(() => undefined);
    });

    it('insert many, replace, delete many and explain', async () => {
      const ids = await db.documentInsertMany(C, [
        { _id: 'a', n: 1, city: 'Pune' }, { n: 2, city: 'Oslo' }, { _id: 'c', n: 3, city: 'Oslo' },
      ]);
      assert.equal(ids.length, 3);
      assert.deepEqual([ids[0], ids[2]], ['a', 'c']);
      assert.match((await refused(db.documentInsertMany(C, [{ _id: 'z', n: 1 }, { _id: 'a', n: 2 }]))).message, /duplicate document id/);
      assert.equal(await db.documentGet(C, 'z'), null, 'the batch is atomic');

      assert.deepEqual(await db.documentReplace(C, 'a', { n: 10 }), { replaced: true, inserted: false, id: 'a' });
      assert.deepEqual(await db.documentGet(C, 'a'), { _id: 'a', n: 10 }, 'the city is gone');
      const before_ = await db.documentReplace(C, 'a', { n: 11 }, { return: 'Before' });
      assert.deepEqual(before_.document, { _id: 'a', n: 10 });
      const upserted = await db.documentReplace(C, 'new', { n: 12 }, { upsert: true, return: 'After' });
      assert.deepEqual(upserted, { replaced: true, inserted: true, id: 'new', document: { _id: 'new', n: 12 } });
      assert.match((await refused(db.documentReplace(C, 'ghost', { n: 1 }))).message, /no such document/);

      const scan = await db.documentExplain(C, DocFilter.eq('city', 'Oslo'));
      assert.deepEqual([scan.plan, scan.index_used, scan.rows_returned], ['FindScan', false, 2]);
      await db.documentCreateIndex(C, 'by_city', 'city');
      const indexed = await db.documentExplain(C, DocFilter.eq('city', 'Oslo'), { limit: 1, sort: [{ field: 'n', descending: true }] });
      assert.deepEqual([indexed.plan, indexed.index, indexed.rows_returned], ['FindByIndex', 'by_city', 1]);
      assert.deepEqual(await db.documentRebuildIndex(C, 'by_city'), { rebuilt: 'by_city', documents: 4, entries: 2 });
      assert.deepEqual(await db.documentPurgeExpired(C), { purged: 0, more: false });

      assert.equal(await db.documentDeleteMany(C, DocFilter.eq('city', 'Oslo')), 2);
      assert.deepEqual((await db.documentFind(C)).map((d) => d._id).sort(), ['a', 'new']);
    });

    it('collection options: schema, defaults and versions', async () => {
      assert.deepEqual(await db.documentGetCollectionOptions(C), { versioned: false });
      const options = {
        schema: { required: ['n'], fields: { n: { type: 'integer', minimum: 0 } }, additional_fields: true },
        defaults: { status: 'new' },
        versioned: true,
      };
      const set = await db.documentSetCollectionOptions(C, options);
      assert.equal(set.updated, true);
      assert.deepEqual(await db.documentGetCollectionOptions(C), options);

      assert.match((await refused(db.documentInsert(C, { city: 'x' }, { id: 'bad' }))).message, /`n` is required/);
      await db.documentInsert(C, { n: 5 }, { id: 'v1' });
      assert.deepEqual(await db.documentGet(C, 'v1'), { _id: 'v1', _version: 1, n: 5, status: 'new' });
      const swapped = await db.documentReplace(C, 'v1', { n: 6 }, { expectedVersion: 1, return: 'After' });
      assert.equal(swapped.document._version, 2);
      assert.match((await refused(db.documentReplace(C, 'v1', { n: 7 }, { expectedVersion: 1 }))).message, /version conflict/);
      assert.equal((await db.documentGet(C, 'v1')).n, 6);
    });

    it('bulk write is one atomic batch of tagged items', async () => {
      const out = await db.documentBulkWrite(C, [
        DocBulk.insert({ n: 1 }, { id: 'b1' }),
        DocBulk.insert({ n: 2 }),
        DocBulk.updateOne('b1', { set: { x: 1 }, inc: { n: 4 } }),
        DocBulk.updateOne('b2', { set: { n: 9 } }, { upsert: true }),
        DocBulk.replace('v1', { n: 8 }, { expectedVersion: 2 }),
        DocBulk.delete('new'),
      ]);
      assert.deepEqual([out.inserted, out.updated, out.replaced, out.deleted, out.upserted], [2, 1, 1, 1, 1]);
      assert.equal(out.inserted_ids[0], 'b1');
      const b1 = await db.documentGet(C, 'b1');
      assert.deepEqual([b1.n, b1.x], [5, 1], 'a later item saw the earlier insert');
      assert.equal((await db.documentGet(C, 'v1')).n, 8);
      assert.equal(await db.documentGet(C, 'new'), null);

      const e = await refused(db.documentBulkWrite(C, [DocBulk.insert({ n: 1 }, { id: 'bx' }), DocBulk.insert({ n: 1 }, { id: 'b1' })]));
      assert.match(e.message, /bulk operation 1: duplicate document id/);
      assert.equal(await db.documentGet(C, 'bx'), null, 'nothing was written');
    });

    it('transactions isolate, commit and roll back', async () => {
      const other = await TriCore.connect(server.opts);
      try {
        const txn = await db.documentBeginTransaction();
        assert.equal(db.txn, txn);
        await db.documentInsert(C, { n: 1 }, { id: 'tx1' });
        assert.equal((await db.documentGet(C, 'tx1')).n, 1, 'the transaction sees its own write');
        assert.equal(await other.documentGet(C, 'tx1'), null, 'nobody else does');
        assert.deepEqual(await db.documentCommitTransaction(), { committed: true, writes: 1 });
        assert.equal(db.txn, null);
        assert.equal((await other.documentGet(C, 'tx1')).n, 1);

        await db.documentBeginTransaction({ serializable: true });
        await db.documentInsert(C, { n: 2 }, { id: 'tx2' });
        await db.documentRollbackTransaction();
        assert.equal(db.txn, null);
        assert.equal(await db.documentGet(C, 'tx2'), null);

        // Two transactions change one document: the second commit is refused,
        // and stays open until it is rolled back.
        await db.documentBeginTransaction();
        await other.documentBeginTransaction();
        await db.documentUpdate(C, 'tx1', { n: 10 });
        await other.documentUpdate(C, 'tx1', { n: 20 });
        await db.documentCommitTransaction();
        assert.match((await refused(other.documentCommitTransaction())).message, /conflict/);
        assert.notEqual(other.txn, null);
        await other.documentRollbackTransaction();
        assert.equal((await db.documentGet(C, 'tx1')).n, 10);

        assert.match((await refused(db.documentCommitTransaction())).message, /options\.txn/);
      } finally {
        other.txn = null;
        await other.close();
      }
    });

    it('rename moves the documents and the indexes', async () => {
      const moved = await db.documentRenameCollection(C, `${C}_renamed`);
      assert.deepEqual([moved.renamed, moved.from, moved.to, moved.indexes], [true, C, `${C}_renamed`, 1]);
      assert.ok(moved.documents > 0);
      assert.equal((await db.documentListCollections()).includes(C), false);
      assert.equal((await db.documentGet(`${C}_renamed`, 'tx1')).n, 10);
    });
  });

  describe('vector', () => {
    const C = 'js_rc3_vec';
    const drop = async () => {
      for (const name of [C, `${C}_copy`, `${C}_moved`, `${C}_named`]) await db.vectorDropCollection(name).catch(() => undefined);
      await db.vectorSetAlias('js_rc3_alias', null).catch(() => undefined);
    };

    before(async () => {
      await drop();
      await db.vectorCreateCollection(C, 3);
    });
    after(drop);

    it('batch upsert, count, filters and batch delete', async () => {
      assert.equal(await db.vectorUpsertMany(C, [
        { id: 'a', vector: [1, 0, 0], metadata: { kind: 'x', n: 1 } },
        { id: 'b', vector: [0, 1, 0], metadata: { kind: 'y' } },
        { id: 'c', vector: new Float32Array([0.9, 0.1, 0]) },
      ]), 3);
      assert.match((await refused(db.vectorUpsertMany(C, [{ id: 'q', vector: [1, 0, 0] }, { id: 'q', vector: [0, 1, 0] }]))).message, /more than once/);
      assert.equal(await db.vectorGet(C, 'q'), null);
      assert.equal(await db.vectorCount(C), 3);
      assert.equal(await db.vectorCount(C, { filter: { kind: 'x' } }), 1);

      assert.equal(await db.vectorUpdateByFilter(C, { kind: 'x' }, { flag: true }), 1);
      assert.deepEqual((await db.vectorGet(C, 'a')).metadata, { flag: true, kind: 'x', n: 1 });
      assert.match((await refused(db.vectorDeleteByFilter(C, {}))).message, /non-empty `filter` is required/);
      assert.equal(await db.vectorDeleteByFilter(C, { kind: 'y' }), 1);
      assert.equal(await db.vectorDeleteMany(C, ['c', 'nobody']), 1);
      assert.equal(await db.vectorCount(C), 1);
    });

    it('batch, multi and by-example search', async () => {
      await db.vectorUpsertMany(C, [
        { id: 'b', vector: [0, 1, 0], metadata: { kind: 'y' } },
        { id: 'c', vector: [0.9, 0.1, 0], metadata: { kind: 'x' } },
      ]);
      const batch = await db.vectorSearchBatch(C, [[1, 0, 0], [0, 1, 0]], 2);
      assert.deepEqual(batch.map((hits) => hits.map((h) => h.id)), [['a', 'c'], ['b', 'c']]);
      assert.equal(batch[0][0].metadata.kind, 'x');

      const shaped = await db.vectorSearchBatch(C, [[1, 0, 0]], 5, {
        filter: { kind: 'x' }, minScore: 0.5, includeVectors: true, includeMetadata: false, exact: true, explain: true,
      });
      assert.deepEqual(shaped[0].map((h) => h.id), ['a', 'c']);
      assert.deepEqual(shaped[0][0].vector, [1, 0, 0]);
      assert.equal(shaped[0][0].metadata, undefined);
      assert.equal(typeof shaped[0][0].reason, 'string');
      assert.deepEqual((await db.vectorSearchBatch(C, [[1, 0, 0]], 1, { offset: 1 }))[0].map((h) => h.id), ['c']);

      const fused = await db.vectorSearchMulti(C, [[1, 0, 0], [0, 1, 0]], 3);
      assert.deepEqual([fused.fusion, fused.queries], ['rrf', 2]);
      assert.deepEqual(fused.results.map((r) => r.id).sort(), ['a', 'b', 'c']);
      assert.equal(fused.results[0].matched, 2);
      const best = await db.vectorSearchMulti(C, [[1, 0, 0], [0, 1, 0]], 1, { fusion: 'max', filter: { kind: 'y' } });
      assert.deepEqual([best.fusion, best.results.map((r) => r.id)], ['max', ['b']]);

      const like = await db.vectorSearchByExamples(C, ['a'], 2);
      assert.deepEqual(like.map((h) => h.id), ['c', 'b'], 'the example itself is left out');
      assert.equal(typeof like.index, 'string');
      const withSelf = await db.vectorSearchByExamples(C, ['a'], 1, { excludeExamples: false, includeVectors: true });
      assert.deepEqual([withSelf[0].id, withSelf[0].vector], ['a', [1, 0, 0]]);
      const away = await db.vectorSearchByExamples(C, [[0, 1, 0]], 1, { negative: ['a'] });
      assert.equal(away[0].id, 'b');
    });

    it('embedding and text upsert', async () => {
      const e = await db.vectorEmbed(['hello world', 'bye'], 4);
      assert.deepEqual([e.dimension, e.vectors.length, e.vectors[0].length, e.sparse.length], [4, 2, 4, 2]);
      assert.equal(typeof e.embedder, 'string');
      assert.deepEqual((await db.vectorEmbed(['hello world'], 4)).vectors[0], e.vectors[0], 'the embedder is deterministic');
      assert.equal(await db.vectorUpsertText(C, [{ id: 't1', text: 'red apple', metadata: { kind: 't' } }, { id: 't2', text: 'green pear' }]), 2);
      const t1 = await db.vectorGet(C, 't1');
      assert.deepEqual([t1.metadata.text, t1.metadata.kind, t1.vector.length], ['red apple', 't', 3]);
      assert.equal(await db.vectorDeleteMany(C, ['t1', 't2']), 2);
    });

    it('partitions, aliases, index maintenance and configuration', async () => {
      await db.vectorUpsert(C, 'p1', [0, 0, 1], { _namespace: 'ns1' });
      assert.deepEqual(await db.vectorListPartitions(C), {
        field: '_namespace', partitions: [{ count: 1, name: 'ns1' }], unpartitioned: 3,
      });
      assert.deepEqual((await db.vectorListPartitions(C, { field: '_tenant' })).partitions, []);
      assert.deepEqual((await db.vectorSearchBatch(C, [[0, 0, 1]], 5, { namespace: 'ns1' }))[0].map((h) => h.id), ['p1']);

      await db.vectorSetAlias('js_rc3_alias', C);
      assert.deepEqual((await db.vectorListAliases()).filter((a) => a.alias === 'js_rc3_alias'), [{ alias: 'js_rc3_alias', collection: C }]);
      assert.equal(await db.vectorCount('js_rc3_alias'), 4);
      await db.vectorSetAlias('js_rc3_alias', null);
      assert.deepEqual((await db.vectorListAliases()).filter((a) => a.alias === 'js_rc3_alias'), []);

      const rebuilt = await db.vectorRebuildIndex(C);
      assert.deepEqual([rebuilt.rebuilt, rebuilt.persisted, rebuilt.vectors], [true, true, 4]);
      const stats = await db.vectorIndexStats(C);
      assert.deepEqual([stats.collection, typeof stats.index], [C, 'string']);
      const recall = await db.vectorMeasureRecall(C, { sample: 2, topK: 2 });
      assert.deepEqual([recall.collection, recall.recall], [C, 1]);

      const config = await db.vectorSetCollectionConfig(C, { m: 8, efConstruction: 100 });
      assert.deepEqual([config.m, config.ef_construction, config.normalize], [8, 100, false]);
      assert.match((await refused(db.vectorSetCollectionConfig(C, { normalize: true }))).message, /only change on an empty collection/);

      assert.equal(await db.vectorCopyCollection(C, `${C}_copy`), 4);
      assert.match((await refused(db.vectorCopyCollection(C, `${C}_copy`))).message, /already exists/);
      const moved = await db.vectorRenameCollection(`${C}_copy`, `${C}_moved`);
      assert.deepEqual([moved.renamed, moved.from, moved.to, moved.moved], [true, `${C}_copy`, `${C}_moved`, 4]);
      assert.equal(await db.vectorCount(`${C}_moved`), 4);
      assert.equal((await db.vectorListCollections()).includes(`${C}_copy`), false);
    });

    it('named vectors are written by name and searched with `using`', async () => {
      const N = `${C}_named`;
      await db.vectorCreateCollection(N, 3);
      await db.vectorAddNamedVector(N, 'title', 2, 'dot');
      assert.equal(await db.vectorUpsertNamed(N, 'n1', { default: [1, 0, 0], title: [1, 2] }, { kind: 'named' }), 'n1');
      assert.equal(await db.vectorUpsertNamed(N, 'n2', { default: [0, 1, 0], title: [2, 1] }), 'n2');
      const config = await db.vectorSetCollectionConfig(N, { multiTenant: false });
      assert.deepEqual(config.named, [{ dimension: 2, metric: 'dot', name: 'title' }]);
      const byTitle = await db.vectorSearch(N, [1, 2], 2, { using: 'title' });
      assert.deepEqual(byTitle.map((h) => [h.id, h.score]), [['n1', 5], ['n2', 4]]);
      assert.deepEqual((await db.vectorSearch(N, [1, 0, 0], 1)).map((h) => h.id), ['n1']);
    });
  });

  describe('graph', () => {
    const G = 'js_rc3_graph';
    const drop = async () => {
      for (const name of [G, `${G}_copy`]) await db.graphDrop(name).catch(() => undefined);
    };

    before(async () => {
      await drop();
      await db.graphCreate(G);
    });
    after(async () => {
      db.txn = null;
      await drop();
    });

    it('bulk add, update in place, and bulk remove', async () => {
      assert.deepEqual(await db.graphAddMany(G, {
        nodes: [
          { id: 'a', labels: ['P'], properties: { name: 'A' } }, { id: 'b', labels: ['P'], properties: { name: 'B' } },
          { id: 'c' }, { id: 'd' }, { id: 'tmp' },
        ],
        edges: [
          { id: 'ab', from: 'a', to: 'b', label: 'K', properties: { weight: 2 } },
          { id: 'bc', from: 'b', to: 'c', label: 'K' },
          { id: 'ca', from: 'c', to: 'a', label: 'K' },
          { id: 'ac', from: 'a', to: 'c', label: 'L' },
          { id: 'at', from: 'a', to: 'tmp', label: 'K' },
        ],
      }), { atomic: true, nodes: 5, edges: 5 });
      const e = await refused(db.graphAddMany(G, { nodes: [{ id: 'orphan' }], edges: [{ id: 'zz', from: 'a', to: 'nope', label: 'K' }] }));
      assert.match(e.message, /does not exist in the graph or the batch/);
      assert.equal(await db.graphGetNode(G, 'orphan'), null, 'the batch is atomic');

      assert.deepEqual(await db.graphUpdateNode(G, 'a', { properties: { name: null, city: 'X' }, addLabels: ['R'], removeLabels: ['P'] }), {
        id: 'a', labels: ['R'], properties: { city: 'X' },
      });
      assert.deepEqual(await db.graphUpdateEdge(G, 'ab', { properties: { weight: 3 }, label: 'Z' }), {
        id: 'ab', from: 'a', to: 'b', label: 'Z', properties: { weight: 3 },
      });
      assert.match((await refused(db.graphUpdateNode(G, 'ghost'))).message, /no such node/);

      assert.deepEqual(await db.graphRemoveMany(G, { nodes: ['tmp', 'nobody'], detach: true }), {
        atomic: true, nodes_removed: 1, edges_removed: 1,
      });
      assert.equal(await db.graphGetEdge(G, 'at'), null);
    });

    it('traversals and algorithms', async () => {
      const dfs = await db.graphDfs(G, 'a');
      assert.deepEqual([dfs.order, dfs.start, dfs.nodes.map((n) => n.id).sort()], ['depth_first', 'a', ['a', 'b', 'c']]);
      assert.equal((await db.graphDfs(G, 'a', { direction: 'both', label: 'K', maxDepth: 1, limit: 2 })).count, 2);

      const weak = await db.graphConnectedComponents(G);
      assert.deepEqual([weak.kind, weak.count, weak.largest], ['weak', 2, 3]);
      assert.deepEqual(weak.components[0].nodes, ['a', 'b', 'c']);
      const strong = await db.graphConnectedComponents(G, { kind: 'strong', label: 'K', limit: 1 });
      assert.deepEqual([strong.kind, strong.count, strong.components.length, strong.truncated], ['strong', 4, 1, true]);

      const cycle = await db.graphDetectCycle(G);
      assert.deepEqual([cycle.hasCycle, cycle.cycle.nodes.slice().sort()], [true, ['a', 'b', 'c']]);
      assert.deepEqual(await db.graphDetectCycle(G, { directed: false, label: 'L' }), { hasCycle: false, directed: false, cycle: null });

      const stats = await db.graphStats(G);
      assert.deepEqual([stats.nodes, stats.edges, stats.isolatedNodes, stats.edgeTypes], [4, 4, 1, { K: 2, L: 1, Z: 1 }]);
      const schema = await db.graphSchema(G);
      assert.deepEqual(schema.edge_types.map((t) => t.type), ['K', 'L', 'Z']);
      assert.deepEqual(schema.node_labels.map((l) => l.label), ['P', 'R']);

      const sub = await db.graphSubgraph(G, ['a']);
      assert.deepEqual([sub.node_count, sub.edge_count, sub.direction], [3, 4, 'both']);
      assert.equal((await db.graphSubgraph(G, ['a', 'd'], { direction: 'outgoing', label: 'K', maxDepth: 2, limit: 2 })).node_count, 2);

      const k = await db.graphKShortestPaths(G, 'a', 'c');
      assert.deepEqual(k.paths.map((p) => p.edges), [['ac'], ['ab', 'bc']]);
      assert.equal((await db.graphKShortestPaths(G, 'a', 'c', { k: 1, weightProperty: 'weight' })).count, 1);
      assert.equal((await db.graphKShortestPaths(G, 'a', 'd')).count, 0);
      const all = await db.graphAllPaths(G, 'a', 'c');
      assert.deepEqual([all.complete, all.count], [true, 2]);
      assert.equal((await db.graphAllPaths(G, 'a', 'c', { direction: 'both', label: 'K', maxDepth: 3, limit: 1 })).count, 1);

      const between = await db.graphCentrality(G, 'betweenness');
      assert.deepEqual([between.measure, between.nodes, between.results.length], ['betweenness', 4, 4]);
      assert.equal((await db.graphCentrality(G, 'closeness', { directed: false, limit: 2 })).results.length, 2);
      const eigen = await db.graphCentrality(G, 'eigenvector', { iterations: 50, tolerance: 0.0001 });
      assert.equal(typeof eigen.converged, 'boolean');

      const rank = await db.graphPageRank(G);
      assert.equal(rank.count, 4);
      assert.ok(Math.abs(rank.ranks.reduce((s, r) => s + r.score, 0) - 1) < 1e-6, 'ranks sum to 1');
      const top = await db.graphPageRank(G, { damping: 0.5, iterations: 10, tolerance: 0.001, label: 'K', limit: 2 });
      assert.deepEqual([top.damping, top.ranks.length, top.truncated], [0.5, 2, true]);

      const communities = await db.graphCommunities(G);
      assert.deepEqual([communities.algorithm, communities.count], ['louvain', 2]);
      assert.equal((await db.graphCommunities(G, { iterations: 5, limit: 1 })).communities.length, 1);
      const triangles = await db.graphTriangleCount(G);
      assert.deepEqual([triangles.triangles, triangles.nodes.length], [1, 4]);
      assert.equal((await db.graphTriangleCount(G, { label: 'K', limit: 1 })).nodes.length, 1);
      const similar = await db.graphNodeSimilarity(G, 'a');
      assert.deepEqual([similar.metric, similar.results.map((r) => r.id)], ['jaccard', ['b', 'c']]);
      assert.equal((await db.graphNodeSimilarity(G, 'a', { direction: 'outgoing', label: 'K', metric: 'overlap', limit: 1 })).metric, 'overlap');

      const check = await db.graphCheckConsistency(G);
      assert.deepEqual([check.consistent, check.nodes, check.edges, check.dangling_edges.count], [true, 4, 4, 0]);
    });

    it('schema objects: indexes, constraints and indexed lookup', async () => {
      await db.graphCreateNodeIndex(G, 'by_name', ['name'], { label: 'P' });
      await db.graphCreateNodeIndex(G, 'by_two', ['name', 'age']);
      await db.graphCreateConstraint(G, 'uniq_name', 'P', 'name', 'unique');
      await db.graphCreateConstraint(G, 'req_w', 'Z', 'weight', 'required', { target: 'edge' });
      assert.deepEqual(await db.graphListSchemaObjects(G), {
        indexes: [{ label: 'P', name: 'by_name', properties: ['name'] }, { label: null, name: 'by_two', properties: ['name', 'age'] }],
        constraints: [
          { kind: 'unique', label: 'P', name: 'uniq_name', property: 'name', target: 'node' },
          { kind: 'required', label: 'Z', name: 'req_w', property: 'weight', target: 'edge' },
        ],
      });
      assert.match((await refused(db.graphAddNode(G, 'dupe', { labels: ['P'], properties: { name: 'B' } }))).message, /constraint `uniq_name`/);

      const found = await db.graphFindNodes(G, { label: 'P', properties: { name: 'B' } });
      assert.deepEqual([found.nodes.map((n) => n.id), found.plan], [['b'], 'index `by_name`']);
      const page = await db.graphFindNodes(G, { limit: 1 });
      assert.deepEqual([page.count, page.truncated, page.plan], [1, true, 'scan']);

      await db.graphDropSchemaObject(G, 'by_two');
      assert.deepEqual((await db.graphListSchemaObjects(G)).indexes.map((i) => i.name), ['by_name']);
      assert.match((await refused(db.graphDropSchemaObject(G, 'nope'))).message, /no index or constraint named/);
    });

    it('CSV import, Cypher writes and transactions', async () => {
      assert.deepEqual(await db.graphImportCsv(G, {
        nodes: 'id,labels,name\nx1,P,X1\nx2,P,X2\n',
        edges: 'id,from,to,label\nx12,x1,x2,K\n',
      }), { atomic: true, nodes: 2, edges: 1 });
      assert.deepEqual(await db.graphGetNode(G, 'x1'), { id: 'x1', labels: ['P'], properties: { name: 'X1' } });

      const made = await db.graphExecute(G, "CREATE (n:Q {name: 'made'})");
      assert.deepEqual([made.nodesCreated, made.statements], [1, 1]);
      assert.match((await refused(db.graphExecute(G, 'MATCH (n) RETURN n'))).message, /not a Cypher write/);
      const names = async (label) => (await db.graphQuery(G, `MATCH (n:${label}) RETURN n.name`)).rows.map((r) => r[0]);
      assert.deepEqual(await names('Q'), ['made']);

      const txn = await db.graphBeginTransaction(G);
      assert.equal(db.txn, txn);
      assert.deepEqual(await db.graphExecute(G, "CREATE (n:T {name: 'queued'})"), { queued: 1, transaction: txn });
      assert.deepEqual(await names('T'), [], 'a queued statement has not run');
      const done = await db.graphCommitTransaction(G);
      assert.deepEqual([done.committed, done.nodesCreated], [1, 1]);
      assert.equal(db.txn, null);
      assert.deepEqual(await names('T'), ['queued']);

      await db.graphBeginTransaction(G);
      await db.graphExecute(G, "CREATE (n:U {name: 'dropped'})");
      assert.equal(await db.graphRollbackTransaction(G), 1);
      assert.equal(db.txn, null);
      assert.deepEqual(await names('U'), []);
      assert.match((await refused(db.graphCommitTransaction(G))).message, /`txn` option/);
    });

    it('copy takes the nodes, the edges and the schema', async () => {
      const copy = await db.graphCopy(G, `${G}_copy`);
      assert.deepEqual([copy.copied, copy.to], [true, `${G}_copy`]);
      const [a, b] = [await db.graphStats(G), await db.graphStats(`${G}_copy`)];
      assert.deepEqual([b.nodes, b.edges], [a.nodes, a.edges]);
      assert.deepEqual((await db.graphListSchemaObjects(`${G}_copy`)).indexes.map((i) => i.name), ['by_name']);
      assert.match((await refused(db.graphCopy(G, `${G}_copy`))).message, /already exists/);
    });
  });
});
