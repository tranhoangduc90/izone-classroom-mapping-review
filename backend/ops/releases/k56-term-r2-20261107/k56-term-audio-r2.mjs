import {issueR2Download, R2_POLICY} from './audio-r2.js';
import {publicAudioCatalog} from './k56-public-audio.mjs';

export function issueK56TermAudio(attempt, requested) {
  if (requested !== R2_POLICY || attempt.attempt_mode !== 'cbt'
      || attempt.listening_started_at || attempt.reading_started_at || attempt.writing_started_at) return;

  const manifest = publicAudioCatalog[attempt.test_slug];
  const pinned = attempt.mini_definition_snapshot?.publicAudioManifest;
  if (pinned && (pinned.sha256 !== manifest?.sha256 || pinned.url !== manifest?.url
      || pinned.byteLength !== manifest?.byteLength || pinned.envelopeVersion !== 'MP3')) return;

  try {
    return issueR2Download(manifest, {requested});
  } catch (error) {
    // A signer/config outage may fall back to Pages after native admission.
    if (error.code !== 'AUDIO_R2_UNAVAILABLE') throw error;
  }
}
