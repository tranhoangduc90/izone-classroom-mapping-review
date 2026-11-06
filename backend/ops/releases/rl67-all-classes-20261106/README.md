# Mở Reading/Listening cho toàn khóa 67 — 06/11/2026

Đức yêu cầu mọi bài Reading/Listening Homework và thực chiến được mở cho toàn khóa 67. Phạm vi ERP được truy vấn trực tiếp trong lượt này: course 5, `on_going`, chưa xóa; có 11 lớp. Giữ quyền lớp cũ, bài làm, cấu hình chấm, audio, đồng hồ và các link cá nhân đã giao.

## Danh mục và phạm vi

| Nhóm | Số bài | Cách mở |
| --- | ---: | --- |
| Reading Homework | 6 | Quyền lớp và policy chủ Docs của từng bài |
| Listening Homework | 5 | Quyền lớp và policy chủ Docs của từng bài |
| Reading thực chiến | 7 | Catalog link chung, lớp/roster từ nguồn K67 |
| Listening thực chiến | 4 | Catalog link chung, lớp/roster từ nguồn K67 |

11 lớp tại thời điểm đối chiếu: IC2213, IC2228, IC2238, IC2262, IC2270, IC2273, IC2304, IC2314, IC2340, IC2353, IC2363. Đây là ảnh nguồn ERP, không phải danh sách lớp cố định để chép cho lần sau. Mở lớp không tự duyệt tài khoản Google, tạo hồ sơ học viên hoặc giao bài Classroom.

## Thay đổi

- Scandinavian Studies thiếu IC2363 trong `allowedClassIds` và policy chủ Docs. Bổ sung đúng lớp đã được ERP/mapping xác nhận.
- Sáu Reading Homework đã có IC2363 trong danh sách lớp, nhưng policy chủ Docs còn thiếu. Bổ sung đúng cặp ERP class/code và Classroom course đã approved cho cả sáu bài.
- The Steam Car (Reading Buổi 7) và Science Experiment (Listening Buổi 8) trước đây chỉ có assignment cá nhân IC2304. Mở thêm catalog chung trên content/version cũ. Listening chỉ thêm metadata công khai của Buổi 8, giữ engine MCQ/Flow-chart và thời gian cũ.
- Khi vào link chung của hai bài cũ, học viên đã có bản Homework cá nhân được đưa vào đúng binding, Docs và lịch sử hiện có; chưa có binding thì dùng chế độ shared trên assignment cùng lớp/content. Assignment nguồn cũ, nội dung, bài làm và job Docs không bị chuyển hoặc tạo lại. Nhánh này chỉ áp dụng hai mã legacy, không nới điều kiện bài khác.

Link chung mới:

- [Reading Buổi 7 — The Steam Car](https://tranhoangduc90.github.io/izone-ai-team-pages/reading-practice/?lesson=7).
- [Listening Buổi 8 — Science Experiment](https://tranhoangduc90.github.io/izone-ai-team-pages/listening-practice/?lesson=8).

## Kiểm chứng

Tám ca hành vi mới đều đạt trên source chính và trên bản source trích trực tiếp từ image live rồi ghép đúng phần sửa. Mười ca hồi quy shared-entry Reading/Listening đều đạt. Không cộng hai lượt chạy tám ca thành 16 ca độc lập. Ca lỗi setup đầu tiên (tên cột fixture/migration thiếu trong image) đã được sửa ở môi trường kiểm, không chạy SQL sửa schema production.

Audit HTTP chỉ đọc cuối cùng: **22 bài × 11 lớp, đủ 242 roster**; tổng 275 request catalog/config/roster, không còn lỗi thiếu lớp hoặc owner policy. ERP được truy vấn lại sau rollout vẫn đúng 11 lớp. Chrome thật đã thấy Scandinavian Studies, Listening Buổi 8 và Reading Buổi 7 với IC2363 cùng bảy tên hợp lệ; không chọn tên, tạo phiên hoặc bắt đầu/nộp/chấm thay học viên. Báo cáo đã làm sạch nằm tại `scope-report.json`.

**Production đã hoàn tất cả bốn nhóm.** Reading thực chiến chỉ chuyển sau khi không còn lease học viên đang hoạt động qua hai lần đọc liên tiếp; không ép dừng lượt đang làm. Hai runtime thực chiến giữ nguyên hash/count của assignment, binding, content, work và operation; mỗi database chỉ thêm một hàng catalog `shared_lesson` cho bài legacy. Học viên còn thiếu mapping hợp lệ vẫn giữ chờ, không được tự tạo hoặc duyệt chỉ để làm đầy roster.

## Runtime và bảo toàn

Homework chỉ sửa hai file cấu hình đang được bind thực tế rồi restart đúng hai container. Tất cả trường ngoài tám đường cấu hình lớp/owner policy giữ nguyên. Không thay image Homework. Bản ghi nháp/lượt/kết quả/binding/validation có count/hash trước và sau khớp.

Hai API thực chiến dùng overlay từ đúng image live, không rebuild từ toàn main. Chỉ thay `sharedLogin` trong service Reading/Listening và metadata `lessons.js` Listening. Các bản vá đang chạy khác trong service được giữ nguyên. Khi tái tạo container, so nguyên cấu hình env, user, command, mount, mạng, port, giới hạn tài nguyên và quyền filesystem; giữ container cũ để quay lui. Chỉ mở thêm một hàng `shared_lesson` ở mỗi database, không seed lại content hoặc tạo assignment/binding/bài làm cho học viên thật.

Không thay Mapping API chung, Term/Mini, Progress Log, quyền giáo viên, n8n, Docs nguồn hoặc lịch đồng bộ. Không chứng nhận Google/AI/Docs/Portal đầu cuối từ các phép kiểm roster này.

## Backup và quay lui

Kho riêng trên laptop: `E:/Codex-Data/rl67-all-classes-20261106/`, gồm config exact trước/sau, Docker inspect private, source live, candidate, build log, SQL/API snapshot, kiểm và receipt. Không đưa secret, raw roster/bài làm hoặc credential vào Git. Bản remote: `/opt/izone-rl67-all-classes-20261106/`; Homework giữ thêm file `.before-rl67-all-classes-20261106` cạnh cấu hình active.

Nếu cần quay code: đọc dữ liệu/lượt đang hoạt động trước, dùng container/image trước chuyển hoặc overlay tương thích. Không restore database cũ. Đóng catalog chung nếu cần chặn lượt mới vẫn phải giữ các phiên/bài đã có; không xóa shared binding hoặc chuyển về bản cá nhân để quay lại. Với Homework, khôi phục đúng byte config được sao lưu vào cùng inode bind rồi restart service tương ứng, giữ mọi bài/nháp phát sinh.

Lần sau mở lớp/bài: lấy ERP và mapping hiện hành, bổ sung đồng thời danh sách lớp **và** policy chủ Docs của mọi lesson; lấy cấu hình live làm baseline, không phục hồi config mốc cũ hoặc dùng số lớp của hồ sơ này làm luật.
