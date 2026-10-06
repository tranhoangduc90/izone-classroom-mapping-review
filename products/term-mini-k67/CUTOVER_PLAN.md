# Lát chuyển một chủ ghi K67

Đích đã dựng: backend và kho bài K67 riêng. K56 tiếp tục dùng runtime/tuyến
hiện tại. Lát chuyển đã thực hiện ngày 06/10/2026; biên nhận tại RELEASE_STATUS.md.

## Giữ tương thích cho bên gọi cũ

- Giữ đường `/mapping-api/api/term-tests/` cho học viên, chuyển đúng phần này
  tới K67. Token, nháp, thời hạn và khóa audio được giữ qua migration.
- Giữ đúng POST `/mapping-api/api/mini-tests/results`. Cổng chuyển đổi khóa
  cũ thành khóa K67 mới chỉ tại endpoint này; khóa sai không được chuyển đổi.
  Chưa tìm đủ caller cũ nên không gỡ endpoint chỉ vì không thấy trong n8n.
- Giảng viên tải lại trang để đăng nhập phiên K67 riêng. Endpoint teacher cũ
  trả thông báo tải lại, tránh lặp đăng nhập bằng cookie của backend chung.
  Không chuyển `/mapping-api/api/auth/`, vì những sản phẩm khác cũng dùng nó.
- Workflow nhận/chấm K67 mới chỉ gọi HTTPS 18869 và Redis K67. Hai parent
  Term Test nguồn được dừng đúng ID sau khi hết lượt đang chạy; writer nguồn
  còn phục vụ Writing khác được giữ nguyên.

## Thứ tự chuyển

1. Chuẩn bị snippet tuyến và bộ đổi khóa riêng, kiểm parser/scope và Nginx.
   Vhost443 chỉ bổ sung một include trong đúng server; không sửa tuyến K56,
   Progress Log, Speaking hoặc toàn bộ `/mapping-api/`.
2. Đọc lại lượt Nghe/Đọc/Viết, lease chấm và execution của hai parent. Nếu còn
   chạy thì tiếp tục các phần chuẩn bị và đợi drain; không chuyển token dở.
3. Tạm giữ đúng tuyến ghi K67, kiểm drain và dừng hai parent nguồn. Khóa ghi
   đúng 13 bảng K67 nguồn bằng trigger có nhãn sở hữu; không khóa schema
   `assessment_k56` hoặc năm bảng Writing khác. Chụp snapshot nhất quán mới
   và phục hồi vào kho K67 đang trống.
4. So hash/ID/nháp/điểm của từng bảng, 15 liên kết, bộ đếm và trigger lịch sử.
   Sau đạt mới chuyển tuyến cũ, bật đúng parent/writer K67 và publish 9 trang.
5. Kiểm bằng mô phỏng và đọc lại side effect. Không ghi điểm giả vào Portal
   thật; kết quả chấm và fault đã có diễn tập native với Portal giả.

## Bảo toàn cấu hình và quay lại

File cổng chung cần giữ exact backup. Không dùng đọc hash rồi thay file để
tuyên bố compare-and-swap nguyên tử. Công cụ dùng trao đổi hai file nguyên
tử và giữ inode/bản bị đổi thành artifact; kiểm bản thực sự lấy ra trước reload.
Nếu phát hiện sửa ngoài task, giữ các bản, không ghi đè để hòa giải tự động.
Chỉ một tiến trình task được sửa cùng nguồn; thao tác này vẫn không khóa được
mọi người quản trị root ở ngoài quy trình, nên kiểm cả trước/sau reload.

Trước khi có ghi mới ở K67, có thể trả tuyến về nguồn chỉ khi hash dữ liệu đích
vẫn bằng snapshot đã chép, không có job/ghi đang chạy. Sau khi có ghi mới,
quay lại runtime phải giữ kho K67 mới; không trả về snapshot cũ làm mất bài
hoặc chấm lại lịch sử. Không xóa dữ liệu nguồn hoặc artifact để kết thúc.

## Sau chuyển: giữ một nơi ghi và phát triển tiếp

- K67 ghi vào `term-mini-k67-postgres`, DB `term_mini_k67`; nguồn 13 bảng cũ
  giữ chỉ đọc. Không bật lại hai parent nguồn hoặc gỡ fence khi chưa có kế
  hoạch chuyển dữ liệu ngược đã đối soát.
- K56/Linh dùng runtime `izone-k56-ic2264-api` và tuyến `/mapping-api-k56/`
  hiện có. Backend chung còn phục vụ sản phẩm khác; không dựng lại nó để
  phát hành K67. Writer Writing nguồn được giữ vì còn phục vụ luồng khác.
- K67 có cookie giảng viên riêng. Người đang mở trang teacher cũ tải lại
  trang rồi đăng nhập; không chuyển cookie của các sản phẩm dùng chung.
- Bộ chấm K67 dùng Redis riêng, credential riêng và HTTPS 18869; ba workflow
  nhận bài/poll/gửi điểm bật, các child gọi nội bộ giữ inactive như thiết kế.
- Lớp/quyền vẫn phụ thuộc API ngữ cảnh có phiên bản trên hạ tầng chung. Bản
  mirror làm mới mỗi 30 giây; quá hạn 120 giây thì từ chối dùng quyền cũ.
  VPS, n8n, AI và Portal vẫn là tài nguyên/dịch vụ chung có giới hạn riêng.

## Quay lại runtime mà giữ bài mới

Đã kiểm đổi API18869 sang runtime K67 thứ hai trên cùng image/source và kho
production, rồi trả về runtime chính. Ba kết quả mô phỏng sau chuyển giữ
nguyên; runtime thử đã dừng. Đây là bằng chứng đổi tuyến/giữ kho, không phải
bằng chứng tương thích với một bản nghiệp vụ khác chưa được kiểm.

Công cụ `rehearse-production-release.py` lưu intent trước đổi tuyến và dừng
container. Nếu lỗi forward, nó chỉ trả tuyến khi file vẫn đúng bản task sở
hữu; nếu người khác sửa file, giữ nguyên và báo unknown. Resume sau gián
đoạn ưu tiên phục hồi, không replay bài hoặc forward lại. Khôi phục thành
công sau lỗi vẫn ghi lỗi gốc, không được gọi diễn tập đạt.

Khi phát hành tiếp, dựng image K67 từ source đã ghim và env K67 riêng. Khóa
audio tương thích đã được lưu riêng; không lấy lại từ backend chung ở mỗi
lần dựng. Trước đổi bản nghiệp vụ, kiểm hợp đồng/schema và hành trình liên
quan trên preview riêng; khi quay lại giữ DB K67 mới. Không chạy lại helper
bootstrap/restore, chép dump cũ lên dữ liệu mới hoặc chấm lại lịch sử.
