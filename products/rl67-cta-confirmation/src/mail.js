import {randomUUID} from 'node:crypto';

const email=/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/;
const reasons={
  CLASS_MISMATCH:'Lớp không còn khớp.',
  OWNER_UNRESOLVED:'Chưa xác định được chủ bài Classroom.',
  MAPPING_CONFLICT:'Thông tin định danh mâu thuẫn.',
  BINDING_UNAVAILABLE:'Chưa nối được bản Homework sau khi xác nhận.',
};
export function createMailSender({from,to,accessToken,fetcher=fetch}) {
  if(!email.test(from||'')||!email.test(to||'')) throw new Error('INVALID_NOTICE_MAILBOX');
  return async row=>{
    const title=Buffer.from('[IZONE] Cần kiểm tra xác nhận học viên '+row.class_code).toString('base64');
    const body=Buffer.from(['Mã ca: '+row.id,'Sản phẩm: '+row.product,'Lớp: '+row.class_code,
      'Mã bài: '+row.assignment_code,'Lý do: '+reasons[row.reason],
      'Tra nhật ký theo mã ca để đối chiếu nguồn.'].join('\r\n')).toString('base64').match(/.{1,76}/g).join('\r\n');
    const raw=Buffer.from([`From: ${from}`,`To: ${to}`,`Subject: =?UTF-8?B?${title}?=`,'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',body].join('\r\n')).toString('base64url');
    const response=await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{authorization:'Bearer '+await accessToken(),'content-type':'application/json'},
      body:JSON.stringify({raw}),
    });
    if(!response.ok) throw new Error('MAIL_HTTP_'+response.status);
    const {id}=await response.json();
    if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('MAIL_ACK_MISSING');
    return id;
  };
}

export async function deliverNotice(pool,send) {
  const lease=randomUUID();
  const {rows:[row]}=await pool.query(`WITH next AS (
    SELECT id FROM rl67_cta_confirmation.notice WHERE sent_at IS NULL AND attempts<8
      AND available_at<=now() AND (lease_until IS NULL OR lease_until<now())
    ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE rl67_cta_confirmation.notice n
    SET lease_id=$1,lease_until=now()+interval '2 minutes',attempts=attempts+1
    FROM next WHERE n.id=next.id RETURNING n.*`,[lease]);
  if(!row) return false;
  let messageId;
  try { messageId=await send(row); }
  catch(error) {
    const code=/^MAIL_(HTTP_\d{3}|ACK_MISSING)$/.test(error.message)?error.message:'MAIL_UNAVAILABLE';
    await pool.query(`UPDATE rl67_cta_confirmation.notice SET lease_id=NULL,lease_until=NULL,last_error=$3,
      available_at=now()+($4::integer*interval '1 second') WHERE id=$1 AND lease_id=$2`,
    [row.id,lease,code,Math.min(300,5*2**row.attempts)]);
    return true;
  }
  await pool.query(`UPDATE rl67_cta_confirmation.notice SET sent_at=now(),message_id=$3,
    lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_id=$2`,[row.id,lease,messageId]);
  return true;
}
