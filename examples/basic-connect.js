const { TriCore } = require('tricoredb');

async function main() {
  const db = await TriCore.connect({ host: '127.0.0.1', port: 8427, user: 'alice', secret: 'pw' });
  const rows = await db.query('SELECT 1 AS n');
  console.log(rows.rows);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
