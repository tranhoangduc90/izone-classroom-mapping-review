import {createHmac, timingSafeEqual} from 'node:crypto';

export const products = Object.freeze({
  'reading-homework': {prefix:'/reading-skills67/', label:'Reading Homework'},
  'listening-homework': {prefix:'/listening-homework/', label:'Listening Homework'},
  'reading-practice': {prefix:'/reading-practice/', label:'Reading thực chiến'},
  'listening-practice': {prefix:'/listening-practice/', label:'Listening thực chiến'},
});
const pagesOrigin = 'https://tranhoangduc90.github.io';
const pagesRoot = '/izone-ai-team-pages';
const entryPage = pagesOrigin + pagesRoot + '/classroom-confirmation/';
const ttl = 10 * 60_000;
const reasons = Object.freeze({
  CLASS_MISMATCH:'Lớp của bản bài không còn khớp nguồn Classroom.',
  OWNER_UNRESOLVED:'Chưa xác định được tài khoản Google của chủ bài.',
  MAPPING_CONFLICT:'Hồ sơ và tài khoản Google có liên kết mâu thuẫn.',
  BINDING_UNAVAILABLE:'Đã xác nhận danh tính nhưng chưa nối được đúng bản bài.',
});
const email = /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/;

export class EntryError extends Error {
  constructor(code, message, status=409) { super(message); this.code=code; this.status=status; }
}
const fail = (code,message,status) => { throw new EntryError(code,message,status); };
export function sameSecret(left,right) {
  if(typeof left!=='string'||typeof right!=='string'||!right) return false;
  const a=Buffer.from(left), b=Buffer.from(right);
  return a.length===b.length && timingSafeEqual(a,b);
}

// Dùng đúng tên sản phẩm và URL native đã cấu hình. URL client không tham gia điều hướng.
export function productUrl(product, value, {fallback=false,classCode,assignmentCode}={}) {
  const definition = products[product];
  if(!definition || typeof value!=='string') fail('INVALID_PRODUCT_URL','Link sản phẩm chưa hợp lệ.');
  let url;
  try { url = new URL(value, pagesOrigin+pagesRoot+'/'); }
  catch { fail('INVALID_PRODUCT_URL','Link sản phẩm chưa hợp lệ.'); }
  const prefix = pagesRoot + definition.prefix;
  const codeKey = product.endsWith('-practice') && url.searchParams.has('lesson') ? 'lesson' : 'assignmentCode';
  if(url.origin!==pagesOrigin||url.username||url.password||!url.pathname.startsWith(prefix)||
      !/^[A-Za-z0-9_./-]+$/.test(url.pathname)||url.pathname.includes('//')||
      url.searchParams.get('class')!==classCode||
      url.searchParams.get(codeKey)!==assignmentCode||url.searchParams.get('mode')!=='student')
    fail('INVALID_PRODUCT_URL','Link sản phẩm chưa hợp lệ.');
  if(fallback) {
    if(url.hash||url.searchParams.has('documentId')||
       [...url.searchParams.keys()].some(key=>!['lesson','assignmentCode','mode','class','fresh','server'].includes(key)))
      fail('INVALID_FALLBACK','Link chọn tên chưa hợp lệ.');
    url.searchParams.set('fresh','1');
  }
  return url;
}

export function createConfirmation({pool, signingKey, finishBinding, now=Date.now}) {
  if(Buffer.byteLength(signingKey||'')<32) throw new Error('RL67_CONFIRMATION_KEY_REQUIRED');
  const first = async (sql,args) => (await pool.query(sql,args)).rows[0]?.value;
  const read = (id,student=null) => first('SELECT rl67_cta_confirmation.resolve($1,$2) AS value',[id,student]);
  const record = (id,reason) => first('SELECT rl67_cta_confirmation.record_notice($1,$2) AS value',[id,reason]);
  async function requireState(id,state) {
    if(state?.state==='choose'||state?.state==='linked') return state;
    if(Object.hasOwn(reasons,state?.state)) {
      await record(id,state.state);
      fail(state.state,reasons[state.state]);
    }
    fail('CTA_NOT_VERIFIED','Link xác nhận chưa sẵn sàng. Hãy mở lại từ bài Classroom của bạn.',404);
  }
  function sign(id,state,ref,expires) {
    return createHmac('sha256',signingKey).update(JSON.stringify(['rl67-confirm-v1',id,
      state.product,state.assignmentCode,state.classCode,state.courseId,state.courseWorkId,
      state.submissionId,state.documentId,state.googleUserId,ref,expires])).digest('base64url');
  }
  async function link(id,state) {
    try {
      const result=await finishBinding(state);
      if(result.studentRef!==state.studentRef||result.documentId!==state.documentId)
        throw new Error('CTA_BINDING_WRONG_OWNER');
      const url=productUrl(state.product,result.entryUrl,state);
      if(url.searchParams.get('documentId')!==state.documentId)
        throw new Error('CTA_BINDING_WRONG_DOCUMENT');
      return {state:'linked',classCode:state.classCode,studentRef:state.studentRef,
        entryUrl:url.href,decisionId:state.decisionId||null};
    } catch {
      await record(id,'BINDING_UNAVAILABLE');
      fail('BINDING_UNAVAILABLE',reasons.BINDING_UNAVAILABLE,503);
    }
  }
  async function ensureAvailable(id,state) {
    try { await finishBinding(state,{checkOnly:true}); }
    catch {
      await record(id,'BINDING_UNAVAILABLE');
      fail('BINDING_UNAVAILABLE','Chưa kiểm được lớp và bài đang mở. Hãy thử lại sau.',503);
    }
  }
  return {
    async prepare(input) {
      const {product,assignmentCode,fallbackPath,documentId,courseId,courseWorkId,submissionId,googleUserId,classCode}=input;
      const url=productUrl(product,fallbackPath,{fallback:true,classCode,assignmentCode});
      const [skill,kind]=product.split('-');
      const prefix=kind==='practice'?`67-practice-${skill}_`:`67-${skill}-`;
      if(!assignmentCode.startsWith(prefix))
        fail('SOURCE_NOT_VERIFIED','Mã bài không khớp sản phẩm.');
      try { await finishBinding(input,{checkOnly:true}); }
      catch { fail('SOURCE_NOT_VERIFIED','Nguồn Classroom chưa khớp duy nhất với bài này.'); }
      const id=await first('SELECT rl67_cta_confirmation.prepare($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value',
        [product,assignmentCode,url.pathname+url.search,documentId,courseId,courseWorkId,submissionId,googleUserId,classCode]);
      if(!id) fail('SOURCE_NOT_VERIFIED','Nguồn Classroom chưa khớp duy nhất với bài này.');
      return {id,entryUrl:entryPage+'#'+id};
    },
    async activate({id,product}) {
      if(!await first('SELECT rl67_cta_confirmation.activate($1,$2) AS value',[id,product]))
        fail('SOURCE_NOT_VERIFIED','Không tìm thấy CTA đã chuẩn bị.',404);
    },
    async fallback(id) {
      const state=await read(id);
      if(!['choose','linked'].includes(state?.state)) fail('CTA_NOT_VERIFIED','Hãy mở lại từ bài Classroom.',404);
      const url=productUrl(state.product,state.fallbackPath,{...state,fallback:true});
      return {state:'choose',classCode:state.classCode,product:state.product,fallbackUrl:url.href,students:[]};
    },
    async form(id) {
      const state=await requireState(id,await read(id));
      if(state.state==='linked') return link(id,state);
      await ensureAvailable(id,state);
      const url=productUrl(state.product,state.fallbackPath,{...state,fallback:true});
      const data={state:'choose',classCode:state.classCode,product:state.product,fallbackUrl:url.href};
      if(!state.students.length||state.students.length>100) return {...data,students:[]};
      if(!email.test(state.account)) {
        await record(id,'OWNER_UNRESOLVED');
        fail('OWNER_UNRESOLVED',reasons.OWNER_UNRESOLVED);
      }
      const expires=now()+ttl;
      return {...data,account:state.account,students:state.students.map(person=>({...person,
        token:`${expires}.${sign(id,state,person.studentRef,expires)}`}))};
    },
    async confirm({id,studentRef,token}) {
      const state=await requireState(id,await read(id));
      const [time,signature]=token.split('.');
      const expires=Number(time);
      const current=now();
      if(!Number.isSafeInteger(expires)||expires<current||expires>current+ttl||
        !sameSecret(signature,sign(id,state,studentRef,expires)))
        fail('CONFIRMATION_EXPIRED','Màn xác nhận đã thay đổi hoặc hết hạn. Hãy tải lại.');
      await ensureAvailable(id,state);
      const confirmed=await requireState(id,await read(id,studentRef));
      if(confirmed.state!=='linked') fail('MAPPING_CONFLICT',reasons.MAPPING_CONFLICT);
      return link(id,confirmed);
    },
  };
}
