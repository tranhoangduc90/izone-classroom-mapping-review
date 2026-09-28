import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Đầu vào: server.js của image API live đã khóa hash.
// Việc chính: chỉ thêm import, khởi động và dừng worker Bác sĩ AI.
// Kết quả: giữ nguyên các module khác của image live; lỗi nếu revision/điểm chèn đổi.
const target = process.env.SPEAKING_DOCTOR_SERVER_TARGET || '/app/src/server.js';
const expected = '1004594667ef68a59b540fae37f18eef4ac159d00dc92c566253301e1a5b85f8';
let source = readFileSync(target, 'utf8');
const digest = createHash('sha256').update(source).digest('hex');
if (digest !== expected) throw new Error('SPEAKING_DOCTOR_SERVER_BASE_CHANGED');

function replaceOnce(before, after) {
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) throw new Error('SPEAKING_DOCTOR_SERVER_ANCHOR_CHANGED');
  source = source.replace(before, after);
}

replaceOnce(
  "import { startSpeakingGradeWorker } from './speaking-grade-worker.js';",
  "import { startSpeakingGradeWorker } from './speaking-grade-worker.js';\n"
  + "import { startSpeakingDoctorWorker } from './speaking-doctor-worker.js';",
);
replaceOnce(
  'const speakingGradeWorker = startSpeakingGradeWorker({\n'
  + '  pool: speakingHomeworkPool, enabled: config.speakingHomeworkEnabled\n});',
  'const speakingGradeWorker = startSpeakingGradeWorker({\n'
  + '  pool: speakingHomeworkPool, enabled: config.speakingHomeworkEnabled\n});\n'
  + 'const speakingDoctorWorker = startSpeakingDoctorWorker({\n'
  + '  pool: speakingHomeworkPool, enabled: config.speakingHomeworkEnabled\n});',
);
replaceOnce(
  '    await speakingGradeWorker.stop();',
  '    await speakingGradeWorker.stop();\n    await speakingDoctorWorker.stop();',
);
writeFileSync(target, source, 'utf8');
