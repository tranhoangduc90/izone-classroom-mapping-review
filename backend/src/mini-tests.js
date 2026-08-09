const BAND_TABLE = [
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

function bandFromConverted(correct) {
  const row = BAND_TABLE.find(item => correct >= item.min && correct <= item.max);
  return row ? row.band : '<2.5';
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

// Nhận số câu đúng do Apps Script gửi, tự quy đổi lại Band và tạo kết quả chuẩn để lưu database.
export function buildMiniTestResult({ testSlug, listeningCorrect, readingCorrect, typeStats }) {
  const normalizedStats = typeStats.map(item => ({
    type: item.type,
    correct: item.correct,
    total: item.total,
    percentage: item.total ? item.correct / item.total : 0
  }));
  const listeningConverted = listeningCorrect * 2;
  const readingConverted = readingCorrect * 3;
  const listeningBand = bandFromConverted(listeningConverted);
  const readingBand = bandFromConverted(readingConverted);
  const averageBand = [listeningBand, readingBand].every(value => typeof value === 'number')
    ? Number(((listeningBand + readingBand) / 2).toFixed(2))
    : null;

  return {
    testSlug,
    listening: {
      correct: listeningCorrect,
      total: 20,
      score10: listeningCorrect / 2,
      converted: listeningConverted,
      band: listeningBand
    },
    reading: {
      correct: readingCorrect,
      total: 13,
      score13: readingCorrect,
      converted: readingConverted,
      band: readingBand
    },
    summary: {
      totalCorrect: listeningCorrect + readingCorrect,
      totalQuestions: 33,
      percentage: (listeningCorrect + readingCorrect) / 33,
      averageBand
    },
    typeStats: normalizedStats,
    performance: splitPerformance(normalizedStats)
  };
}
