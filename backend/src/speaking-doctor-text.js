// Preserve the Unicode/evidence helpers already deployed in the Speaking runtime.
export function isDoctorText(value) {
  return typeof value === 'string' && value.isWellFormed() && !value.includes('\u0000');
}
export function actualEvidenceQuote(source, proposed) {
  if (!isDoctorText(source) || !isDoctorText(proposed) || proposed.length < 5) return null;
  if (proposed.length > 160) {
    if (!source.includes(proposed)) return null;
    let end = 160;
    const last = proposed.charCodeAt(end - 1), next = proposed.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    return proposed.slice(0, end);
  }
  if (source.includes(proposed)) return proposed;
  const words = [...new Set(proposed.toLocaleLowerCase().match(/[\p{L}\p{N}]{5,}/gu) || [])]
    .sort((left, right) => right.length - left.length);
  const lower = source.toLocaleLowerCase();
  const found = words.map(word => lower.indexOf(word)).find(index => index >= 0);
  if (found === undefined) return null;
  let position = found;
  if (lower.length !== source.length) {
    let folded = 0;
    position = 0;
    for (const character of source) {
      const size = character.toLocaleLowerCase().length;
      if (folded + size > found) break;
      folded += size;
      position += character.length;
    }
  }
  let start = Math.max(0, position - 45);
  let end = Math.min(source.length, position + 115);
  const low = value => value >= 0xdc00 && value <= 0xdfff;
  const high = value => value >= 0xd800 && value <= 0xdbff;
  if (start > 0 && low(source.charCodeAt(start)) && high(source.charCodeAt(start - 1))) start++;
  if (end < source.length && high(source.charCodeAt(end - 1)) && low(source.charCodeAt(end))) end--;
  const quote = source.slice(start, end);
  return quote.length >= 5 && quote.length <= 160 && isDoctorText(quote) ? quote : null;
}
export function doctorDiagnostic(error, stage) {
  const allowedStages = new Set(['catalog', 'read_share', 'analyze', 'save', 'practice_event']);
  const currentStage = allowedStages.has(error?.doctorStage) ? error.doctorStage
    : allowedStages.has(stage) ? stage : 'analyze';
  const sqlState = /^[0-9A-Z]{5}$/.test(error?.code || '') ? error.code : null;
  const explicit = [error?.code, error?.message]
    .find(value => /^(DOCTOR|PRACTICE)_[A-Z0-9_]{1,64}$/.test(value || ''));
  return { stage: currentStage,
    code: sqlState ? `DOCTOR_DATABASE_${sqlState}` : explicit || `DOCTOR_${currentStage.toUpperCase()}_ERROR`,
    ...(sqlState ? { sqlState } : {}) };
}
