import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('lượt ERP 102 phải mới hơn 98 theo ID số, không theo alias dạng chữ', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE sync_run (id BIGINT PRIMARY KEY, source TEXT NOT NULL);
      INSERT INTO sync_run VALUES
        (98, 'n8n_k56_erp_ongoing'), (102, 'n8n_k56_erp_ongoing');
    `);
    const wrong = await database.query(`SELECT run.id::text AS id FROM sync_run AS run
      WHERE run.source = 'n8n_k56_erp_ongoing' ORDER BY id DESC LIMIT 1`);
    const correct = await database.query(`SELECT run.id::text AS id FROM sync_run AS run
      WHERE run.source = 'n8n_k56_erp_ongoing' ORDER BY run.id DESC LIMIT 1`);
    assert.equal(wrong.rows[0].id, '98');
    assert.equal(correct.rows[0].id, '102');
    const source = await readFile(new URL(
      '../ops/releases/k56-class-access-20260924/import_shared_roster.py', import.meta.url),
    'utf8');
    assert.match(source, /ORDER BY run\.id DESC LIMIT 1/);
    assert.doesNotMatch(source, /ORDER BY id DESC LIMIT 1/);
    const audit = await readFile(new URL(
      '../ops/releases/k56-class-access-20260924/audit_pre_cutover.py', import.meta.url),
    'utf8');
    assert.ok(/SELECT run\.id::text[\s\S]*?ORDER BY run\.id DESC LIMIT 1/.test(audit),
      'Audit phải sắp theo ID số, không theo alias text.');
  } finally {
    await database.close();
  }
});
