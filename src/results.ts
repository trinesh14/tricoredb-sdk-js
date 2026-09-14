import { NOT_LEADER } from './constants.js';

/** A SQL result set. Values arrive as text and are handed over untouched. */
export class Rows {
  columns: string[];
  rows: string[][];

  constructor(columns: string[], rows: string[][]) {
    this.columns = columns;
    this.rows = rows;
  }

  /** Rows as plain objects keyed by column name. */
  dicts(): Record<string, string>[] {
    return this.rows.map((r) => {
      const o: Record<string, string> = {};
      this.columns.forEach((c, i) => {
        o[c] = r[i] as string;
      });
      return o;
    });
  }

  get length(): number {
    return this.rows.length;
  }

  [Symbol.iterator](): IterableIterator<string[]> {
    return this.rows[Symbol.iterator]();
  }
}

export interface RawResponse {
  request_id?: string;
  status?: string;
  data?: unknown;
  diagnostics?: Record<string, unknown>;
}

/** A server response: typed data plus how it was produced. */
export class Response {
  requestId: string;
  status: string;
  data: unknown;
  diagnostics: Record<string, unknown>;

  constructor(raw?: RawResponse | null) {
    const r = raw || {};
    this.requestId = r.request_id || '';
    this.status = r.status || 'error';
    this.data = r.data;
    this.diagnostics = r.diagnostics || {};
  }

  /** Non-fatal warnings, e.g. a broadcast DDL that missed a shard while still returning ok. */
  get warnings(): string[] {
    return (this.diagnostics.warnings as string[] | undefined) || [];
  }

  get route(): string {
    return (this.diagnostics.route as string | undefined) || '';
  }

  get elapsedMs(): number {
    return (this.diagnostics.elapsed_ms as number | undefined) || 0;
  }

  /** `diagnostics.error_code`, or null. */
  get errorCode(): string | null {
    return (this.diagnostics.error_code as string | undefined) || null;
  }

  /** `diagnostics.leader_hint` (a `host:port`), or null. */
  get leaderHint(): string | null {
    return (this.diagnostics.leader_hint as string | undefined) || null;
  }

  /** Whether this response says "right request, wrong node". */
  get isRedirect(): boolean {
    return this.errorCode === NOT_LEADER;
  }
}
