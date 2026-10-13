'use strict';

// The operations added for server 0.1.0-rc.3: for each typed method, the exact
// `op` it puts on the wire, and what it makes of the server's answer. The
// answers are the shapes a live 0.1.0-rc.3 server returned.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { TriCore, TriCoreError, CacheExpiry, DocBulk, DocFilter } = require('tricoredb');
const { scriptedPeer, refusalEnvelope } = require('../helpers/peer.js');

const B = (s) => Array.from(Buffer.from(s, 'utf8'));
const buf = (s) => Buffer.from(s, 'utf8');

// [name, call, op the method must send, reply data (default {Json:{}}), expected result (optional)]
const CACHE = [
  ['cacheSetFresh', (db) => db.cacheSetFresh('n', 'k', 'v', 500, 9000),
    { Cache: { SetFresh: { namespace: 'n', key: 'k', value: B('v'), fresh_ms: 500, ttl_ms: 9000 } } },
    { Json: { set: true, freshUntilMs: 17 } }, { set: true, freshUntilMs: 17 }],
  ['cacheSetFresh without a TTL', (db) => db.cacheSetFresh('n', 'k', 'v', 500),
    { Cache: { SetFresh: { namespace: 'n', key: 'k', value: B('v'), fresh_ms: 500, ttl_ms: null } } }],
  ['cacheGetFresh (fresh text)', (db) => db.cacheGetFresh('n', 'k', 'me', 1000),
    { Cache: { GetFresh: { namespace: 'n', key: 'k', owner: 'me', lease_ms: 1000 } } },
    { Json: { state: 'fresh', value: 'v' } },
    { state: 'fresh', value: buf('v'), refresh: false, lease: false, retryAfterMs: null }],
  ['cacheGetFresh (stale binary)', (db) => db.cacheGetFresh('n', 'k', 'me', 1000),
    { Cache: { GetFresh: { namespace: 'n', key: 'k', owner: 'me', lease_ms: 1000 } } },
    { Json: { state: 'stale', valueHex: 'fffe0041', refresh: true } },
    { state: 'stale', value: Buffer.from([255, 254, 0, 65]), refresh: true, lease: false, retryAfterMs: null }],
  ['cacheGetFresh (miss, lease held elsewhere)', (db) => db.cacheGetFresh('n', 'k', 'me', 1000),
    { Cache: { GetFresh: { namespace: 'n', key: 'k', owner: 'me', lease_ms: 1000 } } },
    { Json: { state: 'miss', lease: false, retryAfterMs: 988 } },
    { state: 'miss', value: null, refresh: false, lease: false, retryAfterMs: 988 }],
  ['cacheSetMissing', (db) => db.cacheSetMissing('n', 'k', 60000),
    { Cache: { SetMissing: { namespace: 'n', key: 'k', ttl_ms: 60000 } } }, { Json: { set: true } }, undefined],
  ['cacheWarm', (db) => db.cacheWarm('n', [['a', 'x'], ['b', Buffer.from([1])]], 5000),
    { Cache: { Warm: { namespace: 'n', entries: [{ key: 'a', value: B('x') }, { key: 'b', value: [1] }], ttl_ms: 5000 } } },
    { Json: { written: 1, alreadyCached: 1 } }, { written: 1, alreadyCached: 1 }],
  ['cacheMGet', (db) => db.cacheMGet('n', ['a', 'zz', 'a']),
    { Cache: { MGet: { namespace: 'n', keys: ['a', 'zz', 'a'] } } },
    { CacheValues: [[97], null, [97]] }, [buf('a'), null, buf('a')]],
  ['cacheMSet', (db) => db.cacheMSet('n', [['a', 'x'], ['b', 'y']]),
    { Cache: { MSet: { namespace: 'n', entries: [{ key: 'a', value: B('x') }, { key: 'b', value: B('y') }], ttl_ms: null } } },
    { Json: { set: 2 } }, 2],
  ['cacheSetIf (defaults to clearing the expiry)', (db) => db.cacheSetIf('n', 'k', 'v', 'IfAbsent'),
    { Cache: { SetIf: { namespace: 'n', key: 'k', value: B('v'), condition: 'IfAbsent', expiry: 'Clear' } } },
    { Json: { set: false } }, false],
  ['cacheSetIf with a TTL', (db) => db.cacheSetIf('n', 'k', 'v', 'IfPresent', CacheExpiry.set(50)),
    { Cache: { SetIf: { namespace: 'n', key: 'k', value: B('v'), condition: 'IfPresent', expiry: { Set: { ttl_ms: 50 } } } } },
    { Json: { set: true } }, true],
  ['cacheSetIf keeping the TTL', (db) => db.cacheSetIf('n', 'k', 'v', 'Always', CacheExpiry.keep()),
    { Cache: { SetIf: { namespace: 'n', key: 'k', value: B('v'), condition: 'Always', expiry: 'Keep' } } }],
  ['cacheZAdd', (db) => db.cacheZAdd('n', 'z', [{ member: 'a', score: 1.5 }, { member: Buffer.from([9]), score: -2 }]),
    { Cache: { ZAdd: { namespace: 'n', key: 'z', members: [{ score: 1.5, member: B('a') }, { score: -2, member: [9] }] } } },
    { Json: { added: 2, updated: 0 } }, { added: 2, updated: 0 }],
  ['cacheZRem', (db) => db.cacheZRem('n', 'z', ['a', 'b']),
    { Cache: { ZRem: { namespace: 'n', key: 'z', members: [B('a'), B('b')] } } }, { Json: { removed: 1 } }, 1],
  ['cacheZScore', (db) => db.cacheZScore('n', 'z', 'a'),
    { Cache: { ZScore: { namespace: 'n', key: 'z', member: B('a') } } }, { Json: { score: 9.0 } }, 9],
  ['cacheZScore of an absent member', (db) => db.cacheZScore('n', 'z', 'a'),
    { Cache: { ZScore: { namespace: 'n', key: 'z', member: B('a') } } }, { Json: { score: null } }, null],
  ['cacheZCard', (db) => db.cacheZCard('n', 'z'),
    { Cache: { ZCard: { namespace: 'n', key: 'z' } } }, { Json: { cardinality: 4 } }, 4],
  ['cacheZRank', (db) => db.cacheZRank('n', 'z', 'a'),
    { Cache: { ZRank: { namespace: 'n', key: 'z', member: B('a'), rev: false } } }, { Json: { rank: 0 } }, 0],
  ['cacheZRank from the high end', (db) => db.cacheZRank('n', 'z', 'a', { rev: true }),
    { Cache: { ZRank: { namespace: 'n', key: 'z', member: B('a'), rev: true } } }, { Json: { rank: null } }, null],
  ['cacheZRange', (db) => db.cacheZRange('n', 'z', 0, -1),
    { Cache: { ZRange: { namespace: 'n', key: 'z', start: 0, stop: -1, rev: false, with_scores: false } } },
    { Json: { count: 2, members: [[98], [97]] } }, [buf('b'), buf('a')]],
  ['cacheZRangeWithScores', (db) => db.cacheZRangeWithScores('n', 'z', 0, 1, { rev: true }),
    { Cache: { ZRange: { namespace: 'n', key: 'z', start: 0, stop: 1, rev: true, with_scores: true } } },
    { Json: { count: 1, members: [{ member: [97], score: 9.0 }] } }, [{ member: buf('a'), score: 9 }]],
  ['cacheZRangeByScore', (db) => db.cacheZRangeByScore('n', 'z', 2, { value: 100, exclusive: true }),
    { Cache: { ZRangeByScore: { namespace: 'n', key: 'z', min: { value: 2, exclusive: false }, max: { value: 100, exclusive: true }, rev: false, with_scores: false, limit: null } } },
    { Json: { count: 1, members: [[97]] } }, [buf('a')]],
  ['cacheZRangeByScore with open ends', (db) => db.cacheZRangeByScore('n', 'z', -Infinity, Infinity, { rev: true, limit: [0, 2] }),
    { Cache: { ZRangeByScore: { namespace: 'n', key: 'z', min: { value: -Number.MAX_VALUE, exclusive: false }, max: { value: Number.MAX_VALUE, exclusive: false }, rev: true, with_scores: false, limit: [0, 2] } } }],
  ['cacheZRangeByScoreWithScores', (db) => db.cacheZRangeByScoreWithScores('n', 'z', 0, 5),
    { Cache: { ZRangeByScore: { namespace: 'n', key: 'z', min: { value: 0, exclusive: false }, max: { value: 5, exclusive: false }, rev: false, with_scores: true, limit: null } } },
    { Json: { count: 1, members: [{ member: [99], score: 3.0 }] } }, [{ member: buf('c'), score: 3 }]],
  ['cacheZIncrBy', (db) => db.cacheZIncrBy('n', 'z', 'a', 0.25),
    { Cache: { ZIncrBy: { namespace: 'n', key: 'z', member: B('a'), by: 0.25 } } }, { Json: { score: 2.25 } }, 2.25],
  ['cacheLockAcquire', (db) => db.cacheLockAcquire('n', 'lk', 'me', 30000),
    { Cache: { LockAcquire: { namespace: 'n', key: 'lk', owner: 'me', ttl_ms: 30000 } } },
    { Json: { acquired: true, expiresAtMs: 5, holder: 'me', token: 1 } },
    { acquired: true, token: 1, holder: 'me', expiresAtMs: 5 }],
  ['cacheLockAcquire refused', (db) => db.cacheLockAcquire('n', 'lk', 'you', 30000),
    { Cache: { LockAcquire: { namespace: 'n', key: 'lk', owner: 'you', ttl_ms: 30000 } } },
    { Json: { acquired: false, expiresAtMs: 5, holder: 'me', token: null } },
    { acquired: false, token: null, holder: 'me', expiresAtMs: 5 }],
  ['cacheLockRenew', (db) => db.cacheLockRenew('n', 'lk', 'you', 30000),
    { Cache: { LockRenew: { namespace: 'n', key: 'lk', owner: 'you', ttl_ms: 30000 } } },
    { Json: { expiresAtMs: null, renewed: false, token: null } }, { renewed: false, token: null, expiresAtMs: null }],
  ['cacheLockRelease', (db) => db.cacheLockRelease('n', 'lk', 'me'),
    { Cache: { LockRelease: { namespace: 'n', key: 'lk', owner: 'me' } } }, { Json: { released: true } }, true],
  ['cacheSetBit', (db) => db.cacheSetBit('n', 'bm', 7, true),
    { Cache: { SetBit: { namespace: 'n', key: 'bm', offset: 7, value: true } } }, { Json: { previous: 0 } }, 0],
  ['cacheGetBit', (db) => db.cacheGetBit('n', 'bm', 7),
    { Cache: { GetBit: { namespace: 'n', key: 'bm', offset: 7 } } }, { Json: { bit: 1 } }, 1],
  ['cacheBitCount', (db) => db.cacheBitCount('n', 'bm'),
    { Cache: { BitCount: { namespace: 'n', key: 'bm', range: null } } }, { Json: { count: 3 } }, 3],
  ['cacheBitCount in a byte range', (db) => db.cacheBitCount('n', 'bm', [0, -1]),
    { Cache: { BitCount: { namespace: 'n', key: 'bm', range: [0, -1] } } }],
  ['cacheBitPos', (db) => db.cacheBitPos('n', 'bm', true, [1, 2]),
    { Cache: { BitPos: { namespace: 'n', key: 'bm', bit: true, range: [1, 2] } } }, { Json: { position: -1 } }, -1],
  ['cacheBitOp', (db) => db.cacheBitOp('n', 'Or', 'dst', ['a', 'b']),
    { Cache: { BitOp: { namespace: 'n', op: 'Or', dest: 'dst', keys: ['a', 'b'] } } }, { Json: { length: 1 } }, 1],
  ['cachePfAdd', (db) => db.cachePfAdd('n', 'h', ['a', 'b']),
    { Cache: { PfAdd: { namespace: 'n', key: 'h', elements: [B('a'), B('b')] } } }, { Json: { changed: true } }, true],
  ['cachePfCount', (db) => db.cachePfCount('n', ['h1', 'h2']),
    { Cache: { PfCount: { namespace: 'n', keys: ['h1', 'h2'] } } }, { Json: { count: 4 } }, 4],
  ['cachePfMerge', (db) => db.cachePfMerge('n', 'h3', ['h1', 'h2']),
    { Cache: { PfMerge: { namespace: 'n', dest: 'h3', sources: ['h1', 'h2'] } } }, { Json: { merged: true } }, undefined],
  ['cacheLMove', (db) => db.cacheLMove('n', 'l1', 'l2', 'Left', 'Right'),
    { Cache: { LMove: { namespace: 'n', source: 'l1', destination: 'l2', from: 'Left', to: 'Right' } } },
    { CacheValue: [1] }, Buffer.from([1])],
  ['cacheExpireAt', (db) => db.cacheExpireAt('n', 'k', 4102444800000),
    { Cache: { ExpireAt: { namespace: 'n', key: 'k', at_ms: 4102444800000 } } },
    { Json: { deleted: false, updated: true } }, { updated: true, deleted: false }],
  ['cacheStats', (db) => db.cacheStats(), { Cache: 'Stats' },
    { Json: { hits: 10, misses: 3, hitRatio: 0.76, memory: { enabled: true }, eviction: { policy: 'lru', evicted: 0 } } },
    { hits: 10, misses: 3, hitRatio: 0.76, memory: { enabled: true }, eviction: { policy: 'lru', evicted: 0 } }],
  ['cacheFlushDatabase', (db) => db.cacheFlushDatabase('scratch'), { Cache: 'FlushDatabase' }, { Json: { cleared: 7 } }, 7, 'scratch'],
  ['cacheAppend', (db) => db.cacheAppend('n', 'k', 'hi'),
    { Cache: { Append: { namespace: 'n', key: 'k', value: B('hi') } } }, { Json: { length: 2 } }, 2],
  ['cacheCompareAndSwap', (db) => db.cacheCompareAndSwap('n', 'k', 'old', 'new', 5000),
    { Cache: { CompareAndSwap: { namespace: 'n', key: 'k', expected: B('old'), value: B('new'), ttl_ms: 5000 } } },
    { Json: { swapped: false, current: 'v' } }, { swapped: false, current: buf('v'), currentIsBinary: false }],
  ['cacheCompareAndSwap from absent, and to deleted', (db) => db.cacheCompareAndSwap('n', 'k', null, null),
    { Cache: { CompareAndSwap: { namespace: 'n', key: 'k', expected: null, value: null, ttl_ms: null } } },
    { Json: { swapped: false, currentIsBinary: true } }, { swapped: false, current: null, currentIsBinary: true }],
  ['cacheGetDel', (db) => db.cacheGetDel('n', 'k'),
    { Cache: { GetDel: { namespace: 'n', key: 'k' } } }, { CacheValue: null }, null],
  ['cacheGetSet', (db) => db.cacheGetSet('n', 'k', 'v', 9000),
    { Cache: { GetSet: { namespace: 'n', key: 'k', value: B('v'), ttl_ms: 9000 } } }, { CacheValue: [49] }, buf('1')],
  ['cacheGetEx', (db) => db.cacheGetEx('n', 'k', CacheExpiry.clear()),
    { Cache: { GetEx: { namespace: 'n', key: 'k', expiry: 'Clear' } } }, { CacheValue: [50] }, buf('2')],
  ['cacheLTrim', (db) => db.cacheLTrim('n', 'l', 0, 1),
    { Cache: { LTrim: { namespace: 'n', key: 'l', start: 0, stop: 1 } } },
    { Json: { length: 2, removed: 1 } }, { length: 2, removed: 1 }],
  ['cacheSUnion', (db) => db.cacheSUnion('n', ['s1', 's2']),
    { Cache: { SUnion: { namespace: 'n', keys: ['s1', 's2'] } } }, { Json: { count: 2, members: [[1], [2]] } },
    [Buffer.from([1]), Buffer.from([2])]],
  ['cacheSInter', (db) => db.cacheSInter('n', ['s1', 's2']),
    { Cache: { SInter: { namespace: 'n', keys: ['s1', 's2'] } } }, { Json: { count: 0, members: [] } }, []],
  ['cacheSDiff', (db) => db.cacheSDiff('n', ['s1', 's2']),
    { Cache: { SDiff: { namespace: 'n', keys: ['s1', 's2'] } } }, { Json: { count: 1, members: [[1]] } }, [Buffer.from([1])]],
  ['cacheSRandMember', (db) => db.cacheSRandMember('n', 's'),
    { Cache: { SRandMember: { namespace: 'n', key: 's', count: null } } }, { Json: { count: 1, members: [[1]] } },
    [Buffer.from([1])]],
  ['cacheSRandMember with replacement', (db) => db.cacheSRandMember('n', 's', -5),
    { Cache: { SRandMember: { namespace: 'n', key: 's', count: -5 } } }],
  ['cacheHIncrBy', (db) => db.cacheHIncrBy('n', 'h', 'f', 5),
    { Cache: { HIncrBy: { namespace: 'n', key: 'h', field: B('f'), by: 5 } } }, { Json: { value: 5 } }, 5],
  ['cacheHIncrBy by one', (db) => db.cacheHIncrBy('n', 'h', 'f'),
    { Cache: { HIncrBy: { namespace: 'n', key: 'h', field: B('f'), by: 1 } } }],
  ['cachePipeline', (db) => db.cachePipeline([{ Get: { namespace: 'n', key: 'k' } }, 'Ping']),
    { Cache: { Pipeline: { ops: [{ Get: { namespace: 'n', key: 'k' } }, 'Ping'] } } },
    { Json: { results: [{ ok: { CacheValue: [1] } }, { error: 'boom' }] } }, [{ ok: { CacheValue: [1] } }, { error: 'boom' }]],
  ['cacheTransaction', (db) => db.cacheTransaction([{ Incr: { namespace: 'n', key: 'c', by: 2 } }]),
    { Cache: { Transaction: { ops: [{ Incr: { namespace: 'n', key: 'c', by: 2 } }] } } },
    { Json: { results: [{ ok: { Json: { value: 2 } } }] } }, [{ ok: { Json: { value: 2 } } }]],
  ['cacheScriptLoad', (db) => db.cacheScriptLoad('s', [{ Incr: { namespace: 'n', key: '$1', by: 1 } }]),
    { Cache: { ScriptLoad: { name: 's', ops: [{ Incr: { namespace: 'n', key: '$1', by: 1 } }] } } },
    { Json: { loaded: 's', ops: 1 } }, { loaded: 's', ops: 1 }],
  ['cacheScriptRun', (db) => db.cacheScriptRun('s', ['a', 'b']),
    { Cache: { ScriptRun: { name: 's', args: ['a', 'b'] } } },
    { Json: { ops: [{ Incr: { by: 1, key: 'a', namespace: 'n' } }], results: [{ ok: { Json: { value: 1 } } }] } },
    { results: [{ ok: { Json: { value: 1 } } }], ops: [{ Incr: { by: 1, key: 'a', namespace: 'n' } }] }],
  ['cacheScriptRun without arguments', (db) => db.cacheScriptRun('s'), { Cache: { ScriptRun: { name: 's', args: [] } } }],
  ['cacheHotKeys', (db) => db.cacheHotKeys({ limit: 3 }), { Cache: { HotKeys: { limit: 3 } } }],
  ['cacheHotKeys without a limit', (db) => db.cacheHotKeys(), { Cache: { HotKeys: {} } }],
  ['cachePurgeExpired', (db) => db.cachePurgeExpired(), { Cache: 'PurgeExpired' }, { Json: { purged: 4 } }, 4],
  ['cacheBLPop', (db) => db.cacheBLPop('n', ['l1', 'l2'], 100),
    { Cache: { BLPop: { namespace: 'n', keys: ['l1', 'l2'], timeout_ms: 100 } } },
    { CacheValues: [[108, 49], [2]] }, { key: 'l1', value: Buffer.from([2]) }],
  ['cacheBRPop that waited in vain', (db) => db.cacheBRPop('n', ['l1'], 100),
    { Cache: { BRPop: { namespace: 'n', keys: ['l1'], timeout_ms: 100 } } }, { CacheValues: [null, null] }, null],
  ['cacheSetNamespaceLimit', (db) => db.cacheSetNamespaceLimit('n', { maxKeys: 2, maxBytes: 1000 }),
    { Cache: { SetNamespaceLimit: { namespace: 'n', max_keys: 2, max_bytes: 1000 } } },
    { Json: { bytes: 0, keys: 0, max_bytes: 1000, max_keys: 2, namespace: 'n' } },
    { bytes: 0, keys: 0, max_bytes: 1000, max_keys: 2, namespace: 'n' }],
  ['cacheSetNamespaceLimit removing the limit', (db) => db.cacheSetNamespaceLimit('n'),
    { Cache: { SetNamespaceLimit: { namespace: 'n' } } }],
  ['cacheGetNamespaceLimit', (db) => db.cacheGetNamespaceLimit('n'), { Cache: { GetNamespaceLimit: { namespace: 'n' } } }],
  ['cachePublish', (db) => db.cachePublish('ch', 'hello'),
    { Cache: { Publish: { channel: 'ch', message: 'hello' } } }, { Json: { channel: 'ch', id: 3 } }, 3],
  ['cachePoll', (db) => db.cachePoll(['ch', 'x*']), { Cache: { Poll: { channels: ['ch', 'x*'] } } },
    { Json: { messages: [{ at_ms: 1, channel: 'ch', id: 3, message: 'hello' }], next: 3 } },
    { messages: [{ at_ms: 1, channel: 'ch', id: 3, message: 'hello' }], next: 3 }],
  ['cachePoll from an id', (db) => db.cachePoll(['ch'], { after: 3, limit: 10 }),
    { Cache: { Poll: { channels: ['ch'], after: 3, limit: 10 } } }],
];

const DOCUMENT = [
  ['documentReplace', (db) => db.documentReplace('c', 'a', { n: 1 }),
    { Document: { Replace: { collection: 'c', id: 'a', document: { n: 1 }, upsert: false } } },
    { Json: { id: 'a', inserted: false, replaced: true } }, { replaced: true, inserted: false, id: 'a' }],
  ['documentReplace with every option', (db) => db.documentReplace('c', 'a', { n: 1 }, { upsert: true, return: 'After', expectedVersion: 2 }),
    { Document: { Replace: { collection: 'c', id: 'a', document: { n: 1 }, upsert: true, return: 'After', expected_version: 2 } } },
    { Json: { document: { _id: 'a', n: 1 }, id: 'a', inserted: true, replaced: true } },
    { replaced: true, inserted: true, id: 'a', document: { _id: 'a', n: 1 } }],
  ['documentInsertMany', (db) => db.documentInsertMany('c', [{ _id: 'a', n: 1 }, { n: 2 }]),
    { Document: { InsertMany: { collection: 'c', documents: [{ _id: 'a', n: 1 }, { n: 2 }] } } },
    { Json: { ids: ['a', '86789d'], inserted: 2 } }, ['a', '86789d']],
  ['documentDeleteMany', (db) => db.documentDeleteMany('c', DocFilter.eq('city', 'Oslo')),
    { Document: { DeleteMany: { collection: 'c', filter: { Eq: { field: 'city', value: 'Oslo' } } } } },
    { Json: { deleted: 2 } }, 2],
  ['documentRenameCollection', (db) => db.documentRenameCollection('c', 'd'),
    { Document: { RenameCollection: { collection: 'c', to: 'd' } } },
    { Json: { documents: 9, from: 'c', indexes: 1, renamed: true, to: 'd' } },
    { documents: 9, from: 'c', indexes: 1, renamed: true, to: 'd' }],
  ['documentPurgeExpired', (db) => db.documentPurgeExpired('c'),
    { Document: { PurgeExpired: { collection: 'c' } } }, { Json: { more: false, purged: 0 } }, { purged: 0, more: false }],
  ['documentExplain', (db) => db.documentExplain('c'), { Document: { Explain: { collection: 'c', filter: 'All' } } },
    { Json: { plan: 'FindScan', index_used: false } }, { plan: 'FindScan', index_used: false }],
  ['documentExplain with every option', (db) => db.documentExplain('c', DocFilter.eq('a', 1), { limit: 1, sort: [{ field: 'n', descending: true }], skip: 2 }),
    { Document: { Explain: { collection: 'c', filter: { Eq: { field: 'a', value: 1 } }, limit: 1, sort: [{ field: 'n', descending: true }], skip: 2 } } }],
  ['documentRebuildIndex', (db) => db.documentRebuildIndex('c', 'by_city'),
    { Document: { RebuildIndex: { collection: 'c', index_name: 'by_city' } } },
    { Json: { documents: 5, entries: 2, rebuilt: 'by_city' } }, { documents: 5, entries: 2, rebuilt: 'by_city' }],
  ['documentSetCollectionOptions', (db) => db.documentSetCollectionOptions('c', {
    schema: { required: ['n'], fields: { n: { type: 'integer', minimum: 0 } }, additional_fields: true },
    defaults: { status: 'new' },
    versioned: true,
  }),
    { Document: { SetCollectionOptions: { collection: 'c', options: {
      schema: { required: ['n'], fields: { n: { type: 'integer', minimum: 0 } }, additional_fields: true },
      defaults: { status: 'new' },
      versioned: true,
    } } } },
    { Json: { documents_checked: 5, updated: true } }, { documents_checked: 5, updated: true }],
  ['documentGetCollectionOptions', (db) => db.documentGetCollectionOptions('c'),
    { Document: { GetCollectionOptions: { collection: 'c' } } },
    { Json: { collection: 'c', options: { versioned: false } } }, { versioned: false }],
  ['documentBulkWrite', (db) => db.documentBulkWrite('c', [
    DocBulk.insert({ n: 1 }, { id: 'b1' }),
    DocBulk.insert({ n: 2 }),
    DocBulk.updateOne('b1', { set: { x: 1 }, inc: { n: 4 } }),
    DocBulk.updateOne('b2', { set: { n: 9 } }, { upsert: true, expectedVersion: 0 }),
    DocBulk.replace('v1', { n: 8 }, { expectedVersion: 2 }),
    DocBulk.replace('b3', { n: 8 }, { upsert: true }),
    DocBulk.delete('c'),
    DocBulk.delete('d', { expectedVersion: 3 }),
  ]),
    { Document: { BulkWrite: { collection: 'c', ops: [
      { Insert: { id: 'b1', document: { n: 1 } } },
      { Insert: { id: null, document: { n: 2 } } },
      { UpdateOne: { id: 'b1', update: { set: { x: 1 }, inc: { n: 4 } }, upsert: false, expected_version: null } },
      { UpdateOne: { id: 'b2', update: { set: { n: 9 }, inc: {} }, upsert: true, expected_version: 0 } },
      { Replace: { id: 'v1', document: { n: 8 }, upsert: false, expected_version: 2 } },
      { Replace: { id: 'b3', document: { n: 8 }, upsert: true, expected_version: null } },
      { Delete: { id: 'c', expected_version: null } },
      { Delete: { id: 'd', expected_version: 3 } },
    ] } } },
    { Json: { deleted: 1, inserted: 2, inserted_ids: ['b1', '9109'], replaced: 1, updated: 1, upserted: 2 } },
    { deleted: 1, inserted: 2, inserted_ids: ['b1', '9109'], replaced: 1, updated: 1, upserted: 2 }],
];

const VECTOR = [
  ['vectorEmbed', (db) => db.vectorEmbed(['hello world', 'bye'], 4),
    { Vector: { Embed: { texts: ['hello world', 'bye'], dimension: 4 } } },
    { Json: { dimension: 4, embedder: 'hash-v1', sparse: [], vectors: [[0.5, 0.5, 0, -0.5]] } },
    { dimension: 4, embedder: 'hash-v1', sparse: [], vectors: [[0.5, 0.5, 0, -0.5]] }],
  ['vectorUpsertText', (db) => db.vectorUpsertText('c', [{ id: 't1', text: 'red apple', metadata: { kind: 't' } }, { id: 't2', text: 'pear' }]),
    { Vector: { UpsertText: { collection: 'c', items: [{ id: 't1', text: 'red apple', metadata: { kind: 't' } }, { id: 't2', text: 'pear', metadata: null }] } } },
    { Json: { embedder: 'hash-v1', upserted: 2 } }, 2],
  ['vectorSetAlias', (db) => db.vectorSetAlias('al', 'c'),
    { Vector: { SetAlias: { alias: 'al', collection: 'c' } } }, { Json: { alias: 'al', collection: 'c' } }, undefined],
  ['vectorSetAlias removing it', (db) => db.vectorSetAlias('al', null), { Vector: { SetAlias: { alias: 'al', collection: null } } }],
  ['vectorListAliases', (db) => db.vectorListAliases(), { Vector: 'ListAliases' },
    { Json: { aliases: [{ alias: 'al', collection: 'c' }] } }, [{ alias: 'al', collection: 'c' }]],
  ['vectorAddNamedVector', (db) => db.vectorAddNamedVector('c', 'title', 2, 'dot'),
    { Vector: { AddNamedVector: { collection: 'c', name: 'title', dimension: 2, metric: 'dot' } } },
    { Json: { collection: 'c', dimension: 2, name: 'title' } }, undefined],
  ['vectorAddNamedVector with the default metric', (db) => db.vectorAddNamedVector('c', 'title', 2),
    { Vector: { AddNamedVector: { collection: 'c', name: 'title', dimension: 2, metric: 'cosine' } } }],
  ['vectorUpsertNamed', (db) => db.vectorUpsertNamed('c', 'n1', { default: [1, 0, 0], title: new Float32Array([1, 2]) }, { kind: 'named' }),
    { Vector: { UpsertNamed: { collection: 'c', id: 'n1', vectors: { default: [1, 0, 0], title: [1, 2] }, metadata: { kind: 'named' } } } },
    { Json: { id: 'n1', vectors: 2 } }, 'n1'],
  ['vectorUpsertMany', (db) => db.vectorUpsertMany('c', [{ id: 'a', vector: [1, 0], metadata: { k: 1 } }, { id: 'b', vector: new Float32Array([0, 1]) }]),
    { Vector: { UpsertMany: { collection: 'c', items: [{ id: 'a', vector: [1, 0], metadata: { k: 1 } }, { id: 'b', vector: [0, 1], metadata: null }] } } },
    { Json: { upserted: 2 } }, 2],
  ['vectorDeleteMany', (db) => db.vectorDeleteMany('c', ['a', 'nope']),
    { Vector: { DeleteMany: { collection: 'c', ids: ['a', 'nope'] } } }, { Json: { deleted: 1 } }, 1],
  ['vectorSearchBatch', (db) => db.vectorSearchBatch('c', [[1, 0], [0, 1]], 2),
    { Vector: { SearchBatch: { collection: 'c', vectors: [[1, 0], [0, 1]], top_k: 2 } } },
    { Json: { count: 2, results: [[{ id: 'a', metadata: null, score: 1 }], []] } }, [[{ id: 'a', metadata: null, score: 1 }], []]],
  ['vectorSearchBatch with every option', (db) => db.vectorSearchBatch('c', [[1, 0]], 2, {
    filter: { kind: 'x' }, minScore: 0.1, includeVectors: true, offset: 1, includeMetadata: false, maxDistance: 0.5,
    efSearch: 64, exact: true, scoreMetric: 'l2', filterStrategy: 'exact', using: 'title', tenant: 't', namespace: 'ns',
    sparse: { indices: [1], values: [0.5] }, hybridAlpha: 0.3, explain: true, scoreExpr: 'score', explainText: 'q',
    ann: 'ivf_pq', nprobe: 4,
  }),
    { Vector: { SearchBatch: {
      collection: 'c', vectors: [[1, 0]], top_k: 2, filter: { kind: 'x' }, min_score: 0.1, include_vectors: true,
      offset: 1, include_metadata: false, max_distance: 0.5, ef_search: 64, exact: true, score_metric: 'l2',
      filter_strategy: 'exact', using: 'title', tenant: 't', namespace: 'ns', sparse: { indices: [1], values: [0.5] },
      hybrid_alpha: 0.3, explain: true, score_expr: 'score', explain_text: 'q', ann: 'ivf_pq', nprobe: 4,
    } } }],
  ['vectorSearch with a named vector', (db) => db.vectorSearch('c', [1, 2], 2, { using: 'title', offset: 1 }),
    { Vector: { Search: { collection: 'c', vector: [1, 2], top_k: 2, filter: null, using: 'title', offset: 1 } } },
    { Json: { index: 'flat', results: [{ id: 'n1', metadata: null, score: 5 }], top_k: 2 } }, [{ id: 'n1', metadata: null, score: 5 }]],
  ['vectorSearch sends what it always sent', (db) => db.vectorSearch('c', [1, 2], 2),
    { Vector: { Search: { collection: 'c', vector: [1, 2], top_k: 2, filter: null } } }],
  ['vectorDeleteByFilter', (db) => db.vectorDeleteByFilter('c', { kind: 'y' }),
    { Vector: { DeleteByFilter: { collection: 'c', filter: { kind: 'y' } } } }, { Json: { deleted: 1 } }, 1],
  ['vectorUpdateByFilter', (db) => db.vectorUpdateByFilter('c', { kind: 'x' }, { flag: true }),
    { Vector: { UpdateByFilter: { collection: 'c', filter: { kind: 'x' }, set: { flag: true } } } }, { Json: { updated: 1 } }, 1],
  ['vectorCount', (db) => db.vectorCount('c'), { Vector: { Count: { collection: 'c' } } }, { Json: { count: 5, filtered: false } }, 5],
  ['vectorCount with a filter', (db) => db.vectorCount('c', { filter: { kind: 'x' } }),
    { Vector: { Count: { collection: 'c', filter: { kind: 'x' } } } }, { Json: { count: 1, filtered: true } }, 1],
  ['vectorListPartitions', (db) => db.vectorListPartitions('c'), { Vector: { ListPartitions: { collection: 'c' } } },
    { Json: { field: '_namespace', partitions: [{ count: 1, name: 'ns1' }], unpartitioned: 3 } },
    { field: '_namespace', partitions: [{ count: 1, name: 'ns1' }], unpartitioned: 3 }],
  ['vectorListPartitions by tenant', (db) => db.vectorListPartitions('c', { field: '_tenant' }),
    { Vector: { ListPartitions: { collection: 'c', field: '_tenant' } } }],
  ['vectorRenameCollection', (db) => db.vectorRenameCollection('c', 'd'),
    { Vector: { RenameCollection: { collection: 'c', to: 'd' } } },
    { Json: { from: 'c', moved: 2, renamed: true, to: 'd' } }, { from: 'c', moved: 2, renamed: true, to: 'd' }],
  ['vectorRebuildIndex', (db) => db.vectorRebuildIndex('c'), { Vector: { RebuildIndex: { collection: 'c' } } },
    { Json: { build_ms: 51, persisted: true, rebuilt: true, tombstones_cleared: 0, vectors: 5 } },
    { build_ms: 51, persisted: true, rebuilt: true, tombstones_cleared: 0, vectors: 5 }],
  ['vectorIndexStats', (db) => db.vectorIndexStats('c'), { Vector: { IndexStats: { collection: 'c' } } },
    { Json: { collection: 'c', flat_scan_threshold: 256, index: 'flat', stored: 5 } },
    { collection: 'c', flat_scan_threshold: 256, index: 'flat', stored: 5 }],
  ['vectorMeasureRecall', (db) => db.vectorMeasureRecall('c'), { Vector: { MeasureRecall: { collection: 'c' } } },
    { Json: { collection: 'c', index: 'flat', measured: false, reason: 'small', recall: 1.0 } },
    { collection: 'c', index: 'flat', measured: false, reason: 'small', recall: 1 }],
  ['vectorMeasureRecall with every option', (db) => db.vectorMeasureRecall('c', { sample: 2, topK: 3, efSearch: 32 }),
    { Vector: { MeasureRecall: { collection: 'c', sample: 2, top_k: 3, ef_search: 32 } } }],
  ['vectorSearchMulti', (db) => db.vectorSearchMulti('c', [[1, 0], [0, 1]], 3),
    { Vector: { SearchMulti: { collection: 'c', vectors: [[1, 0], [0, 1]], top_k: 3 } } },
    { Json: { depth: 12, fusion: 'rrf', queries: 2, results: [{ id: 'b', matched: 2, metadata: null, score: 0.03 }] } },
    { depth: 12, fusion: 'rrf', queries: 2, results: [{ id: 'b', matched: 2, metadata: null, score: 0.03 }] }],
  ['vectorSearchMulti with every option', (db) => db.vectorSearchMulti('c', [[1, 0]], 3, { fusion: 'max', filter: { kind: 'x' } }),
    { Vector: { SearchMulti: { collection: 'c', vectors: [[1, 0]], top_k: 3, fusion: 'max', filter: { kind: 'x' } } } }],
  ['vectorSetCollectionConfig', (db) => db.vectorSetCollectionConfig('c', { m: 8, efConstruction: 100 }),
    { Vector: { SetCollectionConfig: { collection: 'c', m: 8, ef_construction: 100 } } },
    { Json: { collection: 'c', ef_construction: 100, m: 8, multi_tenant: false, named: [], normalize: false } },
    { collection: 'c', ef_construction: 100, m: 8, multi_tenant: false, named: [], normalize: false }],
  ['vectorSetCollectionConfig with every option', (db) => db.vectorSetCollectionConfig('c', { normalize: true, m: 8, efConstruction: 100, multiTenant: true }),
    { Vector: { SetCollectionConfig: { collection: 'c', normalize: true, m: 8, ef_construction: 100, multi_tenant: true } } }],
  ['vectorCopyCollection', (db) => db.vectorCopyCollection('c', 'd'),
    { Vector: { CopyCollection: { collection: 'c', to: 'd' } } }, { Json: { copied: 2, to: 'd' } }, 2],
  ['vectorSearchByExamples', (db) => db.vectorSearchByExamples('c', ['a', [0, 1, 0]], 3),
    { Vector: { SearchByExamples: { collection: 'c', positive: ['a', [0, 1, 0]], negative: [], top_k: 3 } } },
    { Json: { examples: { negative: 0, positive: 2 }, index: 'flat', results: [{ id: 'c', metadata: null, score: 0.9 }], top_k: 3 } },
    [{ id: 'c', metadata: null, score: 0.9 }]],
  ['vectorSearchByExamples with every option', (db) => db.vectorSearchByExamples('c', ['a'], 3, {
    negative: ['b', new Float32Array([1, 0, 0])], filter: { kind: 'x' }, minScore: 0, includeVectors: true,
    excludeExamples: false, using: 'title',
  }),
    { Vector: { SearchByExamples: {
      collection: 'c', positive: ['a'], negative: ['b', [1, 0, 0]], top_k: 3, filter: { kind: 'x' }, min_score: 0,
      include_vectors: true, exclude_examples: false, using: 'title',
    } } }],
];

const GRAPH = [
  ['graphAddMany', (db) => db.graphAddMany('g', {
    nodes: [{ id: 'a', labels: ['P'], properties: { name: 'A' } }, { id: 'b' }],
    edges: [{ id: 'ab', from: 'a', to: 'b', label: 'K', properties: { weight: 2 } }],
  }),
    { Graph: { AddMany: { graph: 'g',
      nodes: [{ id: 'a', labels: ['P'], properties: { name: 'A' } }, { id: 'b' }],
      edges: [{ id: 'ab', from: 'a', to: 'b', label: 'K', properties: { weight: 2 } }] } } },
    { Json: { atomic: true, edges: 1, nodes: 2 } }, { atomic: true, edges: 1, nodes: 2 }],
  ['graphAddMany with nodes only', (db) => db.graphAddMany('g', { nodes: [{ id: 'a' }] }),
    { Graph: { AddMany: { graph: 'g', nodes: [{ id: 'a' }], edges: [] } } }],
  ['graphRemoveMany', (db) => db.graphRemoveMany('g', { nodes: ['a'], edges: ['bc'], detach: true }),
    { Graph: { RemoveMany: { graph: 'g', nodes: ['a'], edges: ['bc'], detach: true } } },
    { Json: { atomic: true, edges_removed: 4, nodes_removed: 1 } }, { atomic: true, edges_removed: 4, nodes_removed: 1 }],
  ['graphRemoveMany of edges only', (db) => db.graphRemoveMany('g', { edges: ['bc'] }),
    { Graph: { RemoveMany: { graph: 'g', nodes: [], edges: ['bc'], detach: false } } }],
  ['graphUpdateNode', (db) => db.graphUpdateNode('g', 'a', { properties: { name: null, city: 'X' }, addLabels: ['R'], removeLabels: ['P'] }),
    { Graph: { UpdateNode: { graph: 'g', id: 'a', properties: { name: null, city: 'X' }, add_labels: ['R'], remove_labels: ['P'] } } },
    { Json: { id: 'a', labels: ['R'], properties: { city: 'X' } } }, { id: 'a', labels: ['R'], properties: { city: 'X' } }],
  ['graphUpdateNode with nothing to change', (db) => db.graphUpdateNode('g', 'a'), { Graph: { UpdateNode: { graph: 'g', id: 'a' } } }],
  ['graphUpdateEdge', (db) => db.graphUpdateEdge('g', 'ab', { properties: { weight: 3 }, label: 'Z' }),
    { Graph: { UpdateEdge: { graph: 'g', id: 'ab', properties: { weight: 3 }, label: 'Z' } } },
    { Json: { from: 'a', id: 'ab', label: 'Z', properties: { weight: 3 }, to: 'b' } },
    { from: 'a', id: 'ab', label: 'Z', properties: { weight: 3 }, to: 'b' }],
  ['graphCopy', (db) => db.graphCopy('g', 'g2'), { Graph: { CopyGraph: { graph: 'g', to: 'g2' } } },
    { Json: { copied: true, edges: 5, nodes: 8, to: 'g2' } }, { copied: true, edges: 5, nodes: 8, to: 'g2' }],
  ['graphDfs', (db) => db.graphDfs('g', 'a'), { Graph: { Dfs: { graph: 'g', start: 'a' } } },
    { Json: { count: 1, direction: 'outgoing', limit: 100, max_depth: 3, nodes: [{ depth: 0, id: 'a', labels: [], properties: null }], order: 'depth_first', start: 'a', truncated: false } },
    { count: 1, direction: 'outgoing', limit: 100, max_depth: 3, nodes: [{ depth: 0, id: 'a', labels: [], properties: null }], order: 'depth_first', start: 'a', truncated: false }],
  ['graphDfs with every option', (db) => db.graphDfs('g', 'a', { direction: 'both', label: 'K', maxDepth: 1, limit: 2 }),
    { Graph: { Dfs: { graph: 'g', start: 'a', direction: 'both', label: 'K', max_depth: 1, limit: 2 } } }],
  ['graphConnectedComponents', (db) => db.graphConnectedComponents('g'), { Graph: { ConnectedComponents: { graph: 'g' } } },
    { Json: { components: [{ nodes: ['a'], size: 1, truncated: false }], count: 1, kind: 'weak', largest: 1, truncated: false } },
    { components: [{ nodes: ['a'], size: 1, truncated: false }], count: 1, kind: 'weak', largest: 1, truncated: false }],
  ['graphConnectedComponents with every option', (db) => db.graphConnectedComponents('g', { kind: 'strong', label: 'K', limit: 1 }),
    { Graph: { ConnectedComponents: { graph: 'g', kind: 'strong', label: 'K', limit: 1 } } }],
  ['graphDetectCycle', (db) => db.graphDetectCycle('g'), { Graph: { DetectCycle: { graph: 'g' } } },
    { Json: { cycle: { edges: ['ab', 'ba'], nodes: ['a', 'b'] }, directed: true, hasCycle: true } },
    { cycle: { edges: ['ab', 'ba'], nodes: ['a', 'b'] }, directed: true, hasCycle: true }],
  ['graphDetectCycle undirected', (db) => db.graphDetectCycle('g', { directed: false, label: 'L' }),
    { Graph: { DetectCycle: { graph: 'g', directed: false, label: 'L' } } }],
  ['graphStats', (db) => db.graphStats('g'), { Graph: { GraphStats: { graph: 'g' } } },
    { Json: { nodes: 4, edges: 4, selfLoops: 0 } }, { nodes: 4, edges: 4, selfLoops: 0 }],
  ['graphSubgraph', (db) => db.graphSubgraph('g', ['a']), { Graph: { Subgraph: { graph: 'g', seeds: ['a'] } } },
    { Json: { node_count: 1, edge_count: 0, nodes: [], edges: [] } }, { node_count: 1, edge_count: 0, nodes: [], edges: [] }],
  ['graphSubgraph with every option', (db) => db.graphSubgraph('g', ['a', 'd'], { direction: 'outgoing', label: 'K', maxDepth: 2, limit: 2 }),
    { Graph: { Subgraph: { graph: 'g', seeds: ['a', 'd'], direction: 'outgoing', label: 'K', max_depth: 2, limit: 2 } } }],
  ['graphSchema', (db) => db.graphSchema('g'), { Graph: { GraphSchema: { graph: 'g' } } },
    { Json: { nodes: 4, edges: 4, node_labels: [], edge_types: [] } }, { nodes: 4, edges: 4, node_labels: [], edge_types: [] }],
  ['graphKShortestPaths', (db) => db.graphKShortestPaths('g', 'a', 'c'), { Graph: { KShortestPaths: { graph: 'g', from: 'a', to: 'c' } } },
    { Json: { count: 1, paths: [{ cost: 1.0, edges: ['ac'], hops: 1, nodes: ['a', 'c'] }] } },
    { count: 1, paths: [{ cost: 1, edges: ['ac'], hops: 1, nodes: ['a', 'c'] }] }],
  ['graphKShortestPaths with every option', (db) => db.graphKShortestPaths('g', 'a', 'c', { k: 1, direction: 'both', label: 'K', weightProperty: 'weight' }),
    { Graph: { KShortestPaths: { graph: 'g', from: 'a', to: 'c', k: 1, direction: 'both', label: 'K', weight_property: 'weight' } } }],
  ['graphAllPaths', (db) => db.graphAllPaths('g', 'a', 'c'), { Graph: { AllPaths: { graph: 'g', from: 'a', to: 'c' } } },
    { Json: { complete: true, count: 0, paths: [], stopped_by: null } }, { complete: true, count: 0, paths: [], stopped_by: null }],
  ['graphAllPaths with every option', (db) => db.graphAllPaths('g', 'a', 'c', { direction: 'both', label: 'K', maxDepth: 3, limit: 1 }),
    { Graph: { AllPaths: { graph: 'g', from: 'a', to: 'c', direction: 'both', label: 'K', max_depth: 3, limit: 1 } } }],
  ['graphCentrality', (db) => db.graphCentrality('g', 'betweenness'), { Graph: { Centrality: { graph: 'g', measure: 'betweenness' } } },
    { Json: { directed: true, measure: 'betweenness', nodes: 4, results: [{ id: 'a', score: 0.16 }] } },
    { directed: true, measure: 'betweenness', nodes: 4, results: [{ id: 'a', score: 0.16 }] }],
  ['graphCentrality with every option', (db) => db.graphCentrality('g', 'eigenvector', { directed: false, label: 'K', limit: 2, iterations: 50, tolerance: 0.0001 }),
    { Graph: { Centrality: { graph: 'g', measure: 'eigenvector', directed: false, label: 'K', limit: 2, iterations: 50, tolerance: 0.0001 } } }],
  ['graphCommunities', (db) => db.graphCommunities('g'), { Graph: { Communities: { graph: 'g' } } },
    { Json: { algorithm: 'louvain', communities: [], converged: true, count: 0, iterations: 3, modularity: 0.0 } },
    { algorithm: 'louvain', communities: [], converged: true, count: 0, iterations: 3, modularity: 0 }],
  ['graphCommunities with every option', (db) => db.graphCommunities('g', { label: 'K', iterations: 5, limit: 1 }),
    { Graph: { Communities: { graph: 'g', label: 'K', iterations: 5, limit: 1 } } }],
  ['graphTriangleCount', (db) => db.graphTriangleCount('g'), { Graph: { TriangleCount: { graph: 'g' } } },
    { Json: { average_clustering: 0.75, nodes: [], transitivity: 1.0, triangles: 1 } },
    { average_clustering: 0.75, nodes: [], transitivity: 1, triangles: 1 }],
  ['graphTriangleCount with every option', (db) => db.graphTriangleCount('g', { label: 'K', limit: 1 }),
    { Graph: { TriangleCount: { graph: 'g', label: 'K', limit: 1 } } }],
  ['graphNodeSimilarity', (db) => db.graphNodeSimilarity('g', 'a'), { Graph: { NodeSimilarity: { graph: 'g', node: 'a' } } },
    { Json: { count: 1, direction: 'both', metric: 'jaccard', node: 'a', results: [{ id: 'b', score: 0.33 }] } },
    { count: 1, direction: 'both', metric: 'jaccard', node: 'a', results: [{ id: 'b', score: 0.33 }] }],
  ['graphNodeSimilarity with every option', (db) => db.graphNodeSimilarity('g', 'a', { direction: 'outgoing', label: 'K', metric: 'overlap', limit: 1 }),
    { Graph: { NodeSimilarity: { graph: 'g', node: 'a', direction: 'outgoing', label: 'K', metric: 'overlap', limit: 1 } } }],
  ['graphCheckConsistency', (db) => db.graphCheckConsistency('g'), { Graph: { CheckConsistency: { graph: 'g' } } },
    { Json: { consistent: true, nodes: 4, edges: 4 } }, { consistent: true, nodes: 4, edges: 4 }],
  ['graphCreateNodeIndex', (db) => db.graphCreateNodeIndex('g', 'by_name', ['name'], { label: 'P' }),
    { Graph: { CreateNodeIndex: { graph: 'g', name: 'by_name', label: 'P', properties: ['name'] } } },
    { Json: { created: true, name: 'by_name' } }, undefined],
  ['graphCreateNodeIndex over every label', (db) => db.graphCreateNodeIndex('g', 'by_two', ['name', 'age']),
    { Graph: { CreateNodeIndex: { graph: 'g', name: 'by_two', properties: ['name', 'age'] } } }],
  ['graphCreateConstraint', (db) => db.graphCreateConstraint('g', 'uniq', 'P', 'name', 'unique'),
    { Graph: { CreateConstraint: { graph: 'g', name: 'uniq', label: 'P', property: 'name', kind: 'unique' } } },
    { Json: { created: true, kind: 'unique', name: 'uniq', target: 'node' } }, undefined],
  ['graphCreateConstraint on edges', (db) => db.graphCreateConstraint('g', 'req', 'Z', 'weight', 'required', { target: 'edge' }),
    { Graph: { CreateConstraint: { graph: 'g', name: 'req', label: 'Z', property: 'weight', kind: 'required', target: 'edge' } } }],
  ['graphDropSchemaObject', (db) => db.graphDropSchemaObject('g', 'by_two'),
    { Graph: { DropSchemaObject: { graph: 'g', name: 'by_two' } } }, { Json: { dropped: true, name: 'by_two' } }, undefined],
  ['graphListSchemaObjects', (db) => db.graphListSchemaObjects('g'), { Graph: { ListSchemaObjects: { graph: 'g' } } },
    { Json: { constraints: [], indexes: [{ label: 'P', name: 'by_name', properties: ['name'] }] } },
    { constraints: [], indexes: [{ label: 'P', name: 'by_name', properties: ['name'] }] }],
  ['graphFindNodes', (db) => db.graphFindNodes('g', { label: 'P', properties: { name: 'B' }, limit: 5 }),
    { Graph: { FindNodes: { graph: 'g', label: 'P', properties: { name: 'B' }, limit: 5 } } },
    { Json: { count: 1, nodes: [{ id: 'b', labels: ['P'], properties: { name: 'B' } }], plan: 'index `by_name`', truncated: false } },
    { count: 1, nodes: [{ id: 'b', labels: ['P'], properties: { name: 'B' } }], plan: 'index `by_name`', truncated: false }],
  ['graphFindNodes of every node', (db) => db.graphFindNodes('g'), { Graph: { FindNodes: { graph: 'g' } } }],
  ['graphImportCsv', (db) => db.graphImportCsv('g', { nodes: 'id,labels\nx1,P\n', edges: 'id,from,to,label\ne,x1,x1,K\n' }),
    { Graph: { ImportCsv: { graph: 'g', nodes: 'id,labels\nx1,P\n', edges: 'id,from,to,label\ne,x1,x1,K\n' } } },
    { Json: { atomic: true, edges: 1, nodes: 1 } }, { atomic: true, edges: 1, nodes: 1 }],
  ['graphImportCsv of nodes only', (db) => db.graphImportCsv('g', { nodes: 'id\nx1\n' }),
    { Graph: { ImportCsv: { graph: 'g', nodes: 'id\nx1\n' } } }],
  ['graphPageRank', (db) => db.graphPageRank('g'), { Graph: { PageRank: { graph: 'g' } } },
    { Json: { converged: true, count: 1, damping: 0.85, iterations: 5, ranks: [{ id: 'a', score: 1.0 }], truncated: false } },
    { converged: true, count: 1, damping: 0.85, iterations: 5, ranks: [{ id: 'a', score: 1 }], truncated: false }],
  ['graphPageRank with every option', (db) => db.graphPageRank('g', { damping: 0.5, iterations: 10, tolerance: 0.001, label: 'K', limit: 2 }),
    { Graph: { PageRank: { graph: 'g', damping: 0.5, iterations: 10, tolerance: 0.001, label: 'K', limit: 2 } } }],
  ['graphExecute', (db) => db.graphExecute('g', "CREATE (n:Q {name: 'made'})"),
    { Graph: { Execute: { graph: 'g', cypher: "CREATE (n:Q {name: 'made'})" } } },
    { Json: { graph: 'g', nodesCreated: 1, statements: 1 } }, { graph: 'g', nodesCreated: 1, statements: 1 }],
];

function family(name, rows) {
  describe(name, () => {
    let peer;
    let db;
    let reply;

    before(async () => {
      peer = await scriptedPeer((rid) => ({ request_id: rid, status: 'ok', data: reply, diagnostics: {} }));
      db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    });

    after(async () => {
      await db.close();
      await peer.close();
    });

    for (const [what, call, op, data, expected, database] of rows) {
      it(what, async () => {
        reply = data === undefined ? { Json: {} } : data;
        const result = await call(db);
        const sent = peer.state.frames[peer.state.frames.length - 1].body;
        assert.deepEqual(sent.op, op);
        assert.equal(sent.database, database || 'main');
        assert.equal(sent.options, undefined, 'no options are sent outside a transaction');
        if (data !== undefined) assert.deepEqual(result, expected);
      });
    }
  });
}

family('cache requests added for 0.1.0-rc.3', CACHE);
family('document requests added for 0.1.0-rc.3', DOCUMENT);
family('vector requests added for 0.1.0-rc.3', VECTOR);
family('graph requests added for 0.1.0-rc.3', GRAPH);

describe('document and graph transactions', () => {
  // The transaction id travels in the request's options, not in the operation.
  async function session(fn, answer) {
    const peer = await scriptedPeer((rid, n, body) => answer(rid, body));
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    const sent = () => peer.state.frames.filter((f) => f.tag === 2).map((f) => f.body);
    try {
      await fn(db, sent);
    } finally {
      await db.close();
      await peer.close();
    }
  }
  const ok = (rid, json) => ({ request_id: rid, status: 'ok', data: { Json: json }, diagnostics: {} });
  const variant = (body) => {
    const v = Object.values(body.op)[0];
    return typeof v === 'string' ? v : Object.keys(v)[0];
  };

  it('a document transaction names itself on every request until it commits', async () => {
    await session(async (db, sent) => {
      assert.equal(await db.documentBeginTransaction({ serializable: true }), 'dtx-1-7');
      assert.equal(db.txn, 'dtx-1-7');
      await db.documentInsertMany('c', [{ n: 1 }]);
      assert.deepEqual(await db.documentCommitTransaction(), { committed: true, writes: 1 });
      assert.equal(db.txn, null);
      await db.documentDeleteMany('c', 'All');

      const [begin, insert, commit, later] = sent();
      assert.deepEqual(begin.op, { Document: { BeginTransaction: { serializable: true } } });
      assert.equal(begin.options, undefined);
      assert.deepEqual(insert.options, { txn: 'dtx-1-7' });
      assert.deepEqual(commit.op, { Document: 'CommitTransaction' });
      assert.deepEqual(commit.options, { txn: 'dtx-1-7' });
      assert.equal(later.options, undefined, 'the transaction ended with its commit');
    }, (rid, body) => {
      const v = variant(body);
      if (v === 'BeginTransaction') return ok(rid, { serializable: true, txn: 'dtx-1-7' });
      if (v === 'CommitTransaction') return ok(rid, { committed: true, writes: 1 });
      return ok(rid, { ids: ['x'], deleted: 0 });
    });
  });

  it('a snapshot transaction is the default, and rollback ends it', async () => {
    await session(async (db, sent) => {
      await db.documentBeginTransaction();
      db.requestTimeoutMs = 500;
      await db.documentRollbackTransaction();
      assert.equal(db.txn, null);
      const [begin, rollback] = sent();
      assert.deepEqual(begin.op, { Document: { BeginTransaction: { serializable: false } } });
      assert.deepEqual(rollback.op, { Document: 'RollbackTransaction' });
      assert.deepEqual(rollback.options, { timeout_ms: 500, txn: 't1' });
    }, (rid, body) => (variant(body) === 'BeginTransaction' ? ok(rid, { txn: 't1' }) : ok(rid, { rolled_back: true })));
  });

  it('a refused commit leaves the transaction open, as the server does, so it can be rolled back', async () => {
    await session(async (db, sent) => {
      await db.documentBeginTransaction();
      const e = await db.documentCommitTransaction().catch((err) => err);
      assert.ok(e instanceof TriCoreError);
      assert.match(e.message, /write-write conflict/);
      assert.equal(db.txn, 't1');
      await db.documentRollbackTransaction();
      assert.equal(db.txn, null);
      assert.deepEqual(sent()[2].options, { txn: 't1' });
    }, (rid, body) => {
      const v = variant(body);
      if (v === 'BeginTransaction') return ok(rid, { txn: 't1' });
      if (v === 'CommitTransaction') return refusalEnvelope(rid, 'storage error: write-write conflict', { error_code: 'internal' });
      return ok(rid, { rolled_back: true });
    });
  });

  it('a second begin is refused before anything is sent', async () => {
    await session(async (db, sent) => {
      await db.documentBeginTransaction();
      for (const begin of [() => db.documentBeginTransaction(), () => db.graphBeginTransaction('g')]) {
        const e = await begin().catch((err) => err);
        assert.ok(e instanceof TriCoreError);
        assert.equal(e.notSent, true);
        assert.match(e.message, /`t1` is already open/);
      }
      assert.equal(sent().length, 1);
      assert.equal(db.txn, 't1');
    }, (rid) => ok(rid, { txn: 't1' }));
  });

  it('a graph transaction queues writes and commits or rolls back by id', async () => {
    await session(async (db, sent) => {
      assert.equal(await db.graphBeginTransaction('g'), 'gtx-1-15');
      assert.deepEqual(await db.graphExecute('g', 'CREATE (n:T)'), { queued: 1, transaction: 'gtx-1-15' });
      const done = await db.graphCommitTransaction('g');
      assert.equal(done.committed, 1);
      assert.equal(db.txn, null);

      await db.graphBeginTransaction('g');
      assert.equal(await db.graphRollbackTransaction('g'), 1);
      assert.equal(db.txn, null);

      const [begin, execute, commit, , rollback] = sent();
      assert.deepEqual(begin.op, { Graph: { BeginTransaction: { graph: 'g' } } });
      assert.deepEqual(execute.options, { txn: 'gtx-1-15' });
      assert.deepEqual(commit.op, { Graph: { CommitTransaction: { graph: 'g' } } });
      assert.deepEqual(commit.options, { txn: 'gtx-1-15' });
      assert.deepEqual(rollback.op, { Graph: { RollbackTransaction: { graph: 'g' } } });
      assert.deepEqual(rollback.options, { txn: 'gtx-1-15' });
    }, (rid, body) => {
      const v = variant(body);
      if (v === 'BeginTransaction') return ok(rid, { transaction: 'gtx-1-15' });
      if (v === 'Execute') return ok(rid, { queued: 1, transaction: 'gtx-1-15' });
      if (v === 'CommitTransaction') return ok(rid, { committed: 1, statements: 1, graph: 'g' });
      return ok(rid, { rolled_back: 1 });
    });
  });

  it('a request inside a transaction is not sent to another node on not_leader', async () => {
    await session(async (db, sent) => {
      db.txn = 't1';
      const e = await db.documentInsertMany('c', [{ n: 1 }]).catch((err) => err);
      assert.equal(e.code, 'not_leader');
      assert.equal(sent().length, 1, 'the transaction lives on the node that opened it');
    }, (rid) => refusalEnvelope(rid, 'not the raft leader', { error_code: 'not_leader', leader_hint: '127.0.0.1:1' }));
  });
});

describe('arguments refused before anything is sent', () => {
  it('names the argument', async () => {
    const peer = await scriptedPeer((rid) => ({ request_id: rid, status: 'ok', data: { Json: {} }, diagnostics: {} }));
    const db = await TriCore.connect({ host: '127.0.0.1', port: peer.port });
    try {
      await assert.rejects(() => db.cacheMSet('n', []), /entries must be a non-empty array/);
      await assert.rejects(() => db.cacheMSet('n', [[1, 'v']]), /string key/);
      await assert.rejects(() => db.cacheZAdd('n', 'z', [{ member: 'a', score: NaN }]), /not NaN/);
      await assert.rejects(() => db.cacheZRangeByScore('n', 'z', NaN, 1), /min must be/);
      await assert.rejects(() => db.vectorSearchBatch('c', [], 1), /vectors must be a non-empty array/);
      assert.equal(peer.state.requests, 0);
    } finally {
      await db.close();
      await peer.close();
    }
  });
});
