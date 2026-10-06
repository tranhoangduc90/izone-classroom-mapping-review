# Bản sửa Mini Test nhập đáp án — 07/10/2026

## Học viên sẽ thấy gì?

Trước khi nhập, học viên chọn lớp, chọn tên và xác nhận. Trang mới lấy lượt hiện tại từ máy chủ, rồi mở Listening hoặc Reading đang dở. Nhấn “Đổi người học” để quay về màn chọn tên. Tải lại luôn cần xác nhận; tên đã xác nhận trước chỉ được điền sẵn.

Listening và Reading của **trang nhập đáp án Mini67** không có hạn, khóa hết giờ hoặc tự nộp. Giảng viên tổ chức thời gian làm trên giấy. Học viên tự nhấn nộp, nhận kết quả chấm và phân tích hiện có. Bản thi trên máy giữ cơ chế thời gian cũ.

Đây là xác nhận danh tính theo lớp/tên như Progress Log, không phải xác thực bằng mật khẩu hoặc Google. Không mở rộng cách đăng nhập này sang Term Test hoặc khóa 56.

## Trách nhiệm từng phần

| File | Thay đổi và lý do |
|---|---|
| `src/mini-answer-sheet.js` | API riêng cho nhập giấy: danh sách lớp, mở/nối lượt, lưu nháp, nộp hai phần, đọc kết quả. Chính sách không hạn được giữ ở máy chủ. |
| `src/app.js` | Gắn API mới; chặn CBT dùng phiên nhập giấy. Sự kiện lưu nháp nhận lượt chưa hoàn tất. |
| `src/sql.js` | Các đường CBT không đặt hạn hoặc nộp cho lượt giấy; dọn phiên quá 8 giờ không đụng lượt giấy. Tách truy vấn sự kiện khỏi điều kiện xem kết quả. |
| `db/007-mini-answer-sheet.sql` | Thêm loại lượt và thế hệ; chuyển đúng bài giấy IC2304 đã xác minh. |
| `test/mini-answer-sheet.test.js` | SQL thật trên PostgreSQL nhúng: migration dữ liệu cũ, định danh, nháp, retry, thời gian, chuyển URL và tab cũ. |
| `test/helpers/mini-answer-sheet-fixture.js` | Ứng dụng/database giả trên máy local cho kiểm Chrome từ đầu đến kết quả. |
| Pages `term-tests/shared/app.js` | Màn chọn lớp/tên riêng cho Mini giấy; cache theo lớp/người/lượt; giữ nháp cũ và chặn phản hồi/nháp xếp hàng sau đổi người. |
| Pages `term-tests/shared/styles.css` | Khoảng cách cho tên người đã xác nhận ở phía trên phần nhập. |
| Pages Mini config và các HTML/bootstrap K67 | Hướng dẫn nhập giấy và đổi revision tài nguyên để trình duyệt nhận bản mới. |
| Pages các test Mini, reliability, bộ nhớ và kết quả K67 | Kiểm hành vi mới; điều chỉnh kỳ vọng cũ chỉ ở phần Mini giấy đã đổi. |

## Chính sách dữ liệu cũ

- Chỉ Mini `mini-test-lesson-5`, lớp ERP1293/IC2304, không có `exam_session_id`, được chuyển từ `legacy` sang `answer_sheet`. Đây là nhóm đã xác minh làm giấy. Bài chưa hoàn tất bỏ hạn Reading cũ; bài hoàn tất giữ hạn lịch sử, đáp án và điểm.
- IC2238 chưa xác minh loại lượt được giữ nguyên. Nếu đang dở, mở trang giấy báo giảng viên kiểm tra; không âm thầm bỏ hạn hoặc tự nộp. Lượt CBT chưa hoàn tất cũng được giữ nguyên và yêu cầu dùng link CBT.
- Các kết quả hợp lệ của bốn học viên trong yêu cầu IC2304 không được mở lại hoặc chấm lại trong gói này.
- Nháp cùng người/lượt/thế hệ được khôi phục. Nháp cũ vô chủ hoặc trước lần mở lại chỉ phục hồi khi học viên xác nhận rõ. Nháp người khác vẫn giữ nguyên tại khóa cũ, không trộn vào bài mới.
- Kết quả Mini mới được đọc qua API thuần đọc; không gọi chấm Writing hay ghi Portal Term Test.

## Giao tiếp và lỗi/phục hồi

Tiền tố mới là `/api/term-tests/mini-test-lesson-5/answer-sheet`.

| Đường | Nhận | Trả hoặc lỗi |
|---|---|---|
| GET `/classes` | Không có danh tính | Các lớp thật trong nguồn K67 đang hợp lệ; bỏ lớp demo. Nguồn lớp/quyền cũ hoặc mất nguồn thì không mở lớp mới. |
| POST `/open` | `classCode`, `studentRef`, `identityConfirmed: true` | Token đúng lượt, thế hệ, nháp, chính sách không hạn, trạng thái/kết quả. Thiếu xác nhận trả 400; lớp/tên sai 404; lượt CBT/chưa xác minh 409. |
| POST `/listening/draft`, `/reading/draft` | Token, `generation`, `revision`, `answers` | Nháp được ghi hoặc bản mới hơn trên máy chủ; không đặt hạn. Đã nộp/thế hệ cũ trả 409. |
| POST `/listening` | Token phiên, thế hệ, mã gửi bài, đáp án | Một attempt và kết quả Listening; gửi lại giữ kết quả đầu. |
| POST `/reading/start` | Token attempt, thế hệ | Bắt đầu nhập Reading, không cấp hạn. |
| POST `/reading` | Token attempt, thế hệ, đáp án | Kết quả đã hoàn tất; gửi lại không chấm bằng đáp án khác. |
| POST `/result` | Token attempt, thế hệ | Kết quả đã lưu; không gây tác động tới hệ thống ngoài. |

Máy chủ khóa theo cùng học viên/lớp trước khi khóa bản ghi. Mở lại trang và nộp Listening không tạo hai lượt khi diễn ra đồng thời. Mỗi giao dịch giữ kết quả ghi hoặc hoàn tác toàn bộ khi lỗi.

Giao diện lưu nháp trên máy trước, rồi lưu máy chủ. Mạng lỗi hiện “chưa lưu được” và thử lại; không biến lỗi thành “đã lưu”. Hạn chờ request giao diện là 45 giây. Giới hạn request hiện hành của K67 được giữ; không thêm hàng xử lý, AI hoặc chi phí dịch vụ vào luồng này. Tải căn cứ: 10 lớp thật/169 hồ sơ trong readback 06/10; không tuyên bố đã kiểm tải đồng thời ở mức đó.

## Khi giảng viên cần mở lại một bài

Gói này chưa thêm màn giảng viên mở lại bài. Đó là thao tác vận hành riêng, cần đúng học viên/lượt và quyền ghi dữ liệu. Trước khi sửa phải lưu riêng bản ghi cũ cùng điểm/đáp án để đọc lại và khôi phục.

Thao tác mở lại phải lấy **cùng khóa học viên/lớp**, tăng `generation` của attempt **và exam session liên kết** trong cùng giao dịch, rồi chỉ đổi phần Reading đã được cho phép. Không tăng một bảng riêng lẻ. Các tab cũ mang thế hệ cũ sẽ bị từ chối; học viên xác nhận lại để đọc thế hệ mới. Không xóa Listening, dữ liệu lớp khác hoặc kết quả hợp lệ khi chưa có yêu cầu.

Test hiện mô phỏng việc tăng thế hệ cả hai bản ghi và chứng minh tab cũ không nộp Listening/Reading. Chưa kiểm một công cụ mở lại production thật.

## Kiểm đã thực hiện và giới hạn

Hai ca lỗi gốc chạy RED trên Pages base cũ và GREEN trên bản sửa: mở ô trả lời trước xác nhận; tự gửi Reading khi mang hạn cũ qua 21 phút/tải lại.

Các kiểm local gồm backend hiện hành, Chrome desktop/mobile, SQL PostgreSQL nhúng, mất mạng/khôi phục nháp, chờ hai giờ, nộp lặp, đổi người khi request đang chờ, chấm và đọc lại database, học viên tạm, bộ nhớ Term/CBT, Writing, audio và định tuyến K56. Báo cáo kiểm cuối và ảnh nằm trong evidence riêng của task, ngoài Git.

Review độc lập đã phát hiện và sửa race mở trang/nộp Listening. Reviewer đã đọc lại cách khóa chung và ca migration trên dữ liệu cũ; không còn finding mở trong phần review.

Ngày 07/10, sau khi Đức cho phép kiểm đầy đủ trên VPS rồi phát hành: 84 ca native trên PostgreSQL 16/role thật và 8 ca HTTP đều đạt, không skip. Ba ca Mini mới ép mở đồng thời, mở trong khi Listening nộp, Reading nộp đồng thời; chỉ tạo một phiên/lượt và giữ cùng kết quả.

Backend mới đã chuyển, readiness/API công khai/CORS đạt. Migration chuyển 16 lượt giấy IC2304, so và giữ nguyên nội dung 156 attempt cùng 126 exam session trong giao dịch. Điểm bốn học viên được đọc lại, không nộp hoặc chấm lại. Cấu hình runtime, mount, Redis, nguồn ngữ cảnh và runtime chung/K56 giữ nguyên theo hash đối chiếu. Snapshot database đã kiểm đọc danh mục phục hồi; container cũ được giữ, không dùng để tự quay lại sau khi có bài giấy mới.

Pages đã phát hành tại commit `90470fefeed01a0226528f9fca8a6540283e635e`. 11 tài nguyên live khớp source chuẩn hóa xuống dòng. Chrome sạch trên mobile/desktop đã xác nhận chọn lớp/tên trước khi mở, tải lại cần xác nhận lại, xem đúng điểm cả bốn học viên và không có lỗi JavaScript; không gửi đáp án thật. Backend healthy, không restart hoặc lỗi runtime trong cửa sổ quan sát. Chưa quan sát một lớp thật đang làm bài và chưa kiểm tải 169 người đồng thời; không suy từ số ca kiểm thành chứng minh hai việc đó.

## Thứ tự phát hành sau khi được phép

1. Đối chiếu lại phiên bản container K67 và Git/Pages live. Nếu đổi từ nền đã rà, tích hợp/kiểm phần thay đổi trước. Đối chiếu nội dung chuẩn hóa xuống dòng, tránh nhầm CRLF với thay đổi nghiệp vụ.
2. Dựng fixture PostgreSQL/container thử riêng trên VPS, dữ liệu giả, không nối database bài thật, Portal hay n8n thật. Chạy các nhóm native database/context/integration và phép đồng thời mở trang–nộp Listening. Kiểm bằng role K67 và đúng migration mới.
3. Lưu snapshot database riêng tư cùng bản image/config K67 đã xác minh. Giữ nguyên cấu hình, Redis, hàng chấm Writing, giới hạn và endpoint nguồn lớp/quyền hiện hành.
4. Chạy duy nhất migration 007 trên database K67, trong giao dịch. Đọc lại phạm vi chuyển: IC2304 không có phiên CBT; so điểm/đáp án bài hoàn tất, IC2238 và CBT phải giữ nguyên. Không chạy lại restore/cutover/migration gói tách backend cũ.
5. Chuyển ứng dụng K67 ứng viên, kiểm health/readiness và các đường API mới bằng dữ liệu thử đã được cho phép. Bản frontend cũ không ghi được lượt giấy đã chuyển; thông báo học viên tải lại trong cửa sổ phát hành ngắn này.
6. Tích hợp và phát hành đúng diff Pages trên nền mới nhất. Khóa 56 không có source thay đổi trong gói. Giữ tài nguyên K56/Progress Log/Writing ngoài Term; backend K67 riêng không chuyển container của các sản phẩm đó.
7. Đọc lại tài nguyên live, kiểm Chrome từ đăng nhập tới kết quả bằng hồ sơ thử được phép, kiểm CBT vẫn giữ hạn và quan sát lỗi lưu nháp. Đối chiếu điểm bốn học viên IC2304, không chấm lại bài thật.

### Quay lại khi có lỗi

Giữ database cùng mọi bài mới. Không restore snapshot đè lên kho đã nhận bài. Dừng phát hành frontend nếu backend ứng viên chưa sẵn sàng.

Image cũ không hiểu loại lượt giấy và có thể cấp lại hạn; **không quay về image cũ một cách máy móc** sau khi có bài giấy mới. Cần bản dự phòng giữ nhận biết `answer_sheet`, hoặc tạm đóng phần nhập giấy trong khi sửa, giữ cơ chế xem kết quả/CBT hiện hành. Migration thêm cột có thể giữ nguyên; không DROP cột hoặc chuyển các bài giấy về CBT để quay lại.

Quyền Git tích hợp/push và ghi production vẫn là các bước riêng. Hồ sơ này mô tả gói cụ thể để duyệt; không tự cấp quyền hoặc tạo cổng metadata bắt buộc.
