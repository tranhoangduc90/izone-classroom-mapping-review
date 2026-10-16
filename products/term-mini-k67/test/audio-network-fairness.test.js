import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';

// Các phiên hợp lệ dùng chung IP thật của supertest; token sai xoay liên tục không được né quota mạng.
// Kiểm ở HTTP/SQL, không gọi helper tạo key hoặc tự khai token là đã xác thực.
let f,api,tokens=[];
const base='/api/term-tests/mini-test-lesson-5';
const assets={supports:()=>true,getTiming:()=>({listeningDurationSeconds:120,listeningTotalSeconds:240}),getContent:async()=>({}),getPreview:async()=>Buffer.from('Audio nghe thử giả'),getSessionAudioKey:()=>Buffer.alloc(32)};
before(async()=>{
  f=await createMiniFixture({examOrder:true,assets,audioProtection:true});api=request(f.app);
  for(let i=0;i<4;i++){
    const classId=(await f.db.query("SELECT erp_course_class_id FROM mapping.classroom_course_mapping WHERE erp_class_name_snapshot='IC2304'")).rows[0].erp_course_class_id;
    const ref=randomUUID();await f.db.query(`INSERT INTO mapping.student_mapping_review VALUES($1,$2,$3,$4,'approved')`,[ref,classId,50000+i,'Học viên thử '+i]);
    const p=await api.post(base+'/session/prepare').send({classCode:'IC2304',studentRef:ref});assert.ok([200,201].includes(p.status),JSON.stringify(p.body));
    const token={examSessionToken:p.body.examSessionToken,generation:0};tokens.push(token);
    assert.equal((await api.post(base+'/session/start').send({...token,audioProtocolVersion:1})).status,200);
  }
});
after(async()=>f?.db.close());
test('Hơn 900 yêu cầu từ nhiều phiên cùng IP không chiếm quota nhau; đường giữ bài vẫn mở',async()=>{
  for(let round=0;round<230;round++)for(const token of tokens){
    const r=await api.post(base+'/session/audio-state').send(token);
    assert.equal(r.status,200,`Lượt ${round}: phiên hợp lệ cùng mạng không được bị quota IP chặn: ${r.body.error}`);
  }
  const id=randomUUID(),held=await api.post(base+'/session/audio-incident').send({...tokens[0],eventId:id,incidentId:id,heardSeconds:0,reason:'manual'});
  assert.equal(held.status,200);assert.equal(held.body.activeIncident.incidentId,id);
});
test('Audio nghe thử GET theo phiên không gộp quota đọc của nhiều người chung IP',async()=>{
  for(let round=0;round<65;round++)for(const token of tokens){
    const r=await api.get(base+'/session/'+token.examSessionToken+'/preview');
    assert.equal(r.status,200,`GET nghe thử lượt ${round}: ${r.body.error}`);
  }
});
test('Token sai đổi liên tục bị giới hạn theo IP nhưng không khóa điều khiển phiên hợp lệ',async()=>{
  let limited=0;
  for(let i=0;i<910;i++){
    const r=await api.post(base+'/session/audio-state').send({examSessionToken:randomUUID(),generation:0});
    assert.ok([409,429].includes(r.status));if(r.status===429)limited++;
  }
  assert.ok(limited>0,'Token giả xoay không được có ngân sách riêng vô hạn');
  const good=await api.post(base+'/session/audio-state').send(tokens[1]);assert.equal(good.status,200);
});
