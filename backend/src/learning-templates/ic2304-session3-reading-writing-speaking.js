/*
 * Dữ liệu nhận vào: hai đoạn Reading A–B theo chỉ dẫn của Đức và bảng Writing trong Handout Lesson 3,
 * cùng checklist Speaking đã phát hành cho IC2304 Buổi 2.
 * Việc chính: tạo phiếu Buổi 3; đáp án Reading được truyền riêng khi xuất bản.
 * Kết quả: định nghĩa công khai không có đáp án và khóa chấm chỉ ở backend.
 * Khi lỗi: schema hoặc bộ đáp án sai dừng trước khi ghi cơ sở dữ liệu.
 */
import { parseFormDefinition, parseFormGradingKey } from '../learning-contracts.js';
import { buildIc2304Session2SpeakingDefinition } from './ic2304-session2-speaking.js';

export const IC2304_SESSION3_TEMPLATE = Object.freeze({
  code: 'ic2304.session3.reading-writing-speaking.v1',
  templateId: '23040003-0000-4000-8000-000000000001',
  formVersionId: '23040003-0000-4000-8000-000000000002',
  courseCode: '67',
  title: 'Progress Log · IC2304 · Buổi 3'
});

const headings = [
  ['i', 'Getting the finance for production'],
  ['ii', 'An unexpected benefit'],
  ['iii', 'From initial inspiration to new product'],
  ['iv', 'The range of potential customers for the device'],
  ['v', 'What makes the device different from alternatives'],
  ['vi', 'Cleaning water from a range of sources'],
  ['vii', 'Overcoming production difficulties'],
  ['viii', 'Profit not the primary goal'],
  ['ix', 'A warm welcome for the device'],
  ['x', 'The number of people affected by water shortages']
];

const writingPrompts = [
  'Body 1 · Idea 1',
  'Body 1 · Idea 2',
  'Body 1 · Ý chung của đoạn (Topic sentence)',
  'Body 2 · Idea 1',
  'Body 2 · Idea 2',
  'Body 2 · Ý chung của đoạn (Topic sentence)',
  'Thesis statement của mở bài'
];

function itemId(segment, number) {
  return '23040003-0000-4000-' + segment + '-' + String(number).padStart(12, '0');
}

function baseItem(number, overrides) {
  return {
    itemFamilyId: itemId('8100', number),
    itemVersionId: itemId('8200', number),
    position: number,
    prompt: 'Câu ' + number,
    helpText: '',
    interactionType: 'long_text',
    pedagogicalTypeCode: 'writing_idea_development',
    layoutType: 'plain_prompt',
    graderType: 'none',
    groupId: null,
    required: true,
    maxScore: 0,
    options: [],
    interactionConfig: {},
    skillCodes: ['writing'],
    evidenceSource: 'student_self_report',
    releasePolicy: 'inherit',
    ...overrides
  };
}

export function buildIc2304Session3Definition() {
  const session2Speaking = buildIc2304Session2SpeakingDefinition().blocks[2];
  const previousChecklistId = session2Speaking.items[0].itemVersionId;
  const speakingItems = session2Speaking.items.map((item, index) => ({
    ...item,
    itemFamilyId: itemId('8100', index + 10),
    itemVersionId: itemId('8200', index + 10),
    position: index + 10,
    interactionConfig: {
      ...item.interactionConfig,
      ...(item.interactionConfig?.visibleWhenItemVersionId === previousChecklistId
        ? { visibleWhenItemVersionId: itemId('8200', 10) } : {})
    }
  }));
  return parseFormDefinition({
    schemaVersion: 'FormDefinitionV1',
    formVersionId: IC2304_SESSION3_TEMPLATE.formVersionId,
    title: IC2304_SESSION3_TEMPLATE.title,
    kind: 'mixed',
    answerReleasePolicy: 'immediate',
    blocks: [
      {
        blockId: itemId('8000', 11),
        checkpoint: 1,
        title: 'Reading · Matching Headings',
        instructions: 'Chọn một heading phù hợp cho mỗi đoạn A–B của bài The Desolenator: producing clean water.',
        items: ['A', 'B'].map((paragraph, index) => baseItem(index + 1, {
          displayNumber: paragraph,
          prompt: 'Đoạn ' + paragraph,
          interactionType: 'single_choice',
          pedagogicalTypeCode: 'reading_matching_headings',
          layoutType: 'matching_heading_dropdown',
          graderType: 'exact_option',
          maxScore: 1,
          options: headings.map(([id, label]) => ({ id, label })),
          skillCodes: ['reading']
        }))
      },
      {
        blockId: itemId('8000', 12),
        checkpoint: 2,
        title: 'Writing',
        instructions: 'Chọn các idea từ bảng brainstorm trong Homework Lesson 2, rồi viết theo thứ tự Body 1, Body 2 và Thesis statement.',
        items: writingPrompts.map((prompt, index) => baseItem(index + 3, {
          displayNumber: String(index + 1),
          prompt
        }))
      },
      {
        blockId: itemId('8000', 13),
        checkpoint: 3,
        title: session2Speaking.title,
        instructions: session2Speaking.instructions,
        items: speakingItems
      }
    ]
  });
}

export function buildIc2304Session3GradingKey(answers) {
  if (!Array.isArray(answers) || answers.length !== 2
    || answers.some(answer => !headings.some(([id]) => id === answer))) {
    throw new Error('IC2304_SESSION3_READING_ANSWERS_REQUIRED');
  }
  const reading = buildIc2304Session3Definition().blocks[0];
  return parseFormGradingKey({
    schemaVersion: 'FormGradingKeyV1',
    formVersionId: IC2304_SESSION3_TEMPLATE.formVersionId,
    graderVersion: 1,
    items: Object.fromEntries(reading.items.map((item, index) => [
      item.itemVersionId,
      { graderType: 'exact_option', expectedOptionId: answers[index] }
    ])),
    groups: {}
  });
}
