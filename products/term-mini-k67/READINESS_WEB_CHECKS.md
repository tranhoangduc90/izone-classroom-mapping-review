# Web tự kiểm trước thi K67

Bộ kiểm chỉ nằm trong bài làm quen riêng. Không sửa phòng chờ Listening thật, không mở đề, tạo lượt thi, tính giờ, gửi chấm hoặc gửi thông báo giáo viên. Sau cảnh báo, học viên và giảng viên liên hệ qua chat/trực tiếp như hiện nay.

## Hành vi học viên

Nút **Kiểm thiết bị** nằm trên cùng dòng tiêu đề. Mở nút này để xem từng mục đã kiểm, cần chú ý, cần khắc phục hoặc chưa quan sát được. Thông báo tóm tắt luôn hiện trong bài làm quen. Không có điểm “máy đạt 95%” hoặc cam kết không gián đoạn.

| Nhóm kiểm | Bằng chứng và cách diễn giải |
| --- | --- |
| Tính năng lõi | HTTPS/secure context, crypto, Web Locks và helper lưu audio có mặt. Thiếu lõi báo rõ; xung đột tab có thông báo riêng, không gán thành máy hỏng. Tên trình duyệt chỉ giới hạn phạm vi nghiệm thu Chrome/Edge Windows. |
| Kết nối | Đo request thật của phiên, tải và lưu. Có Internet/`onLine=true` không thay kết quả API. Phản hồi trên 2,5 giây giữ cảnh báo trong lượt; lỗi request không kết luận do thiết bị hay dịch vụ. |
| Nháp cục bộ | Thử ghi–đọc–xóa một khóa riêng. Nếu thất bại, cảnh báo reload có thể phải vào lại/mất phần chưa đồng bộ. Không âm thầm coi dữ liệu RAM là bản lưu bền. |
| Mẫu và cache | Dùng kết quả tải đủ, hash, AES-GCM và ghi–đọc IndexedDB của mẫu riêng hiện có. Hỏng bản mã không báo đạt; không lưu cache được thì nói rõ mức phục hồi còn lại. |
| Định dạng | `canPlayType(audio/mpeg)` chỉ là gợi ý, không phải pass. Tải mẫu MP3 riêng sáu giây, kiểm hash/kích thước rồi giải mã toàn bộ bằng AudioContext; không phát ngầm. Nếu API giải mã phụ không có, giữ trạng thái chưa quan sát được. Không suy từ WAV hoặc một MP3 sang mọi file/codec của đề. |
| Phát | Sau thao tác bấm, quan sát play/error, mute/volume phần tử và mốc phát. Mốc phát tiến ít nhất hai giây mới có kết quả “trình phát đang chạy”; vẫn chưa chứng minh tiếng tới tai. Đứng mốc hơn năm giây khi trang hiện thì cảnh báo, không tự phát lại. |
| Nghe | Học viên xác nhận riêng; chọn sớm chưa được ghi đã hoàn thành nghe rõ. Mute, gián đoạn hoặc đổi môi trường xóa lựa chọn nghe rõ đang có; cần nghe/xác nhận lại. Nộp trạng thái không nghe rõ vẫn cho kết quả trung thực. |
| Lưu máy chủ | Chỉ pass sau khi bản nháp trả về đúng revision/nội dung đã gửi. Lỗi lưu báo cần xử lý, giữ nháp trên máy trong phạm vi khả năng lưu. |
| Trang/thiết bị/tải | Theo dõi visibility/freeze/resume, devicechange và Long Tasks khi có. Không suy một sự kiện devicechange thành tai nghe bị rút, hoặc nghẽn JS thành mất đoạn nghe/app cụ thể gây lỗi. |
| API phụ | Wake Lock thử khi học viên phát mẫu; bị từ chối/thu hồi hoặc không có thì ghi chưa quan sát được, không đánh trượt máy. Không xin micro/camera để kiểm đầu ra. |

Các mốc 2,5 giây/5 giây và cảnh báo UI (một tác vụ ≥1 giây hoặc ba tác vụ ≥250 ms trong 30 giây) là ngưỡng chẩn đoán ban đầu, chưa được hiệu chỉnh bằng dữ liệu lớp thật. Không dùng chúng để chặn thi thật. Bộ kiểm không tự tạo tải nặng; ca test nghẽn chỉ tồn tại trong runner thử.

Khi nghe không rõ lặp từ hai lần bấm báo lỗi, trang đề nghị trao đổi giảng viên để đổi thiết bị/hình thức phù hợp. Không gửi yêu cầu hỗ trợ, không có trạng thái “giáo viên đã nhận”, không tự thử phát vô hạn.

## Giới hạn cần nói rõ

Web thông thường không xác nhận chắc mute Windows/tab, Volume Mixer, app gọi/họp, extension, driver, Bluetooth hay lịch cập nhật/restart. Hướng dẫn người học kiểm đầu ra/âm lượng Windows, đóng app không cần thiết và thử hồ sơ trình duyệt riêng khi nghi xung đột. Không tự tắt extension/công cụ trợ năng hoặc thu thập danh sách app.

Reload mở lượt quan sát mới; không tái dùng nhãn pass cũ làm kết quả hiện tại. Bài Listening/Reading/Writing đã nộp vẫn giữ trạng thái riêng. Kết quả bài làm quen không trở thành điều kiện mở hoặc chặn bài thi thật.

Lỗi nạp module/helper/CSS được bootstrap riêng báo sớm. Không đổi CSP sang cho phép script inline. Tải lại khi mất mạng vẫn cần mạng để tải trang và xác thực phiên; không bổ sung service worker offline.

## API, dữ liệu và vận hành

Migration **015-readiness-web-checks.sql** thêm check_report, check_revision và check_updated_at vào bảng phiên làm quen. Không sửa các bảng thi. Fixture thử áp dụng 013 → 014 → 015.

`POST /api/k67-readiness/v1/checks` nhận token thử, revision và báo cáo `web-check-v1`: runId, thời điểm client bắt đầu, tối đa 13 mục có id/state/code/thời điểm. Chỉ nhận danh sách mã cho phép; không nhận tên thiết bị, deviceId, app, extension, raw user agent, nội dung bài hoặc khóa audio. Dữ liệu client là tự khai; server chỉ kiểm schema/quyền, không chứng nhận máy hoặc dùng báo cáo này làm quyền mở đề. Thời điểm server ghi nhận nằm ở check_updated_at; không dựa đồng hồ client cho expiry hoặc thời gian thi.

Mỗi lần ghi kiểm membership/expiry/lớp được bật. Revision cũ không ghi đè, cùng revision khác nội dung bị từ chối; JSON được so theo nội dung vì PostgreSQL jsonb có thể đổi thứ tự key. Chỉ tab đang giữ Web Lock của phiên mới gửi báo cáo từ giao diện. Ghi gộp thay đổi sau 1,5 giây; không poll máy chủ mỗi giây. Đồng bộ trước khi nộp Listening, đọc lại metadata sau ghi. Lỗi báo cáo hiển thị “chưa xác nhận đồng bộ” và không thay trạng thái lưu/nộp bài thử.

Báo cáo dùng cùng expiry bảy ngày của phiên. Chưa bổ sung lịch dọn vật lý hoặc cam kết retention 30 ngày. Không tạo dashboard mới. API hiện có vẫn giới hạn theo token xác minh và có quota cho request lạ; đã kiểm 120 phiên chung IP với cả báo cáo và lưu nháp.

## Kiểm và phát hành/quay lui

Chạy: `node --test test/readiness-checks.test.js test/readiness-practice.test.js test/readiness.test.js test/runtime-boundary.test.js`. Các ca browser cần Chrome và Edge cài thật: chặn play, mute phần tử, mốc đứng, đổi thiết bị (mô phỏng tín hiệu), UI bị giữ trong tác vụ trang, API phụ thiếu, thiếu lõi, quota, API lỗi/chậm, reload, báo cáo lỗi, module/CSS lỗi và toàn hành trình ba kỹ năng. Tín hiệu mô phỏng không thay nghiệm thu Windows/tai nghe/app thật. Windows Sleep giữ ngoài phạm vi theo lựa chọn đã có.

Khi được phép phát hành: migration 015 → backend → frontend theo cùng gói. Quay lui frontend trước rồi backend, giữ ba cột/báo cáo đã ghi; không DROP hoặc khôi phục DB đè bài làm quen/thi thật. Công tắc hiện có tắt/bật toàn readiness, chưa có chế độ đóng mềm phiên mới. Task này chỉ chạy local, chưa phát hành hoặc chạy migration production.

## Tài liệu API đã đối chiếu

- [play và lỗi quyền phát](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play).
- [Giới hạn quan sát danh sách thiết bị theo quyền](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices).
- [onLine chỉ là gợi ý](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine).
- [Long Tasks đo nghẽn luồng giao diện](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming).
- [Wake Lock có thể không được cấp hoặc bị thu hồi](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API).
