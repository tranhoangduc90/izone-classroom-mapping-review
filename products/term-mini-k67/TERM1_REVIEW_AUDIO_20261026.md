# Bổ sung mốc nghe Term Test 1 — 26/10/2026

Runtime hiện hành đã hỗ trợ `reviewAudio` theo catalog của từng slug. Đợt này không sửa hay dựng lại backend; chỉ bổ sung `reviewAudio`, `entry.replay` và `block.replay` vào bundle riêng tư `term-test-1/explanations.json` sau khi frontend tương thích đã phát.

`tools/add-term1-review-audio.mjs` nhận bundle gốc, replay map đã rà và đường xuất riêng. Nó kiểm SHA của nguyên bundle, content/definition, SHA từng nhóm bằng chứng, số câu/block, catalog file/hash và biên thời gian. Sai nguồn dừng; không ghi đè snapshot đầu vào. Reading và mọi trường cũ giữ nguyên. Dữ liệu đề/lời giải/map thật không vào Git.

Chạy công cụ bằng Node trên ba đường dẫn riêng tư:

```powershell
node tools/add-term1-review-audio.mjs '<bundle-goc.json>' '<replay-map.json>' '<thu-muc-rieng/explanations.json>'
```

Đầu vào là lời giải đã phát và mốc gắn với chính lời giải đó. Công cụ sao chép nội dung, thêm mốc đã kiểm và xuất JSON/SHA. Khi sai câu, bằng chứng, key, phiên bản hoặc audio, công cụ dừng bằng lỗi rõ; không tạo một phần bundle để phát.

MP3: `term-test-1-128kbps-9af027eaaf402acc.mp3`, SHA `9af027eaaf402acc230fdaeff11bcc1b792b62e55d75067f1a2bcf2392b485f8`. Bundle nguồn SHA `1be53ed60e04a8292d083468c54a527b1b17a78e43153ab5f0375077b1785927`; candidate SHA `a895b308bb0fa6773aae51e8b910da36368df7116958896cc40297b02d0dfa19`. Giữ definition version 1, content, toàn bộ key và 80 lời giải cũ. Có 54 khoảng cho 40 câu và dẫn chứng nhiễu.

Mốc căn bằng word timestamps cục bộ của đúng file, rà 72 trích dẫn và 161 ánh xạ câu/block. Chuẩn hóa cách đối chiếu số/contraction và ngắt người nói chỉ trong công cụ căn mốc; không sửa chữ nguồn. Chưa nghe thủ công trọn mọi clip và không đánh dấu transcript đã được người dùng duyệt.

Kiểm: 14 ca builder, 4 ca SQL/HTTP quyền học viên/giảng viên gồm replay Term 1 và bảo vệ người/lớp/lượt; candidate thật qua validator khớp module live, bỏ các trường replay cho kết quả giống hệt bundle đầu. Pages kiểm MP3/decoder, các entry và cơ chế nghe lại nhanh bằng fixture riêng. Giữ giới hạn Google/thiết bị thật/Portal đã nêu trong biên nhận, không nhận toàn bộ hệ thống đã kiểm lại.

Đổi tệp nguyên tử chỉ sau so lại runtime/module, content/definition và hash tệp đích. Giữ bản cũ, owner/mode, đối chiếu dữ liệu bài thi trước/sau và đọc lại API; không restart, thay env hoặc ghi DB. Lỗi quay đúng bundle cũ nếu tệp vẫn là candidate của gói này; không đè thay đổi mới của task khác. SHA/PR và trạng thái đã phát phải lấy từ biên nhận thực tế.
