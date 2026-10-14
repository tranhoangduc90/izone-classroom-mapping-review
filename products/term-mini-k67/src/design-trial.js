// Cổng dữ liệu thử: chuyển tiếp tới nguyên handler thi, chỉ cho người thử riêng.
// Không sửa scorer/deadline/nháp. Token của lớp/người khác bị chặn trước handler ghi.
export const designTrialStudents=Object.freeze([
 ['term-test-1',8061401,'e4e2050c-1441-4414-8000-000000000001','Bạn thử Term 1 A'],
 ['term-test-1',8061402,'e4e2050c-1441-4414-8000-000000000002','Bạn thử Term 1 B'],
 ['term-test-2',8061403,'e4e2050c-1441-4414-8000-000000000003','Bạn thử Term 2 A'],
 ['term-test-2',8061404,'e4e2050c-1441-4414-8000-000000000004','Bạn thử Term 2 B'],
 ['mini-test-lesson-5',8061405,'e4e2050c-1441-4414-8000-000000000005','Bạn thử Mini A'],
 ['mini-test-lesson-5',8061406,'e4e2050c-1441-4414-8000-000000000006','Bạn thử Mini B'],
 ['mini-test-lesson-5',8061407,'e4e2050c-1441-4414-8000-000000000007','Bạn thử phiếu Mini A'],
 ['mini-test-lesson-5',8061408,'e4e2050c-1441-4414-8000-000000000008','Bạn thử phiếu Mini B']
]);
const prefix='/api/term-tests/teacher/design-demo/trial';
const uuids=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function mountDesignTrial(app,{pool}){
 app.use(prefix,async(req,res,next)=>{
  try{
   const paper=req.path.startsWith('/paper/'),target=paper?req.url.slice(6):req.url;
   const url=new URL(target,'http://trial.local'),path=url.pathname;
   const slots=designTrialStudents.filter(s=>paper?s[1]>=8061407:s[1]<8061407),ids=slots.map(s=>s[1]);
   const tempPrefix=paper?'DESIGNP':'DESIGNC';
   const fail=()=>res.status(403).json({ok:false,error:'DESIGN_TRIAL_SCOPE',message:'Demo chỉ dùng người và lượt thử riêng.'});
   if(!['GET','POST'].includes(req.method)||!path.startsWith('/api/term-tests/'))return fail();
   const common=['/api/term-tests/writing','/api/term-tests/writing/planning','/api/term-tests/roster','/api/term-tests/demo/reset','/api/term-tests/result','/api/term-tests/result/review','/api/term-tests/result/stream'];
   const match=path.match(/^\/api\/term-tests\/(term-test-1|term-test-2|mini-test-lesson-5)\/(.+)$/);
   if(!common.includes(path)&&!match)return fail();
   if(paper&&path.startsWith('/api/term-tests/writing'))return fail();
   if(paper&&match&&(match[1]!=='mini-test-lesson-5'||(!match[2].startsWith('answer-sheet/')&&match[2]!=='temporary-students')))return fail();
   if(!paper&&match&&match[2].startsWith('answer-sheet/'))return fail();
   const classCode=req.body?.classCode||url.searchParams.get('class');
   if(classCode&&classCode!=='CODEXDEMO806')return fail();
   const ref=req.body?.studentRef;
   if(ref&&!slots.some(s=>s[2]===ref)){
    if(!uuids.test(ref))return fail();
    const r=await pool.query(`SELECT 1 FROM assessment.term_test_temporary_student WHERE student_ref=$1::uuid AND erp_course_class_id=-8062028 AND active AND temporary_code_normalized LIKE $2`,[ref,tempPrefix+'%']);
    if(r.rows.length!==1)return fail();
   }
   if(match?.[2]==='temporary-students'&&!String(req.body?.temporaryCode||'').toUpperCase().startsWith(tempPrefix))return fail();
   const tokens=[req.body?.attemptToken,req.body?.examSessionToken,path.match(/\/session\/([0-9a-f-]{36})\/(?:audio|preview)$/i)?.[1]].filter(Boolean);
   for(const token of tokens){
    if(!uuids.test(token))return fail();
    const r=await pool.query(`WITH a AS (
      SELECT erp_course_class_id,erp_student_contact_id FROM assessment.term_test_attempt WHERE id=$1::uuid
      UNION ALL SELECT erp_course_class_id,erp_student_contact_id FROM assessment.term_test_exam_session WHERE id=$1::uuid
     ) SELECT EXISTS(SELECT 1 FROM a) AS found,EXISTS(SELECT 1 FROM a WHERE a.erp_course_class_id=-8062028 AND (a.erp_student_contact_id=ANY($2::bigint[]) OR EXISTS(
      SELECT 1 FROM assessment.term_test_temporary_student t WHERE t.temporary_student_id=a.erp_student_contact_id AND t.erp_course_class_id=a.erp_course_class_id AND t.active AND t.temporary_code_normalized LIKE $3))) AS owned`,[token,ids,tempPrefix+'%']);
    if(r.rows[0]?.found&&!r.rows[0]?.owned)return fail();
   }
   if(path==='/api/term-tests/demo/reset'&&!slots.some(s=>s[2]===ref))return fail();
   // Chỉ thay danh mục dữ liệu thử; các handler mở/lưu/nộp bên dưới giữ nguyên.
   const temporaryRefs=path==='/api/term-tests/roster'?(await pool.query('SELECT student_ref FROM assessment.term_test_temporary_student WHERE erp_course_class_id=-8062028 AND active AND temporary_code_normalized LIKE $1',[tempPrefix+'%'])).rows.map(t=>t.student_ref):[];
   const json=res.json.bind(res);
   res.json=data=>{
    if(path.endsWith('/answer-sheet/classes')&&data.ok)data={...data,classes:[{name:'CODEXDEMO806'}]};
    if(path==='/api/term-tests/roster'&&data.ok)data={...data,students:data.students.filter(s=>slots.some(slot=>slot[2]===s.ref)||s.temporary&&temporaryRefs.includes(s.ref))};
    return json(data);
   };
   req.url=target;app.handle(req,res,next);
  }catch(error){next(error);}
 });
}
