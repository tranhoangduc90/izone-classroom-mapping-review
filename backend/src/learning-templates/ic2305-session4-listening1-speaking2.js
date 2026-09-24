/*
 * Dữ liệu nhận vào: nội dung Buổi 4 do giảng viên cung cấp, không có dữ liệu học viên.
 * Việc chính: dựng hai phần của phiếu; giữ đáp án tô vàng trong khóa riêng phía máy chủ.
 * Kết quả: definition công khai và grading key riêng cho IC2305, khóa 56.
 * Khi lỗi: kiểm schema/test dừng trước khi tạo assignment.
 */
import { parseFormDefinition, parseFormGradingKey } from '../learning-contracts.js';

export const IC2305_SESSION4_TEMPLATE = Object.freeze({
  code: 'k56.progress.listening1-speaking2.session4.v1',
  templateId: '56000000-0000-4000-8000-000000000007',
  formVersionId: '56000000-0000-4000-8000-000000000008',
  courseCode: '56',
  title: 'Buổi 4 - Listening 1 + Speaking 2'
});

const ids = Object.freeze({
  blocks: ['56000000-0000-4000-8000-000000000041', '56000000-0000-4000-8000-000000000042'],
  families: Array.from({ length: 8 }, (_, index) =>
    `56000000-0000-4000-8700-${String(index + 1).padStart(12, '0')}`),
  versions: Array.from({ length: 8 }, (_, index) =>
    `56000000-0000-4000-8800-${String(index + 1).padStart(12, '0')}`)
});

function item(number, overrides) {
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

export function buildIc2305Session4Definition() {
  return parseFormDefinition({
    schemaVersion: 'FormDefinitionV1',
    formVersionId: IC2305_SESSION4_TEMPLATE.formVersionId,
    courseCode: IC2305_SESSION4_TEMPLATE.courseCode,
    title: IC2305_SESSION4_TEMPLATE.title,
    kind: 'mixed',
    answerReleasePolicy: 'hidden',
    blocks: [
      {
        blockId: ids.blocks[0],
        checkpoint: 1,
        title: 'Phần 1: Nhìn lại bài học trước',
        instructions: 'Ghi lại điều hữu ích và hoàn thiện các bước Listening Part 1.',
        items: [
          item(1, {
            displayNumber: '1',
            prompt: 'Em thấy nội dung nào trong buổi học trước hữu ích nhất đối với việc học hoặc làm bài của mình? Hãy nêu rõ kiến thức đó là gì.',
            interactionType: 'long_text',
            skillCodes: ['reflection']
          }),
          item(2, {
            displayNumber: '2',
            prompt: 'Các bước làm bài điền từ trong Listening Part 1:',
            pedagogicalTypeCode: 'listening_part1_steps',
            layoutType: 'numbered_short_texts',
            interactionConfig: {
              responseCount: 3,
              responseLabels: ['Bước 1: số lượng cần điền', 'Bước 2: loại cần điền', 'Bước 3: thông tin trong câu hỏi'],
              sentenceLines: [
                { title: 'Bước 1:', parts: ['Xác định ', ' cần điền'] },
                { title: 'Bước 2:', parts: ['Dự đoán ', ' cần điền'] },
                { title: 'Bước 3:', parts: ['Xác định các ', ' trong câu hỏi'] },
                { title: 'Bước 4:', parts: ['Nghe và điền đáp án'] }
              ]
            },
            skillCodes: ['listening']
          })
        ]
      },
      {
        blockId: ids.blocks[1],
        checkpoint: 2,
        title: 'Phần 2: Buổi học hôm nay',
        instructions: 'Hoàn thành phần Reading và tự nhìn lại buổi luyện Speaking.',
        items: [
          item(3, {
            displayNumber: '1',
            prompt: 'Khi áp dụng kỹ năng Scanning (Đọc quét) để tìm thông tin, có 3 loại thông tin "bắt mắt" nhất mà chúng ta có thể dễ dàng định vị trên bài đọc. Đó là:',
            pedagogicalTypeCode: 'reading_scanning_cues',
            layoutType: 'numbered_short_texts',
            interactionConfig: {
              responseCount: 3,
              responseLabels: ['Loại thông tin thứ nhất', 'Loại thông tin thứ hai', 'Loại thông tin thứ ba']
            },
            skillCodes: ['reading']
          }),
          item(4, {
            displayNumber: '2',
            prompt: 'Xác định nhận định sau đây về dạng bài Sentence Completion (Điền từ vào câu) là ĐÚNG hay SAI? "Khi tìm được từ trong bài đọc, người thi cần phải linh hoạt thay đổi từ loại (Word form) hoặc thì (Tense) của từ đó sao cho đúng ngữ pháp với câu hỏi."',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'reading_sentence_completion_rule',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [{ id: 'TRUE', label: 'ĐÚNG' }, { id: 'FALSE', label: 'SAI' }],
            skillCodes: ['reading']
          }),
          item(5, {
            displayNumber: '3',
            prompt: 'Số câu em làm đúng trong bài luyện tập hôm nay là: Sentence Completion',
            interactionType: 'number_score',
            pedagogicalTypeCode: 'reading_practice_score',
            layoutType: 'score_fraction',
            interactionConfig: { min: 0, max: 6, step: 1, unit: 'câu' },
            skillCodes: ['reading']
          }),
          item(6, {
            displayNumber: '3',
            prompt: 'Số câu em làm đúng trong bài luyện tập hôm nay là: T/F/NG',
            interactionType: 'number_score',
            pedagogicalTypeCode: 'reading_practice_score',
            layoutType: 'score_fraction',
            interactionConfig: { min: 0, max: 7, step: 1, unit: 'câu' },
            skillCodes: ['reading']
          }),
          item(7, {
            displayNumber: '4',
            prompt: 'Em nhận thấy, hoặc partner speaking của em nhận xét, mình đang gặp vấn đề gì lớn nhất trong buổi luyện tập speaking hôm nay?',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'speaking_self_assessment',
            layoutType: 'choice_cards',
            options: [
              { id: 'IDEAS', label: 'Khó phát triển ý và nói đủ dài' },
              { id: 'VOCABULARY', label: 'Thiếu từ vựng để diễn đạt ý' },
              { id: 'FLUENCY', label: 'Nói ngắt quãng hoặc dừng quá lâu' },
              { id: 'PRONUNCIATION', label: 'Phát âm chưa rõ hoặc sai trọng âm' },
              { id: 'GRAMMAR', label: 'Dùng ngữ pháp chưa chính xác' },
              { id: 'COHERENCE', label: 'Câu trả lời chưa liên kết, thiếu mạch lạc' },
              { id: 'NO_MAJOR_ISSUE', label: 'Em chưa nhận thấy vấn đề lớn' },
              { id: 'OTHER', label: 'Vấn đề khác' }
            ],
            skillCodes: ['speaking']
          }),
          item(8, {
            prompt: 'Vấn đề khác. Nêu rõ',
            pedagogicalTypeCode: 'speaking_self_assessment',
            layoutType: 'conditional_other_text',
            required: false,
            interactionConfig: {
              visibleWhenItemVersionId: ids.versions[6],
              visibleWhenValue: 'OTHER',
              requiredWhenVisible: true
            },
            skillCodes: ['speaking']
          })
        ]
      }
    ]
  });
}

export function buildIc2305Session4GradingKey() {
  return parseFormGradingKey({
    schemaVersion: 'FormGradingKeyV1',
    formVersionId: IC2305_SESSION4_TEMPLATE.formVersionId,
    graderVersion: 1,
    items: { [ids.versions[3]]: { graderType: 'exact_option', expectedOptionId: 'FALSE' } },
    groups: {},
    referenceAnswers: {
      [ids.versions[1]]: ['số lượng từ', 'loại từ/số hoặc chữ', 'keywords/từ khóa'],
      [ids.versions[2]]: ['số', 'tên riêng', 'từ chuyên ngành/thuật ngữ/terminology']
    }
  });
}
