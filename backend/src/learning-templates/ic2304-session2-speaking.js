/*
 * Dữ liệu nhận vào: phiếu IC2304 đã có Listening/Writing và checklist Speaking Đức cung cấp.
 * Xử lý: thêm checkpoint Speaking tối đa hai lựa chọn; giữ khóa chấm Listening riêng.
 * Kết quả: form v3 công khai và khóa chấm riêng cho backend.
 * Khi lỗi: schema/test chặn form; không sửa version đã phát hành.
 */
import { parseFormDefinition, parseFormGradingKey } from '../learning-contracts.js';
import { buildIc2304Session2ScoredDefinition, buildIc2304Session2ScoredGradingKey,
  IC2304_SESSION2_SCORED } from './ic2304-session2-scored.js';

export const IC2304_SESSION2_SPEAKING = Object.freeze({
  ...IC2304_SESSION2_SCORED,
  code: 'ic2304.session2.listening-writing-speaking.v3',
  formVersionId: '23040002-0000-4000-8000-000000000004'
});

const checklistId = '23040002-0000-4000-8300-000000000010';
const choices = [
  ['IDEAS', 'Khó phát triển ý và nói đủ dài'],
  ['VOCABULARY', 'Thiếu từ vựng để diễn đạt ý'],
  ['FLUENCY', 'Nói ngắt quãng hoặc dừng quá lâu'],
  ['PRONUNCIATION', 'Phát âm chưa rõ hoặc sai trọng âm'],
  ['GRAMMAR', 'Dùng ngữ pháp chưa chính xác'],
  ['COHERENCE', 'Câu trả lời chưa liên kết, thiếu mạch lạc'],
  ['NO_MAJOR_ISSUE', 'Em chưa nhận thấy vấn đề lớn'],
  ['OTHER', 'Vấn đề khác. Nêu rõ']
];

function explanation(index, optionId, prompt) {
  return {
    itemFamilyId: `23040002-0000-4000-8100-${String(10 + index).padStart(12, '0')}`,
    itemVersionId: `23040002-0000-4000-8300-${String(10 + index).padStart(12, '0')}`,
    position: 10 + index,
    prompt,
    helpText: '',
    interactionType: 'long_text',
    pedagogicalTypeCode: 'speaking_self_assessment',
    layoutType: 'inline_option_text',
    graderType: 'none',
    groupId: null,
    required: false,
    maxScore: 0,
    options: [],
    interactionConfig: {
      visibleWhenItemVersionId: checklistId,
      visibleWhenValue: optionId,
      requiredWhenVisible: true
    },
    skillCodes: ['speaking'],
    evidenceSource: 'student_self_report',
    releasePolicy: 'inherit'
  };
}

export function buildIc2304Session2SpeakingDefinition() {
  const previous = buildIc2304Session2ScoredDefinition();
  return parseFormDefinition({
    ...previous,
    formVersionId: IC2304_SESSION2_SPEAKING.formVersionId,
    blocks: [
      ...previous.blocks,
      {
        blockId: '23040002-0000-4000-8000-000000000013',
        checkpoint: 3,
        title: 'Speaking',
        instructions: '',
        items: [
          {
            itemFamilyId: '23040002-0000-4000-8100-000000000010',
            itemVersionId: checklistId,
            position: 10,
            displayNumber: '1',
            prompt: 'Em nhận thấy, hoặc partner speaking của em nhận xét, mình đang gặp vấn đề gì lớn nhất trong buổi luyện tập speaking hôm nay?',
            helpText: 'Chọn tối đa 2 mục. Với mục có ô nhập, em hãy nêu rõ vấn đề; gõ vào ô sẽ tự chọn mục đó.',
            interactionType: 'multi_choice_group',
            pedagogicalTypeCode: 'speaking_self_assessment',
            layoutType: 'speaking_issue_checklist',
            graderType: 'none',
            groupId: null,
            required: true,
            maxScore: 0,
            options: choices.map(([id, label]) => ({ id, label })),
            interactionConfig: { maxSelections: 2, exclusiveOptionId: 'NO_MAJOR_ISSUE' },
            skillCodes: ['speaking'],
            evidenceSource: 'student_self_report',
            releasePolicy: 'inherit'
          },
          explanation(1, 'IDEAS', 'Em gặp khó khăn cụ thể gì khi phát triển ý và nói đủ dài?'),
          explanation(2, 'VOCABULARY', 'Em thiếu từ vựng nào để diễn đạt ý?'),
          explanation(3, 'OTHER', 'Vấn đề khác. Nêu rõ.')
        ]
      }
    ]
  });
}

export function buildIc2304Session2SpeakingGradingKey(answers) {
  const previous = buildIc2304Session2ScoredGradingKey(answers);
  return parseFormGradingKey({ ...previous, formVersionId: IC2304_SESSION2_SPEAKING.formVersionId });
}
