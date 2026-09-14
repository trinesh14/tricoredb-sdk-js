import tricore = require('tricoredb');

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type CjsCacheDelete = Expect<
  Equal<ReturnType<tricore.TriCore['cacheDelete']>, Promise<boolean>>
>;
export type CjsPoolUse = Expect<
  Equal<Awaited<ReturnType<tricore.Pool['use']>>, unknown>
>;

export async function cjsUsage(): Promise<boolean> {
  const db = await tricore.connect({ host: '127.0.0.1', port: tricore.DEFAULT_PORT });
  const deleted: boolean = await db.cacheDelete('ns', 'k');
  await db.close();
  return deleted;
}
