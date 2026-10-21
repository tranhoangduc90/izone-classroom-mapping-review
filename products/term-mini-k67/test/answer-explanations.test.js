import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { mountAnswerExplanations } from '../src/answer-explanations.js';

// DB và file đề đều là dữ liệu giả trên máy local. Kiểm HTTP thật cùng điều kiện SQL,
// gồm lượt chưa nộp đủ, đổi phiên bản và lỗi file; không gửi điểm hoặc gọi AI/Portal.
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
test('lời giải chỉ mở sau đủ kỹ năng, đúng lượt, đúng nguồn và đúng phiên bản', async t => {
  const db = new PGlite();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'k67-explanations-'));
  t.after(async () => { await db.close(); await fs.rm(root, { recursive: true, force: true }); });
  await db.exec(`CREATE SCHEMA assessment;
    CREATE TABLE assessment.test_definition(slug text,version integer,listening_definition jsonb,reading_definition jsonb);
    CREATE TABLE assessment.term_test_attempt(id uuid,test_slug text,definition_version integer,combined_result jsonb,
      listening_answers jsonb,reading_answers jsonb,completed_at timestamptz,writing_submitted_at timestamptz,writing_scope text);`);
  const definitions = { listening: { questions: [{ number: 11, accepted: ['L'] }] }, reading: { questions: [{ number: 14, accepted: ['R'] }] } };
  const tokens = {};
  for (const slug of ['term-test-1', 'mini-test-lesson-5', 'term-test-2']) {
    await db.query('INSERT INTO assessment.test_definition VALUES($1,1,$2,$3)', [slug, definitions.listening, definitions.reading]);
    const content = JSON.stringify({ baseTestSlug: slug,
      reading: { sections: [{ range: 'Questions 14–14' }] }, listening: { sections: [{ range: 'Questions 11–11' }] } });
    await fs.mkdir(path.join(root, slug));
    await fs.writeFile(path.join(root, slug, 'content.json'), content);
    const entry = (number, source) => ({ number, section: 0, answers: [number === 11 ? 'L' : 'R'],
      evidence: [[{ text: source }]], blocks: [{ analysis: [[{ text: 'Lý do giả' }]] }] });
    await fs.writeFile(path.join(root, slug, 'explanations.json'), JSON.stringify({ schemaVersion: 1, testSlug: slug,
      definitionVersion: 1, definitionSha256: hash(canonical(definitions)), contentSha256: hash(content),
      skills: { listening: { entries: { 11: entry(11, 'Nguồn nghe giả') } }, reading: { entries: { 14: entry(14, 'Nguồn đọc khác giả') } } } }));
    for (const state of ['started', 'lr', 'lr_only', 'complete']) {
      const token = crypto.randomUUID(); tokens[`${slug}:${state}`] = token;
      await db.query('INSERT INTO assessment.term_test_attempt VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)',
        [token, slug, { listening: { details: [{ number: 11, result: 'incorrect' }] } }, { 11: 'Sai giả' }, { 14: 'R' },
          state === 'started' ? null : '2026-10-17T00:00:00Z', state === 'complete' ? '2026-10-17T00:00:00Z' : null,
          state === 'lr_only' ? 'lr_only' : 'required']);
    }
  }
  const app = express(); app.use(express.json());
  mountAnswerExplanations(app, { pool: db, config: { termTestAssetDir: root }, limiter: (req, res, next) => next() });
  const get = token => request(app).post('/api/term-tests/result/explanations').send({ attemptToken: token });
  for (const token of [null, 'bad', '../term-test-1']) assert.equal((await get(token)).status, 400);
  assert.equal((await get(crypto.randomUUID())).status, 404);
  for (const state of ['started', 'lr']) {
    const response = await get(tokens[`term-test-1:${state}`]);
    assert.equal(response.status, 404); assert.equal(response.body.review, undefined);
  }
  const complete = await get(tokens['term-test-1:complete']);
  assert.equal(complete.status, 200);
  assert.match(complete.headers['cache-control'], /no-store/);
  assert.equal(complete.body.review.answers.listening[11], 'Sai giả');
  assert.equal(complete.body.review.bundle.skills.reading.entries[14].evidence[0][0].text, 'Nguồn đọc khác giả');
  assert.equal(complete.body.review.result.listening.details[0].result, 'incorrect');
  assert.equal((await get(tokens['mini-test-lesson-5:lr'])).status, 200);
  assert.equal((await get(tokens['term-test-1:lr_only'])).status, 200);
  assert.equal((await get(tokens['mini-test-lesson-5:started'])).status, 404);
  assert.equal((await get(tokens['term-test-2:complete'])).status, 200);
  assert.equal((await get(tokens['term-test-2:lr_only'])).status, 200);
  for (const state of ['started', 'lr']) assert.equal((await get(tokens[`term-test-2:${state}`])).status, 404);
  const term2file = path.join(root, 'term-test-2', 'explanations.json');
  const term2 = JSON.parse(await fs.readFile(term2file, 'utf8'));
  await fs.writeFile(term2file, JSON.stringify({ ...term2, definitionVersion: 2 }));
  assert.equal((await get(tokens['term-test-2:complete'])).status, 409);
  await fs.unlink(term2file);
  assert.equal((await get(tokens['term-test-2:complete'])).status, 404);
  const file = path.join(root, 'term-test-1', 'explanations.json');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const mutation of [b => { b.testSlug = 'mini-test-lesson-5'; }, b => { b.definitionVersion++; },
    b => { b.contentSha256 = 'changed'; }, b => { b.definitionSha256 = 'changed'; },
    b => { delete b.skills.listening.entries[11]; }, b => { b.skills.reading.entries[14].number = 15; },
    b => { b.skills.reading.entries[14].answers = ['L']; }, b => { b.skills.reading.entries[14].section = 1; }]) {
    const changed = structuredClone(original); mutation(changed);
    await fs.writeFile(file, JSON.stringify(changed));
    const response = await get(tokens['term-test-1:complete']);
    assert.equal(response.status, 409); assert.equal(response.body.review, undefined);
  }
  await fs.unlink(file);
  assert.equal((await get(tokens['term-test-1:complete'])).status, 404);
});
