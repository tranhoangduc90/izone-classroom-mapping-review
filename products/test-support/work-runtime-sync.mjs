// Explicitly pin the dependency into each standalone image's own build context.
import {readFile,writeFile} from 'node:fs/promises';
for(const name of ['test-work-runtime.js','test-state-runtime.js','test-practice-observation.js','test-practice-history.js','test-practice-student-progress.js']){
 const source=await readFile(new URL('../../backend/src/'+name,import.meta.url));
 for(const product of ['reading-practice','listening-practice'])await writeFile(new URL('../'+product+'/src/'+name,import.meta.url),source);
}
