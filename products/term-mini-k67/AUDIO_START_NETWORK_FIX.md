# K67 — sửa mất phản hồi bắt đầu và quota chung mạng

Ngày 15/10/2026. Chỉ bản local; chưa merge/push/production. Hồ sơ lát 4 là kết quả lịch sử trước bản sửa này.

## Hành vi sau sửa

Client K67 mới gửi `audioStartGuardVersion=1` cùng protocol bảo vệ audio. Máy chủ ghi bắt đầu và mở incident giữ bài trong **cùng giao dịch**. Nếu phản hồi mất hoặc lỗi sau commit, phiên đã được giữ; retry/reload trả cùng incident. Trình duyệt dùng cơ chế prepare → player thực sự tiến → confirm hiện có trước khi mở làm bài. Thời gian chờ được bù một lần theo trần 900 giây; vượt trần giữ bài để giáo viên xử lý.

Không thêm thao tác cho lần bắt đầu bình thường: học viên đã thử tiếng ở phòng chờ. Nếu player không phát được, màn hình giữ bài cùng các nút thử tiếng/tiếp tục hiện có. Tất cả vẫn trên một dòng tiêu đề; không thay CSS hoặc tạo hàng mới.

Backend cũ chưa hiểu handshake mới vẫn giữ hành vi cũ. Backend mới vẫn nhận client cũ; không nâng protocol giữa phiên đã bắt đầu. Vì vậy rollout phải chuyển backend tương thích trước, frontend/revision sau; tab dùng bootstrap cũ chưa tự có bảo vệ start mới cho đến khi nạp bản mới. Không tắt cờ hoặc ép reload giữa một phiên đang thi để áp dụng thay đổi.

## Quota theo phiên đã xác minh

`exam-rate-limit.js` chỉ chọn ngân sách riêng sau khi SQL tìm đúng session/attempt, đề và generation khi có. Áp dụng cho các POST điều khiển đã xác minh và GET audio/nghe thử có token trong path. Các ngưỡng hiện tại giữ nguyên: global 900, đọc 240, ghi 120, nháp 600 và audio 300 mỗi phút. Các đường này không dùng chung ngân sách với học viên khác chỉ vì cùng Wi-Fi. Quyền owner, generation, hold và lưu/nộp vẫn được kiểm tại handler và trigger DB; định danh quota không cấp quyền làm bài.

Token sai/thiếu/khác đề hoặc generation không được tạo bộ đếm riêng. Chúng trở lại ngân sách IP; token lạ còn có giới hạn tra cứu 900/phút/IP trước DB. Bằng chứng token đã được SQL xác minh chỉ được nhớ để chọn quota, tối đa 20.000 mục/8 giờ; hết hạn/loại khỏi bộ nhớ phải tra lại. Không cache quyền truy cập, khóa audio hoặc nội dung bài.

Đợt công kích token lạ có thể chặn việc xác minh **phiên chưa được biết đến** trên cùng mạng cho đến cửa sổ tiếp theo; các phiên đang được biết vẫn có lane điều khiển và kiểm quyền nghiệp vụ. Mở phiên ban đầu không token tiếp tục chịu ngân sách ghi theo IP. Mức 120 người thử không phải cam kết số lớp/người production hoặc miễn mọi giới hạn chống lạm dụng.

## Giảm nghẽn khi mở bài đồng thời

Đọc/hash file audio nằm ngoài giao dịch giữ connection/khóa hàng. Giao dịch ngắn chỉ chốt manifest một lần; nếu có người đã chốt trong lúc chờ, dùng bản đã ghim. Những request cùng slug đang hash có thể chia sẻ một công việc đang chạy; lần sau vẫn hash mới, không giữ kết quả hash lâu để bỏ qua file đổi. Client vẫn kiểm AES-GCM/hash plaintext; stream từ chối file khác bản ghim.

Sau bước đọc file, `audio-access` kiểm lại quyền/owner trước khi trả khóa. Không tăng pool, timeout, quota hoặc thêm dependency để làm bài tải đạt. Không thêm migration và không đổi bài/đáp án/quy tắc chấm.

## Kiểm chứng

Kết quả cuối: **257 backend**, **172 Pages**, không lỗi/skip; thêm **16 hành trình trọn vẹn có cửa sổ Chrome/Edge**, trong đó bốn hành trình cố ý mất phản hồi start rồi đi tới nộp/xem kết quả. Sau bổ sung GET quota, bốn hành trình fault được kiểm lại trên backend cuối. Bốn ca fault tập trung còn được chạy riêng trên mỗi browser, không cộng trùng vào 172.

- `test/audio-start-guard.test.js`: HTTP/SQL thật, cả hai thứ tự; start mất ACK vẫn có hold đã commit, nộp bị chặn, retry giữ incident/deadline, phục hồi và confirm lặp không bù hai lần, nộp đọc lại.
- `test/audio-network-fairness.test.js`: hơn 900 request của nhiều phiên chung IP không chặn nhau; vẫn mở được incident; UUID giả xoay liên tục bị giới hạn nhưng phiên đã biết còn điều khiển được. Thêm 260 lượt GET nghe thử dùng bốn phiên chung IP; đã RED ở request 241 trước sửa đường GET và GREEN sau sửa. Các ca lỗi gốc có cùng test RED/GREEN.
- Các test quyền/cache/owner/nháp/thời gian và full suite backend chạy trên PostgreSQL native local bằng role ứng dụng. Mock nghiệp vụ cũ chỉ thêm đáp ứng riêng cho truy vấn quota mới để không tiêu thụ nhầm thứ tự response; không dùng mock đó làm bằng chứng quota.
- Pages có bốn ca startup: hai thứ tự × 500/mất kết nối rồi reload; dùng start thật đã commit trước khi làm mất phản hồi, đối chiếu UI và DB. Kiểm bằng Chrome/Edge có cửa sổ thật, thêm sáu hành trình trọn vẹn mỗi browser, tới nộp L/R/Writing khi có và xem/reload kết quả.
- Tải cùng file giả 40 MiB: 60 chung IP và 120 địa chỉ tách không còn lỗi trước sửa. Thêm 120 chung IP với handshake start mới: tất cả bắt đầu, lưu, giữ/phục hồi/bù/nộp/readback đạt; 8 tải lạnh giải mã/hash đúng, không timeout pool.

Raw log/JSON, giới hạn và revision cuối tại `E:/Codex-Data/k67-start-network-fix-20261015/`. Các lượt đo local không ép quota CPU/RAM production; không chứng minh audibility, cuộc gọi/driver/Bluetooth/extension hoặc bài nghe thật trọn buổi. [18 ca thiết bị thật](AUDIO_DEVICE_ACCEPTANCE.md) còn chờ; [runbook phát hành/quay lui](AUDIO_RELEASE_ROLLBACK.md) vẫn áp dụng, đặc biệt không tắt cache giữa phiên đang thi.
