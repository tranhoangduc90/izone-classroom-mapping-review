import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';

function imageRoot(product){
 assert.ok(['reading','listening'].includes(product));
 const root=process.env.PRACTICE_NATIVE_IMAGE_SOURCE_ROOT;
 if(!root)return null;
 assert.equal(process.platform,'linux');
 assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
 assert.equal(root,'/app/src');
 assert.ok(['reading','listening'].includes(process.env.PRACTICE_NATIVE_IMAGE_PRODUCT));
 return process.env.PRACTICE_NATIVE_IMAGE_PRODUCT===product?root:null;
}
export function practiceFixtureModule(product,name,from){
 assert.match(name,/^[a-z0-9-]+\.js$/);
 const root=imageRoot(product);
 return root?pathToFileURL(root+'/'+name).href:new URL('../'+product+'-practice/src/'+name,from).href;
}
export function practiceFixtureEntrypoint(product,from){
 return imageRoot(product)?{entrypoint:'/app/src/server.js',cwd:'/app',source:'candidate-image'}
  :{entrypoint:'src/server.js',cwd:fileURLToPath(new URL('../'+product+'-practice/',from)),source:'overlay'};
}
