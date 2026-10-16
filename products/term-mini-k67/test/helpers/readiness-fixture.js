import {readFile} from 'node:fs/promises';
import {createApp} from '../../src/app.js';
import {createMiniFixture} from './mini-answer-sheet-fixture.js';

// PostgreSQL nhúng và dữ liệu giả; API thật. Không gọi ERP, chấm bài hoặc tài nguyên đề thật.
export async function createReadinessFixture({audioSource,allowedOrigins=new Set(['http://127.0.0.1']),enabled=true}={}){
  const assets={supports:()=>true,getTiming:()=>({listeningDurationSeconds:10,listeningTotalSeconds:130,readingDurationMinutes:20,writingDurationMinutes:0}),
    getPreview:async()=>Buffer.from('OFFICIAL_ASSET_SENTINEL'),getContent:async()=>({sentinel:'OFFICIAL_ASSET_SENTINEL'}),
    getSessionAudioKey:()=>Buffer.alloc(32,9)};
  const f=await createMiniFixture({assets});
  await f.db.exec(await readFile(new URL('../../db/013-readiness.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('../../db/014-readiness-reading-writing.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('../../db/015-readiness-web-checks.sql',import.meta.url),'utf8'));
  const config={readinessEnabled:enabled,readinessClasses:new Set(['IC2304']),
    termTestSessionSecret:'readiness-local-test-secret-32-characters',allowedOrigins,trustProxyHops:0,
    authMode:'legacy',legacyReviewToken:'fixture-only-key'};
  return{...f,config,app:createApp({pool:f.pool,config,termTestAssetService:assets,readinessAudioSource:audioSource})};
}
