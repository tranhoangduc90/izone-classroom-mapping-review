import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';

const catalog = JSON.parse(readFileSync(new URL('./r2-audio-catalog.json', import.meta.url), 'utf8'));
export const R2_POLICY = 'r2-direct-v1';

const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
const mac = (key, value) => createHmac('sha256', key).update(value).digest();
const unavailable = () => Object.assign(new Error('AUDIO_R2_UNAVAILABLE'), { status: 503, code: 'AUDIO_R2_UNAVAILABLE' });

function readSettings(file) {
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw unavailable(); }
}

// The native audio route authorizes and pins the file before calling the signer.
export function issueR2Download(manifest, { requested, configFile, now = new Date(), settings = readSettings(configFile) } = {}) {
  const asset = catalog[manifest?.sha256];
  if (requested !== R2_POLICY || !asset || settings?.enabled !== true || !Array.isArray(settings.assets)
      || !settings.assets.includes(asset.sha256)) return undefined;
  if (manifest.url !== asset.url || manifest.byteLength !== asset.byteLength || manifest.envelopeVersion !== 'MP3') {
    throw Object.assign(new Error('AUDIO_R2_MANIFEST_DENIED'), { status: 403, code: 'AUDIO_R2_MANIFEST_DENIED' });
  }
  const { accountId, bucket, accessKeyId, secretAccessKey } = settings;
  if (!/^[a-f0-9]{32}$/.test(accountId || '') || !bucket || !accessKeyId || !secretAccessKey) throw unavailable();
  const host = accountId + '.r2.cloudflarestorage.com';
  const pathname = '/' + [bucket, ...asset.key.split('/')].map(encode).join('/');
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const scope = day + '/auto/s3/aws4_request';
  const query = Object.entries({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': accessKeyId + '/' + scope,
    'X-Amz-Date': date,
    'X-Amz-Expires': '600',
    'X-Amz-SignedHeaders': 'host'
  }).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => encode(key) + '=' + encode(value)).join('&');
  const canonical = ['GET', pathname, query, 'host:' + host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const signing = mac(mac(mac(mac('AWS4' + secretAccessKey, day), 'auto'), 's3'), 'aws4_request');
  const signature = mac(signing, toSign).toString('hex');
  return { version: 1, policy: R2_POLICY, method: 'GET', url: `https://${host}${pathname}?${query}&X-Amz-Signature=${signature}`,
    sha256: asset.sha256, byteLength: asset.byteLength, validForSeconds: 600, fallback: 'public-pages', chunkSize: 524288, chunks: asset.chunks };
}
