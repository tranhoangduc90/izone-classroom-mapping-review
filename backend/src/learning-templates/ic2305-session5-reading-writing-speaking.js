/*
 * Dữ liệu nhận vào: câu hỏi Buổi 5 trong tài liệu do giảng viên cung cấp.
 * Việc chính: dựng phiếu công khai và giữ đáp án trắc nghiệm trong khóa riêng.
 * Kết quả: hai phần Progress Log cho IC2305, khóa 56; câu tự luận không chấm máy.
 * Khi lỗi: schema và kiểm thử chặn phát hành trước khi tạo assignment.
 */
import { parseFormDefinition, parseFormGradingKey } from '../learning-contracts.js';

export const IC2305_SESSION5_TEMPLATE = Object.freeze({
  code: 'k56.progress.reading-writing-speaking.session5.v1',
  templateId: '56000000-0000-4000-8000-000000000009',
  formVersionId: '56000000-0000-4000-8000-000000000010',
  courseCode: '56',
  title: 'Buổi 5 - Reading, Writing và Speaking'
});

const ids = Object.freeze({
  blocks: ['56000000-0000-4000-8000-000000000051', '56000000-0000-4000-8000-000000000052'],
  families: Array.from({ length: 8 }, (_, index) =>
    `56000000-0000-4000-8900-${String(index + 1).padStart(12, '0')}`),
  versions: Array.from({ length: 8 }, (_, index) =>
    `56000000-0000-4000-8a00-${String(index + 1).padStart(12, '0')}`)
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

export function buildIc2305Session5Definition() {
  return parseFormDefinition({
    schemaVersion: 'FormDefinitionV1',
    formVersionId: IC2305_SESSION5_TEMPLATE.formVersionId,
    courseCode: IC2305_SESSION5_TEMPLATE.courseCode,
    title: IC2305_SESSION5_TEMPLATE.title,
    kind: 'mixed',
    answerReleasePolicy: 'hidden',
    blocks: [
      {
        blockId: ids.blocks[0],
        checkpoint: 1,
        title: 'Phần 1: Nhìn lại bài học trước',
        instructions: 'Nhớ lại kiến thức đã học và chọn phương án đúng nhất.',
        items: [
          item(1, {
            displayNumber: '1',
            prompt: 'Em thấy nội dung nào trong buổi học trước hữu ích nhất đối với việc học hoặc làm bài của mình? Hãy nêu rõ kiến thức đó là gì.',
            interactionType: 'long_text',
            skillCodes: ['reflection']
          }),
          item(2, {
            displayNumber: '2',
            prompt: 'Khi đọc câu hỏi và vận dụng kỹ năng Scanning để tìm từ khóa, em nên ưu tiên scan thuật ngữ vì sao, hãy chọn phương án đúng nhất.',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'reading_scanning_terms',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [
              { id: 'A', label: 'Vì từ đó dài, dễ thấy hơi các từ ngắn' },
              { id: 'B', label: 'Vì từ đó khó bị paraphrase' },
              { id: 'C', label: 'Vì từ đó chắc chắn sẽ xuất hiện y hệt trong bài đọc' }
            ],
            skillCodes: ['reading']
          }),
          item(3, {
            displayNumber: '3',
            prompt: 'Deciding keywords là gì?',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'reading_deciding_keywords',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [
              { id: 'A', label: 'Deciding keywords là các từ khóa dễ scan như số, tên riêng, hay thuật ngữ' },
              { id: 'B', label: 'Deciding keywords là các từ khóa sẽ bị paraphrase trong bài đọc nên cần phải hiểu nghĩa thì mới tìm đúng được' },
              { id: 'C', label: 'Deciding keywords giúp phân định một khẳng định (statement) là True, False hay Not given' }
            ],
            skillCodes: ['reading']
          })
        ]
      },
      {
        blockId: ids.blocks[1],
        checkpoint: 2,
        title: 'Phần 2: Bài học hôm nay',
        instructions: 'Hoàn thành phần Writing và nhìn lại buổi luyện Speaking.',
        items: [
          item(4, {
            displayNumber: '1',
            prompt: '(Xác định điểm cuối) Đọc câu Topic Sentence dưới đây và chọn cụm từ thể hiện đúng "Điểm cuối" mà đoạn văn cần phải hướng tới để tránh lỗi lập luận (lỗi dừng lại giữa chừng / chưa khớp điểm cuối):\nTopic Sentence: "Khuyến khích người dân đi xe đạp thay vì lái xe ô tô sẽ giúp cải thiện sức khỏe cộng đồng."',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'writing_endpoint',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [
              { id: 'A', label: 'Giảm lượng khí thải độc hại ra môi trường.' },
              { id: 'B', label: 'Người dân được vận động cơ thể nhiều hơn.' },
              { id: 'C', label: 'Giảm nguy cơ mắc các bệnh về tim mạch.' }
            ],
            skillCodes: ['writing']
          }),
          item(5, {
            displayNumber: '2',
            prompt: '(Trắc nghiệm) Theo cấu trúc đã học, một đoạn văn Body tiêu chuẩn trong bài thi sẽ gồm 5 câu. Vai trò của 5 câu này được phân bổ như thế nào?',
            interactionType: 'single_choice',
            pedagogicalTypeCode: 'writing_body_structure',
            layoutType: 'choice_cards',
            graderType: 'exact_option',
            maxScore: 1,
            options: [
              { id: 'A', label: '1 câu Topic Sentence + 4 câu liên tục để đưa ra ví dụ (Examples).' },
              { id: 'B', label: '1 câu Topic Sentence + 2 ý nhỏ (mỗi ý nhỏ được phát triển thành 2 câu làm rõ/chứng minh).' },
              { id: 'C', label: '2 câu Topic Sentence + 3 câu làm rõ/chứng minh.' }
            ],
            skillCodes: ['writing']
          }),
          item(6, {
            displayNumber: '3',
            prompt: '(Hedging) "Hedging" là kỹ thuật vô cùng quan trọng giúp làm giảm độ chắc chắn tuyệt đối, tăng tính khách quan cho lập luận.\nTrong các cách Hedging đã học, các em cảm thấy 02 kỹ thuật nào là dễ nhớ và dễ áp dụng nhất đối với bản thân khi viết bài? Hãy liệt kê:',
            pedagogicalTypeCode: 'writing_hedging_reflection',
            layoutType: 'numbered_short_texts',
            interactionConfig: {
              responseCount: 2,
              responseLabels: ['Kỹ thuật 1', 'Kỹ thuật 2']
            },
            skillCodes: ['writing']
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
              { id: 'OTHER', label: 'Vấn đề khác. Nêu rõ' }
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

export function buildIc2305Session5GradingKey() {
  return parseFormGradingKey({
    schemaVersion: 'FormGradingKeyV1',
    formVersionId: IC2305_SESSION5_TEMPLATE.formVersionId,
    graderVersion: 1,
    items: {
      [ids.versions[1]]: { graderType: 'exact_option', expectedOptionId: 'B' },
      [ids.versions[2]]: { graderType: 'exact_option', expectedOptionId: 'C' },
      [ids.versions[3]]: { graderType: 'exact_option', expectedOptionId: 'C' },
      [ids.versions[4]]: { graderType: 'exact_option', expectedOptionId: 'B' }
    },
    groups: {}
  });
}
