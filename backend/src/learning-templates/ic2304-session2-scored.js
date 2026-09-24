/*
 * Dữ liệu nhận vào: mẫu IC2304 Buổi 2 và năm đáp án lấy từ nguồn riêng tư.
 * Xử lý: tạo version mới, chấm năm câu Listening; giữ nguyên bốn câu Writing.
 * Kết quả: form công khai không có đáp án và khóa chấm riêng cho máy chủ.
 * Khi lỗi: schema chặn phát hành; không trả đáp án trước khi học viên nộp phần.
 */
import { parseFormDefinition, parseFormGradingKey } from '../learning-contracts.js';
import { buildIc2304Session2Definition, IC2304_SESSION2_TEMPLATE } from './ic2304-session2-listening-writing.js';

export const IC2304_SESSION2_SCORED = Object.freeze({
  ...IC2304_SESSION2_TEMPLATE,
  code: 'ic2304.session2.listening-writing.v2',
  formVersionId: '23040002-0000-4000-8000-000000000003'
});

export function buildIc2304Session2ScoredDefinition() {
  const original = buildIc2304Session2Definition();
  return parseFormDefinition({
    ...original,
    formVersionId: IC2304_SESSION2_SCORED.formVersionId,
    answerReleasePolicy: 'immediate',
    blocks: original.blocks.map((block, blockIndex) => ({
      ...block,
      items: block.items.map((item, itemIndex) => ({
        ...item,
        itemVersionId: '23040002-0000-4000-8300-'
          + String(blockIndex * 5 + itemIndex + 1).padStart(12, '0'),
        ...(blockIndex === 0 ? { graderType: 'exact_option', maxScore: 1 } : {})
      }))
    }))
  });
}

export function buildIc2304Session2ScoredGradingKey(answers) {
  if (!Array.isArray(answers) || answers.length !== 5
    || answers.some(answer => !['A', 'B', 'C'].includes(answer))) {
    throw new Error('IC2304_PRIVATE_ANSWER_IDS_REQUIRED');
  }
  const definition = buildIc2304Session2ScoredDefinition();
  return parseFormGradingKey({
    schemaVersion: 'FormGradingKeyV1',
    formVersionId: definition.formVersionId,
    graderVersion: 1,
    items: Object.fromEntries(definition.blocks[0].items.map((item, index) => [
      item.itemVersionId,
      { graderType: 'exact_option', expectedOptionId: answers[index] }
    ])),
    groups: {}
  });
}
