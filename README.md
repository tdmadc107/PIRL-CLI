# PIRL-CLI

Plan - Implement - Review Layer in CLI.

PIRL CLI là ứng dụng TUI chạy [PIRL framework](pirl-framework/README.md) (Plan – Implement – Review)
bằng agent CLI mà bạn đã cài và tự đăng nhập bằng subscription của mình. Bản 1.0 dùng Claude Code.
PIRL CLI không có màn hình đăng nhập riêng, không đọc, lưu hay chuyển tiếp credential của provider.

Thiết kế đầy đủ: [docs/pirl-cli-proposal.md](docs/pirl-cli-proposal.md).

## Trạng thái

Bản 1.0.0 (xem [CHANGELOG.md](CHANGELOG.md)).

| Phần | Bản hiện tại |
| --- | --- |
| `/pirl-plan`, `/pirl-implement`, `/pirl-review`, nhập không có `/` | Dùng được với Claude Code. Cả chuỗi Plan → Implement → Review đã chạy thật trên repo mẫu |
| `/framework`: cập nhật, giải quyết xung đột, hoàn tác, khôi phục, lịch sử | Dùng được |
| `/resume`, `/plans`, `/records`, `/copy`, `/help`, `/doctor`, `/settings`, `/clear`, `/exit` | Dùng được |
| Linux, macOS, Windows | Test tự động chạy trên cả ba (CI). Chạy thật với Claude Code mới thử trên Linux |
| Codex CLI, Gemini CLI, Copilot CLI | Chưa hỗ trợ (giai đoạn 4 của bản đề xuất) |

## Yêu cầu

- Node.js 22 trở lên
- Git
- Python 3.9 trở lên (các công cụ của framework: validator, record)
- Claude Code 2.1.281 trở lên, đã cài và đã đăng nhập (`claude auth status` báo `loggedIn: true`)

## Cài đặt

Từ npm (sau khi bản 1.0.0 được phát hành):

```bash
npm install -g pirl-cli
```

Cập nhật: `npm install -g pirl-cli@latest`. Bản CLI mới không tự ghi gì vào framework của bạn. Nếu bản mới
kèm framework mới, header hiện "Có framework mới"; mở `/framework` để cập nhật khi bạn muốn.

Từ mã nguồn:

```bash
git clone https://github.com/tdmadc107/PIRL-CLI.git
cd PIRL-CLI
npm run setup     # cài thư viện, build, đóng gói và cài lệnh `pirl` cho toàn máy
```

Cập nhật bản cài từ mã nguồn: trong thư mục `PIRL-CLI`, chạy `git pull` rồi `npm run setup`.

Gỡ: `npm uninstall -g pirl-cli`. Hub và cài đặt ở `~/.pirl` vẫn giữ lại; xoá tay nếu không cần.

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
| ↑ / ↓ | Chọn lệnh gợi ý hoặc đáp án khi run hỏi; ngoài ra cuộn khung chat (khi chuột là "Bôi đen tự do", mặc định) hoặc xem lại nội dung đã gửi |
| Ctrl+P / Ctrl+N | Xem lại nội dung đã gửi |
| `@` | Đính kèm file hoặc thư mục (Tab/Enter chọn, Esc ẩn danh sách) |
| PgUp / PgDn, con lăn chuột | Cuộn khung chat hoặc bảng đang mở |
| Esc | Xoá ô nhập, đóng bảng đang mở, hoặc dừng run đang chạy |
| Ctrl+C | Dừng run đang chạy; khi không có run thì thoát |

Shift+Enter cần terminal báo được phím bổ trợ (giao thức bàn phím kitty): Windows Terminal 1.25 trở lên,
kitty, WezTerm, Ghostty, iTerm2. Với Windows Terminal bản cũ hơn, dùng Ctrl+J, hoặc thêm vào `settings.json`
một phím tắt `{"command": {"action": "sendInput", "input": "\n"}, "keys": "shift+enter"}`.

Copy: kéo chuột để bôi đen như mọi nội dung trong terminal; `/copy` copy nguyên câu trả lời gần nhất của PIRL.
Con lăn chuột cuộn hội thoại: terminal gửi con lăn thành phím ↑/↓, nên ↑/↓ cuộn hội thoại và Ctrl+P/Ctrl+N gọi
lại lệnh đã gõ. Cách này cần terminal có alternate scroll (Windows Terminal, VS Code, iTerm2, Terminal của macOS,
GNOME Terminal, kitty, WezTerm). Nếu con lăn không cuộn, chọn "Chuột: Con lăn của PIRL" trong `/settings`: con
lăn chạy trên mọi terminal, nhưng bôi đen phải giữ Shift khi kéo.

### Đính kèm file hoặc thư mục bằng `@`

Gõ `@` trong ô nhập để chọn file hoặc thư mục của target repo (ngoài git repo thì của thư mục đang đứng). Danh
sách lọc theo chữ bạn gõ tiếp và bỏ qua những gì `.gitignore` loại ra. Tab hoặc Enter trên một thư mục sẽ mở
thư mục đó để chọn tiếp. Thư mục đang mở luôn nằm đầu danh sách; Enter trên nó đính kèm cả thư mục. Esc ẩn danh
sách mà giữ nguyên chữ đã gõ. Gõ tay cũng được: `@src/orders/cancel.ts`, `@docs/`, `@~/specs/api.md`,
`@"thư mục có dấu cách/file.md"`.

Khi gửi, mỗi `@` trỏ tới một đường dẫn có thật được gửi kèm request. Dùng được cho mọi lệnh layer lẫn câu hỏi:

- file văn bản đến 100 KB: gửi kèm toàn bộ nội dung, tổng tối đa 300 KB một lần gửi;
- file lớn hơn, hoặc ảnh, PDF: gửi đường dẫn để agent tự đọc bằng Read;
- thư mục: gửi danh sách file (tối đa 300), agent đọc file nào cần.

Coordinator được dặn chuyển các đường dẫn này cho role liên quan, vì role không thấy tin nhắn gốc. Thư mục nằm
ngoài target repo được cấp quyền đọc cho run đó. Một `@` không trỏ tới đường dẫn nào, như `dev@shop.vn`, giữ
nguyên là chữ. Nội dung gửi kèm tính vào token vào của run.

Trên Windows, PIRL không đọc đường dẫn mạng hay thiết bị (`\\máy\thư-mục`, `//máy/thư-mục`, `\\?\…`) trong `@`,
trừ khi chính repo hoặc thư mục home nằm trên share đó: chỉ cần đọc thử, Windows đã kết nối tới máy kia và gửi
thông tin đăng nhập NTLM của bạn, mà `@` có thể nằm lẫn trong một đoạn văn bản dán vào.

### Một run diễn ra thế nào

1. `/pirl-plan <request>` (tương tự `/pirl-implement`, `/pirl-review`) chạy coordinator bằng Claude Code
   của bạn, ở chế độ không tương tác. Mỗi role là một subagent riêng, chỉ có công cụ đúng với việc của role.
2. Khung chat hiện từng role đang làm gì. Khi thiếu quyết định của bạn, run dừng phần phụ thuộc và hỏi:
   chọn bằng ↑↓ rồi Enter, gõ số, hoặc nhập câu trả lời khác.
3. Khi coordinator xong, PIRL CLI tự chạy validator của framework và kiểm tra record tự đánh giá. Sai thì
   gửi coordinator sửa lại (tối đa 2 lần). Sau Implement, CLI kiểm tra file thay đổi có nằm trong
   Allowed paths của Plan không.
4. Nếu run đã sửa file framework (tự cải tiến), CLI hỏi: commit vào Hub, giữ chưa commit, hay bỏ.
   Trước khi hỏi, CLI chạy test của framework trên các file đã sửa; test lỗi thì không commit được, nên bỏ.
5. CLI gợi ý layer tiếp theo dưới dạng lệnh để bạn tự gõ; không tự mở layer nào.

Run không bao giờ commit, push hay đổi nhánh trong repo của bạn. Lệnh nằm ngoài quyền của run bị từ chối
("Đã chặn N lệnh ngoài quyền của run"). Đây là luật quyền đang hoạt động, không phải lỗi: run vẫn tiếp tục,
và run block liệt kê đúng lệnh bị chặn. Esc hoặc Ctrl+C dừng run; bấm Ctrl+C lần nữa để thoát ngay.
`/resume` mở danh sách các run còn chạy tiếp được của repo (đã dừng, lỗi, hoặc đang chờ trả lời), mới nhất
trước; chọn run bằng ↑↓ rồi Enter. Run chạy tiếp đúng session Claude Code của nó, kể cả sau khi đóng TUI.

Trong lúc run chạy, spinner và đồng hồ cho biết run còn đang làm; run block hiện từng role đang làm gì. Nhật ký
đầy đủ của mỗi run ghi vào `~/.pirl/logs/` (TUI không hiện nhật ký; nhật ký không tốn token). Nếu terminal
chậm, tắt "Hiệu ứng chuyển động" trong `/settings`.

`/plans` liệt kê Plan và report Review của repo; `/records` liệt kê record tự đánh giá. Chọn một mục rồi Enter
để xem chi tiết: nội dung Plan hoặc report; với record là kết quả, các role, vấn đề tìm thấy và cải tiến đã làm.

### Token và hạn mức

Mỗi run gọi Claude Code nhiều lần (coordinator và các role), và mọi lần gọi đều tính vào hạn mức
subscription của bạn. Bảng bên phải có mục "Hạn mức": phần trăm đã dùng của hạn mức 5 giờ và hạn mức tuần, kèm
giờ đặt lại. Số liệu lấy từ `/usage` của Claude Code lúc mở TUI (lệnh này không gọi model) và được cập nhật
sau mỗi run. Khi cửa sổ hẹp không có bảng bên phải, hạn mức hiện ở thanh trạng thái. Khi run xong, run block
hiện:

- token theo loại: đọc cache, ghi cache, ra, vào mới. Gồm cả token của các role.
- giá trị quy đổi theo giá API niêm yết, do Claude Code ước tính.
- hạn mức 5 giờ và hạn mức tuần, khi Claude Code báo: mức hiện tại, hoặc trước → sau của run nếu đọc được
  mức trước khi run bắt đầu.

Phần lớn token là token đọc cache. Mỗi request gửi lại toàn bộ ngữ cảnh, nhưng phần đã có trong cache chỉ
tính 5% giá token đầu vào (Sonnet 5.5, Opus 5.5). Chi phí thật nằm ở token ghi cache (file đã đọc, kết quả
lệnh), token ra (gồm phần suy luận) và model được chọn.

Anthropic không công bố công thức đổi token ra phần trăm hạn mức. Cách ước lượng sát nhất là quy đổi theo
giá API, rồi so với phần trăm hạn mức mà run đã dùng. Sau vài run, bạn sẽ biết 1% hạn mức của gói mình
ứng với khoảng bao nhiêu đô la quy đổi.

`/settings` chỉnh các mục sau:

- model của coordinator: mặc định Sonnet. Theo giá API, Opus đắt gấp khoảng 2 lần, Fable gấp khoảng 5 lần.
- model của các role: mặc định giống coordinator.
- mức suy luận (effort), áp dụng cho coordinator và mọi role. Mặc định của Claude Code là medium. Claude Code
  chuyển mức này thành một con số nội bộ, khác nhau theo model và phiên bản. Ví dụ Sonnet nhận low 4, medium 5,
  high 10, xhigh 30; Opus nhận low 5, high 15, xhigh 40. Con số đó không phải thang điểm: model trả lời "10"
  nghĩa là Sonnet đang chạy mức high.
- chuột: bôi đen tự do (mặc định), con lăn của PIRL, hoặc tắt.
- số role chạy song song.

PIRL CLI chỉ cấp cho run các công cụ nó dùng và không nạp MCP server của bạn. Nhờ vậy mỗi request gửi ít
ngữ cảnh hơn.

### Cập nhật framework: `/framework`

Mỗi bản CLI kèm một phiên bản framework gốc. Hub giữ hai nhánh: `upstream` là các bản gốc, `main` là bản gốc
cộng các cải tiến của bạn; các layer chạy trên `main`. `/framework` có các mục:

- **Cập nhật lên fw-x.y.z** (khi bản đi kèm CLI mới hơn):
  1. CLI gộp bản mới vào một bản nháp của `main`; `main` chưa đổi gì.
  2. File chỉ một bên sửa được nhận tự động.
  3. Với mỗi file mà cả bản gốc mới lẫn cải tiến của bạn cùng sửa một đoạn, TUI hiện hai bên đã đổi gì, kèm
     cải tiến nào và record nào đã tạo ra thay đổi của bạn. Bạn chọn: giữ bản của bạn, lấy bản gốc mới, để
     agent gộp hai bản (bạn xem bản gộp rồi mới dùng), hoặc tự sửa trong bản nháp.
  4. CLI chạy test của framework trên bản nháp. PASS thì `main` chuyển sang bản nháp; lỗi thì bản nháp bị bỏ
     và Hub giữ nguyên.
- **Hoàn tác lần cập nhật lên fw-x.y.z**: đưa `main` về đúng như trước lần cập nhật đó.
- **Xem cải tiến cục bộ**: danh sách file khác bản gốc và diff từng file. Nhấn `r` để khôi phục file về bản
  gốc (một commit mới; lịch sử vẫn giữ).
- **Lịch sử cải tiến**: các commit trên `main`, kèm record và nguồn (auditor, sửa tay, khôi phục, cập nhật).
- **File chưa commit**: commit hoặc bỏ trước khi cập nhật hay khôi phục.

`/framework` không thay đổi Hub khi đang có run, vì run đã ghim phiên bản framework.

### Dữ liệu nằm ở đâu

Lần chạy đầu tiên, PIRL CLI tạo Hub tại `~/.pirl/hub` (Windows: `%USERPROFILE%\.pirl\hub`): một git repo
cục bộ, không có remote, chứa framework đi kèm CLI.

| Dữ liệu | Vị trí |
| --- | --- |
| Plan và report Review (`/plans`) | Gốc Hub, mỗi Plan package một thư mục `<request-slug>_<YYYYMMDD-HHmmss>/`. `/plans` chỉ hiện các package có `target_repo` là repo đang mở |
| Record tự đánh giá (`/records`) | `~/.pirl/hub/.agents/evals/records/<layer>/`, lọc theo repo đang mở |
| Cài đặt | `~/.pirl/config.json` |
| Run cho `/resume` | `~/.pirl/sessions/<repo>/`, mỗi run một file, giữ 20 run gần nhất mỗi repo (chỉ lưu session id của Claude Code, không lưu credential) |
| Bản nháp khi đang cập nhật framework | `~/.pirl/hub-update/` (tự xoá khi cập nhật xong hoặc huỷ) |
| Nhật ký đầy đủ của từng run | `~/.pirl/logs/` |

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
npm run pack:check  # đóng gói như khi phát hành, cài vào thư mục tạm, chạy pirl --version và --help
```

CI (`.github/workflows/ci.yml`) chạy typecheck, test, test của framework và `pack:check` trên Linux, macOS,
Windows với Node 22 và 24.

### Phát hành

1. Cập nhật `version` trong `package.json` và mục mới trong `CHANGELOG.md`. Nếu framework đổi, tăng
   `pirl.frameworkVersion`: Hub của người dùng so bản này với nhánh `upstream` để báo có framework mới.
2. Merge vào `main`, đợi CI xanh.
3. Tạo tag `v<version>` (ví dụ `git tag v1.0.0 && git push origin v1.0.0`). Workflow
   `.github/workflows/release.yml` kiểm tra tag khớp `package.json`, chạy `pack:check`, đăng lên npm và tạo
   GitHub release. Provenance chỉ được ký khi repo public. Workflow cần secret `NPM_TOKEN` (granular access
   token của npm có quyền publish) trong Settings → Secrets and variables → Actions của repo. Một phiên bản
   đã đăng thủ công (`npm publish` từ máy) thì workflow bỏ qua bước đăng, chỉ tạo GitHub release.

`npm install` dùng `legacy-peer-deps` (đặt trong `.npmrc`) để tránh một lỗi của npm khi giải peer
dependency của Vitest.

`npm run build`, `npm run dev` và `npm test` đều chạy `scripts/bundle-framework.mjs` trước: script chép
các file framework đang được git theo dõi trong `pirl-framework/` vào `bundled-framework/` kèm
`manifest.json` (phiên bản và hash từng file), là bản framework đi kèm gói npm.

```text
src/
  bin/             điểm vào: pirl.ts đặt chế độ production rồi nạp main.tsx (tham số, target repo, Hub, TUI)
  core/            chạy tiến trình, đường dẫn, cấu hình, xác định target repo
  hub/             Hub git (nhánh upstream/main), framework đi kèm, cập nhật/hoàn tác/khôi phục (/framework)
  providers/       nhận diện provider (Claude Code)
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
