# K67 — nghiệm thu trên máy, tai nghe và profile thật

Chuẩn bị ngày 15/10/2026. **Chưa có ca nào dưới đây được xác nhận bằng tai nghe/thiết bị thật.** Test tự động ở lát 1–3 và load HTTP không thay cho bảng này. Không thử trên bài của học viên đang thi.

## Bản thử đã chuẩn bị

- Bản dài: http://127.0.0.1:8898/term-tests/term-test-1-computer-based/?class=IC2304&mode=lis_first — tiếng giả 31 phút, đủ vượt độ dài audio Term 2 hiện tại (30 phút 44 giây). Đây không phải file đề thật.
- Bản ngắn của lát 3: cổng 8897, nếu tiến trình vẫn chạy; không bấm Làm lại ở tab người khác đang thử. Mỗi ca cần dữ liệu sạch thì dùng profile thử riêng và bản fixture riêng.
- Chọn **Học viên mô phỏng**, xác nhận tên, thử tiếng, bắt đầu. Nhập vài đáp án thật sự trong fixture; không chỉ quan sát nút phát.
- Tất cả thao tác audio vẫn ở **một dòng tiêu đề**, cuộn ngang khi thiếu chỗ. Không tạo thanh/nút mới cho đợt nghiệm thu.
- Chỉ phục vụ loopback. Máy thứ hai không truy cập localhost của máy này. Ca hai thiết bị thật/cắt Wi-Fi cần đích HTTPS thử chung hoặc tunnel riêng đã được cấu hình và cho phép; hiện chưa có đích đó. Hai profile trên một máy chỉ là mô phỏng hai thiết bị.

Khởi động lại bản dài bằng lệnh dưới trong thư mục sản phẩm. Lệnh tạo server local với audio/tên/câu hỏi giả; lỗi sẽ hiện ở terminal. Không trỏ nó vào VPS hoặc thêm địa chỉ nghe ra mạng công cộng.

```powershell
# Mở bản thử thiết bị dài 31 phút; giữ cửa sổ/tiến trình để tiếp tục dùng bản thử.
$env:K67_PREVIEW_PORT = '8898'
$env:K67_PREVIEW_AUDIO_SECONDS = '1860'
$env:K67_PREVIEW_AUDIO_PROTECTION = 'true'
$env:K67_PREVIEW_AUDIO_OWNER = 'true'
node tools/preview-exam-order.mjs E:/wt/k67-audio-hold-slice1-20261015/pages
```

## Ghi cấu hình trước khi thử

Gán mỗi cấu hình một mã: máy/OS + phiên bản browser + profile + tai nghe/đầu ra + kết nối. Ưu tiên Windows Chrome và Edge, gồm máy yếu nhất trong nhóm học viên, tai nghe dây và Bluetooth. Dùng cả profile thường có extension và profile sạch. Không gọi profile headless tự động là profile thường của học viên.

| Mã cấu hình | Máy/OS/browser/version | Profile/extension liên quan | Loa/tai nghe/driver | Mạng và nguồn điện | Người nghe xác nhận |
|---|---|---|---|---|---|
| M01 | Chưa điền | Chưa điền | Chưa điền | Chưa điền | Chưa có |
| M02 | Chưa điền | Chưa điền | Chưa điền | Chưa điền | Chưa có |
| M03 | Chưa điền | Chưa điền | Chưa điền | Chưa điền | Chưa có |

## Các ca cần thực hiện

Mỗi ca lưu mã cấu hình, thời điểm UTC có Z/offset, mốc nghe trước/sau, incident/correlation ID, deadline trước/sau, giây bù, nháp và trạng thái nộp. Người nghe xác nhận tiếng thật; người hỗ trợ kỹ thuật đối chiếu DB/API. Không lưu khóa audio, proof chủ phát hoặc token vào báo cáo chia sẻ.

| ID | Thao tác thực tế | Kết quả phải quan sát | Trạng thái |
|---|---|---|---|
| P01 | Nghe hết 31 phút; nhập đáp án và lưu bài trong lúc nghe; xem lại rồi nộp | Tiếng liền mạch, không chồng player, nháp đúng, nộp đúng một lần; ghi khoảng im/ngắt nếu có | Chưa chạy |
| P02 | Bấm Tôi không nghe được; chờ 10–20 giây, thử tiếng rồi tiếp tục | Khóa sửa/nộp ngay; cùng mốc và nháp; tiếp tục sau xác nhận; bù đúng một lần | Chưa chạy |
| P03 | Tắt tiếng/đưa volume trong trang về 0 rồi bật lại | Giữ bài; không cho tiếp tục khi còn mute; thử tiếng và đề cùng đầu ra | Chưa chạy |
| P04 | Mute tab, mute Windows hoặc hạ âm lượng ứng dụng trong Volume Mixer | Ghi rõ web có nhận biết không; nếu không, học viên báo lỗi ngay; giáo viên xử lý phần đã bỏ lỡ, không tự tua | Chưa chạy |
| P05 | Rút/cắm tai nghe dây; đổi đầu ra mặc định của Windows | Không tự dừng chỉ vì danh sách đổi; đầu ra cụ thể biến mất thì giữ nếu browser cho biết; nếu không nghe được phải dùng nút báo lỗi | Chưa chạy |
| P06 | Bluetooth ngắt/nối lại, đổi chế độ khi nhận cuộc gọi Meet/Zoom/Teams | Ghi tiếng thật và độ trễ; không mặc định cuộc gọi luôn tạo event; giữ bài/báo giáo viên khi mất tiếng | Chưa chạy |
| P07 | Bấm play/pause/seek trên tai nghe và phím media của bàn phím | Không tua hoặc thoát giữ bài ngoài quy trình; tự phục hồi hữu hạn, mẫu thử không phát chồng đề | Chưa chạy |
| P08 | Chuyển tab/thu nhỏ 60 giây trong lúc vẫn nghe tốt | Visibility riêng không làm dừng nhầm; âm thanh/nháp còn đúng khi quay lại | Chưa chạy |
| P09 | Khóa/ngủ/gập máy 20–60 giây rồi mở lại trên máy thử riêng | Ghi mốc an toàn và đoạn nghe bỏ lỡ; không nhảy theo đồng hồ; nếu không xác định được đoạn mất thì giáo viên xử lý | Chưa chạy |
| P10 | Browser loại bỏ tab hoặc đóng browser rồi mở lại | Xác thực online; cùng phiên và cache/mốc; không phát trùng; không mất đáp án đã lưu | Chưa chạy |
| P11 | Mất mạng khi đang nghe; mất mạng rồi reload; nối lại | Tab còn sống phát từ bản RAM; reload không tự lấy khóa offline; khi có API thật mới tiếp tục | Chưa chạy |
| P12 | Mở tab thứ hai trong cùng profile | Tab thứ hai không có player chính; tab chủ tiếp tục bình thường | Chưa chạy |
| P13 | Máy thứ hai mở cùng phiên khi máy thứ nhất offline | Không chiếm quyền bằng timeout; sau dừng/giữ/release nơi cũ mới chuyển được; cần đích thử chung | Chưa chạy |
| P14 | Chọn đầu ra trong web; từ chối quyền hoặc dùng browser không hỗ trợ | Thông báo rõ/chỉ dẫn chọn tại OS; không xin microphone; khi chọn được, tiếng thử dùng đúng đầu ra đề | Chưa chạy |
| P15 | Cùng máy/đề: profile thường rồi profile sạch; nếu lỗi chỉ ở profile thường, tắt từng extension có bằng chứng | Chỉ ghi quan hệ đã tái hiện; không tuyên bố web tự kiểm kê/tắt extension | Chưa chạy |
| P16 | Báo lỗi gần cuối audio, giữ qua deadline, rồi phục hồi trong 900 giây | Không thu khi đang giữ; bù một lần; giữ nháp và phần nghe còn lại; không phát lại toàn bài | Chưa chạy |
| P17 | Đã nghe hết → reload vào thời gian xem lại → mute/khóa-mở/nhấn media → nộp | Không mở sự cố audio, không khóa nộp hoặc đổi deadline chỉ vì tín hiệu sau ended | Chưa chạy |
| P18 | Wake Lock bị từ chối/tiết kiệm pin; máy yếu có ứng dụng thường dùng | Không coi Wake Lock là cam kết; đo tiếng thật, độ trễ UI và bộ nhớ; không tự đóng app | Chưa chạy |

Không dùng chế độ Offline của DevTools làm bằng chứng đã cắt Wi-Fi vật lý. Trên localhost, ngắt Wi-Fi vẫn có thể gọi API loopback; cần ghi chính xác loại lỗi mạng đã tạo. DevTools vẫn hữu ích để thử riêng API tiến độ lỗi trong profile thật.

## Phiếu ghi cho từng lần chạy

| Run ID / P-ID / M-ID | Giờ bắt đầu–kết thúc UTC | Thao tác và tiếng thực nghe | Mốc/nháp/giờ bù/nộp đọc lại | Bằng chứng | Kết luận/người xác nhận |
|---|---|---|---|---|---|
| Chưa có | — | — | — | — | Chưa chạy |

Không nghe được, mất nháp, nộp sai hoặc chưa xác định nguyên nhân thì ghi **Không đạt/Chưa rõ**; dừng ca có thể làm mất bài, giữ tab và báo giáo viên. Không điền Đạt từ việc API trả 200.

Đợt đầu cần P01/P02/P09/P10/P12/P16/P17 trên Chrome và Edge, cả máy yếu, cùng P03–P07/P14/P15 theo thiết bị thực dùng. P11/P13 vẫn chờ đích thử mạng chung phù hợp. Các ca không có phần cứng phải giữ Chưa chạy; người phụ trách nghiệm thu và lịch thử do Đức chốt trước pilot.

## Căn cứ về giới hạn browser

Tab bị loại bỏ có thể không phát event để lưu lần cuối; vì vậy phải kiểm phục hồi, không chỉ listener: [Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api). Quyền/chính sách có thể từ chối phát: [HTMLMediaElement.play](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play). Chọn đầu ra phụ thuộc hỗ trợ và quyền: [selectAudioOutput](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/selectAudioOutput). Wake Lock có thể bị thu hồi và không giữ máy luôn thức: [Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API).
