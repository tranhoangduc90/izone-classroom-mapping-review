/*
 * Dữ liệu nhận vào: không nhận dữ liệu học viên; đây là nội dung chuyên môn bất biến của mẫu v1.
 * Xử lý: mô tả ba checkpoint buổi 3 và tách ba đáp án khách quan khỏi definition công khai.
 * Kết quả: FormDefinitionV1 và FormGradingKeyV1 cho Listening 1 + Speaking 2 của khóa 56.
 * Khi lỗi: schema/test chặn phát hành và không tạo assignment dở dang.
 */

import { parseFormDefinition, parseFormGradingKey } from '../learning-contracts.js';

export const IC2305_SESSION3_TEMPLATE = Object.freeze({
  code: 'k56.entrance.listening1-speaking2.v1',
  templateId: '56000000-0000-4000-8000-000000000005',
  formVersionId: '56000000-0000-4000-8000-000000000006',
  courseCode: '56',
  title: 'ENTRANCE TICKET • LISTENING 1 + SPEAKING 2'
});

const ids = Object.freeze({
  blocks: [
    '56000000-0000-4000-8000-000000000031',
    '56000000-0000-4000-8000-000000000032',
    '56000000-0000-4000-8000-000000000033'
  ],
  families: Array.from({ length: 9 }, (_, index) =>
    `56000000-0000-4000-8500-${String(index + 1).padStart(12, '0')}`),
  versions: Array.from({ length: 9 }, (_, index) =>
    `56000000-0000-4000-8600-${String(index + 1).padStart(12, '0')}`)
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

export function buildIc2305Session3Definition() {
  return parseFormDefinition({
    schemaVersion: 'FormDefinitionV1',
    formVersionId: IC2305_SESSION3_TEMPLATE.formVersionId,
    courseCode: IC2305_SESSION3_TEMPLATE.courseCode,
    title: IC2305_SESSION3_TEMPLATE.title,
    kind: 'mixed',
    answerReleasePolicy: 'hidden',
    blocks: [
      {
        blockId: ids.blocks[0],
        checkpoint: 1,
        title: 'Nhìn lại bài học trước',
        instructions: 'Hoàn thành hai câu ôn tập Writing trước khi tiếp tục.',
        items: [
          baseItem(1, {
            displayNumber: '1',
            prompt: 'Trong IELTS Writing Task 2, loại ví dụ nào sau đây là những điều chúng ta KHÔNG nên làm để tránh làm giảm tính thuyết phục của bài viết?',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'writing_example_selection',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [
              { id: 'A', label: 'Lấy ví dụ về các quốc gia cụ thể và lấy ví dụ về các tập đoàn lớn.' },
              { id: 'B', label: 'Lấy ví dụ mang tính cá nhân (bản thân, người quen) và lấy kết quả/số liệu từ một nghiên cứu cụ thể.' },
              { id: 'C', label: 'Lấy ví dụ về người nổi tiếng và lấy ví dụ về các kiến thức phổ thông.' }
            ],
            skillCodes: ['writing']
          }),
          baseItem(2, {
            displayNumber: '2',
            prompt: 'Để tránh lỗi nhảy cóc, hãy hoàn thiện thông tin còn thiếu trong lập luận sau:',
            pedagogicalTypeCode: 'writing_argument_development',
            layoutType: 'reasoning_chain_completion',
            interactionConfig: {
              beforeText: 'Các công ty xây dựng phòng gym ngay tại trụ sở làm việc',
              afterText: 'Nhân viên cải thiện sức khỏe thể chất'
            },
            skillCodes: ['writing']
          })
        ]
      },
      {
        blockId: ids.blocks[1],
        checkpoint: 2,
        title: 'Buổi học hôm nay · Speaking',
        instructions: 'Chọn vấn đề nổi bật nhất và ghi lại nhận xét em nhận được nếu có.',
        items: [
          baseItem(3, {
            displayNumber: '1',
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
          baseItem(4, {
            prompt: 'Nêu rõ vấn đề khác.',
            pedagogicalTypeCode: 'speaking_self_assessment',
            layoutType: 'conditional_other_text',
            required: false,
            interactionConfig: {
              visibleWhenItemVersionId: ids.versions[2],
              visibleWhenValue: 'OTHER',
              requiredWhenVisible: true
            },
            skillCodes: ['speaking']
          }),
          baseItem(5, {
            displayNumber: '2',
            prompt: 'Giáo viên nhận xét gì cho em ở buổi speaking hôm nay?',
            interactionType: 'long_text',
            pedagogicalTypeCode: 'speaking_teacher_feedback_recall',
            required: false,
            evidenceSource: 'student_reported_teacher_feedback',
            skillCodes: ['speaking']
          })
        ]
      },
      {
        blockId: ids.blocks[2],
        checkpoint: 3,
        title: 'Buổi học hôm nay · Listening',
        instructions: 'Hoàn thành phần Listening rồi nộp phiếu để xác nhận tham gia.',
        items: [
          baseItem(6, {
            displayNumber: '1',
            prompt: 'Khi làm bài Listening Part 1 và nghe đọc tên riêng, chiến thuật nào sau đây là ĐÚNG nhất?',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'listening_names_and_spelling',
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
          baseItem(7, {
            displayNumber: '2',
            prompt: 'Mục tiêu để đạt 6.0 Listening là làm đúng bao nhiêu câu?',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'listening_score_target',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [
              { id: 'A', label: '20-22' },
              { id: 'B', label: '23-26' },
              { id: 'C', label: '30-32' }
            ],
            skillCodes: ['listening']
          }),
          baseItem(8, {
            displayNumber: '3',
            prompt: 'Phát âm 15 và 50 khác nhau ở 2 điểm nào?',
            pedagogicalTypeCode: 'listening_number_pronunciation',
            layoutType: 'numbered_short_texts',
            interactionConfig: {
              responseCount: 2,
              responseLabels: ['Điểm khác nhau thứ nhất', 'Điểm khác nhau thứ hai']
            },
            skillCodes: ['listening']
          }),
          baseItem(9, {
            displayNumber: '4',
            prompt: 'Số câu em làm đúng trong bài luyện tập hôm nay là:',
            interactionType: 'number_score',
            pedagogicalTypeCode: 'listening_practice_score',
            layoutType: 'score_fraction',
            interactionConfig: { min: 0, max: 6, step: 1, unit: 'câu' },
            skillCodes: ['listening']
          })
        ]
      }
    ]
  });
}

export function buildIc2305Session3GradingKey() {
  return parseFormGradingKey({
    schemaVersion: 'FormGradingKeyV1',
    formVersionId: IC2305_SESSION3_TEMPLATE.formVersionId,
    graderVersion: 1,
    items: {
      [ids.versions[0]]: { graderType: 'exact_option', expectedOptionId: 'B' },
      [ids.versions[5]]: { graderType: 'exact_option', expectedOptionId: 'C' },
      [ids.versions[6]]: { graderType: 'exact_option', expectedOptionId: 'B' }
    },
    groups: {}
  });
}
