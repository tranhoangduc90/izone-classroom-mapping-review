import {readFile} from 'node:fs/promises';
import {registerAuthoredLesson} from '../src/authored-content.js';
import {validateContent} from '../src/domain.js';

// Chỉ kiểm gói riêng tư bằng engine thật; không nạp database hay mở bài.
try{
 const bundle=JSON.parse(await readFile(process.argv[2],'utf8'));
 registerAuthoredLesson(bundle.definition.lesson);validateContent(bundle);
 console.log(JSON.stringify({outcome:'passed',code:bundle.code,questionCount:Object.keys(bundle.key).length}));
}catch(e){console.error(e.message);process.exitCode=1;}
