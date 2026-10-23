// Đầu vào là ngữ cảnh audio đã được bên cấp quyền xác nhận. Tạo phạm vi khóa
// và AAD bất biến; không nhận token đăng nhập gốc hay sửa trạng thái bài học.
export const MAGIC = new TextEncoder().encode('IZAP1');
export const CHUNK_SIZES = [524288, 1048576, 2097152];
export const REVISION = 'cf-chunks-lab-20261023-v2';
export const encoder = new TextEncoder();
export function keyContext(c) {
  return JSON.stringify([1,c.product,c.classId,c.testId,c.owner,c.sid,c.generation,c.purpose,c.assetHash,c.downloadId]);
}
export function partContext(c, size, index, length) {
  return encoder.encode(JSON.stringify([keyContext(c),size,index,index*size,length]));
}
export async function deriveAudioKey(secret, c, usages) {
  const material=await crypto.subtle.importKey('raw',encoder.encode(secret),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode(c.sid),info:encoder.encode('izone-audio-parts-v1:'+keyContext(c))},material,{name:'AES-GCM',length:256},false,usages);
}
export function decodeBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('BAD_BASE64URL');
  return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
}
export async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
}
