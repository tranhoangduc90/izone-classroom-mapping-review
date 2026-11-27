import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {createListeningService} from '../src/service.js';
import {publicAudioCatalog} from '../src/public-audio.js';

// Nhận gói đề riêng tư, nạp version bất biến vào kho riêng Reading; không đọc Google hoặc mở lớp.
const [file,option]=process.argv.slice(2);
if(!file||(option&&option!=='--legacy-audio'))throw new Error('Usage: node tools/seed-content.mjs <content-file> [--legacy-audio]');
const bundle=JSON.parse(await readFile(file,'utf8'));
if(option!=='--legacy-audio'&&!Object.hasOwn(publicAudioCatalog,bundle.definition?.audio?.sha256)){
 throw new Error('Register the pinned audio on R2 and GitHub Pages before seeding this lesson');
}
const pool=new pg.Pool({connectionString:process.env.LISTENING_DATABASE_URL,max:1});
try{
 const role=(await pool.query('SELECT current_database() AS db,current_user AS role,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
 if(role.db!=='listening_practice_db'||role.role!=='listening_practice_app'||role.rolsuper)throw new Error('Wrong Reading database role');
 const service=createListeningService({pool,context:{},pageBase:'https://example.invalid/'});
 const result=await service.seedContent(bundle);
 console.log(JSON.stringify({status:'seeded',version:bundle.version,digest:result.digest}));
}finally{await pool.end();}
