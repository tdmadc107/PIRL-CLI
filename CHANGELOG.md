# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/); phiên bản theo
[Semantic Versioning](https://semver.org/lang/vi/).

## [1.0.0] - 2026-10-24

Bản phát hành đầu tiên. Provider: Claude Code (2.1.281 trở lên). Framework đi kèm: fw-1.1.0.

### Thêm

- TUI mở bằng `pirl` trong thư mục của một git repo; repo đó là target repo.
- `/pirl-plan`, `/pirl-implement`, `/pirl-review` chạy một layer của PIRL bằng Claude Code của bạn. Mỗi role là
  một subagent riêng, quyền theo layer.
- Nhập không có `/`: hỏi đáp, việc độc lập, bảo trì framework. Run gợi ý lệnh layer khi yêu cầu là một layer.
- Câu hỏi giữa run (chọn bằng phím mũi tên, gõ số hoặc nhập câu trả lời khác); `/resume` chạy tiếp run bị dừng,
  kể cả sau khi đóng TUI.
- Sau mỗi run, CLI tự chạy validator và kiểm tra record tự đánh giá. Sau Implement, CLI kiểm tra file thay đổi có
  nằm trong Allowed paths của Plan không.
- Cải tiến framework của run được chạy test của framework rồi mới hỏi commit vào Hub. Test lỗi thì không commit
  được.
- `/framework`:
  - cập nhật lên bản đi kèm CLI qua bản nháp, có merge 3 chiều;
  - giải quyết xung đột: giữ bản của bạn, lấy bản gốc mới, để agent gộp, hoặc sửa tay;
  - chạy test của framework trước khi áp dụng;
  - hoàn tác lần cập nhật gần nhất;
  - xem khác biệt so với bản gốc, khôi phục từng file, lịch sử cải tiến.
- Theo dõi run: spinner, đồng hồ, nhật ký trong bảng bên phải và nhật ký đầy đủ ở `~/.pirl/logs/`.
- Token theo loại (đọc cache, ghi cache, ra, vào mới) gồm cả các role, giá trị quy đổi theo giá API, và hạn mức
  5 giờ và tuần khi Claude Code báo.
- `/settings`: model coordinator (mặc định Sonnet), model các role, mức suy luận, số role chạy song song, bảng
  màu, giao diện, ký hiệu, hiệu ứng chuyển động.
- `/plans`, `/records`, `/doctor`, `/copy`, `/clear`, `/help`, `/exit`; dán bằng Ctrl+V; xuống dòng bằng
  Shift+Enter, Ctrl+J hoặc `\` + Enter.
- Bố cục co giãn từ 40 cột; hỗ trợ bộ gõ tiếng Việt.

### Framework fw-1.1.0

- Phần chi tiết của tự đánh giá chuyển sang `self-evaluation.instructions.md`, kèm mẫu JSON của record. Không quy
  tắc nào thay đổi.
- Plan, report và record dùng múi giờ của máy thay vì UTC+7 cố định.

[1.0.0]: https://github.com/tdmadc107/PIRL-CLI/releases/tag/v1.0.0
