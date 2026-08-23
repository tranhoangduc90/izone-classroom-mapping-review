import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function readSyncSafeInteger(buffer, offset) {
  return ((buffer[offset] & 0x7f) << 21)
    | ((buffer[offset + 1] & 0x7f) << 14)
    | ((buffer[offset + 2] & 0x7f) << 7)
    | (buffer[offset + 3] & 0x7f);
}

function frameInfo(buffer, offset) {
  if (offset + 4 > buffer.length || buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buffer[offset + 1] >> 3) & 0x03;
  const layerBits = (buffer[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x03;
  const padding = (buffer[offset + 2] >> 1) & 0x01;
  if (versionBits !== 0x03 || layerBits !== 0x01 || bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) return null;
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const sampleRates = [44100, 48000, 32000];
  const bitrate = bitrates[bitrateIndex] * 1000;
  const sampleRate = sampleRates[sampleRateIndex];
  return { bytes: Math.floor(144 * bitrate / sampleRate) + padding, seconds: 1152 / sampleRate };
}

// Dữ liệu vào: MP3 gốc của bài thi.
// Việc chính: cắt đủ 30 giây đầu theo ranh giới frame MPEG.
// Kết quả: file nghe thử độc lập, không làm hỏng frame cuối.
// Khi lỗi: dừng build và báo byte lỗi; không phát hành file audio hỏng.
function createPreview(buffer, seconds = 30) {
  let firstFrame = 0;
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') {
    firstFrame = 10 + readSyncSafeInteger(buffer, 6);
  }
  let offset = firstFrame;
  let duration = 0;
  while (duration < seconds) {
    const frame = frameInfo(buffer, offset);
    if (!frame || offset + frame.bytes > buffer.length) {
      throw new Error(`Không đọc được frame MP3 tại byte ${offset}.`);
    }
    offset += frame.bytes;
    duration += frame.seconds;
  }
  return buffer.subarray(0, offset);
}

async function main() {
  const [contentModule, audioFile, outputRoot] = process.argv.slice(2);
  if (![contentModule, audioFile, outputRoot].every(Boolean)) {
    throw new Error('Cách dùng: node create-protected-cbt-assets.mjs <content.mjs> <audio.mp3> <output-root>');
  }

  const imported = await import(pathToFileURL(path.resolve(contentModule)).href + `?build=${Date.now()}`);
  const content = structuredClone(imported.default);
  const slug = String(content?.baseTestSlug || '');
  if (!slug || content?.variant !== 'semantic-html') {
    throw new Error('Module nội dung không trả về đề semantic-html hợp lệ.');
  }
  content.audio = { ...(content.audio || {}), src: '' };

  const target = path.resolve(outputRoot, slug);
  await fs.promises.mkdir(target, { recursive: true });
  const audio = await fs.promises.readFile(path.resolve(audioFile));
  await Promise.all([
    fs.promises.writeFile(path.join(target, 'content.json'), JSON.stringify(content), 'utf8'),
    fs.promises.writeFile(path.join(target, 'listening-audio.mp3'), audio),
    fs.promises.writeFile(path.join(target, 'listening-preview-30s.mp3'), createPreview(audio))
  ]);
  process.stdout.write(`${JSON.stringify({ ok: true, slug, output: target, audioBytes: audio.length })}\n`);
}

main().catch(error => {
  process.stderr.write(`Không thể tạo tài nguyên CBT riêng: ${error.message}\n`);
  process.exitCode = 1;
});
