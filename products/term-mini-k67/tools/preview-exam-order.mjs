import express from 'express';
import path from 'node:path';
import {randomBytes,createCipheriv} from 'node:crypto';
import {createMiniFixture} from '../test/helpers/mini-answer-sheet-fixture.js';
import {readFile} from 'node:fs/promises';

// Bản thử chỉ nghe trên localhost, PostgreSQL nhúng trong RAM, toàn bộ tên/đề/audio đều giả.
// API và giao diện thật dùng cùng origin; không nối Portal, n8n hoặc database production.
// Khi đóng tiến trình, dữ liệu thử mất; lỗi hiện ở terminal và thông báo của trang.
const pages=path.resolve(process.argv[2]||'');
if(!process.argv[2])throw new Error('Cần đường dẫn worktree Pages.');
const port=Number(process.env.K67_PREVIEW_PORT||8877);
const timing={
  'term-test-1':{listeningDurationSeconds:1735,listeningTotalSeconds:1855,readingDurationMinutes:60,writingDurationMinutes:40},
  'term-test-2':{listeningDurationSeconds:1844,listeningTotalSeconds:1964,readingDurationMinutes:60,writingDurationMinutes:60},
  'mini-test-lesson-5':{listeningDurationSeconds:972,listeningTotalSeconds:1092,readingDurationMinutes:20,writingDurationMinutes:0}
};
const key=randomBytes(32);
// Âm thanh thử ngắn được tạo tại máy; không lấy audio đề thi thật.
// Test audio gián đoạn cần đoạn giả dài hơn; mặc định vẫn là 2 giây của bản thử cũ.
const toneSeconds=Number(process.env.K67_PREVIEW_AUDIO_SECONDS||2);
if(!Number.isInteger(toneSeconds)||toneSeconds<2||toneSeconds>180)throw new Error('Thời lượng audio giả không hợp lệ.');
const toneSamples=8000*toneSeconds;
const wav=Buffer.alloc(44+toneSamples*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);
wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
for(let i=0;i<toneSamples;i++)wav.writeInt16LE(Math.round(Math.sin(i*440*2*Math.PI/8000)*1000),44+i*2);
const definition=async slug=>{
  const file=path.join(pages,'term-tests',slug,'test-config.js');
  const src=await readFile(file,'utf8');
  // File cấu hình trong worktree do task quản lý, không phải code lấy từ API.
  let out;new Function('window',src)({set TERM_TEST_CONFIG(value){out=value;}});return out;
};
const configs=new Map();for(const slug of Object.keys(timing))configs.set(slug,await definition(slug));
const questions=(slug,skill)=>configs.get(slug)[skill].controls.map(c=>`<p data-question-number="${c.number}">Câu ${c.number} · Đáp án thử <span data-answer-slot="${c.number}"></span></p>`).join('');
const content=slug=>({baseTestSlug:slug,variant:'semantic-html',deferResultsUntilComplete:true,
  timing:{readingMinutes:timing[slug].readingDurationMinutes,writingMinutes:timing[slug].writingDurationMinutes},
  audio:{label:`Âm thanh mô phỏng ${toneSeconds} giây`,durationLabel:`${Math.floor(toneSeconds/60)}:${String(toneSeconds%60).padStart(2,'0')}`,src:'/preview-tone.wav'},
  listening:{instructions:['Đây là câu hỏi giả để thử hành trình. Nhập một đáp án và nộp để chuyển phần.'],sections:[{label:'Listening thử',range:'Questions',html:questions(slug,'listening')}]},
  reading:{instructions:['Đề giả; thời gian và thứ tự dùng chính sách K67.'],sections:[{label:'Reading thử',title:'Bài đọc mô phỏng',range:'Questions',passageHtml:'<p>Đây là bài đọc thử. Không phải nội dung đề thi đang chạy.</p>',questionsHtml:questions(slug,'reading')}]},
  writing:slug==='mini-test-lesson-5'?null:{tasks:(slug==='term-test-1'?['task2']:['task1','task2']).map(id=>({id,label:id==='task1'?'Task 1':'Task 2',prompt:'Đề Writing mô phỏng; nhập vài từ để kiểm lưu bài.',minimumWords:id==='task1'?150:250,recommendedMinutes:id==='task1'?20:40}))}
});
const assets={supports:slug=>Boolean(timing[slug]),getTiming:slug=>({...timing[slug],listeningReviewSeconds:120}),
  getContent:async slug=>content(slug),getSessionAudioKey:()=>key,getPreview:async()=>wav,
  streamEncryptedAudio:async(_slug,_token,res)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    res.type('application/octet-stream').send(Buffer.concat([Buffer.from('IZTT1'),iv,cipher.update(wav),cipher.final(),cipher.getAuthTag()]));}};
const protection=process.env.K67_PREVIEW_AUDIO_PROTECTION==='true';
const fixture=await createMiniFixture({examOrder:true,completeSchema:true,assets,audioProtection:protection,allowedOrigins:new Set([`http://127.0.0.1:${port}`])});
await fixture.db.exec('DELETE FROM assessment.test_definition');
for(const slug of Object.keys(timing)){
  const c=configs.get(slug),section=skill=>JSON.stringify({questions:c[skill].controls.map(control=>({number:control.number,type:'Câu mô phỏng',accepted:[control.kind==='select'?control.options[0]:'A']}))});
  await fixture.db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    VALUES($1,$2,1,$3,$4,true)`,[slug,c.title+' · Bản thử',section('listening'),section('reading')]);
}
const outer=express();
outer.get('/preview/status',(_req,res)=>res.json({ok:true,previewId:'k67-orders-20261014',fixtureOnly:true,node:process.version}));
// Readback chỉ trong bản thử localhost, trả mốc/hạn của phiên giả mà không trả đáp án.
outer.get('/preview/audio-state',async(req,res)=>{
  if(!/^[0-9a-f-]{36}$/.test(req.query.id||''))return res.status(400).json({ok:false});
  const row=(await fixture.db.query(`SELECT listening_audio_checkpoint_seconds,listening_audio_checkpoint_at,
    listening_audio_state,listening_recovery_seconds,listening_deadline_at,listening_submitted_at,
    listening_audio_protocol_version,listening_audio_revision,listening_audio_incident_id,listening_draft,listening_draft_revision
    FROM assessment.term_test_exam_session WHERE id=$1`,[req.query.id])).rows[0];
  res.json({ok:true,fixtureOnly:true,...row});
});
// Điều khiển thời gian chỉ tồn tại ở công cụ localhost chứa dữ liệu giả; không mount trong app production.
if(protection)outer.post('/preview/incident-clock',express.json(),async(req,res)=>{
  const {id,seconds,deadlineSeconds,recoveryUsed}=req.body;
  if(!/^[0-9a-f-]{36}$/.test(id||'')||![seconds,deadlineSeconds,recoveryUsed].every(x=>x===undefined||Number.isFinite(x)))return res.status(400).json({ok:false});
  if(seconds!==undefined)await fixture.db.query(`UPDATE assessment.term_test_audio_incident SET opened_at=clock_timestamp()-make_interval(secs=>$2::double precision) WHERE exam_session_id=$1 AND resolved_at IS NULL`,[id,seconds]);
  if(deadlineSeconds!==undefined)await fixture.db.query(`UPDATE assessment.term_test_exam_session SET listening_deadline_at=clock_timestamp()+make_interval(secs=>$2::double precision) WHERE id=$1`,[id,deadlineSeconds]);
  if(recoveryUsed!==undefined)await fixture.db.query('UPDATE assessment.term_test_exam_session SET listening_recovery_seconds=$2 WHERE id=$1',[id,recoveryUsed]);
  res.json({ok:true,fixtureOnly:true});
});
outer.get('/term-tests/k67-shared/config.js',(_req,res)=>res.type('application/javascript').send(`window.TERM_TEST_APP_CONFIG={API_BASE_URL:location.origin,GOOGLE_CLIENT_ID:''};`));
outer.get('/preview-tone.wav',(_req,res)=>res.type('audio/wav').send(wav));
outer.get('/preview-only.css',(_req,res)=>res.type('text/css').send(`.preview-banner{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 20px;background:#fff6d8;color:#694b00;font:14px system-ui}.preview-banner button{padding:8px;border:1px solid #eed48b;border-radius:6px;cursor:pointer}@media(max-width:700px){.preview-banner{align-items:flex-start;flex-direction:column}}`));
outer.get('/preview-only.js',(_req,res)=>res.type('application/javascript').send(`document.getElementById('resetPreview')?.addEventListener('click',async()=>{if(!confirm('Xóa dữ liệu giả trên bản thử này để làm lại?'))return;await fetch('/preview/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});for(const storage of [localStorage,sessionStorage])for(const key of Object.keys(storage))if(/^izone-(test|mini)/.test(key))storage.removeItem(key);location.href='/term-tests/';});`));
outer.get(/^\/term-tests\/(?:|(?:term-test-[12](?:-computer-based)?|mini-test-lesson-5(?:-computer-based)?)\/)(?:index.html)?$/,async(req,res,next)=>{
  try {const file=path.join(pages,req.path.replace(/^\//,''),req.path.endsWith('/')?'index.html':'');
    const html=(await readFile(file,'utf8')).replace('</head>','<link rel="stylesheet" href="/preview-only.css"></head>')
      .replace(/(<body[^>]*>)/,'$1<aside class="preview-banner" role="status"><span><strong>Bản thử K67</strong> · Đề, tên và audio giả · Không gửi điểm hoặc chấm AI bên ngoài</span><button id="resetPreview" type="button">Làm lại bản thử</button></aside>')
      .replace('</body>','<script src="/preview-only.js"></script></body>');res.type('html').send(html);
  }catch(e){next(e);}
});
outer.use('/preview/reset',express.json(),async(_req,res)=>{await fixture.db.exec('UPDATE assessment.term_test_exam_session SET attempt_id=NULL;UPDATE assessment.term_test_attempt SET exam_session_id=NULL;DELETE FROM assessment.term_test_attempt;DELETE FROM assessment.term_test_exam_session;');res.json({ok:true,fixtureOnly:true});});
outer.use(express.static(pages));
outer.use(fixture.app);
const refresh=setInterval(()=>fixture.db.exec('UPDATE mapping.k67_context_state SET captured_at=now()').catch(console.error),30000);
const server=outer.listen(port,'127.0.0.1',()=>console.log(`Bản thử K67: http://127.0.0.1:${port}/term-tests/?class=IC2304`));
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{clearInterval(refresh);server.close(async()=>{await fixture.db.close();process.exit(0);});});
