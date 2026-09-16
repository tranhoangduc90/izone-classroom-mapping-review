/*
 * Dữ liệu nhận vào: không nhận dữ liệu học viên; đây là nội dung chuyên môn bất biến của mẫu v1.
 * Xử lý: tách nội dung công khai khỏi hai đáp án trắc nghiệm riêng tư.
 * Kết quả: FormDefinitionV1 và FormGradingKeyV1 cho Entrance Ticket Writing 1 của khóa 56.
 * Khi lỗi: schema/test chặn phát hành và không tạo assignment dở dang.
 */

import { parseFormDefinition, parseFormGradingKey } from '../learning-contracts.js';

export const IC2305_WRITING1_TEMPLATE = Object.freeze({
  code: 'k56.entrance.writing1.v1',
  templateId: '56000000-0000-4000-8000-000000000003',
  formVersionId: '56000000-0000-4000-8000-000000000004',
  courseCode: '56',
  title: 'ENTRANCE TICKET • WRITING 1',
  expectedMinutes: 5
});

const ids = Object.freeze({
  blocks: [
    '56000000-0000-4000-8000-000000000021',
    '56000000-0000-4000-8000-000000000022',
    '56000000-0000-4000-8000-000000000023'
  ],
  families: Array.from({ length: 6 }, (_, index) =>
    `56000000-0000-4000-8300-${String(index + 1).padStart(12, '0')}`),
  versions: Array.from({ length: 6 }, (_, index) =>
    `56000000-0000-4000-8400-${String(index + 1).padStart(12, '0')}`)
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

export function buildIc2305Writing1Definition() {
  return parseFormDefinition({
    schemaVersion: 'FormDefinitionV1',
    formVersionId: IC2305_WRITING1_TEMPLATE.formVersionId,
    courseCode: IC2305_WRITING1_TEMPLATE.courseCode,
    title: IC2305_WRITING1_TEMPLATE.title,
    kind: 'mixed',
    estimatedMinutes: IC2305_WRITING1_TEMPLATE.expectedMinutes,
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
            skillCodes: ['writing']
          }),
          baseItem(2, {
            prompt: 'Em thấy nội dung nào trong buổi học trước hữu ích nhất đối với việc học hoặc làm bài của mình? Hãy nêu rõ kiến thức đó là gì.',
            interactionType: 'long_text',
            skillCodes: ['writing']
          })
        ]
      },
      {
        blockId: ids.blocks[1],
        checkpoint: 2,
        title: 'Kiến thức tổng quan Writing Task 2',
        instructions: 'Chọn hoặc điền đủ nội dung theo bài học.',
        items: [
          baseItem(3, {
            prompt: 'Đâu là thời gian và số lượng từ tối thiểu được yêu cầu để hoàn thành một bài Writing Task 2?',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'writing_task2_overview',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [
              { id: 'A', label: '20 phút – 150 từ' },
              { id: 'B', label: '40 phút – 250 từ' },
              { id: 'C', label: '40 phút – 150 từ' }
            ],
            skillCodes: ['writing']
          }),
          baseItem(4, {
            prompt: 'Hãy điền các từ khóa chính để hoàn thiện phần giải thích 4 tiêu chí chấm điểm của bài thi Writing Task 2.',
            pedagogicalTypeCode: 'writing_task2_band_descriptors',
            layoutType: 'numbered_short_texts',
            interactionConfig: {
              responseCount: 8,
              responseLabels: [
                'Task Response · trả lời đúng ...',
                'Task Response · và ...',
                'Coherence · liên kết về ...',
                'Cohesion · liên kết về ...',
                'Lexical Resource · tính ...',
                'Lexical Resource · và ...',
                'Grammar · tính ...',
                'Grammar · và ...'
              ]
            },
            skillCodes: ['writing']
          }),
          baseItem(5, {
            prompt: 'Theo nguyên tắc chung khi lập luận, nhận định sau là ĐÚNG hay SAI? “Có những lập luận là nghiễm nhiên đúng nên người viết không cần phải làm rõ hay chứng minh thêm.”',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'writing_argument_development',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [
              { id: 'DUNG', label: 'Đúng' },
              { id: 'SAI', label: 'Sai' }
            ],
            skillCodes: ['writing']
          })
        ]
      },
      {
        blockId: ids.blocks[2],
        checkpoint: 3,
        title: 'Cách phát triển ý',
        instructions: 'Hoàn thành câu cuối rồi nộp phiếu để xác nhận tham gia.',
        items: [
          baseItem(6, {
            prompt: 'Dựa vào bài học, hãy nêu 2 cách cơ bản để làm rõ và chứng minh cho một lập luận.',
            pedagogicalTypeCode: 'writing_idea_development',
            layoutType: 'numbered_short_texts',
            interactionConfig: {
              responseCount: 2,
              responseLabels: ['Cách thứ nhất', 'Cách thứ hai']
            },
            skillCodes: ['writing']
          })
        ]
      }
    ]
  });
}

export function buildIc2305Writing1GradingKey() {
  return parseFormGradingKey({
    schemaVersion: 'FormGradingKeyV1',
    formVersionId: IC2305_WRITING1_TEMPLATE.formVersionId,
    graderVersion: 1,
    items: {
      [ids.versions[2]]: { graderType: 'exact_option', expectedOptionId: 'B' },
      [ids.versions[4]]: { graderType: 'exact_option', expectedOptionId: 'SAI' }
    },
    groups: {}
  });
}
