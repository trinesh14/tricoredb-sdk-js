import { NOT_LEADER } from './constants.js';
import { ProtocolError, TriCoreError } from './errors.js';
import { DocFilter } from './builders.js';
import type { Response } from './results.js';
import type { CacheBytes, CacheStreamEntry, LlmSource } from './types.js';

export function kindOf(data: unknown): string {
  if (data && typeof data === 'object') {
    const keys = Object.keys(data);
    if (keys.length) return keys[0] as string;
  }
  return JSON.stringify(data);
}

function arm(resp: Response, name: string): { present: boolean; value: unknown } {
  const data = resp.data;
  if (data && typeof data === 'object' && name in data) {
    return { present: true, value: (data as Record<string, unknown>)[name] };
  }
  return { present: false, value: undefined };
}

/** The `Json` arm. `null` is a legitimate value (a Get miss), so presence is checked, not truthiness. */
export function jsonData<T = any>(resp: Response, what: string): T {
  const a = arm(resp, 'Json');
  if (a.present) return a.value as T;
  throw new ProtocolError(`expected Json for ${what}, got ${kindOf(resp.data)}`);
}

export function documentsData<T = any>(resp: Response, what: string): T[] {
  const a = arm(resp, 'Documents');
  if (a.present) return (a.value as T[] | null) || [];
  throw new ProtocolError(`expected Documents for ${what}, got ${kindOf(resp.data)}`);
}

export function cacheValue(resp: Response, what: string): Buffer | null {
  const a = arm(resp, 'CacheValue');
  if (a.present) return a.value === null ? null : Buffer.from(a.value as number[]);
  throw new ProtocolError(`expected CacheValue for ${what}, got ${kindOf(resp.data)}`);
}

export function rendered(resp: Response): any {
  for (const name of ['Toon', 'Json', 'Message']) {
    const a = arm(resp, name);
    if (a.present) return a.value;
  }
  throw new ProtocolError(`expected a rendered export, got ${kindOf(resp.data)}`);
}

export function bytes(value: CacheBytes, name: string): number[] {
  if (value === null || value === undefined) {
    throw new TriCoreError(`${name} must not be null or undefined`);
  }
  if (typeof value === 'string') return Array.from(Buffer.from(value, 'utf8'));
  if (Array.isArray(value)) return value;
  return Array.from(value as Uint8Array);
}

export function byteArrays(values: ReadonlyArray<CacheBytes>, name: string): number[][] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TriCoreError(`${name} must be a non-empty array`);
  }
  return values.map((v: CacheBytes) => bytes(v, `${name} element`));
}

export function pairs(
  entries: ReadonlyArray<readonly [CacheBytes, CacheBytes]>,
  name: string,
): [number[], number[]][] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TriCoreError(`${name} must be a non-empty array of [field, value] pairs`);
  }
  return entries.map((e: readonly [CacheBytes, CacheBytes]) => {
    if (!Array.isArray(e) || e.length !== 2) {
      throw new TriCoreError(`each ${name} entry must be a [field, value] pair`);
    }
    return [bytes(e[0], `${name} field`), bytes(e[1], `${name} value`)];
  });
}

export function textPairs(obj: Record<string, string>): [Buffer, Buffer][] {
  return Object.entries(obj || {}).map(([f, v]) => [Buffer.from(f, 'utf8'), Buffer.from(String(v), 'utf8')]);
}

export function buffers(values: number[][] | null | undefined): Buffer[] {
  return (values || []).map((v) => Buffer.from(v));
}

export function numbers(vector: ArrayLike<number> | Iterable<number>): number[] {
  return Array.isArray(vector) ? vector : Array.from(vector as ArrayLike<number>);
}

export function streamEntries(json: { entries?: { id: string; fields?: [number[], number[]][] }[] }): CacheStreamEntry[] {
  return (json.entries || []).map((e) => {
    const fields = (e.fields || []).map((p): [Buffer, Buffer] => [Buffer.from(p[0]), Buffer.from(p[1])]);
    const text: Record<string, string> = {};
    for (const [f, v] of fields) text[f.toString('utf8')] = v.toString('utf8');
    return { id: e.id, fields, text };
  });
}

export function llmSource(src: LlmSource): Record<string, unknown> {
  if (!src || typeof src !== 'object') throw new TriCoreError('each LLM source must be an object');
  const s = src as { sql?: unknown; collection?: unknown; filter?: unknown; limit?: unknown };
  if (typeof s.sql === 'string') return { Sql: { query: s.sql } };
  if (typeof s.collection === 'string') {
    return {
      DocumentFind: {
        collection: s.collection,
        filter: s.filter === undefined ? DocFilter.all() : s.filter,
        limit: s.limit === undefined ? null : s.limit,
      },
    };
  }
  throw new TriCoreError('an LLM source needs either `sql` or `collection`');
}

function messageOf(data: unknown): string | null {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if ('Message' in d) return d.Message as string;
    if ('Json' in d) return JSON.stringify(d.Json);
  }
  return null;
}

function errorText(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    return (b.message as string) || (b.error as string) || JSON.stringify(body);
  }
  return String(body);
}

/** The typed error for an ERROR frame, carrying the frame's own `code`. */
export function errorFrame(
  Ctor: new (message?: string, opts?: { code?: string | null }) => TriCoreError,
  body: unknown,
): TriCoreError {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).code : null;
  const code = typeof raw === 'string' && raw ? raw : null;
  return new Ctor(errorText(body), { code });
}

/** The typed error for a response whose status is not `ok`. Never re-sends anywhere. */
export function serverRefusal(resp: Response, txnOpen: boolean): TriCoreError {
  let message = `${messageOf(resp.data) || 'request failed'} (server status: ${resp.status})`;
  const code = resp.errorCode;
  const leaderHint = resp.leaderHint;
  if (code === NOT_LEADER) {
    message += leaderHint
      ? ` [${NOT_LEADER}: this node is not the leader; the leader serves clients at ` +
        `\`${leaderHint}\`. This driver does not follow the hint on its own — a new connection ` +
        'authenticates again, and only you know whether that address is reachable from here. ' +
        'Send this request there.'
      : ` [${NOT_LEADER}: this node is not the leader and there is no address to name (an ` +
        'election is in progress, this node has no [raft] configured, or the leader has no ' +
        'address in [[raft.peers]]). There is nowhere to redirect to: wait and try again.';
    if (txnOpen) {
      message +=
        ' The open session transaction is over: it is bound to this connection and ' +
        'cannot be continued, committed or resumed on another node.';
    }
    message += ']';
  }
  return new TriCoreError(message, { code, leaderHint });
}
