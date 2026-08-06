import pg from 'pg';

const { Pool } = pg;

// Tạo pool kết nối nhỏ để API không chiếm hết connection của PostgreSQL.
export function createDatabasePool(config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'izone_mapping_review_api'
  });

  pool.on('error', () => {
    // Không ghi connection string hoặc dữ liệu truy vấn vào log.
    console.error('PostgreSQL pool gặp lỗi kết nối nền.');
  });
  return pool;
}

// Chạy một thao tác trong transaction; lỗi ở bất kỳ bước nào đều rollback.
export async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
