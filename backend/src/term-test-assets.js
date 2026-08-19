import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const AUDIO_MAGIC = Buffer.from('IZTT1', 'ascii');
const SESSION_KEY_INFO = Buffer.from('izone-term-test-session-audio-v1', 'utf8');
const ASSETS = Object.freeze({
  'term-test-2': Object.freeze({
    content: 'term-test-2/content.json',
    audio: 'term-test-2/listening-audio.mp3',
    preview: 'term-test-2/listening-preview-30s.mp3',
    listeningDurationSeconds: 1844,
    listeningReviewSeconds: 120
  })
});

function resolveAsset(root, relativePath) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Đường dẫn tài nguyên Term Test không hợp lệ.');
  }
  return resolved;
}

function getDefinition(testSlug) {
  const definition = ASSETS[testSlug];
  if (!definition) throw new Error('Bài test chưa có tài nguyên được bảo vệ.');
  return definition;
}

function deriveSessionAudioKey(secret, sessionToken) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    Buffer.from(sessionToken, 'utf8'),
    SESSION_KEY_INFO,
    32
  ));
}

// Dữ liệu vào: thư mục tài nguyên riêng và bí mật chỉ có trên máy chủ.
// Việc chính: đọc đề sau khi phiên thi bắt đầu, phát bản nghe thử 30 giây và mã hóa audio riêng theo từng phiên.
// Kết quả: GitHub Pages không chứa đề/audio rõ; file tải ở phòng chờ chưa thể phát nếu chưa nhận khóa lúc bắt đầu.
// Khi lỗi: promise bị từ chối để middleware trả lỗi chung, không lộ đường dẫn hay bí mật máy chủ.
export function createTermTestAssetService({ assetDir, sessionSecret }) {
  if (!assetDir || !sessionSecret || sessionSecret.length < 32) {
    throw new Error('Tài nguyên Term Test cần thư mục riêng và bí mật phiên tối thiểu 32 ký tự.');
  }
  const contentCache = new Map();

  async function getContent(testSlug) {
    if (contentCache.has(testSlug)) return contentCache.get(testSlug);
    const definition = getDefinition(testSlug);
    const file = resolveAsset(assetDir, definition.content);
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (parsed?.baseTestSlug !== testSlug) throw new Error('Nội dung đề không khớp mã bài test.');
    contentCache.set(testSlug, parsed);
    return parsed;
  }

  async function getPreview(testSlug) {
    const definition = getDefinition(testSlug);
    return fs.promises.readFile(resolveAsset(assetDir, definition.preview));
  }

  function getTiming(testSlug) {
    const definition = getDefinition(testSlug);
    return {
      listeningDurationSeconds: definition.listeningDurationSeconds,
      listeningReviewSeconds: definition.listeningReviewSeconds,
      listeningTotalSeconds: definition.listeningDurationSeconds + definition.listeningReviewSeconds
    };
  }

  function getSessionAudioKey(testSlug, sessionToken) {
    getDefinition(testSlug);
    return deriveSessionAudioKey(sessionSecret, sessionToken);
  }

  async function streamEncryptedAudio(testSlug, sessionToken, response) {
    const definition = getDefinition(testSlug);
    const sourcePath = resolveAsset(assetDir, definition.audio);
    const stat = await fs.promises.stat(sourcePath);
    const key = deriveSessionAudioKey(sessionSecret, sessionToken);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    response.status(200);
    response.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="listening-audio.iztt"',
      'Content-Length': String(AUDIO_MAGIC.length + iv.length + stat.size + 16),
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff'
    });
    response.write(AUDIO_MAGIC);
    response.write(iv);

    await new Promise((resolve, reject) => {
      const source = fs.createReadStream(sourcePath);
      const fail = error => reject(error);
      source.once('error', fail);
      cipher.once('error', fail);
      cipher.on('data', chunk => response.write(chunk));
      cipher.once('end', () => {
        response.end(cipher.getAuthTag());
        resolve();
      });
      source.pipe(cipher);
    });
  }

  return { getContent, getPreview, getTiming, getSessionAudioKey, streamEncryptedAudio };
}

export const termTestAudioEnvelope = Object.freeze({
  magic: AUDIO_MAGIC.toString('ascii'),
  ivBytes: 12,
  tagBytes: 16
});
