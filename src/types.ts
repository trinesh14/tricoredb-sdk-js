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
  /**
   * Send a request again when the server refuses it with `not_leader`
   * (default `true`): to the leader the refusal names, over a new connection
   * that replaces this one, or, while no leader is known, to the same node
   * after a pause. Safe because a `not_leader` refusal was applied nowhere.
   * Never inside a session transaction.
   */
  followLeader?: boolean;
  /** How many times a refused request is sent again. Default 5. */
  leaderRetries?: number;
  /** The first pause, in milliseconds, before sending again; it doubles up to 2000. Default 250. */
  leaderRetryDelayMs?: number;
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

export type VectorMetric = 'cosine' | 'dot' | 'l2' | 'l1' | 'linf';
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

// -- cache: server 0.1.0-rc.3 -------------------------------------------------

/** When `cacheSetIf` writes: unconditionally, only if absent (`NX`), only if present (`XX`). */
export type CacheSetCondition = 'Always' | 'IfAbsent' | 'IfPresent';

/** What happens to a key's expiry. Build it with `CacheExpiry`. */
export type CacheExpiryValue = 'Keep' | 'Clear' | { Set: { ttl_ms: number } };

export type CacheListEnd = 'Left' | 'Right';

/** `Not` takes exactly one source key. */
export type CacheBitOp = 'And' | 'Or' | 'Xor' | 'Not';

/** One cache operation in the server's externally-tagged wire form, for a pipeline, transaction or script. */
export type CacheOpValue = string | { [variant: string]: unknown };

/** One operation's outcome in a pipeline, transaction or script: its response data, or its error. */
export type CacheOpResult = { ok: Json; error?: undefined } | { error: string; ok?: undefined };

export interface CacheScoredMemberInput {
  member: CacheBytes;
  score: number;
}

export interface CacheScoredMember {
  member: Buffer;
  score: number;
}

/** One end of a score range. `exclusive` leaves the bound itself out. */
export interface CacheScoreBound {
  value: number;
  exclusive?: boolean;
}

export interface CacheFreshWrite {
  set: boolean;
  freshUntilMs: number;
}

/**
 * A stale-while-revalidate read. `fresh` and `stale` carry the value;
 * `refresh` is true for the one caller that should refresh a stale value,
 * `lease` for the one caller that should compute a missing one. `missing` is a
 * cached absence (`cacheSetMissing`).
 */
export interface CacheFreshRead {
  state: 'fresh' | 'stale' | 'missing' | 'miss';
  value: Buffer | null;
  refresh: boolean;
  lease: boolean;
  retryAfterMs: number | null;
}

export interface CacheWarmResult {
  written: number;
  alreadyCached: number;
}

export interface CacheZAddResult {
  added: number;
  updated: number;
}

/** `token` is the fencing token: it only ever rises for one lock. Null when the lock is held by `holder`. */
export interface CacheLock {
  acquired: boolean;
  token: number | null;
  holder: string | null;
  expiresAtMs: number | null;
}

export interface CacheLockRenewal {
  renewed: boolean;
  token: number | null;
  expiresAtMs: number | null;
}

export interface CacheExpireAtResult {
  updated: boolean;
  /** The deadline had already passed, so the key was deleted. */
  deleted: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRatio: number | null;
  memory: { [k: string]: Json };
  eviction: { [k: string]: Json };
  [k: string]: Json;
}

/**
 * `current` is what the key held when the swap was refused, when that is valid
 * UTF-8. A binary value sets `currentIsBinary` instead: read it with `cacheGet`.
 */
export interface CacheSwapResult {
  swapped: boolean;
  current: Buffer | null;
  currentIsBinary: boolean;
}

export interface CacheTrimResult {
  length: number;
  removed: number;
}

export interface CacheScriptLoaded {
  loaded: string;
  ops: number;
}

export interface CacheScriptRun {
  results: CacheOpResult[];
  /** The operations that ran, with the arguments substituted. */
  ops: CacheOpValue[];
}

export interface CacheListPop {
  key: string;
  value: Buffer;
}

export interface CacheNamespaceLimit {
  namespace: string;
  max_keys: number | null;
  max_bytes: number | null;
  keys: number;
  bytes: number;
}

export interface CacheMessage {
  id: number;
  channel: string;
  message: string;
  at_ms: number;
}

/** `next` is the id to pass as `after` on the following poll. */
export interface CachePollResult {
  messages: CacheMessage[];
  next: number;
}

// -- document: server 0.1.0-rc.3 ----------------------------------------------

/** Whether a by-id write hands back the document it touched, and which version of it. */
export type DocumentReturn = 'None' | 'Before' | 'After';

export interface DocumentSortKey {
  field: string;
  descending?: boolean;
  collation?: { case_insensitive?: boolean; numeric?: boolean };
}

/** One item of `documentBulkWrite` in the server's externally-tagged wire form. Build it with `DocBulk`. */
export type BulkOpValue = { [variant: string]: unknown };

/** `document` is present only when `return` asked for it and that version exists. */
export interface DocumentReplaceResult {
  replaced: boolean;
  inserted: boolean;
  id: string;
  document?: JsonObject;
}

export interface DocumentRenameResult {
  renamed: boolean;
  from: string;
  to: string;
  documents: number;
  indexes: number;
}

export interface DocumentPurgeResult {
  purged: number;
  /** More expired documents remain; call again. */
  more: boolean;
}

export interface DocumentExplain {
  plan: string;
  index: string | null;
  index_used: boolean;
  scan_reason: string | null;
  scan_source: string | null;
  estimated_rows: number;
  estimated_cost: number;
  rows_examined: number;
  rows_returned: number;
  elapsed_us: number;
  [k: string]: Json;
}

export interface DocumentCommitResult {
  committed: boolean;
  writes: number;
}

export interface DocumentRebuildResult {
  rebuilt: string;
  documents: number;
  entries: number;
}

export type DocumentFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** What one field may hold. Every rule given must pass. */
export interface DocumentFieldRule {
  type?: DocumentFieldType;
  one_of?: Json[];
  minimum?: number;
  maximum?: number;
  min_length?: number;
  max_length?: number;
  pattern?: string;
}

export interface DocumentSchema {
  required?: string[];
  fields?: Record<string, DocumentFieldRule>;
  /** Whether a top-level field the schema does not name is allowed. Default true. */
  additional_fields?: boolean;
}

/** Rules a collection applies to every document written into it. */
export interface DocumentCollectionOptions {
  schema?: DocumentSchema;
  /** `path -> value` given to a newly created document that lacks the path. */
  defaults?: Record<string, Json>;
  /** Keep a `_version` counter on every document, enabling `expectedVersion`. */
  versioned?: boolean;
}

export interface DocumentOptionsUpdate {
  updated: boolean;
  documents_checked: number;
}

export interface DocumentBulkResult {
  inserted: number;
  updated: number;
  replaced: number;
  deleted: number;
  upserted: number;
  inserted_ids: string[];
}

// -- vector: server 0.1.0-rc.3 ------------------------------------------------

export interface VectorUpsertItem {
  id: string;
  vector: ArrayLike<number>;
  metadata?: Json;
}

export interface VectorTextItem {
  id: string;
  text: string;
  metadata?: Json;
}

export interface VectorSparse {
  indices: number[];
  values: number[];
}

/** How a search is shaped and how hard it looks. Every field is optional; the server supplies the defaults. */
export interface VectorSearchOptions {
  /** Skip this many ranked hits before `topK`. */
  offset?: number;
  /** Whether each hit carries its metadata. Default true. */
  includeMetadata?: boolean;
  /** Only hits within this distance, in the metric's own units. Refused for `dot`. */
  maxDistance?: number;
  efSearch?: number;
  /** Score every stored vector instead of walking the ANN index. */
  exact?: boolean;
  scoreMetric?: VectorMetric;
  filterStrategy?: 'auto' | 'graph' | 'exact';
  /** Search this named vector (`vectorAddNamedVector`) instead of the default one. */
  using?: string;
  tenant?: string;
  namespace?: string;
  sparse?: VectorSparse;
  hybridAlpha?: number;
  /** Give each hit a one-line `reason`. */
  explain?: boolean;
  scoreExpr?: string;
  explainText?: string;
  ann?: 'hnsw' | 'ivf' | 'ivf_pq';
  nprobe?: number;
}

/** A hit of the batch, multi and by-example searches. Which optional fields appear depends on the options asked for. */
export interface VectorSearchHit {
  id: string;
  score: number;
  metadata?: Json;
  vector?: number[];
  reason?: string;
  [k: string]: Json | undefined;
}

export interface VectorEmbedding {
  dimension: number;
  embedder: string;
  vectors: number[][];
  sparse: VectorSparse[];
}

export interface VectorAlias {
  alias: string;
  collection: string;
}

export interface VectorPartitions {
  field: string;
  partitions: { name: string; count: number }[];
  unpartitioned: number;
}

export interface VectorRenameResult {
  renamed: boolean;
  from: string;
  to: string;
  moved: number;
}

export interface VectorRebuildResult {
  rebuilt: boolean;
  persisted: boolean;
  vectors: number;
  tombstones_cleared: number;
  build_ms: number;
  [k: string]: Json;
}

/** The index's shape. The fields beyond these depend on the index kind (`flat`, `hnsw`, ...). */
export interface VectorIndexStats {
  collection: string;
  index: string;
  [k: string]: Json;
}

/** `measured` is false, with a `reason`, when the collection is answered by an exact scan. */
export interface VectorRecall {
  collection: string;
  index: string;
  measured: boolean;
  recall: number;
  reason?: string;
  [k: string]: Json | undefined;
}

export interface VectorMultiHit {
  id: string;
  score: number;
  /** How many of the queries ranked this vector. */
  matched: number;
  metadata?: Json;
}

export interface VectorMultiHits {
  fusion: 'rrf' | 'max' | 'mean';
  queries: number;
  depth: number;
  results: VectorMultiHit[];
}

export interface VectorCollectionConfig {
  collection: string;
  normalize: boolean;
  m: number;
  ef_construction: number;
  multi_tenant: boolean;
  named: { name: string; dimension: number; metric: VectorMetric }[];
}

/** An example for `vectorSearchByExamples`: a stored vector's id, or a vector given inline. */
export type VectorExample = string | ArrayLike<number>;

/** By-example hits, best first. `index` (non-enumerable) names the path that served them. */
export interface VectorExampleHits extends Array<VectorSearchHit> {
  readonly index: string;
}

// -- graph: server 0.1.0-rc.3 -------------------------------------------------

export interface GraphNodeInput {
  id: string;
  labels?: string[];
  properties?: Json;
}

export interface GraphEdgeInput {
  id: string;
  from: string;
  to: string;
  label: string;
  properties?: Json;
}

export interface GraphBatchResult {
  nodes: number;
  edges: number;
  atomic: boolean;
}

export interface GraphRemoveResult {
  nodes_removed: number;
  edges_removed: number;
  atomic: boolean;
}

export interface GraphCopyResult {
  copied: boolean;
  to: string;
  nodes: number;
  edges: number;
}

export interface GraphDfsResult extends GraphTraversal {
  order: string;
}

export interface GraphComponent {
  nodes: string[];
  size: number;
  truncated: boolean;
}

/** `count` and `largest` describe every component; `components` lists at most `limit` of them. */
export interface GraphComponents {
  kind: 'weak' | 'strong';
  count: number;
  largest: number;
  truncated: boolean;
  components: GraphComponent[];
}

export interface GraphCycle {
  hasCycle: boolean;
  directed: boolean;
  cycle: { nodes: string[]; edges: string[] } | null;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  nodeLabels: Record<string, number>;
  edgeTypes: Record<string, number>;
  selfLoops: number;
  isolatedNodes: number;
  unlabeledNodes: number;
  danglingEdges: number;
  maxInDegree: number;
  maxOutDegree: number;
  avgOutDegree: number;
  [k: string]: Json;
}

export interface GraphSubgraph {
  direction: GraphDirection;
  max_depth: number;
  limit: number;
  nodes: (GraphNode & { depth: number })[];
  edges: GraphEdge[];
  node_count: number;
  edge_count: number;
  nodes_truncated: boolean;
  edges_truncated: boolean;
}

export interface GraphPropertyInfo {
  key: string;
  count: number;
  types: string[];
}

export interface GraphSchemaInfo {
  nodes: number;
  edges: number;
  node_labels: { label: string; count: number; properties: GraphPropertyInfo[] }[];
  edge_types: { type: string; count: number; properties: GraphPropertyInfo[] }[];
  unlabeled_nodes: { count: number; properties: GraphPropertyInfo[] };
}

export interface GraphRankedPath {
  nodes: string[];
  edges: string[];
  hops: number;
  cost: number;
}

export interface GraphPaths {
  from: string;
  to: string;
  direction: GraphDirection;
  k: number;
  weight_property: string | null;
  count: number;
  paths: GraphRankedPath[];
}

/** `complete` is false, with `stopped_by` naming the bound, when the enumeration did not finish. */
export interface GraphAllPaths {
  from: string;
  to: string;
  direction: GraphDirection;
  max_depth: number;
  limit: number;
  count: number;
  complete: boolean;
  stopped_by: string | null;
  paths: GraphRankedPath[];
}

export interface GraphScore {
  id: string;
  score: number;
}

export type GraphCentralityMeasure = 'betweenness' | 'closeness' | 'eigenvector';

/** `iterations` and `converged` are reported for `eigenvector` only. */
export interface GraphCentrality {
  measure: GraphCentralityMeasure;
  directed: boolean;
  nodes: number;
  results: GraphScore[];
  iterations?: number;
  converged?: boolean;
}

export interface GraphCommunities {
  algorithm: string;
  count: number;
  modularity: number;
  iterations: number;
  converged: boolean;
  communities: GraphComponent[];
}

export interface GraphTriangles {
  triangles: number;
  transitivity: number;
  average_clustering: number;
  nodes: { id: string; triangles: number; clustering: number }[];
}

export interface GraphSimilarity {
  node: string;
  direction: GraphDirection;
  metric: 'jaccard' | 'overlap';
  count: number;
  results: GraphScore[];
}

export interface GraphFindings {
  count: number;
  listed: Json[];
}

export interface GraphConsistency {
  consistent: boolean;
  nodes: number;
  edges: number;
  dangling_edges: GraphFindings;
  undecodable: GraphFindings;
  misfiled: GraphFindings;
  mirror: { loaded: boolean; differences: GraphFindings };
}

export type GraphConstraintKind = 'unique' | 'required';
export type GraphConstraintTarget = 'node' | 'edge';

export interface GraphSchemaObjects {
  indexes: { name: string; label: string | null; properties: string[] }[];
  constraints: {
    name: string;
    label: string;
    property: string;
    kind: GraphConstraintKind;
    target: GraphConstraintTarget;
  }[];
}

/** `plan` says how the request was answered: an index by name, the label index, or `scan`. */
export interface GraphFoundNodes {
  nodes: GraphNode[];
  count: number;
  plan: string;
  truncated: boolean;
}

export interface GraphPageRank {
  damping: number;
  iterations: number;
  converged: boolean;
  count: number;
  truncated: boolean;
  ranks: GraphScore[];
}

/**
 * What a Cypher write did. Inside a graph transaction the statement is queued
 * instead: only `queued` and `transaction` are present.
 */
export interface GraphWriteResult {
  graph?: string;
  statements?: number;
  nodesCreated?: number;
  nodesDeleted?: number;
  relationshipsCreated?: number;
  relationshipsDeleted?: number;
  propertiesSet?: number;
  labelsAdded?: number;
  labelsRemoved?: number;
  queued?: number;
  transaction?: string;
  [k: string]: Json | undefined;
}

/** A committed graph transaction: how many statements, and what they did together. */
export interface GraphCommitResult extends GraphWriteResult {
  committed: number;
  cypher?: string;
}
