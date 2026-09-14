import { NOT_LEADER } from './constants.js';

export interface TriCoreErrorOptions {
  code?: string | null;
  leaderHint?: string | null;
}

/**
 * Any failure from the server or the transport.
 *
 * `code` is the server's stable reason (`diagnostics.error_code`, or an ERROR
 * frame's own code); branch on it, never on `message`. `leaderHint` is the
 * leader's `host:port`, set only alongside `not_leader`.
 */
export class TriCoreError extends Error {
  readonly code: string | null;
  readonly leaderHint: string | null;
  /** @internal set when the request never left this process. */
  notSent?: boolean;

  constructor(message?: string, opts?: TriCoreErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = (opts && opts.code) || null;
    this.leaderHint = (opts && opts.leaderHint) || null;
  }

  /**
   * The request was right, the node was wrong: true for every `not_leader`
   * refusal, hint or not. This driver never follows the hint on its own.
   */
  get isRedirect(): boolean {
    return this.code === NOT_LEADER;
  }
}

export class AuthError extends TriCoreError {}
export class ProtocolError extends TriCoreError {}

/**
 * A reply did not arrive within `readTimeoutMs`. Fatal to the connection: the
 * reply may still be in flight and would be read as the next request's answer.
 */
export class Timeout extends TriCoreError {}

/** No pooled connection became free in time. */
export class PoolTimeout extends TriCoreError {}
