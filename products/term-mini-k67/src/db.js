import pg from 'pg';

// Chỉ mở pool K67; kiểm danh tính DB thật trước khi phục vụ hoặc đánh thức hàng chấm.
export function createDatabasePool(config) {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    application_name: 'term-mini-k67',
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    options: '-c search_path=assessment,mapping,public -c statement_timeout=15000'
  });
}
export async function verifyDatabaseBoundary(pool, config) {
  const result = await pool.query('SELECT current_database() AS database_name, current_user AS role_name');
  const row = result.rows[0];
  if (row?.database_name !== config.databaseName || row?.role_name !== 'k67_app') {
    throw new Error('Danh tính DB K67 không đúng cấu hình; dừng trước phục vụ.');
  }
}
