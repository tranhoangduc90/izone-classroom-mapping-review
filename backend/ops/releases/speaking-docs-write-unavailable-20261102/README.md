# Speaking Docs: phân biệt sai tài liệu và không thể ghi

Google Docs GET có thể đọc đúng document ID nhưng không trả `revisionId` khi người gọi không sửa được tài liệu. Planner trước đây gán chung trường hợp này thành `DOC_IDENTITY_MISMATCH`, khiến việc điều tra đi sai hướng.

Planner hiện giữ kiểm ID trước, sau đó trả `DOC_WRITE_UNAVAILABLE` nếu thiếu revision. Worker tiến độ dừng tại `blocked`, giữ payload đang chờ, bản đã áp dụng và thời điểm xác minh cũ. Không tạo revision giả, nới kiểm chủ bài, ghi đè nội dung hoặc đánh dấu đồng bộ thành công.

Chỉ retry đúng unit sau khi xác minh nguồn, chủ và quyền sửa thực tế đã phục hồi. Worker vẫn đọc revision hiện hành, chỉ cập nhật ô Speaking đã quản lý và xác minh lại nội dung cùng hyperlink sau ghi. Drive `role=writer` hoặc `canEdit=true` riêng lẻ chưa chứng minh Google Docs cho phép chỉnh sửa.

## Kiểm thử

- Tái hiện RED: Doc đúng ID, thiếu revision bị trả lỗi identity; worker cũng báo sai lỗi.
- GREEN: thiếu revision trả lỗi ghi, sai ID vẫn trả lỗi identity kể cả khi thiếu revision.
- Worker không gọi write, không xác nhận sequence và không thay payload/last/attempt metadata khi chỉ xem; khôi phục quyền rồi retry ghi bằng revision hiện hành, đọc lại thành công và không tạo receipt.
- Bộ Speaking của source: 259 ca, 257 đạt, 2 ca PostgreSQL đồng thời bỏ qua; không có ca lỗi.
- Bộ liên quan trên exact-live candidate: 60 ca, 58 đạt, 2 ca PostgreSQL đồng thời bỏ qua; không có ca lỗi.

## Production

Đã phát overlay đúng hai module `speaking-independent-status.js`, `speaking-progress-docs.js` trên image Speaking hiện hành, giữ config, network, mount và toàn bộ module khác. Không đổi luật công nhận bài hoặc dịch vụ khác.

- Base: `sha256:059e55ec5c87a499c03544deb6d5b8383e7cbaf9f0f2123f0b0ada8b502075b3`
- Candidate: `sha256:ab98805a257f83c06c33d2ad70f00b4580559b664f85061ff52d9953ba0663f0`
- Rollback container còn giữ, đã dừng: `speaking67-independent-api-before-docs-nhi-20261102`
- Health sau đổi: `ok=true`, `docsReadMode=direct`.

Canary mục tiêu đã requeue đúng một unit: lỗi cũ được thay bằng `DOC_WRITE_UNAVAILABLE`; Google vẫn từ chối ghi. Không coi đây là Docs đã đồng bộ. Dữ liệu định danh, phản hồi Google, hash bảo toàn và kết quả từng bước lưu riêng ở `E:/Codex-Data/speaking67-docs-nhi-20261102/`, không đưa bài làm vào repository.

Tham chiếu API: [Google Docs document resource — revisionId](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents).
