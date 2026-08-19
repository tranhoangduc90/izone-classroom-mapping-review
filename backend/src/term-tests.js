import { z } from 'zod';

const answerKeySchema = z.string().trim().max(120);
const pairGroupSchema = z.object({
  numbers: z.array(z.number().int().min(1).max(40)).min(2),
  expected: z.array(answerKeySchema).min(2)
});
const questionSchema = z.object({
  number: z.number().int().min(1).max(40),
  type: z.string().trim().min(1).max(160),
  accepted: z.array(answerKeySchema).default([]),
  pairGroup: z.string().trim().min(1).max(40).nullable().optional()
});
const sectionSchema = z.object({
  questions: z.array(questionSchema).min(1).max(40),
  pairGroups: z.record(z.string(), pairGroupSchema).default({})
}).superRefine((section, context) => {
  const numbers = new Set(section.questions.map(question => question.number));
  if (numbers.size !== section.questions.length) {
    context.addIssue({ code: 'custom', path: ['questions'], message: 'Số thứ tự câu trong mỗi phần không được trùng.' });
  }
  for (const question of section.questions) {
    if (question.pairGroup && !section.pairGroups[question.pairGroup]) {
      context.addIssue({ code: 'custom', path: ['questions'], message: `Thiếu nhóm đáp án ${question.pairGroup}.` });
    }
  }
  for (const [groupId, group] of Object.entries(section.pairGroups)) {
    if (group.numbers.length !== group.expected.length) {
      context.addIssue({ code: 'custom', path: ['pairGroups', groupId], message: 'Số ô và số đáp án trong nhóm phải bằng nhau.' });
    }
    if (new Set(group.numbers).size !== group.numbers.length) {
      context.addIssue({ code: 'custom', path: ['pairGroups', groupId], message: 'Số câu trong nhóm đáp án không được trùng.' });
    }
    for (const number of group.numbers) {
      const question = section.questions.find(item => item.number === number);
      if (!question || question.pairGroup !== groupId) {
        context.addIssue({ code: 'custom', path: ['pairGroups', groupId], message: `Câu ${number} chưa liên kết đúng với nhóm ${groupId}.` });
      }
    }
  }
});

const storedTestSchema = z.object({
  test_slug: z.string().trim().min(1),
  test_title: z.string().trim().min(1),
  definition_version: z.coerce.number().int().positive(),
  listening_band_adjustment: z.coerce.number().min(-1).max(1).default(0),
  listening_definition: sectionSchema,
  reading_definition: sectionSchema
});

const spellingCanonical = new Map([
  ['color', 'colour'],
  ['colors', 'colours'],
  ['center', 'centre'],
  ['centers', 'centres'],
  ['theater', 'theatre'],
  ['theaters', 'theatres'],
  ['liter', 'litre'],
  ['liters', 'litres']
]);

const bandTable = [
  { min: 39, max: 40, band: 9.0 },
  { min: 37, max: 38, band: 8.5 },
  { min: 35, max: 36, band: 8.0 },
  { min: 33, max: 34, band: 7.5 },
  { min: 30, max: 32, band: 7.0 },
  { min: 27, max: 29, band: 6.5 },
  { min: 23, max: 26, band: 6.0 },
  { min: 20, max: 22, band: 5.5 },
  { min: 16, max: 19, band: 5.0 },
  { min: 13, max: 15, band: 4.5 },
  { min: 10, max: 12, band: 4.0 },
  { min: 7, max: 9, band: 3.5 },
  { min: 5, max: 6, band: 3.0 },
  { min: 3, max: 4, band: 2.5 }
];

function clean(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function normalize(value) {
  const normalized = clean(value).toLocaleLowerCase('en');
  return spellingCanonical.get(normalized) || normalized;
}

function ieltsBand(correct) {
  const row = bandTable.find(item => correct >= item.min && correct <= item.max);
  return row ? row.band : '<2.5';
}

function applyBandAdjustment(band, adjustment) {
  if (typeof band !== 'number') return band;
  return Math.min(9, Math.max(0, Math.round((band + Number(adjustment || 0)) * 2) / 2));
}

function buildPairItems(section, answers) {
  const result = new Map();
  for (const [groupId, group] of Object.entries(section.pairGroups)) {
    const remaining = new Map();
    for (const expected of group.expected) {
      const key = normalize(expected);
      remaining.set(key, (remaining.get(key) || 0) + 1);
    }
    const correctAnswer = `${group.expected.map(clean).join(' + ')} (không xét thứ tự)`;
    for (const number of group.numbers) {
      const studentAnswer = clean(answers[String(number)]);
      const key = normalize(studentAnswer);
      const correct = Boolean(key && (remaining.get(key) || 0) > 0);
      if (correct) remaining.set(key, remaining.get(key) - 1);
      result.set(`${groupId}:${number}`, {
        studentAnswer,
        answered: Boolean(key),
        correct,
        correctAnswer
      });
    }
  }
  return result;
}

export function parseStoredTest(row) {
  return storedTestSchema.parse(row);
}

export function gradeSection(sectionInput, answersInput, bandAdjustment = 0) {
  const section = sectionSchema.parse(sectionInput);
  const answers = answersInput || {};
  const pairItems = buildPairItems(section, answers);
  const typeStats = new Map();
  const details = [];
  let correct = 0;
  let answered = 0;

  for (const question of [...section.questions].sort((left, right) => left.number - right.number)) {
    const rawAnswer = clean(answers[String(question.number)]);
    const pairItem = question.pairGroup
      ? pairItems.get(`${question.pairGroup}:${question.number}`)
      : null;
    const isCorrect = pairItem
      ? pairItem.correct
      : question.accepted.some(expected => normalize(rawAnswer) === normalize(expected));
    const isAnswered = pairItem ? pairItem.answered : Boolean(normalize(rawAnswer));
    const studentAnswer = pairItem ? pairItem.studentAnswer : rawAnswer;
    const correctAnswer = pairItem
      ? pairItem.correctAnswer
      : question.accepted.map(clean).join(' / ');

    if (isCorrect) correct += 1;
    if (isAnswered) answered += 1;
    const current = typeStats.get(question.type) || { type: question.type, correct: 0, total: 0 };
    current.total += 1;
    if (isCorrect) current.correct += 1;
    typeStats.set(question.type, current);
    details.push({
      number: question.number,
      type: question.type,
      studentAnswer,
      correctAnswer,
      result: isCorrect ? 'correct' : (isAnswered ? 'incorrect' : 'blank')
    });
  }

  const converted = Math.round(correct * 40 / section.questions.length);
  const baseBand = ieltsBand(converted);
  return {
    correct,
    total: section.questions.length,
    answered,
    converted,
    baseBand,
    adjustment: Number(bandAdjustment || 0),
    band: applyBandAdjustment(baseBand, bandAdjustment),
    details,
    typeStats: [...typeStats.values()].map(item => ({
      ...item,
      percentage: item.total ? item.correct / item.total : 0
    }))
  };
}

function splitPerformance(stats) {
  const sorted = [...stats].sort((left, right) =>
    right.percentage - left.percentage || left.type.localeCompare(right.type, 'vi')
  );
  if (!sorted.length) return { best: [], needsImprovement: [], other: [] };
  const highest = sorted[0].percentage;
  const lowest = sorted.at(-1).percentage;
  return {
    best: sorted.filter(item => item.percentage === highest),
    needsImprovement: sorted.filter(item => item.percentage === lowest && lowest !== highest),
    other: sorted.filter(item => item.percentage !== highest && item.percentage !== lowest)
  };
}

function buildResult(test, listening, reading = null) {
  const merged = new Map();
  const sections = reading ? [listening, reading] : [listening];
  for (const stat of sections.flatMap(section => section.typeStats)) {
    const current = merged.get(stat.type) || { type: stat.type, correct: 0, total: 0 };
    current.correct += stat.correct;
    current.total += stat.total;
    merged.set(stat.type, current);
  }
  const typeStats = [...merged.values()].map(item => ({
    ...item,
    percentage: item.total ? item.correct / item.total : 0
  }));
  const totalCorrect = sections.reduce((sum, section) => sum + section.correct, 0);
  const totalQuestions = sections.reduce((sum, section) => sum + section.total, 0);
  const averageBand = reading
    && [listening.band, reading.band].every(band => typeof band === 'number' && Number.isFinite(band))
    ? Number(((listening.band + reading.band) / 2).toFixed(2))
    : null;
  return {
    testSlug: test.test_slug,
    testTitle: test.test_title,
    definitionVersion: test.definition_version,
    listening,
    reading,
    summary: {
      totalCorrect,
      totalQuestions,
      percentage: totalQuestions ? totalCorrect / totalQuestions : 0,
      averageBand
    },
    performance: splitPerformance(typeStats),
    typeStats: [...typeStats].sort((left, right) =>
      right.percentage - left.percentage || left.type.localeCompare(right.type, 'vi')
    )
  };
}

export function buildListeningResult(test, listening) {
  return buildResult(test, listening);
}

export function buildCombinedResult(test, listening, reading) {
  return buildResult(test, listening, reading);
}
