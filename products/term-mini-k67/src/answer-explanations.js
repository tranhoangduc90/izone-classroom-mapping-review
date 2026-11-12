import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { publicAudioCatalog } from './public-audio-catalog.js';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export const explanationSlugs = new Set(['term-test-1', 'term-test-2', 'mini-test-lesson-5', 'pretest-lesson-16']);
export const explanationAttemptSql = `SELECT
  attempt.test_slug, attempt.definition_version, attempt.combined_result,
  attempt.listening_answers, attempt.reading_answers,
  definition.listening_definition, definition.reading_definition
FROM assessment.term_test_attempt AS attempt
JOIN assessment.test_definition AS definition
  ON definition.slug = attempt.test_slug AND definition.version = attempt.definition_version
WHERE attempt.id = $1::uuid AND attempt.completed_at IS NOT NULL
  AND (attempt.test_slug = 'mini-test-lesson-5' OR attempt.writing_scope = 'lr_only'
    OR attempt.writing_submitted_at IS NOT NULL);`;

const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// Nhận lượt đã nộp đủ; chỉ đọc gói riêng tư khớp cả nội dung đề lẫn đáp án chấm.
// Trả lời giải theo kỹ năng/số câu, giữ kết quả cũ; file thiếu hoặc sai phiên bản báo lỗi ở nút xem.
export async function loadAnswerExplanations(assetDir, row) {
  if (!assetDir || !explanationSlugs.has(row.test_slug)) return null;
  const root = path.join(assetDir, row.test_slug);
  let raw;
  try { raw = await fs.readFile(path.join(root, 'explanations.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const bundle = JSON.parse(raw);
  const content = await fs.readFile(path.join(root, 'content.json'), 'utf8');
  const parsedContent = JSON.parse(content);
  const definitions = { listening: row.listening_definition, reading: row.reading_definition };
  if (bundle.schemaVersion !== 1 || bundle.testSlug !== row.test_slug
      || bundle.definitionVersion !== Number(row.definition_version)
      || bundle.contentSha256 !== digest(content)
      || bundle.definitionSha256 !== digest(canonical(definitions))) {
    throw new Error('EXPLANATION_VERSION_MISMATCH');
  }
  for (const skill of ['listening', 'reading']) {
    const entries = bundle.skills?.[skill]?.entries;
    const questions = definitions[skill].questions;
    if (!entries || Object.keys(entries).length !== questions.length
        || questions.some(q => {
          const entry = entries[q.number];
          const expected = q.pairGroup ? definitions[skill].pairGroups[q.pairGroup].expected : q.accepted;
          const range = parsedContent[skill]?.sections?.[entry?.section]?.range?.match(/\d+/g)?.map(Number);
          return entry?.number !== q.number || canonical(entry.answers) !== canonical(expected)
            || !range || q.number < range[0] || q.number > range[1]
            || !entry?.evidence?.length || !entry?.blocks?.length;
        })) {
      throw new Error('EXPLANATION_CONTENT_INCOMPLETE');
    }
  }
  // Mốc nghe chỉ dùng đúng MP3 đã phát hành; không nhận URL/file hoặc khoảng thời gian lạ.
  const listening = Object.values(bundle.skills.listening.entries);
  if (bundle.reviewAudio || listening.some(e => e.replay?.length)) {
    const audio = bundle.reviewAudio, catalog = publicAudioCatalog[row.test_slug];
    const validClip = c => c && typeof c.id === 'string' && Number.isInteger(c.startMs) && Number.isInteger(c.endMs)
      && c.startMs >= 0 && c.endMs > c.startMs && c.endMs <= audio.durationMs;
    const privatePretest = row.test_slug === 'pretest-lesson-16';
    const identity = privatePretest ? JSON.parse(await fs.readFile(path.join(root, 'audio.private.json'), 'utf8')) : null;
    const matchingAudio = privatePretest
      ? audio?.private === true && audio.asset === 'listening-audio.mp3'
        && /^[0-9a-f]{64}$/.test(audio.sha256) && audio.sha256 === identity.sha256 && audio.durationMs === identity.durationMs
      : audio && catalog && audio.sha256 === catalog.sha256
        && audio.asset === path.basename(new URL(catalog.url).pathname);
    if (!matchingAudio || !Number.isInteger(audio.durationMs) || audio.durationMs <= 0 || audio.durationMs > 7200000
      || listening.some(e => !e.replay?.length || [...e.replay, ...e.blocks.flatMap(b => b.replay || [])].some(c => !validClip(c)))) {
      throw new Error('EXPLANATION_AUDIO_MISMATCH');
    }
  }
  return { bundle, content: parsedContent, result: row.combined_result,
    answers: { listening: row.listening_answers, reading: row.reading_answers } };
}

export async function streamPretestReviewAudio(assetDir, review, res) {
  if (review.bundle.testSlug !== 'pretest-lesson-16' || review.bundle.reviewAudio?.private !== true) {
    return res.status(404).json({ ok: false, error: 'EXPLANATIONS_UNAVAILABLE', message: 'Chưa có audio của lời giải.' });
  }
  const file = path.join(assetDir, 'pretest-lesson-16', 'listening-audio.mp3');
  const { size } = await fs.stat(file);
  res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': String(size), 'Cache-Control': 'no-store, private' });
  await pipeline(createReadStream(file), res);
}

export function mountAnswerExplanations(app, { pool, config, limiter }) {
  app.post('/api/term-tests/result/explanations', limiter, async (req, res, next) => {
    res.set('Cache-Control', 'no-store, private');
    const token = req.body?.attemptToken;
    if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      return res.status(400).json({ ok: false, error: 'INVALID_RESULT_TOKEN', message: 'Mã kết quả không hợp lệ.' });
    }
    try {
      const { rows } = await pool.query(explanationAttemptSql, [token]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'EXPLANATIONS_NOT_READY',
        message: 'Chỉ xem giải thích sau khi đã hoàn thành mọi kỹ năng của đề.' });
      const review = await loadAnswerExplanations(config.termTestAssetDir, rows[0]);
      if (!review) return res.status(404).json({ ok: false, error: 'EXPLANATIONS_UNAVAILABLE',
        message: 'Lời giải của đề này chưa sẵn sàng. Bạn có thể thử lại sau.' });
      if (req.body?.audio === true) return await streamPretestReviewAudio(config.termTestAssetDir, review, res);
      return res.json({ ok: true, review });
    } catch (error) {
      if (/^EXPLANATION_/.test(error.message)) return res.status(409).json({ ok: false, error: error.message,
        message: 'Lời giải chưa khớp phiên bản đề. Hãy báo giáo viên để được kiểm tra.' });
      return next(error);
    }
  });
}
