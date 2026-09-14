'use strict';

// Conformance runner for the tricoredb JS package.
//
//   node conformance/runner.js <host> <port> <user> <secret>   < scenario.json
//
// Loads this package's BUILT output through its own package name (`exports`
// self-reference, so `npm run build` must have run). Maps each canonical action
// to the public SDK method a user would call and copies the typed result into
// canonical JSON, one object per step on stdout. No assertions, no defaults, no
// computed values: every judgement lives in the shared scenario.

const { TriCore, DocFilter, DocStage } = require('tricoredb');

function filter(spec) {
  switch (spec.op) {
    case 'all': return DocFilter.all();
    case 'eq': return DocFilter.eq(spec.field, spec.value);
    case 'gt': return DocFilter.gt(spec.field, spec.value);
    case 'contains': return DocFilter.contains(spec.field, spec.value);
    case 'and': return DocFilter.and(...spec.filters.map(filter));
    default: throw new Error(`unsupported filter op in the scenario: ${spec.op}`);
  }
}

function accumulator(a) {
  switch (a.op) {
    case 'sum': return DocStage.sum(a.output, a.field);
    case 'count': return DocStage.countDocs(a.output);
    default: throw new Error(`unsupported accumulator: ${a.op}`);
  }
}

function stage(spec) {
  switch (spec.stage) {
    case 'match': return DocStage.match(filter(spec.filter));
    case 'group': return DocStage.group(DocStage.byField(spec.by.field), spec.accumulators.map(accumulator));
    case 'sort': return DocStage.sort(spec.keys);
    case 'count': return DocStage.count(spec.field);
    default: throw new Error(`unsupported aggregate stage: ${spec.stage}`);
  }
}

const bufs = (xs) => (xs || []).map((x) => Buffer.from(x, 'utf8'));
const pairs = (ps) => (ps || []).map((p) => [Buffer.from(p[0], 'utf8'), Buffer.from(p[1], 'utf8')]);
const value = (v) => (v === null || v === undefined ? { found: false } : { found: true, value: v.toString('utf8') });
const entry = (e) => ({ id: e.id, fields: e.fields.map((f) => [f[0].toString('utf8'), f[1].toString('utf8')]) });

const ACTIONS = {
  'doc.createCollection': async (db, a) => { await db.documentCreateCollection(a.collection); return {}; },
  'doc.dropCollection': async (db, a) => { await db.documentDropCollection(a.collection); return {}; },
  'doc.listCollections': async (db) => ({ names: await db.documentListCollections() }),
  'doc.insert': async (db, a) => ({ id: await db.documentInsert(a.collection, a.document, { id: a.id }) }),
  'doc.get': async (db, a) => {
    const doc = await db.documentGet(a.collection, a.id);
    return doc === null || doc === undefined ? { found: false } : { found: true, doc };
  },
  'doc.find': async (db, a) => ({
    docs: await db.documentFind(a.collection, filter(a.filter), a.limit === undefined ? {} : { limit: a.limit }),
  }),
  'doc.update': async (db, a) => { await db.documentUpdate(a.collection, a.id, a.set); return {}; },
  'doc.updateOne': async (db, a) => {
    const update = {};
    if (a.set) update.set = a.set;
    if (a.inc) update.inc = a.inc;
    await db.documentUpdateOne(a.collection, a.id, update, { upsert: !!a.upsert });
    return {};
  },
  'doc.updateMany': async (db, a) => {
    const update = {};
    if (a.set) update.set = a.set;
    if (a.inc) update.inc = a.inc;
    const r = await db.documentUpdateMany(a.collection, filter(a.filter), update);
    return { matched: r.matched, modified: r.modified };
  },
  'doc.delete': async (db, a) => { await db.documentDelete(a.collection, a.id); return {}; },
  'doc.createIndex': async (db, a) => {
    await db.documentCreateIndex(a.collection, a.indexName, a.field, { unique: !!a.unique });
    return {};
  },
  'doc.dropIndex': async (db, a) => { await db.documentDropIndex(a.collection, a.indexName); return {}; },
  'doc.listIndexes': async (db, a) => ({
    indexes: (await db.documentListIndexes(a.collection)).map((i) => ({ name: i.index_name, field: i.field })),
  }),
  'doc.analyze': async (db, a) => {
    const s = await db.documentAnalyze(a.collection);
    return { document_count: s.document_count };
  },
  'doc.aggregate': async (db, a) => ({ docs: await db.documentAggregate(a.collection, a.pipeline.map(stage)) }),

  'vec.createCollection': async (db, a) => {
    await db.vectorCreateCollection(a.collection, a.dimension, { metric: a.metric });
    return {};
  },
  'vec.dropCollection': async (db, a) => { await db.vectorDropCollection(a.collection); return {}; },
  'vec.listCollections': async (db) => ({ names: await db.vectorListCollections() }),
  'vec.upsert': async (db, a) => { await db.vectorUpsert(a.collection, a.id, a.vector, a.metadata); return {}; },
  'vec.get': async (db, a) => {
    const v = await db.vectorGet(a.collection, a.id);
    return v === null || v === undefined
      ? { found: false }
      : { found: true, id: v.id, vector: v.vector, metadata: v.metadata };
  },
  'vec.delete': async (db, a) => { await db.vectorDelete(a.collection, a.id); return {}; },
  'vec.search': async (db, a) => {
    const opts = a.filter === undefined ? {} : { filter: a.filter };
    const hits = await db.vectorSearch(a.collection, a.vector, a.topK, opts);
    return { ids: hits.map((h) => h.id), scores: hits.map((h) => h.score) };
  },
  'vec.describeCollection': async (db, a) => {
    const d = await db.vectorDescribeCollection(a.collection);
    return { dimension: d.dimension, metric: d.metric, count: d.count };
  },
  'vec.listVectors': async (db, a) => {
    const page = await db.vectorListVectors(a.collection);
    return { ids: page.vectors.map((v) => v.id), total: page.total };
  },

  'graph.create': async (db, a) => { await db.graphCreate(a.graph); return {}; },
  'graph.drop': async (db, a) => { await db.graphDrop(a.graph); return {}; },
  'graph.listGraphs': async (db) => ({ names: await db.graphListGraphs() }),
  'graph.addNode': async (db, a) => {
    await db.graphAddNode(a.graph, a.id, { labels: a.labels || [], properties: a.properties || {} });
    return {};
  },
  'graph.getNode': async (db, a) => {
    const n = await db.graphGetNode(a.graph, a.id);
    return n === null || n === undefined
      ? { found: false }
      : { found: true, id: n.id, labels: n.labels, properties: n.properties };
  },
  'graph.deleteNode': async (db, a) => { await db.graphDeleteNode(a.graph, a.id); return {}; },
  'graph.addEdge': async (db, a) => {
    await db.graphAddEdge(a.graph, a.id, a.from, a.to, a.label, { properties: a.properties || {} });
    return {};
  },
  'graph.getEdge': async (db, a) => {
    const e = await db.graphGetEdge(a.graph, a.id);
    return e === null || e === undefined
      ? { found: false }
      : { found: true, id: e.id, from: e.from, to: e.to, label: e.label, properties: e.properties };
  },
  'graph.deleteEdge': async (db, a) => { await db.graphDeleteEdge(a.graph, a.id); return {}; },
  'graph.neighbors': async (db, a) => {
    const opts = { direction: a.direction || 'outgoing' };
    if (a.label !== undefined) opts.label = a.label;
    const ns = await db.graphNeighbors(a.graph, a.nodeId, opts);
    return { nodeIds: ns.map((n) => n.node_id), edgeIds: ns.map((n) => n.edge_id) };
  },
  'graph.degree': async (db, a) => ({
    degree: await db.graphDegree(a.graph, a.nodeId, { direction: a.direction || 'outgoing' }),
  }),
  'graph.traverse': async (db, a) => {
    const t = await db.graphTraverse(a.graph, a.start, { direction: a.direction || 'outgoing', maxDepth: a.maxDepth });
    const depths = {};
    for (const n of t.nodes) depths[n.id] = n.depth;
    return { ids: t.nodes.map((n) => n.id), depths };
  },
  'graph.shortestPath': async (db, a) => {
    const p = await db.graphShortestPath(a.graph, a.from, a.to);
    return { found: p.found, hops: p.hops, nodePath: p.node_path, edgePath: p.edge_path };
  },
  'graph.weightedShortestPath': async (db, a) => {
    const opts = a.weightProperty === undefined ? {} : { weightProperty: a.weightProperty };
    const p = await db.graphWeightedShortestPath(a.graph, a.from, a.to, opts);
    return { found: p.found, totalCost: p.total_cost, nodePath: p.node_path, edgePath: p.edge_path };
  },
  'graph.listNodes': async (db, a) => {
    const page = await db.graphListNodes(a.graph);
    const labels = {};
    for (const n of page.nodes) labels[n.id] = n.labels;
    return { ids: page.nodes.map((n) => n.id), labels, total: page.total };
  },
  'graph.listEdges': async (db, a) => {
    const page = await db.graphListEdges(a.graph);
    const labels = {};
    for (const e of page.edges) labels[e.id] = e.label;
    return { ids: page.edges.map((e) => e.id), labels, total: page.total };
  },
  'graph.query': async (db, a) => {
    const q = await db.graphQuery(a.graph, a.cypher);
    return { columns: q.columns, rows: q.rows };
  },

  'sql.execute': async (db, a) => {
    const resp = await db.execute(a.sql);
    const j = resp.data && resp.data.Json;
    return { rowsAffected: j && typeof j.rows_affected === 'number' ? j.rows_affected : null };
  },
  'sql.query': async (db, a) => {
    const rows = await db.query(a.sql);
    return { columns: rows.columns, rows: rows.rows };
  },

  'cache.ping': async (db) => { await db.cachePing(); return {}; },
  'cache.set': async (db, a) => {
    await db.cacheSet(a.namespace, a.key, Buffer.from(a.value, 'utf8'), a.ttlMs === undefined ? null : a.ttlMs);
    return {};
  },
  'cache.get': async (db, a) => value(await db.cacheGet(a.namespace, a.key)),
  'cache.delete': async (db, a) => ({ deleted: await db.cacheDelete(a.namespace, a.key) }),
  'cache.exists': async (db, a) => ({ exists: await db.cacheExists(a.namespace, a.key) }),
  'cache.ttl': async (db, a) => {
    const ttl = await db.cacheTtl(a.namespace, a.key);
    return ttl === null ? { hasTtl: false } : { hasTtl: true, ttlMs: ttl };
  },
  'cache.clearNamespace': async (db, a) => ({ cleared: await db.cacheClearNamespace(a.namespace) }),
  'cache.incr': async (db, a) => ({ value: await db.cacheIncr(a.namespace, a.key, a.by) }),
  'cache.expire': async (db, a) => ({ updated: await db.cacheExpire(a.namespace, a.key, a.ttlMs) }),
  'cache.persist': async (db, a) => ({ persisted: await db.cachePersist(a.namespace, a.key) }),
  'cache.setNx': async (db, a) => ({
    set: await db.cacheSetNx(a.namespace, a.key, Buffer.from(a.value, 'utf8'), a.ttlMs === undefined ? null : a.ttlMs),
  }),
  'cache.keys': async (db, a) => {
    const opts = a.pattern === undefined ? {} : { pattern: a.pattern };
    return { keys: (await db.cacheKeys(a.namespace, opts)).map((k) => k.key) };
  },

  'cache.lPush': async (db, a) => ({ length: await db.cacheLPush(a.namespace, a.key, bufs(a.values)) }),
  'cache.rPush': async (db, a) => ({ length: await db.cacheRPush(a.namespace, a.key, bufs(a.values)) }),
  'cache.lPop': async (db, a) => value(await db.cacheLPop(a.namespace, a.key)),
  'cache.rPop': async (db, a) => value(await db.cacheRPop(a.namespace, a.key)),
  'cache.lRange': async (db, a) => ({
    values: (await db.cacheLRange(a.namespace, a.key, a.start, a.stop)).map((b) => b.toString('utf8')),
  }),
  'cache.lLen': async (db, a) => ({ length: await db.cacheLLen(a.namespace, a.key) }),
  'cache.lIndex': async (db, a) => value(await db.cacheLIndex(a.namespace, a.key, a.index)),

  'cache.sAdd': async (db, a) => ({ added: await db.cacheSAdd(a.namespace, a.key, bufs(a.members)) }),
  'cache.sRem': async (db, a) => ({ removed: await db.cacheSRem(a.namespace, a.key, bufs(a.members)) }),
  'cache.sIsMember': async (db, a) => ({
    isMember: await db.cacheSIsMember(a.namespace, a.key, Buffer.from(a.member, 'utf8')),
  }),
  'cache.sCard': async (db, a) => ({ cardinality: await db.cacheSCard(a.namespace, a.key) }),
  'cache.sMembers': async (db, a) => ({
    members: (await db.cacheSMembers(a.namespace, a.key)).map((b) => b.toString('utf8')),
  }),

  'cache.hSet': async (db, a) => ({ created: await db.cacheHSet(a.namespace, a.key, pairs(a.entries)) }),
  'cache.hGet': async (db, a) => value(await db.cacheHGet(a.namespace, a.key, Buffer.from(a.field, 'utf8'))),
  'cache.hDel': async (db, a) => ({ deleted: await db.cacheHDel(a.namespace, a.key, bufs(a.fields)) }),
  'cache.hGetAll': async (db, a) => ({
    entries: (await db.cacheHGetAll(a.namespace, a.key)).map((e) => [e[0].toString('utf8'), e[1].toString('utf8')]),
  }),
  'cache.hExists': async (db, a) => ({
    exists: await db.cacheHExists(a.namespace, a.key, Buffer.from(a.field, 'utf8')),
  }),
  'cache.hLen': async (db, a) => ({ length: await db.cacheHLen(a.namespace, a.key) }),

  'cache.xAdd': async (db, a) => ({ id: await db.cacheXAdd(a.namespace, a.key, pairs(a.fields)) }),
  'cache.xLen': async (db, a) => ({ length: await db.cacheXLen(a.namespace, a.key) }),
  'cache.xRange': async (db, a) => ({
    entries: (await db.cacheXRange(a.namespace, a.key, a.start, a.end)).map(entry),
  }),
  'cache.xRead': async (db, a, ctx) => ({
    entries: (await db.cacheXRead(a.namespace, a.key, ctx[a.afterStep].id)).map(entry),
  }),
  'cache.xDel': async (db, a, ctx) => ({
    deleted: await db.cacheXDel(a.namespace, a.key, a.idsFromSteps.map((s) => ctx[s].id)),
  }),
  'cache.xTrim': async (db, a) => ({ trimmed: await db.cacheXTrim(a.namespace, a.key, a.maxLen) }),
  // Consumer groups are refused by name by the server, so there is no typed
  // helper; the raw request path is how a user reaches the operation.
  'cache.xGroup': async (db, a) => {
    await db.request({ Cache: { XGroup: { namespace: a.namespace, key: a.key, command: a.command } } });
    return {};
  },

  'llm.schema': async (db, a) => ({ rendered: String(await db.llmSchema({ format: a.format })) }),
  'llm.context': async (db, a) => ({ rendered: String(await db.llmContext(a.sources, { format: a.format })) }),

  'admin.ping': async (db) => { await db.adminPing(); return {}; },
  'admin.status': async (db) => ({ status: await db.adminStatus() }),
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function emit(o) {
  process.stdout.write(`${JSON.stringify(o)}\n`);
}

async function main() {
  const [host, port, user, secret] = process.argv.slice(2);
  const scenario = JSON.parse(await readStdin());
  const db = await TriCore.connect({ host, port: Number(port), user, secret });
  const results = {};
  try {
    for (const step of scenario.steps) {
      const fn = ACTIONS[step.action];
      if (!fn) {
        emit({ id: step.id, status: 'unsupported', error: `no JS SDK method for action ${step.action}` });
        continue;
      }
      try {
        const out = await fn(db, step.args || {}, results);
        results[step.id] = out;
        emit({ id: step.id, status: 'ok', value: out });
      } catch (e) {
        emit({ id: step.id, status: 'error', error: `${e && e.constructor ? e.constructor.name : 'Error'}: ${e && e.message}` });
      }
    }
  } finally {
    await db.close().catch(() => {});
  }
}

main().catch((e) => {
  process.stderr.write(`js runner fatal: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
