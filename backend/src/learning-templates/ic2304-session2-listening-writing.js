/*
 * Dữ liệu nhận vào: nội dung Listening và Writing từ handout Buổi 2; không nhận hồ sơ học viên.
 * Xử lý: tạo hai phần và chín câu bắt buộc, giữ nguyên lựa chọn Listening và điểm cắt Writing.
 * Kết quả: mẫu phiếu công khai cùng khóa chấm rỗng vì chưa có đáp án Listening được duyệt.
 * Khi lỗi: kiểm schema/test chặn xuất bản; học viên không thấy đáp án suy đoán.
 */

import { parseFormDefinition, parseFormGradingKey } from '../learning-contracts.js';

export const IC2304_SESSION2_TEMPLATE = Object.freeze({
  code: 'ic2304.session2.listening-writing.v1',
  templateId: '23040002-0000-4000-8000-000000000001',
  formVersionId: '23040002-0000-4000-8000-000000000002',
  courseCode: '67',
  title: 'Progress Log · IC2304 · Buổi 2'
});

const ids = Object.freeze({
  blocks: [
    '23040002-0000-4000-8000-000000000011',
    '23040002-0000-4000-8000-000000000012'
  ],
  families: Array.from({ length: 9 }, (_, index) =>
    '23040002-0000-4000-8100-' + String(index + 1).padStart(12, '0')),
  versions: Array.from({ length: 9 }, (_, index) =>
    '23040002-0000-4000-8200-' + String(index + 1).padStart(12, '0'))
});

function baseItem(number, overrides) {
  return {
    itemFamilyId: ids.families[number - 1],
    itemVersionId: ids.versions[number - 1],
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

function listeningItem(number, prompt, options) {
  return baseItem(number - 20, {
    displayNumber: String(number),
    prompt,
    interactionType: 'single_choice',
    pedagogicalTypeCode: 'listening_mcq',
    layoutType: 'choice_cards',
    options: options.map((label, index) => ({
      id: String.fromCharCode(65 + index),
      label
    })),
    skillCodes: ['listening']
  });
}

function writingItem(number, prompt) {
  return baseItem(number + 5, {
    displayNumber: String(number),
    prompt
  });
}

export function buildIc2304Session2Definition() {
  return parseFormDefinition({
    schemaVersion: 'FormDefinitionV1',
    formVersionId: IC2304_SESSION2_TEMPLATE.formVersionId,
    title: IC2304_SESSION2_TEMPLATE.title,
    kind: 'mixed',
    answerReleasePolicy: 'hidden',
    blocks: [
      {
        blockId: ids.blocks[0],
        checkpoint: 1,
        title: 'Listening · Scandinavian Studies',
        instructions: 'Questions 21–25. Choose the correct letter, A, B or C.',
        items: [
          listeningItem(21,
            'James chose to take Scandinavian Studies because when he was a child',
            [
              'he was often taken to Denmark.',
              'his mother spoke to him in Danish.',
              'a number of Danish people visited his family.'
            ]),
          listeningItem(22,
            'When he graduates, James would like to',
            [
              'take a postgraduate course.',
              'work in the media.',
              'become a translator.'
            ]),
          listeningItem(23,
            'Which course will end this term?',
            [
              'Swedish cinema',
              'Danish television programmes',
              'Scandinavian literature'
            ]),
          listeningItem(24,
            'They agree that James’s literature paper this term will be on',
            [
              '19th century playwrights.',
              'the Icelandic sagas.',
              'modern Scandinavian novels.'
            ]),
          listeningItem(25,
            'Beth recommends that James’s paper should be',
            [
              'a historical overview of the genre.',
              'an in-depth analysis of a single writer.',
              'a study of the social background to the literature.'
            ])
        ]
      },
      {
        blockId: ids.blocks[1],
        checkpoint: 2,
        title: 'Writing',
        instructions: '',
        items: [
          writingItem(1,
            'Với quan điểm Agree:\nGiả sử có nội dung sau:\n“Tăng giá đồ ăn gây béo” gây ra hệ quả XXX, rồi hệ quả XXX dẫn đến “Giảm vấn nạn béo phì”\n=> XXX có thể là những gì?'),
          writingItem(2,
            'Với quan điểm Disagree:\n“Tăng giá đồ ăn gây béo” liệu có khả thi?'),
          writingItem(3,
            'Kể cả có tăng giá được, liệu có thật là nạn béo phì sẽ được giải quyết?'),
          writingItem(4,
            'Kể cả việc “Tăng giá đồ ăn gây béo” có thể “Giảm vấn nạn béo phì”, thì khi tăng giá có hậu quả/tác hại gì kèm theo (đến mức mà kể cả việc này có giảm được béo phì thì vẫn không đáng làm) không?')
        ]
      }
    ]
  });
}

export function buildIc2304Session2GradingKey() {
  return parseFormGradingKey({
    schemaVersion: 'FormGradingKeyV1',
    formVersionId: IC2304_SESSION2_TEMPLATE.formVersionId,
    graderVersion: 1,
    items: {},
    groups: {}
  });
}
