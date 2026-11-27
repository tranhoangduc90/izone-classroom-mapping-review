import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const [assetId, filename, expectedSha256] = process.argv.slice(2);
if (!assetId || !filename || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) {
  throw new Error('Usage: node tools/register-r2-audio.mjs <asset-id> <local-mp3> <native-content-sha256>');
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(filename);
const sha256 = digest(bytes);
if (sha256 !== expectedSha256) throw new Error('The MP3 does not match the native content SHA-256');

const name = basename(filename);
if (!/^[a-z0-9-]+\.mp3$/.test(name) || !name.endsWith('-' + sha256.slice(0, 16) + '.mp3')) {
  throw new Error('Use a Pages filename ending in the first 16 hex characters of the MP3 SHA-256');
}

function describeChunks(chunkSize) {
  const chunks = [];
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const block = bytes.subarray(start, start + chunkSize);
    chunks.push({ byteLength: block.length, sha256: digest(block) });
  }
  return chunks;
}

const asset = {
  id: assetId,
  sha256,
  byteLength: bytes.length,
  url: 'https://tranhoangduc90.github.io/izone-ai-team-pages/listening-practice/audio-assets/' + name,
  chunks: describeChunks(524288),
  key: 'public-audio/' + sha256 + '.mp3',
  pagesChunks: describeChunks(1048576),
};
const catalogPath = new URL('../src/r2-audio-catalog.json', import.meta.url);
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
if (catalog[sha256] && JSON.stringify(catalog[sha256]) !== JSON.stringify(asset)) {
  throw new Error('Registration already exists with different metadata for this hash');
}
catalog[sha256] = asset;
await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(JSON.stringify({ id: asset.id, sha256, byteLength: asset.byteLength, r2Key: asset.key, pagesUrl: asset.url }));
