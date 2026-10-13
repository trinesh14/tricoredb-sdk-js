import type {
  AccumulatorValue,
  AggregateStageValue,
  BulkOpValue,
  CacheExpiryValue,
  DocumentFilterValue,
  DocumentUpdateSpec,
  GroupKeyValue,
  Json,
  JsonObject,
} from './types.js';

/**
 * Builders for the server's `DocumentFilter` wire form. There is no `Or`, `Not`
 * or regex: that is the server's vocabulary, not an omission here.
 */
export const DocFilter = {
  all: (): DocumentFilterValue => 'All',
  eq: (field: string, value: Json): DocumentFilterValue => ({ Eq: { field, value } }),
  ne: (field: string, value: Json): DocumentFilterValue => ({ Ne: { field, value } }),
  gt: (field: string, value: Json): DocumentFilterValue => ({ Gt: { field, value } }),
  gte: (field: string, value: Json): DocumentFilterValue => ({ Gte: { field, value } }),
  lt: (field: string, value: Json): DocumentFilterValue => ({ Lt: { field, value } }),
  lte: (field: string, value: Json): DocumentFilterValue => ({ Lte: { field, value } }),
  /** `field` equals any of `values`. Named `inList` because `in` is reserved. */
  inList: (field: string, values: Json[]): DocumentFilterValue => ({ In: { field, values } }),
  contains: (field: string, value: Json): DocumentFilterValue => ({ Contains: { field, value } }),
  and: (...filters: (DocumentFilterValue | DocumentFilterValue[])[]): DocumentFilterValue => ({
    And: filters.flat(),
  }),
};

/** What `cacheSetIf` and `cacheGetEx` do with a key's expiry. */
export const CacheExpiry = {
  /** Leave the deadline as it is (`KEEPTTL`). */
  keep: (): CacheExpiryValue => 'Keep',
  /** Remove the deadline, as a plain `SET` and `PERSIST` do. */
  clear: (): CacheExpiryValue => 'Clear',
  /** Expire this many milliseconds from now. */
  set: (ttlMs: number): CacheExpiryValue => ({ Set: { ttl_ms: ttlMs } }),
};

/**
 * Builders for the items of `documentBulkWrite`. The items apply in order as
 * one atomic batch, and a later item sees the effect of an earlier one.
 */
export const DocBulk = {
  /** Insert a document; the id is generated when omitted. */
  insert: (document: JsonObject, opts: { id?: string | null } = {}): BulkOpValue => ({
    Insert: { id: opts.id ?? null, document },
  }),
  /** Apply `{ set, inc }` to one document. `expectedVersion` needs a versioned collection. */
  updateOne: (
    id: string,
    update: DocumentUpdateSpec,
    opts: { upsert?: boolean; expectedVersion?: number | null } = {},
  ): BulkOpValue => ({
    UpdateOne: {
      id,
      update: { set: (update || {}).set ?? {}, inc: (update || {}).inc ?? {} },
      upsert: !!opts.upsert,
      expected_version: opts.expectedVersion ?? null,
    },
  }),
  /** Swap a document's whole body. */
  replace: (
    id: string,
    document: JsonObject,
    opts: { upsert?: boolean; expectedVersion?: number | null } = {},
  ): BulkOpValue => ({
    Replace: { id, document, upsert: !!opts.upsert, expected_version: opts.expectedVersion ?? null },
  }),
  delete: (id: string, opts: { expectedVersion?: number | null } = {}): BulkOpValue => ({
    Delete: { id, expected_version: opts.expectedVersion ?? null },
  }),
};

/** Builders for aggregation stages, group keys and accumulators. Stages apply in order. */
export const DocStage = {
  match: (filter: DocumentFilterValue): AggregateStageValue => ({ Match: filter }),
  group: (by: GroupKeyValue, accumulators: AccumulatorValue[] = []): AggregateStageValue => ({
    Group: { by, accumulators },
  }),
  sort: (keys: { field: string; descending?: boolean }[]): AggregateStageValue => ({
    Sort: keys.map((k) => ({ field: k.field, descending: !!k.descending })),
  }),
  skip: (n: number): AggregateStageValue => ({ Skip: n }),
  limit: (n: number): AggregateStageValue => ({ Limit: n }),
  project: (fields: string[], include = true): AggregateStageValue => ({ Project: { fields, include } }),
  count: (field: string): AggregateStageValue => ({ Count: { field } }),

  byField: (field: string): GroupKeyValue => ({ Field: field }),
  byConstant: (value: Json): GroupKeyValue => ({ Constant: value }),

  sum: (output: string, field: string): AccumulatorValue => ({ output, op: { Sum: field } }),
  avg: (output: string, field: string): AccumulatorValue => ({ output, op: { Avg: field } }),
  min: (output: string, field: string): AccumulatorValue => ({ output, op: { Min: field } }),
  max: (output: string, field: string): AccumulatorValue => ({ output, op: { Max: field } }),
  /** Counts documents, so it takes no field. */
  countDocs: (output: string): AccumulatorValue => ({ output, op: 'Count' }),
};
