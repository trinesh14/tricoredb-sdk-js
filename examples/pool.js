const { Pool } = require('tricoredb');

async function main() {
  const pool = new Pool({ host: '127.0.0.1', port: 8427, size: 4 });
  const rows = await pool.use(async (db) => db.query('SELECT 1 AS n'));
  console.log(rows.rows);
  await pool.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
