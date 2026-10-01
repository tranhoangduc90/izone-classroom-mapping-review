import assert from 'node:assert/strict';
import test from 'node:test';
import { createLearningErpScheduleReader } from '../src/learning-erp-schedule.js';

const columns = ['class_session_id', 'course_class_id', 'starts_at', 'ends_at', 'status']
  .map(name => ({ name }));

test('đọc đúng dòng lịch ERP của một lớp, giữ ID và ngày giờ địa phương', async () => {
  const requests = [];
  const reader = createLearningErpScheduleReader({
    url: 'https://metabase.example.test', username: 'schedule-reader',
    password: 'private-test-value', fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        json: async () => requests.length === 1 ? { id: 'private-session' } : {
          data: { cols: columns, rows: [
            [35811, 1294, '2026-09-14 18:30:00', '2026-09-14 21:00:00', 1],
            [35812, 1294, '2026-09-17 18:30:00', '2026-09-17 21:00:00', 0]
          ] }
        }
      };
    }
  });
  const result = await reader('1294');
  assert.deepEqual(result.sessions.map(({ erpSessionId, date }) => ({ erpSessionId, date })), [
    { erpSessionId: '35811', date: '2026-09-14' },
    { erpSessionId: '35812', date: '2026-09-17' }
  ]);
  assert.equal(requests.length, 2);
  assert.match(requests[1].options.body, /course_class_id = 1294/);
  assert.doesNotMatch(requests[1].options.body, /private-test-value/);
  await assert.rejects(() => reader('1294 OR 1=1'), /ERP_SCHEDULE_CLASS_INVALID/);
});

test('dòng lịch khác lớp hoặc phản hồi bị cắt không được dùng để xác nhận', async () => {
  const reader = createLearningErpScheduleReader({
    url: 'https://metabase.example.test', username: 'schedule-reader',
    password: 'private-test-value', fetchImpl: async (url) => ({
      ok: true,
      json: async () => String(url).endsWith('/api/session') ? { id: 'private-session' } : {
        data: { cols: columns, rows: [[35811, 9999,
          '2026-09-14 18:30:00', '2026-09-14 21:00:00', 1]] }
      }
    })
  });
  await assert.rejects(() => reader('1294'), /ERP_SCHEDULE_ROW_INVALID/);
});

test('E02/E06: cùng lớp đang đọc được gộp, refresh đọc mới; lỗi/deadline giải phóng lượt đang chờ',async()=>{
  let calls=0,fail=false;
  const reader=createLearningErpScheduleReader({url:'https://metabase.example.test',username:'reader',password:'fixture',timeoutMs:2000,
    fetchImpl:async(url,{signal})=>{
      calls++;await new Promise(resolve=>setTimeout(resolve,15));
      if(fail)throw new Error('UPSTREAM_FIXTURE');
      assert.ok(signal instanceof AbortSignal);
      return {ok:true,json:async()=>String(url).endsWith('/api/session')?{id:'fixture'}:{data:{cols:columns,rows:[[1,1294,'2026-09-14 18:30:00','2026-09-14 21:00:00',0]]}}};
    }});
  const both=await Promise.all([reader('1294'),reader('1294')]);assert.equal(calls,2);assert.deepEqual(both[0],both[1]);
  await reader('1294');assert.equal(calls,4);
  fail=true;await assert.rejects(()=>reader('1294'),/UPSTREAM_FIXTURE/);fail=false;await reader('1294');assert.equal(calls,7);
  const hanging=createLearningErpScheduleReader({url:'https://metabase.example.test',username:'reader',password:'fixture',timeoutMs:2000,
    fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  // Giữ event loop tới deadline thật; AbortSignal.timeout tự unref timer.
  const keep=setTimeout(()=>{},3000);try{await assert.rejects(()=>hanging('1294'),e=>e.name==='TimeoutError');}finally{clearTimeout(keep);}
});

test('E04: ngày/giờ sai và lịch bị cắt quá 200 dòng bị từ chối',async()=>{
  for(const row of [[1,1294,'2026-02-30 18:30:00','2026-02-30 21:00:00',0],
    [1,1294,'2026-09-14 24:00:00','2026-09-15 25:00:00',0],[1,1294,'2026-09-14 18:30:00','2026-09-14 18:00:00',0]]){
    const reader=createLearningErpScheduleReader({url:'https://metabase.example.test',username:'reader',password:'fixture',
      fetchImpl:async url=>({ok:true,json:async()=>String(url).endsWith('/api/session')?{id:'fixture'}:{data:{cols:columns,rows:[row]}}})});
    await assert.rejects(()=>reader('1294'),/ERP_SCHEDULE_ROW_INVALID/);
  }
  const capped=createLearningErpScheduleReader({url:'https://metabase.example.test',username:'reader',password:'fixture',
    fetchImpl:async url=>({ok:true,json:async()=>String(url).endsWith('/api/session')?{id:'fixture'}:{data:{cols:columns,
      rows:Array.from({length:201},(_,index)=>[index+1,1294,'2026-09-14 18:30:00','2026-09-14 21:00:00',0])}}})});
  await assert.rejects(()=>capped('1294'),/ERP_SCHEDULE_RESPONSE_INVALID/);
});
