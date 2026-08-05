-- Mục đích: cho phép giảng viên sửa mapping đã duyệt hoặc đưa phiếu về Chờ duyệt.
-- Dữ liệu nhận vào: không nhận tham số và không thay đổi các mapping hiện có.
-- Kết quả: lịch sử quyết định chấp nhận thêm hai thao tác edit_mapping và reopen.
-- Lỗi: PostgreSQL rollback toàn bộ transaction; dữ liệu duyệt hiện tại không bị sửa dở dang.

BEGIN;

ALTER TABLE mapping.mapping_decision_event
  DROP CONSTRAINT IF EXISTS mapping_decision_event_decision_check;

ALTER TABLE mapping.mapping_decision_event
  ADD CONSTRAINT mapping_decision_event_decision_check
  CHECK (decision IN (
    'approve',
    'reject',
    'choose_another',
    'edit_mapping',
    'reopen'
  ));

COMMIT;
