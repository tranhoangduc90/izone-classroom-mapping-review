import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {listeningClockMigration as term2Migration} from '../term2-k56-listening-recovery-20261124/print-listening-clock-migration.mjs';

export const listeningClockMigration=profile=>term2Migration(profile).replaceAll('term2_offline_', 'term1_offline_');
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  process.stdout.write(listeningClockMigration(process.argv[2]));
