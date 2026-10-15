import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const AUDIO_MAGIC = Buffer.from('IZTT1', 'ascii');
const SESSION_KEY_INFO = Buffer.from('izone-term-test-session-audio-v1', 'utf8');
const ASSETS = Object.freeze({
  'term-test-1': Object.freeze({
    content: 'term-test-1/content.json',
    audio: 'term-test-1/listening-audio.mp3',
    preview: 'term-test-1/listening-preview-30s.mp3',
    listeningDurationSeconds: 1735,
    listeningReviewSeconds: 120,
    readingDurationMinutes: 60,
    writingDurationMinutes: 40
  }),
  'term-test-2': Object.freeze({
    content: 'term-test-2/content.json',
    audio: 'term-test-2/listening-audio.mp3',
    preview: 'term-test-2/listening-preview-30s.mp3',
    listeningDurationSeconds: 1844,
    listeningReviewSeconds: 120,
    readingDurationMinutes: 60,
    writingDurationMinutes: 60
  }),
  'mini-test-lesson-5': Object.freeze({
    content: 'mini-test-lesson-5/content.json',
    audio: 'mini-test-lesson-5/listening-audio.mp3',
    preview: 'mini-test-lesson-5/listening-preview-30s.mp3',
    listeningDurationSeconds: 972,
    listeningReviewSeconds: 120,
    readingDurationMinutes: 20,
    writingDurationMinutes: 0
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
      listeningTotalSeconds: definition.listeningDurationSeconds + definition.listeningReviewSeconds,
      readingDurationMinutes: definition.readingDurationMinutes,
      writingDurationMinutes: definition.writingDurationMinutes
    };
  }

  function supports(testSlug) {
    return Boolean(ASSETS[testSlug]);
  }

  function getSessionAudioKey(testSlug, sessionToken) {
    getDefinition(testSlug);
    return deriveSessionAudioKey(sessionSecret, sessionToken);
  }

  async function getAudioManifest(testSlug) {
    const hash=crypto.createHash('sha256');let byteLength=0;
    for await(const chunk of fs.createReadStream(resolveAsset(assetDir,getDefinition(testSlug).audio))){hash.update(chunk);byteLength+=chunk.length;}
    const sha256=hash.digest('hex');
    return {assetVersion:`sha256-${sha256}`,sha256,byteLength,
      encryptedByteLength:byteLength+33,envelopeVersion:'IZTT1'};
  }

  async function streamEncryptedAudio(testSlug, sessionToken, response, expectedManifest=null) {
    if(response.destroyed||response.writableEnded)return;
    const definition = getDefinition(testSlug);
    const sourcePath = resolveAsset(assetDir, definition.audio);
    // Hash và mã hóa theo luồng để không giữ thêm cả file cho mỗi học viên đang tải.
    // Nếu file đổi đúng giữa hai bước, hash plaintext bắt buộc ở client vẫn chặn phát sai.
    if(expectedManifest){
      const current=await getAudioManifest(testSlug);
      if(response.destroyed||response.writableEnded)return;
      if(current.byteLength!==expectedManifest.byteLength||current.sha256!==expectedManifest.sha256){
        response.status(409).set('Cache-Control','no-store, private').json({ok:false,error:'AUDIO_ASSET_CHANGED',message:'Audio trên máy chủ đã đổi. Giữ bài và nhờ giáo viên hỗ trợ.'});return;
      }
    }
    const stat = await fs.promises.stat(sourcePath);
    if(response.destroyed||response.writableEnded)return;
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
      let settled=false;
      const finish = error => {
        if(settled)return;settled=true;
        response.removeListener('close',closed);response.removeListener('error',fail);
        source.destroy();cipher.destroy();
        if(error&&!response.headersSent)reject(error);
        else{if(error)response.destroy();resolve();}
      };
      const fail = error => finish(error);
      const closed = () => {if(!response.writableFinished)finish();};
      source.once('error', fail);
      cipher.once('error', fail);
      cipher.on('data', chunk => { if(!response.write(chunk)){cipher.pause();response.once('drain',()=>cipher.resume());} });
      response.once('close',closed);response.once('error',fail);
      cipher.once('end', () => {
        if(settled)return;
        response.end(cipher.getAuthTag());
        finish();
      });
      if(response.destroyed||response.writableEnded){finish();return;}
      source.pipe(cipher);
    });
  }


  // Audio đề thật chỉ được route demo có đăng nhập/quyền lớp gọi; hỗ trợ tua bằng Range.
  async function streamDemoAudio(testSlug, request, response) {
    const sourcePath = resolveAsset(assetDir, getDefinition(testSlug).audio);
    const { size } = await fs.promises.stat(sourcePath);
    const range = request.headers.range;
    let start = 0, end = size - 1;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match || Number(match[1]) >= size || (match[2] && Number(match[2]) < Number(match[1]))) {
        response.set('Content-Range', `bytes */${size}`);
        response.status(416).end(); return;
      }
      start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : end;
      response.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    response.set({ 'Content-Type':'audio/mpeg', 'Content-Length':String(end-start+1),
      'Accept-Ranges':'bytes', 'Cache-Control':'no-store, private' });
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(sourcePath, { start, end });
      stream.once('error', reject); response.once('close', () => { stream.destroy(); resolve(); });
      response.once('finish', resolve); stream.pipe(response);
    });
  }

  return { supports, getContent, getPreview, getTiming, getAudioManifest, getSessionAudioKey, streamEncryptedAudio, streamDemoAudio };
}

export const termTestAudioEnvelope = Object.freeze({
  magic: AUDIO_MAGIC.toString('ascii'),
  ivBytes: 12,
  tagBytes: 16
});
