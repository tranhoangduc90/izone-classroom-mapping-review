import { issueR2Download } from './audio-r2.js';
import { publicAudioCatalog } from './k56-public-audio.mjs';

// Only the authorized Listening fallback open route invokes this function.
export function issueTerm1SkillAudio(attempt, requested) {
  if (attempt.test_slug !== 'term-test-1-k56' || attempt.attempt_mode !== 'cbt' || attempt.listening_submitted_at) return;
  const manifest = publicAudioCatalog[attempt.test_slug];
  const pinned = attempt.mini_definition_snapshot?.publicAudioManifest;
  if (pinned && ['sha256', 'url', 'byteLength', 'envelopeVersion'].some(key => pinned[key] !== manifest?.[key]))
    throw Object.assign(Error('Audio không khớp với đề Listening đã ghim.'), { status: 403, code: 'TERM1_SKILL_AUDIO_SCOPE' });
  try {
    return issueR2Download(manifest, { requested });
  } catch (error) {
    if (error.code !== 'AUDIO_R2_UNAVAILABLE') throw error;
  }
}
