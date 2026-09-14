import * as net from 'node:net';
import * as tls from 'node:tls';

import {
  CLOSE_TIMEOUT_MS,
  DEFAULT_PORT,
  FEATURES,
  FEATURE_CORRELATION_ID,
  FEATURE_SERVER_PARAMS,
  FEATURE_SESSION_TXN,
  HEADER_SIZE,
  MAX_CONTROL_FRAME_SIZE,
  MAX_SUPPORTED_FRAME_VERSION,
  PROTOCOL,
  TAG,
  VERSION,
  maxPayloadFor,
} from './constants.js';
import { AuthError, ProtocolError, Timeout, TriCoreError } from './errors.js';
import { DocFilter } from './builders.js';
import { buildTransactionScript, encodeBody, sqlOp } from './params.js';
import { Response, Rows, type RawResponse } from './results.js';
import { tlsConnectOptions } from './tls.js';
import {
  buffers,
  byteArrays,
  bytes,
  cacheValue,
  documentsData,
  errorFrame,
  jsonData,
  kindOf,
  llmSource,
  numbers,
  pairs,
  rendered,
  serverRefusal,
  streamEntries,
  textPairs,
} from './wire.js';
import type {
  AggregateStageValue,
  CacheBytes,
  CacheKeyInfo,
  CacheStreamEntry,
  ConnectOptions,
  DocumentAnalyzeResult,
  DocumentFilterValue,
  DocumentIndexInfo,
  DocumentUpdateSpec,
  GrantedFeatures,
  GraphDirection,
  GraphEdge,
  GraphEdgePage,
  GraphNeighbor,
  GraphNode,
  GraphNodePage,
  GraphPath,
  GraphQueryResult,
  GraphTraversal,
  GraphWeightedPath,
  Json,
  JsonObject,
  LlmOptions,
  LlmSource,
  SqlValue,
  TransactionStatement,
  TransactionSummary,
  VectorCollectionInfo,
  VectorHits,
  VectorItem,
  VectorMetric,
  VectorPage,
  VectorQuantization,
} from './types.js';

const PROCESS_STAMP = (() => {
  const [s, ns] = process.hrtime();
  return (BigInt(Date.now()) * 1000000n + BigInt(s % 1000) * 1000000n + BigInt(ns)).toString(16);
})();
let CONNECTION_SEQ = 0;

/**
 * Request ids must be unique across one principal's connections: the server's
 * cancel registry stops every entry matching (principal, request_id).
 */
function nextConnectionPrefix(): string {
  CONNECTION_SEQ += 1;
  return `${process.pid.toString(16)}${PROCESS_STAMP}${CONNECTION_SEQ.toString(16)}`;
}

interface Frame {
  tag: number;
  body: any;
}

interface Waiter {
  n: number;
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
}

type Socket = net.Socket | tls.TLSSocket;

/**
 * A connection to a TriCoreDB server.
 *
 * One connection is one request/response stream: await each call before the
 * next, or use a `Pool` for concurrency. Overlapping calls are refused by name.
 */
export class TriCore {
  private _socket: Socket | null;
  private _rid = 0;
  private readonly _ridPrefix = nextConnectionPrefix();
  private _txnOpen = false;
  private _inFlight = false;
  private _buf: Buffer = Buffer.alloc(0);
  private _waiters: Waiter[] = [];
  private _fatal: Error | null = null;

  /** The server session id, set after authentication. */
  sessionId: string | null = null;
  /** Server-side deadline in milliseconds applied to every request, or null. */
  requestTimeoutMs: number | null = null;
  /** Client-side reply deadline in milliseconds, or null (default) for none. */
  readTimeoutMs: number | null = null;
  /** The `request_id` most recently sent; pass it to `cancel()`. */
  lastRequestId: string | null = null;
  /** The feature bitmap the server granted in HELLO_OK. */
  grantedFeatures = 0;

  private constructor(socket: Socket) {
    this._socket = socket;
    socket.on('data', (chunk: Buffer) => this._onData(chunk));
    socket.on('error', (err: Error) => this._onFatal(new TriCoreError(`socket error: ${err.message}`)));
    socket.on('close', () => this._onFatal(new ProtocolError('connection closed mid-frame by the server')));
  }

  /** What the server granted in HELLO_OK, by name. */
  get features(): GrantedFeatures {
    const g = this.grantedFeatures || 0;
    return {
      mask: g,
      correlationId: (g & FEATURE_CORRELATION_ID) !== 0,
      serverParams: (g & FEATURE_SERVER_PARAMS) !== 0,
      sessionTxn: (g & FEATURE_SESSION_TXN) !== 0,
    };
  }

  /** True while a `begin()` block is open on this connection. */
  get inTransaction(): boolean {
    return this._txnOpen && this._socket !== null;
  }

  /** Connect, handshake, and (when `user` is given) authenticate. */
  static async connect(opts: ConnectOptions = {}): Promise<TriCore> {
    const {
      host = '127.0.0.1',
      port = DEFAULT_PORT,
      user = null,
      secret = '',
      clientName = 'tricoredb-js',
      timeout = 10000,
      readTimeoutMs = null,
      tls: tlsOpts = null,
      features = FEATURES,
    } = opts;

    const socket = await new Promise<Socket>((resolve, reject) => {
      const secure = tlsOpts !== null && tlsOpts !== undefined;
      let s: Socket;
      try {
        s = secure
          ? tls.connect({ host, port, ...tlsConnectOptions(tlsOpts) })
          : net.createConnection({ host, port });
      } catch (e) {
        reject(e);
        return;
      }
      const readyEvent = secure ? 'secureConnect' : 'connect';
      const onError = (err: Error): void => {
        s.destroy();
        reject(new TriCoreError(`connect failed: ${err.message}`));
      };
      const onTimeout = (): void => {
        s.destroy();
        reject(new TriCoreError(`connect to ${host}:${port} timed out`));
      };
      s.once('error', onError);
      if (timeout) s.setTimeout(timeout, onTimeout);
      s.once(readyEvent, () => {
        if (secure && (s as tls.TLSSocket).authorized === false && !tlsOpts.dangerAcceptInvalidCerts) {
          const why = (s as tls.TLSSocket).authorizationError || 'certificate verification failed';
          s.destroy();
          reject(new TriCoreError(`tls verification of \`${host}\` failed: ${String(why)}`));
          return;
        }
        s.removeListener('error', onError);
        s.setTimeout(0);
        s.setNoDelay(true);
        resolve(s);
      });
    });

    const db = new TriCore(socket);
    try {
      await db._hello(clientName, features);
      if (user !== null && user !== undefined) {
        await db.auth(user, secret || '');
      }
    } catch (err) {
      // Release the socket, or a failed AUTH keeps the event loop alive.
      db._socket = null;
      socket.destroy();
      throw err;
    }
    db.readTimeoutMs = readTimeoutMs;
    return db;
  }

  /** End the session politely, then drop the socket. Never throws. */
  async close(): Promise<void> {
    if (this._socket === null) return;
    let timer: NodeJS.Timeout | null = null;
    try {
      this._send(TAG.CLOSE, null);
      await Promise.race([
        this._recv(),
        new Promise((_r, reject) => {
          timer = setTimeout(() => reject(new TriCoreError('BYE timed out')), CLOSE_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } catch {
      // best-effort goodbye
    } finally {
      if (timer) clearTimeout(timer);
      const s = this._socket;
      this._socket = null;
      if (s) s.destroy();
    }
  }

  /** Transport-level liveness: a PING frame that never reaches a module. */
  async ping(): Promise<void> {
    const { tag } = await this._exchange(TAG.PING, null);
    if (tag !== TAG.PONG) throw new ProtocolError(`expected PONG, got tag ${tag}`);
  }

  async auth(user: string, secret: string): Promise<void> {
    const { tag, body } = await this._exchange(TAG.AUTH, {
      username: user,
      secret: Array.from(Buffer.from(secret, 'utf8')),
    });
    if (tag === TAG.ERROR) throw errorFrame(AuthError, body);
    if (tag !== TAG.AUTH_OK) throw new ProtocolError(`expected AUTH_OK, got tag ${tag}`);
    if (!body || !body.ok) throw new AuthError((body && body.message) || 'authentication refused');
    this.sessionId = body.session_id || null;
  }

  /**
   * Send a raw operation. Rejects unless the server reported `ok`:
   * `not_implemented` (a recognised hook that was not run) is a refusal too.
   */
  async request(op: Record<string, unknown>, database = 'main'): Promise<Response> {
    this._rid += 1;
    const requestId = `js-${this._ridPrefix}-${this._rid}`;
    this.lastRequestId = requestId;
    const payload: Record<string, unknown> = { request_id: requestId, database, op };
    if (this.requestTimeoutMs !== null && this.requestTimeoutMs !== undefined) {
      payload.options = { timeout_ms: this.requestTimeoutMs };
    }
    const { tag, body } = await this._exchange(TAG.REQUEST, payload);
    if (tag === TAG.ERROR) throw errorFrame(TriCoreError, body);
    if (tag !== TAG.RESPONSE) throw new ProtocolError(`expected RESPONSE, got tag ${tag}`);
    const resp = new Response(body as RawResponse);
    if (resp.status !== 'ok') throw serverRefusal(resp, this._txnOpen);
    return resp;
  }

  /**
   * Stop one of this principal's running statements by `request_id`. Send it
   * on a second connection. Resolves with how many were cancelled (0 if unknown).
   */
  async cancel(requestId: string): Promise<number> {
    const { tag, body } = await this._exchange(TAG.CANCEL, { request_id: requestId });
    if (tag === TAG.ERROR) throw errorFrame(TriCoreError, body);
    if (tag !== TAG.CANCEL_OK) throw new ProtocolError(`expected CANCEL_OK, got tag ${tag}`);
    return (body && body.cancelled) || 0;
  }

  // -- sql --------------------------------------------------------------------

  /** Run a write. `args` bind `?` placeholders server-side (requires SERVER_PARAMS). */
  execute(sql: string, database: string): Promise<Response>;
  execute(sql: string, args?: ReadonlyArray<SqlValue> | null, database?: string): Promise<Response>;
  async execute(
    sql: string,
    args: ReadonlyArray<SqlValue> | string | null = null,
    database = 'main',
  ): Promise<Response> {
    const [op, db] = sqlOp('Exec', sql, args, database, this.grantedFeatures);
    return this.request(op, db);
  }

  /** Run a read and return its rows. `args` bind `?` placeholders server-side. */
  query(sql: string, database: string): Promise<Rows>;
  query(sql: string, args?: ReadonlyArray<SqlValue> | null, database?: string): Promise<Rows>;
  async query(sql: string, args: ReadonlyArray<SqlValue> | string | null = null, database = 'main'): Promise<Rows> {
    const [op, db] = sqlOp('Query', sql, args, database, this.grantedFeatures);
    const resp = await this.request(op, db);
    const data = resp.data as Record<string, any> | null;
    if (data && typeof data === 'object' && 'Rows' in data) {
      const r = data.Rows || {};
      return new Rows(r.columns || [], r.rows || []);
    }
    throw new ProtocolError(`expected Rows, got ${kindOf(data)}`);
  }

  // -- cache ------------------------------------------------------------------

  /** Liveness through the cache core: proves auth, routing and dispatch. */
  async cachePing(database = 'main'): Promise<void> {
    await this.request({ Cache: 'Ping' }, database);
  }

  async cacheSet(namespace: string, key: string, value: CacheBytes, ttlMs: number | null = null, database = 'main'): Promise<void> {
    await this.request({ Cache: { Set: { namespace, key, value: bytes(value, 'value'), ttl_ms: ttlMs } } }, database);
  }

  /** The value as a Buffer, or null on a miss. */
  async cacheGet(namespace: string, key: string, database = 'main'): Promise<Buffer | null> {
    return cacheValue(await this.request({ Cache: { Get: { namespace, key } } }, database), 'get');
  }

  /** The value decoded as UTF-8, or null on a miss. */
  async cacheGetText(namespace: string, key: string, database = 'main'): Promise<string | null> {
    const v = await this.cacheGet(namespace, key, database);
    return v === null ? null : v.toString('utf8');
  }

  /** Whether the key existed. Deleting a missing key is not an error. */
  async cacheDelete(namespace: string, key: string, database = 'main'): Promise<boolean> {
    const resp = await this.request({ Cache: { Delete: { namespace, key } } }, database);
    return !!jsonData(resp, 'cache delete').deleted;
  }

  async cacheExists(namespace: string, key: string, database = 'main'): Promise<boolean> {
    const resp = await this.request({ Cache: { Exists: { namespace, key } } }, database);
    return !!jsonData(resp, 'cache exists').exists;
  }

  /** Remaining TTL in ms, or null when the key is missing or has no expiry. */
  async cacheTtl(namespace: string, key: string, database = 'main'): Promise<number | null> {
    const resp = await this.request({ Cache: { Ttl: { namespace, key } } }, database);
    const ttl = jsonData(resp, 'cache ttl').ttl_ms;
    return typeof ttl === 'number' ? ttl : null;
  }

  /** Delete every key in a namespace; resolves with how many were removed. */
  async cacheClearNamespace(namespace: string, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { ClearNamespace: { namespace } } }, database);
    return jsonData(resp, 'cache clear').cleared;
  }

  /** Add to a counter and resolve with the new value. */
  async cacheIncr(namespace: string, key: string, by = 1, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { Incr: { namespace, key, by } } }, database);
    return jsonData(resp, 'cache incr').value;
  }

  /** Set or replace a TTL. False when the key does not exist. */
  async cacheExpire(namespace: string, key: string, ttlMs: number, database = 'main'): Promise<boolean> {
    const resp = await this.request({ Cache: { Expire: { namespace, key, ttl_ms: ttlMs } } }, database);
    return !!jsonData(resp, 'cache expire').updated;
  }

  /** Drop a TTL. False when it had none. */
  async cachePersist(namespace: string, key: string, database = 'main'): Promise<boolean> {
    const resp = await this.request({ Cache: { Persist: { namespace, key } } }, database);
    return !!jsonData(resp, 'cache persist').persisted;
  }

  /** Set only if absent. */
  async cacheSetNx(namespace: string, key: string, value: CacheBytes, ttlMs: number | null = null, database = 'main'): Promise<boolean> {
    const resp = await this.request(
      { Cache: { SetNx: { namespace, key, value: bytes(value, 'value'), ttl_ms: ttlMs } } },
      database,
    );
    return !!jsonData(resp, 'cache setnx').set;
  }

  /** Live keys with remaining TTL and size. `pattern` is a `*` glob. */
  async cacheKeys(
    namespace: string,
    opts: { pattern?: string | null; limit?: number | null } = {},
    database = 'main',
  ): Promise<CacheKeyInfo[]> {
    const { pattern = null, limit = null } = opts;
    const resp = await this.request({ Cache: { Keys: { namespace, pattern, limit } } }, database);
    return jsonData(resp, 'cache keys').keys || [];
  }

  /** Prepend elements; resolves with the new length. */
  async cacheLPush(namespace: string, key: string, values: ReadonlyArray<CacheBytes>, database = 'main'): Promise<number> {
    return this._push('LPush', namespace, key, values, database);
  }

  /** Append elements; resolves with the new length. */
  async cacheRPush(namespace: string, key: string, values: ReadonlyArray<CacheBytes>, database = 'main'): Promise<number> {
    return this._push('RPush', namespace, key, values, database);
  }

  private async _push(variant: string, namespace: string, key: string, values: ReadonlyArray<CacheBytes>, database: string): Promise<number> {
    const resp = await this.request(
      { Cache: { [variant]: { namespace, key, values: byteArrays(values, 'values') } } },
      database,
    );
    return jsonData(resp, 'cache push').length;
  }

  async cacheLPop(namespace: string, key: string, database = 'main'): Promise<Buffer | null> {
    return cacheValue(await this.request({ Cache: { LPop: { namespace, key } } }, database), 'lpop');
  }

  async cacheRPop(namespace: string, key: string, database = 'main'): Promise<Buffer | null> {
    return cacheValue(await this.request({ Cache: { RPop: { namespace, key } } }, database), 'rpop');
  }

  /** Inclusive range; negative indices count from the end. */
  async cacheLRange(namespace: string, key: string, start: number, stop: number, database = 'main'): Promise<Buffer[]> {
    const resp = await this.request({ Cache: { LRange: { namespace, key, start, stop } } }, database);
    return buffers(jsonData(resp, 'cache lrange').values);
  }

  async cacheLLen(namespace: string, key: string, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { LLen: { namespace, key } } }, database);
    return jsonData(resp, 'cache llen').length;
  }

  async cacheLIndex(namespace: string, key: string, index: number, database = 'main'): Promise<Buffer | null> {
    return cacheValue(await this.request({ Cache: { LIndex: { namespace, key, index } } }, database), 'lindex');
  }

  async cacheSAdd(namespace: string, key: string, members: ReadonlyArray<CacheBytes>, database = 'main'): Promise<number> {
    const resp = await this.request(
      { Cache: { SAdd: { namespace, key, members: byteArrays(members, 'members') } } },
      database,
    );
    return jsonData(resp, 'cache sadd').added;
  }

  async cacheSRem(namespace: string, key: string, members: ReadonlyArray<CacheBytes>, database = 'main'): Promise<number> {
    const resp = await this.request(
      { Cache: { SRem: { namespace, key, members: byteArrays(members, 'members') } } },
      database,
    );
    return jsonData(resp, 'cache srem').removed;
  }

  async cacheSIsMember(namespace: string, key: string, member: CacheBytes, database = 'main'): Promise<boolean> {
    const resp = await this.request(
      { Cache: { SIsMember: { namespace, key, member: bytes(member, 'member') } } },
      database,
    );
    return !!jsonData(resp, 'cache sismember').is_member;
  }

  async cacheSCard(namespace: string, key: string, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { SCard: { namespace, key } } }, database);
    return jsonData(resp, 'cache scard').cardinality;
  }

  async cacheSMembers(namespace: string, key: string, database = 'main'): Promise<Buffer[]> {
    const resp = await this.request({ Cache: { SMembers: { namespace, key } } }, database);
    return buffers(jsonData(resp, 'cache smembers').members);
  }

  /** Set `[field, value]` pairs; resolves with how many were newly created. */
  async cacheHSet(
    namespace: string,
    key: string,
    entries: ReadonlyArray<readonly [CacheBytes, CacheBytes]>,
    database = 'main',
  ): Promise<number> {
    const resp = await this.request(
      { Cache: { HSet: { namespace, key, entries: pairs(entries, 'entries') } } },
      database,
    );
    return jsonData(resp, 'cache hset').created;
  }

  async cacheHSetText(namespace: string, key: string, obj: Record<string, string>, database = 'main'): Promise<number> {
    return this.cacheHSet(namespace, key, textPairs(obj), database);
  }

  async cacheHGet(namespace: string, key: string, field: CacheBytes, database = 'main'): Promise<Buffer | null> {
    return cacheValue(
      await this.request({ Cache: { HGet: { namespace, key, field: bytes(field, 'field') } } }, database),
      'hget',
    );
  }

  async cacheHDel(namespace: string, key: string, fields: ReadonlyArray<CacheBytes>, database = 'main'): Promise<number> {
    const resp = await this.request(
      { Cache: { HDel: { namespace, key, fields: byteArrays(fields, 'fields') } } },
      database,
    );
    return jsonData(resp, 'cache hdel').deleted;
  }

  async cacheHGetAll(namespace: string, key: string, database = 'main'): Promise<[Buffer, Buffer][]> {
    const resp = await this.request({ Cache: { HGetAll: { namespace, key } } }, database);
    const entries: [number[], number[]][] = jsonData(resp, 'cache hgetall').entries || [];
    return entries.map((e): [Buffer, Buffer] => [Buffer.from(e[0]), Buffer.from(e[1])]);
  }

  async cacheHExists(namespace: string, key: string, field: CacheBytes, database = 'main'): Promise<boolean> {
    const resp = await this.request(
      { Cache: { HExists: { namespace, key, field: bytes(field, 'field') } } },
      database,
    );
    return !!jsonData(resp, 'cache hexists').exists;
  }

  async cacheHLen(namespace: string, key: string, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { HLen: { namespace, key } } }, database);
    return jsonData(resp, 'cache hlen').length;
  }

  /** Append a stream entry; `id` null/`'*'` auto-generates. Resolves with the assigned id. */
  async cacheXAdd(
    namespace: string,
    key: string,
    fields: ReadonlyArray<readonly [CacheBytes, CacheBytes]>,
    id: string | null = null,
    database = 'main',
  ): Promise<string> {
    const resp = await this.request(
      { Cache: { XAdd: { namespace, key, id, fields: pairs(fields, 'fields') } } },
      database,
    );
    return jsonData(resp, 'cache xadd').id;
  }

  async cacheXAddText(namespace: string, key: string, obj: Record<string, string>, id: string | null = null, database = 'main'): Promise<string> {
    return this.cacheXAdd(namespace, key, textPairs(obj), id, database);
  }

  async cacheXLen(namespace: string, key: string, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { XLen: { namespace, key } } }, database);
    return jsonData(resp, 'cache xlen').length;
  }

  /** Entries in an inclusive id range; `-` and `+` are min and max. */
  async cacheXRange(
    namespace: string,
    key: string,
    start = '-',
    end = '+',
    count: number | null = null,
    database = 'main',
  ): Promise<CacheStreamEntry[]> {
    const resp = await this.request({ Cache: { XRange: { namespace, key, start, end, count } } }, database);
    return streamEntries(jsonData(resp, 'cache xrange'));
  }

  /** Entries strictly newer than `after`. Never blocks. */
  async cacheXRead(
    namespace: string,
    key: string,
    after = '0-0',
    count: number | null = null,
    database = 'main',
  ): Promise<CacheStreamEntry[]> {
    const resp = await this.request({ Cache: { XRead: { namespace, key, after, count } } }, database);
    return streamEntries(jsonData(resp, 'cache xread'));
  }

  async cacheXDel(namespace: string, key: string, ids: ReadonlyArray<string>, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { XDel: { namespace, key, ids } } }, database);
    return jsonData(resp, 'cache xdel').deleted;
  }

  async cacheXTrim(namespace: string, key: string, maxLen: number, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { XTrim: { namespace, key, max_len: maxLen } } }, database);
    return jsonData(resp, 'cache xtrim').trimmed;
  }

  // -- document ---------------------------------------------------------------

  async documentCreateCollection(collection: string, database = 'main'): Promise<void> {
    await this.request({ Document: { CreateCollection: { collection } } }, database);
  }

  /** Insert a document; resolves with the stored id. A duplicate id is an error. */
  async documentInsert(collection: string, document: JsonObject, opts: { id?: string | null } = {}, database = 'main'): Promise<string> {
    const { id = null } = opts;
    const resp = await this.request({ Document: { Insert: { collection, id, document } } }, database);
    return jsonData(resp, 'document insert').id;
  }

  /** The document, or null when no document has that id. */
  async documentGet(collection: string, id: string, database = 'main'): Promise<JsonObject | null> {
    const resp = await this.request({ Document: { Get: { collection, id } } }, database);
    const docs = documentsData<JsonObject>(resp, 'document get');
    return docs.length ? (docs[0] as JsonObject) : null;
  }

  async documentFind(
    collection: string,
    filter: DocumentFilterValue = DocFilter.all(),
    opts: { limit?: number | null } = {},
    database = 'main',
  ): Promise<JsonObject[]> {
    const { limit = null } = opts;
    const resp = await this.request({ Document: { Find: { collection, filter, limit } } }, database);
    return documentsData<JsonObject>(resp, 'document find');
  }

  /** Set fields by dot path. Not an upsert. */
  async documentUpdate(collection: string, id: string, set: Record<string, Json>, database = 'main'): Promise<void> {
    await this.request({ Document: { Update: { collection, id, set } } }, database);
  }

  async documentUpdateOne(
    collection: string,
    id: string,
    update: DocumentUpdateSpec,
    opts: { upsert?: boolean } = {},
    database = 'main',
  ): Promise<{ updated: boolean; inserted: boolean; id: string }> {
    const { upsert = false } = opts;
    const resp = await this.request(
      { Document: { UpdateOne: { collection, id, update: normalizeUpdate(update), upsert } } },
      database,
    );
    const j = jsonData(resp, 'document updateOne');
    return { updated: !!j.updated, inserted: !!j.inserted, id: j.id };
  }

  async documentUpdateMany(
    collection: string,
    filter: DocumentFilterValue,
    update: DocumentUpdateSpec,
    database = 'main',
  ): Promise<{ matched: number; modified: number }> {
    const resp = await this.request(
      { Document: { UpdateMany: { collection, filter, update: normalizeUpdate(update) } } },
      database,
    );
    const j = jsonData(resp, 'document updateMany');
    return { matched: j.matched, modified: j.modified };
  }

  async documentDelete(collection: string, id: string, database = 'main'): Promise<void> {
    await this.request({ Document: { Delete: { collection, id } } }, database);
  }

  async documentListCollections(database = 'main'): Promise<string[]> {
    const resp = await this.request({ Document: 'ListCollections' }, database);
    return jsonData(resp, 'document listCollections').collections || [];
  }

  async documentDropCollection(collection: string, database = 'main'): Promise<void> {
    await this.request({ Document: { DropCollection: { collection } } }, database);
  }

  async documentCreateIndex(
    collection: string,
    indexName: string,
    field: string,
    opts: { unique?: boolean } = {},
    database = 'main',
  ): Promise<void> {
    const { unique = false } = opts;
    await this.request({ Document: { CreateIndex: { collection, index_name: indexName, field, unique } } }, database);
  }

  async documentDropIndex(collection: string, indexName: string, database = 'main'): Promise<void> {
    await this.request({ Document: { DropIndex: { collection, index_name: indexName } } }, database);
  }

  async documentListIndexes(collection: string, database = 'main'): Promise<DocumentIndexInfo[]> {
    const resp = await this.request({ Document: { ListIndexes: { collection } } }, database);
    return jsonData(resp, 'document listIndexes').indexes || [];
  }

  async documentAnalyze(collection: string, database = 'main'): Promise<DocumentAnalyzeResult> {
    const resp = await this.request({ Document: { Analyze: { collection } } }, database);
    return jsonData(resp, 'document analyze');
  }

  /** Run an aggregation pipeline built with `DocStage`. */
  async documentAggregate(collection: string, pipeline: AggregateStageValue[], database = 'main'): Promise<JsonObject[]> {
    const resp = await this.request({ Document: { Aggregate: { collection, pipeline } } }, database);
    return documentsData<JsonObject>(resp, 'document aggregate');
  }

  // -- vector -----------------------------------------------------------------

  async vectorCreateCollection(
    collection: string,
    dimension: number,
    opts: { metric?: VectorMetric; quantization?: VectorQuantization } = {},
    database = 'main',
  ): Promise<void> {
    const { metric = 'cosine', quantization = 'none' } = opts;
    await this.request({ Vector: { CreateCollection: { collection, dimension, metric, quantization } } }, database);
  }

  /** Insert or replace a vector; resolves with its id. */
  async vectorUpsert(
    collection: string,
    id: string,
    vector: ArrayLike<number>,
    metadata: Json = null,
    database = 'main',
  ): Promise<string> {
    const resp = await this.request(
      { Vector: { Upsert: { collection, id, vector: numbers(vector), metadata } } },
      database,
    );
    return jsonData(resp, 'vector upsert').id;
  }

  async vectorGet(collection: string, id: string, database = 'main'): Promise<VectorItem | null> {
    const resp = await this.request({ Vector: { Get: { collection, id } } }, database);
    const j = jsonData(resp, 'vector get');
    return j === null || j === undefined ? null : j;
  }

  async vectorDelete(collection: string, id: string, database = 'main'): Promise<void> {
    await this.request({ Vector: { Delete: { collection, id } } }, database);
  }

  /** Nearest neighbours, best first. `opts.filter` is a flat equality map on metadata. */
  async vectorSearch(
    collection: string,
    vector: ArrayLike<number>,
    topK: number,
    opts: { filter?: Record<string, Json> | null } = {},
    database = 'main',
  ): Promise<VectorHits> {
    const { filter = null } = opts;
    const resp = await this.request(
      { Vector: { Search: { collection, vector: numbers(vector), top_k: topK, filter } } },
      database,
    );
    const j = jsonData(resp, 'vector search');
    const results = j.results || [];
    Object.defineProperty(results, 'index', { value: j.index, enumerable: false });
    return results as VectorHits;
  }

  async vectorListCollections(database = 'main'): Promise<string[]> {
    const resp = await this.request({ Vector: 'ListCollections' }, database);
    return jsonData(resp, 'vector listCollections').collections || [];
  }

  async vectorDescribeCollection(collection: string, database = 'main'): Promise<VectorCollectionInfo> {
    const resp = await this.request({ Vector: { DescribeCollection: { collection } } }, database);
    return jsonData(resp, 'vector describeCollection');
  }

  /** A page of stored vectors; `truncated` says whether more remain. */
  async vectorListVectors(
    collection: string,
    opts: { limit?: number | null; offset?: number | null } = {},
    database = 'main',
  ): Promise<VectorPage> {
    const { limit = null, offset = null } = opts;
    const resp = await this.request({ Vector: { ListVectors: { collection, limit, offset } } }, database);
    return jsonData(resp, 'vector listVectors');
  }

  async vectorDropCollection(collection: string, database = 'main'): Promise<void> {
    await this.request({ Vector: { DropCollection: { collection } } }, database);
  }

  // -- graph ------------------------------------------------------------------

  async graphCreate(graph: string, database = 'main'): Promise<void> {
    await this.request({ Graph: { CreateGraph: { graph } } }, database);
  }

  async graphAddNode(
    graph: string,
    id: string,
    opts: { labels?: string[]; properties?: Json } = {},
    database = 'main',
  ): Promise<string> {
    const { labels = [], properties = null } = opts;
    const resp = await this.request({ Graph: { AddNode: { graph, id, labels, properties } } }, database);
    return jsonData(resp, 'graph addNode').id;
  }

  async graphGetNode(graph: string, id: string, database = 'main'): Promise<GraphNode | null> {
    const resp = await this.request({ Graph: { GetNode: { graph, id } } }, database);
    const j = jsonData(resp, 'graph getNode');
    return j === null || j === undefined ? null : j;
  }

  /** Add an edge; both endpoints must exist. */
  async graphAddEdge(
    graph: string,
    id: string,
    from: string,
    to: string,
    label: string,
    opts: { properties?: Json } = {},
    database = 'main',
  ): Promise<string> {
    const { properties = null } = opts;
    const resp = await this.request({ Graph: { AddEdge: { graph, id, from, to, label, properties } } }, database);
    return jsonData(resp, 'graph addEdge').id;
  }

  async graphGetEdge(graph: string, id: string, database = 'main'): Promise<GraphEdge | null> {
    const resp = await this.request({ Graph: { GetEdge: { graph, id } } }, database);
    const j = jsonData(resp, 'graph getEdge');
    return j === null || j === undefined ? null : j;
  }

  async graphNeighbors(
    graph: string,
    nodeId: string,
    opts: { direction?: GraphDirection; label?: string | null; limit?: number | null } = {},
    database = 'main',
  ): Promise<GraphNeighbor[]> {
    const { direction = 'outgoing', label = null, limit = null } = opts;
    const resp = await this.request(
      { Graph: { Neighbors: { graph, node_id: nodeId, direction, label, limit } } },
      database,
    );
    return jsonData(resp, 'graph neighbors').neighbors || [];
  }

  async graphDeleteNode(graph: string, id: string, database = 'main'): Promise<void> {
    await this.request({ Graph: { DeleteNode: { graph, id } } }, database);
  }

  async graphDeleteEdge(graph: string, id: string, database = 'main'): Promise<void> {
    await this.request({ Graph: { DeleteEdge: { graph, id } } }, database);
  }

  async graphListGraphs(database = 'main'): Promise<string[]> {
    const resp = await this.request({ Graph: 'ListGraphs' }, database);
    return jsonData(resp, 'graph listGraphs').graphs || [];
  }

  async graphDrop(graph: string, database = 'main'): Promise<void> {
    await this.request({ Graph: { DropGraph: { graph } } }, database);
  }

  /** Bounded BFS. The server clamps `maxDepth` and `limit` and echoes the bounds used. */
  async graphTraverse(
    graph: string,
    start: string,
    opts: { direction?: GraphDirection; label?: string | null; maxDepth?: number | null; limit?: number | null } = {},
    database = 'main',
  ): Promise<GraphTraversal> {
    const { direction = 'outgoing', label = null, maxDepth = null, limit = null } = opts;
    const resp = await this.request(
      { Graph: { Traverse: { graph, start, direction, label, max_depth: maxDepth, limit } } },
      database,
    );
    return jsonData(resp, 'graph traverse');
  }

  /** Fewest hops. No path is `found: false`, not an error. */
  async graphShortestPath(
    graph: string,
    from: string,
    to: string,
    opts: { direction?: GraphDirection; label?: string | null; maxDepth?: number | null } = {},
    database = 'main',
  ): Promise<GraphPath> {
    const { direction = 'outgoing', label = null, maxDepth = null } = opts;
    const resp = await this.request(
      { Graph: { ShortestPath: { graph, from, to, direction, label, max_depth: maxDepth } } },
      database,
    );
    return jsonData(resp, 'graph shortestPath');
  }

  /** Least summed edge weight (`weightProperty`, default `weight`). */
  async graphWeightedShortestPath(
    graph: string,
    from: string,
    to: string,
    opts: { direction?: GraphDirection; label?: string | null; weightProperty?: string | null } = {},
    database = 'main',
  ): Promise<GraphWeightedPath> {
    const { direction = 'outgoing', label = null, weightProperty = null } = opts;
    const resp = await this.request(
      {
        Graph: {
          WeightedShortestPath: { graph, from, to, direction, label, weight_property: weightProperty },
        },
      },
      database,
    );
    return jsonData(resp, 'graph weightedShortestPath');
  }

  async graphDegree(graph: string, nodeId: string, opts: { direction?: GraphDirection } = {}, database = 'main'): Promise<number> {
    const { direction = 'outgoing' } = opts;
    const resp = await this.request({ Graph: { Degree: { graph, node_id: nodeId, direction } } }, database);
    return jsonData(resp, 'graph degree').degree;
  }

  async graphListNodes(
    graph: string,
    opts: { limit?: number | null; offset?: number | null } = {},
    database = 'main',
  ): Promise<GraphNodePage> {
    const { limit = null, offset = null } = opts;
    const resp = await this.request({ Graph: { ListNodes: { graph, limit, offset } } }, database);
    return jsonData(resp, 'graph listNodes');
  }

  async graphListEdges(
    graph: string,
    opts: { limit?: number | null; offset?: number | null } = {},
    database = 'main',
  ): Promise<GraphEdgePage> {
    const { limit = null, offset = null } = opts;
    const resp = await this.request({ Graph: { ListEdges: { graph, limit, offset } } }, database);
    return jsonData(resp, 'graph listEdges');
  }

  /** Read-only Cypher subset; unsupported clauses are refused by name. */
  async graphQuery(graph: string, cypher: string, database = 'main'): Promise<GraphQueryResult> {
    const resp = await this.request({ Graph: { Query: { graph, cypher } } }, database);
    return jsonData(resp, 'graph query');
  }

  // -- llm --------------------------------------------------------------------

  /** Assemble a read-only context bundle. Text for `toon`/`markdown`, JSON otherwise. */
  async llmContext(sources: LlmSource | LlmSource[], opts: LlmOptions = {}, database = 'main'): Promise<any> {
    const { format = 'toon', maxRows = null, redactSensitive = true, includeSchema = false } = opts;
    const wire = (Array.isArray(sources) ? sources : [sources]).map(llmSource);
    if (wire.length === 0) throw new TriCoreError('a context bundle needs at least one source');
    const resp = await this.request(
      {
        Llm: {
          Context: {
            sources: wire,
            format,
            options: { max_rows: maxRows, redact_sensitive: redactSensitive, include_schema: includeSchema },
          },
        },
      },
      database,
    );
    return rendered(resp);
  }

  /** Export the schema catalog: SQL tables plus document collections. */
  async llmSchema(opts: LlmOptions = {}, database = 'main'): Promise<any> {
    const { format = 'toon', maxRows = null, redactSensitive = true, includeSchema = false } = opts;
    const resp = await this.request(
      {
        Llm: {
          Schema: {
            format,
            options: { max_rows: maxRows, redact_sensitive: redactSensitive, include_schema: includeSchema },
          },
        },
      },
      database,
    );
    return rendered(resp);
  }

  // -- admin ------------------------------------------------------------------

  /** Round-trip through the full request pipeline. */
  async adminPing(database = 'main'): Promise<void> {
    await this.request({ Admin: 'Ping' }, database);
  }

  /** Server status from the cluster core. */
  async adminStatus(database = 'main'): Promise<Record<string, any>> {
    const resp = await this.request({ Admin: 'Status' }, database);
    const data = resp.data as Record<string, unknown> | null;
    if (data && typeof data === 'object' && 'Message' in data) return { message: data.Message };
    return jsonData(resp, 'admin status');
  }

  // -- transactions -----------------------------------------------------------

  /**
   * Run a pre-declared script atomically in one request (`BEGIN; ...; COMMIT`).
   * Works on every node, including those that withhold SESSION_TXN. Arguments
   * in `[sql, args]` entries are rendered with `bindParams`.
   */
  async transaction(statements: ReadonlyArray<TransactionStatement>, database = 'main'): Promise<TransactionSummary> {
    const resp = await this.execute(buildTransactionScript(statements), null, database);
    return jsonData(resp, 'transaction');
  }

  /**
   * Open a session transaction on this connection. Refuses by name when the
   * server did not grant SESSION_TXN; it never falls back to autocommit.
   */
  async begin(database = 'main'): Promise<TransactionSummary> {
    if ((this.grantedFeatures & FEATURE_SESSION_TXN) === 0) {
      const err = new TriCoreError(
        'this server did not grant session transactions (SESSION_TXN is not in the granted ' +
          'feature set), so begin()/commit()/rollback() cannot open a rollback boundary on this ' +
          'connection; use transaction([...]) to send the whole unit as one ' +
          '`BEGIN; <statements>; COMMIT` request',
      );
      err.notSent = true;
      throw err;
    }
    return this._txnControl('BEGIN', database);
  }

  async commit(database = 'main'): Promise<TransactionSummary> {
    return this._txnControl('COMMIT', database);
  }

  async rollback(database = 'main'): Promise<TransactionSummary> {
    return this._txnControl('ROLLBACK', database);
  }

  /** `begin()`, run `fn(this)`, `commit()`; on a throw, roll back and rethrow the original error. */
  async withTransaction<T>(fn: (db: TriCore) => Promise<T> | T, database = 'main'): Promise<T> {
    if (typeof fn !== 'function') throw new TriCoreError('withTransaction(fn) needs a callback');
    await this.begin(database);
    let result: T;
    try {
      result = await fn(this);
    } catch (e) {
      if (this.inTransaction) await this.rollback(database).catch(() => undefined);
      throw e;
    }
    await this.commit(database);
    return result;
  }

  private async _txnControl(keyword: 'BEGIN' | 'COMMIT' | 'ROLLBACK', database: string): Promise<TransactionSummary> {
    let resp: Response;
    try {
      resp = await this.request({ Sql: { Exec: { sql: keyword } } }, database);
    } catch (e) {
      if (keyword !== 'BEGIN' && !(e && (e as TriCoreError).notSent)) this._txnOpen = false;
      throw e;
    }
    this._txnOpen = keyword === 'BEGIN';
    return jsonData(resp, keyword);
  }

  // -- transport --------------------------------------------------------------

  private async _hello(clientName: string, features: number = FEATURES): Promise<void> {
    const { tag, body } = await this._exchange(TAG.HELLO, {
      protocol: PROTOCOL,
      version: { major: VERSION, minor: 0 },
      client: clientName,
      features,
    });
    if (tag === TAG.ERROR) throw errorFrame(ProtocolError, body);
    if (tag !== TAG.HELLO_OK) throw new ProtocolError(`expected HELLO_OK, got tag ${tag}`);
    if (!body || !body.ok) throw new ProtocolError((body && body.message) || 'handshake refused');
    this.grantedFeatures = Number(body.features || 0);
  }

  /** One frame out, its reply in. A second overlapping call is refused, not queued. */
  private async _exchange(tag: number, payload: unknown): Promise<Frame> {
    if (this._inFlight) {
      const err = new TriCoreError(
        'a request is already in flight on this connection. A TriCore connection is a single ' +
          'request/response stream: overlapping requests interleave frames and deadlock. Await ' +
          'each call before the next, or use a Pool for real concurrency.',
      );
      err.notSent = true;
      throw err;
    }
    this._inFlight = true;
    try {
      this._send(tag, payload);
      const ms = this.readTimeoutMs;
      if (ms === null || ms === undefined) return await this._recv();
      let timer: NodeJS.Timeout | null = null;
      try {
        return await Promise.race([
          this._recv(),
          new Promise<Frame>((_r, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  this._poison(
                    new Timeout(
                      `no reply within ${ms}ms; the connection is closed because the reply may still ` +
                        "be in flight and would be read as the next request's answer",
                    ),
                  ),
                ),
              ms,
            );
            timer.unref();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      this._inFlight = false;
    }
  }

  private _send(tag: number, payload: unknown): void {
    if (this._socket === null) {
      const err = new TriCoreError('connection is closed');
      err.notSent = true;
      throw err;
    }
    const body =
      payload === null || payload === undefined ? Buffer.alloc(0) : Buffer.from(encodeBody(payload), 'utf8');
    // An oversized REQUEST is left for the server to refuse by name.
    if (tag !== TAG.REQUEST && body.length > MAX_CONTROL_FRAME_SIZE) {
      throw new ProtocolError(
        `refusing to send a ${body.length}-byte control frame (tag ${tag}); the protocol caps ` +
          `control frames at ${MAX_CONTROL_FRAME_SIZE} bytes`,
      );
    }
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt8(VERSION, 0);
    header.writeUInt8(tag, 1);
    header.writeUInt32BE(body.length, 2);
    this._socket.write(Buffer.concat([header, body]));
  }

  private async _recv(): Promise<Frame> {
    const head = await this._readExactly(HEADER_SIZE);
    const version = head.readUInt8(0);
    const tag = head.readUInt8(1);
    const length = head.readUInt32BE(2);
    if (version > MAX_SUPPORTED_FRAME_VERSION) {
      throw this._poison(
        new ProtocolError(
          `frame header version ${version} is newer than this driver can read ` +
            `(max ${MAX_SUPPORTED_FRAME_VERSION})`,
        ),
      );
    }
    const limit = maxPayloadFor(tag);
    if (length > limit) {
      throw this._poison(
        new ProtocolError(
          `frame (tag ${tag}) declares a ${length}-byte payload, above the ${limit}-byte limit for ` +
            'that frame; refusing to buffer it',
        ),
      );
    }
    const body = length ? await this._readExactly(length) : Buffer.alloc(0);
    return { tag, body: body.length ? JSON.parse(body.toString('utf8')) : null };
  }

  /** Record `err` as fatal, drop the socket, and return the error. */
  private _poison(err: Error): Error {
    this._onFatal(err);
    const s = this._socket;
    this._socket = null;
    if (s) s.destroy();
    return err;
  }

  private _readExactly(n: number): Promise<Buffer> {
    if (this._fatal) return Promise.reject(this._fatal);
    if (this._buf.length >= n) {
      const out = this._buf.subarray(0, n);
      this._buf = this._buf.subarray(n);
      return Promise.resolve(out);
    }
    return new Promise((resolve, reject) => {
      this._waiters.push({ n, resolve, reject });
    });
  }

  private _onData(chunk: Buffer): void {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (this._waiters.length && this._buf.length >= (this._waiters[0] as Waiter).n) {
      const { n, resolve } = this._waiters.shift() as Waiter;
      const out = this._buf.subarray(0, n);
      this._buf = this._buf.subarray(n);
      resolve(out);
    }
  }

  private _onFatal(err: Error): void {
    if (this._fatal) return;
    this._fatal = err;
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w.reject(err);
  }
}

function normalizeUpdate(update: DocumentUpdateSpec | null | undefined): { set: Record<string, Json>; inc: Record<string, number> } {
  const { set = {}, inc = {} } = update || {};
  return { set, inc };
}

/** Shorthand for `TriCore.connect(opts)`. */
export function connect(opts?: ConnectOptions): Promise<TriCore> {
  return TriCore.connect(opts);
}
