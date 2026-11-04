// Gọi native registrar bằng credential riêng. Giá trị URL do cấu hình vận hành cung cấp.
export function createNativeBinder(targets,{fetcher=fetch}={}) {
  return async (state,{checkOnly=false}={})=>{
    const target=targets[state.product];
    const url=new URL(target.url);
    if(state.product==='listening-homework') url.searchParams.set('assignmentCode',state.assignmentCode);
    const auth=state.product.endsWith('-practice')
      ? {[`x-${state.product.split('-')[0]}-admin`]:target.key}
      : {authorization:'Bearer '+target.key};
    const response=await fetcher(url,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(checkOnly?12_000:22_000),
      headers:{'content-type':'application/json',...auth},
      body:JSON.stringify({schema_version:'course67_cta_registration_v2',course:67,
        doc_id:state.documentId,classroom_course_id:state.courseId,coursework_id:state.courseWorkId,
        submission_id:state.submissionId,student_id:state.googleUserId,class_name:state.classCode,
        ...(checkOnly?{check_only:true}:{})}),
    });
    if(!response.ok) throw new Error('NATIVE_REGISTRATION_UNAVAILABLE');
    const data=await response.json();
    if(data.status!==(checkOnly?'eligible':'verified')||data.documentId!==state.documentId||
        (data.assignmentCode||data.code)!==state.assignmentCode)
      throw new Error('NATIVE_REGISTRATION_UNVERIFIED');
    return data;
  };
}
