# Đề xuất: biến PIRL framework thành PIRL CLI

Trạng thái: giai đoạn 0, 1, 2 (pilot Claude Code) đã triển khai, xem mục 14. Cập nhật: 2026-10-24 (lần 6).

## 1. Kết luận

PIRL CLI là một ứng dụng TUI viết bằng TypeScript + Ink, cài trên máy từng
người dùng. Người dùng mở terminal (PowerShell, Git Bash, Terminal…) tại thư
mục project, gõ `pirl`, và làm việc trong một khung chat:

- `/pirl-plan <request>`, `/pirl-implement <request>`, `/pirl-review <request>`
  chạy layer tương ứng của PIRL framework.
- Nhập request không có dấu `/` là câu hỏi, standalone task hoặc bảo trì
  framework.

PIRL CLI **điều khiển các agent CLI chính chủ** mà người dùng đã cài và tự đăng
nhập bằng subscription của họ. Bản pilot dùng Claude Code. PIRL CLI **không**
tự làm màn hình đăng nhập, không đọc hay lưu token subscription, không gọi API
thay người dùng bằng token đó. Anthropic cấm bên thứ ba đưa "Claude.ai login"
vào ứng dụng của mình và cấm trung chuyển credential gói Free/Pro/Max, nhưng
cho phép người dùng cuối tự đăng nhập vào binary Claude Code không sửa đổi
bằng subscription của chính họ
([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).

## 2. Quyết định đã chốt

| Chủ đề | Quyết định |
| --- | --- |
| Giao diện | Gõ `pirl` mở TUI có khung chat; layer chạy bằng slash command; nhập không có `/` là câu hỏi, standalone task, bảo trì framework (mục 5) |
| Thẩm mỹ và kích cỡ | TUI phải đẹp mắt và co giãn linh hoạt theo mọi kích cỡ cửa sổ terminal (mục 5.7) |
| Danh sách lệnh | Đã xác nhận đủ và đúng (mục 6) |
| Xuất patch cải tiến | **Không** làm lệnh xuất patch, cả pilot lẫn bản chính thức, vì quá nhiều rủi ro (mục 10) |
| Ngôn ngữ cài đặt | TypeScript + Ink |
| Target repo | Thư mục nơi người dùng gõ `pirl`. Ví dụ đứng ở project A gõ `pirl` thì project A là target repo |
| Provider | Pilot cho Claude Code trước, sau đó phát triển cho provider khác |
| Phạm vi dùng | Mỗi người dùng cá nhân tự tải và cài. Mỗi người phải có sẵn provider AI của mình. Tuân thủ ToS của provider: không chia sẻ quyền sử dụng |
| Cập nhật framework | Phương án A: Hub là git repo, merge 3 chiều. Mọi quyết định của phần này ưu tiên chất lượng, tối ưu, tiện dụng (mục 9) |
| Múi giờ | Bỏ múi giờ cố định UTC+7; **đã thực hiện** (mục 13) |

Hệ quả của phạm vi dùng cá nhân:

- Không có server, không có tài khoản PIRL, không dùng chung subscription.
- PIRL CLI không đọc file credential của provider. Kiểm tra đăng nhập bằng
  lệnh trạng thái của chính provider đó.
- Plan, report, record và framework đã tự cải tiến chỉ nằm trên máy người dùng.
- Không dùng tên hay logo "Claude Code" trong tên sản phẩm.

## 3. Hiện trạng PIRL framework (đã đọc trong repo)

- Framework chạy hoàn toàn bằng file chỉ dẫn: `AGENTS.md`, `CONTEXT.md`,
  router `.agents/instructions/layered-task-execution.instructions.md`, 3 layer
  contract, 9 role, 3 skill `pirl-plan|pirl-implement|pirl-review`.
- Công cụ Python 3.9+: `new_plan.py`, `new_review.py`,
  `add_implementation_record.py`, `new_layout_run.py`,
  `validate_layer_artifact.py`, `layer_record.py`. 24 test đều PASS
  (`python3 -B -m unittest discover -s .agents/evals/tests -p "test_*.py"`).
- Framework phụ thuộc vào "host" ở 4 điểm mà CLI làm chắc chắn hơn (mục 4):
  host tự suy ra layer; sub-agent cho từng role tuỳ host; độc lập giữa role chỉ
  là lời dặn; các bước quy trình do LLM tự nhớ.

## 4. PIRL CLI bổ sung được gì

| Vấn đề hiện tại | PIRL CLI xử lý thế nào |
| --- | --- |
| Layer được suy ra từ lời nói, có thể nhầm hoặc tự mở layer tiếp theo | Layer chỉ mở bằng slash command. Quy tắc "không tự mở layer tiếp theo" thành code. |
| Sub-agent tùy host | CLI tự là coordinator: mỗi role là một tiến trình agent headless riêng, có độc lập thật trên mọi provider. |
| Độc lập giữa role chỉ là lời dặn | CLI quyết định role đọc gì, ghi gì, chạy lệnh gì (mục 7.2). |
| Bước quy trình do LLM tự nhớ | CLI tự chạy `layer_record.py start`, `new_plan.py`, validator (lặp đến khi PASS), `append`/`check`, cleanup. |
| Người dùng phải clone Hub, nhớ đường dẫn | Lần chạy đầu tự dựng Hub; target repo là thư mục hiện tại. |
| Không biết đã tốn bao nhiêu quota | Thanh trạng thái hiển thị số lượt gọi và usage; ghi vào record. |

## 5. Thiết kế TUI

### 5.1. Khởi động khi gõ `pirl`

1. **Xác định target repo.** Lấy thư mục hiện tại; nếu đang ở thư mục con của
   một git repo thì lấy gốc repo (`git rev-parse --show-toplevel`). Thư mục
   không phải git repo: TUI vẫn mở, báo rõ trên header, và chỉ cho câu hỏi; các
   layer bị khoá cho tới khi người dùng mở `pirl` trong một git repo.
2. **Chuẩn bị Hub.** Lần đầu: tạo `~/.pirl/hub` từ bản framework đóng gói
   (mục 9.3). Các lần sau: kiểm tra có bản framework gốc mới không; có thì hiện
   thông báo trên header, không chặn công việc.
3. **Kiểm tra nhanh.** Provider đã cài và đã đăng nhập chưa, Python, Git. Lỗi
   thì hiện thông báo kèm cách sửa; chi tiết ở `/doctor`.
4. **Khôi phục phiên.** Có run đang dở của repo này thì gợi ý `/resume`.
5. Hiện màn hình chat với dòng gợi ý: "Gõ `/` để xem lệnh, hoặc nhập yêu cầu".

### 5.2. Bố cục màn hình

```text
┌ PIRL · shop-web (main) · Claude Code · framework fw-1.0 (+2 cải tiến) ─ Có bản mới ┐
│                                                                                    │
│ Bạn  › /pirl-plan Khách nhận email khi đơn hàng bị huỷ                             │
│                                                                                    │
│ ┌ Plan · đang chạy ────────────────────────────────────────────────────────────┐   │
│ │ ✔ business-analyst     ▸ code-analyst      ○ solution-architect             │   │
│ │ code-analyst: Đang đọc src/orders/cancel.ts · tìm thấy 3 nơi gọi cancelOrder │   │
│ │                                                                (Tab: chi tiết) │   │
│ │ ? Cần quyết định: Gửi email cả khi admin huỷ đơn?   [Có]  [Không]           │   │
│ └──────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                    │
│ PIRL › ...                                                                         │
├────────────────────────────────────────────────────────────────────────────────────┤
│ › /pirl-█                                                                          │
│   /pirl-plan        Tạo Plan cho request                                           │
│   /pirl-implement   Thực hiện một task của Plan, hoặc sửa theo report              │
│   /pirl-review      Review kết quả implement của một task                          │
├────────────────────────────────────────────────────────────────────────────────────┤
│ 6 lượt gọi · run: Plan 2/4 role                    Esc dừng · Tab chi tiết · /help  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

| Vùng | Nội dung |
| --- | --- |
| Header | Target repo và nhánh, provider, phiên bản framework và số cải tiến cục bộ, thông báo có bản framework mới |
| Khung chat | Tin nhắn của người dùng, câu trả lời, và **run block** cho mỗi lần chạy layer (mục 5.4). Cuộn được; nội dung cũ không vẽ lại |
| Ô nhập | Nhiều dòng; gõ `/` hiện danh sách lệnh lọc theo chữ đã gõ; ↑/↓ xem lại lệnh đã nhập |
| Thanh trạng thái | Usage, tiến độ run, phím tắt |
| Lớp phủ | Mở khi cần: chọn Plan/task, xem diff, giải quyết xung đột framework, cài đặt, kết quả `/doctor` |

### 5.3. Định tuyến nội dung nhập

| Nội dung nhập | Xử lý |
| --- | --- |
| `/pirl-plan <request>` | Mở layer Plan với request đó |
| `/pirl-implement <request>` | Mở layer Implement. Request xác định Plan/task hoặc report cần sửa theo; thiếu hoặc khớp nhiều Plan thì mở lớp phủ để chọn |
| `/pirl-review <request>` | Mở layer Review. Xác định task như trên |
| Lệnh `/` khác | Lệnh quản lý (mục 6) |
| Không có `/` | Gửi coordinator. Coordinator phân loại theo `AGENTS.md`: câu hỏi (trả lời, không tạo file), standalone task, hoặc bảo trì framework |
| Không có `/` nhưng đang hỏi một layer (ví dụ "tạo plan cho…") | Không mở layer. TUI điền sẵn `/pirl-plan <request>` vào ô nhập để người dùng nhấn Enter |
| Đang có câu hỏi chờ trả lời | Nội dung nhập (hoặc nút chọn) là câu trả lời cho câu hỏi đó |

Quy tắc thêm:

- Chỉ một run layer chạy tại một thời điểm. Trong lúc run chạy, người dùng vẫn
  gõ câu hỏi được; standalone task và bảo trì framework phải đợi run xong, vì
  chúng có thể sửa cùng file.
- Hội thoại không có `/` giữ ngữ cảnh trong phiên: sau `/pirl-plan`, hỏi
  "T02 phụ thuộc gì?" thì coordinator trả lời dựa trên Plan vừa tạo.
- Khi chạy dưới PIRL CLI, cách chọn layer trong `AGENTS.md` cần ghi thêm: layer
  được chọn bằng slash command. Việc sửa này thuộc giai đoạn pilot.

### 5.4. Run block

Mỗi lần chạy layer tạo một khối trong khung chat, đi qua các trạng thái:

1. **Đang chạy:** danh sách role và trạng thái từng role; dòng hoạt động mới
   nhất của role đang chọn; Tab mở log đầy đủ.
2. **Cần quyết định:** câu hỏi của role, kèm các lựa chọn và lựa chọn được
   khuyến nghị. Phần phụ thuộc dừng; phần độc lập vẫn chạy.
3. **Kết quả:** file đã tạo hoặc sửa, kết quả validator, kết luận
   (`PASS|FAIL|BLOCKED` với Review), bước tiếp theo gợi ý dưới dạng lệnh để
   người dùng tự gõ (không tự chạy).
4. **Tự cải tiến:** danh sách file framework đã sửa; Enter mở diff; câu hỏi
   "Commit cải tiến này vào Hub? [Có] [Không] [Bỏ cải tiến]" (mục 9.4).

Esc dừng run: CLI dừng các tiến trình role, giữ trạng thái để `/resume`.

### 5.5. Kiến trúc thành phần

```text
 Ink UI (components)          Header, ChatView, RunBlock, InputBox + CommandPalette, StatusBar, Overlays
        ▲  render từ store          │ hành động người dùng
        │                           ▼
 Session store                InputRouter → CommandRegistry (lệnh /) | Conversation (không /)
        ▲  sự kiện                  │
        │                           ▼
 Engine (không phụ thuộc UI)  LayerRun: start → roles → merge → validate → audit → record → cleanup
        │                           │
        ▼                           ▼
 Providers (claude, …)        Hub (git, framework update)      Tools (script Python của framework)
```

- **Engine phát sự kiện**, UI chỉ hiển thị: `run.started`, `role.started`,
  `role.output`, `role.question`, `role.finished`, `validator.result`,
  `audit.result`, `run.finished`. Nhờ đó engine chạy và test được không cần
  UI, dùng provider giả lập.
- **CommandRegistry:** mỗi lệnh khai báo tên, mô tả, có nhận request không, và
  hàm xử lý. Danh sách gợi ý khi gõ `/` sinh từ registry.
- **Test UI:** `ink-testing-library` cho từng component; kịch bản đầu-cuối
  chạy engine với provider giả lập.

### 5.6. Dữ liệu lưu trên máy

| Đường dẫn | Nội dung |
| --- | --- |
| `~/.pirl/config.json` | Provider, model theo role, số role chạy song song |
| `~/.pirl/hub/` | Hub: framework (git), Plan, report, record (mục 9.3) |
| `~/.pirl/sessions/<repo>/` | Lịch sử chat và trạng thái run dở để `/resume` |

Trên Windows, `~` là `%USERPROFILE%`.

### 5.7. Thẩm mỹ và co giãn theo kích cỡ màn hình

#### Hệ thống thiết kế

Mọi màu, ký hiệu và khoảng cách lấy từ một bộ token duy nhất (`ui/theme`);
component không ghi mã màu trực tiếp. Nhờ vậy giao diện nhất quán và đổi
theme chỉ cần đổi token.

| Token | Dùng cho | Ghi chú |
| --- | --- | --- |
| `accent` | Tên lệnh, viền khối đang hoạt động, con trỏ chọn | Một màu nhấn duy nhất |
| `success`, `warning`, `danger` | PASS, cần quyết định, FAIL/BLOCKED | Luôn đi kèm ký hiệu và chữ, không chỉ dựa vào màu |
| `muted` | Gợi ý phím tắt, thời gian, đường dẫn phụ | Chữ mờ (dim) |
| `border` | Viền khung, đường phân cách | Viền bo góc `╭╮╰╯` |
| `role.*` | Màu riêng của từng role trong run block | 9 role, chọn để phân biệt được trên nền sáng và tối |

Nguyên tắc trình bày:

- Thứ bậc bằng độ đậm và màu, không bằng nhiều đường viền: chỉ run block và
  lớp phủ có viền; tin nhắn chat không có viền.
- Khoảng cách theo lưới 1 ký tự: lề trong 1, cách giữa các khối 1 dòng trống.
- Nội dung markdown trong câu trả lời (tiêu đề, danh sách, bảng, khối code)
  được hiển thị có định dạng, khối code có tô màu cú pháp.
- Chuyển động tiết chế: chỉ spinner của role đang chạy; không nhấp nháy.

Thích ứng với terminal:

| Điều kiện | Cách xử lý |
| --- | --- |
| Nền sáng hoặc tối | Tự nhận theo terminal khi đọc được; người dùng chọn lại trong `/settings` |
| Truecolor, 256 màu, 16 màu | Mỗi token có giá trị cho cả 3 mức; tự hạ mức theo khả năng terminal |
| Biến môi trường `NO_COLOR` | Tắt màu; trạng thái vẫn đọc được nhờ ký hiệu và chữ |
| Terminal không hiển thị được ký tự viền hoặc ký hiệu (một số console Windows cũ) | Dùng bộ ký tự ASCII thay thế (`+-|`, `[x]`, `>`) |
| Chữ tiếng Việt, CJK, emoji | Đo độ rộng bằng thư viện đo độ rộng hiển thị (ví dụ `string-width`), không đếm số ký tự, để cột không lệch |

#### Co giãn theo kích cỡ

Bố cục chọn theo số cột và số dòng hiện tại của terminal. Khi người dùng kéo
cửa sổ, TUI nghe sự kiện resize của terminal và vẽ lại ngay theo bố cục mới,
không mất nội dung, không mất trạng thái nhập.

| Mức | Số cột | Bố cục |
| --- | --- | --- |
| Rộng | ≥ 120 | Hai vùng: khung chat bên trái, bảng bên phải (khoảng 1/3 chiều rộng) hiện danh sách role và chi tiết role đang chọn của run đang chạy. Header đầy đủ |
| Chuẩn | 80–119 | Một cột. Danh sách role nằm trong run block. Header đầy đủ, rút gọn đường dẫn |
| Hẹp | 60–79 | Một cột. Header chỉ còn tên repo và provider. Danh sách role thành một dòng ký hiệu (`✔ ▸ ○ ○`) kèm tên role đang chạy. Thanh trạng thái bỏ gợi ý phím, giữ usage |
| Rất hẹp | < 60 | Như mức hẹp, thêm: ẩn header, thanh trạng thái còn một mục. Dưới 40 cột hiện thông báo "Cửa sổ quá hẹp, hãy mở rộng" thay vì vẽ bố cục vỡ |

| Số dòng | Bố cục |
| --- | --- |
| ≥ 24 | Đầy đủ |
| 16–23 | Ô nhập tối đa 3 dòng; danh sách gợi ý lệnh tối đa 5 mục |
| < 16 | Ẩn header; danh sách gợi ý lệnh tối đa 3 mục |

Quy tắc cho từng loại nội dung:

| Nội dung | Cửa sổ rộng | Cửa sổ hẹp |
| --- | --- | --- |
| Đường dẫn dài | Hiện đủ | Rút gọn ở giữa: `src/…/cancel.ts` |
| Bảng markdown | Hiện dạng bảng | Bảng không vừa chiều rộng thì chuyển thành danh sách "tên cột: giá trị" |
| Diff | Hai cột cạnh nhau | Một cột, dòng `-`/`+` xen kẽ |
| Xung đột framework 3 cột (mục 9.2) | 3 cột cạnh nhau khi ≥ 150 cột | Ba tab (bản gốc cũ, bản của bạn, bản gốc mới), chuyển bằng ←/→ |
| Lựa chọn trong câu hỏi | Các nút trên một hàng | Mỗi lựa chọn một dòng |

#### Hiệu năng hiển thị

- TUI chạy ở màn hình phụ của terminal (alternate screen, như vim, htop) và tự
  dàn trang: nội dung chat được dàn thành từng dòng theo chiều rộng hiện tại,
  chỉ những dòng vừa khung được vẽ. Nhờ vậy khi đổi kích cỡ, toàn bộ nội dung
  được dàn lại theo bố cục mới; cuộn bằng PgUp/PgDn. (Ban đầu đề xuất dùng
  thành phần `Static` của Ink; `Static` in nội dung ra một lần nên không dàn lại
  được khi đổi kích cỡ, vì vậy không dùng.)
- Ink vẽ lại tối đa 30 lần mỗi giây; output của role sẽ được gom theo nhịp này.

#### Kiểm chứng giao diện

- Test chụp ảnh văn bản (snapshot) của mỗi màn hình ở các chiều rộng 40, 60,
  80, 120, 160 cột và chiều cao 15, 24, 40 dòng, bằng `ink-testing-library`.
- Test thay đổi kích cỡ giữa lúc run đang chạy: nội dung và trạng thái nhập
  không mất.
- Chạy thử bằng tay trên Windows Terminal, PowerShell, Git Bash, Terminal và
  iTerm2 trên macOS, một terminal Linux; mỗi nơi thử nền sáng và nền tối.

## 6. Danh sách lệnh (đã xác nhận)

Lệnh gõ ở terminal:

| Lệnh | Việc làm |
| --- | --- |
| `pirl` | Mở TUI, target repo là thư mục hiện tại |
| `pirl --version` | In phiên bản CLI và framework đóng gói |
| `pirl --help` | In hướng dẫn ngắn |

Lệnh gõ trong TUI:

| Nhóm | Lệnh | Việc làm |
| --- | --- | --- |
| Layer | `/pirl-plan <request>` | Tạo hoặc điều chỉnh Plan |
| Layer | `/pirl-implement <request>` | Thực hiện một task của Plan, hoặc sửa theo report Review |
| Layer | `/pirl-review <request>` | Review kết quả implement của một task |
| Run | `/resume` | Chạy tiếp run bị dừng (Esc, hết quota, mất mạng, đóng TUI) |
| Tra cứu | `/plans` | Danh sách Plan, task, report và trạng thái của target repo hiện tại |
| Tra cứu | `/records` | Tra cứu record tự cải tiến |
| Cấu hình | `/settings` | Provider, model theo role, số role chạy song song |
| Cấu hình | `/doctor` | Kiểm tra provider đã cài và đã đăng nhập, Python, Git, Hub |
| Framework | `/framework` | Bảng điều khiển framework: xem khác biệt so với bản gốc, cập nhật, khôi phục file, lịch sử và hoàn tác cải tiến (mục 9) |
| Phiên | `/clear` | Xoá khung chat, bắt đầu hội thoại mới (không xoá Plan, report, record) |
| Phiên | `/help` | Danh sách lệnh và phím tắt |
| Phiên | `/exit` | Thoát TUI |

Không có lệnh riêng cho commit/push trong target repo: người dùng yêu cầu bằng
lời (không có `/`), đúng quy tắc "chỉ commit khi người dùng yêu cầu" của
framework. Commit cải tiến framework được hỏi ở cuối mỗi run (mục 9.4).

## 7. Kiến trúc tổng

```text
pirl (TypeScript + Ink)
├── bin/pirl       điểm vào: xác định target repo, chuẩn bị Hub, mở TUI
├── ui/            component Ink (mục 5.5)
├── commands/      CommandRegistry và các lệnh / (mục 6)
├── engine/        LayerRun, Conversation, phân loại request
├── hub/           Hub git, cập nhật framework
├── tools/         gọi script Python của framework như tiến trình con
├── providers/
│   ├── claude     pilot: claude -p ... --output-format stream-json
│   ├── codex      giai đoạn sau
│   ├── gemini     giai đoạn sau
│   ├── copilot    giai đoạn sau
│   └── fake       provider giả lập cho test
└── framework/     bản PIRL framework gốc đóng gói kèm phiên bản CLI
```

### 7.1. Provider adapter

Interface chung:

```text
detect()      có binary không, phiên bản nào, đã đăng nhập chưa
run(task)     prompt hệ thống + prompt role, thư mục làm việc, quyền đọc/ghi/chạy lệnh,
              model, timeout → luồng sự kiện, kết quả, file đã sửa, usage
resume(id)    tiếp tục phiên của một role sau khi người dùng trả lời câu hỏi
capabilities  có chặn quyền theo đường dẫn không, có JSON output không, có resume không
```

Cờ Claude Code cho pilot (kiểm tra lại theo phiên bản khi viết adapter):
`claude -p`, `--output-format stream-json`, `--append-system-prompt`,
`--allowedTools`/`--disallowedTools` (có quy tắc theo đường dẫn, ví dụ dạng
`Edit(src/**)`), `--permission-mode`, `--add-dir`, `--model`, `--resume`.

Ghi chú cho giai đoạn sau:

- Codex: `codex exec --json --sandbox read-only|workspace-write --cd <dir>`;
  đăng nhập ChatGPT Plus/Pro/Team dùng được cho `codex exec`
  ([Codex auth](https://developers.openai.com/codex/auth)).
- Gemini CLI: `gemini -p`; tài liệu chính thức khuyên dùng API key hoặc Vertex
  AI cho chế độ headless
  ([Gemini CLI auth](https://www.geminicli.com/docs/get-started/authentication)).
- Copilot CLI: `copilot -p`; mỗi prompt tiêu tốn premium request
  ([Copilot CLI programmatic](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)).
- Agent Client Protocol (ACP) có SDK TypeScript chính thức
  `@agentclientprotocol/sdk`
  ([ACP TypeScript library](https://agentclientprotocol.com/libraries/typescript));
  interface trên được thiết kế để thay phần gọi headless bằng ACP sau này mà
  engine không đổi.

### 7.2. Quyền theo role và layer

Ký hiệu: **Target** là target repo; **Hub** là Hub của người dùng; **Allowed
paths** là danh sách đường dẫn được phép trong task của Plan.

| Layer | Role | Loại | Đọc | Ghi | Chạy lệnh |
| --- | --- | --- | --- | --- | --- |
| Plan | coordinator | điều phối | Target, Hub | Plan package (qua `new_plan.py`) | Script framework, validator |
| Plan | `business-analyst` | lập kế hoạch | Target, request | Không | Không |
| Plan | `code-analyst` | lập kế hoạch | Target | Không | Chỉ git đọc (`git log`, `git show`, `git diff`) |
| Plan | `solution-architect` | lập kế hoạch | Target | Không | Không |
| Plan | `ux-designer` | lập kế hoạch | Target | Không | Không |
| Plan | `process-auditor` | tự đánh giá | Plan, nguồn đã dùng, kết luận của các role | File framework trong Hub, record (qua `layer_record.py`) | Test và validator của framework |
| Implement | coordinator | điều phối | Target, Plan | Implementation Record (qua `add_implementation_record.py`) | Script framework |
| Implement | `backend-developer` | thực hiện | Target | Target, chỉ trong Allowed paths | Test FUT theo lệnh trong tài liệu của target repo |
| Implement | `frontend-developer` | thực hiện | Target | Target, chỉ trong Allowed paths; ảnh chụp layout trong `.tmp/layout-snapshots/` | Test FUT; chụp layout bằng mock (dev server, trình duyệt, `new_layout_run.py`) |
| Implement | `technical-writer` | thực hiện | Target | Tài liệu trong Target, chỉ trong Allowed paths | Không |
| Implement | `code-reviewer` | kiểm chứng | Target, diff, Plan | Không | Chỉ git đọc |
| Implement | `code-analyst` | kiểm chứng | Target, diff, Plan | Không | Chỉ git đọc |
| Implement | `ux-designer` | kiểm chứng | Target, ảnh chụp và số đo layout | Không | Không |
| Implement | `process-auditor` | tự đánh giá | Như ở Plan, thêm Implementation Record | Như ở Plan | Như ở Plan |
| Review | coordinator | điều phối | Target, Plan, Implementation Record | Report (qua `new_review.py`) | Script framework, validator |
| Review | `code-analyst` | review | Target, diff, Plan, Implementation Record | Không | Chỉ git đọc |
| Review | `code-reviewer` | review | Như trên | Không | Chỉ git đọc |
| Review | `business-analyst` | review | Như trên | Không | Không |
| Review | `solution-architect` | review | Như trên | Không | Không |
| Review | `ux-designer` (khi diff đổi UI) | review | Như trên, thêm ảnh chụp layout | Không | Không |
| Review | `process-auditor` | tự đánh giá | Report, Implementation Record, nguồn đã dùng | Phần `Evaluations` của report, file framework trong Hub, record | Test và validator của framework |

Cách cưỡng chế:

- Quyền của từng dòng được dịch thành cờ quyền của provider khi gọi role đó.
- Sau khi role thực hiện xong, CLI chạy `git diff --name-only` trong target
  repo và so với Allowed paths; file ngoài danh sách thì dừng và hỏi người dùng.
- Role kiểm chứng và role review không được đọc bản nháp của coordinator hay
  role khác trong cùng run: CLI không truyền và chặn đọc các đường dẫn đó.
- Provider nào không cưỡng chế được một quyền thì TUI cảnh báo và CLI ghi mức
  độc lập thực tế vào output, đúng quy tắc sẵn có của router.

### 7.3. Engine: phần nào là code, phần nào là LLM

| Bước | Ai làm |
| --- | --- |
| Chọn layer | Code, theo slash command |
| Phân loại nội dung không có `/` | LLM (coordinator), theo `AGENTS.md` |
| `layer_record.py start`, ghim `framework_ref` | Code |
| Đọc context doc của target repo | LLM (coordinator) |
| Chọn đội role | LLM đề xuất, code kiểm tra role hợp lệ với layer theo role catalog |
| Giao việc từng role, chạy song song khi không phụ thuộc | Code điều phối, LLM thực hiện |
| Gộp kết quả theo bằng chứng | LLM (coordinator) |
| Tạo file Plan/report từ template | Code (`new_plan.py`, `new_review.py`) |
| Validate, lặp sửa đến khi PASS | Code chạy validator, LLM sửa |
| Hỏi người dùng khi thiếu quyết định | Role trả câu hỏi dạng JSON; TUI hỏi; code lưu câu trả lời và `resume` role |
| process-auditor | LLM ở tiến trình riêng |
| `append`/`check` record, cleanup | Code |
| Commit cải tiến framework vào Hub | Code, chỉ khi người dùng chọn "Có" ở cuối run |
| Commit/push trong target repo | Chỉ khi người dùng yêu cầu bằng lời |

## 8. Ngôn ngữ cài đặt (đã chốt TypeScript + Ink)

Lý do: đây là bộ công nghệ mà Claude Code và Gemini CLI dùng cho cùng loại giao
diện (luồng output của agent, câu hỏi giữa chừng, duyệt quyền), và là ngôn ngữ
có cả SDK ACP chính thức lẫn Agent SDK của Anthropic cho các giai đoạn sau.

Các script Python của framework **giữ nguyên là Python**, vì
`process-auditor` được phép sửa chúng (`FRAMEWORK_PATHS` trong
`layer_record.py` gồm `.agents/evals` và `.skills`). CLI gọi chúng như tiến
trình con. Yêu cầu cài đặt: Node.js 22+ (Ink 7 yêu cầu Node 22), Python
3.9+, Git, và provider AI của người dùng.

Nguồn về bộ công nghệ của các agent CLI là bài viết bên thứ ba
([so sánh Gemini CLI và Codex CLI](https://blog.logrocket.com/gemini-cli-vs-codex-cli/),
[danh sách dự án dùng Ink](https://www.libhunt.com/r/ink)).

## 9. Framework tự cải tiến và cập nhật (đã chốt phương án A)

### 9.1. Nguyên tắc

1. Bản cập nhật CLI không bao giờ ghi vào Hub. Chỉ người dùng, qua
   `/framework`, mới đưa bản framework gốc mới vào Hub.
2. Framework đang dùng (nhánh `main`) không bao giờ ở trạng thái hỏng: mọi
   thao tác cập nhật làm trên bản nháp, kiểm tra xong mới áp dụng.
3. Không bao giờ chặn công việc: có bản mới chỉ hiện thông báo; người dùng cập
   nhật khi muốn.
4. Phần nào máy tự quyết được an toàn thì tự quyết; phần cần người quyết thì
   giải thích bằng lời và đưa lựa chọn khuyến nghị.
5. Không thay đổi nào nới lỏng safety rule mà người dùng không duyệt.

### 9.2. Vận hành qua một ví dụ

1. Người dùng cài PIRL CLI 1.0 (kèm framework `fw-1.0`), gõ `pirl` lần đầu.
   CLI tạo Hub với nhánh `upstream` = `fw-1.0` và nhánh `main` = `fw-1.0`.
2. Sau vài run, `process-auditor` sửa 2 chỗ: một rule trong
   `implement.instructions.md` và một câu trong `code-analyst.role.md`. Cuối
   mỗi run người dùng chọn "Có", nên `main` có thêm 2 commit cải tiến.
3. Người dùng cập nhật CLI lên 1.1 (kèm `fw-1.1`). Lần sau gõ `pirl`, header
   hiện "Có bản framework mới". Công việc vẫn chạy bình thường trên `main`.
4. Người dùng mở `/framework` → "Cập nhật". CLI làm trên bản nháp:
   - commit `fw-1.1` lên `upstream`;
   - tạo nhánh tạm từ `main` và merge `upstream` vào đó;
   - kết quả: `fw-1.1` sửa 10 file. 9 file không đụng chỗ người dùng sửa nên
     nhận tự động. `code-analyst.role.md` bị cả hai bên sửa cùng đoạn: xung đột.
5. TUI hiện xung đột với 3 cột (bản gốc cũ, bản của bạn, bản gốc mới) và lời
   giải thích: bản gốc mới đổi gì (lấy từ changelog), bản của bạn đổi gì và vì
   sao (lấy từ record của cải tiến đó), kèm lựa chọn khuyến nghị: giữ bản của
   bạn, lấy bản gốc mới, hoặc bản gộp do agent đề xuất.
6. Sau khi chọn, CLI chạy test framework và validator trên bản nháp. PASS thì
   chuyển `main` sang bản nháp và gắn mốc `pre-update/fw-1.1` ở vị trí cũ để
   hoàn tác. FAIL thì bỏ bản nháp, `main` giữ nguyên, TUI báo lỗi.
7. Nếu sau đó framework mới chạy tệ hơn, `/framework` → "Hoàn tác lần cập nhật
   gần nhất" đưa `main` về mốc `pre-update/fw-1.1`.

### 9.3. Cấu trúc Hub

```text
~/.pirl/hub                         git repo cục bộ, không có remote
  nhánh upstream                    mỗi commit = một phiên bản framework gốc, tag fw-<version>
  nhánh main                        upstream + các commit cải tiến cục bộ
  tag pre-update/<version>          mốc để hoàn tác mỗi lần cập nhật
  .agents/evals/records/            record (Git bỏ qua, như hiện nay)
  <plan-set>/                       Plan và report (Git bỏ qua, như hiện nay)
```

Mỗi commit cải tiến có trailer để truy nguồn:
`Pirl-Record: <record_id>` và `Pirl-Source: auditor|manual`. TUI dùng trailer
này để giải thích xung đột (bước 5 ở mục 9.2) và để liệt kê lịch sử cải tiến
trong `/framework`.

### 9.4. Các quyết định về chất lượng và tiện dụng

| Tình huống | Quyết định | Lý do |
| --- | --- | --- |
| Commit cải tiến | Cuối run, TUI hiện diff và hỏi "Commit cải tiến này vào Hub? [Có] [Không] [Bỏ cải tiến]". "Có" là yêu cầu commit của người dùng | Giữ đúng safety rule "chỉ commit khi người dùng yêu cầu" trong `AGENTS.md` |
| Cải tiến làm hỏng framework | Sau mỗi lần `process-auditor` sửa file, CLI chạy test và validator; FAIL thì hoàn tác chính sửa đổi đó và ghi vào record | Không để framework hỏng lọt vào `main` |
| Có cải tiến chưa commit khi cập nhật | TUI liệt kê và yêu cầu commit hoặc bỏ trước | Merge cần thư mục làm việc sạch |
| Đang có run | Không cho cập nhật cho tới khi run xong | Run đã ghim `framework_ref` |
| Hai bên sửa giống hệt nhau | Git tự gộp, không hỏi | Không có gì để quyết định |
| Cải tiến cục bộ đã thừa vì bản gốc sửa cùng vấn đề | Sau cập nhật, agent đối chiếu và đề xuất bỏ; người dùng duyệt | Giảm lệch so với bản gốc, giảm xung đột lần sau |
| Xung đột chạm safety rule | Không có lựa chọn tự động; người dùng phải đọc và chọn | Nguyên tắc 5 |
| Phiên bản schema | CLI vẫn chạy với framework cũ, trừ khi framework cũ dùng schema CLI không còn đọc (`pirl-plan/v1`, `pirl-review/v1`, `pirl-record/v1`); khi đó TUI yêu cầu cập nhật trước khi chạy layer | Không chặn công việc khi không cần |

## 10. Xuất patch cải tiến: quyết định không làm

PIRL CLI **không** có lệnh xuất patch cải tiến, cả ở pilot lẫn bản chính thức.
Lý do: bản đánh giá trước đó tìm ra 10 rủi ro, nặng nhất là lộ thông tin dự án
hoặc bí mật trong rule do `process-auditor` viết (gửi rồi thì không thu hồi
được), lộ tên và email trong header của patch, và patch nới lỏng safety rule lan
sang mọi người dùng nếu bản gốc nhận nó.

Hệ quả cho thiết kế:

- Cải tiến cục bộ chỉ tồn tại trong Hub trên máy người dùng. CLI không có
  đường nào gửi nội dung framework, Plan, report hay record ra ngoài.
- Bản framework gốc chỉ thay đổi qua bản phát hành chính thức kèm CLI.
- Lệch giữa bản cục bộ và bản gốc được giữ trong giới hạn bằng bước đối chiếu
  sau mỗi lần cập nhật (mục 9.4): cải tiến cục bộ đã thừa được đề xuất bỏ.
- Trailer `Pirl-Record` và `Pirl-Source` vẫn được giữ, vì chúng phục vụ việc
  giải thích xung đột và xem lịch sử trong `/framework` (mục 9.3).

## 11. Rủi ro khác

1. **Quota subscription.** Một lần chạy layer = 1 coordinator + N role +
   process-auditor + các vòng sửa validator, dễ thành 5–15 lần gọi agent.
   Anthropic ghi rõ giới hạn của gói Pro/Max giả định "mức dùng cá nhân thông
   thường". Cần giới hạn số role chạy song song, hiển thị usage, dừng an toàn
   khi gặp rate limit và cho chạy tiếp bằng `/resume`.
2. **Khác biệt năng lực provider.** Adapter khai báo `capabilities`; thiếu thì
   TUI cảnh báo và CLI ghi mức độc lập thực tế.
3. **Câu hỏi giữa chừng.** Pilot phải kiểm chứng `claude --resume` cho phép
   role nhận câu trả lời rồi làm tiếp.
4. **Git Bash trên Windows.** Ink cần terminal ở chế độ raw. Cửa sổ Git Bash
   (mintty) cũ không hỗ trợ đầy đủ chế độ này cho Node.js. Pilot phải chạy thử
   trên PowerShell, Windows Terminal và Git Bash; nếu Git Bash lỗi thì hướng dẫn
   mở Git Bash trong Windows Terminal.

## 12. Lộ trình

| Giai đoạn | Nội dung | Kết quả kiểm chứng |
| --- | --- | --- |
| 0. Khung (**đã xong**) | Dự án TypeScript + Ink; khởi động (mục 5.1); hệ thống thiết kế và bố cục co giãn (mục 5.7) kèm test snapshot theo kích cỡ; CommandRegistry; `/help`, `/doctor`, `/settings`, `/clear`, `/exit`; Hub git với `upstream`/`main` | Gõ `pirl` trong một repo mở TUI, nhận đúng target repo, `/doctor` nhận ra `claude` đã đăng nhập; kéo cửa sổ qua 4 mức chiều rộng không vỡ bố cục |
| 1. Pilot Claude Code: Plan | Adapter Claude Code; `/pirl-plan` chạy đủ vòng; run block; câu hỏi giữa chừng; hỏi commit cải tiến có trailer | Tạo Plan hợp lệ cho một repo mẫu, validator PASS |
| 2. Pilot Claude Code: đủ 3 layer và chat | `/pirl-implement`, `/pirl-review`, cưỡng chế quyền theo mục 7.2, nhập không có `/`, `/resume`, `/plans`, `/records` | Chạy trọn chuỗi Plan → Implement → Review trên repo mẫu |
| 3. Cập nhật framework | `/framework`: diff, cập nhật trên bản nháp, giải quyết xung đột 3 cột, hoàn tác | Cập nhật lên bản gốc mới mà giữ được cải tiến cục bộ |
| 4. Provider khác | Codex, Copilot, Gemini; provider và model theo role | Review bằng provider khác với Implement |
| 5. Hoàn thiện | Bản 1 file thực thi, cân nhắc ACP | Test đầu-cuối bằng provider giả lập chạy trong CI |

## 13. Đã thực hiện: bỏ múi giờ cố định UTC+7

UTC+7 không chỉ nằm ở `new_plan.py` và `layer_record.py`. Validator bắt buộc
mọi mốc thời gian phải là `+07:00`, nên nếu chỉ sửa hai file đó, Plan tạo trên
máy ở múi giờ khác sẽ bị validator từ chối. Vì vậy đã sửa đồng bộ:

| File | Thay đổi |
| --- | --- |
| `new_plan.py`, `new_review.py`, `add_implementation_record.py`, `new_layout_run.py`, `layer_record.py` | Dùng múi giờ của máy (`datetime.now().astimezone()`), mốc thời gian vẫn ghi kèm độ lệch UTC |
| `validate_layer_artifact.py` | Chấp nhận mọi độ lệch UTC, vẫn từ chối mốc thời gian không có độ lệch |
| `layer_record.py` (`check`) | So thứ tự record theo thời điểm thật thay vì so chuỗi; trước đây `10:00+07:00` bị coi là sau `04:00+00:00` dù thực tế sớm hơn 1 giờ |
| `plan-format.md`, `review-format.md`, `implementation-record-format.md` | Mô tả mới về múi giờ |
| Test | Sửa 1 test; thêm 2 test: validator nhận mọi độ lệch và từ chối mốc không có độ lệch; `check` xếp record theo thời điểm khi độ lệch khác nhau |

Kiểm chứng: 24/24 test PASS, cả khi đặt múi giờ máy là `America/New_York`.
Test mới về thứ tự record FAIL khi tạm đưa code về cách so chuỗi cũ, nên test
bắt được đúng lỗi đó.

## 14. Trạng thái triển khai

### 14.1. Giai đoạn 0: đã xong

| Hạng mục | Kết quả |
| --- | --- |
| Lệnh | Đủ 12 lệnh trong TUI và 3 lệnh terminal (mục 6). Dùng được ngay: `/help`, `/doctor`, `/settings`, `/framework` (xem trạng thái), `/clear`, `/exit`. Các lệnh còn lại báo rõ giai đoạn sẽ có |
| Khởi động | Target repo là git repo chứa thư mục hiện tại; ngoài git repo thì khoá layer. Hub tạo lần đầu ở `~/.pirl/hub` với nhánh `upstream` và `main`, tag `fw-1.0.0`, không có remote |
| Provider | Claude Code: nhận phiên bản và trạng thái đăng nhập qua `claude auth status --json`, không đọc credential |
| Kiểm tra môi trường | Node.js, Git, Python (Windows thử `py -3` trước), provider, Hub, target repo; tóm tắt một dòng lúc khởi động |
| Giao diện | Bộ token màu và ký hiệu; nền sáng/tối; `NO_COLOR`; ASCII cho console Windows cũ; 4 mức chiều rộng và 3 mức chiều cao; header tự rút gọn; bảng phủ cuộn được |
| Kiểm chứng | 98 test Vitest pass: logic (lệnh, Hub với git thật, cấu hình, kiểm tra môi trường, xử lý chữ tiếng Việt) và giao diện ở 15 tổ hợp kích cỡ, đổi kích cỡ giữa lúc gõ, snapshot. Chạy thật trong pseudo-terminal: tạo Hub thật, kiểm tra Claude Code thật, đổi kích cỡ, thoát. Cài từ gói `npm pack` chạy đúng |

### 14.2. Khác với đề xuất

| Điểm | Đề xuất | Thực hiện | Lý do |
| --- | --- | --- | --- |
| Node.js | 20+ | 22+ | Ink 7 yêu cầu Node 22 |
| Vẽ chat | Thành phần `Static` của Ink | Màn hình phụ, tự dàn trang | `Static` không dàn lại nội dung khi đổi kích cỡ (mục 5.7) |
| `.gitignore` của framework trong gói npm | Không đề cập | Lưu với tên `gitignore.pirl-bundled`, Hub đổi lại tên khi tạo | npm luôn bỏ file `.gitignore` khỏi gói; thiếu nó thì Hub sẽ commit nhầm Plan và record |
| Cài đặt phụ thuộc | Không đề cập | `.npmrc` đặt `legacy-peer-deps=true` | Lỗi của npm (`edgesOut`) khi giải peer dependency của Vitest |

### 14.3. Giai đoạn 1 và 2: đã xong (pilot Claude Code)

| Hạng mục | Kết quả |
| --- | --- |
| Layer | `/pirl-plan`, `/pirl-implement`, `/pirl-review` chạy coordinator bằng `claude -p` của người dùng; nhập không có `/` là chat với coordinator (câu hỏi, standalone task, bảo trì framework), các tin nhắn chat nối tiếp một session |
| Role | Mỗi role trong role catalog là một subagent khai báo qua `--agents`; công cụ theo loại việc (role chỉ đọc: Read, Grep, Glob; role kiểm chứng thêm Bash; role thực hiện và process-auditor thêm Edit, Write) |
| Quyền | `--permission-mode dontAsk` và `--permission-prompts none`: lệnh ngoài danh sách cho phép bị từ chối, không có prompt. Plan và Review không sửa được target repo; Implement sửa được và chạy được các test runner phổ biến. Mọi run: không commit, push, đổi nhánh, xoá file; không tool hẹn giờ hay việc nền |
| Câu hỏi giữa chừng | Coordinator trả khối `pirl-questions`; TUI hỏi từng câu (↑↓, gõ số, hoặc tự nhập); CLI gửi câu trả lời vào đúng session bằng `--resume` |
| Kiểm tra sau run | CLI tự chạy validator (Plan package, Plan file, report), đếm record mới và chạy `layer_record.py check`; sai thì gửi coordinator sửa (tối đa 2 lần). Sau Implement: file thay đổi phải nằm trong Allowed paths |
| Tự cải tiến | File framework do run sửa được liệt kê; người dùng chọn commit (kèm trailer `Pirl-Record`, `Pirl-Source`), giữ chưa commit, hoặc bỏ (chỉ bỏ file do run này sửa) |
| `/resume` | Run dở (Esc, Ctrl+C, lỗi, đóng TUI, đang chờ trả lời) lưu ở `~/.pirl/sessions/`; `/resume` chạy tiếp đúng session |
| `/plans`, `/records` | Đọc trong Hub, lọc theo `target_repo` là repo đang mở |
| Nhập liệu | Sửa lỗi gõ tiếng Việt bằng bộ gõ; Shift+Enter, Alt+Enter, Ctrl+J, `\`+Enter xuống dòng; Ctrl+V dán; `/copy` |
| Giao diện | Run block trong khung chat; bảng "Phiên làm việc" hiện role đang chạy; 6 bảng màu trong `/settings` |
| Kiểm chứng | 130 test Vitest pass (engine với Hub thật và provider giả lập, luồng run trong TUI, phím, clipboard). Đối chiếu tham số với Claude Code 2.1.309 thật. Chạy thật một lượt chat và một lượt `/pirl-plan` qua adapter: hai role chạy bằng subagent, Plan qua validator, record được ghi, trả lời bằng tiếng Việt |

Kết quả lượt `/pirl-plan` thật trên repo demo một file: khoảng 6 phút. Số đếm lúc đó là 585 nghìn token
đầu vào (phần lớn đọc từ cache) và 6 nghìn token đầu ra, nhưng chỉ tính coordinator (xem 14.5). Hai lần chạy đầu lộ ra 4 lỗi tích hợp, đã sửa: coordinator ghi
file tạm ra `/tmp` và dùng heredoc (bị chặn); xin người dùng cấp quyền; trả lời bằng tiếng Anh; gọi
`ScheduleWakeup` làm `claude -p` không kết thúc.

Chưa chạy thật: `/pirl-implement`, `/pirl-review` (cùng cơ chế với Plan, đã có test với provider giả lập);
Windows, macOS.

### 14.4. Khác với đề xuất (giai đoạn 1–2)

| Điểm | Đề xuất | Thực hiện | Lý do |
| --- | --- | --- | --- |
| Ai chạy role | CLI gọi mỗi role là một tiến trình riêng | Coordinator (một `claude -p`) giao role cho subagent Claude Code, mỗi role một subagent với bộ công cụ riêng | Framework đã định nghĩa coordinator giao việc và gộp kết quả; subagent là agent độc lập thật; ít lượt gọi hơn. CLI vẫn tự làm các bước cố định (mục 7.3). Provider khác có thể dùng cách gọi từng role ở giai đoạn 4 |
| Quyền theo đường dẫn từng role | Từng role có quyền riêng (mục 7.2) | Quyền đường dẫn theo run (layer); từng role chỉ khác nhau ở bộ công cụ | Claude Code không cho đặt luật đường dẫn riêng cho từng subagent; luật của session áp dụng cho mọi subagent |
| Câu hỏi khi đang có run | Hỏi được trong lúc run chạy | Một run tại một thời điểm; chat chờ run xong | Hai session ghi cùng Hub dễ đè nhau |
| Lệnh | 12 lệnh | 13 lệnh: thêm `/copy` | Người dùng yêu cầu copy |
| Ctrl+C | Thoát | Dừng run đang chạy; không có run thì thoát | Tránh mất run vì bấm nhầm |

### 14.5. Theo dõi run, token và model

**Theo dõi run.**
- Spinner và đồng hồ: chạy 5 khung hình/giây, và chỉ ô spinner được vẽ lại.
- Nhật ký run: giữ 200 dòng trong bộ nhớ và ghi toàn bộ ra file trong `~/.pirl/logs/`.
- Lệnh bị chặn: hiện đúng lệnh bị chặn (trước đây chỉ hiện "Bash") và mỗi lệnh chỉ đếm một lần.

**Hiệu năng.** Đo trên PTY thật, khi run đang chạy và không có sự kiện mới:

| Cửa sổ | Ban đầu | Hiện tại | Tắt chuyển động |
| --- | --- | --- | --- |
| 160x45 | 36,5% CPU | 14,8% CPU | 2,7% CPU |
| 100x30 | không đo | 8% CPU | 1,8% CPU |

Mức giảm đến từ bốn thay đổi:
- gộp cập nhật run mỗi 100 ms;
- cache dòng chat theo từng tin nhắn;
- bật incremental rendering, và chạy React ở chế độ production;
- spinner 5 khung hình/giây thay vì 10.

**Token.** Đo trên lượt `/pirl-plan` thật trên repo demo, model Sonnet 5.5:

| Loại | Token | Tỷ lệ chi phí quy đổi |
| --- | --- | --- |
| Đọc cache | 653k | 13% |
| Ghi cache | 98k | 65% |
| Ra | 10,5k | 21% |
| Tổng quy đổi | | ≈ $0,49 |

- Bản trước chỉ đếm token của coordinator và cộng token đọc cache vào token đầu vào, nên con số trông rất lớn.
- Stream của Claude Code báo thiếu token ra, và thiếu một số request của role. Vì vậy CLI chỉ dùng số đếm từ
  stream để hiển thị trong lúc chạy. Khi lượt gọi kết thúc, CLI thay bằng `modelUsage` của kết quả, có tính
  đến việc session resume cộng dồn tổng của các lượt trước.
- Hạn mức 5 giờ và tuần lấy từ `rate_limit_event` trong stream, cùng `/usage` đọc trước run (lệnh này không
  gọi model).

**Tiết kiệm.**
- `--tools` chỉ cấp Read, Write, Edit, Bash, Glob, Grep và Agent; `--strict-mcp-config` bỏ MCP server của
  người dùng. Ngữ cảnh ban đầu của coordinator giảm từ 25k xuống 18k token. Trên repo demo, chi phí giảm
  khoảng 9%.
- Cài đặt model coordinator (mặc định Sonnet), model các role và mức suy luận.

**Chưa làm (cần quyết định).**
- Coordinator dùng cache TTL 5 phút thay vì 1 giờ: rẻ hơn khoảng 37% phần ghi cache của coordinator, nhưng
  mất cache nếu một role chạy quá 5 phút.
- Rút gọn tài liệu framework mà coordinator đọc ở mỗi run. Hiện khoảng 78 nghìn ký tự, chiếm khoảng một nửa
  ngữ cảnh của coordinator.

### 14.6. Bước tiếp theo

Giai đoạn 3: `/framework` cập nhật framework trên bản nháp, giải quyết xung đột, hoàn tác (mục 9).

## Nguồn tham khảo

- [Claude Code – Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk)
- [Codex – Authentication](https://developers.openai.com/codex/auth)
- [Gemini CLI – Authentication](https://www.geminicli.com/docs/get-started/authentication)
- [GitHub Copilot CLI – Running programmatically](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)
- [ACP – TypeScript library](https://agentclientprotocol.com/libraries/typescript)
- [Gemini CLI vs Codex CLI (LogRocket)](https://blog.logrocket.com/gemini-cli-vs-codex-cli/)
- [Ink – danh sách dự án sử dụng](https://www.libhunt.com/r/ink)
