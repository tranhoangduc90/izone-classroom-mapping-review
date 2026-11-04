import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {createNativeBinder} from '../src/bind.js';
import {createMailSender,deliverNotice} from '../src/mail.js';
import {createConfirmation,products} from '../src/service.js';

const origin='https://tranhoangduc90.github.io';
const classCode='IC2353';
const paths=Object.entries(products).map(([product,{prefix}])=>[product,prefix]);
const keys=Object.fromEntries(paths.map(([product])=>[product,'fixture-key-for-'+product+'-longer-than-32-characters']));

async function fixture(t) {
  const db=new PGlite();
  t.after(()=>db.close());
  const schema=await readFile(new URL('../../../docs/schema.sql',import.meta.url),'utf8');
  await db.exec(schema.split('CREATE SCHEMA IF NOT EXISTS assessment;')[0]);
  await db.exec('CREATE SCHEMA reading_owner_api_v1; CREATE SCHEMA listening_owner_api_v1;');
  await db.exec(`INSERT INTO mapping.classroom_course_mapping(erp_course_class_id,erp_class_name_snapshot,classroom_course_id,status)
      VALUES(1345,'IC2353','71000','approved');`);
  const migration=await readFile(new URL('../../../backend/ops/migrations/202611040600_rl67_cta_confirmation.sql',import.meta.url),'utf8');
  await db.exec(migration);
  const candidates=new Map();
  async function source(product,index,{missingOwner=false}={}) {
    const [skill,kind]=product.split('-');
    const code=(kind==='practice'?`67-practice-${skill}_`:`67-${skill}-`)+'fixture-'+index;
    const googleUserId='23456000'+index;
    const documentId='fixture-classroom-doc-'+String(index).padStart(4,'0');
    const ref=randomUUID();
    const account='student.fixture.'+index+'@example.invalid';
    const erp=1450+index;
    await db.query(`INSERT INTO mapping.student_mapping_review(public_id,erp_course_class_id,erp_student_contact_id,
      erp_student_name_snapshot) VALUES($1,1345,$2,$3)`,[ref,erp,'Học viên mẫu '+index]);
    await db.query(`INSERT INTO mapping.erp_class_membership_snapshot(erp_course_class_id,erp_student_contact_id,
      erp_class_name_snapshot,erp_student_name_snapshot,registration_status) VALUES(1345,$1,$2,$3,'on_going')`,
      [erp,classCode,'Học viên mẫu '+index]);
    if(!missingOwner) await db.query(`INSERT INTO mapping.classroom_roster_snapshot(classroom_course_id,classroom_user_id,
      classroom_name_snapshot,classroom_email_snapshot) VALUES('71000',$1,$2,$3)`,[googleUserId,'Tài khoản thử',account]);
    const url=new URL(origin+'/izone-ai-team-pages'+products[product].prefix);
    url.search=new URLSearchParams({assignmentCode:code,mode:'student',class:classCode});
    const input={product,assignmentCode:code,fallbackPath:url.href,documentId,courseId:'71000',courseWorkId:'71100',
      submissionId:'submission-'+index,googleUserId,classCode};
    candidates.set(documentId,{input,ref});
    return {input,ref,account};
  }
  const binds=[];
  const targets=Object.fromEntries(paths.map(([p])=>[p,{url:'https://fixture.invalid/'+p,key:keys[p]}]));
  const finishBinding=createNativeBinder(targets,{fetcher:async(url,options)=>{
    const event=JSON.parse(options.body);
    const {input,ref}=candidates.get(event.doc_id);
    assert.equal(new URL(url).pathname,'/'+input.product);
    if(input.product.endsWith('-practice'))
      assert.equal(options.headers['x-'+input.product.split('-')[0]+'-admin'],keys[input.product]);
    else assert.equal(options.headers.authorization,'Bearer '+keys[input.product]);
    assert.equal(event.student_id,input.googleUserId);
    assert.equal(event.submission_id,input.submissionId);
    assert.equal(event.schema_version,'course67_cta_registration_v2');
    assert.equal(event.course,67);
    if(event.check_only)return Response.json({status:'eligible',code:input.assignmentCode,documentId:input.documentId});
    const entryUrl=new URL(input.fallbackPath);
    entryUrl.searchParams.set('documentId',input.documentId);
    binds.push(input.product);
    return Response.json({status:'verified',code:input.assignmentCode,studentRef:ref,documentId:input.documentId,entryUrl:entryUrl.href});
  }});
  const service=createConfirmation({pool:db,signingKey:'fixture-signing-key-with-more-than-thirty-two-characters',finishBinding});
  const app=request(createApp({service,pool:db,publisherKeys:keys,origin}));
  const post=(path,body,key)=>{const call=app.post(path).send(body);return key?call.set('Authorization','Bearer '+key):call;};
  async function prepare(input){
    const {body:{id,entryUrl}}=await post('/internal/prepare',input,keys[input.product]).expect(200);
    assert.equal(new URL(entryUrl).hash,'#'+id);
    await post('/v1/form',{id}).expect(404);
    await post('/internal/activate',{id,product:input.product},keys[input.product]).expect(200);
    return id;
  }
  return {source,post,prepare,db,binds};
}

test('Bốn sản phẩm nhận email đầy đủ, fallback không ghi, xác nhận một lần và retry giữ cùng quyết định',async t=>{
  const f=await fixture(t);
  for(const [index,[product]] of paths.entries()) {
    const {input,ref,account}=await f.source(product,index);
    await f.post('/internal/prepare',input,keys['other-product']).expect(401);
    await f.post('/internal/prepare',{...input,submissionId:'wrong'},keys[product]).expect(409);
    const id=await f.prepare(input);
    const {body:form}=await f.post('/v1/form',{id}).expect(200).expect('Cache-Control','no-store');
    assert.equal(form.account,account);
    assert.equal(form.classCode,classCode);
    assert.equal(form.product,product);
    const {searchParams}=new URL(form.fallbackUrl);
    assert.equal(searchParams.get('fresh'),'1');
    assert.equal(searchParams.has('documentId'),false);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM rl67_cta_confirmation.decision')).rows[0].n,index);
    const token=form.students.find(s=>s.studentRef===ref).token;
    await f.post('/v1/confirm',{id,studentRef:randomUUID(),token}).expect(409);
    const {body:result}=await f.post('/v1/confirm',{id,studentRef:ref,token}).expect(200);
    assert.equal(result.studentRef,ref);
    assert.ok(result.decisionId);
    if(product==='listening-practice') {
      const own=(await f.db.query('SELECT student_ref FROM listening_owner_api_v1.owner WHERE student_ref=$1',[ref])).rows;
      assert.deepEqual(own,[{student_ref:ref}]);
      const foreign=(await f.db.query('SELECT student_ref FROM listening_owner_api_v1.owner WHERE student_ref<>$1',[ref])).rows;
      assert.equal(foreign.length,1);
    }
    assert.equal((await f.post('/v1/confirm',{id,studentRef:ref,token}).expect(200)).body.decisionId,result.decisionId);
    const reentry=(await f.post('/v1/form',{id}).expect(200)).body;
    assert.equal(reentry.studentRef,ref);
    assert.equal(reentry.account,undefined);
  }
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM mapping.mapping_decision_event')).rows[0].n,4);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM rl67_cta_confirmation.notice')).rows[0].n,0);
});

test('Ca nguồn không rõ chỉ tạo một cảnh báo, gửi lại sau lỗi và giữ biên nhận Gmail',async t=>{
  const f=await fixture(t);
  const {input}=await f.source('listening-homework',8,{missingOwner:true});
  const id=await f.prepare(input);
  for(let i=0;i<2;i++) assert.equal((await f.post('/v1/form',{id}).expect(409)).body.error,'OWNER_UNRESOLVED');
  let requests=0;
  const send=createMailSender({from:'sender@example.invalid',to:'owner@example.invalid',accessToken:async()=> 'fake',
    fetcher:async(url,options)=>{
      assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
      const decoded=Buffer.from(JSON.parse(options.body).raw,'base64url').toString();
      assert.match(decoded,/To: owner@example.invalid/);
      const content=Buffer.from(decoded.split('\r\n\r\n')[1],'base64').toString();
      assert.match(content,/listening-homework/);
      assert.ok(!content.includes(input.googleUserId)&&!content.includes(input.documentId));
      return ++requests===1?new Response('',{status:503}):Response.json({id:'gmail-fixture-ok'});
    }});
  assert.equal(await deliverNotice(f.db,send),true);
  const query='SELECT reason,attempts,last_error,message_id FROM rl67_cta_confirmation.notice';
  assert.deepEqual((await f.db.query(query)).rows,[{reason:'OWNER_UNRESOLVED',attempts:1,last_error:'MAIL_HTTP_503',message_id:null}]);
  await f.db.query('UPDATE rl67_cta_confirmation.notice SET available_at=now()');
  assert.equal(await deliverNotice(f.db,send),true);
  assert.equal(await deliverNotice(f.db,send),false);
  assert.deepEqual((await f.db.query(query)).rows,[{reason:'OWNER_UNRESOLVED',attempts:2,last_error:null,message_id:'gmail-fixture-ok'}]);
  await f.db.exec('SET ROLE rl67_cta_confirmation_api');
  await assert.rejects(f.db.query("UPDATE mapping.student_mapping_review SET status='approved'"),{code:'42501'});
  await assert.rejects(f.db.query('SELECT * FROM rl67_cta_confirmation.decision'),{code:'42501'});
  await f.db.exec('RESET ROLE');
});

test('Trình duyệt: đủ email ở hai màn, quay lại chọn tên và chỉ một lần xác nhận cho cả bốn sản phẩm',
  {skip:!process.env.RL67_CONFIRMATION_PAGES||!process.env.PLAYWRIGHT_MODULE,timeout:90000},async t=>{
  const f=await fixture(t);
  const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  const browser=await chromium.launch({channel:'msedge',headless:true});
  t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const requests=[];
  const base='/izone-ai-team-pages/';
  const ui=origin+base+'classroom-confirmation/';
  const pages=resolve(process.env.RL67_CONFIRMATION_PAGES);
  await context.route('**/*',async route=>{
    const request=route.request();
    const url=new URL(request.url());
    if(url.origin===origin&&url.pathname.startsWith(base)) {
      let file=url.pathname.slice(base.length);
      if(file.endsWith('/'))file+='index.html';
      if(!file.startsWith('classroom-confirmation/')&&!file.startsWith('shared/'))
        return route.fulfill({contentType:'text/html',body:'<h1>Native product fixture</h1>'});
      return route.fulfill({path:resolve(pages,file)});
    }
    const cors={'access-control-allow-origin':origin,'access-control-allow-methods':'POST,OPTIONS','access-control-allow-headers':'content-type'};
    if(url.origin==='https://ducizone.ddns.net'&&request.method()==='OPTIONS')
      return route.fulfill({status:204,headers:cors});
    if(url.pathname.startsWith('/rl67-cta-confirmation-api/v1/')) {
      const path=url.pathname.replace('/rl67-cta-confirmation-api','');
      const input=request.postDataJSON();
      requests.push(path);
      const result=await f.post(path,input);
      return route.fulfill({status:result.status,headers:cors,json:result.body});
    }
    if(url.pathname==='/mapping-api/api/student-identity/resolve') {
      const input=request.postDataJSON();
      return route.fulfill({status:200,headers:cors,json:{ok:true,status:'unique',identity:{authority:'erp-contact',id:'555'},
        aliases:[{classId:'1345',classCode,studentRef:input.studentRef,studentName:'Học viên thử'}]}});
    }
    return route.abort();
  });
  for(const [i,[product,prefix]] of paths.entries()){
    const {input,ref,account}=await f.source(product,i+30);
    const id=await f.prepare(input);
    await page.goto(ui+'#'+id);
    await page.getByText(account,{exact:false}).waitFor();
    await page.locator('#student').selectOption(ref);
    await page.getByRole('button',{name:'Tiếp tục'}).click();
    assert.match(await page.locator('#summary').textContent(),new RegExp(account.replaceAll('.','\\.')));
    await page.getByRole('button',{name:'Quay lại'}).click();
    assert.equal(requests.filter(path=>path==='/v1/confirm').length,i);
    await page.getByRole('link',{name:'Không thấy tên của tôi'}).click();
    await page.waitForURL(value=>value.pathname.startsWith(base.slice(0,-1)+prefix)&&value.searchParams.get('fresh')==='1');
    assert.equal(new URL(page.url()).searchParams.has('documentId'),false);
    assert.equal(requests.filter(path=>path==='/v1/confirm').length,i);
    await page.goto(ui+'#'+id);
    await page.locator('#student').selectOption(ref);
    await page.getByRole('button',{name:'Tiếp tục'}).click();
    await page.getByRole('button',{name:'Xác nhận và vào bài'}).click();
    await page.waitForURL(value=>value.pathname.startsWith(base.slice(0,-1)+prefix)&&value.searchParams.get('documentId')===input.documentId);
    assert.equal(requests.filter(path=>path==='/v1/confirm').length,i+1);
  }
  assert.deepEqual(errors,[]);
});
