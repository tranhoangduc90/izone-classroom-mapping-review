import { LearningError } from './learning-service.js';

const localDate = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Ho_Chi_Minh'});
const isRunning = (row,today) => row?.class_status === 'on_going'
  && Boolean(row.class_started_at) && row.class_started_at <= today;

export function createLearningClassPolicy({pool,directoryReader,now=()=>new Date()}) {
  const readCourseId='4';
  let directory=null,expires=0,pending;

  async function load({fresh=false}={}) {
    if(!directoryReader)return null;
    if(!fresh&&now().getTime()<expires)return directory;
    if(!pending){
      pending=Promise.resolve().then(directoryReader).then(rows=>{
        directory=new Map(rows.map(row=>[row.class_id,row]));
        expires=now().getTime()+60000;
        return directory;
      }).catch(()=>{
        directory=null;expires=now().getTime()+5000;
        return null;
      }).finally(()=>{pending=null;});
    }
    return pending;
  }

  async function reviewer(account) {
    const {rows:[scope]}=await pool.query(`SELECT
      EXISTS(SELECT 1 FROM learning.progress_log_admin WHERE reviewer_email=$1 AND status='active') AS global_scope,
      EXISTS(SELECT 1 FROM learning.progress_log_course_viewer WHERE reviewer_email=$1 AND course_id=$2::bigint) AS course_scope`,
      [account.email,readCourseId]);
    const all=scope.global_scope===true;
    return {...account,role:all?'admin':'teacher',canAccessAllClasses:all,
      canReadCourse56:!all&&scope.course_scope===true};
  }

  async function courseClass(actor,classId) {
    if(!actor.canReadCourse56)return null;
    const entry=(await load())?.get(String(classId));
    return entry?.course_id===readCourseId?entry:null;
  }

  async function classRead(actor,classId) {
    return await courseClass(actor,classId)?{...actor,canAccessAllClasses:true}:actor;
  }

  async function assignmentRead(actor,assignmentId,database=pool) {
    if(!actor.canReadCourse56)return actor;
    const {rows}=await database.query(`SELECT erp_course_class_id::text AS class_id
      FROM learning.form_assignment WHERE id=$1::uuid AND status<>'retired'`,[assignmentId]);
    return rows[0]?classRead(actor,rows[0].class_id):actor;
  }

  async function options(actor,query) {
    const catalog=await load();
    const courseClasses=actor.canReadCourse56&&catalog
      ?[...catalog.values()].filter(row=>row.course_id===readCourseId):[];
    const result=await query({...actor,readClassIds:courseClasses.map(row=>row.class_id)});
    const classes=result.classes.map(row=>{
      const entry=catalog?.get(row.class_id);
      return entry?{...row,class_status:entry.class_status,class_started_at:entry.class_started_at}:row;
    });
    const mapped=new Set(classes.map(row=>row.class_id));
    for(const row of courseClasses)if(!mapped.has(row.class_id)){
      classes.push({...row,can_manage:false,student_count:null,progress_log_mapped:false});
    }
    const today=localDate.format(now());
    const assignmentClasses=classes.filter(row=>row.can_manage===true&&isRunning(catalog?.get(row.class_id),today))
      .sort((a,b)=>b.class_started_at.localeCompare(a.class_started_at)
        || b.class_id.length-a.class_id.length || b.class_id.localeCompare(a.class_id));
    return {...result,classes,assignmentClasses,assignmentClassStatus:catalog?'ready':'unavailable'};
  }

  function deliveryCheck({fresh=false}={}) {
    // Share one source read across the targets, including when the source fails.
    let snapshot;
    return async classId=>{
      const catalog=await (snapshot??=load({fresh}));
      if(!catalog?.has(String(classId)))throw new LearningError('CLASS_STATUS_UNAVAILABLE',
        'Chưa xác minh được trạng thái lớp trên ERP. Hãy tải lại danh sách.',503);
      if(!isRunning(catalog.get(String(classId)),localDate.format(now())))throw new LearningError('CLASS_NOT_ONGOING',
        'Lớp hiện không ở trạng thái đang học. Hãy chọn lớp khác.',409);
    };
  }

  return {reviewer,courseClass,classRead,assignmentRead,options,deliveryCheck};
}
