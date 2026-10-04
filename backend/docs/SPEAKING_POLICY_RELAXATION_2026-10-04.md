# Speaking Homework khóa 67 — giảm yêu cầu ngày 04/10/2026

Theo yêu cầu đã duyệt của Đức: IC2304 Lesson 4, mã `67-speaking-diem_giua`, ERP class 1293, Classroom course `826336470852`, courseWork `888655404214`, phần Freestyle yêu cầu một câu hoàn chỉnh thay ba câu. Các phần/lớp khác giữ ngưỡng; hai bài bổ trợ của Lesson 4 vẫn bắt buộc.

Backend và Pages ngừng đánh giá nói hay gõ, ngừng chặn chốt bài/bài bổ trợ bằng cảnh báo giọng nói. Trường lịch sử và endpoint tương thích tab cũ được giữ; không tự ghi học viên đã dùng voice. Trang giảng viên bỏ cảnh báo này.

Production: image `izone-speaking-relax:20261004-v1` phủ đúng ba module Speaking lên exact live image `sha256:1fdaca6048a223d5b6db2e8247b65964662767b2de6e61a631176acb5fcb11a2`. API healthy; env, mounts, host config và hash mọi source ngoài Speaking được đọc lại không đổi. Không suy mã Git cũ tương đương toàn bộ image live. Pages PR #51, main `485ea69d99cf5de59ded29426e1b3773f5921e02`, Action phát hành thành công.

Readback: một link hiện hành đã gửi được thông qua hành chính, có lý do/người duyệt/thời điểm trong evidence; giữ số câu thật và cờ voice cũ. Có chỉnh sửa đồng thời của học viên nên guard đã dừng link phiên bản 8, đọc lại rồi thông qua phiên bản 9. Không sửa phiên bản cũ.

10 bài: sáu đã nộp, bốn bản nháp chưa gửi hai bài bổ trợ; không tự miễn phần chưa gửi để tạo biên nhận. Đọc đủ 16 Docs, sáu ô của biên nhận thật có thông điệp và link đúng; không cần ghi lại. Không có practice chờ xác nhận giọng nói ở toàn bộ mã bài Speaking khóa 67 tại mốc kiểm.

Kiểm chứng: backend canonical 310/310; Pages Speaking 12/12 gồm 26 ca danh tính và desktop/mobile; image candidate 41/41 gồm Speaking và phiên đăng nhập/CSRF. Policy regression RED 3/5 trên base rồi GREEN 5/5. Fixture app cũ của image thiếu bảng phiên và Origin; đã chỉnh fixture theo contract live trong image kiểm riêng, giữ ca kiểm và source auth thật. SQL migration kiểm đúng phạm vi, chạy lại, sai phạm vi rollback. Đây là phạm vi thay đổi Speaking, không nghiệm thu lại toàn hệ thống điểm danh/Portal.

Migration chuẩn: repo mapping-db, `migrations/202610041418_speaking_ic2304_lesson4_one_question.sql`, Issue #37. Không đổi ERP active mapping 03/34/45. Evidence riêng tư: `E:/Codex-Data/speaking-relax-20261004`; backup VPS: `/opt/backups/speaking-relax-20261004`, container trước chuyển `mapping-review-api-before-speaking-relax-20261004`. Quay lui bằng container cũ và migration bù đúng phần; không restore dump đè bài mới. Git revert không tự quay lui production hoặc dữ liệu.
