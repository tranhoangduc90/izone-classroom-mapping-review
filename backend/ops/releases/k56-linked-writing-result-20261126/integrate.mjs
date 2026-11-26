import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [input, output] = process.argv.slice(2).map(path => resolve(path));
if (!input || !output || input === output) throw new Error('Provide separate input and output paths.');

const base = readFileSync(input, 'utf8');
const anchor = [
  '    let writing = null;',
  '    if (a.listening_interrupted_at && a.writing_started_at) {'
].join('\n');
if (base.split(anchor).length !== 2) throw new Error('Expected one matching result handler in the running module.');

const updated = base.replace(anchor, [
  '    let writing = null;',
  '    if (linked && a.writing_submitted_at && readOnlineWriting) {',
  '      // The linked profile keeps its token and reads the official submission through the student release policy.',
  '      writing = (await readOnlineWriting(pool, a)).writing;',
  '    } else if (a.listening_interrupted_at && a.writing_started_at) {'
].join('\n'));

writeFileSync(output, updated, { flag: 'wx' });
