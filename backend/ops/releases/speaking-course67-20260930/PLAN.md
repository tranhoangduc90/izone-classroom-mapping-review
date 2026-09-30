# Mở rộng Speaking Homework cho toàn khóa 67

Ngày kiểm: 30/09/2026, 14:54 +07:00. Phiên bản kế hoạch: 1.
Trạng thái: đã kiểm hiện trạng và lập kế hoạch; chưa xây hoặc đổi production trong tác vụ này.

## 1. Kết luận hiện trạng

| Trang | Chọn lớp trên màn hình | Cách lấy lớp hiện tại | Ghi nhớ học viên |
| --- | --- | --- | --- |
| Buổi 2 — `67-speaking-paraphrase` | Chưa có | JavaScript cố định IC2304 | Dùng khóa chung; chỉ chọn được mã có trong roster IC2304 |
| Buổi 3 — `67-speaking-lam_ro` | Chưa có | docID → bài đã đăng ký; tham số class được kiểm khớp | Dùng khóa chung; chỉ chọn được mã có trong roster của bài |
| Buổi 4 — `67-speaking-diem_giua` | Chưa có | docID → bài đã đăng ký; tham số class được kiểm khớp | Dùng khóa chung; chỉ chọn được mã có trong roster của bài |

Các trang chính thức trả HTTP 200. HTML và JavaScript trên Pages khớp nội dung nguồn đã đọc sau chuẩn hóa CRLF/LF. Cả ba màn hình có dropdown học viên, chưa có dropdown lớp. Không có chức năng tìm lớp toàn khóa từ mã đã nhớ.

Backend không cố định toàn bộ hệ thống vào IC2304: schema đã lưu bài theo class_id và Classroom course/courseWork; roster được truy vấn theo lớp của bài. Tuy nhiên chưa có API danh mục lớp Speaking toàn khóa, API suy ra lớp từ hồ sơ đã nhớ, hay đường mở chung cho buổi 3/4 không có docID. Buổi 2 có đường mở trực tiếp nhưng frontend cố định lớp.

Readback database production:

- IC2304 / buổi 2: open, direct, 15 Docs.
- IC2304 / buổi 3: open, docs_cta, 15 Docs.
- IC2304 / buổi 4: draft, docs_cta, chưa có Docs học viên.
- Ngoài các hàng kiểm thử và bài buổi 3 cũ đã đóng, chưa có bài Speaking của lớp khác trong registry.
- API buổi 2 direct-open trả HTTP 200, ok=true, 15 học viên, 2 phần.

### Nguồn kiểm

Frontend: repo `izone-ai-team-pages`, cây mã `ee11ad3aa96c56104be1f939ce179f3d0f035617`; `speaking-homework/index.html`, `lesson-3.html`, `lesson-4.html`, ba file `lesson-*-live.js`, `shared/student-memory.js`. Các file liên quan đã đối chiếu với URL production.

Backend: repo `izone-classroom-mapping-review`, worktree `speaking-lesson2-release-backend-20260930`; `backend/src/speaking-homework.js`, `speaking-homework-routes.js`, `speaking-classroom-copies.js`. Hai module đầu khớp nội dung container live sau chuẩn hóa xuống dòng.

Readback SQL chạy trong transaction READ ONLY trên mapping_db; chỉ lấy mã lớp, mã bài, trạng thái và số Docs. Không tạo phiên, nộp link, sửa Docs hoặc chạy AI cho học viên trong lần kiểm này.

Chuẩn dùng chung: `lop-67/docs/writing-student-memory.md`; module `shared/student-memory.js`; giao diện Writing hiện tại `writing-handouts/js/student-memory-ui.js`.

## 2. Kết quả học viên sẽ thấy

Lần đầu mở trang chung: chọn Lớp → chọn Học viên → bấm Mở bài. Ô “Ghi nhớ tôi trên thiết bị này” tick sẵn. Lần sau trên cùng website, trình duyệt và thiết bị: tự chọn sẵn lớp và tên đúng mã hồ sơ, vẫn có nút Mở bài và Đổi người học.

Link CTA từ Docs chọn sẵn lớp của bài. Bộ chọn lớp vẫn có để chuyển sang lớp phù hợp; khi chuyển, hệ thống phải tìm đúng bài/bản Docs của ngữ cảnh mới. Không mang docID của lớp cũ sang phiên lớp mới. Trước khi bắt đầu, trang luôn hiển thị rõ lớp và tên đang chọn.

Phạm vi đề xuất là các lớp khóa 67 đang hoạt động và các lớp mới về sau đã có mapping/bài hợp lệ. Lớp chưa có bài mở không được giả thành sẵn sàng. Lớp đã kết thúc không tự mở nhận homework mới; lịch sử và quyền luyện thêm đã có phải được giữ.

## 3. Quy tắc phải giữ

1. Dùng khóa chung hiện tại, chỉ lưu version + studentRef. Lớp và tên lấy lại từ backend; không lập kho ghi nhớ riêng Speaking. Ghi nhớ không phải xác thực Google hay đồng bộ xuyên thiết bị.
2. Chỉ ghép bằng mã chính thức duy nhất; không ghép theo tên gần giống, không chọn phần tử đầu nếu nhiều kết quả, không tự đổi mã hồ sơ khi chuyển lớp. Mã đã nhớ không có quyền tự mở lớp ngoài phạm vi.
3. Danh sách và bước mở phiên đều loại dropped/on_hold ở backend theo cặp lớp–học viên; bảo toàn lịch sử.
4. Khi đã mở phiên, khóa assignmentId, classId, studentRef, documentId. Đổi bộ nhớ ở tab khác hoặc dữ liệu roster không được đổi người/đích nhận bài đang làm.
5. Có docID thì đúng file đó là đích ghi. Giữ hành vi CTA hiện tại cho phép chọn người khác chủ Docs trong cùng lớp; không thêm lại ràng buộc phải trùng chủ Docs. Đổi lớp là đổi ngữ cảnh trước khi mở phiên, không sửa ngầm phiên cũ.
6. Link chung không có docID: backend tìm duy nhất bản Docs của học viên trong bài/lớp đã chọn. Không dùng LIMIT 1 để che hai bài hoặc hai Docs mơ hồ. Với docs_cta, chỉ dùng bản đã kiểm CTA; direct giữ quy tắc hiện tại.
7. Bộ nhớ hợp lệ được ưu tiên hơn class chỉ là gợi ý trên link chung. Với link có docID thuộc lớp khác hồ sơ nhớ: hiển thị rõ và cho chọn người của lớp đó, hoặc mở bài của lớp mình bằng một ngữ cảnh/Doc mới. Không bỏ kiểm lớp để ghi chéo.
8. Buổi 2 vẫn 2 link chính; buổi 3 vẫn 4 link và chỉ cập nhật Bác sĩ AI phía sau; buổi 4 vẫn 2 link chính + 2 bài bổ trợ khác nhau. Giữ kiểm ChatGPT Share, chống dùng lại hội thoại, cảnh báo voice, biên nhận và luyện thêm.
9. Bác sĩ AI ghi đúng classId/studentRef, giữ thứ tự đề xuất và quy tắc 5 ngày. Không trộn danh sách cá nhân giữa lớp/người học.
10. CTA vẫn chữ trắng, không gạch dưới. Cảnh báo Classroom chỉ xét TURNED_IN, không RETURNED; email theo đợt, chống gửi trùng và không hồi tố nhầm bài cũ.
11. Các URL IC2304 hiện có vẫn dùng được. Buổi 4 còn nháp không bị tự phát hành chỉ vì thêm bộ chọn lớp.

## 4. Bản đồ thành phần và giao diện đề xuất

| Thành phần | Trách nhiệm và dữ liệu sở hữu | Giao diện/ranh giới | Nơi sửa dự kiến |
| --- | --- | --- | --- |
| M1 — Phạm vi khóa/lớp | Nhận diện đúng khóa 67; trạng thái lớp và readiness từng mã bài | Chỉ dùng nguồn khóa/lớp đã đối soát; không suy từ tên IC hoặc doctor_course_key | Backend catalog + tài liệu mapping |
| M2 — Nhận diện người học | Chọn lớp/tên, khôi phục UUID, khóa phiên, lỗi lưu bộ nhớ | Dùng shared/student-memory; dữ liệu roster mới quyết định tính hợp lệ | Ba HTML, ba live JS, một adapter Speaking dùng chung |
| M3 — Mở bài | Giải quyết bài/lớp/DocID, kiểm roster và trả ngữ cảnh bất biến | Mở link chung và CTA đều trả cùng hợp đồng phiên; không chuyển đích trong phiên | speaking-homework.js + routes + tests |
| M4 — Đăng ký và CTA | Tạo instance của mẫu bài cho từng Classroom, đồng bộ bản sao và CTA | Tận dụng sự kiện hiện có, xử lý lặp không tạo bài/link trùng | Registry/migration, speaking-classroom-copies, n8n event consumer |
| M5 — Xử lý sau nộp | Kiểm Share, biên nhận, ghi Docs, phân tích và Bác sĩ AI, email | Tiêu thụ ngữ cảnh M3; giữ ownership và chống trùng hiện hành | Kiểm lại các module Speaking, chỉ sửa điểm phụ thuộc phạm vi |

API dự kiến dưới `/api/speaking-homework` (tên cần khóa khi xây lát đầu):

- `GET /classes?assignmentCode=...`: mã/ref lớp thuộc phạm vi 67, trạng thái readiness của bài; không trả danh sách tên cả khóa hay DocID cả lớp.
- `POST /identity/resolve`: nhận assignmentCode + studentRef đã nhớ; trả kết quả duy nhất/missing/ambiguous và lớp phù hợp. Không trả token phiên, không tạo grant.
- `POST /assignment/roster`: nhận classRef + assignmentCode; trả roster đã lọc cùng trạng thái bài. Có docID thì giải quyết và kiểm lớp từ Doc trước.
- `POST /session/start-selected`: nhận lớp/bài/studentRef, docID nếu có, identityConfirmed. Giải quyết duy nhất ở server, kiểm lại roster/readiness, trả session và đúng đích. Các endpoint cũ giữ tương thích.

Response roster dùng studentRef chính thức; chuẩn hóa `student_ref` hiện tại qua adapter, không tạo UUID mới. Danh mục lớp và phép resolve ghi nhớ không lấy danh sách tên toàn khóa xuống trình duyệt. Mất mạng cho tải lại, không dùng roster mẫu để mở phiên.

### Điểm cần kiểm trước khi khóa nguồn lớp 67

Snapshot `mapping.erp_class_state` production hiện chứa phạm vi mở rộng 03/34/45/S&W/1-1; IC2304 không có hàng trong bảng này nhưng có classroom_course_mapping approved. Vì vậy không được inner join bảng này rồi kết luận các lớp 67 đều biến mất, cũng không coi 56 lớp mapping approved là toàn bộ khóa 67.

Lát đầu phải đối chiếu nguồn ERP/khóa và roster 67 đang dùng ở Writing/Term/Progress Log, lập danh mục lớp 67 đã xác minh cùng nguồn và độ mới. Chọn nguồn backend chuẩn; nếu cần bảng phạm vi riêng, migration phải có provenance và không sao chép tên/email học viên. Chưa chốt con số lớp/học viên toàn khóa trong lần kiểm này.

## 5. Thứ tự xây dựng

Chế độ controlled vì có nhận diện người học, dữ liệu cá nhân, backend dùng chung và nhiều hệ thống. Nghiệm thu large_phased: từng lát phải đi trọn từ chọn tên tới đích dữ liệu; không dùng giao diện đã có dropdown để gọi cả hệ thống hoàn tất.

| Lát | Phụ thuộc | Đầu vào → đầu ra | Điều kiện đóng lát |
| --- | --- | --- | --- |
| T1 — Chốt nguồn lớp và API | Không | Mapping/nguồn khóa/readback hiện tại → danh mục lớp + contract M1/M3 | Phân biệt 67 với 56/S&W; không mất IC2304; unique identity và readiness đã kiểm |
| T2 — Đăng nhập đa lớp buổi 2 | T1 | Contract + mẫu roster hai lớp → UI M2/M3 dùng chung | Chọn lớp rồi tên; nhớ từ Progress Log/Writing chọn đúng cả hai; không tạo phiên trước xác nhận; direct trỏ đúng Docs |
| T3 — Buổi 3 và 4 | T2 | Adapter chung + docID CTA → cùng hành vi chọn lớp/tên | CTA cũ chạy, đổi lớp tìm ngữ cảnh mới; buổi 3 không hiện Doctor; buổi 4 giữ bài bổ trợ |
| T4 — Đăng ký lớp/bài qua sự kiện | T1, T3 | Mã bài + Classroom mapping + Docs → registry instance + CTA | Kiểm một lớp thứ hai, không mở draft/deleted, CTA đúng trắng/không gạch dưới; không sửa Docs cũ ngoài scope |
| T5 — Nộp đầu cuối lớp thứ hai | T4 | Link thật được phép thử → receipt/Docs/doctor/read-only teacher view | Đọc lại đúng người, đúng file và danh sách Doctor; thử lỗi/retry không ghi trùng; phạm vi thử được quản lý |
| T6 — Mở dần toàn khóa | T5 | Danh mục đã xác minh + evidence → các lớp ready xuất hiện | Full suite đạt; gates/readback/quan sát; lớp lỗi có thể tắt riêng; không ảnh hưởng Progress Log |

Mỗi lát khi bắt đầu bổ sung file cụ thể, schema migration nếu cần, commands, manifest schema v3, test IDs và evidence trên revision của lát. Nếu T1 đổi nguồn lớp/UUID, T2–T6 phải đánh dấu stale và cập nhật kế hoạch trước khi xây.

## 6. Thiết kế vận hành

Đường chính: Pages → API danh mục/resolve/roster → API mở phiên → database → kiểm Share/AI → biên nhận → ghi Docs và Bác sĩ AI. Classroom event → đăng ký bài/bản sao → CTA là đường chuẩn bị trước khi học viên mở.

Tải đã biết: pilot IC2304 có 15 học viên; chưa đo tổng số khóa 67. Poll hiện tại 5 giây/lượt, khoảng 12 request/phút/người; limiter Speaking hiện 360 request/phút/IP. 30 thiết bị chung một IP chỉ polling đã chạm 360, chưa tính nộp/mở bài. Trước rollout phải đo lớp bận nhất và nhiều lớp đồng thời; thử 15/30/60 phiên là các kịch bản kiểm, không phải khẳng định khả năng chịu tải.

- Danh mục lớp chỉ tải dữ liệu nhỏ; roster tải theo lớp. Resolver UUID không tải tên toàn khóa.
- Cache danh mục ngắn có invalidation/version; mở phiên luôn kiểm trạng thái mới ở backend. Không cache quyền mở bằng localStorage.
- Poll chỉ khi có việc chờ, tăng khoảng cách khi không hoạt động, backoff khi 429/mất mạng; kiểm tác động trước đổi limiter. Không tăng giới hạn tùy tiện hoặc thêm dịch vụ mới khi chưa đo.
- Mục tiêu danh mục/roster phản hồi trong 2 giây ở mức tải kiểm; quá 10 giây hiện thông báo và nút thử lại. Đây là mục tiêu cần đo, không phải SLA hiện đã đạt.
- AI xử lý nền: hiển thị đang xử lý, không báo đã nộp khi chưa đủ điều kiện; giữ link/draft khi timeout. Kiểm quota/worker concurrency/cost hiện tại trước mở toàn khóa.
- Theo dõi độ trễ, 429, số job chờ/thất bại, Doc chưa xác minh CTA, mapping chưa duy nhất. Tra theo assignmentId/classId/studentRef/jobId; không đổ payload/secret vào log công khai.
- Các bước lặp lại dùng khóa chống trùng hiện có; retry lỗi một lớp không chặn lớp khác. Nếu AI/Docs lỗi một phần, giữ biên nhận và retry đúng job, không phát sinh biên nhận/email thứ hai.

## 7. Ma trận nghiệm thu bắt buộc

| Mã | Tình huống | Kết quả cần có |
| --- | --- | --- |
| A01 | Link chung, chưa ghi nhớ | Chọn lớp 67 rồi tên, tick sẵn, mở đúng bài |
| A02 | Ghi nhớ từ Progress Log/Writing/Term | Chọn sẵn đúng lớp/tên bằng mã chính thức; không tạo phiên trước xác nhận |
| A03 | class gợi ý khác hồ sơ nhớ, không docID | Ưu tiên hồ sơ hợp lệ, không lấy tên đầu danh sách |
| A04 | CTA đúng lớp; nhớ đúng người/cùng lớp khác chủ Doc | Tên đúng, docID gốc giữ nguyên; không tái áp ràng buộc chủ Doc |
| A05 | CTA của lớp khác hồ sơ nhớ; đổi lớp | Mismatch rõ; mở lớp mình chỉ sau giải quyết Doc/ngữ cảnh mới, không ghi chéo |
| A06 | UUID hỏng/mất/trùng, tên trùng, reorder roster | Chọn tay hoặc báo rõ; không đoán ghép |
| A07 | dropped/on_hold, ngoài67, mapping chưa duyệt | Không hiện hoặc không mở được phiên, lịch sử còn nguyên |
| A08 | Bỏ tick, lỗi đọc/ghi/xóa storage, Đổi người học | Tôn trọng chọn; lỗi có thông báo; không mất bài hoặc báo nhớ giả |
| A09 | Đổi tên/lớp trong tab khác lúc đang mở/gửi/retry | Phiên giữ danh tính và DocID ban đầu |
| A10 | Bài draft/closed/deleted, không Doc/hai Docs | Không mở mới sai; quyền luyện thêm hợp lệ vẫn giữ; không dùng LIMIT 1 |
| A11 | Nộp thật lớp thứ hai, hai người đồng thời | Check Share, receipt, Doc ghi đúng, Doctor đúng; retry không trùng |
| A12 | AI/Docs/network lỗi một phần, 429 | Draft/link giữ, trạng thái thật, backoff/retry; không email trùng |
| A13 | Buổi2/3/4 và URL IC2304 cũ | Đúng số/phần bài, chặn /c/, /s/t_, giả host; buổi3 không Doctor UI |
| A14 | Doctor + luyện thêm + quy tắc5 ngày | Đúng danh sách/cooldown theo người/lớp, kết quả mới cập nhật đúng |
| A15 | Desktop/mobile/keyboard | Nhãn Lớp/Tên rõ, dropdown dễ dùng, đúng skill izone-web-design, không tràn |
| A16 | API chung và Progress Log | Config/consumer điểm danh giữ đúng; readback Portal theo guard trước/sau deploy |
| A17 | Sự kiện Classroom lặp/sai thứ tự/bài mới cùng mã | Một instance đúng courseWork/Doc; không dùng ID deleted; CTA đúng format |
| A18 | Alert lớp mới và bài lịch sử | Chỉ TURNED_IN thuộc phạm vi bật; email đúng giảng viên theo lô, chống trùng |

Lệnh suite hiện hữu để kế thừa (chạy từ repo/worktree tương ứng):

- Backend: `npm run check`, `npm test` trong backend; thêm test contract catalog/resolve/session và regression lớp mới.
- Pages: `node --test writing-handouts/test/student-memory.test.js`; `node tests/speaking-homework-lesson2-live.mjs`; `node tests/speaking-homework-lesson2-3-parity.mjs`; `node tests/speaking-homework-lesson3-no-doctor.mjs`; `node tests/speaking-homework-lesson4.mjs`; `node tests/speaking-homework-single-reply-link.mjs`.
- Thêm browser test đa lớp riêng cho A01–A10/A15 bằng roster giả, kiểm lưu từ sản phẩm khác; phiên Pages test cần đúng runtime Playwright đã cấu hình.
- Với n8n dùng validate/execution/readback theo AGENTS và công cụ đã pin. Với lỗi hồi quy đã tới người dùng, cùng test phải RED trên base rồi GREEN trên head.
- Trước phát hành chạy full suite revision cuối và quality-gate checker; sau phát hành kiểm URL, console/network, registry, Docs và Doctor thực tế. Các lệnh trên chưa được chạy trong tác vụ lập kế hoạch này.

Review Focus: nhận diện sai khóa67; remembered UUID/đổi lớp dẫn sai Doc; roster cũ cho mở phiên; đăng ký nhầm Classroom ID; tải polling làm 429. Mỗi điểm được đóng bằng A05/A07/A09/A11/A16/A17 và phép thử tải tương ứng.

## 8. Phát hành và quay lại

1. Build trên branch/worktree riêng cho từng repo. Kế thừa manifest/runbook hiện tại, không ghi source lên main và không chép source vào Lớp67.
2. Bật selector + API ở IC2304 trước; kiểm URL cũ và shared memory. Đăng ký một lớp67 thứ hai có bài/bản sao hợp lệ rồi kiểm đầu cuối.
3. Mở thêm từng nhóm lớp từ danh mục ready; lớp67 mới tự xuất hiện khi mapping/bài được xác minh, không tự phát assignment Classroom.
4. Không phát bài buổi4 đang draft hoặc nhúng lại Docs Lesson2 cũ của IC2304 trong phạm vi mở selector.
5. Rollback UI bằng revision trước; tắt riêng lớp/bài gặp lỗi trong registry/feature scope, giữ receipt/claim/Doctor. API quay image trước bằng snapshot; migration thêm trường phải giữ tương thích. Không xóa lịch sử để rollback.
6. Trước/ sau API deployment phải giữ guard điểm danh Progress Log, cấu hình consumer và readback outcome Portal. Thiếu bằng chứng đích thì deployed_awaiting_validation.
7. Chỉ gọi một lớp/bài verified khi có kết quả học viên nhìn thấy và dữ liệu đích readback. Các lớp chưa ready tiếp tục đóng, không gọi toàn khóa hoàn tất nhờ một pilot.

Trong lần này mới hoàn thành kiểm hiện trạng và kế hoạch. Chưa sửa frontend/backend/registry/n8n hoặc phát hành thêm lớp.
