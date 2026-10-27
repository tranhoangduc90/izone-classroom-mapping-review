# Nâng cấp đồng hồ và quyền Listening — 26–27/10/2026

Trạng thái: candidate đã kiểm local, chưa phát hành. Không reset phiên, sửa nháp, điểm hoặc tuyến Portal. Dữ liệu live và cấu hình chứa secret chỉ giữ trong kho riêng E:/Codex-Data/exam-resilience-20261026.

## Phạm vi

- K67: Term 1, Term 2, Mini Test; cả Listening trước và Reading trước.
- K56: ba bài tương ứng, giữ controller v2 và chính sách phục hồi hiện hành.
- Frontend Pages dùng chung với bốn Substitute, giữ quy tắc thi lại của Substitute.
- CBT chặn điện thoại/tablet trước API; sáu answer sheet dự phòng vẫn mở trên điện thoại.

## Hợp đồng mới

GET `/api/term-tests/:testSlug/clock` trả `serverNow` của PostgreSQL, không đọc/ghi bài thi. Client neo thời gian bằng performance.now; khi tỉnh máy thì đối chiếu lại. Chưa đối chiếu được thì không tự nộp dựa đồng hồ chưa chắc chắn; hạn trên server vẫn giữ nguyên.

K67 `session/audio-owner` status trả `ownerStartVersion:2`. Client mới tải/nghe thử mà không claim hoặc lấy Web Lock. Khi bấm Start, gửi version2 + ownerId/proof/pageId/epoch/generation. Máy chủ khóa hàng và chốt chủ trong cùng giao dịch Start; hai máy chỉ một máy thắng. Thử lại cùng page/proof sau mất ACK giữ deadline; page cũ sau reclaim bị chặn. Client cũ và phiên legacy đang chạy giữ đường tương thích.

Teacher GET/POST `/api/term-tests/teacher/audio-recovery` dùng auth và scope native. Release preparation hoặc transfer active cần reason, expectedVersion, requestId; active cần xác nhận nơi cũ đã dừng. Chỉ đổi ownership/epoch, so toàn bộ trường khác trước commit; request lặp không gỡ chủ tiếp theo. Không có reset/chấm/nộp thay.

## Tạo overlay

`patch-live.py` nhận bản chụp runtime có `source-hashes.json`, đích mới, kind, role và schema. Nó kiểm từng hash, copy nguyên source live rồi chỉ sửa allowlist; xuất receipt và migration đúng role/schema. Không gọi SSH, Docker hoặc tự deploy. K56/ Sub có overlay vận hành nên không dựng từ toàn bộ main cũ.

- K67: thêm migration13 audit, migration14 cho phép pin metadata trước Start. Vẫn bảo vệ Start/nháp/nộp và metadata sau Start.
- K56: chỉ migration13 audit; guard native không cho thiết bị khác resume khi chưa được giáo viên giải phóng. Cùng owner vẫn resume; teacher-cleared owner nhận stop-id cũ.
- Audit FK cascade giữ khả năng reset dữ liệu demo đã có; upgrade không gọi reset hoặc xóa phiên.

## Trình tự phát hành sau khi được duyệt

1. Chụp lại image ID, source, env/mount/network và snapshot dữ liệu cần giữ; so với receipt. Có drift phải dựng candidate mới từ đúng live.
2. Chạy migration bổ sung bằng owner đúng DB. Không backfill/reset/đổi generation phiên đang làm.
3. Dựng image overlay từ đúng image đang chạy; giữ env, mount, network, role, healthcheck và routing. Chạy canary trước, backend trước frontend.
4. K56 demo trước lớp thật. Kiểm clock, chuẩn bị, tải, Start, draft, resume và auth giáo viên với hồ sơ thử riêng.
5. Substitute thêm serverNow ở history theo release root tương ứng; kiểm trường này đi qua gateway của cả bốn bài trước khi chuyển frontend.
6. Chuyển Pages sau khi backend đủ contract; query cache `resilience=20261027-v1`. Không ép reload tab học viên đang làm.
7. Đọc lại dữ liệu bảo toàn, đường lưu/nộp/chấm/Portal từng chặng. Không dùng bài giả để ghi điểm lớp thật. Giữ rescue cho đến khi không còn phiên cần nó.

## Quay lui

Trước frontend cutover: giữ frontend cũ, quay đúng image API vừa thay. Sau frontend cutover: quay frontend trước rồi image API theo baseline đã chụp. Giữ migration bổ sung và mọi bài mới đã nhận; không restore database cũ, xóa audit hay đảo dữ liệu để quay code. Không rollback toàn bộ main có công việc người khác.

## Bằng chứng và giới hạn

- Native PostgreSQL16 local: 80/80 ca audio-access/incidents/owner/exam-order, gồm cạnh tranh Start, mất ACK, reclaim, nháp quá hạn đợi khóa và đủ thời lượng sau khóa.
- Mixed native local: 100 hồ sơ +10 reader giáo viên, bốn bài kiểm đạt, không gọi AI/Portal/audio thật.
- K56: guard native6/6; teacher SQL hai schema2/2. Guard unit cung cấp hàng đã khóa, không tự chứng minh khóa PostgreSQL.
- Pages: 89/89 hồi quy nhóm ảnh hưởng; Cloudflare15/15; owner browser21/21 trước bổ sung helper chọn nguồn (helper có kiểm riêng); desktop guard Android/iPad cả12 CBT không gọi API, sáu paper không bị chặn.
- Full default K67:384 pass,6 fail setup,6 skip. Các file fail cần fixture PostgreSQL/HTTP riêng hoặc dependency sibling chưa cài; không được gọi là full suite xanh. Các ca native liên quan đã chạy riêng như trên.
- Chưa có bằng chứng sau phát hành, tai nghe lớp thật hoặc điểm Portal mới do upgrade. Web không thể dừng máy phát đã offline; teacher phải xác nhận nơi cũ đã dừng. Browser không có Web Locks hoặc không lưu được proof có thể cần hỗ trợ khi chuyển/reload.
