export const PROTOCOL = 'tricore';
export const VERSION = 1;

/** This SDK's own version. Separate from the protocol major `VERSION`. */
export const SDK_VERSION = '0.1.1';

/** Capability bits sent in HELLO; the server replies with the subset it granted. */
export const FEATURE_CORRELATION_ID = 1;
/** The server binds `?` placeholders server-side. */
export const FEATURE_SERVER_PARAMS = 2;
/** Session-scoped transactions: `begin()`/`commit()`/`rollback()` as separate requests on one connection. */
export const FEATURE_SESSION_TXN = 4;
/** Every capability bit this build understands. */
export const FEATURES = FEATURE_CORRELATION_ID | FEATURE_SERVER_PARAMS | FEATURE_SESSION_TXN;

export const DEFAULT_PORT = 8427;

export const TAG = {
  HELLO: 0,
  AUTH: 1,
  REQUEST: 2,
  RESPONSE: 3,
  PING: 4,
  PONG: 5,
  ERROR: 6,
  CLOSE: 7,
  HELLO_OK: 8,
  AUTH_OK: 9,
  BYE: 10,
  CANCEL: 11,
  CANCEL_OK: 12,
} as const;

export const HEADER_SIZE = 6;

/** Payload ceiling for REQUEST/RESPONSE frames, mirrored from `tricore_protocol`. */
export const MAX_FRAME_SIZE = 16 * 1024 * 1024;
/** Payload ceiling for every control frame (HELLO, AUTH, ERROR, ...). */
export const MAX_CONTROL_FRAME_SIZE = 64 * 1024;
/** The highest frame-header format version this driver can read. */
export const MAX_SUPPORTED_FRAME_VERSION = 1;

export const CLOSE_TIMEOUT_MS = 2000;

/** The code a not-leader refusal carries. Branch on this constant, not a literal. */
export const NOT_LEADER = 'not_leader';

/** The code a refusal carries when the request needs a data model the server has switched off. */
export const ENGINE_DISABLED = 'engine.disabled';

/** An unknown tag takes the tighter ceiling: the safe direction to be wrong in is "too small". */
export function maxPayloadFor(tag: number): number {
  return tag === TAG.REQUEST || tag === TAG.RESPONSE ? MAX_FRAME_SIZE : MAX_CONTROL_FRAME_SIZE;
}
