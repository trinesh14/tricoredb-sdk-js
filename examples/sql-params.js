const { TriCore } = require('tricoredb');

async function main() {
  const db = await TriCore.connect({ host: '127.0.0.1', port: 8427 });
  await db.execute('INSERT INTO t VALUES (?, ?, ?)', [42, 'ada', Buffer.from([0xde, 0xad])]);
  const rows = await db.query('SELECT * FROM t WHERE id = ?', [42]);
  console.log(rows.rows);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
