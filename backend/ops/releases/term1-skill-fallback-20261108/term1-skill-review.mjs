import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SLUG = 'term-test-1-k56';
const counts = { listening: 40, reading: 26 };

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function reviewSourceHash(version, section, content, definition) {
  return createHash('sha256').update(JSON.stringify(canonical({
    slug: SLUG, version: Number(version), section, content, definition
  }))).digest('hex');
}

export function validateSkillReview(bundle, section, sourceHash) {
  const count = counts[section];
  if (!count || bundle?.schema !== 1 || bundle.test !== SLUG || bundle.section !== section
      || bundle.sourceHash !== sourceHash || bundle.items?.length !== count || !Array.isArray(bundle.items)) return null;
  const items = [];
  for (const [index, item] of bundle.items.entries()) {
    if (item?.number !== index + 1 || typeof item.source !== 'string' || !item.source.trim()
        || typeof item.evidence !== 'string' || !item.evidence.trim()
        || typeof item.explanation !== 'string' || !item.explanation.trim()
        || item.source.length > 100 || item.evidence.length > 1200 || item.explanation.length > 2000) return null;
    let clip;
    if (section === 'listening') {
      const { start, end } = item.clip ?? {};
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 1848
          || end <= start || end - start > 60) return null;
      clip = { start, end };
    }
    items.push({ number: item.number, source: item.source, evidence: item.evidence, explanation: item.explanation,
      ...(clip ? { clip } : {}) });
  }
  return items;
}

export async function readTerm1SkillReview({ assetDir, assets, attempt, section }) {
  if (!counts[section] || attempt.test_slug !== SLUG || !attempt[section + '_submitted_at']) return null;
  const file = join(assetDir, SLUG, 'fallback-' + section + '-review.json');
  const data = await readFile(file, 'utf8');
  if (data.length > 300_000) return null;
  const content = attempt.mini_definition_snapshot?.content ?? await assets.getContent(SLUG);
  const definition = attempt[section + '_definition'];
  if (!content?.[section] || !definition) return null;
  const sourceHash = reviewSourceHash(attempt.definition_version, section, content[section], definition);
  return validateSkillReview(JSON.parse(data), section, sourceHash);
}
