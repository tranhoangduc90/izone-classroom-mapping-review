// Explicitly pin the dependency into each standalone image's own build context.
import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile(new URL('../../backend/src/test-work-runtime.js',import.meta.url));
for(const product of ['reading-practice','listening-practice'])await writeFile(new URL('../'+product+'/src/test-work-runtime.js',import.meta.url),source);
