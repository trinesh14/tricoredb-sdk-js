import { randomBytes } from 'node:crypto';

import { FEATURE_SERVER_PARAMS } from './constants.js';
import { TriCoreError } from './errors.js';
import type { SqlValue, TransactionStatement } from './types.js';

function hex(value: Uint8Array): string {
  // Only the view's own window, never the whole backing ArrayBuffer.
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
}

/**
 * One JS value as a server-side parameter (a JSON scalar).
 *
 * An integer-valued `number` past 2^53 has already lost precision, so within
 * the range an integer column could hold it is refused by name; pass a BigInt
 * or a string. A `Date` becomes ISO-8601, a `Uint8Array`/`Buffer` becomes
 * `0x` + hex. A decimal is a string, which the server parses exactly.
 */
export function sqlParam(value: SqlValue): SqlValue {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value) &&
    Math.abs(value) <= 2 ** 63
  ) {
    throw new TriCoreError(
      `${value} is outside the range JavaScript numbers represent exactly, so this value has ` +
        'already lost precision. Pass it as a BigInt (e.g. 9007199254740993n) or as a string.',
    );
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `0x${hex(value)}`;
  return value;
}

/**
 * JSON for one frame body, rendering `BigInt` as an exact JSON number.
 *
 * Load-bearing: a string sent into a `BIGINT` column is refused, so a BigInt
 * must travel as a number without passing through a double. Each BigInt is
 * stashed behind a per-call random nonce and spliced back unquoted; the splice
 * count is checked so a collision fails loudly instead of corrupting a value.
 */
export function encodeBody(payload: unknown): string {
  const held: string[] = [];
  const nonce = randomBytes(9).toString('hex');
  const text = JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === 'bigint') {
      held.push(value.toString());
      return `${nonce}:${held.length - 1}`;
    }
    return value;
  });
  if (held.length === 0) return text;
  let spliced = 0;
  const out = text.replace(new RegExp(`"${nonce}:(\\d+)"`, 'g'), (_m, i: string) => {
    spliced += 1;
    return held[Number(i)] as string;
  });
  if (spliced !== held.length) {
    throw new TriCoreError('could not encode a BigInt parameter safely; pass it as a string');
  }
  return out;
}

export type SqlKind = 'Exec' | 'Query';

/**
 * Build a Query/Exec op. Arguments are bound **server-side only**: when the
 * connection was not granted `FEATURE_SERVER_PARAMS` this refuses by name
 * rather than silently rendering values into the SQL text.
 */
export function sqlOp(
  kind: SqlKind,
  sql: string,
  args: ReadonlyArray<SqlValue> | string | null | undefined,
  database: string,
  granted: number,
): [Record<string, unknown>, string] {
  if (typeof args === 'string') return [{ Sql: { [kind]: { sql } } }, args];
  if (args === null || args === undefined) return [{ Sql: { [kind]: { sql } } }, database];
  if ((granted & FEATURE_SERVER_PARAMS) === 0) {
    const err = new TriCoreError(
      'this server did not grant server-side parameters (SERVER_PARAMS is not in the granted ' +
        'feature set), so `?` placeholders cannot be bound on this connection. The driver ' +
        'refuses rather than rendering values into the SQL text; if client-side rendering is ' +
        'acceptable, call bindParams(sql, args) yourself and send the result without args',
    );
    err.notSent = true;
    throw err;
  }
  return [{ Sql: { [kind]: { sql, params: Array.from(args, sqlParam) } } }, database];
}

/** Escape and quote a string: double every `'`. */
export function quoteSql(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function sqlLiteral(value: SqlValue): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TriCoreError(`\`${value}\` has no SQL literal form`);
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return quoteSql(value);
  if (value instanceof Date) return quoteSql(value.toISOString());
  if (value instanceof Uint8Array) return quoteSql(`0x${hex(value)}`);
  throw new TriCoreError(
    `no SQL literal form for ${typeof value}. Convert it explicitly -- falling back to ` +
      "toString() would put an object's debug rendering into the statement.",
  );
}

/**
 * Client-side rendering of `?` placeholders into a SQL string. This is not a
 * server-side bind: strings are escaped by doubling `'`, only a closed set of
 * types is accepted, counts must match, and a `?` inside a literal is left
 * alone. It cannot protect an identifier.
 */
export function bindParams(sql: string, args: ReadonlyArray<SqlValue> | SqlValue): string {
  if (typeof sql !== 'string') throw new TriCoreError('sql must be a string');
  const list: ReadonlyArray<SqlValue> = Array.isArray(args) ? args : [args as SqlValue];
  let out = '';
  let next = 0;
  let inString = false;

  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (c === "'") {
      if (inString && sql[i + 1] === "'") {
        out += "''";
        i += 1;
        continue;
      }
      inString = !inString;
      out += c;
      continue;
    }
    if (c === '?' && !inString) {
      if (next >= list.length) {
        throw new TriCoreError(`SQL has more \`?\` placeholders than the ${list.length} argument(s) supplied`);
      }
      out += sqlLiteral(list[next]);
      next += 1;
      continue;
    }
    out += c;
  }

  if (inString) throw new TriCoreError('SQL ends inside an unterminated string literal');
  if (next !== list.length) {
    throw new TriCoreError(`SQL has ${next} \`?\` placeholder(s) but ${list.length} argument(s) were supplied`);
  }
  return out;
}

/** Assemble `BEGIN; ...; COMMIT`. Own transaction control inside the list is refused. */
export function buildTransactionScript(statements: ReadonlyArray<TransactionStatement>): string {
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new TriCoreError('transaction() needs a non-empty array of statements');
  }
  const parts = statements.map((s: TransactionStatement) => {
    const [sql, args] = Array.isArray(s) ? (s as readonly [string, ReadonlyArray<SqlValue>]) : [s as string, null];
    if (typeof sql !== 'string' || sql.trim() === '') {
      throw new TriCoreError('each transaction statement must be a non-empty SQL string');
    }
    const text = args === null || args === undefined ? sql : bindParams(sql, args);
    const first = (text.trim().split(/\s+/)[0] || '').toUpperCase();
    if (first === 'BEGIN' || first === 'START' || first === 'COMMIT' || first === 'ROLLBACK') {
      throw new TriCoreError(`transaction() brackets the script itself -- remove the \`${first}\` statement`);
    }
    return text.trim().replace(/;\s*$/, '');
  });
  return `BEGIN; ${parts.join('; ')}; COMMIT`;
}
