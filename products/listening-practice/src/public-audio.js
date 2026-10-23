import {readFileSync} from 'node:fs';
import {withCloudflareAudio} from './cloudflare-audio.mjs';

export const AUDIO_MANIFEST_TYPE = 'application/vnd.izone.audio-manifest+json';
export const publicAudioCatalog = JSON.parse(readFileSync(new URL('./public-audio-catalog.json', import.meta.url), 'utf8'));

// Called only after the original student/teacher authorization has succeeded.
// Old clients keep the original file response during the compatible rollout.
export function sendPublicAudioMetadata(req, res, sha256) {
  const manifest = publicAudioCatalog[sha256];
  if (req.get('Accept') !== AUDIO_MANIFEST_TYPE || !manifest) return false;
  res.set('Cache-Control', 'private, no-store').type(AUDIO_MANIFEST_TYPE).json({audioManifest: withCloudflareAudio(manifest)});
  return true;
}
