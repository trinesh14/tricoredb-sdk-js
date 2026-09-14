import { TriCore } from './client.js';
import { PoolTimeout, ProtocolError, TriCoreError } from './errors.js';
import type { ConnectOptions, PoolOptions, PoolStats } from './types.js';

interface PoolWaiter {
  resolve: (conn: TriCore) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

async function abandonBlock(conn: TriCore): Promise<boolean> {
  try {
    await conn.rollback();
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether an error thrown inside `use()` means the stream may be torn.
 *
 * A server refusal carries a `code`, which means its frame arrived whole and
 * was parsed: the stream is healthy. It is excluded first, because refusal
 * prose is the server's to write ("reconnect" contains "ECONN") and a refusal's
 * `code` sits in the same property a Node system error (`EPIPE`) uses.
 */
export function isBrokenConnectionError(e: unknown): boolean {
  const refused = e instanceof TriCoreError && !(e instanceof ProtocolError) && !!e.code;
  if (refused) return false;
  const err = e as { code?: unknown; message?: unknown } | null;
  return (
    e instanceof ProtocolError ||
    !!(err && err.code) ||
    /socket|closed|EPIPE|ECONN/i.test(String(err && err.message))
  );
}

/**
 * A pool of connections, safe under concurrent async use. A pooled connection
 * is owned exclusively for the duration of one `use()` callback.
 */
export class Pool {
  private readonly _size: number;
  private readonly _connOpts: ConnectOptions;
  private readonly _idle: TriCore[] = [];
  private _created = 0;
  private _closed = false;
  private readonly _waiters: PoolWaiter[] = [];

  constructor(opts: PoolOptions = {}) {
    const { size = 8, ...connOpts } = opts;
    if (size < 1) throw new TriCoreError('pool size must be >= 1');
    this._size = size;
    this._connOpts = connOpts;
  }

  get size(): number {
    return this._size;
  }

  stats(): PoolStats {
    return {
      size: this._size,
      created: this._created,
      idle: this._idle.length,
      inUse: this._created - this._idle.length,
      waiting: this._waiters.length,
    };
  }

  /**
   * Borrow a connection for the duration of `fn`. A session transaction left
   * open is rolled back, never returned to the pool mid-block: if `fn` returned
   * normally `use()` rejects by name; if `fn` threw, its error propagates.
   */
  async use<T>(fn: (db: TriCore) => Promise<T> | T, timeoutMs = 10000): Promise<T> {
    const conn = await this._acquire(timeoutMs);
    let broken = false;
    try {
      let result: T;
      try {
        result = await fn(conn);
      } catch (e) {
        if (isBrokenConnectionError(e)) {
          broken = true;
        } else if (conn.inTransaction) {
          broken = !(await abandonBlock(conn));
        }
        throw e;
      }
      if (conn.inTransaction) {
        broken = !(await abandonBlock(conn));
        throw new TriCoreError(
          'the callback returned with a session transaction still open on the pooled ' +
            'connection; it has been rolled back rather than returned to the pool mid-block. ' +
            'commit() or rollback() inside the callback, or use db.withTransaction(fn).',
        );
      }
      return result;
    } finally {
      this._release(conn, broken);
    }
  }

  private async _acquire(timeoutMs: number): Promise<TriCore> {
    if (this._closed) throw new TriCoreError('pool is closed');
    const idle = this._idle.pop();
    if (idle) return idle;

    if (this._created < this._size) {
      this._created += 1;
      try {
        return await TriCore.connect(this._connOpts);
      } catch (e) {
        this._created -= 1;
        this._drainOneWaiter();
        throw e;
      }
    }

    return new Promise<TriCore>((resolve, reject) => {
      const waiter: PoolWaiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this._waiters.indexOf(waiter);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new PoolTimeout(`no pooled connection available within ${timeoutMs}ms (size=${this._size})`));
      }, timeoutMs);
      this._waiters.push(waiter);
    });
  }

  private _release(conn: TriCore, broken: boolean): void {
    if (conn.inTransaction) broken = true;
    if (broken || this._closed) {
      this._created -= 1;
      conn.close().catch(() => undefined);
      this._drainOneWaiter();
      return;
    }
    const waiter = this._waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(conn);
      return;
    }
    this._idle.push(conn);
  }

  private _drainOneWaiter(): void {
    const waiter = this._waiters.shift();
    if (!waiter) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    this._acquire(10000).then(waiter.resolve, waiter.reject);
  }

  async close(): Promise<void> {
    this._closed = true;
    for (const w of this._waiters.splice(0)) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(new TriCoreError('pool is closed'));
    }
    const idle = this._idle.splice(0);
    this._created -= idle.length;
    await Promise.all(idle.map((c) => c.close().catch(() => undefined)));
  }
}
