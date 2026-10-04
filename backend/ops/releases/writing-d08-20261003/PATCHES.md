# Bằng chứng phần Writing thay đổi trong image K56

Hai file `*.patch.json` giữ nguyên từng dòng của bản so sánh trước/sau, kể cả ký tự xuống dòng gốc. Đọc trường `lines` rồi nối theo thứ tự bằng chuỗi rỗng sẽ khôi phục byte UTF-8 ban đầu; SHA256 phải khớp `original_sha256`. JSON giúp giữ nguyên các dòng trống và ký tự CR của source lịch sử trong Git. Hai bản đã được đọc lại và so khớp toàn bộ byte sau chuyển định dạng.

Các file này là bằng chứng so sánh. Adapter phát hành dùng đúng image bất biến trong `candidate.json`, kiểm lại hash mọi file source và cấu hình live trước thao tác. Không dựng lại candidate từ patch hoặc coi patch là bằng chứng Git đã dựng image gốc.

Bộ kiểm `exercise_canary_docker.py` chạy ba image candidate với PostgreSQL giả riêng trong mạng Internal, chỉ khởi tạo API bằng `createApp`. Bộ đếm chấm/Portal là giả, phải bằng 0. Receipt này chứng minh API/SQL/producer và cleanup fixture; production, browser, Apps Script và điểm danh vẫn có biên nhận riêng.

## Bổ sung quyền quản trị demo, Đức duyệt 04/10

`demo-admin.patch.json` giữ đúng diff của auth và SQL từ candidate D08 trước. Hai file được đọc lại trong image mới, 31 file source/package còn lại khớp byte. Admin có quyền toàn lớp từ role đã xác thực; giáo viên vẫn theo cờ/phân công. Nhãn lớp phân biệt được phân công và quyền quản trị. Không migration, sửa tài khoản hay thay grader/prompt. Cùng fixture SHA48c4c60d: RED6/8 trên image cũ, GREEN8/8 trên image mới; expanded11/11. Image bất biến trong candidate.json là đích mới; checkpoint bundle/production còn phải qua cổng.

## Hoàn thiện nhãn quyền và khóa lớp demo ngày 04/10

Đức duyệt sửa cả hai lỗi quản trị và chốt chỉ cho làm bài ở CODEXDEMO56. Patch demo gồm ba file auth/app/sql: admin từ role đã xác thực; OPTIONS và RESULTS giữ nhãn được phân công/quyền quản trị; middleware chặn lớp khác hoặc token attempt/session thuộc lớp khác trước đường học viên. Teacher và collector vẫn qua quyền/xác thực riêng. Không sửa tài khoản, phân công, bài thật hay database production.

Cùng fixture metadata RED11/15 → GREEN15/15; fixture lớp/auth/route thật RED18/21 → GREEN21/21, collector5/5 trên image cuối. Source/package33/33 đã đọc lại. Full239 lịch sử còn193pass/46fail, trong đó13regression D08 thiếu dữ liệu lớp nền mới; đã chuẩn bị fixture thêm đúng mapping CODEXDEMO56, giữ mọi assertion và log lỗi gốc, chưa chứng nhận full đạt. Image trong manifest chỉ là đích nghiệm thu tiếp; không phải cổng cho deploy.

Đánh giá ảnh hưởng: chỉ profile demo mở khóa lớp mới, nên link/token của lớp khác bị chặn403/404; API quản trị vẫn xem theo quyền. Mỗi thao tác mang token thêm một SELECT chỉ đọc và kiểm riêng token phiên nếu có. Không AI/Portal/Lark hoặc migration. Nếu sửa sai có thể chặn nhầm bài demo, nên các đường roster/prepare/token/session và hai Task phải được kiểm trên profile/image cuối. Hoàn tác bằng image cũ có checkpoint; không restore database hoặc replay request mất phản hồi. Production chưa đổi; các cổng public UI, điểm danh và quan sát vận hành vẫn đang chờ.
