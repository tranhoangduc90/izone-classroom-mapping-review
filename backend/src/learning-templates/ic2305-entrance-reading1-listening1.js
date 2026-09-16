/*
 * Dữ liệu nhận vào: không nhận dữ liệu học viên; đây là nội dung chuyên môn bất biến của mẫu v1.
 * Xử lý: tách phần học viên được xem khỏi đáp án chấm riêng tư, giữ itemFamilyId ổn định qua các lần gán lớp.
 * Kết quả: FormDefinitionV1 và FormGradingKeyV1 dùng chung cho IC2305 hoặc lớp khác sau khi được duyệt.
 * Khi lỗi: schema/test chặn phát hành; không tạo assignment dở dang và không đưa đáp án vào Pages.
 */

import { parseFormDefinition, parseFormGradingKey } from '../learning-contracts.js';

export const IC2305_ENTRANCE_TEMPLATE = Object.freeze({
  code: 'k56.entrance.reading1-listening1.v1',
  templateId: '56000000-0000-4000-8000-000000000001',
  formVersionId: '56000000-0000-4000-8000-000000000002',
  courseCode: '56',
  title: 'ENTRANCE TICKET • READING 1 & LISTENING 1',
  expectedMinutes: 5
});

const ids = Object.freeze({
  blocks: [
    '56000000-0000-4000-8000-000000000011',
    '56000000-0000-4000-8000-000000000012',
    '56000000-0000-4000-8000-000000000013'
  ],
  families: Array.from({ length: 8 }, (_, index) =>
    `56000000-0000-4000-8100-${String(index + 1).padStart(12, '0')}`),
  versions: Array.from({ length: 8 }, (_, index) =>
    `56000000-0000-4000-8200-${String(index + 1).padStart(12, '0')}`)
});

function baseItem(number, overrides) {
  return {
    itemFamilyId: ids.families[number - 1],
    itemVersionId: ids.versions[number - 1],
    position: number,
    prompt: `Câu ${number}`,
    helpText: '',
    interactionType: 'short_text',
    pedagogicalTypeCode: 'reflection',
    layoutType: 'plain_prompt',
    graderType: 'none',
    groupId: null,
    required: true,
    maxScore: 0,
    options: [],
    interactionConfig: {},
    skillCodes: [],
    evidenceSource: 'student_self_report',
    releasePolicy: 'inherit',
    ...overrides
  };
}

export function buildIc2305EntranceDefinition() {
  return parseFormDefinition({
    schemaVersion: 'FormDefinitionV1',
    formVersionId: IC2305_ENTRANCE_TEMPLATE.formVersionId,
    courseCode: IC2305_ENTRANCE_TEMPLATE.courseCode,
    title: IC2305_ENTRANCE_TEMPLATE.title,
    kind: 'mixed',
    estimatedMinutes: IC2305_ENTRANCE_TEMPLATE.expectedMinutes,
    answerReleasePolicy: 'hidden',
    blocks: [
      {
        blockId: ids.blocks[0],
        checkpoint: 1,
        title: 'Nhìn lại bài học trước',
        instructions: 'Trả lời ngắn gọn theo trải nghiệm thật của em.',
        items: [
          baseItem(1, {
            prompt: 'Trong phần bài tập về nhà của bài trước, bài, câu hoặc dạng bài nào khiến em gặp khó khăn nhất? Theo em, điều gì khiến phần đó khó với em?',
            interactionType: 'long_text',
            skillCodes: ['listening', 'reading']
          }),
          baseItem(2, {
            prompt: 'Em thấy nội dung nào trong buổi học trước hữu ích nhất đối với việc học hoặc làm bài của mình? Hãy nêu rõ kiến thức đó là gì.',
            interactionType: 'long_text',
            skillCodes: ['listening', 'reading']
          })
        ]
      },
      {
        blockId: ids.blocks[1],
        checkpoint: 2,
        title: 'IELTS Listening · Nghe số và chữ',
        instructions: 'Chọn phương án đúng nhất và ghi lại điều em nhớ.',
        items: [
          baseItem(3, {
            prompt: 'Khi làm bài Listening Part 1 và nghe đọc tên riêng, chiến thuật nào sau đây là ĐÚNG nhất?',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'listening_strategy',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [
              { id: 'A', label: 'Phải viết hoa toàn bộ các chữ cái hoặc bắt buộc viết hoa chữ cái đầu tiên.' },
              { id: 'B', label: 'Đợi audio đọc xong từ đó, bắt đầu đánh vần từng chữ cái rồi mới viết.' },
              { id: 'C', label: 'Viết ngay phác thảo từ đó ra nháp ngay khi nghe tên riêng được nhắc đến, không đợi đến lúc đánh vần.' }
            ],
            skillCodes: ['listening']
          }),
          baseItem(4, {
            prompt: 'Mục tiêu để đạt 6.0 Listening là làm đúng bao nhiêu câu?',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'listening_band_target',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [
              { id: 'A', label: '20–22' },
              { id: 'B', label: '23–26' },
              { id: 'C', label: '30–32' }
            ],
            skillCodes: ['listening']
          }),
          baseItem(5, {
            prompt: 'Phát âm 15 và 50 khác nhau ở 2 điểm nào?',
            pedagogicalTypeCode: 'listening_number_discrimination',
            layoutType: 'numbered_short_texts',
            interactionConfig: {
              responseCount: 2,
              responseLabels: ['Điểm khác nhau thứ nhất', 'Điểm khác nhau thứ hai']
            },
            skillCodes: ['listening']
          })
        ]
      },
      {
        blockId: ids.blocks[2],
        checkpoint: 3,
        title: 'IELTS Reading · Scanning và ứng dụng',
        instructions: 'Hoàn thành ba câu cuối rồi nộp phiếu để xác nhận tham gia.',
        items: [
          baseItem(6, {
            prompt: 'Khi áp dụng kỹ năng Scanning (Đọc quét) để tìm thông tin, có 3 loại thông tin “bắt mắt” nhất mà chúng ta có thể dễ dàng định vị trên bài đọc. Đó là:',
            pedagogicalTypeCode: 'reading_scanning',
            layoutType: 'numbered_short_texts',
            interactionConfig: {
              responseCount: 3,
              responseLabels: ['Loại thông tin thứ nhất', 'Loại thông tin thứ hai', 'Loại thông tin thứ ba']
            },
            skillCodes: ['reading']
          }),
          baseItem(7, {
            prompt: 'Nhận định sau về dạng Sentence Completion là ĐÚNG hay SAI? “Khi tìm được từ trong bài đọc, người thi cần linh hoạt thay đổi từ loại (Word form) hoặc thì (Tense) của từ đó sao cho đúng ngữ pháp với câu hỏi.”',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'sentence_completion',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [
              { id: 'DUNG', label: 'ĐÚNG' },
              { id: 'SAI', label: 'SAI' }
            ],
            skillCodes: ['reading']
          }),
          baseItem(8, {
            prompt: 'Khi làm dạng True/False/Not Given, việc nhận diện các “Red flags” (dấu hiệu cảnh báo) ở Deciding Keywords rất quan trọng. Hãy kể tên 2 loại “Red flags” thường gặp.',
            pedagogicalTypeCode: 'true_false_not_given',
            layoutType: 'numbered_short_texts',
            interactionConfig: {
              responseCount: 2,
              responseLabels: ['Loại Red flag thứ nhất', 'Loại Red flag thứ hai']
            },
            skillCodes: ['reading']
          })
        ]
      }
    ]
  });
}

export function buildIc2305EntranceGradingKey() {
  return parseFormGradingKey({
    schemaVersion: 'FormGradingKeyV1',
    formVersionId: IC2305_ENTRANCE_TEMPLATE.formVersionId,
    graderVersion: 1,
    items: {
      [ids.versions[2]]: { graderType: 'exact_option', expectedOptionId: 'C' },
      [ids.versions[3]]: { graderType: 'exact_option', expectedOptionId: 'B' },
      [ids.versions[6]]: { graderType: 'exact_option', expectedOptionId: 'SAI' }
    },
    groups: {}
  });
}
