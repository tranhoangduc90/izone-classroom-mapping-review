import { sha256, stableStringify } from '../src/learning-domain.js';

// Dữ liệu nhận vào: không nhận dữ liệu thật; toàn bộ ID và nội dung dưới đây chỉ dành cho lớp demo.
// Xử lý: tạo đúng FormDefinitionV1/FormGradingKeyV1 và tính hash giống backend production.
// Kết quả: in JSON gồm fixture và hash để migration SQL có thể được kiểm chứng trước khi triển khai.
// Khi lỗi: tiến trình dừng với exit code khác 0; không có thay đổi nào được ghi vào database.
export const demoDefinition = {
  schemaVersion: 'FormDefinitionV1',
  formVersionId: '20000000-0000-4000-8000-000000000002',
  title: 'Phiếu điểm danh và ghi nhanh · Demo',
  kind: 'reflection',
  answerReleasePolicy: 'hidden',
  blocks: [
    {
      blockId: '20000000-0000-4000-8000-000000000101',
      checkpoint: 1,
      title: 'Sau hoạt động luyện tập',
      instructions: 'Điền ngắn gọn khi giảng viên yêu cầu.',
      items: [{
        itemFamilyId: '10000000-0000-4000-8000-000000000004',
        itemVersionId: '20000000-0000-4000-8000-000000000201',
        position: 1,
        prompt: 'Em làm đúng hoặc hoàn thành được bao nhiêu câu?',
        helpText: '', interactionType: 'short_text', pedagogicalTypeCode: 'reflection',
        layoutType: 'plain_prompt', graderType: 'none', groupId: null, required: true,
        maxScore: 0, options: [], skillCodes: [], releasePolicy: 'inherit'
      }]
    },
    {
      blockId: '20000000-0000-4000-8000-000000000102',
      checkpoint: 2,
      title: 'Trước khi kết thúc buổi học',
      instructions: 'Điền ngắn gọn khi giảng viên yêu cầu.',
      items: [
        {
          itemFamilyId: '10000000-0000-4000-8000-000000000002',
          itemVersionId: '20000000-0000-4000-8000-000000000202',
          position: 2,
          prompt: 'Điều gì vẫn khiến em chưa chắc hoặc còn vướng?',
          helpText: '', interactionType: 'long_text', pedagogicalTypeCode: 'reflection',
          layoutType: 'plain_prompt', graderType: 'none', groupId: null, required: true,
          maxScore: 0, options: [], skillCodes: [], releasePolicy: 'inherit'
        },
        {
          itemFamilyId: '10000000-0000-4000-8000-000000000003',
          itemVersionId: '20000000-0000-4000-8000-000000000203',
          position: 3,
          prompt: 'Việc cụ thể tiếp theo em sẽ làm là gì?',
          helpText: '', interactionType: 'short_text', pedagogicalTypeCode: 'reflection',
          layoutType: 'plain_prompt', graderType: 'none', groupId: null, required: true,
          maxScore: 0, options: [], skillCodes: [], releasePolicy: 'inherit'
        }
      ]
    }
  ]
};

export const demoGradingKey = {
  schemaVersion: 'FormGradingKeyV1',
  formVersionId: demoDefinition.formVersionId,
  graderVersion: 1,
  items: {},
  groups: {}
};

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/learning-demo-fixture.mjs')) {
  process.stdout.write(`${JSON.stringify({
    definition: demoDefinition,
    gradingKey: demoGradingKey,
    definitionHash: sha256(stableStringify(demoDefinition)),
    gradingHash: sha256(stableStringify(demoGradingKey)),
    evidenceHashes: ['progress-form-demo-1', 'term-test-demo-1', 'homework-demo-1'].map(sha256)
  })}\n`);
}
