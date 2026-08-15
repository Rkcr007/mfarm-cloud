import pg from 'pg';
const url = process.env.DATABASE_URL ?? 'postgres://mfarm:mfarm@localhost:5433/mfarm';
for (let i = 0; i < 60; i++) {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query('SELECT 1'); await c.end(); console.log('postgres ready'); process.exit(0); }
  catch { await c.end().catch(() => {}); await new Promise((r) => setTimeout(r, 1000)); }
}
console.error('postgres did not become ready in 60s'); process.exit(1);
