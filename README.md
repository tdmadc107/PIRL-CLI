# PIRL-CLI

Plan - Implement - Review Layer in CLI.

PIRL CLI là ứng dụng TUI chạy [PIRL framework](pirl-framework/README.md) (Plan – Implement – Review)
bằng agent CLI mà bạn đã cài và tự đăng nhập bằng subscription của mình. Bản pilot dùng Claude Code.
PIRL CLI không có màn hình đăng nhập riêng, không đọc, lưu hay chuyển tiếp credential của provider.

Thiết kế đầy đủ: [docs/pirl-cli-proposal.md](docs/pirl-cli-proposal.md).

## Trạng thái

Giai đoạn 0 (khung TUI) đã xong. Bảng dưới cho biết mỗi lệnh dùng được tới đâu ở bản này.

| Lệnh | Bản hiện tại |
| --- | --- |
| `/help`, `/doctor`, `/settings`, `/framework` (xem trạng thái), `/clear`, `/exit` | Dùng được |
| `/pirl-plan` | Giai đoạn 1 |
| `/pirl-implement`, `/pirl-review`, `/resume`, `/plans`, `/records`, nhập không có `/` | Giai đoạn 2 |
| `/framework`: cập nhật, khôi phục, hoàn tác | Giai đoạn 3 |

## Yêu cầu

- Node.js 22 trở lên
- Git
- Python 3.9 trở lên (các công cụ của framework: validator, record)
- Claude Code đã cài và đã đăng nhập (`claude auth status` báo `loggedIn: true`)

## Cài từ mã nguồn

PIRL CLI chưa phát hành lên npm.

```bash
git clone https://github.com/tdmadc107/PIRL-CLI.git
cd PIRL-CLI
npm install
npm pack                              # build và đóng gói thành pirl-cli-<version>.tgz
npm install -g ./pirl-cli-0.1.0.tgz   # cài lệnh `pirl` cho toàn máy
pirl --version
```

Cập nhật: `git pull`, rồi chạy lại `npm pack` và `npm install -g` với file `.tgz` mới.
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
| `\` rồi Enter | Xuống dòng trong ô nhập |
| Tab | Hoàn thành tên lệnh đang chọn |
| ↑ / ↓ | Chọn lệnh gợi ý, hoặc xem lại nội dung đã gửi |
| PgUp / PgDn | Cuộn khung chat hoặc bảng đang mở |
| Esc | Xoá ô nhập, hoặc đóng bảng đang mở |
| Ctrl+C | Thoát |

Lần chạy đầu tiên, PIRL CLI tạo Hub tại `~/.pirl/hub` (Windows: `%USERPROFILE%\.pirl\hub`): một git repo
cục bộ, không có remote, chứa framework đi kèm CLI. Cài đặt lưu ở `~/.pirl/config.json`.
Biến môi trường `PIRL_HOME` đổi thư mục `~/.pirl`.

TUI co giãn theo kích cỡ cửa sổ: từ 120 cột có thêm bảng "Phiên làm việc" bên phải; dưới 40 cột hoặc
10 dòng, TUI yêu cầu mở rộng cửa sổ. Biến `NO_COLOR` tắt màu; console Windows cũ tự dùng ký hiệu ASCII
(chọn lại trong `/settings`).

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
  providers/       adapter provider (Claude Code; các provider khác ở giai đoạn sau)
  doctor/          kiểm tra môi trường
  commands/        danh sách lệnh và xử lý từng lệnh
  ui/              TUI: theme, bố cục co giãn, ô nhập, các bảng, App
test/              test logic và test giao diện ở nhiều kích cỡ cửa sổ
pirl-framework/    mã nguồn PIRL framework
docs/              bản đề xuất thiết kế
```

## Giấy phép

[MIT](LICENSE).
