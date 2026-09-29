import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const addresses = [
  'danhhien94@gmail.com',
  'gia081004@gmail.com',
  'chinhleenglish@gmail.com',
  'tuanhung.bui.ec@gmail.com'
].sort();

async function setup() {
  const database = new PGlite();
  await database.exec(`
    CREATE ROLE learning_api NOLOGIN;
    CREATE SCHEMA mapping;
    CREATE SCHEMA learning;
    CREATE TABLE mapping.reviewer_account (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'teacher',
      status TEXT NOT NULL DEFAULT 'active',
      can_access_all_classes BOOLEAN NOT NULL DEFAULT false
    );
  `);
  const migration = await readFile(
    new URL('../ops/learning-migrations/202609280001_progress_log_admin_scope.sql', import.meta.url),
    'utf8'
  );
  await database.exec(migration);
  return database;
}

async function runSql(database, path) {
  const sql = await readFile(new URL(path, import.meta.url), 'utf8');
  await database.exec(sql);
}

test('cấp và thu hồi đúng bốn quyền Progress Log, giữ role hệ thống là teacher', async () => {
  const database = await setup();
  await runSql(database, '../ops/releases/progress-log-admins-20260928/grant.sql');
  await runSql(database, '../ops/releases/progress-log-admins-20260928/grant.sql');
  const granted = await database.query(`SELECT account.email, account.role,
      account.can_access_all_classes, admin.status
    FROM mapping.reviewer_account AS account
    JOIN learning.progress_log_admin AS admin ON admin.reviewer_email = account.email
    ORDER BY account.email;`);
  assert.deepEqual(granted.rows.map(row => row.email), addresses);
  assert.ok(granted.rows.every(row => row.role === 'teacher'
    && row.can_access_all_classes === false && row.status === 'active'));
  await runSql(database, '../ops/releases/progress-log-admins-20260928/rollback.sql');
  const revoked = await database.query(`SELECT status FROM learning.progress_log_admin ORDER BY reviewer_email;`);
  assert.ok(revoked.rows.every(row => row.status === 'revoked'));
  await database.close();
});

test('không âm thầm đổi tài khoản đang có quyền toàn hệ thống', async () => {
  const database = await setup();
  await database.query(`INSERT INTO mapping.reviewer_account
    (email, role, status, can_access_all_classes)
    VALUES ($1, 'admin', 'active', true);`, [addresses[0]]);
  await assert.rejects(
    () => runSql(database, '../ops/releases/progress-log-admins-20260928/grant.sql'),
    /PROGRESS_LOG_ADMIN_ACCOUNT_SCOPE_MISMATCH/
  );
  await database.exec('ROLLBACK;');
  const granted = await database.query('SELECT count(*)::int AS count FROM learning.progress_log_admin;');
  assert.equal(granted.rows[0].count, 0);
  await database.close();
});
