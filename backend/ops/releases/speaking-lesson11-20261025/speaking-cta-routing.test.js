import assert from 'node:assert/strict';
import test from 'node:test';
import { speakingCopyUrl, planSpeakingCopyCta, verifySpeakingCopyCta } from '../src/speaking-classroom-copies.js';

// Nhận cấu hình các bài, kỳ vọng URL độc lập với hàm đang kiểm.
// Bảo vệ việc mở đúng lesson, giữ Doc/lớp/mã và không chấp nhận link Lesson 3 sai.
// Khi lỗi, node:test chỉ rõ mã bài và đường dẫn thực tế khác kỳ vọng.
const cases = [
  ['67-speaking-paraphrase', ''],
  ['67-speaking-lam_ro', 'lesson-3.html'],
  ['67-speaking-diem_giua', 'lesson-4.html'],
  ['67-speaking-on_tap_lam_ro_diem_giua', 'lesson-5.html'],
  ['67-speaking-ly_do_hanh_vi', 'lesson-6.html'],
  ['67-speaking-cach_lam_mot_viec', 'lesson-7.html'],
  ['67-speaking-so_sanh', 'lesson-8.html'],
  ['67-speaking-freestyle_on_tap', 'lesson-9.html'],
  ['67-speaking-ke_chuyen_boi_canh_truoc_trong_sau', 'lesson-10.html'],
  ['67-speaking-ke_chuyen_dien_bien_chi_tiet', 'lesson-11.html']
];
const documentId = 'fixture doc 8 + unicode';
const classCode = 'IC2304';
function document(url) {
  return { documentId, revisionId: 'revision-1', tabs: [{
    tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [{
      paragraph: { elements: [{ startIndex: 70, endIndex: 104, textRun: {
        content: 'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP SPEAKING', textStyle: {
          link: { url }, underline: false,
          foregroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } }
        }
      } }] }
    }] } }
  }] };
}
for (const [assignmentCode, page] of cases) {
  test(`CTA ${assignmentCode} mở đúng ${page || 'trang paraphrase'}`, () => {
    const input = { documentId, classCode, assignmentCode };
    const expected = new URL(`https://tranhoangduc90.github.io/izone-ai-team-pages/speaking-homework/${page}`);
    expected.searchParams.set('documentId', documentId);
    expected.searchParams.set('class', classCode);
    expected.searchParams.set('assignmentCode', assignmentCode);
    assert.equal(speakingCopyUrl(input), expected.href);
    const current = planSpeakingCopyCta({ ...input, document: document(expected.href) });
    assert.equal(current.status, 'already_current');
    assert.deepEqual(current.requests, []);
    assert.equal(verifySpeakingCopyCta({ ...input, document: document(expected.href) }), true);
    if (page && page !== 'lesson-3.html') {
      const wrong = new URL(expected);
      wrong.pathname = '/izone-ai-team-pages/speaking-homework/lesson-3.html';
      const plan = planSpeakingCopyCta({ ...input, document: document(wrong.href) });
      assert.equal(plan.status, 'write');
      assert.equal(plan.url, expected.href);
      assert.equal(plan.revisionId, 'revision-1');
      assert.equal(plan.requests[0].updateTextStyle.textStyle.link.url, expected.href);
      assert.equal(verifySpeakingCopyCta({ ...input, document: document(wrong.href) }), false);
    }
  });
}
