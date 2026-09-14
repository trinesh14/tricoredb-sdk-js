import {
  TriCore,
  Pool,
  Rows,
  Response,
  TriCoreError,
  DocFilter,
  NOT_LEADER,
  type ConnectOptions,
  type GrantedFeatures,
  type TransactionSummary,
} from 'tricoredb';

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Resolved<K extends keyof TriCore> = TriCore[K] extends (...args: any[]) => Promise<infer R> ? R : never;

// The drift that motivated generating declarations: cacheDelete resolves a boolean.
export type CacheDeleteIsBoolean = Expect<Equal<Resolved<'cacheDelete'>, boolean>>;
export type CacheGetIsBuffer = Expect<Equal<Resolved<'cacheGet'>, Buffer | null>>;
export type QueryIsRows = Expect<Equal<Resolved<'query'>, Rows>>;
export type ExecuteIsResponse = Expect<Equal<Resolved<'execute'>, Response>>;
export type CancelIsNumber = Expect<Equal<Resolved<'cancel'>, number>>;
export type BeginIsSummary = Expect<Equal<Resolved<'begin'>, TransactionSummary>>;
export type FeaturesShape = Expect<Equal<TriCore['features'], GrantedFeatures>>;
export type CodeIsNullable = Expect<Equal<TriCoreError['code'], string | null>>;
export type HintIsNullable = Expect<Equal<TriCoreError['leaderHint'], string | null>>;
export type RedirectIsBoolean = Expect<Equal<TriCoreError['isRedirect'], boolean>>;

export async function usage(opts: ConnectOptions): Promise<void> {
  const db = await TriCore.connect(opts);
  const rows = await db.query('SELECT * FROM t WHERE id = ?', [1n]);
  const first: string[] | undefined = rows.rows[0];
  void first;
  await db.execute('INSERT INTO t VALUES (?, ?, ?)', [Buffer.from([1]), new Date(), null]);
  await db.execute('CREATE TABLE t (id INT)', 'main');
  const found = await db.documentFind('people', DocFilter.eq('name', 'Ada'), { limit: 1 });
  void found;
  // @ts-expect-error a plain object is not a SQL parameter
  await db.execute('INSERT INTO t VALUES (?)', [{ a: 1 }]);

  const pool = new Pool({ ...opts, size: 2 });
  const n: number = await pool.use(async (c) => c.cacheIncr('ns', 'k'));
  void n;
  await pool.close();

  try {
    await db.execute('INSERT INTO t VALUES (1)');
  } catch (e) {
    if (e instanceof TriCoreError && e.code === NOT_LEADER) {
      const hint: string | null = e.leaderHint;
      void hint;
    }
  }
  await db.close();
}
