-- Dữ liệu vào: phiên Listening đã có trước cơ chế tiếp tục audio.
-- Việc chính: bổ sung các cột checkpoint theo schema production hiện hành.
-- Kết quả: phiên cũ giữ thời gian đã nghe bằng 0 và trạng thái sẵn sàng.
-- Khi lỗi: PostgreSQL dừng migration, không thay đổi lượt bài hay điểm.
ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN IF NOT EXISTS listening_audio_checkpoint_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS listening_audio_checkpoint_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS listening_audio_state TEXT NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS listening_recovery_seconds INTEGER NOT NULL DEFAULT 0;
