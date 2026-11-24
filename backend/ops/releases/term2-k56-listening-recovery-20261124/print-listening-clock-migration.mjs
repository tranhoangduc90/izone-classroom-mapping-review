import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {clockSchema} from './listening-clock.mjs';

const profiles = new Map([
  ['k56-ic2264', {schema:'assessment_k56', role:'k56_shared_api'}],
  ['k56-demo', {schema:'assessment', role:'k56_demo_runtime'}],
]);

export function listeningClockMigration(profile) {
  const target = profiles.get(profile);
  if (!target) throw Error('Choose k56-ic2264 or k56-demo');
  const {schema, role} = target;
  const tables = clockSchema.replace(/\bassessment\./g, `${schema}.`);
  return `BEGIN;
SET LOCAL lock_timeout = '5s';
${tables.trim()}
GRANT SELECT, INSERT, UPDATE ON ${schema}.term2_offline_listening_clock TO ${role};
GRANT SELECT, INSERT ON ${schema}.term2_offline_listening_clock_operation TO ${role};
COMMIT;
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(listeningClockMigration(process.argv[2]));
}
