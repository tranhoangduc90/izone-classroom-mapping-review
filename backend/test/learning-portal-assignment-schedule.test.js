import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPortalAssignmentScheduleReader, assignmentPortalSchedule, portalAssignmentTargets } from '../src/learning-portal-assignment-schedule.js';

const tokenUrl = 'https://accounts.izone.edu.vn/realms/izone/protocol/openid-connect/token';
const scheduleUrl = id => `https://gateway.izone.edu.vn/portal/v1/course-classes/${id}/class-sessions`;
const firstToken = 'fixture.payload.signature';
const secondToken = 'new-fixture.payload.signature';
const credentials = { username: 'reader@example.test', password: 'fixture password&+', clientId: 'test-client' };

async function writeCredentials(t) {
  const directory = await mkdtemp(join(tmpdir(), 'progress-portal-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'credentials.json');
  await writeFile(file, JSON.stringify(credentials), { mode: 0o600 });
  return file;
}

function replyFor(classId) {
  return Response.json({ data: [{
    course_class_id: Number(classId), class_session_id: 45, status: '1',
    session_start_datetime: '2026-11-26T18:00:00', session_end_datetime: '2026-11-26T20:00:00'
  }] });
}

test('Portal schedule signs in once for concurrent classes and sends only the bearer token to the gateway', async t => {
  let signIns = 0;
  const requested = [];
  const reader = createPortalAssignmentScheduleReader({
    credentialsFile: await writeCredentials(t),
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      if (url === tokenUrl) {
        signIns += 1;
        assert.equal(options.method, 'POST');
        assert.deepEqual(Object.fromEntries(options.body), {
          grant_type: 'password', client_id: credentials.clientId,
          username: credentials.username, password: credentials.password
        });
        return Response.json({ access_token: firstToken, expires_in: 300 });
      }
      const classId = url === scheduleUrl('1001') ? '1001' : '1002';
      assert.equal(url, scheduleUrl(classId));
      assert.deepEqual(options.headers, { Accept: 'application/json', Authorization: `Bearer ${firstToken}` });
      assert.equal(options.body, undefined);
      requested.push(classId);
      return replyFor(classId);
    }
  });
  const [first, second] = await Promise.all([reader('1001'), reader('1002')]);
  assert.equal(signIns, 1);
  assert.deepEqual(requested.sort(), ['1001', '1002']);
  assert.equal(second.classId, '1002');
  assert.deepEqual(first, { classId: '1001', sessions: [{
    erpSessionId: '45', startsAt: '2026-11-26 18:00:00', endsAt: '2026-11-26 20:00:00',
    date: '2026-11-26', statusCode: 1
  }] });
});

test('a rejected sign-in pauses further sign-ins and sends no schedule requests', async t => {
  let signIns = 0;
  const log = [];
  const reader = createPortalAssignmentScheduleReader({
    credentialsFile: await writeCredentials(t),
    logger: { warn: line => log.push(JSON.parse(line)) },
    fetchImpl: async url => {
      assert.equal(url, tokenUrl);
      signIns += 1;
      return Response.json({ error: 'invalid_grant', error_description: credentials.password },
        { status: 400, headers: { 'cf-ray': 'test-ray' } });
    }
  });
  await assert.rejects(reader('1001'), { message: 'PORTAL_SCHEDULE_UNAVAILABLE' });
  await assert.rejects(reader('1002'), { message: 'PORTAL_SCHEDULE_UNAVAILABLE' });
  assert.equal(signIns, 1);
  assert.deepEqual(log, [{
    type: 'progress_log_read', operation: 'portal_schedule_token', status: 'failed',
    httpStatus: 400, requestId: 'test-ray', reason: 'invalid_grant'
  }]);
});

test('a gateway 401 drops the token for the next call and a wrong-class response is still rejected', async t => {
  const signInTokens = [firstToken, secondToken];
  const usedTokens = [];
  const reader = createPortalAssignmentScheduleReader({
    credentialsFile: await writeCredentials(t),
    fetchImpl: async (url, options) => {
      if (url === tokenUrl) return Response.json({ access_token: signInTokens.shift(), expires_in: 300 });
      usedTokens.push(options.headers.Authorization);
      if (usedTokens.length === 1) return new Response(null, { status: 401 });
      return replyFor('1003');
    }
  });
  await assert.rejects(reader('1001'), { message: 'PORTAL_SCHEDULE_UNAVAILABLE' });
  assert.deepEqual(usedTokens, [`Bearer ${firstToken}`]);
  await assert.rejects(reader('1001'), { message: 'PORTAL_SCHEDULE_CLASS_MISMATCH' });
  assert.deepEqual(usedTokens, [`Bearer ${firstToken}`, `Bearer ${secondToken}`]);
});

test('a reader without credentials sends no request', async () => {
  const reader = createPortalAssignmentScheduleReader({
    fetchImpl: async () => assert.fail('unexpected upstream request')
  });
  await assert.rejects(reader('1001'), { message: 'PORTAL_SCHEDULE_UNAVAILABLE' });
});

test('Portal-first only offers ordinals before an unknown status that could change the ordering',()=>{
  const slot=(id,date,statusCode)=>({erpSessionId:id,date,statusCode,startsAt:date+' 18:30:00',endsAt:date+' 21:00:00'});
  const raw={classId:'1001',sessions:[
    slot('201','2026-11-26',0),slot('202','2026-11-27',4),slot('203','2026-11-29',0)]};
  assert.deepEqual(portalAssignmentTargets(assignmentPortalSchedule('1001',raw)),[]);
  const newSchedule=assignmentPortalSchedule('1001',raw,{portalFirst:true});
  assert.equal(newSchedule.ambiguous,true);
  assert.deepEqual(portalAssignmentTargets(newSchedule).map(item=>[item.erpSessionId,item.erpSessionNumber]),[['201',1]]);
});
