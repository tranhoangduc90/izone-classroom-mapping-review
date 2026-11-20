import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const digest = value => createHash('sha256').update(value).digest('hex');

export async function loadSpeakingNativeDocs(file) {
  if (!file) return null;
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const { bundleDir, manifestSha256, all = false, classIds = [] } = config;
    if (typeof all !== 'boolean' || !Array.isArray(classIds) || (!all && !classIds.length)
      || !classIds.every(x => typeof x === 'string' && /^[1-9][0-9]{0,17}$/.test(x))) throw Error();
    const manifest = readFileSync(resolve(bundleDir, 'manifest.json'));
    if (digest(manifest) !== manifestSha256) throw Error();
    const hashes = JSON.parse(manifest).files;
    const files = ['google.js', 'execute.js', 'lock.js'];
    const sources = Object.fromEntries(files.map(name => [name, resolve(bundleDir, name)]));
    for (const name of files) if (digest(readFileSync(sources[name])) !== hashes[name]) throw Error();
    const [{ createGoogleDocsAccount, createGoogleDocsTokenProvider }, { executeDocsWrite }, { createDocsDocumentLock }] =
      await Promise.all(files.map(name => import(pathToFileURL(sources[name]))));
    const accounts = {};
    for (const role of ['primary', 'fallback']) {
      const credentials = JSON.parse(readFileSync(config[role + 'CredentialsFile'], 'utf8'));
      accounts[role] = createGoogleDocsAccount({ role, getToken: createGoogleDocsTokenProvider({ credentials }) });
    }
    const lockPool = new pg.Pool({ connectionString: readFileSync(config.lockDatabaseFile, 'utf8').trim(),
      max: 2, connectionTimeoutMillis: 4_000, application_name: 'speaking_native_docs_lock' });
    lockPool.on('error', () => console.error(JSON.stringify({ event: 'speaking_docs_lock_connection_lost' })));
    return { scope: { all, classIds }, accounts, execute: executeDocsWrite, withDocumentLock: createDocsDocumentLock(lockPool),
      close: () => lockPool.end(), log: context => console.log(JSON.stringify({ event: 'speaking_native_docs', ...context })) };
  } catch {
    throw Error('SPEAKING_NATIVE_DOCS_CONFIG_INVALID');
  }
}

export function isNativeDocsClass(scope, classId) {
  return Boolean(scope && (scope.all || scope.classIds.includes(String(classId))));
}
