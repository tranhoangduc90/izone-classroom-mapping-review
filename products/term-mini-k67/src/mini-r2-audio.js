import { issueR2Download, R2_POLICY } from './mini-r2-signer.js';
import { publicAudioCatalog } from './public-audio-catalog.js';

export { R2_POLICY };

export function miniR2Audio({ config, slug, row, manifest, requested }) {
  const expected = publicAudioCatalog['mini-test-lesson-5'];
  if (requested !== R2_POLICY || !config.miniR2Enabled || !config.miniR2ConfigFile
      || slug !== 'mini-test-lesson-5' || !['cbt', 'legacy'].includes(row.attempt_mode) || row.listening_started_at
      || manifest?.envelopeVersion !== 'MP3' || manifest.sha256 !== expected.sha256
      || manifest.url !== expected.url || manifest.byteLength !== expected.byteLength) return {};
  // This adapter is called only after native audio authorization and pinning.
  // If the signer is unavailable the pinned Pages asset is still usable.
  let audioDownload;
  try {
    audioDownload = issueR2Download(manifest, { requested, configFile: config.miniR2ConfigFile });
  } catch (error) {
    if (error.code !== 'AUDIO_R2_UNAVAILABLE') throw error;
  }
  return { audioTransport: R2_POLICY, ...(audioDownload ? { audioDownload } : {}) };
}
