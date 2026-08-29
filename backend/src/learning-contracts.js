import { z } from 'zod';

const uuidSchema = z.string().uuid();
const codeSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{1,79}$/);
const optionSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/),
  label: z.string().trim().min(1).max(300)
}).strict();

export const interactionTypeSchema = z.enum([
  'short_text',
  'long_text',
  'single_choice',
  'multi_choice_group'
]);

export const graderTypeSchema = z.enum([
  'none',
  'accepted_text',
  'exact_option',
  'unordered_group_slot',
  'rubric_async'
]);

export const formItemSchema = z.object({
  itemFamilyId: uuidSchema,
  itemVersionId: uuidSchema,
  position: z.number().int().min(1).max(100),
  prompt: z.string().trim().min(1).max(2_000),
  helpText: z.string().trim().max(1_000).optional().default(''),
  interactionType: interactionTypeSchema,
  pedagogicalTypeCode: codeSchema,
  layoutType: codeSchema,
  graderType: graderTypeSchema,
  groupId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/).nullable().optional(),
  required: z.boolean().default(true),
  maxScore: z.number().min(0).max(100).default(0),
  options: z.array(optionSchema).max(40).optional().default([]),
  skillCodes: z.array(codeSchema).max(20).optional().default([]),
  releasePolicy: z.enum(['inherit', 'hidden', 'immediate', 'teacher_release']).default('inherit')
}).strict().superRefine((item, context) => {
  const optionIds = item.options.map(option => option.id);
  if (new Set(optionIds).size !== optionIds.length) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'Mã lựa chọn trong một câu không được trùng.' });
  }
  if (['single_choice', 'multi_choice_group'].includes(item.interactionType) && item.options.length < 2) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'Câu lựa chọn cần ít nhất hai phương án.' });
  }
  if (['short_text', 'long_text'].includes(item.interactionType) && item.options.length) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'Câu nhập chữ không được chứa option.' });
  }
  if (item.graderType === 'unordered_group_slot' && !item.groupId) {
    context.addIssue({ code: 'custom', path: ['groupId'], message: 'Câu chọn TWO/THREE phải có groupId.' });
  }
  if (item.graderType === 'rubric_async' && item.interactionType !== 'long_text') {
    context.addIssue({ code: 'custom', path: ['graderType'], message: 'Chấm rubric chỉ áp dụng cho câu viết dài.' });
  }
  if (item.graderType === 'none' && item.maxScore !== 0) {
    context.addIssue({ code: 'custom', path: ['maxScore'], message: 'Câu reflection không chấm điểm phải có maxScore bằng 0.' });
  }
});

const formBlockSchema = z.object({
  blockId: uuidSchema,
  checkpoint: z.number().int().min(1).max(3),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(2_000).optional().default(''),
  items: z.array(formItemSchema).min(1).max(40)
}).strict();

export const formDefinitionV1Schema = z.object({
  schemaVersion: z.literal('FormDefinitionV1'),
  formVersionId: uuidSchema,
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['reflection', 'mixed', 'quiz']),
  answerReleasePolicy: z.enum(['hidden', 'immediate', 'teacher_release']).default('hidden'),
  blocks: z.array(formBlockSchema).min(1).max(20)
}).strict().superRefine((definition, context) => {
  const items = definition.blocks.flatMap(block => block.items);
  const blockIds = definition.blocks.map(block => block.blockId);
  const itemVersionIds = items.map(item => item.itemVersionId);
  if (items.length > 100) {
    context.addIssue({ code: 'custom', path: ['blocks'], message: 'Một form chỉ nhận tối đa 100 câu.' });
  }
  if (new Set(blockIds).size !== blockIds.length) {
    context.addIssue({ code: 'custom', path: ['blocks'], message: 'blockId không được trùng.' });
  }
  if (new Set(itemVersionIds).size !== itemVersionIds.length) {
    context.addIssue({ code: 'custom', path: ['blocks'], message: 'itemVersionId không được trùng.' });
  }
  const positions = items.map(item => item.position);
  if (new Set(positions).size !== positions.length) {
    context.addIssue({ code: 'custom', path: ['blocks'], message: 'Vị trí câu hỏi không được trùng.' });
  }
});

const normalizationSchema = z.object({
  unicode: z.literal('NFKC').default('NFKC'),
  caseInsensitive: z.boolean().default(true),
  collapseWhitespace: z.boolean().default(true),
  acceptedWordCountMax: z.number().int().min(1).max(20).nullable().optional()
}).strict();

const privateItemKeySchema = z.discriminatedUnion('graderType', [
  z.object({
    graderType: z.literal('accepted_text'),
    accepted: z.array(z.string().max(300)).min(1).max(40),
    normalization: normalizationSchema.default({})
  }).strict(),
  z.object({
    graderType: z.literal('exact_option'),
    expectedOptionId: z.string().trim().min(1).max(80)
  }).strict(),
  z.object({
    graderType: z.literal('rubric_async'),
    rubricCode: codeSchema,
    rubricVersion: z.number().int().positive()
  }).strict()
]);

const privateGroupKeySchema = z.object({
  graderType: z.literal('unordered_group_slot'),
  expectedOptionIds: z.array(z.string().trim().min(1).max(80)).min(2).max(3)
}).strict();

export const formGradingKeyV1Schema = z.object({
  schemaVersion: z.literal('FormGradingKeyV1'),
  formVersionId: uuidSchema,
  graderVersion: z.number().int().positive(),
  items: z.record(uuidSchema, privateItemKeySchema).default({}),
  groups: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/), privateGroupKeySchema).default({})
}).strict();

export const responseValueSchema = z.union([
  z.string().max(12_000),
  z.array(z.string().trim().min(1).max(80)).min(1).max(10)
]);

export const responseMapSchema = z.record(uuidSchema, responseValueSchema).superRefine((responses, context) => {
  if (Object.keys(responses).length > 100) {
    context.addIssue({ code: 'custom', message: 'Một form chỉ nhận tối đa 100 câu trả lời.' });
  }
});

export const submissionReceiptV1Schema = z.object({
  schemaVersion: z.literal('SubmissionReceiptV1'),
  submissionId: uuidSchema,
  receivedAt: z.iso.datetime(),
  completeness: z.enum(['complete', 'incomplete']),
  attendanceStatus: z.enum(['self_confirmed', 'pending_teacher', 'not_eligible']),
  gradingStatus: z.enum(['complete', 'pending', 'manual_review']),
  message: z.string().max(500),
  nextAction: z.string().max(500)
}).strict();

const resultItemSchema = z.object({
  itemVersionId: uuidSchema,
  itemFamilyId: uuidSchema,
  position: z.number().int().positive(),
  pedagogicalTypeCode: codeSchema,
  skillCodes: z.array(codeSchema),
  rawAnswer: responseValueSchema.nullable(),
  normalizedAnswer: responseValueSchema.nullable(),
  answerState: z.enum(['blank', 'answered', 'invalid']),
  verdict: z.enum(['correct', 'incorrect', 'partial', 'pending', 'manual_review', 'ungraded']),
  scoreEarned: z.number().min(0),
  maxScore: z.number().min(0),
  expectedAnswer: responseValueSchema.nullable().optional()
}).strict();

export const quizResultV1Schema = z.object({
  schemaVersion: z.literal('QuizResultV1'),
  formVersionId: uuidSchema,
  graderVersion: z.number().int().positive(),
  gradingStatus: z.enum(['complete', 'pending', 'manual_review']),
  summary: z.object({
    answered: z.number().int().min(0),
    totalItems: z.number().int().min(0),
    scoreEarned: z.number().min(0),
    maxScore: z.number().min(0),
    percentage: z.number().min(0).max(1).nullable()
  }).strict(),
  typeStats: z.array(z.object({
    pedagogicalTypeCode: codeSchema,
    correct: z.number().int().min(0),
    total: z.number().int().min(0),
    scoreEarned: z.number().min(0),
    maxScore: z.number().min(0)
  }).strict()),
  items: z.array(resultItemSchema).max(100)
}).strict();

export const evidenceEnvelopeV1Schema = z.object({
  schemaVersion: z.literal('EvidenceEnvelopeV1'),
  evidenceId: uuidSchema,
  sourceSystem: codeSchema,
  sourceRecordId: z.string().trim().min(1).max(200),
  sourceRevision: z.number().int().positive(),
  entityKey: z.string().trim().min(1).max(200),
  unitKey: z.string().trim().min(1).max(200),
  operationKey: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(300),
  occurredAt: z.iso.datetime(),
  ingestedAt: z.iso.datetime(),
  visibility: z.enum(['internal', 'analysis_allowed', 'student_visible']),
  context: z.object({
    organizationKey: z.string().trim().min(1).max(80),
    courseCode: z.string().trim().max(80).nullable(),
    classId: z.string().regex(/^\d+$/),
    sessionNumber: z.number().int().min(1).max(100),
    studentRef: uuidSchema,
    formVersionId: uuidSchema.nullable(),
    assignmentId: uuidSchema.nullable(),
    submissionId: uuidSchema.nullable()
  }).strict(),
  payload: z.record(z.string(), z.unknown()),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  rendererVersion: z.string().trim().min(1).max(80),
  markdown: z.string().max(500_000)
}).strict();

const evidenceBackedPointSchema = z.object({
  text: z.string().trim().min(1).max(300),
  evidenceIds: z.array(uuidSchema).min(1).max(20)
}).strict();

export const periodicReportSystemOutputV1Schema = z.object({
  schemaVersion: z.literal('PeriodicReportSystemOutputV1'),
  studentRef: uuidSchema,
  classId: z.string().regex(/^\d+$/),
  fromSessionNumber: z.number().int().min(1).max(100),
  toSessionNumber: z.number().int().min(1).max(100),
  evidenceCount: z.number().int().min(0).max(10_000),
  progress: z.array(evidenceBackedPointSchema).max(3),
  recurringIssues: z.array(evidenceBackedPointSchema).max(3),
  attendance: z.object({
    expectedSessions: z.number().int().min(0).max(100),
    submittedComplete: z.number().int().min(0).max(100),
    submittedIncomplete: z.number().int().min(0).max(100),
    missed: z.number().int().min(0).max(100)
  }).strict(),
  nextAction: evidenceBackedPointSchema.nullable(),
  insufficientData: z.boolean(),
  insufficientDataReason: z.string().trim().max(300).nullable()
}).strict().superRefine((report, context) => {
  if (report.toSessionNumber < report.fromSessionNumber) {
    context.addIssue({ code: 'custom', path: ['toSessionNumber'], message: 'Khoảng buổi không hợp lệ.' });
  }
  if (report.insufficientData && !report.insufficientDataReason) {
    context.addIssue({ code: 'custom', path: ['insufficientDataReason'], message: 'Thiếu lý do khi dữ liệu chưa đủ.' });
  }
  if (!report.insufficientData && report.insufficientDataReason) {
    context.addIssue({ code: 'custom', path: ['insufficientDataReason'], message: 'Không ghi cảnh báo thiếu dữ liệu khi evidence đã đủ.' });
  }
});

export const teacherHumanNoteV1Schema = z.object({
  schemaVersion: z.literal('TeacherHumanNoteV1'),
  reportId: uuidSchema,
  teacherEmail: z.email(),
  noteText: z.string().trim().min(1).max(500)
}).strict();

export function parseFormDefinition(value) {
  return formDefinitionV1Schema.parse(value);
}

export function parseFormGradingKey(value) {
  return formGradingKeyV1Schema.parse(value);
}

export function parseResponses(value) {
  return responseMapSchema.parse(value);
}
