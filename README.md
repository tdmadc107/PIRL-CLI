# PIRL-CLI

Plan - Implement - Review Layer in CLI.

PIRL CLI là ứng dụng TUI chạy [PIRL framework](pirl-framework/README.md) (Plan – Implement – Review)
bằng agent CLI mà bạn đã cài và tự đăng nhập bằng subscription của mình. Bản pilot dùng Claude Code.
PIRL CLI không có màn hình đăng nhập riêng, không đọc, lưu hay chuyển tiếp credential của provider.

Thiết kế đầy đủ: [docs/pirl-cli-proposal.md](docs/pirl-cli-proposal.md).

## Trạng thái

Pilot với Claude Code: giai đoạn 0, 1 và 2 đã xong.

| Lệnh | Bản hiện tại |
| --- | --- |
| `/pirl-plan`, `/pirl-implement`, `/pirl-review`, nhập không có `/` | Dùng được (Claude Code) |
| `/resume`, `/plans`, `/records`, `/copy`, `/help`, `/doctor`, `/settings`, `/clear`, `/exit` | Dùng được |
| `/framework` | Xem trạng thái; cập nhật, khôi phục, hoàn tác ở giai đoạn 3 |
| Codex CLI, Gemini CLI, Copilot CLI | Giai đoạn 4 |

## Yêu cầu

- Node.js 22 trở lên
- Git
- Python 3.9 trở lên (các công cụ của framework: validator, record)
- Claude Code 2.1.281 trở lên, đã cài và đã đăng nhập (`claude auth status` báo `loggedIn: true`)

## Cài từ mã nguồn

PIRL CLI chưa phát hành lên npm.

```bash
git clone https://github.com/tdmadc107/PIRL-CLI.git
cd PIRL-CLI
npm run setup     # cài thư viện, build, đóng gói và cài lệnh `pirl` cho toàn máy
```

Cập nhật: trong thư mục `PIRL-CLI`, chạy `git pull` rồi `npm run setup`.
Gỡ: `npm uninstall -g pirl-cli` (Hub và cài đặt ở `~/.pirl` vẫn giữ lại; xoá tay nếu không cần).

Trên PowerShell, nếu gõ `pirl` báo "running scripts is disabled on this system", chạy
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` một lần, hoặc gõ `pirl.cmd` thay cho `pirl`.

## Sử dụng

```bash
cd đường/dẫn/tới/project-của-bạn   # thư mục này (git repo) là target repo
pirl
```

Trong TUI, gõ `/` để xem danh sách lệnh, hoặc `/help` để xem lệnh và phím tắt.

| Phím | Tác dụng |
| --- | --- |
| Enter | Gửi |
| Shift+Enter | Xuống dòng trong ô nhập. Cũng được: `\` rồi Enter, Ctrl+J, Alt+Enter |
| Ctrl+V | Dán từ clipboard (phím dán của terminal, chuột phải cũng được) |
| Tab | Hoàn thành tên lệnh đang chọn |
| ↑ / ↓ | Chọn lệnh gợi ý, chọn đáp án khi run hỏi, hoặc xem lại nội dung đã gửi |
| PgUp / PgDn | Cuộn khung chat hoặc bảng đang mở |
| Esc | Xoá ô nhập, đóng bảng đang mở, hoặc dừng run đang chạy |
| Ctrl+C | Dừng run đang chạy; khi không có run thì thoát |

Shift+Enter cần terminal báo được phím bổ trợ (giao thức bàn phím kitty): Windows Terminal 1.25 trở lên,
kitty, WezTerm, Ghostty, iTerm2. Với Windows Terminal bản cũ hơn, dùng Ctrl+J, hoặc thêm vào `settings.json`
một phím tắt `{"command": {"action": "sendInput", "input": "\n"}, "keys": "shift+enter"}`.

Copy: bôi đen bằng chuột như mọi nội dung trong terminal; `/copy` copy nguyên câu trả lời gần nhất của PIRL.

### Một run diễn ra thế nào

1. `/pirl-plan <request>` (tương tự `/pirl-implement`, `/pirl-review`) chạy coordinator bằng Claude Code
   của bạn, ở chế độ không tương tác. Mỗi role là một subagent riêng, chỉ có công cụ đúng với việc của role.
2. Khung chat hiện từng role đang làm gì. Khi thiếu quyết định của bạn, run dừng phần phụ thuộc và hỏi:
   chọn bằng ↑↓ rồi Enter, gõ số, hoặc nhập câu trả lời khác.
3. Khi coordinator xong, PIRL CLI tự chạy validator của framework và kiểm tra record tự đánh giá. Sai thì
   gửi coordinator sửa lại (tối đa 2 lần). Sau Implement, CLI kiểm tra file thay đổi có nằm trong
   Allowed paths của Plan không.
4. Nếu run đã sửa file framework (tự cải tiến), CLI hỏi: commit vào Hub, giữ chưa commit, hay bỏ.
5. CLI gợi ý layer tiếp theo dưới dạng lệnh để bạn tự gõ; không tự mở layer nào.

Run không bao giờ commit, push hay đổi nhánh trong repo của bạn. Lệnh không nằm trong danh sách cho phép
của run bị từ chối và được liệt kê trong run block. Esc hoặc Ctrl+C dừng run; `/resume` chạy tiếp, kể cả
sau khi đóng TUI.

Mỗi run gọi Claude Code nhiều lần (coordinator và các role) và tính vào hạn mức subscription của bạn.
Thanh trạng thái hiện số lượt gọi và số token. `/settings` chỉnh số role chạy song song.

### Dữ liệu nằm ở đâu

Lần chạy đầu tiên, PIRL CLI tạo Hub tại `~/.pirl/hub` (Windows: `%USERPROFILE%\.pirl\hub`): một git repo
cục bộ, không có remote, chứa framework đi kèm CLI.

| Dữ liệu | Vị trí |
| --- | --- |
| Plan và report Review (`/plans`) | Gốc Hub, mỗi Plan package một thư mục `<request-slug>_<YYYYMMDD-HHmmss>/`. `/plans` chỉ hiện các package có `target_repo` là repo đang mở |
| Record tự đánh giá (`/records`) | `~/.pirl/hub/.agents/evals/records/<layer>/`, lọc theo repo đang mở |
| Cài đặt | `~/.pirl/config.json` |
| Run dở dang cho `/resume` | `~/.pirl/sessions/` (chỉ lưu session id của Claude Code, không lưu credential) |

Plan, report và record nằm trong Hub, không nằm trong repo project của bạn, và bị Git của Hub bỏ qua: chúng
không bị commit ở đâu cả. Biến môi trường `PIRL_HOME` đổi thư mục `~/.pirl`.

### Giao diện

TUI co giãn theo kích cỡ cửa sổ: từ 120 cột có thêm bảng "Phiên làm việc" bên phải; dưới 40 cột hoặc
10 dòng, TUI yêu cầu mở rộng cửa sổ. `/settings` đổi bảng màu (PIRL, Đại dương, Rừng, Hoàng hôn, Tím,
Đơn sắc), nền sáng/tối và bộ ký hiệu. Biến `NO_COLOR` tắt màu; console Windows cũ tự dùng ký hiệu ASCII.

## Phát triển

```bash
npm run dev         # chạy thẳng từ src/ bằng tsx
npm test            # toàn bộ test (Vitest)
npm run typecheck
python -B -m unittest discover -s pirl-framework/.agents/evals/tests -p "test_*.py"   # test của framework
```

`npm install` dùng `legacy-peer-deps` (đặt trong `.npmrc`) để tránh một lỗi của npm khi giải peer
dependency của Vitest.

`npm run build`, `npm run dev` và `npm test` đều chạy `scripts/bundle-framework.mjs` trước: script chép
các file framework đang được git theo dõi trong `pirl-framework/` vào `bundled-framework/` kèm
`manifest.json` (phiên bản và hash từng file), là bản framework đi kèm gói npm.

```text
src/
  bin/pirl.tsx     điểm vào: tham số dòng lệnh, target repo, Hub, mở TUI
  core/            chạy tiến trình, đường dẫn, cấu hình, xác định target repo
  hub/             Hub git (nhánh upstream/main) và framework đi kèm
  providers/       nhận diện provider (Claude Code; các provider khác ở giai đoạn sau)
  engine/          chạy layer: adapter Claude Code, quyền theo layer, subagent theo role,
                   giao thức với coordinator, kiểm tra sau run, dữ liệu Hub, lưu run cho /resume
  doctor/          kiểm tra môi trường
  commands/        danh sách lệnh và xử lý từng lệnh
  ui/              TUI: theme, bố cục co giãn, ô nhập, run block, các bảng, App
test/              test logic và test giao diện ở nhiều kích cỡ cửa sổ
pirl-framework/    mã nguồn PIRL framework
docs/              bản đề xuất thiết kế
```

## Giấy phép

[MIT](LICENSE).
