import { createHash } from 'node:crypto';

// Nhận đúng hội thoại đã kiểm; giữ nguyên lời nói, bỏ metadata không dùng cho phân tích.
// Trả bản chụp và mã nội dung. Dữ liệu sai làm transaction công nhận rollback.
export function conversationSnapshot(conversation) {
  const messages = conversation?.messages?.filter(m => ['user', 'assistant'].includes(m?.role)
    && typeof m.text === 'string' && m.text.trim()).map(m => ({ role: m.role, text: m.text }));
  if (!messages?.length || messages.some(m => !m.text.isWellFormed() || m.text.includes('\u0000'))
    || messages.reduce((n, m) => n + m.text.length, 0) > 80_000) throw new Error('DOCTOR_SNAPSHOT_INVALID');
  const fingerprint = createHash('sha256').update(messages.map(m => `${m.role}\u0000${m.text.trim()}`).join('\u0001')).digest('hex');
  return { messages, fingerprint };
}

function table(schema, kind) {
  if (schema === 'speaking_independent') return 'speaking_independent.conversation_snapshot';
  if (schema === 'speaking_homework' && kind === 'main') return 'speaking_homework.main_conversation_snapshot';
  if (schema === 'speaking_homework' && kind === 'practice') return 'speaking_homework.practice_conversation_snapshot';
  throw new Error('DOCTOR_SNAPSHOT_SCOPE_INVALID');
}

// Chỉ thêm một bản cho đúng ID link; không sửa bản chụp, bài accepted hoặc receipt.
export async function saveConversationSnapshot(db, schema, kind, linkId, fingerprint, snapshot) {
  if (!snapshot) return; // Tương thích bài lịch sử và đường nội bộ cũ không có bản chụp.
  const checked = conversationSnapshot(snapshot);
  if (checked.fingerprint !== fingerprint) throw new Error('DOCTOR_SNAPSHOT_FINGERPRINT_INVALID');
  await db.query(`INSERT INTO ${table(schema, kind)}(link_id, original_fingerprint, fingerprint, messages)
    VALUES($1,$2,$2,$3) ON CONFLICT(link_id) DO NOTHING`, [linkId, fingerprint, JSON.stringify(checked.messages)]);
  const { rows: [stored] } = await db.query(`SELECT fingerprint, original_fingerprint FROM ${table(schema, kind)} WHERE link_id=$1`, [linkId]);
  if (stored.fingerprint !== fingerprint || stored.original_fingerprint !== fingerprint) throw new Error('DOCTOR_SNAPSHOT_CONFLICT');
}

// Worker chỉ đọc bản đúng link và mã bài đã nhận. Bản phục hồi có dấu nguồn riêng.
// Không có bản lịch sử thì trả null để dùng kiểm Share cũ; bản hỏng không được bỏ qua.
export async function readConversationSnapshot(db, schema, kind, linkId, fingerprint) {
  if (!linkId) return null;
  const { rows: [row] } = await db.query(`SELECT * FROM ${table(schema, kind)} WHERE link_id=$1`, [linkId]);
  if (!row) return null;
  const snapshot = conversationSnapshot(row);
  if (row.original_fingerprint !== fingerprint || row.fingerprint !== snapshot.fingerprint
    || (row.source === 'accepted' && row.fingerprint !== row.original_fingerprint)
    || (row.source === 'revalidated' && !row.recovery_job_id)) throw new Error('DOCTOR_SNAPSHOT_FINGERPRINT_INVALID');
  return { messages: snapshot.messages, source: row.source, fingerprint: snapshot.fingerprint };
}
