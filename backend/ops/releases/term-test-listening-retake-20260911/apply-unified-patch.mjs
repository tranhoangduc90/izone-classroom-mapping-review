import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [rootDirectory = '/app', patchPath = '/tmp/listening-retake.patch', manifestPath = '/tmp/manifest.json'] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const patchLines = (await readFile(patchPath, 'utf8')).replace(/\r\n/g, '\n').split('\n');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseTarget(line) {
  const raw = line.slice(4).trim().split('\t')[0];
  return raw.startsWith('b/') ? raw.slice(2) : raw;
}

let index = 0;
while (index < patchLines.length) {
  if (!patchLines[index].startsWith('diff --git ')) {
    index += 1;
    continue;
  }
  index += 1;
  while (index < patchLines.length && !patchLines[index].startsWith('--- ')) index += 1;
  if (index >= patchLines.length || !patchLines[index + 1]?.startsWith('+++ ')) throw new Error('patch_header_invalid');
  const relativePath = parseTarget(patchLines[index + 1]);
  const expected = manifest[relativePath];
  if (!expected) throw new Error(`manifest_missing:${relativePath}`);
  const absolutePath = path.join(rootDirectory, relativePath);
  const originalText = (await readFile(absolutePath, 'utf8')).replace(/\r\n/g, '\n');
  if (sha256(originalText) !== expected.before) throw new Error(`baseline_hash_mismatch:${relativePath}`);
  const originalLines = originalText.endsWith('\n')
    ? originalText.slice(0, -1).split('\n')
    : originalText.split('\n');
  const result = [];
  let oldCursor = 0;
  index += 2;

  while (index < patchLines.length && !patchLines[index].startsWith('diff --git ')) {
    if (!patchLines[index].startsWith('@@ ')) {
      index += 1;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(patchLines[index]);
    if (!match) throw new Error(`patch_hunk_invalid:${relativePath}`);
    const oldStart = Number(match[1]) - 1;
    result.push(...originalLines.slice(oldCursor, oldStart));
    oldCursor = oldStart;
    index += 1;
    while (index < patchLines.length && !patchLines[index].startsWith('@@ ') && !patchLines[index].startsWith('diff --git ')) {
      const line = patchLines[index];
      if (line.startsWith(' ')) {
        if (originalLines[oldCursor] !== line.slice(1)) throw new Error(`patch_context_mismatch:${relativePath}:${oldCursor + 1}`);
        result.push(originalLines[oldCursor]);
        oldCursor += 1;
      } else if (line.startsWith('-')) {
        if (originalLines[oldCursor] !== line.slice(1)) throw new Error(`patch_remove_mismatch:${relativePath}:${oldCursor + 1}`);
        oldCursor += 1;
      } else if (line.startsWith('+')) {
        result.push(line.slice(1));
      } else if (line !== '' && !line.startsWith('\\ No newline')) {
        throw new Error(`patch_line_invalid:${relativePath}`);
      }
      index += 1;
    }
  }
  result.push(...originalLines.slice(oldCursor));
  const outputText = `${result.join('\n')}\n`;
  if (sha256(outputText) !== expected.after) throw new Error(`target_hash_mismatch:${relativePath}`);
  await writeFile(absolutePath, outputText, 'utf8');
}

console.log('Listening retake overlay applied with verified source hashes.');
