import express from 'express';
import path from 'node:path';
import {randomBytes,randomUUID,createCipheriv,createHash} from 'node:crypto';
import {createMiniFixture} from '../test/helpers/mini-answer-sheet-fixture.js';
import {createTermTestWritingGradingService} from '../src/term-test-writing-grading.js';
import {createErpGradeSync} from '../src/erp-sync.js';
import {createTermTestAssetService} from '../src/term-test-assets.js';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';
import {startPreviewExamJournal} from './preview-exam-journal.mjs';

// Bản thử chỉ nghe trên localhost, PostgreSQL nhúng trong RAM, toàn bộ tên và đề đều giả.
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
const pretestMode=process.env.K67_PREVIEW_PRETEST_CBT_JOURNEY;
const pretestSlug='pretest-lesson-16';
const pretestAssetDir=process.env.K67_PREVIEW_PRETEST_ASSETS;
const pretestR2ConfigFile=process.env.K67_PREVIEW_PRETEST_R2_CONFIG;
const nativePretest=pretestAssetDir ? createTermTestAssetService({ assetDir:pretestAssetDir,
  sessionSecret:'fixture-pretest-audio-key-at-least-32-bytes' }) : null;
if(pretestMode==='on')timing[pretestSlug]={listeningDurationSeconds:6,listeningTotalSeconds:8,readingDurationMinutes:0.75,writingDurationMinutes:0};
const key=randomBytes(32);
// Âm thanh thử ngắn được tạo tại máy; không lấy audio đề thi thật.
// Test audio gián đoạn cần đoạn giả dài hơn; mặc định vẫn là 2 giây của bản thử cũ.
const toneSeconds=Number(process.env.K67_PREVIEW_AUDIO_SECONDS||2);
// Cho phép bản giả dài tới 35 phút để nghiệm thu thiết bị; không đổi thời lượng đề thật.
if(!Number.isInteger(toneSeconds)||toneSeconds<2||toneSeconds>2100)throw new Error('Thời lượng audio giả không hợp lệ.');
const toneSamples=8000*toneSeconds;
const wav=Buffer.alloc(44+toneSamples*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);
wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
for(let i=0;i<toneSamples;i++)wav.writeInt16LE(Math.round(Math.sin(i*440*2*Math.PI/8000)*1000),44+i*2);
const miniAudio = process.env.K67_PREVIEW_REAL_MINI_AUDIO === 'true'
  ? await readFile(path.join(pages, 'term-tests/k67-audio-assets/mini-test-lesson-5-128kbps-182526cd0c3357a4.mp3')) : null;
const term1Audio = process.env.K67_PREVIEW_REAL_TERM1_AUDIO === 'true'
  ? await readFile(path.join(pages,'term-tests/k67-audio-assets/term-test-1-128kbps-9af027eaaf402acc.mp3')) : null;
const term2Audio = process.env.K67_PREVIEW_REAL_TERM2_AUDIO === 'true'
  ? await readFile(path.join(pages,'term-tests/k67-audio-assets/term-test-2-96kbps-656921dc9888dcfe.mp3')) : null;
const audioBytes = slug => (slug==='mini-test-lesson-5'?miniAudio:slug==='term-test-1'?term1Audio:slug==='term-test-2'?term2Audio:null)||wav;
const definition=async slug=>{
  const file=path.join(pages,'term-tests',slug,'test-config.js');
  const src=await readFile(file,'utf8');
  // File cấu hình trong worktree do task quản lý, không phải code lấy từ API.
  let out;new Function('window',src)({set TERM_TEST_CONFIG(value){out=value;}});return out;
};
const configs=new Map();for(const slug of Object.keys(timing))configs.set(slug,await definition(slug));
const questions=(slug,skill)=>configs.get(slug)[skill].controls.map(c=>`<p data-question-number="${c.number}">Câu ${c.number} · Đáp án thử <span data-answer-slot="${c.number}"></span></p>`).join('');
const {listeningProfiles}=await import(pathToFileURL(path.join(pages,'term-tests/k67-shared/listening-profiles-v1.mjs')));
const listeningSections=slug=>{
  const parts=slug==='term-test-2'?[1,2,3,4]:listeningProfiles[slug]?.parts;
  if(!parts)return [{label:'Listening thử',range:'Questions',html:questions(slug,'listening')}];
  return parts.map(part=>{
    const first=10*(part-1)+1;
    const keys=configs.get(slug).listening.controls.filter(control=>Number(control.number)>=first&&Number(control.number)<first+10)
      .flatMap(control=>control.kind==='pair'?control.keys:[String(control.number)]);
    return {label:`Part ${part}`,range:`Questions ${first}–${first+9}`,
      html:keys.map(key=>`<p>Câu ${key} · Đề giả <span data-answer-slot="${key}"></span></p>`).join('')};
  });
};
const content=slug=>({baseTestSlug:slug,variant:'semantic-html',deferResultsUntilComplete:true,
  timing:{readingMinutes:timing[slug].readingDurationMinutes,writingMinutes:timing[slug].writingDurationMinutes},
  audio:{label:`Âm thanh mô phỏng ${toneSeconds} giây`,durationLabel:`${Math.floor(toneSeconds/60)}:${String(toneSeconds%60).padStart(2,'0')}`,src:'/preview-tone.wav'},
  listening:{instructions:['Đây là câu hỏi giả để thử hành trình. Nhập một đáp án và nộp để chuyển phần.'],sections:listeningSections(slug)},
  reading:{instructions:['Đề giả; thời gian và thứ tự dùng chính sách K67.'],sections:[{label:'Reading thử',title:'Bài đọc mô phỏng',range:'Questions',passageHtml:'<p>Đây là bài đọc thử. Không phải nội dung đề thi đang chạy.</p>',questionsHtml:questions(slug,'reading')}]},
  writing:['mini-test-lesson-5',pretestSlug].includes(slug)?null:{tasks:(slug==='term-test-1'?['task2']:['task1','task2']).map(id=>({id,label:id==='task1'?'Task 1':'Task 2',prompt:'Đề Writing mô phỏng; nhập vài từ để kiểm lưu bài.',minimumWords:id==='task1'?150:250,recommendedMinutes:id==='task1'?20:40}))}
});
const journeyMode=process.env.K67_PREVIEW_MINI_CBT_JOURNEY;
const miniParallel=process.env.K67_PREVIEW_MINI_CBT_PARALLEL==='true';
if(miniParallel&&(journeyMode!=='on'||pretestMode!=='on'))throw new Error('Mini parallel preview needs the current journey migrations.');
const term1JourneyMode=process.env.K67_PREVIEW_TERM1_CBT_JOURNEY;
const term1PaperMode=process.env.K67_PREVIEW_TERM1_PAPER_JOURNEY;
const term1Parallel=process.env.K67_PREVIEW_TERM1_PARALLEL_ENTRY;
const term1ReportCases=process.env.K67_PREVIEW_TERM1_REPORT_CASES==='true';
const term2ReportCases=process.env.K67_PREVIEW_TERM2_REPORT_CASES==='true';
if(term1ReportCases&&term2ReportCases)throw new Error('Select one Listening report fixture.');
const reportSlug=term1ReportCases?'term-test-1':term2ReportCases?'term-test-2':null;
const term2JourneyMode=process.env.K67_PREVIEW_TERM2_CBT_JOURNEY;
const term2Parallel=process.env.K67_PREVIEW_TERM2_PARALLEL_ENTRY;
const retakeMode=process.env.K67_PREVIEW_TERM1_RETAKE;
const miniReview=journeyMode==='on'?Number(process.env.K67_PREVIEW_MINI_REVIEW_SECONDS||120):120;
const term1Review=term1JourneyMode==='on'&&!term1Audio?3:120;
const term1R2ConfigFile=process.env.K67_PREVIEW_TERM1_R2_CONFIG;
const term2Review=term2JourneyMode==='on'&&!term2Audio?Number(process.env.K67_PREVIEW_TERM2_REVIEW_SECONDS||3):120;
const term2R2ConfigFile=process.env.K67_PREVIEW_TERM2_R2_CONFIG;
const assets={supports:slug=>Boolean(timing[slug]),getTiming:slug=>slug===pretestSlug&&nativePretest ? nativePretest.getTiming(slug) : ({...timing[slug],
    listeningReviewSeconds:slug===pretestSlug?2:slug==='mini-test-lesson-5'?miniReview:slug==='term-test-1'?term1Review:slug==='term-test-2'?term2Review:120}),
  getJourneyManifest:slug=>{
    if(slug===pretestSlug&&nativePretest)return nativePretest.getJourneyManifest(slug);
    if(slug===pretestSlug&&pretestMode==='on')return {
      url:`http://127.0.0.1:${port}/preview-tone.wav`,envelopeVersion:'MP3',byteLength:wav.length,
      sha256:createHash('sha256').update(wav).digest('hex'),durationSeconds:toneSeconds
    };
    if(!((slug==='term-test-1'&&(term1JourneyMode==='on'||retakeMode==='on'))||(slug==='term-test-2'&&term2JourneyMode==='on')))return null;
    const bytes=audioBytes(slug);
    return {url:slug==='term-test-1'&&term1Audio&&term1R2ConfigFile
        ?'https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/k67-audio-assets/term-test-1-128kbps-9af027eaaf402acc.mp3'
        :slug==='term-test-2'&&term2Audio&&term2R2ConfigFile
        ?'https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/k67-audio-assets/term-test-2-96kbps-656921dc9888dcfe.mp3'
        :`http://127.0.0.1:${port}/${slug==='term-test-1'&&term1Audio?'preview-term1-audio':slug==='term-test-2'&&term2Audio?'preview-term2-audio':'preview-tone.wav'}`,
      envelopeVersion:'MP3',byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  },
  getMiniJourneyManifest:()=>{const bytes=audioBytes('mini-test-lesson-5');return {url:`http://127.0.0.1:${port}/preview-mini-audio`,
    envelopeVersion:'MP3',byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};},
  getAudioManifest:async slug=>{const bytes=audioBytes(slug);const sha256=createHash('sha256').update(bytes).digest('hex');return{assetVersion:`sha256-${sha256}`,sha256,byteLength:bytes.length,encryptedByteLength:bytes.length+33,envelopeVersion:'IZTT1'};},
  getContent:async slug=>slug===pretestSlug&&nativePretest ? nativePretest.getContent(slug) : content(slug),
  getSessionAudioKey:()=>key,getPreview:async slug=>slug===pretestSlug&&nativePretest ? nativePretest.getPreview(slug) : wav,
  streamDemoAudio:(slug,request,response)=>nativePretest.streamDemoAudio(slug,request,response),
  streamEncryptedAudio:async(slug,_token,res)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    res.type('application/octet-stream').send(Buffer.concat([Buffer.from('IZTT1'),iv,cipher.update(audioBytes(slug)),cipher.final(),cipher.getAuthTag()]));}};
const protection=process.env.K67_PREVIEW_AUDIO_PROTECTION==='true';
if(protection)for(const value of Object.values(timing)){value.listeningDurationSeconds=toneSeconds;value.listeningTotalSeconds=toneSeconds+120;}
if(pretestMode==='on')Object.assign(timing[pretestSlug],{listeningDurationSeconds:toneSeconds,listeningTotalSeconds:toneSeconds+2});
if (miniAudio) {
  if (createHash('sha256').update(miniAudio).digest('hex') !== '182526cd0c3357a4b963ea1cf84a9b72a9a6f6d968324c8905895bcce74088cd') throw new Error('Sai bản audio Mini K67.');
  Object.assign(timing['mini-test-lesson-5'], { listeningDurationSeconds: 972, listeningTotalSeconds: 1092 });
}
if(journeyMode==='on'){
  const mini=timing['mini-test-lesson-5'];
  mini.listeningTotalSeconds=mini.listeningDurationSeconds+miniReview;
  if(process.env.K67_PREVIEW_MINI_READING_MINUTES)mini.readingDurationMinutes=Number(process.env.K67_PREVIEW_MINI_READING_MINUTES);
}
if(term1JourneyMode==='on'||retakeMode==='on'){
  if(term1Audio){
    if(createHash('sha256').update(term1Audio).digest('hex')!=='9af027eaaf402acc230fdaeff11bcc1b792b62e55d75067f1a2bcf2392b485f8')throw new Error('Sai bản audio Term 1 K67.');
    Object.assign(timing['term-test-1'],{listeningDurationSeconds:1735,listeningTotalSeconds:1855});
  }else Object.assign(timing['term-test-1'],{listeningDurationSeconds:toneSeconds,
    listeningTotalSeconds:toneSeconds+term1Review,
    readingDurationMinutes:Number(process.env.K67_PREVIEW_TERM1_READING_MINUTES||.12),writingDurationMinutes:.2});
}
if(term2JourneyMode==='on'){
  if(term2Audio){
    if(createHash('sha256').update(term2Audio).digest('hex')!=='656921dc9888dcfe778eb0cfa6b61491fd906500edde28054d53d26194df219e')throw new Error('Sai bản audio Term 2 K67.');
    Object.assign(timing['term-test-2'],{listeningDurationSeconds:1844,listeningTotalSeconds:1964});
  }else Object.assign(timing['term-test-2'],{listeningDurationSeconds:toneSeconds,
    listeningTotalSeconds:toneSeconds+term2Review,
    readingDurationMinutes:Number(process.env.K67_PREVIEW_TERM2_READING_MINUTES||.12),writingDurationMinutes:.2});
}
const miniR2ConfigFile = process.env.K67_PREVIEW_MINI_R2_CONFIG;
const miniListeningEofEnabled = process.env.K67_PREVIEW_MINI_EOF === 'true';
const term1ListeningEofEnabled = process.env.K67_PREVIEW_TERM1_EOF === 'true';
const term2ListeningEofEnabled = process.env.K67_PREVIEW_TERM2_EOF === 'true';
const listeningContinuityEnabled=process.env.K67_PREVIEW_LISTENING_CONTINUITY==='true';
const previewTerm2ListeningRecovery=term2JourneyMode==='on'&&process.env.K67_PREVIEW_TERM2_LISTENING_RECOVERY==='true';
const previewTerm1ListeningRecovery=term1JourneyMode==='on'&&process.env.K67_PREVIEW_TERM1_LISTENING_RECOVERY==='true';
const previewMiniListeningRecovery=journeyMode==='on'&&process.env.K67_PREVIEW_MINI_LISTENING_RECOVERY==='true';
const previewPretestListeningRecovery=pretestMode==='on'&&process.env.K67_PREVIEW_PRETEST_LISTENING_RECOVERY==='true';
const termHoldSlug=process.env.K67_PREVIEW_TERM1_WRITING_HOLD==='true'?'term-test-1'
  :process.env.K67_PREVIEW_TERM2_WRITING_HOLD==='true'?'term-test-2':null;
const miniHoldEnabled=process.env.K67_PREVIEW_MINI_CBT_LR_HOLD==='true';
const holdSlug=miniHoldEnabled?'mini-test-lesson-5':termHoldSlug;
const writingHoldEnabled=Boolean(termHoldSlug);
const fullWritingHold=writingHoldEnabled&&process.env.K67_PREVIEW_FULL_WRITING_HOLD==='true';
const journalSource=process.env.K67_PREVIEW_EXAM_JOURNAL;
const journalSlug=reportSlug||(term1PaperMode==='on'?'term-test-1':holdSlug);
const journalFixture=journalSlug&&journalSource
  ? await startPreviewExamJournal(journalSource,`http://127.0.0.1:${port}`,journalSlug) : null;
const holdClass=new Set([process.env.K67_PREVIEW_RESCUE_CLASS||'IC2304']);
const lrHold=miniHoldEnabled?{miniCbtLrHoldHours:2,miniCbtLrHoldLimit:20,miniCbtLrHoldClasses:holdClass}
  :process.env.K67_PREVIEW_TERM_CBT_LR_HOLD==='true'
  ? {termCbtLrHoldHours:2,termCbtLrHoldLimit:20,
    ...(holdSlug==='term-test-1'?{term1CbtLrHoldClasses:holdClass}:{term2CbtLrHoldClasses:holdClass})} : {};
const fakeWorkerKey='fixture-k67-local-writing-grader-only';
const gradingRoundTrip=Boolean(termHoldSlug)
  &&process.env.K67_PREVIEW_WRITING_RESULT==='true';
const fixtureGradeRequests=[];
let writingGrading;
const fixture=await createMiniFixture({examOrder:true,completeSchema:true,assets,termTestAssetDir:pretestAssetDir,listeningContinuityEnabled,audioProtection:protection,audioCache:protection,audioOwner:process.env.K67_PREVIEW_AUDIO_OWNER==='true',
  term1ParallelEntryEnabled:['true','warm-up'].includes(term1Parallel),
  term2ParallelEntryMode:miniParallel||['true','warm-up'].includes(term2Parallel)?'on':'off',
  mountJournal:journalFixture?.mount,
  writingHold:{
    ...miniParallel&&{miniCbtParallelEntryMode:'on'},
    ...writingHoldEnabled&&(termHoldSlug==='term-test-1'?{term1WritingHoldHours:2,term1WritingHoldLimit:fullWritingHold?1:20,term1WritingHoldClasses:holdClass}
      :{term2WritingHoldHours:2,term2WritingHoldLimit:fullWritingHold?1:20,term2WritingHoldClasses:holdClass}),
    ...lrHold,
    ...writingHoldEnabled&&(journalFixture||gradingRoundTrip)&&{writingTestSyncSecret:fakeWorkerKey}},
  termTestWritingGradingService:writingHoldEnabled ? {
    ensureSubmission:input=>writingGrading.ensureSubmission(input),
    ensureSubmissionInTransaction:(db,input)=>writingGrading.ensureSubmissionInTransaction(db,input),
    claimJobs:input=>writingGrading.claimJobs(input),
    completeDispatch:input=>writingGrading.completeDispatch(input),
    completeResult:input=>writingGrading.completeResult(input),
    getStatus:input=>writingGrading.getStatus(input)
  } : undefined,
  publicAudio:Boolean(miniR2ConfigFile),miniR2ConfigFile,miniListeningEofEnabled,term1ListeningEofEnabled,term2ListeningEofEnabled,miniCbtOfflineMode:process.env.K67_PREVIEW_MINI_CBT_OFFLINE,
  miniCbtJourneyMode:journeyMode,pretestCbtJourneyMode:pretestMode,pretestPaperJourneyMode:pretestMode,pretestR2ConfigFile,term1CbtJourneyMode:term1JourneyMode,term1PaperJourneyMode:term1PaperMode,term2CbtJourneyMode:term2JourneyMode,term1R2ConfigFile,term2R2ConfigFile,
  term1ListeningRetakeMode:retakeMode,term1ListeningRetakeSecret:'synthetic-retake-ticket-key-at-least-32-characters',
  term1CbtListeningRecoveryMode:previewTerm1ListeningRecovery?(process.env.K67_PREVIEW_TERM1_RECOVERY_MODE||'on'):'off',
  term2CbtListeningRecoveryMode:previewTerm2ListeningRecovery?(process.env.K67_PREVIEW_TERM2_RECOVERY_MODE||'on'):'off',
  miniCbtListeningRecoveryMode:previewMiniListeningRecovery?(process.env.K67_PREVIEW_MINI_RECOVERY_MODE||'on'):'off',
  pretestCbtListeningRecoveryMode:previewPretestListeningRecovery?(process.env.K67_PREVIEW_PRETEST_RECOVERY_MODE||'on'):'off',
  allowedOrigins:new Set([`http://127.0.0.1:${port}`])});
if(miniParallel) {
  await fixture.db.exec(await readFile(new URL('../db/047-pretest-cbt-parallel-entry.sql',import.meta.url),'utf8'));
  await fixture.db.exec(await readFile(new URL('../db/048-mini-k67-cbt-parallel-entry.sql',import.meta.url),'utf8'));
}
if (writingHoldEnabled) writingGrading=createTermTestWritingGradingService({pool:fixture.pool,
  syncErpGrades:gradingRoundTrip ? createErpGradeSync({config:{
    erpSyncUrl:`http://127.0.0.1:${port}/preview/writing-portal`,erpSyncSecret:fakeWorkerKey,erpSyncTimeoutMs:5000
  }}) : null});
const sealClock=new AsyncLocalStorage();
if (holdSlug) {
  const connect=fixture.pool.connect.bind(fixture.pool);
  fixture.pool.connect=async()=>{
    const client=await connect();
    const now=sealClock.getStore();
    if (now===undefined) return client;
    return {release:()=>client.release(),query:(sql,args)=>sql==='SELECT clock_timestamp() AS now'
      ? Promise.resolve({rows:[{now:new Date(now)}]}) : client.query(sql,args)};
  };
}
if(listeningContinuityEnabled&&!pretestMode){
  await fixture.db.exec(await readFile(new URL('../db/028-listening-interruption.sql',import.meta.url),'utf8'));
}
// Thêm lớp giả đúng mã thường mở khi xem demo; không đọc hoặc chép roster lớp thật.
await fixture.db.query("INSERT INTO mapping.classroom_course_mapping VALUES(1992200,'IC2200')");
await fixture.db.query("INSERT INTO mapping.student_mapping_review VALUES('22222222-2222-4222-8222-222222222222',1992200,990022,'Học viên mô phỏng IC2200','approved')");
if(reportSlug){
  for(let n=1;n<=5;n++){
    const ref='91000000-0000-4000-8000-'+String(n).padStart(12,'0');
    await fixture.db.query('INSERT INTO mapping.student_mapping_review VALUES($1,1992200,$2,$3,$4)',
      [ref,991000+n,'Học viên báo âm thanh '+n,'approved']);
  }
}
if(pretestMode){
  await fixture.db.exec(`INSERT INTO mapping.classroom_course_mapping VALUES (1992806,'CODEXDEMO806');
    INSERT INTO mapping.student_mapping_review VALUES
      ('66666666-6666-4666-8666-666666666666',1992806,990806,'Học viên Pretest demo','approved');
    CREATE TABLE IF NOT EXISTS mapping.reviewer_account
      (email text,status text,google_subject text,role text,can_access_all_classes boolean);
    CREATE TABLE IF NOT EXISTS mapping.reviewer_session
      (token_hash bytea,reviewer_email text,google_subject text,revoked_at timestamptz,idle_expires_at timestamptz,absolute_expires_at timestamptz);
    CREATE TABLE IF NOT EXISTS mapping.reviewer_class_access (reviewer_email text,erp_course_class_id bigint)`);
}
if(!pretestMode&&(previewTerm1ListeningRecovery&&process.env.K67_PREVIEW_TERM1_DEMO_CBT==='true'||
  previewTerm2ListeningRecovery&&process.env.K67_PREVIEW_TERM2_DEMO_CBT==='true'||
  previewMiniListeningRecovery&&process.env.K67_PREVIEW_MINI_DEMO_CBT==='true')){
  await fixture.db.exec(`INSERT INTO mapping.classroom_course_mapping VALUES (1992806,'CODEXDEMO806');
    INSERT INTO mapping.student_mapping_review VALUES
      ('66666666-6666-4666-8666-666666666666',1992806,990806,'Học viên Term demo giả','approved');`);
}
const rescueClass=process.env.K67_PREVIEW_RESCUE_CLASS;
if(rescueClass){
  if(!['IC2213','IC2207'].includes(rescueClass))throw new Error('Mã lớp thử cứu hộ không hợp lệ.');
  await fixture.db.query('UPDATE mapping.classroom_course_mapping SET erp_class_name_snapshot=$1 WHERE erp_class_name_snapshot=$2',
    [rescueClass,'IC2304']);
}
await fixture.db.exec('DELETE FROM assessment.test_definition');
for(const slug of Object.keys(timing)){
  const c=configs.get(slug),section=skill=>JSON.stringify({questions:c[skill].controls.map(control=>({number:control.number,type:'Câu mô phỏng',accepted:[control.kind==='select'?control.options[0]:'A']}))});
  const nativeDefinition=slug===pretestSlug&&nativePretest
    ? JSON.parse(await readFile(path.join(pretestAssetDir,slug,'definition.private.json'),'utf8')) : null;
  await fixture.db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    VALUES($1,$2,1,$3,$4,true)`,[slug,c.title+' · Bản thử',
      nativeDefinition ? JSON.stringify(nativeDefinition.listening_definition) : section('listening'),
      nativeDefinition ? JSON.stringify(nativeDefinition.reading_definition) : section('reading')]);
  if(slug===pretestSlug)await fixture.db.query(
    'UPDATE assessment.test_definition SET open_class_ids=$2 WHERE slug=$1',
    [slug, JSON.stringify(['1293','1992200','1992806'])]
  );
}
const outer=express();
if(process.env.K67_PREVIEW_TERM2_JOURNAL_RECORDER_DOWN==='1'){
  const requests={primary:0,fallback:0};
  const shared='/term-tests/shared/exam-journal/';
  outer.get(shared+'recorder.mjs',(_req,res)=>{requests.primary++;res.status(503).end();});
  outer.get(shared+'recorder-term1-k56-fallback-v1.mjs',(_req,_res,next)=>{requests.fallback++;next();});
  outer.get('/preview/recorder-requests',(_req,res)=>res.json(requests));
}
let previewApp=term1Parallel==='warm-up'?fixture.appForTerm1Mode('off'):fixture.app;
const term2PreviewApps=term2Parallel==='warm-up'
  ? {off:fixture.appForTerm2Mode('off'),on:fixture.app,drain:fixture.appForTerm2Mode('drain')}
  : null;
if(term2PreviewApps && term2Parallel==='warm-up') previewApp=term2PreviewApps.off;
if (['true','warm-up'].includes(term1Parallel)) outer.post('/preview/term1-parallel-mode',express.json(),(req,res)=>{
  if (!['on','drain'].includes(req.body?.mode)) return res.sendStatus(400);
  previewApp=fixture.appForTerm1Mode(req.body.mode);
  return res.json({ok:true,mode:req.body.mode});
});
if (term2PreviewApps) outer.post('/preview/term2-parallel-mode',express.json(),(req,res)=>{
  if (!['on','drain'].includes(req.body?.mode)) return res.sendStatus(400);
  previewApp=term2PreviewApps[req.body.mode];
  return res.json({ok:true,mode:req.body.mode});
});
outer.get('/preview/status',(_req,res)=>res.json({ok:true,previewId:'k67-orders-20261014',fixtureOnly:true,node:process.version}));
const recoverySlug=previewTerm1ListeningRecovery?'term-test-1':previewTerm2ListeningRecovery?'term-test-2':
  previewMiniListeningRecovery?'mini-test-lesson-5':previewPretestListeningRecovery?pretestSlug:null;
const recoveryJourneyTable=previewMiniListeningRecovery?'assessment.mini_k67_cbt_journey':'assessment.term_k67_cbt_journey';
const recoveryClockTable=previewMiniListeningRecovery?'assessment.mini_k67_cbt_listening_clock':'assessment.term_k67_cbt_listening_clock';
if(recoverySlug)outer.get('/preview/listening-recovery-clock',async(_req,res)=>{
  const {rows}=await fixture.db.query(`SELECT j.session_id,c.revision,c.snapshot,
    s.listening_submitted_at,s.listening_eof_at,
    (SELECT count(*)::int FROM ${recoveryClockTable}_operation o WHERE o.session_id=c.session_id) AS operations
    FROM ${recoveryClockTable} c
    JOIN ${recoveryJourneyTable} j ON j.session_id=c.session_id
    JOIN assessment.term_test_exam_session s ON s.id=c.session_id
    WHERE s.test_slug=$1 ORDER BY s.id`,[recoverySlug]);
  res.json({rows});
});
const rehearsalSlug=term2JourneyMode==='on'?'term-test-2':term1JourneyMode==='on'?'term-test-1':
  pretestMode==='on'?pretestSlug:journeyMode==='on'?'mini-test-lesson-5':null;
const rehearsalTable=rehearsalSlug==='mini-test-lesson-5'?'assessment.mini_k67_cbt_journey':'assessment.term_k67_cbt_journey';
if (rehearsalSlug) outer.get('/preview/rehearsal-receipt-readback', async (_req, res) => {
  const {rows} = await fixture.db.query(`
    SELECT a.generation, s.id::text AS session_id,
           s.erp_course_class_id::text AS native_class_id, j.student_ref::text AS student_ref,
           s.listening_submitted_at IS NOT NULL AS listening_submitted,
           a.reading_submitted_at IS NOT NULL AS reading_submitted,
           a.writing_submitted_at IS NOT NULL AS writing_submitted,
           a.completed_at IS NOT NULL AS completed,
           a.listening_answers, a.reading_answers, a.writing_task_1, a.writing_task_2 AS writing,
           j.sections->'listening'->>'operationId' AS l,
           j.sections->'reading'->>'operationId' AS r,
           j.sections->'writing'->>'operationId' AS w
    FROM assessment.term_test_attempt a
    JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id
    JOIN ${rehearsalTable} j ON j.session_id=s.id AND j.generation=a.generation
    WHERE a.test_slug=$1 AND a.superseded_at IS NULL`,[rehearsalSlug]);
  res.json({rows});
});
if (gradingRoundTrip) {
  outer.post('/preview/writing-portal',express.json(),(req,res)=>{
    if(req.get('x-term-test-sync')!==fakeWorkerKey)return res.sendStatus(403);
    fixtureGradeRequests.push(req.body);
    return res.json({ok:true,status:'synced',attemptToken:req.body.attemptToken});
  });
  outer.get('/preview/writing-portal',(_req,res)=>res.json(fixtureGradeRequests));
  outer.post('/preview/writing-collect-due/:attempt',async(req,res)=>{
    if(req.get('x-writing-test-sync')!==fakeWorkerKey)return res.sendStatus(403);
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if(!uuid.test(req.params.attempt))return res.sendStatus(400);
    // Advance only the synthetic collector delay. Keep leases and result writes on the real HTTP routes.
    const updated=await fixture.db.query(`UPDATE assessment.term_test_writing_grading_job job
      SET next_attempt_at=now() FROM assessment.term_test_writing_grading_run run
      WHERE run.id=job.run_id AND run.attempt_id=$1 AND job.job_type='collect' AND job.status='retry_wait'`,[req.params.attempt]);
    return res.json({jobs:updated.affectedRows});
  });
}
if (journalFixture) outer.get('/preview/writing-journal',async (req,res)=>{
  const bySession=(Boolean(reportSlug)||term1PaperMode==='on')&&typeof req.query.session==='string';
  const attempt=String((bySession?req.query.session:req.query.attempt)||'');
  if(!/^[0-9a-f-]{36}$/.test(attempt))return res.status(400).json({ok:false});
  const result=await journalFixture.read(attempt,req.query.archive==='1',bySession);
  res.json(result);
});
if(reportSlug){
  let journalPaused=false;
  const previewId=reportSlug==='term-test-1'?'term1':'term2';
  outer.post('/preview/'+previewId+'-report-journal',express.json(),(req,res)=>{
    if(typeof req.body?.paused!=='boolean')return res.sendStatus(400);
    journalPaused=req.body.paused;
    return res.json({ok:true});
  });
  outer.post('/api/term-tests/'+reportSlug+'/journal-events',(_req,res,next)=>{
    if(journalPaused)return res.sendStatus(503);
    next();
  });
  outer.post('/api/term-tests/'+reportSlug+'/listening/report',(_req,res)=>res.sendStatus(503));
}
if (writingHoldEnabled) outer.get('/preview/writing-submission',async (req,res)=>{
  const {attempt,operation}=req.query;
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (typeof attempt!=='string'||typeof operation!=='string'||!uuid.test(attempt)||!uuid.test(operation))
    return res.status(400).json({ok:false});
  const receipt=(await fixture.db.query(`SELECT j.sections
    FROM assessment.term_test_attempt a JOIN assessment.term_k67_cbt_journey j ON j.session_id=a.exam_session_id
    WHERE a.id=$1`,[attempt])).rows[0];
  const jobs=(await fixture.db.query(`SELECT r.task_number AS task,count(*)::int AS jobs
    FROM assessment.term_test_writing_grading_run r
    JOIN assessment.term_test_writing_grading_job j ON j.run_id=r.id AND j.job_type='dispatch'
    WHERE r.attempt_id=$1 GROUP BY r.task_number ORDER BY r.task_number`,[attempt])).rows;
  const held=(await fixture.db.query(`SELECT h.payload_hash AS "payloadHash",
    char_length(h.payload->'answers'->>'task1') AS "task1Length",
    char_length(h.payload->'answers'->>'task2') AS "task2Length"
    FROM assessment.term_k67_writing_submission_hold h
    JOIN assessment.term_test_attempt a ON a.exam_session_id=h.session_id AND a.generation=h.generation
    WHERE a.id=$1 AND h.operation_id=$2 AND h.expires_at>clock_timestamp() AND h.payload IS NOT NULL`,[attempt,operation])).rows[0];
  const sections=receipt?.sections||{};
  res.json({receiptVerified:sections.writing?.operationId===operation,sections:Object.keys(sections).sort(),jobs,...held&&{held}});
});
if(lrHold.termCbtLrHoldHours||miniHoldEnabled)outer.get('/preview/reading-review',async(req,res)=>{
  const {session,operation}=req.query;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(typeof session!=='string'||typeof operation!=='string'||!uuid.test(session)||!uuid.test(operation))
    return res.status(400).json({ok:false});
  const {rows:[row]}=await fixture.db.query(`SELECT j.sections,h.payload_hash AS "payloadHash",h.review_only AS "reviewOnly",
    h.payload->'answers' AS answers,
    (SELECT count(*)::int FROM assessment.term_test_writing_grading_run r
     JOIN assessment.term_test_attempt a ON a.id=r.attempt_id WHERE a.exam_session_id=j.session_id) AS jobs
    FROM assessment.${miniHoldEnabled?'mini_k67_cbt_journey':'term_k67_cbt_journey'} j
    LEFT JOIN assessment.term_k67_lr_submission_hold h
      ON h.session_id=j.session_id AND h.generation=j.generation AND h.section='reading' AND h.operation_id=$2
    WHERE j.session_id=$1`,[session,operation]);
  if(!row)return res.status(404).json({ok:false});
  const {sections,...held}=row;
  res.json({...held,sections:Object.keys(sections).sort()});
});
// Readback chỉ trong bản thử localhost, trả mốc/hạn của phiên giả mà không trả đáp án.
outer.get('/preview/audio-state',async(req,res)=>{
  if(!/^[0-9a-f-]{36}$/.test(req.query.id||''))return res.status(400).json({ok:false});
  const row=(await fixture.db.query(`SELECT listening_audio_checkpoint_seconds,listening_audio_checkpoint_at,
    listening_audio_state,listening_recovery_seconds,listening_started_at,listening_deadline_at,listening_submitted_at,
    listening_audio_protocol_version,listening_audio_revision,listening_audio_incident_id,listening_draft,listening_draft_revision,audio_owner_id
    FROM assessment.term_test_exam_session WHERE id=$1`,[req.query.id])).rows[0];
  res.json({ok:true,fixtureOnly:true,...row});
});
// Điều khiển thời gian chỉ tồn tại ở công cụ localhost chứa dữ liệu giả; không mount trong app production.
if(protection)outer.post('/preview/incident-clock',express.json(),async(req,res)=>{
  const {id,seconds,deadlineSeconds,recoveryUsed,startedSecondsAgo}=req.body;
  if(!/^[0-9a-f-]{36}$/.test(id||'')||![seconds,deadlineSeconds,recoveryUsed,startedSecondsAgo].every(x=>x===undefined||Number.isFinite(x)))return res.status(400).json({ok:false});
  if(startedSecondsAgo!==undefined)await fixture.db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=clock_timestamp()-make_interval(secs=>$2::double precision) WHERE id=$1`,[id,startedSecondsAgo]);
  if(seconds!==undefined)await fixture.db.query(`UPDATE assessment.term_test_audio_incident SET opened_at=clock_timestamp()-make_interval(secs=>$2::double precision) WHERE exam_session_id=$1 AND resolved_at IS NULL`,[id,seconds]);
  if(deadlineSeconds!==undefined)await fixture.db.query(`UPDATE assessment.term_test_exam_session SET listening_deadline_at=clock_timestamp()+make_interval(secs=>$2::double precision) WHERE id=$1`,[id,deadlineSeconds]);
  if(recoveryUsed!==undefined)await fixture.db.query('UPDATE assessment.term_test_exam_session SET listening_recovery_seconds=$2 WHERE id=$1',[id,recoveryUsed]);
  res.json({ok:true,fixtureOnly:true});
});
const fixtureConfig = `window.TERM_TEST_APP_CONFIG={API_BASE_URL:location.origin,GOOGLE_CLIENT_ID:''${journalFixture?',EXAM_JOURNAL_ENABLED:true':''}};`;
outer.get('/term-tests/k67-shared/config.js',(_req,res)=>res.type('application/javascript').send(fixtureConfig));
const previousPagesRevision=process.env.K67_PREVIEW_PREVIOUS_PAGES_REVISION;
if(previousPagesRevision){
  if(!/^[a-f0-9]{40}$/.test(previousPagesRevision))throw new Error('Revision Pages thử không hợp lệ.');
  const paperPreview=term1PaperMode==='on'&&term1JourneyMode!=='on';
  const route=paperPreview?'term-test-1':term1JourneyMode==='on'?'term-test-1-computer-based'
    :term2JourneyMode==='on'?'term-test-2-computer-based':'mini-test-lesson-5-computer-based';
  const files=[`term-tests/${route}/index.html`];
  if(paperPreview)files.push(`term-tests/${route}/offline-worker.js`,`term-tests/${route}/offline-assets.mjs`,
    'shared/teacher-single-sign-on.js','term-tests/teacher/app.js','term-tests/teacher/index.html');
  else if (term1JourneyMode!=='on' && term2Parallel!=='warm-up') files.push(`term-tests/${route}/offline-assets.mjs`,
    'term-tests/term-test-2-computer-based/bootstrap-terms-cbt.js','term-tests/term-test-2-computer-based/bootstrap.js',
    'term-tests/shared/app-terms-cbt.js','term-tests/shared/app.js',
    'term-tests/mini-test-lesson-5-computer-based/journey-terms-cbt.mjs','term-tests/k67-shared/offline-journey-ui.mjs');
  if(term2JourneyMode==='on' && term2Parallel!=='warm-up')files.push(`term-tests/${route}/offline-assets-audio-status-v2.mjs`,
    'term-tests/mini-test-lesson-5-computer-based/journey-terms-cbt-audio-status-v2.mjs',
    'term-tests/term-test-2-computer-based/bootstrap-terms-cbt-audio-status-v2.js',
    'term-tests/term-test-2-computer-based/enhance-terms-cbt.js',
    'term-tests/shared/exam-journal/bridge.mjs');
  const previous=new Map(files.map(file=>[file,execFileSync('git',['show',previousPagesRevision+':'+file],
    {cwd:pages,encoding:'utf8'}).replace(/\r\n/g,'\n')]));
  let servingPrevious=true;
  outer.post('/preview/switch-pages',(req,res)=>{servingPrevious=req.query.previous==='1';res.json({ok:true});});
  outer.use((req,res,next)=>{
    if(!servingPrevious||req.method!=='GET')return next();
    const file=req.path.replace(/^\//,'').replace(/\/$/,'/index.html');
    const content=previous.get(file);
    if(!content)return next();
    const body=/\/offline-assets(?:-audio-status-v2)?\.mjs$/.test(file)
      ? content.replace(/("\.\.\/k67-shared\/config\.js":\s*")[a-f0-9]{64}(")/,
          (_match,before,after)=>before+createHash('sha256').update(fixtureConfig).digest('hex')+after)
      : content;
    res.type(path.extname(file)).send(body);
  });
}

const offlineEntries=[];
if(process.env.K67_PREVIEW_MINI_CBT_OFFLINE==='on'||journeyMode==='on')offlineEntries.push('mini-test-lesson-5-computer-based');
if(term1JourneyMode==='on')offlineEntries.push('term-test-1-computer-based');
if(term1PaperMode==='on')offlineEntries.push('term-test-1');
if(term2JourneyMode==='on')offlineEntries.push('term-test-2-computer-based');
if(pretestMode==='on')offlineEntries.push('pretest-lesson-16-computer-based','pretest-lesson-16');
if(term2JourneyMode==='on'&&rescueClass)offlineEntries.push('term-test-2-rescue');
if(retakeMode==='on')offlineEntries.push('term-test-1-listening-retake');
for(const entry of offlineEntries){
  // The isolated server replaces only the origin config. Production digests are
  // checked separately against Git bytes, while this fixture still checks its cache.
  const fixtureManifests=['offline-assets-listening-first-frame-v1.mjs',
    ...(['term-test-1-computer-based','term-test-2-computer-based'].includes(entry)?[
      'offline-assets-student-cache-v2-preview-verified-v1-confirmed-departure-v1.mjs',
      'offline-assets-student-cache-v2-preview-verified-v1-confirmed-departure-v1-listening-recovery-v1.mjs'
    ]:[]),
    ...(miniParallel&&entry==='mini-test-lesson-5-computer-based'
      ?['offline-assets-mini-parallel-v1.mjs','offline-assets-audio-report-v1.mjs']:[]),
    ...(entry==='mini-test-lesson-5-computer-based'
      ?['offline-assets-mini-student-cache-v3-preview-verified-v1-confirmed-departure-v1-listening-recovery-v1.mjs']:[]),
    ...(['term-test-1-computer-based','term-test-2-computer-based','term-test-1'].includes(entry)?['offline-assets-parallel-v1.mjs']:[]),
    ...(entry.startsWith('pretest-lesson-16')?['offline-assets-audio-status-v2.mjs']
    :['offline-assets.mjs','offline-assets-audio-status-v1.mjs','offline-assets-audio-status-v2.mjs'])];
  outer.get(fixtureManifests.map(name=>`/term-tests/${entry}/${name}`), async (req,res,next) => {
    try {
      const source = await readFile(path.join(pages,'term-tests',entry,path.posix.basename(req.path)),'utf8');
      const hash = createHash('sha256').update(fixtureConfig).digest('hex');
      res.type('application/javascript').send(source.replace(/("\.\.\/k67-shared\/config\.js":\s*")[a-f0-9]{64}(")/,
        (_match, before, after) => before + hash + after));
    } catch (error) { next(error); }
  });
  outer.get(/^\/(?:term-tests|shared|speaking-homework)\//, async (req,res,next) => {
    if (typeof req.query.examBuild !== 'string' || !/^[a-f0-9]{64}$/.test(req.query.examBuild)) return next();
    const file = path.resolve(pages, '.' + req.path);
    if (!file.startsWith(pages + path.sep) || !/\.(?:js|mjs|css|svg|html)$/.test(file)) return next();
    try { res.type(path.extname(file)).send((await readFile(file,'utf8')).replace(/\r\n/g, '\n')); }
    catch { next(); }
  });
}
let miniParallelDefault=false;
if(miniParallel)outer.post('/preview/mini-parallel-default',(_req,res)=>{
  miniParallelDefault=true;
  res.json({fixtureOnly:true,enabled:true});
});
if(miniParallel)outer.get('/preview/mini-parallel-readback',async(_req,res)=>{
  const attempts=await fixture.db.query(`SELECT reading_answers,listening_answers,combined_result,mini_k67_first_submission_guard
    FROM assessment.term_test_attempt WHERE test_slug='mini-test-lesson-5' AND superseded_at IS NULL
      AND (reading_submitted_at IS NOT NULL OR listening_submitted_at IS NOT NULL)`);
  const journey=await fixture.db.query(`SELECT session_id::text AS session_id,sections
    FROM assessment.mini_k67_cbt_journey WHERE sections<>'{}'::jsonb ORDER BY session_id`);
  res.json({fixtureOnly:true,attempts:attempts.rows,journey:journey.rows});
});
outer.get('/preview-tone.wav',(_req,res)=>res.type('audio/wav').send(wav));
if(term1Audio)outer.get('/preview-term1-audio',(_req,res)=>res.type('audio/mpeg').send(term1Audio));
if(term2Audio)outer.get('/preview-term2-audio',(_req,res)=>res.type('audio/mpeg').send(term2Audio));
outer.get('/preview-mini-audio',(_req,res)=>res.type(miniAudio?'audio/mpeg':'audio/wav').send(audioBytes('mini-test-lesson-5')));
outer.get('/preview-only.css',(_req,res)=>res.type('text/css').send(`.preview-banner{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 20px;background:#fff6d8;color:#694b00;font:14px system-ui}.preview-banner button{padding:8px;border:1px solid #eed48b;border-radius:6px;cursor:pointer}@media(max-width:700px){.preview-banner{align-items:flex-start;flex-direction:column}}`));
outer.get('/preview-only.js',(_req,res)=>res.type('application/javascript').send(`document.getElementById('resetPreview')?.addEventListener('click',async()=>{if(!confirm('Xóa dữ liệu giả trên bản thử này để làm lại?'))return;await fetch('/preview/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});for(const storage of [localStorage,sessionStorage])for(const key of Object.keys(storage))if(/^izone-(test|mini)/.test(key))storage.removeItem(key);location.href='/term-tests/';});`));
outer.get(/^\/term-tests\/(?:|(?:term-test-[12](?:-computer-based)?|mini-test-lesson-5(?:-computer-based)?)\/)(?:index.html)?$/,async(req,res,next)=>{
  try {const file=path.join(pages,req.path.replace(/^\//,''),req.path.endsWith('/')?'index.html':'');
    const switchMini=miniParallelDefault&&/\/mini-test-lesson-5-computer-based\/(?:index\.html)?$/.test(req.path);
    const selectedFile=switchMini?path.join(pages,'term-tests/mini-test-lesson-5-computer-based/index-mini-parallel-v1.html'):file;
    const source=await readFile(selectedFile,'utf8');
    const local=term1ReportCases?source.replace(/<meta name="izone-term1-journal-ingress"[^>]+>/,''):source;
    const html=local.replace('</head>','<link rel="stylesheet" href="/preview-only.css"></head>')
      .replace(/(<body[^>]*>)/,`$1<aside class="preview-banner" role="status"><span><strong>Bản thử K67</strong> · Đề và tên giả · ${miniAudio?'Audio Mini thật':'Audio giả'} · Không gửi điểm hoặc chấm AI bên ngoài</span><button id="resetPreview" type="button">Làm lại bản thử</button></aside>`)
      .replace('</body>','<script src="/preview-only.js"></script></body>');res.type('html').send(html);
  }catch(e){next(e);}
});
outer.use('/preview/reset',express.json(),async(_req,res)=>{await fixture.db.exec('UPDATE assessment.term_test_exam_session SET attempt_id=NULL;UPDATE assessment.term_test_attempt SET exam_session_id=NULL;DELETE FROM assessment.term_test_attempt;DELETE FROM assessment.term_test_exam_session;');res.json({ok:true,fixtureOnly:true});});
if(fullWritingHold)outer.post('/preview/fill-writing-hold/:attempt',async(req,res)=>{
  const {attempt}=req.params;
  if(!/^[0-9a-f-]{36}$/.test(attempt))return res.status(400).json({ok:false});
  const {rows}=await fixture.db.query(`INSERT INTO assessment.term_k67_writing_submission_hold
    (session_id,generation,operation_id,payload_hash,payload,held_at,expires_at)
    SELECT a.exam_session_id,a.generation,$2,$3,'{}',clock_timestamp(),clock_timestamp()+interval '2 hours'
    FROM assessment.term_test_attempt a WHERE a.id=$1 AND a.test_slug=$4
    RETURNING operation_id`,[attempt,randomUUID(),'a'.repeat(64),termHoldSlug]);
  res.json({holds:rows.length});
});
outer.use(express.static(pages));
if (holdSlug) outer.use((req,_res,next)=>{
  if(req.method!=='POST'||req.path!==`/api/term-tests/${holdSlug}/cbt-journey/seal`)return next();
  const now=Number(req.get('x-preview-seal-clock'));
  if(!Number.isSafeInteger(now)||Math.abs(Date.now()-now)>180_000)return next();
  sealClock.run(now,next);
});
outer.use((req,res,next)=>previewApp(req,res,next));
const refresh=setInterval(()=>fixture.db.exec('UPDATE mapping.k67_context_state SET captured_at=now()').catch(console.error),30000);
const server=outer.listen(port,'127.0.0.1',()=>console.log(`Bản thử K67: http://127.0.0.1:${port}/term-tests/?class=IC2304`));
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{clearInterval(refresh);server.close(async()=>{await fixture.db.close();process.exit(0);});});
