# Speaking Homework: ERP web cho hai lớp mới

Đức cho dùng hồ sơ ERP đang học ở IC2340/1333 và IC2353/1345 để vào Speaking/Listening web, giữ ghép Google chờ duyệt. Không đổi quyền giảng viên.

Speaking thêm `webEntry` chỉ ở API nguồn nội bộ đã xác thực. Roster, nhớ danh tính, mở và đọc lại web work unit truyền đúng cờ; Docs/cầu nối có documentId giữ đường xác minh cũ. Source chỉ nhận pending_review cho hai lớp khi đăng ký on_going/source active, dùng đúng UUID và tên ERP. Phản hồi không cấp google_user_id cho ghép chưa approved. Các lớp khác giữ luật cũ.

Nguồn context thêm endpoint chỉ đọc `/v1/homework/erp-students` với khóa nguồn hiện hữu, no-store và view riêng của migration 202611020332. `/v1/snapshot` không đổi contract hoặc quyền của Term/Mini.

Kiểm: ca hồi quy lỗi cũ RED, source SQL PGlite GREEN; Speaking 34 đạt/2 native skip ở nhóm independent/bridge, sau sửa tên ERP 15 ca source/bridge đạt. Context contract/HTTP 12 ca đạt. Image cuối giữ source Speaking đã kiểm; kiểm image gồm phiên GV 90/365 và worker điểm danh/outbox. Không dùng kết quả fixture làm bằng chứng nộp AI/Docs thật.

Runtime đã phát riêng trên đúng image live, giữ các overlay Docs chỉ xem và kiểm hội thoại đang có. Cấu hình container/env/mount/mạng/resource limit trước–sau bằng nhau; source và backup riêng ở `/opt/izone-homework-erp-20261102`. Mapping cuối `b92e37a036a960507acea63c7963f543dec7b47ce2a8c326409fc4c6ef345dc7`, Speaking `192559b904c0a2ffd56652fd33ef18bef10b22078153487762cd8bf18d4f1781`, context source `19ff7627570a25d9fecfd743731004e4f2371bdabcd2c4bd0f388248ae0efbed`.

Readback public: đủ 19/19 và 18/18, UUID/tên khớp Portal. Trang giảng viên bằng tài khoản admin thật đọc được hai roster, chưa có work unit Paraphrase của hai lớp; không tạo phiên hoặc bài nộp thử. Ghép Google vẫn 14 approved/5 pending và 12 approved/6 pending. Hàng điểm danh giữ 230 complete/16 review_required tại mốc so; đây không phải outcome Portal mới.

Quay runtime tương thích bằng container trước bản sửa, giữ mọi dữ liệu mới; không restore DB. Git main và runtime là hai trạng thái riêng; branch chưa được merge không được dùng rebuild nguyên main để thay image đang chạy.
