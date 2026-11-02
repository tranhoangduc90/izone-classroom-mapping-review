import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

// Chỉ bộ kiểm native được chọn file thực trong image ứng viên. Mode mặc định
// vẫn chạy source fixture; không thêm biến hoặc nhánh vào runtime production.
export function speakingFixtureEntrypoint(name){
 assert.ok(['server.js','speaking-independent-server.js'].includes(name));
 const root=process.env.SPEAKING_NATIVE_IMAGE_SOURCE_ROOT;
 if(root===undefined)return fileURLToPath(new URL('../../backend/src/'+name,import.meta.url));
 assert.equal(process.platform,'linux');
 assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
 assert.equal(root,'/app/src');
 return root+'/'+name;
}

export const speakingFixtureEntrypointSource=()=>process.env.SPEAKING_NATIVE_IMAGE_SOURCE_ROOT?'candidate-image':'fixture-source';
