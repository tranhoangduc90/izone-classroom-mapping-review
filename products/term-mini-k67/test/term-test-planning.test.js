import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';

// Dữ liệu giả trong database bộ nhớ: kiểm SQL thật, không gọi hệ thống học viên.
test('dàn ý riêng từng Task, mốc giờ bất biến, không nhận bản lưu cũ hoặc sửa sau nộp', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE k67_app; CREATE SCHEMA assessment;
      CREATE TABLE assessment.term_test_attempt (id uuid PRIMARY KEY, test_slug text, completed_at timestamptz,
        superseded_at timestamptz, writing_started_at timestamptz, writing_deadline_at timestamptz, writing_submitted_at timestamptz);
      INSERT INTO assessment.term_test_attempt VALUES ('00000000-0000-4000-8000-000000000091','term-test-2',now(),NULL,now(),now()+interval '60 minutes',NULL),
        ('00000000-0000-4000-8000-000000000092','term-test-1',now(),NULL,now(),now()+interval '40 minutes',NULL);`);
    const migration = await fs.readFile(new URL('../db/006-writing-planning.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const query = async (sql, params) => { const result = await db.query(sql, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; };
    const app = createApp({ config: { nodeEnv: 'test', authMode: 'legacy', legacyReviewToken: 'test-only-token', allowedOrigins: new Set(), trustProxyHops: 0 }, pool: { connect: async () => ({ query, release() {} }) } });
    const token = '00000000-0000-4000-8000-000000000091';
    const post = body => request(app).post('/api/term-tests/writing/planning').send({ attemptToken: token, taskNumber: 1, ...body });
    assert.equal((await post({ action: 'read' })).body.planning, null);
    const first = (await post({ action: 'start', startedAt: '2099-01-01T00:00:00Z' })).body.planning;
    assert.equal(Date.parse(first.deadlineAt) - Date.parse(first.startedAt), 300000);
    const again = (await post({ action: 'start' })).body.planning;
    assert.equal(again.startedAt, first.startedAt);
    assert.equal(again.deadlineAt, first.deadlineAt);
    const second = (await post({ action: 'start', taskNumber: 2 })).body.planning;
    assert.equal(Date.parse(second.deadlineAt) - Date.parse(second.startedAt), 600000);
    assert.equal((await post({ action: 'save', outline: 'Dàn ý giả mới', revision: 2 })).body.accepted, true);
    assert.equal((await post({ action: 'save', outline: 'Dàn ý giả mới', revision: 2 })).body.accepted, true);
    assert.equal((await post({ action: 'save', outline: 'Bản khác cùng phiên bản', revision: 2 })).body.accepted, false);
    const stale = await post({ action: 'save', outline: 'Dàn ý giả cũ', revision: 1 });
    assert.equal(stale.body.accepted, false);
    assert.equal(stale.body.planning.outline, 'Dàn ý giả mới');
    assert.equal((await post({ action: 'read', taskNumber: 2 })).body.planning.outline, '');
    assert.equal((await post({ action: 'start', attemptToken: '00000000-0000-4000-8000-000000000092' })).status, 404);
    await db.query('UPDATE assessment.term_test_attempt SET writing_submitted_at=now() WHERE id=$1', [token]);
    assert.equal((await post({ action: 'save', outline: 'Không được ghi', revision: 3 })).status, 409);
    assert.equal((await post({ action: 'read' })).body.planning.outline, 'Dàn ý giả mới');
    await db.query("UPDATE assessment.term_test_attempt SET writing_submitted_at=NULL, writing_deadline_at=now()-interval '1 second' WHERE id=$1", [token]);
    assert.equal((await post({ action: 'start' })).status, 409);
    assert.equal((await post({ action: 'save', outline: 'Không được ghi', revision: 4 })).status, 409);
    assert.equal((await post({ action: 'start', taskNumber: 3 })).status, 400);
    assert.equal((await post({ action: 'save', outline: 'Thiếu phiên bản' })).status, 400);
  } finally { await db.close(); }
});
