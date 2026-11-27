BEGIN;
ALTER TABLE learning.assignment_live_change
  DROP CONSTRAINT assignment_live_change_scope_check,
  ADD CONSTRAINT assignment_live_change_scope_check
    CHECK (scope IN ('dashboard','drafts','analytics','checkpoint_analytics'));

-- Cùng transaction với bản nộp. record_live_change giữ một revision/phiếu/transaction.
CREATE TRIGGER teacher_checkpoint_analytics
AFTER INSERT OR UPDATE OR DELETE ON learning.checkpoint_submission
FOR EACH ROW EXECUTE FUNCTION learning.capture_live_change('checkpoint_analytics');

-- Khi đổi attempt hiện hành, không giữ bản nộp từ attempt bị thay thế trên màn đang mở.
CREATE TRIGGER teacher_checkpoint_analytics_attempt
AFTER UPDATE OF status ON learning.attempt
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status
  AND (OLD.status = 'superseded' OR NEW.status = 'superseded'))
EXECUTE FUNCTION learning.capture_live_change('checkpoint_analytics');
COMMIT;
