import {readFileSync} from 'node:fs';
import {withCloudflareAudio} from './cloudflare-audio.mjs';

export const publicAudioCatalog = JSON.parse(readFileSync(new URL('./k56-public-audio-catalog.json', import.meta.url), 'utf8'));

// Pin only audio metadata inside the existing definition snapshot. No schema
// migration, new attempt, clock start, answer change, grade or Portal write.
// The attempt then session locks match the K56 start/prepare lock order.
export async function selectK56PublicAudio(pool, attempt) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const row = (await db.query(`SELECT a.id,a.test_slug,a.generation,a.mini_definition_snapshot,
      a.listening_submitted_at,a.superseded_at,a.attempt_mode,a.exam_mode,a.reading_submitted_at,
      s.listening_started_at AS session_started_at,s.superseded_at AS session_superseded_at,
      s.listening_submitted_at AS session_submitted_at,
      s.generation AS session_generation
      FROM assessment.term_test_attempt a JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id
      WHERE a.id=$1 AND a.test_slug=$2 FOR UPDATE OF a,s`, [attempt.attempt_token, attempt.test_slug])).rows[0];
    let manifest;
    if (row && !row.superseded_at && !row.session_superseded_at && !row.listening_submitted_at && !row.session_submitted_at
        && !(row.exam_mode === 'read_first' && !row.reading_submitted_at)
        && row.attempt_mode !== 'answer_sheet' && Number(row.generation) === Number(attempt.generation)
        && Number(row.session_generation) === Number(row.generation)) {
      manifest = row.mini_definition_snapshot?.publicAudioManifest;
      if (!manifest && !row.session_started_at) {
        manifest = publicAudioCatalog[row.test_slug];
        if (manifest) await db.query(`UPDATE assessment.term_test_attempt
          SET mini_definition_snapshot=jsonb_set(coalesce(mini_definition_snapshot,'{}'::jsonb),
            '{publicAudioManifest}',$2::jsonb) WHERE id=$1`, [row.id, JSON.stringify(manifest)]);
      }
    }
    await db.query('COMMIT');
    return withCloudflareAudio(manifest);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
