import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabasePool } from './db.js';

// Khởi động API: đọc cấu hình, kết nối PostgreSQL và lắng nghe trên cổng nội bộ.
const config = loadConfig();
const pool = createDatabasePool(config);
const app = createApp({ config, pool });

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Mapping review API đang lắng nghe tại cổng ${config.port}.`);
});

server.requestTimeout = 15_000;
server.headersTimeout = 16_000;
server.keepAliveTimeout = 5_000;

async function shutdown(signal) {
  console.log(`Nhận ${signal}; đang đóng API an toàn.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
