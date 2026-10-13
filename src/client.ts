import * as net from 'node:net';
import * as tls from 'node:tls';

import {
  CLOSE_TIMEOUT_MS,
  DEFAULT_PORT,
  FEATURES,
  FOLLOW_CONNECT_TIMEOUT_MS,
  FEATURE_CORRELATION_ID,
  FEATURE_SERVER_PARAMS,
  FEATURE_SESSION_TXN,
  HEADER_SIZE,
  MAX_CONTROL_FRAME_SIZE,
  MAX_LEADER_RETRY_DELAY_MS,
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
  cacheEntries,
  cacheValue,
  cacheValues,
  documentsData,
  errorFrame,
  freshValue,
  given,
  jsonData,
  kindOf,
  llmSource,
  numbers,
  pairs,
  rendered,
  scoreBound,
  scoredMembers,
  scoredResults,
  searchOptions,
  serverRefusal,
  streamEntries,
  textPairs,
  vectorList,
} from './wire.js';
import type {
  AggregateStageValue,
  BulkOpValue,
  CacheBitOp,
  CacheBytes,
  CacheExpireAtResult,
  CacheExpiryValue,
  CacheFreshRead,
  CacheFreshWrite,
  CacheKeyInfo,
  CacheListEnd,
  CacheListPop,
  CacheLock,
  CacheLockRenewal,
  CacheNamespaceLimit,
  CacheOpResult,
  CacheOpValue,
  CachePollResult,
  CacheScoreBound,
  CacheScoredMember,
  CacheScoredMemberInput,
  CacheScriptLoaded,
  CacheScriptRun,
  CacheSetCondition,
  CacheStats,
  CacheStreamEntry,
  CacheSwapResult,
  CacheTrimResult,
  CacheWarmResult,
  CacheZAddResult,
  ConnectOptions,
  DocumentAnalyzeResult,
  DocumentBulkResult,
  DocumentCollectionOptions,
  DocumentCommitResult,
  DocumentExplain,
  DocumentFilterValue,
  DocumentIndexInfo,
  DocumentOptionsUpdate,
  DocumentPurgeResult,
  DocumentRebuildResult,
  DocumentRenameResult,
  DocumentReplaceResult,
  DocumentReturn,
  DocumentSortKey,
  DocumentUpdateSpec,
  GrantedFeatures,
  GraphAllPaths,
  GraphBatchResult,
  GraphCentrality,
  GraphCentralityMeasure,
  GraphCommitResult,
  GraphCommunities,
  GraphComponents,
  GraphConsistency,
  GraphConstraintKind,
  GraphConstraintTarget,
  GraphCopyResult,
  GraphCycle,
  GraphDfsResult,
  GraphDirection,
  GraphEdge,
  GraphEdgeInput,
  GraphEdgePage,
  GraphFoundNodes,
  GraphNeighbor,
  GraphNode,
  GraphNodeInput,
  GraphNodePage,
  GraphPageRank,
  GraphPath,
  GraphPaths,
  GraphQueryResult,
  GraphRemoveResult,
  GraphSchemaInfo,
  GraphSchemaObjects,
  GraphSimilarity,
  GraphStats,
  GraphSubgraph,
  GraphTraversal,
  GraphTriangles,
  GraphWeightedPath,
  GraphWriteResult,
  Json,
  JsonObject,
  LlmOptions,
  LlmSource,
  SqlValue,
  TransactionStatement,
  TransactionSummary,
  VectorAlias,
  VectorCollectionConfig,
  VectorCollectionInfo,
  VectorEmbedding,
  VectorExample,
  VectorExampleHits,
  VectorHits,
  VectorIndexStats,
  VectorItem,
  VectorMetric,
  VectorMultiHits,
  VectorPage,
  VectorPartitions,
  VectorQuantization,
  VectorRebuildResult,
  VectorRecall,
  VectorRenameResult,
  VectorSearchHit,
  VectorSearchOptions,
  VectorTextItem,
  VectorUpsertItem,
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `host:port` or `[v6]:port`, as a `leader_hint` names it; null if it is neither. */
function splitAddress(address: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(address) || /^([^:]+):(\d+)$/.exec(address);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1] as string, port } : null;
}

function joinAddress(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

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
  private _opts: ConnectOptions = {};
  private _address = '';

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
  /**
   * The open document or graph transaction, or null. While it is set, every
   * request on this connection carries it as `options.txn` and so runs inside
   * that transaction. `documentBeginTransaction` and `graphBeginTransaction`
   * set it; the matching commit and rollback clear it.
   */
  txn: string | null = null;

  private constructor(socket: Socket) {
    this._socket = socket;
    this._bind(socket);
  }

  /** Listen on `socket` for as long as it is this connection's socket. */
  private _bind(socket: Socket): void {
    const mine = (): boolean => this._socket === socket;
    socket.on('data', (chunk: Buffer) => {
      if (mine()) this._onData(chunk);
    });
    socket.on('error', (err: Error) => {
      if (mine()) this._onFatal(new TriCoreError(`socket error: ${err.message}`));
    });
    socket.on('close', () => {
      if (mine()) this._onFatal(new ProtocolError('connection closed mid-frame by the server'));
    });
  }

  /** The `host:port` this connection is talking to. It changes when the driver follows the leader. */
  get address(): string {
    return this._address;
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
    db._opts = { ...opts };
    db._address = joinAddress(host, port);
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
    const options: Record<string, unknown> = {};
    if (this.requestTimeoutMs !== null && this.requestTimeoutMs !== undefined) {
      options.timeout_ms = this.requestTimeoutMs;
    }
    if (this.txn !== null && this.txn !== undefined) options.txn = this.txn;
    if (Object.keys(options).length > 0) payload.options = options;
    const follow = this._opts.followLeader !== false;
    const retries = Math.max(0, this._opts.leaderRetries ?? 5);
    let pause = Math.max(0, this._opts.leaderRetryDelayMs ?? 250);
    for (let retried = 0; ; retried += 1) {
      const { tag, body } = await this._exchange(TAG.REQUEST, payload);
      if (tag === TAG.ERROR) throw errorFrame(TriCoreError, body);
      if (tag !== TAG.RESPONSE) throw new ProtocolError(`expected RESPONSE, got tag ${tag}`);
      const resp = new Response(body as RawResponse);
      if (resp.status === 'ok') return resp;
      // A `not_leader` refusal was applied nowhere, so sending it again cannot
      // apply it twice. A session transaction belongs to this connection and
      // cannot move.
      if (!(follow && resp.isRedirect && !this._txnOpen && this.txn === null && retried < retries)) {
        throw serverRefusal(resp, this._txnOpen, follow ? retried : null);
      }
      const hint = resp.leaderHint;
      if (hint && hint !== this._address && (await this._moveTo(hint))) continue;
      await sleep(pause);
      pause = Math.min(Math.max(pause * 2, 1), MAX_LEADER_RETRY_DELAY_MS);
    }
  }

  /**
   * Replace this connection with one to `address`, authenticated as this one
   * was. False, with this connection untouched, when that fails.
   */
  private async _moveTo(address: string): Promise<boolean> {
    const target = splitAddress(address);
    if (!target) return false;
    const o = this._opts;
    const connectTimeout = o.timeout ? Math.min(o.timeout, FOLLOW_CONNECT_TIMEOUT_MS) : FOLLOW_CONNECT_TIMEOUT_MS;
    let fresh: TriCore;
    try {
      fresh = await TriCore.connect({
        ...o,
        host: target.host,
        port: target.port,
        timeout: connectTimeout,
        // The leader's certificate is checked against the name the hint gives.
        tls: o.tls ? { ...o.tls, serverName: target.host } : o.tls,
      });
    } catch {
      return false;
    }
    const socket = fresh._socket as Socket;
    fresh._socket = null;
    const old = this._socket;
    this._socket = socket;
    this._bind(socket);
    this._buf = fresh._buf;
    this._waiters = [];
    this._fatal = null;
    this.sessionId = fresh.sessionId;
    this.grantedFeatures = fresh.grantedFeatures;
    this._address = address;
    if (old) old.destroy();
    return true;
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

  // -- cache: server 0.1.0-rc.3 and later ---------------------------------------

  /** Write a value that reads as fresh for `freshMs`, then as stale until its TTL (if any) ends. */
  async cacheSetFresh(
    namespace: string,
    key: string,
    value: CacheBytes,
    freshMs: number,
    ttlMs: number | null = null,
    database = 'main',
  ): Promise<CacheFreshWrite> {
    const resp = await this.request(
      { Cache: { SetFresh: { namespace, key, value: bytes(value, 'value'), fresh_ms: freshMs, ttl_ms: ttlMs } } },
      database,
    );
    const j = jsonData(resp, 'cache setFresh');
    return { set: !!j.set, freshUntilMs: j.freshUntilMs };
  }

  /**
   * Read with stale-while-revalidate and stampede protection. On a `miss`,
   * `lease` is true for the one caller (`owner`) that should compute the
   * value; on `stale`, `refresh` is true for the one that should refresh it.
   */
  async cacheGetFresh(namespace: string, key: string, owner: string, leaseMs: number, database = 'main'): Promise<CacheFreshRead> {
    const resp = await this.request({ Cache: { GetFresh: { namespace, key, owner, lease_ms: leaseMs } } }, database);
    const j = jsonData(resp, 'cache getFresh');
    return {
      state: j.state,
      value: freshValue(j),
      refresh: !!j.refresh,
      lease: !!j.lease,
      retryAfterMs: typeof j.retryAfterMs === 'number' ? j.retryAfterMs : null,
    };
  }

  /** Negative caching: remember for `ttlMs` that the source has no value for `key`. */
  async cacheSetMissing(namespace: string, key: string, ttlMs: number, database = 'main'): Promise<void> {
    await this.request({ Cache: { SetMissing: { namespace, key, ttl_ms: ttlMs } } }, database);
  }

  /** Write the `[key, value]` entries that are not already cached, leaving live values alone. */
  async cacheWarm(
    namespace: string,
    entries: ReadonlyArray<readonly [string, CacheBytes]>,
    ttlMs: number | null = null,
    database = 'main',
  ): Promise<CacheWarmResult> {
    const resp = await this.request(
      { Cache: { Warm: { namespace, entries: cacheEntries(entries, 'entries'), ttl_ms: ttlMs } } },
      database,
    );
    const j = jsonData(resp, 'cache warm');
    return { written: j.written, alreadyCached: j.alreadyCached };
  }

  /** Many values in one round trip, positionally: null where a key is absent. Not a snapshot. */
  async cacheMGet(namespace: string, keys: ReadonlyArray<string>, database = 'main'): Promise<(Buffer | null)[]> {
    return cacheValues(await this.request({ Cache: { MGet: { namespace, keys } } }, database), 'mget');
  }

  /** Write `[key, value]` entries as one batch; resolves with how many. A repeated key is refused. */
  async cacheMSet(
    namespace: string,
    entries: ReadonlyArray<readonly [string, CacheBytes]>,
    ttlMs: number | null = null,
    database = 'main',
  ): Promise<number> {
    const resp = await this.request(
      { Cache: { MSet: { namespace, entries: cacheEntries(entries, 'entries'), ttl_ms: ttlMs } } },
      database,
    );
    return jsonData(resp, 'cache mset').set;
  }

  /**
   * Write under a condition, with explicit control of the expiry (see
   * `CacheExpiry`). False means the condition was not met, not that it failed.
   */
  async cacheSetIf(
    namespace: string,
    key: string,
    value: CacheBytes,
    condition: CacheSetCondition,
    expiry: CacheExpiryValue = 'Clear',
    database = 'main',
  ): Promise<boolean> {
    const resp = await this.request(
      { Cache: { SetIf: { namespace, key, value: bytes(value, 'value'), condition, expiry } } },
      database,
    );
    return !!jsonData(resp, 'cache setIf').set;
  }

  /** Add scored members to a sorted set, or re-score ones already there. A NaN score is refused. */
  async cacheZAdd(
    namespace: string,
    key: string,
    members: ReadonlyArray<CacheScoredMemberInput>,
    database = 'main',
  ): Promise<CacheZAddResult> {
    const resp = await this.request(
      { Cache: { ZAdd: { namespace, key, members: scoredMembers(members, 'members') } } },
      database,
    );
    const j = jsonData(resp, 'cache zadd');
    return { added: j.added, updated: j.updated };
  }

  async cacheZRem(namespace: string, key: string, members: ReadonlyArray<CacheBytes>, database = 'main'): Promise<number> {
    const resp = await this.request(
      { Cache: { ZRem: { namespace, key, members: byteArrays(members, 'members') } } },
      database,
    );
    return jsonData(resp, 'cache zrem').removed;
  }

  /** The member's score, or null when it is not in the set. */
  async cacheZScore(namespace: string, key: string, member: CacheBytes, database = 'main'): Promise<number | null> {
    const resp = await this.request(
      { Cache: { ZScore: { namespace, key, member: bytes(member, 'member') } } },
      database,
    );
    const score = jsonData(resp, 'cache zscore').score;
    return typeof score === 'number' ? score : null;
  }

  async cacheZCard(namespace: string, key: string, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { ZCard: { namespace, key } } }, database);
    return jsonData(resp, 'cache zcard').cardinality;
  }

  /** The member's position, or null when absent. `rev` counts from the high-scoring end. */
  async cacheZRank(
    namespace: string,
    key: string,
    member: CacheBytes,
    opts: { rev?: boolean } = {},
    database = 'main',
  ): Promise<number | null> {
    const resp = await this.request(
      { Cache: { ZRank: { namespace, key, member: bytes(member, 'member'), rev: !!opts.rev } } },
      database,
    );
    const rank = jsonData(resp, 'cache zrank').rank;
    return typeof rank === 'number' ? rank : null;
  }

  /** Members by rank, `start..=stop` inclusive; negative indices count from the end. */
  async cacheZRange(
    namespace: string,
    key: string,
    start: number,
    stop: number,
    opts: { rev?: boolean } = {},
    database = 'main',
  ): Promise<Buffer[]> {
    const resp = await this.request(
      { Cache: { ZRange: { namespace, key, start, stop, rev: !!opts.rev, with_scores: false } } },
      database,
    );
    return buffers(jsonData(resp, 'cache zrange').members);
  }

  /** `cacheZRange`, with each member's score. */
  async cacheZRangeWithScores(
    namespace: string,
    key: string,
    start: number,
    stop: number,
    opts: { rev?: boolean } = {},
    database = 'main',
  ): Promise<CacheScoredMember[]> {
    const resp = await this.request(
      { Cache: { ZRange: { namespace, key, start, stop, rev: !!opts.rev, with_scores: true } } },
      database,
    );
    return scoredResults(jsonData(resp, 'cache zrange').members);
  }

  /**
   * Members by score between two bounds: a number (inclusive) or
   * `{ value, exclusive }`. `-Infinity` and `Infinity` leave an end open.
   * `limit` is `[offset, count]`, applied after the range is selected.
   */
  async cacheZRangeByScore(
    namespace: string,
    key: string,
    min: number | CacheScoreBound,
    max: number | CacheScoreBound,
    opts: { rev?: boolean; limit?: readonly [number, number] | null } = {},
    database = 'main',
  ): Promise<Buffer[]> {
    const resp = await this.request(this._zRangeByScore(namespace, key, min, max, opts, false), database);
    return buffers(jsonData(resp, 'cache zrangeByScore').members);
  }

  /** `cacheZRangeByScore`, with each member's score. */
  async cacheZRangeByScoreWithScores(
    namespace: string,
    key: string,
    min: number | CacheScoreBound,
    max: number | CacheScoreBound,
    opts: { rev?: boolean; limit?: readonly [number, number] | null } = {},
    database = 'main',
  ): Promise<CacheScoredMember[]> {
    const resp = await this.request(this._zRangeByScore(namespace, key, min, max, opts, true), database);
    return scoredResults(jsonData(resp, 'cache zrangeByScore').members);
  }

  private _zRangeByScore(
    namespace: string,
    key: string,
    min: number | CacheScoreBound,
    max: number | CacheScoreBound,
    opts: { rev?: boolean; limit?: readonly [number, number] | null },
    withScores: boolean,
  ): Record<string, unknown> {
    return {
      Cache: {
        ZRangeByScore: {
          namespace,
          key,
          min: scoreBound(min, 'min'),
          max: scoreBound(max, 'max'),
          rev: !!opts.rev,
          with_scores: withScores,
          limit: opts.limit ? [opts.limit[0], opts.limit[1]] : null,
        },
      },
    };
  }

  /** Add `by` to a member's score, creating it at `by` when absent; resolves with the new score. */
  async cacheZIncrBy(namespace: string, key: string, member: CacheBytes, by: number, database = 'main'): Promise<number> {
    const resp = await this.request(
      { Cache: { ZIncrBy: { namespace, key, member: bytes(member, 'member'), by } } },
      database,
    );
    return jsonData(resp, 'cache zincrby').score;
  }

  /**
   * Take a lease on a lock, or refresh one `owner` already holds (same token).
   * Pass the fencing `token` to the resource the lock protects.
   */
  async cacheLockAcquire(namespace: string, key: string, owner: string, ttlMs: number, database = 'main'): Promise<CacheLock> {
    const resp = await this.request({ Cache: { LockAcquire: { namespace, key, owner, ttl_ms: ttlMs } } }, database);
    const j = jsonData(resp, 'cache lockAcquire');
    return {
      acquired: !!j.acquired,
      token: typeof j.token === 'number' ? j.token : null,
      holder: typeof j.holder === 'string' ? j.holder : null,
      expiresAtMs: typeof j.expiresAtMs === 'number' ? j.expiresAtMs : null,
    };
  }

  /** Extend a lease still held. Not renewed once it has lapsed, even if nobody else took the lock. */
  async cacheLockRenew(namespace: string, key: string, owner: string, ttlMs: number, database = 'main'): Promise<CacheLockRenewal> {
    const resp = await this.request({ Cache: { LockRenew: { namespace, key, owner, ttl_ms: ttlMs } } }, database);
    const j = jsonData(resp, 'cache lockRenew');
    return {
      renewed: !!j.renewed,
      token: typeof j.token === 'number' ? j.token : null,
      expiresAtMs: typeof j.expiresAtMs === 'number' ? j.expiresAtMs : null,
    };
  }

  /** Give up a lock. Only the current, live holder can; false otherwise. */
  async cacheLockRelease(namespace: string, key: string, owner: string, database = 'main'): Promise<boolean> {
    const resp = await this.request({ Cache: { LockRelease: { namespace, key, owner } } }, database);
    return !!jsonData(resp, 'cache lockRelease').released;
  }

  /** Set one bit, numbered from the most significant bit of byte 0; resolves with its old value (0 or 1). */
  async cacheSetBit(namespace: string, key: string, offset: number, value: boolean, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { SetBit: { namespace, key, offset, value: !!value } } }, database);
    return jsonData(resp, 'cache setBit').previous;
  }

  /** One bit (0 or 1). Past the end of the value, and on a missing key, every bit is 0. */
  async cacheGetBit(namespace: string, key: string, offset: number, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { GetBit: { namespace, key, offset } } }, database);
    return jsonData(resp, 'cache getBit').bit;
  }

  /** Count the set bits, optionally within a `[start, end]` range of **bytes** (negative counts from the end). */
  async cacheBitCount(
    namespace: string,
    key: string,
    range: readonly [number, number] | null = null,
    database = 'main',
  ): Promise<number> {
    const resp = await this.request(
      { Cache: { BitCount: { namespace, key, range: range ? [range[0], range[1]] : null } } },
      database,
    );
    return jsonData(resp, 'cache bitCount').count;
  }

  /** The position of the first bit equal to `bit`, optionally within a byte range, or -1. */
  async cacheBitPos(
    namespace: string,
    key: string,
    bit: boolean,
    range: readonly [number, number] | null = null,
    database = 'main',
  ): Promise<number> {
    const resp = await this.request(
      { Cache: { BitPos: { namespace, key, bit: !!bit, range: range ? [range[0], range[1]] : null } } },
      database,
    );
    return jsonData(resp, 'cache bitPos').position;
  }

  /** Combine values bitwise into `dest`; resolves with the result's length in bytes. */
  async cacheBitOp(namespace: string, op: CacheBitOp, dest: string, keys: ReadonlyArray<string>, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { BitOp: { namespace, op, dest, keys } } }, database);
    return jsonData(resp, 'cache bitOp').length;
  }

  /** Add elements to a HyperLogLog; resolves with whether its estimate may have moved. */
  async cachePfAdd(namespace: string, key: string, elements: ReadonlyArray<CacheBytes>, database = 'main'): Promise<boolean> {
    const resp = await this.request(
      { Cache: { PfAdd: { namespace, key, elements: byteArrays(elements, 'elements') } } },
      database,
    );
    return !!jsonData(resp, 'cache pfAdd').changed;
  }

  /** Estimated distinct elements; with several keys, of their union. */
  async cachePfCount(namespace: string, keys: ReadonlyArray<string>, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { PfCount: { namespace, keys } } }, database);
    return jsonData(resp, 'cache pfCount').count;
  }

  /** Merge HyperLogLogs into `dest`, which counts as a source when it already exists. */
  async cachePfMerge(namespace: string, dest: string, sources: ReadonlyArray<string>, database = 'main'): Promise<void> {
    await this.request({ Cache: { PfMerge: { namespace, dest, sources } } }, database);
  }

  /** Atomically move one element between list ends; null when `source` is empty. */
  async cacheLMove(
    namespace: string,
    source: string,
    destination: string,
    from: CacheListEnd,
    to: CacheListEnd,
    database = 'main',
  ): Promise<Buffer | null> {
    return cacheValue(
      await this.request({ Cache: { LMove: { namespace, source, destination, from, to } } }, database),
      'lmove',
    );
  }

  /** Set the absolute instant (Unix epoch ms) a live key dies. A deadline already passed deletes it. */
  async cacheExpireAt(namespace: string, key: string, atMs: number, database = 'main'): Promise<CacheExpireAtResult> {
    const resp = await this.request({ Cache: { ExpireAt: { namespace, key, at_ms: atMs } } }, database);
    const j = jsonData(resp, 'cache expireAt');
    return { updated: !!j.updated, deleted: !!j.deleted };
  }

  /** Lookup hits and misses, the memory budget and the eviction policy of the node reached. */
  async cacheStats(database = 'main'): Promise<CacheStats> {
    return jsonData(await this.request({ Cache: 'Stats' }, database), 'cache stats');
  }

  /** Delete every cache key in `database`, across every namespace; resolves with how many. */
  async cacheFlushDatabase(database = 'main'): Promise<number> {
    return jsonData(await this.request({ Cache: 'FlushDatabase' }, database), 'cache flushDatabase').cleared;
  }

  /** Concatenate bytes onto a key (created when missing); resolves with the new length. */
  async cacheAppend(namespace: string, key: string, value: CacheBytes, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { Append: { namespace, key, value: bytes(value, 'value') } } }, database);
    return jsonData(resp, 'cache append').length;
  }

  /**
   * Write only if the key still holds `expected` (null: must be absent).
   * `value` null deletes the key. On a mismatch nothing is written.
   */
  async cacheCompareAndSwap(
    namespace: string,
    key: string,
    expected: CacheBytes | null,
    value: CacheBytes | null,
    ttlMs: number | null = null,
    database = 'main',
  ): Promise<CacheSwapResult> {
    const resp = await this.request(
      {
        Cache: {
          CompareAndSwap: {
            namespace,
            key,
            expected: expected === null ? null : bytes(expected, 'expected'),
            value: value === null ? null : bytes(value, 'value'),
            ttl_ms: ttlMs,
          },
        },
      },
      database,
    );
    const j = jsonData(resp, 'cache compareAndSwap');
    return {
      swapped: !!j.swapped,
      current: typeof j.current === 'string' ? Buffer.from(j.current, 'utf8') : null,
      currentIsBinary: !!j.currentIsBinary,
    };
  }

  /** Read a key and delete it in one atomic step. */
  async cacheGetDel(namespace: string, key: string, database = 'main'): Promise<Buffer | null> {
    return cacheValue(await this.request({ Cache: { GetDel: { namespace, key } } }, database), 'getdel');
  }

  /** Write a value and resolve with the one it replaced. The old TTL is dropped. */
  async cacheGetSet(namespace: string, key: string, value: CacheBytes, ttlMs: number | null = null, database = 'main'): Promise<Buffer | null> {
    return cacheValue(
      await this.request(
        { Cache: { GetSet: { namespace, key, value: bytes(value, 'value'), ttl_ms: ttlMs } } },
        database,
      ),
      'getset',
    );
  }

  /** Read a key and change its expiry (see `CacheExpiry`) in the same atomic step. */
  async cacheGetEx(namespace: string, key: string, expiry: CacheExpiryValue, database = 'main'): Promise<Buffer | null> {
    return cacheValue(await this.request({ Cache: { GetEx: { namespace, key, expiry } } }, database), 'getex');
  }

  /** Keep only the inclusive index range of a list. */
  async cacheLTrim(namespace: string, key: string, start: number, stop: number, database = 'main'): Promise<CacheTrimResult> {
    const resp = await this.request({ Cache: { LTrim: { namespace, key, start, stop } } }, database);
    const j = jsonData(resp, 'cache ltrim');
    return { length: j.length, removed: j.removed };
  }

  /** Every member of every named set. A missing key is the empty set. */
  async cacheSUnion(namespace: string, keys: ReadonlyArray<string>, database = 'main'): Promise<Buffer[]> {
    const resp = await this.request({ Cache: { SUnion: { namespace, keys } } }, database);
    return buffers(jsonData(resp, 'cache sunion').members);
  }

  /** The members present in every named set. */
  async cacheSInter(namespace: string, keys: ReadonlyArray<string>, database = 'main'): Promise<Buffer[]> {
    const resp = await this.request({ Cache: { SInter: { namespace, keys } } }, database);
    return buffers(jsonData(resp, 'cache sinter').members);
  }

  /** The members of the first set that are in none of the rest. */
  async cacheSDiff(namespace: string, keys: ReadonlyArray<string>, database = 'main'): Promise<Buffer[]> {
    const resp = await this.request({ Cache: { SDiff: { namespace, keys } } }, database);
    return buffers(jsonData(resp, 'cache sdiff').members);
  }

  /**
   * Random members, without removing them. `count` null: at most one;
   * positive: up to that many distinct; negative: exactly that many, repeats allowed.
   */
  async cacheSRandMember(namespace: string, key: string, count: number | null = null, database = 'main'): Promise<Buffer[]> {
    const resp = await this.request({ Cache: { SRandMember: { namespace, key, count } } }, database);
    return buffers(jsonData(resp, 'cache srandmember').members);
  }

  /** Add `by` to one hash field (ASCII decimal; a missing field starts at 0); resolves with the new value. */
  async cacheHIncrBy(namespace: string, key: string, field: CacheBytes, by = 1, database = 'main'): Promise<number> {
    const resp = await this.request(
      { Cache: { HIncrBy: { namespace, key, field: bytes(field, 'field'), by } } },
      database,
    );
    return jsonData(resp, 'cache hincrby').value;
  }

  /**
   * Run cache operations in order in one round trip, each as if sent alone. A
   * failing one does not stop the rest. Each operation is in the server's wire
   * form, e.g. `{ Get: { namespace, key } }`, and so is each result.
   */
  async cachePipeline(ops: ReadonlyArray<CacheOpValue>, database = 'main'): Promise<CacheOpResult[]> {
    const resp = await this.request({ Cache: { Pipeline: { ops } } }, database);
    return jsonData(resp, 'cache pipeline').results || [];
  }

  /**
   * `cachePipeline` with no other writer interleaving. Every operation is
   * checked before any runs; after that there is no rollback.
   */
  async cacheTransaction(ops: ReadonlyArray<CacheOpValue>, database = 'main'): Promise<CacheOpResult[]> {
    const resp = await this.request({ Cache: { Transaction: { ops } } }, database);
    return jsonData(resp, 'cache transaction').results || [];
  }

  /** Store a script: operations run as one transaction, with `$1`, `$2`, ... replaced by its arguments. */
  async cacheScriptLoad(name: string, ops: ReadonlyArray<CacheOpValue>, database = 'main'): Promise<CacheScriptLoaded> {
    const resp = await this.request({ Cache: { ScriptLoad: { name, ops } } }, database);
    const j = jsonData(resp, 'cache scriptLoad');
    return { loaded: j.loaded, ops: j.ops };
  }

  /** Run a stored script with `args` as one transaction. */
  async cacheScriptRun(name: string, args: ReadonlyArray<string> = [], database = 'main'): Promise<CacheScriptRun> {
    const resp = await this.request({ Cache: { ScriptRun: { name, args } } }, database);
    const j = jsonData(resp, 'cache scriptRun');
    return { results: j.results || [], ops: j.ops || [] };
  }

  /**
   * The most frequently addressed keys on the node. The server refuses this
   * unless `[cache] hot_keys` is set, and the response is handed over as is.
   */
  async cacheHotKeys(opts: { limit?: number | null } = {}, database = 'main'): Promise<Json> {
    const resp = await this.request({ Cache: { HotKeys: given({ limit: opts.limit }) } }, database);
    return jsonData(resp, 'cache hotKeys');
  }

  /** Delete every expired cache key in `database` now; resolves with how many. */
  async cachePurgeExpired(database = 'main'): Promise<number> {
    return jsonData(await this.request({ Cache: 'PurgeExpired' }, database), 'cache purgeExpired').purged;
  }

  /**
   * Pop the head of the first non-empty list among `keys`, waiting up to
   * `timeoutMs`; null when the wait ran out. A `readTimeoutMs` shorter than
   * the wait closes the connection first.
   */
  async cacheBLPop(namespace: string, keys: ReadonlyArray<string>, timeoutMs: number, database = 'main'): Promise<CacheListPop | null> {
    return this._blockingPop('BLPop', namespace, keys, timeoutMs, database);
  }

  /** `cacheBLPop` from the tail. */
  async cacheBRPop(namespace: string, keys: ReadonlyArray<string>, timeoutMs: number, database = 'main'): Promise<CacheListPop | null> {
    return this._blockingPop('BRPop', namespace, keys, timeoutMs, database);
  }

  private async _blockingPop(
    variant: string,
    namespace: string,
    keys: ReadonlyArray<string>,
    timeoutMs: number,
    database: string,
  ): Promise<CacheListPop | null> {
    const resp = await this.request({ Cache: { [variant]: { namespace, keys, timeout_ms: timeoutMs } } }, database);
    const [key, value] = cacheValues(resp, variant.toLowerCase());
    if (key === null || key === undefined || value === null || value === undefined) return null;
    return { key: key.toString('utf8'), value };
  }

  /** Cap a namespace at `maxKeys` live keys and `maxBytes` of values. Neither given removes the limit. */
  async cacheSetNamespaceLimit(
    namespace: string,
    opts: { maxKeys?: number | null; maxBytes?: number | null } = {},
    database = 'main',
  ): Promise<CacheNamespaceLimit> {
    const resp = await this.request(
      { Cache: { SetNamespaceLimit: { namespace, ...given({ max_keys: opts.maxKeys, max_bytes: opts.maxBytes }) } } },
      database,
    );
    return jsonData(resp, 'cache setNamespaceLimit');
  }

  /** A namespace's limit and what it holds now. */
  async cacheGetNamespaceLimit(namespace: string, database = 'main'): Promise<CacheNamespaceLimit> {
    const resp = await this.request({ Cache: { GetNamespaceLimit: { namespace } } }, database);
    return jsonData(resp, 'cache getNamespaceLimit');
  }

  /** Append a message to a channel; resolves with its id. */
  async cachePublish(channel: string, message: string, database = 'main'): Promise<number> {
    const resp = await this.request({ Cache: { Publish: { channel, message } } }, database);
    return jsonData(resp, 'cache publish').id;
  }

  /**
   * The messages after id `after` on `channels` (a trailing `*` is a pattern).
   * Never blocks; pass the result's `next` as the following `after`.
   */
  async cachePoll(
    channels: ReadonlyArray<string>,
    opts: { after?: number; limit?: number } = {},
    database = 'main',
  ): Promise<CachePollResult> {
    const resp = await this.request(
      { Cache: { Poll: { channels, ...given({ after: opts.after, limit: opts.limit }) } } },
      database,
    );
    const j = jsonData(resp, 'cache poll');
    return { messages: j.messages || [], next: j.next };
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

  // -- document: server 0.1.0-rc.3 and later ------------------------------------

  /**
   * Swap a document's whole body: anything not in `document` is gone.
   * `return` hands back the document as it was `'Before'` or is `'After'`;
   * `expectedVersion` applies only on a versioned collection.
   */
  async documentReplace(
    collection: string,
    id: string,
    document: JsonObject,
    opts: { upsert?: boolean; return?: DocumentReturn; expectedVersion?: number | null } = {},
    database = 'main',
  ): Promise<DocumentReplaceResult> {
    const body: Record<string, unknown> = { collection, id, document, upsert: !!opts.upsert };
    if (opts.return !== undefined && opts.return !== 'None') body.return = opts.return;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== null) body.expected_version = opts.expectedVersion;
    const resp = await this.request({ Document: { Replace: body } }, database);
    const j = jsonData(resp, 'document replace');
    const out: DocumentReplaceResult = { replaced: !!j.replaced, inserted: !!j.inserted, id: j.id };
    if (j.document !== undefined) out.document = j.document;
    return out;
  }

  /**
   * Insert several documents as one atomic batch; resolves with their ids in
   * order. Each id is the document's own `_id`, or generated.
   */
  async documentInsertMany(collection: string, documents: ReadonlyArray<JsonObject>, database = 'main'): Promise<string[]> {
    const resp = await this.request({ Document: { InsertMany: { collection, documents } } }, database);
    return jsonData(resp, 'document insertMany').ids || [];
  }

  /** Delete every document matching `filter`; resolves with how many. */
  async documentDeleteMany(collection: string, filter: DocumentFilterValue, database = 'main'): Promise<number> {
    const resp = await this.request({ Document: { DeleteMany: { collection, filter } } }, database);
    return jsonData(resp, 'document deleteMany').deleted;
  }

  /** Move a collection, its documents and its indexes to a new name. Refused when `to` exists. */
  async documentRenameCollection(collection: string, to: string, database = 'main'): Promise<DocumentRenameResult> {
    const resp = await this.request({ Document: { RenameCollection: { collection, to } } }, database);
    return jsonData(resp, 'document renameCollection');
  }

  /** Delete the documents a TTL index says have expired, now. */
  async documentPurgeExpired(collection: string, database = 'main'): Promise<DocumentPurgeResult> {
    const resp = await this.request({ Document: { PurgeExpired: { collection } } }, database);
    const j = jsonData(resp, 'document purgeExpired');
    return { purged: j.purged, more: !!j.more };
  }

  /** Run a find and describe how it ran instead of returning its documents. */
  async documentExplain(
    collection: string,
    filter: DocumentFilterValue = DocFilter.all(),
    opts: { limit?: number | null; sort?: ReadonlyArray<DocumentSortKey>; skip?: number | null } = {},
    database = 'main',
  ): Promise<DocumentExplain> {
    const resp = await this.request(
      {
        Document: {
          Explain: { collection, filter, ...given({ limit: opts.limit, sort: opts.sort, skip: opts.skip }) },
        },
      },
      database,
    );
    return jsonData(resp, 'document explain');
  }

  /**
   * Open a document transaction and make it this connection's `txn`: every
   * later request reads and writes inside it until it is committed or rolled
   * back. Snapshot isolation, or with `serializable` its reads are validated
   * at commit. Resolves with the transaction id.
   */
  async documentBeginTransaction(opts: { serializable?: boolean } = {}, database = 'main'): Promise<string> {
    this._refuseSecondTxn();
    const resp = await this.request({ Document: { BeginTransaction: { serializable: !!opts.serializable } } }, database);
    const txn: string = jsonData(resp, 'document beginTransaction').txn;
    this.txn = txn;
    return txn;
  }

  /**
   * Commit this connection's `txn`: every write lands as one batch, or a
   * conflict is thrown and nothing lands. After a refusal the transaction is
   * still open on the server; roll it back.
   */
  async documentCommitTransaction(database = 'main'): Promise<DocumentCommitResult> {
    const resp = await this.request({ Document: 'CommitTransaction' }, database);
    this.txn = null;
    const j = jsonData(resp, 'document commitTransaction');
    return { committed: !!j.committed, writes: j.writes };
  }

  /** Discard this connection's `txn`. */
  async documentRollbackTransaction(database = 'main'): Promise<void> {
    await this._endTxn({ Document: 'RollbackTransaction' }, database);
  }

  /** Rebuild one index from the stored documents. */
  async documentRebuildIndex(collection: string, indexName: string, database = 'main'): Promise<DocumentRebuildResult> {
    const resp = await this.request({ Document: { RebuildIndex: { collection, index_name: indexName } } }, database);
    return jsonData(resp, 'document rebuildIndex');
  }

  /**
   * Set a collection's schema, defaults and versioning, replacing any it had.
   * Refused when an existing document would break the new schema.
   */
  async documentSetCollectionOptions(
    collection: string,
    options: DocumentCollectionOptions,
    database = 'main',
  ): Promise<DocumentOptionsUpdate> {
    const resp = await this.request({ Document: { SetCollectionOptions: { collection, options } } }, database);
    return jsonData(resp, 'document setCollectionOptions');
  }

  async documentGetCollectionOptions(collection: string, database = 'main'): Promise<DocumentCollectionOptions> {
    const resp = await this.request({ Document: { GetCollectionOptions: { collection } } }, database);
    return jsonData(resp, 'document getCollectionOptions').options || {};
  }

  /**
   * Many inserts, updates, replaces and deletes on one collection, built with
   * `DocBulk` and applied in order as one atomic batch.
   */
  async documentBulkWrite(collection: string, ops: ReadonlyArray<BulkOpValue>, database = 'main'): Promise<DocumentBulkResult> {
    const resp = await this.request({ Document: { BulkWrite: { collection, ops } } }, database);
    return jsonData(resp, 'document bulkWrite');
  }

  /** `txn` holds one transaction at a time; a second begin would lose track of the first. */
  private _refuseSecondTxn(): void {
    if (this.txn === null || this.txn === undefined) return;
    const err = new TriCoreError(
      `transaction \`${this.txn}\` is already open on this connection; commit it or roll it back ` +
        'first, or set `txn = null` to leave it open and begin another',
    );
    err.notSent = true;
    throw err;
  }

  /** Send a rollback. Whatever the server answers, the transaction is over for this connection. */
  private async _endTxn(op: Record<string, unknown>, database: string): Promise<Response> {
    let resp: Response;
    try {
      resp = await this.request(op, database);
    } catch (e) {
      if (!(e && (e as TriCoreError).notSent)) this.txn = null;
      throw e;
    }
    this.txn = null;
    return resp;
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

  /**
   * Nearest neighbours, best first. `opts.filter` is a flat equality map on
   * metadata. The other options (`using` for a named vector, `offset`,
   * `exact`, ...) need server 0.1.0-rc.3 or later.
   */
  async vectorSearch(
    collection: string,
    vector: ArrayLike<number>,
    topK: number,
    opts: VectorSearchOptions & { filter?: Record<string, Json> | null } = {},
    database = 'main',
  ): Promise<VectorHits> {
    const { filter = null } = opts;
    const resp = await this.request(
      { Vector: { Search: { collection, vector: numbers(vector), top_k: topK, filter, ...searchOptions(opts) } } },
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

  // -- vector: server 0.1.0-rc.3 and later --------------------------------------

  /** Embed texts with the server's built-in embedder (feature hashing: lexical, no model). Nothing is stored. */
  async vectorEmbed(texts: ReadonlyArray<string>, dimension: number, database = 'main'): Promise<VectorEmbedding> {
    const resp = await this.request({ Vector: { Embed: { texts, dimension } } }, database);
    return jsonData(resp, 'vector embed');
  }

  /**
   * Embed each text at the collection's dimension and upsert the vectors as
   * one atomic batch; resolves with how many. The text is kept in the metadata
   * under `text`.
   */
  async vectorUpsertText(collection: string, items: ReadonlyArray<VectorTextItem>, database = 'main'): Promise<number> {
    const wire = items.map((i) => ({ id: i.id, text: i.text, metadata: i.metadata === undefined ? null : i.metadata }));
    const resp = await this.request({ Vector: { UpsertText: { collection, items: wire } } }, database);
    return jsonData(resp, 'vector upsertText').upserted;
  }

  /** Point an alias at a collection; `collection` null removes it. */
  async vectorSetAlias(alias: string, collection: string | null, database = 'main'): Promise<void> {
    await this.request({ Vector: { SetAlias: { alias, collection } } }, database);
  }

  async vectorListAliases(database = 'main'): Promise<VectorAlias[]> {
    const resp = await this.request({ Vector: 'ListAliases' }, database);
    return jsonData(resp, 'vector listAliases').aliases || [];
  }

  /** Declare a second vector per item, with its own dimension and metric, searched with `using`. */
  async vectorAddNamedVector(
    collection: string,
    name: string,
    dimension: number,
    metric: VectorMetric = 'cosine',
    database = 'main',
  ): Promise<void> {
    await this.request({ Vector: { AddNamedVector: { collection, name, dimension, metric } } }, database);
  }

  /** Write an item's vectors by name (`default` is the collection's own); resolves with its id. */
  async vectorUpsertNamed(
    collection: string,
    id: string,
    vectors: Record<string, ArrayLike<number>>,
    metadata: Json = null,
    database = 'main',
  ): Promise<string> {
    const wire: Record<string, number[]> = {};
    for (const [name, v] of Object.entries(vectors)) wire[name] = numbers(v);
    const resp = await this.request({ Vector: { UpsertNamed: { collection, id, vectors: wire, metadata } } }, database);
    return jsonData(resp, 'vector upsertNamed').id;
  }

  /** Write many vectors as one atomic batch; resolves with how many. A repeated id is refused. */
  async vectorUpsertMany(collection: string, items: ReadonlyArray<VectorUpsertItem>, database = 'main'): Promise<number> {
    const wire = items.map((i) => ({
      id: i.id,
      vector: numbers(i.vector),
      metadata: i.metadata === undefined ? null : i.metadata,
    }));
    const resp = await this.request({ Vector: { UpsertMany: { collection, items: wire } } }, database);
    return jsonData(resp, 'vector upsertMany').upserted;
  }

  /** Delete many vectors by id as one atomic batch; resolves with how many were present. */
  async vectorDeleteMany(collection: string, ids: ReadonlyArray<string>, database = 'main'): Promise<number> {
    const resp = await this.request({ Vector: { DeleteMany: { collection, ids } } }, database);
    return jsonData(resp, 'vector deleteMany').deleted;
  }

  /** Several query vectors in one request: one hit list per query, in the order asked. */
  async vectorSearchBatch(
    collection: string,
    vectors: ReadonlyArray<ArrayLike<number>>,
    topK: number,
    opts: VectorSearchOptions & { filter?: Record<string, Json> | null; minScore?: number | null; includeVectors?: boolean } = {},
    database = 'main',
  ): Promise<VectorSearchHit[][]> {
    const resp = await this.request(
      {
        Vector: {
          SearchBatch: {
            collection,
            vectors: vectorList(vectors, 'vectors'),
            top_k: topK,
            ...given({ filter: opts.filter, min_score: opts.minScore, include_vectors: opts.includeVectors }),
            ...searchOptions(opts),
          },
        },
      },
      database,
    );
    return jsonData(resp, 'vector searchBatch').results || [];
  }

  /** Delete every vector whose metadata matches `filter`; an empty filter is refused. */
  async vectorDeleteByFilter(collection: string, filter: Record<string, Json>, database = 'main'): Promise<number> {
    const resp = await this.request({ Vector: { DeleteByFilter: { collection, filter } } }, database);
    return jsonData(resp, 'vector deleteByFilter').deleted;
  }

  /** Merge `set` into the metadata of every vector matching `filter`; resolves with how many. */
  async vectorUpdateByFilter(
    collection: string,
    filter: Record<string, Json>,
    set: Record<string, Json>,
    database = 'main',
  ): Promise<number> {
    const resp = await this.request({ Vector: { UpdateByFilter: { collection, filter, set } } }, database);
    return jsonData(resp, 'vector updateByFilter').updated;
  }

  /** How many vectors a collection holds or, with a `filter`, how many match it. An exact count. */
  async vectorCount(collection: string, opts: { filter?: Record<string, Json> | null } = {}, database = 'main'): Promise<number> {
    const resp = await this.request({ Vector: { Count: { collection, ...given({ filter: opts.filter }) } } }, database);
    return jsonData(resp, 'vector count').count;
  }

  /** Each distinct value of `field` (`_namespace`, the default, or `_tenant`) with its vector count. */
  async vectorListPartitions(collection: string, opts: { field?: string } = {}, database = 'main'): Promise<VectorPartitions> {
    const resp = await this.request({ Vector: { ListPartitions: { collection, ...given({ field: opts.field }) } } }, database);
    return jsonData(resp, 'vector listPartitions');
  }

  /** Rename a collection with every vector in it. Refused when `to` exists. */
  async vectorRenameCollection(collection: string, to: string, database = 'main'): Promise<VectorRenameResult> {
    const resp = await this.request({ Vector: { RenameCollection: { collection, to } } }, database);
    return jsonData(resp, 'vector renameCollection');
  }

  /** Rebuild the collection's ANN index from its stored vectors and persist it. */
  async vectorRebuildIndex(collection: string, database = 'main'): Promise<VectorRebuildResult> {
    const resp = await this.request({ Vector: { RebuildIndex: { collection } } }, database);
    return jsonData(resp, 'vector rebuildIndex');
  }

  /** The shape of the collection's ANN index. */
  async vectorIndexStats(collection: string, database = 'main'): Promise<VectorIndexStats> {
    const resp = await this.request({ Vector: { IndexStats: { collection } } }, database);
    return jsonData(resp, 'vector indexStats');
  }

  /** Measure the ANN index's recall against exact scans of `sample` stored vectors. */
  async vectorMeasureRecall(
    collection: string,
    opts: { sample?: number | null; topK?: number | null; efSearch?: number | null } = {},
    database = 'main',
  ): Promise<VectorRecall> {
    const resp = await this.request(
      {
        Vector: {
          MeasureRecall: { collection, ...given({ sample: opts.sample, top_k: opts.topK, ef_search: opts.efSearch }) },
        },
      },
      database,
    );
    return jsonData(resp, 'vector measureRecall');
  }

  /** Search with several query vectors and return one fused ranking (`rrf` by default). */
  async vectorSearchMulti(
    collection: string,
    vectors: ReadonlyArray<ArrayLike<number>>,
    topK: number,
    opts: { fusion?: 'rrf' | 'max' | 'mean'; filter?: Record<string, Json> | null } = {},
    database = 'main',
  ): Promise<VectorMultiHits> {
    const resp = await this.request(
      {
        Vector: {
          SearchMulti: {
            collection,
            vectors: vectorList(vectors, 'vectors'),
            top_k: topK,
            ...given({ fusion: opts.fusion, filter: opts.filter }),
          },
        },
      },
      database,
    );
    return jsonData(resp, 'vector searchMulti');
  }

  /**
   * Change a collection's configuration. `normalize` can only change on an
   * empty collection; `m` and `efConstruction` force an index rebuild.
   */
  async vectorSetCollectionConfig(
    collection: string,
    opts: { normalize?: boolean | null; m?: number | null; efConstruction?: number | null; multiTenant?: boolean | null },
    database = 'main',
  ): Promise<VectorCollectionConfig> {
    const resp = await this.request(
      {
        Vector: {
          SetCollectionConfig: {
            collection,
            ...given({
              normalize: opts.normalize,
              m: opts.m,
              ef_construction: opts.efConstruction,
              multi_tenant: opts.multiTenant,
            }),
          },
        },
      },
      database,
    );
    return jsonData(resp, 'vector setCollectionConfig');
  }

  /** Copy a collection, configuration and vectors, to a new name; resolves with how many vectors. */
  async vectorCopyCollection(collection: string, to: string, database = 'main'): Promise<number> {
    const resp = await this.request({ Vector: { CopyCollection: { collection, to } } }, database);
    return jsonData(resp, 'vector copyCollection').copied;
  }

  /**
   * Search with a query built from examples: the sum of the `positive` ones
   * minus the sum of `opts.negative`. An example is a stored vector's id or a
   * vector. Examples named by id are left out unless `excludeExamples` is false.
   */
  async vectorSearchByExamples(
    collection: string,
    positive: ReadonlyArray<VectorExample>,
    topK: number,
    opts: VectorSearchOptions & {
      negative?: ReadonlyArray<VectorExample>;
      filter?: Record<string, Json> | null;
      minScore?: number | null;
      includeVectors?: boolean;
      excludeExamples?: boolean;
    } = {},
    database = 'main',
  ): Promise<VectorExampleHits> {
    const example = (e: VectorExample): string | number[] => (typeof e === 'string' ? e : numbers(e));
    const resp = await this.request(
      {
        Vector: {
          SearchByExamples: {
            collection,
            positive: positive.map(example),
            negative: (opts.negative || []).map(example),
            top_k: topK,
            ...given({
              filter: opts.filter,
              min_score: opts.minScore,
              include_vectors: opts.includeVectors,
              exclude_examples: opts.excludeExamples,
            }),
            ...searchOptions(opts),
          },
        },
      },
      database,
    );
    const j = jsonData(resp, 'vector searchByExamples');
    const results = j.results || [];
    Object.defineProperty(results, 'index', { value: j.index, enumerable: false });
    return results as VectorExampleHits;
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

  // -- graph: server 0.1.0-rc.3 and later ---------------------------------------

  /**
   * Write many nodes and edges as one unit: every record lands or none does.
   * Nodes are written first, so an edge may join nodes of the same batch.
   */
  async graphAddMany(
    graph: string,
    batch: { nodes?: ReadonlyArray<GraphNodeInput>; edges?: ReadonlyArray<GraphEdgeInput> },
    database = 'main',
  ): Promise<GraphBatchResult> {
    const resp = await this.request(
      { Graph: { AddMany: { graph, nodes: batch.nodes || [], edges: batch.edges || [] } } },
      database,
    );
    return jsonData(resp, 'graph addMany');
  }

  /**
   * Delete many nodes and edges as one unit. An id that is not there is
   * skipped. With `detach`, every edge touching a removed node goes too.
   */
  async graphRemoveMany(
    graph: string,
    batch: { nodes?: ReadonlyArray<string>; edges?: ReadonlyArray<string>; detach?: boolean },
    database = 'main',
  ): Promise<GraphRemoveResult> {
    const resp = await this.request(
      {
        Graph: {
          RemoveMany: { graph, nodes: batch.nodes || [], edges: batch.edges || [], detach: !!batch.detach },
        },
      },
      database,
    );
    return jsonData(resp, 'graph removeMany');
  }

  /**
   * Change an existing node in place. `properties` is a JSON merge patch: a
   * key set to null is removed, a key left out is kept. Resolves with the node.
   */
  async graphUpdateNode(
    graph: string,
    id: string,
    opts: { properties?: Json; addLabels?: ReadonlyArray<string>; removeLabels?: ReadonlyArray<string> } = {},
    database = 'main',
  ): Promise<GraphNode> {
    const resp = await this.request(
      {
        Graph: {
          UpdateNode: {
            graph,
            id,
            ...given({ properties: opts.properties, add_labels: opts.addLabels, remove_labels: opts.removeLabels }),
          },
        },
      },
      database,
    );
    return jsonData(resp, 'graph updateNode');
  }

  /** Change an existing edge in place: `properties` merges, `label` changes its type. The endpoints cannot change. */
  async graphUpdateEdge(
    graph: string,
    id: string,
    opts: { properties?: Json; label?: string | null } = {},
    database = 'main',
  ): Promise<GraphEdge> {
    const resp = await this.request(
      { Graph: { UpdateEdge: { graph, id, ...given({ properties: opts.properties, label: opts.label }) } } },
      database,
    );
    return jsonData(resp, 'graph updateEdge');
  }

  /** Copy a graph, with its nodes, edges and schema, to a new name. Refused when `to` exists. */
  async graphCopy(graph: string, to: string, database = 'main'): Promise<GraphCopyResult> {
    const resp = await this.request({ Graph: { CopyGraph: { graph, to } } }, database);
    return jsonData(resp, 'graph copy');
  }

  /** Bounded depth-first walk: the same nodes as `graphTraverse`, in DFS preorder. */
  async graphDfs(
    graph: string,
    start: string,
    opts: { direction?: GraphDirection; label?: string | null; maxDepth?: number | null; limit?: number | null } = {},
    database = 'main',
  ): Promise<GraphDfsResult> {
    const resp = await this.request(
      {
        Graph: {
          Dfs: {
            graph,
            start,
            ...given({ direction: opts.direction, label: opts.label, max_depth: opts.maxDepth, limit: opts.limit }),
          },
        },
      },
      database,
    );
    return jsonData(resp, 'graph dfs');
  }

  /** Partition the nodes into connected components, largest first. `weak` (default) ignores edge direction. */
  async graphConnectedComponents(
    graph: string,
    opts: { kind?: 'weak' | 'strong'; label?: string | null; limit?: number | null } = {},
    database = 'main',
  ): Promise<GraphComponents> {
    const resp = await this.request(
      {
        Graph: {
          ConnectedComponents: { graph, ...given({ kind: opts.kind, label: opts.label, limit: opts.limit }) },
        },
      },
      database,
    );
    return jsonData(resp, 'graph connectedComponents');
  }

  /** Whether the graph contains a cycle, and one cycle as evidence. `directed` defaults to true. */
  async graphDetectCycle(
    graph: string,
    opts: { directed?: boolean; label?: string | null } = {},
    database = 'main',
  ): Promise<GraphCycle> {
    const resp = await this.request(
      { Graph: { DetectCycle: { graph, ...given({ directed: opts.directed, label: opts.label }) } } },
      database,
    );
    return jsonData(resp, 'graph detectCycle');
  }

  /** Counts describing a graph: nodes and edges, per label and type, degree extremes, dangling edges. */
  async graphStats(graph: string, database = 'main'): Promise<GraphStats> {
    return jsonData(await this.request({ Graph: { GraphStats: { graph } } }, database), 'graph stats');
  }

  /** The nodes within `maxDepth` hops of `seeds` and every edge joining two of them. */
  async graphSubgraph(
    graph: string,
    seeds: ReadonlyArray<string>,
    opts: { direction?: GraphDirection; label?: string | null; maxDepth?: number | null; limit?: number | null } = {},
    database = 'main',
  ): Promise<GraphSubgraph> {
    const resp = await this.request(
      {
        Graph: {
          Subgraph: {
            graph,
            seeds,
            ...given({ direction: opts.direction, label: opts.label, max_depth: opts.maxDepth, limit: opts.limit }),
          },
        },
      },
      database,
    );
    return jsonData(resp, 'graph subgraph');
  }

  /** The node labels and edge types in the data, each with a count and the property keys seen on it. */
  async graphSchema(graph: string, database = 'main'): Promise<GraphSchemaInfo> {
    return jsonData(await this.request({ Graph: { GraphSchema: { graph } } }, database), 'graph schema');
  }

  /** The `k` cheapest loopless paths, cheapest first. Without `weightProperty` every edge costs 1. */
  async graphKShortestPaths(
    graph: string,
    from: string,
    to: string,
    opts: { k?: number | null; direction?: GraphDirection; label?: string | null; weightProperty?: string | null } = {},
    database = 'main',
  ): Promise<GraphPaths> {
    const resp = await this.request(
      {
        Graph: {
          KShortestPaths: {
            graph,
            from,
            to,
            ...given({ k: opts.k, direction: opts.direction, label: opts.label, weight_property: opts.weightProperty }),
          },
        },
      },
      database,
    );
    return jsonData(resp, 'graph kShortestPaths');
  }

  /** Every simple path of at most `maxDepth` edges, up to `limit` paths. `complete` says whether it finished. */
  async graphAllPaths(
    graph: string,
    from: string,
    to: string,
    opts: { direction?: GraphDirection; label?: string | null; maxDepth?: number | null; limit?: number | null } = {},
    database = 'main',
  ): Promise<GraphAllPaths> {
    const resp = await this.request(
      {
        Graph: {
          AllPaths: {
            graph,
            from,
            to,
            ...given({ direction: opts.direction, label: opts.label, max_depth: opts.maxDepth, limit: opts.limit }),
          },
        },
      },
      database,
    );
    return jsonData(resp, 'graph allPaths');
  }

  /** Betweenness, closeness or eigenvector centrality, top `limit` nodes. `iterations` and `tolerance` tune eigenvector only. */
  async graphCentrality(
    graph: string,
    measure: GraphCentralityMeasure,
    opts: {
      directed?: boolean;
      label?: string | null;
      limit?: number | null;
      iterations?: number | null;
      tolerance?: number | null;
    } = {},
    database = 'main',
  ): Promise<GraphCentrality> {
    const resp = await this.request(
      {
        Graph: {
          Centrality: {
            graph,
            measure,
            ...given({
              directed: opts.directed,
              label: opts.label,
              limit: opts.limit,
              iterations: opts.iterations,
              tolerance: opts.tolerance,
            }),
          },
        },
      },
      database,
    );
    return jsonData(resp, 'graph centrality');
  }

  /** Communities by Louvain modularity optimisation, direction ignored, largest first. */
  async graphCommunities(
    graph: string,
    opts: { label?: string | null; iterations?: number | null; limit?: number | null } = {},
    database = 'main',
  ): Promise<GraphCommunities> {
    const resp = await this.request(
      {
        Graph: {
          Communities: { graph, ...given({ label: opts.label, iterations: opts.iterations, limit: opts.limit }) },
        },
      },
      database,
    );
    return jsonData(resp, 'graph communities');
  }

  /** Triangles and clustering coefficients, direction ignored. */
  async graphTriangleCount(
    graph: string,
    opts: { label?: string | null; limit?: number | null } = {},
    database = 'main',
  ): Promise<GraphTriangles> {
    const resp = await this.request(
      { Graph: { TriangleCount: { graph, ...given({ label: opts.label, limit: opts.limit }) } } },
      database,
    );
    return jsonData(resp, 'graph triangleCount');
  }

  /** The nodes whose neighbour sets most resemble `node`'s (`jaccard` by default). */
  async graphNodeSimilarity(
    graph: string,
    node: string,
    opts: { direction?: GraphDirection; label?: string | null; metric?: 'jaccard' | 'overlap'; limit?: number | null } = {},
    database = 'main',
  ): Promise<GraphSimilarity> {
    const resp = await this.request(
      {
        Graph: {
          NodeSimilarity: {
            graph,
            node,
            ...given({ direction: opts.direction, label: opts.label, metric: opts.metric, limit: opts.limit }),
          },
        },
      },
      database,
    );
    return jsonData(resp, 'graph nodeSimilarity');
  }

  /** Check a graph's stored records against each other and against the in-memory mirror. */
  async graphCheckConsistency(graph: string, database = 'main'): Promise<GraphConsistency> {
    return jsonData(await this.request({ Graph: { CheckConsistency: { graph } } }, database), 'graph checkConsistency');
  }

  /** Index node properties for `graphFindNodes`. Several properties make a composite index; `label` limits it. */
  async graphCreateNodeIndex(
    graph: string,
    name: string,
    properties: ReadonlyArray<string>,
    opts: { label?: string | null } = {},
    database = 'main',
  ): Promise<void> {
    await this.request(
      { Graph: { CreateNodeIndex: { graph, name, ...given({ label: opts.label }), properties } } },
      database,
    );
  }

  /**
   * Enforce `unique` or `required` on a property of every node (or, with
   * `target: 'edge'`, every relationship) labelled `label`. Refused when a
   * stored record already breaks it.
   */
  async graphCreateConstraint(
    graph: string,
    name: string,
    label: string,
    property: string,
    kind: GraphConstraintKind,
    opts: { target?: GraphConstraintTarget } = {},
    database = 'main',
  ): Promise<void> {
    await this.request(
      { Graph: { CreateConstraint: { graph, name, label, property, kind, ...given({ target: opts.target }) } } },
      database,
    );
  }

  /** Drop an index or a constraint by name. */
  async graphDropSchemaObject(graph: string, name: string, database = 'main'): Promise<void> {
    await this.request({ Graph: { DropSchemaObject: { graph, name } } }, database);
  }

  /** A graph's indexes and constraints. */
  async graphListSchemaObjects(graph: string, database = 'main'): Promise<GraphSchemaObjects> {
    const j = jsonData(await this.request({ Graph: { ListSchemaObjects: { graph } } }, database), 'graph listSchemaObjects');
    return { indexes: j.indexes || [], constraints: j.constraints || [] };
  }

  /** Nodes with `label` whose `properties` equal the given values, in id order. `plan` says how it was answered. */
  async graphFindNodes(
    graph: string,
    opts: { label?: string | null; properties?: Record<string, Json>; limit?: number | null } = {},
    database = 'main',
  ): Promise<GraphFoundNodes> {
    const resp = await this.request(
      {
        Graph: {
          FindNodes: { graph, ...given({ label: opts.label, properties: opts.properties, limit: opts.limit }) },
        },
      },
      database,
    );
    return jsonData(resp, 'graph findNodes');
  }

  /** Import nodes and edges from CSV text as one atomic batch. Constraints apply. */
  async graphImportCsv(
    graph: string,
    csv: { nodes?: string | null; edges?: string | null },
    database = 'main',
  ): Promise<GraphBatchResult> {
    const resp = await this.request(
      { Graph: { ImportCsv: { graph, ...given({ nodes: csv.nodes, edges: csv.edges }) } } },
      database,
    );
    return jsonData(resp, 'graph importCsv');
  }

  /** PageRank over edge direction: the top `limit` nodes by rank. `damping` defaults to 0.85. */
  async graphPageRank(
    graph: string,
    opts: {
      damping?: number | null;
      iterations?: number | null;
      tolerance?: number | null;
      label?: string | null;
      limit?: number | null;
    } = {},
    database = 'main',
  ): Promise<GraphPageRank> {
    const resp = await this.request(
      {
        Graph: {
          PageRank: {
            graph,
            ...given({
              damping: opts.damping,
              iterations: opts.iterations,
              tolerance: opts.tolerance,
              label: opts.label,
              limit: opts.limit,
            }),
          },
        },
      },
      database,
    );
    return jsonData(resp, 'graph pageRank');
  }

  /**
   * A Cypher write: `CREATE`, `MERGE`, `SET`, `REMOVE`, `[DETACH] DELETE`,
   * optionally after `MATCH ... [WHERE ...]`. Inside a graph transaction it is
   * queued rather than applied.
   */
  async graphExecute(graph: string, cypher: string, database = 'main'): Promise<GraphWriteResult> {
    return jsonData(await this.request({ Graph: { Execute: { graph, cypher } } }, database), 'graph execute');
  }

  /**
   * Open a transaction on `graph` and make it this connection's `txn`: each
   * later `graphExecute` is queued until the commit. Other graph writes are
   * not queued. Resolves with the transaction id.
   */
  async graphBeginTransaction(graph: string, database = 'main'): Promise<string> {
    this._refuseSecondTxn();
    const resp = await this.request({ Graph: { BeginTransaction: { graph } } }, database);
    const txn: string = jsonData(resp, 'graph beginTransaction').transaction;
    this.txn = txn;
    return txn;
  }

  /** Apply every queued statement of this connection's `txn`: all of them or none. */
  async graphCommitTransaction(graph: string, database = 'main'): Promise<GraphCommitResult> {
    const resp = await this.request({ Graph: { CommitTransaction: { graph } } }, database);
    this.txn = null;
    return jsonData(resp, 'graph commitTransaction');
  }

  /** Discard this connection's `txn`; resolves with how many queued statements were dropped. */
  async graphRollbackTransaction(graph: string, database = 'main'): Promise<number> {
    const resp = await this._endTxn({ Graph: { RollbackTransaction: { graph } } }, database);
    return jsonData(resp, 'graph rollbackTransaction').rolled_back;
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
   *
   * Inside an open block, server 0.1.0-rc.3 and later open a nested block (a
   * savepoint): its `commit()` releases it, its `rollback()` undoes only that
   * block, and both answer with `nested_depth`. Earlier servers refuse it.
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
    const summary = jsonData(resp, keyword);
    // A reply carrying `nested_depth` came from a nested block: the outer one is still open.
    this._txnOpen = keyword === 'BEGIN' || (!!summary && typeof summary.nested_depth === 'number');
    return summary;
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
