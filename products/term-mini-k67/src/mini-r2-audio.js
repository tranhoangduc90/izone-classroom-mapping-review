import { issueR2Download, R2_POLICY } from './mini-r2-signer.js';
import { publicAudioCatalog } from './public-audio-catalog.js';

export { R2_POLICY };

export function miniR2Audio({ config, slug, row, manifest, requested }) {
  if(slug!=='mini-test-lesson-5'||!config.miniR2Enabled)return {};
  return scopedR2Audio({configFile:config.miniR2ConfigFile,slug,row,manifest,requested});
}

export function term1JourneyR2Audio({config,row,manifest}) {
  return scopedR2Audio({configFile:config.term1R2ConfigFile,slug:'term-test-1',row,manifest,requested:R2_POLICY});
}
export function term2JourneyR2Audio({config,row,manifest}) {
  return scopedR2Audio({configFile:config.term2R2ConfigFile,slug:'term-test-2',row,manifest,requested:R2_POLICY});
}

export function pretestJourneyR2Audio({config,row,manifest}) {
  if (!config.pretestR2ConfigFile || !manifest?.private || !['cbt', 'legacy'].includes(row.attempt_mode)
      || row.listening_started_at) return {};
  return signedAudio(manifest, config.pretestR2ConfigFile, R2_POLICY);
}

function scopedR2Audio({configFile,slug,row,manifest,requested}) {
  const expected = publicAudioCatalog[slug];
  if (requested !== R2_POLICY || !configFile
      || !['cbt', 'legacy'].includes(row.attempt_mode) || row.listening_started_at
      || manifest?.envelopeVersion !== 'MP3' || manifest.sha256 !== expected.sha256
      || manifest.url !== expected.url || manifest.byteLength !== expected.byteLength) return {};
  return signedAudio(manifest, configFile, requested);
}

// The native route validates and pins the file before calling the signer.
function signedAudio(manifest, configFile, requested) {
  let audioDownload;
  try {
    audioDownload = issueR2Download(manifest, { requested, configFile });
  } catch (error) {
    if (error.code !== 'AUDIO_R2_UNAVAILABLE') throw error;
  }
  return { audioTransport: R2_POLICY, ...(audioDownload ? { audioDownload } : {}) };
}
