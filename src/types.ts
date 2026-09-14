/// <reference types="node" />

/** A JSON value as the document/vector/graph cores exchange it. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A JSON object. */
export type JsonObject = { [k: string]: Json };

/** A `DocumentFilter` in the server's externally-tagged wire form. */
export type DocumentFilterValue = 'All' | { [variant: string]: unknown };

/** One `AggregateStage` in the server's externally-tagged wire form. */
export type AggregateStageValue = { [variant: string]: unknown };

/** A group key for `DocStage.group`. */
export type GroupKeyValue = { Field: string } | { Constant: Json };

/** An accumulator for `DocStage.group`. */
export interface AccumulatorValue {
  output: string;
  op: 'Count' | { [op: string]: string };
}

/** A `{ set, inc }` document update. Both halves are optional. */
export interface DocumentUpdateSpec {
  set?: Record<string, Json>;
  inc?: Record<string, number>;
}

/** TLS settings. Passing this object at all is what turns TLS on. */
export interface TlsOptions {
  /** PEM CA bundle. Replaces Node's root store; omitted, the trust store is empty. */
  caFile?: string | null;
  /** Expected server name (SNI and certificate name check). Default `localhost`. */
  serverName?: string;
  /** Development only: skip certificate and hostname verification. */
  dangerAcceptInvalidCerts?: boolean;
  /** PEM client certificate chain (mTLS). Requires `clientKeyFile`. */
  clientCertFile?: string | null;
  /** PEM private key for `clientCertFile` (mTLS). Requires `clientCertFile`. */
  clientKeyFile?: string | null;
}

export interface ConnectOptions {
  host?: string;
  port?: number;
  /** Omit to skip authentication. */
  user?: string | null;
  secret?: string;
  clientName?: string;
  /** Milliseconds for the connect phase (TCP, TLS, HELLO, AUTH). 0 disables it. */
  timeout?: number;
  /** Client-side reply deadline in milliseconds; `null` (default) for none. */
  readTimeoutMs?: number | null;
  /** Omit for plain TCP. */
  tls?: TlsOptions | null;
  /** Capability bitmap announced in HELLO. Defaults to `FEATURES`. */
  features?: number;
}

export interface PoolOptions extends ConnectOptions {
  /** Maximum number of connections. Default 8. */
  size?: number;
}

export interface PoolStats {
  size: number;
  created: number;
  idle: number;
  inUse: number;
  waiting: number;
}

/** What the server granted in HELLO_OK, by name. */
export interface GrantedFeatures {
  mask: number;
  correlationId: boolean;
  serverParams: boolean;
  sessionTxn: boolean;
}

/** A value `query`/`execute` can bind to a `?` placeholder. */
export type SqlValue = null | undefined | boolean | number | bigint | string | Date | Uint8Array;

/** One `transaction()` entry: a SQL string, or `[sql, args]`. */
export type TransactionStatement = string | readonly [string, ReadonlyArray<SqlValue>];

/** The server's account of a transaction. */
export interface TransactionSummary {
  transaction: string;
  statements?: number;
  committed_writes?: number;
  discarded_writes?: number;
  [k: string]: Json | undefined;
}

export type CacheBytes = Buffer | Uint8Array | string | number[];

export interface CacheKeyInfo {
  key: string;
  ttl_ms: number | null;
  bytes: number;
}

export interface CacheStreamEntry {
  id: string;
  fields: [Buffer, Buffer][];
  text: Record<string, string>;
}

export type VectorMetric = 'cosine' | 'dot' | 'l2';
export type VectorQuantization = 'none' | 'int8';
export type GraphDirection = 'outgoing' | 'incoming' | 'both';

export interface VectorItem {
  id: string;
  vector: number[];
  metadata: Json;
}

export interface VectorHit {
  id: string;
  score: number;
  metadata: Json;
}

/** Search hits, best first. `index` (non-enumerable) names the path: `flat`, `hnsw`, `hnsw-int8`. */
export interface VectorHits extends Array<VectorHit> {
  readonly index: string;
}

export interface VectorCollectionInfo {
  collection: string;
  dimension: number;
  metric: VectorMetric;
  count: number;
  quantization: VectorQuantization;
}

export interface VectorPage {
  collection: string;
  vectors: VectorItem[];
  count: number;
  total: number;
  truncated: boolean;
}

export interface GraphNode {
  id: string;
  labels: string[];
  properties: Json;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  properties: Json;
}

export interface GraphNeighbor {
  edge_id: string;
  node_id: string;
  label: string;
  direction: GraphDirection;
}

export interface GraphTraversal {
  start: string;
  direction: GraphDirection;
  max_depth: number;
  limit: number;
  count: number;
  truncated: boolean;
  nodes: (GraphNode & { depth: number })[];
}

export interface GraphPath {
  found: boolean;
  hops: number;
  node_path: string[];
  edge_path: string[];
  message?: string;
}

export interface GraphWeightedPath extends GraphPath {
  total_cost: number;
  weight_property: string;
}

export interface GraphNodePage {
  graph: string;
  nodes: GraphNode[];
  count: number;
  total: number;
  truncated: boolean;
}

export interface GraphEdgePage {
  graph: string;
  edges: GraphEdge[];
  count: number;
  total: number;
  truncated: boolean;
}

export interface GraphQueryResult {
  graph: string;
  columns: string[];
  rows: Json[][];
  count: number;
  truncated: boolean;
}

export interface DocumentIndexInfo {
  index_name: string;
  field: string;
  unique: boolean;
}

export interface DocumentAnalyzeResult {
  analyzed: Json;
  document_count: number;
  indexed_fields: Json;
  [k: string]: Json;
}

/** An LLM context source: a SQL read, or a document find. */
export type LlmSource =
  | { sql: string }
  | { collection: string; filter?: DocumentFilterValue; limit?: number | null };

export interface LlmOptions {
  format?: string;
  maxRows?: number | null;
  redactSensitive?: boolean;
  includeSchema?: boolean;
}
