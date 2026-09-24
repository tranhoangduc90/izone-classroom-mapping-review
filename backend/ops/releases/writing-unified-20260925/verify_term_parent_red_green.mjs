import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Dữ liệu vào: snapshot ứng viên cũ và ứng viên đã sửa, đều không chứa credential.
// Việc chính: chạy cùng phép thử HTTP/PGlite trên hai bản, đòi RED đúng lỗi và GREEN trọn bốn ca.
// Kết quả: verdict gọn, không in bài giả, payload chấm hay thông tin học viên.
// Khi lỗi: dừng khác 0; không chạm production hoặc sửa database thật.
const [oldPath, fixedPath] = process.argv.slice(2);
if (!oldPath || !fixedPath) throw new Error('OLD_AND_FIXED_CANDIDATE_PATHS_REQUIRED');
const testPath = fileURLToPath(new URL('./test_term_parent_http_contract.mjs', import.meta.url));
function run(candidatePath) {
  return spawnSync(process.execPath, [testPath, candidatePath], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024
  });
}
const old = run(oldPath);
assert.equal(old.error, undefined, 'TERM_PARENT_OLD_PROCESS_ERROR');
assert.notEqual(old.status, 0, 'TERM_PARENT_OLD_MUST_BE_RED');
assert.match(old.stderr,
  /TERM_PARENT_UNEXPECTED_NODE_REFERENCE:Chấm trực tiếp một Task/u);
const fixed = run(fixedPath);
assert.equal(fixed.error, undefined, 'TERM_PARENT_FIXED_PROCESS_ERROR');
assert.equal(fixed.status, 0, 'TERM_PARENT_FIXED_MUST_BE_GREEN');
const report = JSON.parse(fixed.stdout.trim());
assert.equal(report.toolOutcome, 'success');
assert.equal(report.productionWrites, 0);
assert.equal(report.cases.length, 4);
assert.equal(report.cases.every(item => item.jobsComplete === 2), true);
assert.equal(report.miniWritingPortalWrites, 0);
assert.deepEqual(report.schemaJobs, { k67: 2, k56: 6 });
console.log(JSON.stringify({ toolOutcome: 'success', old: 'RED', fixed: 'GREEN',
  cases: report.cases.length, completedJobs: 8,
  schemaJobs: report.schemaJobs,
  portalSyncCalls: report.portalSyncCalls,
  miniWritingPortalWrites: report.miniWritingPortalWrites,
  productionWrites: 0 }));
