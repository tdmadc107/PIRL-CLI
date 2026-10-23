# Đề xuất: biến PIRL framework thành PIRL CLI

Trạng thái: bản đề xuất, chưa triển khai. Cập nhật: 2026-10-23 (lần 2).

## 1. Kết luận

Có, làm được. PIRL CLI là một ứng dụng có giao diện TUI, cài trên máy từng
người dùng. Nó **điều khiển các agent CLI chính chủ** mà người dùng đã cài và
tự đăng nhập bằng subscription của họ. Bản pilot dùng Claude Code, các
provider khác theo sau. PIRL CLI **không** tự làm màn hình đăng nhập, không đọc
hay lưu token subscription, không gọi API thay người dùng bằng token đó.

Lý do: Anthropic cấm bên thứ ba đưa "Claude.ai login" vào ứng dụng của mình,
cấm chuyển request qua credential gói Free/Pro/Max thay người dùng, và cấm thu
thập hay trung chuyển token đăng nhập. Cùng trang đó cho phép người dùng cuối
tự đăng nhập vào **binary Claude Code không sửa đổi** bằng subscription của
chính họ ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).

Ngôn ngữ cài đặt đề xuất: **TypeScript + Ink** (mục 7). Các công cụ Python
sẵn có của framework vẫn giữ nguyên là Python và được CLI gọi như tiến trình
con, vì chúng thuộc phạm vi tự cải tiến của framework.

## 2. Quyết định đã chốt

| Chủ đề | Quyết định | Nguồn |
| --- | --- | --- |
| Giao diện | CLI phải có TUI | Góp ý của người dùng, điểm 1 |
| Cú pháp lệnh | Đơn giản kiểu `pirl-plan <nội dung request>`, không nhiều tham số | Điểm 2 |
| Provider | Pilot cho Claude Code trước, sau đó phát triển cho provider khác | Điểm 4 |
| Ngôn ngữ | Có thể dùng ngôn ngữ khác Python để có TUI tốt; đánh giá ở mục 7 | Điểm 5 |
| Phạm vi dùng | Mỗi người dùng cá nhân tự tải về, tự cài. Mỗi người phải có sẵn provider AI của mình. Tuân thủ ToS của provider: không chia sẻ quyền sử dụng | Điểm 6 |
| Framework tự cải tiến | Bản cập nhật CLI không được đè lên phần người dùng đã tự cải tiến; phân tích ở mục 8 | Điểm 7 |

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
- Đã có sẵn công cụ Python 3.9+: `new_plan.py`, `new_review.py`,
  `add_implementation_record.py`, `new_layout_run.py`,
  `validate_layer_artifact.py`, `layer_record.py`. 22 test đều PASS
  (`python3 -B -m unittest discover -s .agents/evals/tests -p "test_*.py"`).
- Framework phụ thuộc vào "host" (Claude Code hoặc agent tương tự) ở 4 điểm:
  1. Host phải đọc `AGENTS.md` và tự suy ra layer từ lời người dùng.
  2. Mỗi role phải chạy trong một sub-agent riêng; host không có sub-agent thì
     rơi về `mode: self` (chất lượng kém hơn, phải ghi lý do).
  3. Tính độc lập giữa các role chỉ được *dặn* trong prompt ("không đọc các
     path chứa bản nháp"), không có gì cưỡng chế.
  4. Các bước quy trình (`layer_record.py start`, validator, `append`, `check`,
     cleanup) do LLM tự nhớ mà chạy.

## 4. PIRL CLI bổ sung được gì

| Vấn đề hiện tại | PIRL CLI xử lý thế nào |
| --- | --- |
| Layer được suy ra từ lời nói, có thể nhầm hoặc tự mở layer tiếp theo | Mỗi layer là một lệnh riêng (`pirl-plan`, `pirl-implement`, `pirl-review`). Quy tắc "không tự mở layer tiếp theo" thành code. |
| Sub-agent tùy host | CLI tự là coordinator: mỗi role là một tiến trình agent headless riêng. Có độc lập thật trên mọi provider; `mode: self` gần như không còn cần. |
| Độc lập giữa role chỉ là lời dặn | CLI quyết định role đọc gì, ghi gì, chạy lệnh gì (mục 6.2). |
| Bước quy trình do LLM tự nhớ | CLI tự chạy `layer_record.py start`, `new_plan.py`, validator (lặp đến khi PASS), `append`/`check`, cleanup. LLM chỉ làm phần cần suy luận. |
| Người dùng phải clone Hub, nhớ đường dẫn | Lần chạy đầu tiên tự dựng Hub; target repo mặc định là thư mục hiện tại. |
| Không biết đã tốn bao nhiêu quota | TUI hiển thị số lượt gọi và usage của từng role; ghi vào record. |

## 5. Lệnh và TUI

### 5.1. Lệnh

Chỉ có 4 lệnh. Mọi thứ sau tên lệnh là nội dung request, không cần dấu ngoặc
kép, không có tham số.

| Lệnh | Ví dụ | Việc làm |
| --- | --- | --- |
| `pirl-plan <request>` | `pirl-plan Khách nhận email khi đơn hàng bị huỷ` | Chạy layer Plan |
| `pirl-implement <request>` | `pirl-implement T01 của plan order-cancel-email` | Chạy layer Implement, kể cả sửa theo report: `pirl-implement Sửa theo report round-01 của T01` |
| `pirl-review <request>` | `pirl-review T01 của plan order-cancel-email` | Chạy layer Review |
| `pirl` | `pirl` | Mở TUI chính |

Các giá trị thường phải truyền bằng tham số được suy ra như sau:

| Giá trị | Cách xác định |
| --- | --- |
| Target repo | Thư mục hiện tại (`cd` vào repo rồi gõ lệnh). Nếu thư mục hiện tại không phải git repo, TUI hỏi một câu. |
| Plan/task cần implement hoặc review | Coordinator đọc từ request, giống framework hiện nay. Request thiếu hoặc khớp nhiều plan thì TUI hiện danh sách để chọn bằng phím mũi tên. |
| Provider, model | Cài đặt một lần trong TUI (`/settings`). |
| Nơi lưu Plan và report | Theo mặc định của framework: trong Hub. Request ghi rõ nơi khác thì theo request. |
| Role | Coordinator chọn theo bảng của layer; request nêu tên role thì giữ đúng danh sách đó (quy tắc sẵn có). |

`pirl-plan` không có request thì mở TUI ở ô nhập request của layer Plan.
Tương tự với hai lệnh còn lại.

### 5.2. TUI

Màn hình khi chạy một layer:

```text
┌ pirl-plan · shop-web · Claude Code ───────────────────────────────┐
│ Request: Khách nhận email khi đơn hàng bị huỷ                     │
├ Roles ────────────────┬ Chi tiết: code-analyst ───────────────────┤
│ ✔ business-analyst    │ Đang đọc src/orders/cancel.ts ...          │
│ ▸ code-analyst        │ Tìm thấy 3 nơi gọi cancelOrder()           │
│ ○ solution-architect  │                                            │
│ ○ process-auditor     │                                            │
├ Cần quyết định ───────┴────────────────────────────────────────────┤
│ Gửi email cả khi admin huỷ đơn?  [Có]  [Không]                    │
├────────────────────────────────────────────────────────────────────┤
│ Usage: 4 lượt gọi · validator: chưa chạy        Esc dừng · ? trợ giúp │
└────────────────────────────────────────────────────────────────────┘
```

Cuối run, TUI hiện kết quả, phần tự cải tiến (diff từng file) và hỏi có commit
cải tiến đó vào Hub không (mục 8.4).

TUI chính (`pirl`) chứa các việc quản lý, gọi bằng lệnh gạch chéo bên trong
TUI thay vì tham số dòng lệnh:

| Lệnh trong TUI | Việc làm |
| --- | --- |
| Gõ request tự do | Câu hỏi, standalone task, bảo trì framework: coordinator phân loại theo `AGENTS.md`, hỏi xác nhận trước khi mở layer |
| `/plans` | Danh sách Plan, task, report và trạng thái |
| `/records` | Tra cứu record tự cải tiến |
| `/settings` | Provider, model theo role, số role chạy song song |
| `/doctor` | Kiểm tra provider đã cài và đã đăng nhập, Python, Git |
| `/framework` | Xem khác biệt so với bản gốc, cập nhật, khôi phục file (mục 8) |
| `/resume` | Chạy tiếp run bị dừng (hết quota, mất mạng) |

## 6. Kiến trúc

```text
pirl (TypeScript)
├── bin            pirl, pirl-plan, pirl-implement, pirl-review
├── tui            màn hình Ink: run view, câu hỏi, diff, danh sách plan, cài đặt
├── engine         máy trạng thái của layer: mở run → chọn role → giao việc → gộp kết quả
│                  → validate → process-auditor → ghi record → cleanup → báo cáo
├── hub            quản lý Hub của người dùng (git) và cập nhật framework (mục 8)
├── tools          gọi các script Python của framework như tiến trình con
└── providers      adapter điều khiển agent CLI người dùng đã đăng nhập
    ├── claude     pilot: claude -p ... --output-format stream-json
    ├── codex      giai đoạn sau: codex exec --json ...
    ├── gemini     giai đoạn sau: gemini -p ...
    └── copilot    giai đoạn sau: copilot -p ...
```

### 6.1. Provider adapter

Mỗi adapter cài một interface chung:

```text
detect()      có binary không, phiên bản nào, đã đăng nhập chưa
run(task)     prompt hệ thống + prompt role, thư mục làm việc, quyền đọc/ghi/chạy lệnh,
              model, timeout → luồng sự kiện (để TUI hiển thị), kết quả, file đã sửa, usage
resume(id)    tiếp tục phiên của một role sau khi người dùng trả lời câu hỏi
capabilities  có chặn quyền theo đường dẫn không, có JSON output không, có resume không
```

Cờ của Claude Code dùng cho pilot (kiểm tra lại theo phiên bản khi viết
adapter): `claude -p`, `--output-format stream-json`,
`--append-system-prompt`, `--allowedTools`/`--disallowedTools` (có quy tắc
theo đường dẫn, ví dụ dạng `Edit(src/**)`), `--permission-mode`, `--add-dir`,
`--model`, `--resume`.

Ghi chú cho giai đoạn sau:

- Codex: `codex exec --json --sandbox read-only|workspace-write --cd <dir>`;
  đăng nhập ChatGPT Plus/Pro/Team dùng được cho `codex exec`
  ([Codex auth](https://developers.openai.com/codex/auth)).
- Gemini CLI: `gemini -p`. Tài liệu chính thức khuyên dùng API key hoặc
  Vertex AI cho chế độ headless; đăng nhập Google subscription chủ yếu cho chế
  độ tương tác ([Gemini CLI auth](https://www.geminicli.com/docs/get-started/authentication)).
- Copilot CLI: `copilot -p`; mỗi prompt tiêu tốn premium request
  ([Copilot CLI programmatic](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)).
- Agent Client Protocol (ACP) là giao thức chung (JSON-RPC qua stdin/stdout)
  để điều khiển nhiều agent; có SDK TypeScript chính thức
  `@agentclientprotocol/sdk`
  ([ACP TypeScript library](https://agentclientprotocol.com/libraries/typescript)).
  Interface adapter ở trên được thiết kế để sau này thay phần gọi headless bằng
  ACP mà engine không đổi.

### 6.2. Quyền theo role và layer

Bản trước chỉ liệt kê 9 dòng và bỏ sót: `ux-designer` ở Plan; ba role kiểm
chứng ở Implement (`code-reviewer`, `code-analyst`, `ux-designer`);
`code-analyst`, `business-analyst`, `solution-architect`, `ux-designer` ở
Review; và coordinator của mỗi layer. Bảng dưới lấy đủ từ bảng role của từng
layer contract và role catalog.

Ký hiệu đường dẫn: **Target** là target repo; **Hub** là Hub của người dùng;
**Allowed paths** là danh sách đường dẫn được phép trong task của Plan.

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

- Quyền đọc/ghi/lệnh của từng dòng được dịch thành cờ quyền của provider khi
  gọi role đó.
- Sau khi role thực hiện xong, CLI chạy `git diff --name-only` trong target
  repo và so với Allowed paths; file ngoài danh sách thì dừng và hỏi người dùng.
- Role kiểm chứng và role review không được đọc bản nháp của coordinator hay
  role khác trong cùng run: CLI không truyền và chặn đọc các đường dẫn đó.
- Provider nào không cưỡng chế được một quyền thì CLI cảnh báo trong TUI và ghi
  mức độc lập thực tế vào output, đúng quy tắc sẵn có của router.

### 6.3. Engine: phần nào là code, phần nào là LLM

| Bước | Ai làm |
| --- | --- |
| Chọn layer | Code, theo lệnh đã gõ |
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
| Commit cải tiến framework vào Hub | Code, chỉ khi người dùng đồng ý ở cuối run (mục 8.4) |
| Commit/push trong target repo | Chỉ khi người dùng yêu cầu bằng lời trong request hoặc trong TUI |

## 7. Ngôn ngữ cài đặt khi có TUI

### 7.1. Một điểm thay đổi cách nhìn

Các script Python (`.agents/evals/*.py`, `.skills/*/scripts/*.py`) thuộc phạm
vi tự cải tiến: `FRAMEWORK_PATHS` trong `layer_record.py` gồm `.agents/evals`
và `.skills`, nên `process-auditor` được phép sửa chúng. Nếu viết lại chúng
bằng ngôn ngữ của CLI thì self-improvement không sửa được nữa, và mỗi lần cập
nhật CLI sẽ đè lên chúng. Vì vậy:

- Các script đó **giữ nguyên là Python**, nằm trong Hub, CLI gọi bằng tiến
  trình con. Python 3.9+ vẫn là yêu cầu cài đặt, bất kể CLI viết bằng gì.
- Việc chọn ngôn ngữ cho CLI chỉ còn xét theo chất lượng TUI, điều khiển tiến
  trình agent, phân phối và hệ sinh thái provider.

### 7.2. So sánh

| Tiêu chí | TypeScript + Ink | Go + Bubble Tea | Rust + Ratatui | Python + Textual |
| --- | --- | --- | --- | --- |
| Đã dùng cho agent CLI | Claude Code, Gemini CLI | — | Codex CLI | — |
| Chất lượng TUI | Tốt; mô hình React, hợp giao diện luồng sự kiện kiểu chat | Rất tốt, nhiều widget | Rất tốt, hiệu năng cao | Rất tốt, nhiều widget |
| SDK ACP chính thức | Có | Không tìm thấy | Có | Có |
| SDK Claude chính thức (khi thêm chế độ API key) | Có (Agent SDK TS) | Chỉ API client | Không | Có |
| Phân phối | npm, giống cách cài Claude Code/Gemini CLI/Codex; có thể đóng thành 1 file thực thi | 1 file thực thi, dễ nhất | 1 file thực thi | pipx/uv; đóng file thực thi kém gọn hơn |
| Windows | Tốt | Tốt | Tốt | Tốt |
| Tốc độ phát triển | Nhanh | Nhanh | Chậm hơn | Nhanh |
| Dùng lại code Python sẵn có | Gọi tiến trình con (đằng nào cũng phải vậy, mục 7.1) | Như trên | Như trên | Import trực tiếp |

### 7.3. Khuyến nghị

**TypeScript + Ink**. Lý do trong một câu: đây là bộ công nghệ mà chính Claude
Code và Gemini CLI dùng cho cùng loại giao diện (luồng output của agent, câu
hỏi giữa chừng, duyệt quyền), và là ngôn ngữ duy nhất có đủ SDK ACP chính thức
lẫn Agent SDK của Anthropic cho các giai đoạn sau.

Đổi lại: cần Node.js 20+ (hoặc phát hành kèm bản 1 file thực thi) và phải giữ
Python cho framework. Phương án dự phòng là Go + Bubble Tea nếu ưu tiên số một
là một file thực thi gọn nhẹ; mất SDK ACP chính thức.

Nguồn về bộ công nghệ của các agent CLI là bài viết bên thứ ba
([so sánh Gemini CLI và Codex CLI](https://blog.logrocket.com/gemini-cli-vs-codex-cli/),
[danh sách dự án dùng Ink](https://www.libhunt.com/r/ink)); cần đọc lại repo
chính thức trước khi trích dẫn ra ngoài.

## 8. Framework tự cải tiến và bản cập nhật CLI

### 8.1. Bài toán

Có ba nguồn thay đổi lên cùng một bộ file framework:

| Nguồn | Ví dụ | Đặc điểm |
| --- | --- | --- |
| Bản gốc (upstream) | Phiên bản framework mới đi kèm bản cập nhật CLI | Giống nhau cho mọi người dùng |
| Tự cải tiến cục bộ | `process-auditor` sửa một rule sau một run | Khác nhau theo từng người dùng, theo dự án của họ |
| Người dùng sửa tay | Người dùng tự chỉnh `AGENTS.md` | Như trên |

Yêu cầu:

1. Cập nhật CLI không bao giờ âm thầm đè phần cục bộ.
2. Người dùng vẫn nhận được cải tiến của bản gốc.
3. Khi hai bên sửa cùng một chỗ, người dùng quyết định.
4. Không có thay đổi nào nới lỏng safety rule mà người dùng không duyệt (quy
   tắc sẵn có trong `AGENTS.md`).
5. Có cách quay lại khi một cải tiến cục bộ làm framework tệ đi.

### 8.2. Các phương án

| Phương án | Cách làm | Được | Mất |
| --- | --- | --- | --- |
| A. Hub là git repo, merge 3 chiều (khuyến nghị) | Bản gốc nằm trên nhánh `upstream`; bản người dùng là nhánh `main`. Cập nhật = đưa bản gốc mới vào `upstream` rồi merge vào `main` | Đáp ứng cả 5 yêu cầu; dùng đúng `framework_ref` sẵn có (commit Hub + hash file khác commit) | Phải xử lý xung đột; người dùng không quen git cần TUI hỗ trợ tốt |
| B. Lớp ghi đè (overlay) theo file | Bản gốc chỉ đọc; file nào được sửa thì lưu bản sao ghi đè | Đơn giản | Ghi đè cả file nên mọi sửa lỗi của bản gốc trên file đó không bao giờ tới người dùng; khó biết bản ghi đè đã lỗi thời |
| C. Không cập nhật framework sau lần cài đầu | Không có gì để làm | Không có xung đột | Người dùng không bao giờ nhận cải tiến của bản gốc |

### 8.3. Thiết kế theo phương án A

Tách hai thứ được cập nhật theo hai đường khác nhau:

- **Mã CLI** (TypeScript) cập nhật qua npm hoặc file thực thi. Bản cập nhật chỉ
  mang theo một **bản framework gốc đóng gói**; nó không ghi gì vào Hub.
- **Hub** (`~/.pirl/hub`) là git repo cục bộ của người dùng. Chỉ lệnh
  `/framework` trong TUI ghi vào Hub, và chỉ khi người dùng đồng ý.

Cấu trúc Hub:

```text
~/.pirl/hub                         git repo cục bộ, không có remote
  nhánh upstream                    mỗi commit = một phiên bản framework gốc, có tag fw-<version>
  nhánh main                        upstream + các commit cải tiến cục bộ
  .agents/evals/records/            record (Git bỏ qua, như hiện nay)
  <plan-set>/                       Plan và report (Git bỏ qua, như hiện nay)
```

Luồng cập nhật framework khi CLI có bản gốc mới:

1. CLI so tag phiên bản trên nhánh `upstream` với bản đóng gói. Bản đóng gói
   mới hơn thì TUI báo "Có framework mới" kèm changelog; người dùng chọn cập
   nhật hoặc để sau. CLI vẫn chạy được với bản cũ, trừ khi bản cũ dùng schema
   mà CLI không còn đọc (`pirl-plan/v1`, `pirl-review/v1`, `pirl-record/v1`).
2. Điều kiện trước: `main` không có thay đổi chưa commit (mục 8.4). Có thì TUI
   yêu cầu commit hoặc bỏ trước.
3. CLI commit bản gốc mới lên `upstream`, rồi merge `upstream` vào `main`. Git
   tự lấy điểm gốc chung là phiên bản gốc trước đó, nên:
   - phần chỉ bản gốc đổi: nhận tự động;
   - phần chỉ người dùng đổi: giữ nguyên;
   - phần cả hai cùng đổi: xung đột.
4. Mỗi xung đột hiện trong TUI với 3 cột (bản gốc cũ, bản của bạn, bản gốc mới)
   và 3 lựa chọn: giữ bản của bạn, lấy bản gốc mới, hoặc nhờ agent đề xuất bản
   gộp rồi bạn duyệt. Xung đột chạm safety rule thì không có lựa chọn tự động;
   người dùng phải đọc và chọn.
5. Sau merge, CLI chạy test của framework và validator. Có lỗi thì huỷ merge
   (`git merge --abort` hoặc quay về commit trước), giữ framework cũ và báo lỗi.
6. Tuỳ chọn: một lượt "đối chiếu" do agent chạy, liệt kê cải tiến cục bộ nào
   nay đã thừa vì bản gốc đã sửa cùng vấn đề, đề xuất bỏ. Người dùng duyệt.

Xử lý khi tự cải tiến làm framework tệ đi:

- Sau mỗi lần `process-auditor` sửa file, CLI chạy test framework và validator.
  Lỗi thì hoàn tác chính sửa đổi đó và ghi vào record.
- `/framework diff`: xem toàn bộ khác biệt giữa bản của bạn và bản gốc.
- `/framework restore <file>`: lấy lại bản gốc của một file.
- `/framework history`: danh sách commit cải tiến, hoàn tác từng commit
  (`git revert`).

### 8.4. Commit cải tiến: giữ đúng quy tắc Git của framework

`AGENTS.md` quy định chỉ commit khi người dùng yêu cầu, và đây là safety rule.
Phương án A cần mỗi cải tiến là một commit trong Hub. Để không nới lỏng quy
tắc này, cuối mỗi run TUI hiện diff của phần tự cải tiến và hỏi
"Commit cải tiến này vào Hub? [Có] [Không] [Bỏ cải tiến]". Câu trả lời "Có" là
yêu cầu commit của người dùng. CLI không bao giờ push Hub, vì Hub không có
remote.

### 8.5. Hướng lâu dài: đóng góp ngược về bản gốc

Cải tiến cục bộ càng lệch bản gốc thì càng nhiều xung đột. Nên có lệnh xuất các
commit cải tiến thành patch để người dùng tự gửi về repo framework. Patch chỉ
chứa file framework (record, Plan, report đã bị Git bỏ qua), nhưng nội dung
rule có thể nhắc tới dự án của người dùng, nên người dùng phải tự đọc trước khi
gửi. CLI không tự gửi gì ra ngoài.

## 9. Rủi ro khác

1. **Quota subscription.** Một lần chạy layer = 1 coordinator + N role +
   process-auditor + các vòng sửa validator, dễ thành 5–15 lần gọi agent.
   Anthropic ghi rõ giới hạn của gói Pro/Max giả định "mức dùng cá nhân thông
   thường". Cần: giới hạn số role chạy song song, hiển thị usage, dừng an toàn
   khi gặp rate limit và cho chạy tiếp bằng `/resume`.
2. **Khác biệt năng lực provider.** Không phải provider nào cũng chặn quyền
   theo đường dẫn, có JSON output hay resume phiên. Adapter khai báo
   `capabilities`; thiếu thì CLI cảnh báo và ghi mức độc lập thực tế.
3. **Câu hỏi giữa chừng.** Agent headless không hỏi người dùng trực tiếp được.
   Quy ước: role trả khối câu hỏi dạng JSON, CLI dừng phần phụ thuộc, TUI hỏi,
   rồi `resume` phiên của role với câu trả lời. Pilot phải kiểm chứng
   `claude --resume` đáp ứng được việc này.
4. **Đa nền tảng.** README và skill dùng khối lệnh PowerShell; script Python
   chạy được trên Linux (đã chạy test ở môi trường Linux). Múi giờ đang cố định
   UTC+7 (`TZ = timezone(timedelta(hours=7))` trong `new_plan.py`,
   `layer_record.py`); nên chuyển thành cấu hình.

## 10. Lộ trình

| Giai đoạn | Nội dung | Kết quả kiểm chứng |
| --- | --- | --- |
| 0. Khung | Dự án TypeScript + Ink, 4 lệnh, Hub git (nhánh `upstream`/`main`), `/doctor`, `/settings` | `/doctor` nhận ra `claude` đã đăng nhập, Python, Git |
| 1. Pilot Claude Code: Plan | Adapter Claude Code; `pirl-plan` chạy đủ vòng: start → roles → new_plan → validator → auditor → record → hỏi commit cải tiến | Tạo Plan hợp lệ cho một repo mẫu, validator PASS |
| 2. Pilot Claude Code: đủ 3 layer | `pirl-implement`, `pirl-review`, cưỡng chế quyền theo bảng 6.2, câu hỏi giữa chừng + `/resume` | Chạy trọn chuỗi Plan → Implement → Review trên repo mẫu |
| 3. Cập nhật framework | `/framework` (diff, update với merge 3 chiều, restore, history) | Cập nhật lên bản gốc mới mà giữ được cải tiến cục bộ; xung đột hiện đúng trong TUI |
| 4. Provider khác | Codex, Copilot, Gemini; provider và model theo role | Review bằng provider khác với Implement |
| 5. Hoàn thiện | Usage/quota, `/plans`, `/records`, file thực thi đóng gói, cân nhắc ACP | Test tích hợp bằng provider giả lập chạy trong CI |

Mỗi giai đoạn kèm test dùng **provider giả lập** (adapter trả kết quả dựng sẵn)
để kiểm engine và TUI mà không tốn quota.

## Cần xác nhận

1. Chọn TypeScript + Ink làm ngôn ngữ cài đặt CLI? (khuyến nghị: Có). Chưa trả
   lời thì chưa dựng khung giai đoạn 0.
2. Target repo mặc định là thư mục hiện tại khi gõ lệnh? (khuyến nghị: Có).
   Chưa trả lời thì chưa chốt cách suy ra target repo ở mục 5.1.
3. Cập nhật framework theo phương án A ở mục 8: Hub là git repo, merge 3 chiều,
   hỏi commit cải tiến cuối mỗi run? (khuyến nghị: Có). Chưa trả lời thì chưa
   làm giai đoạn 3; giai đoạn 0–2 không bị chặn.

## Đề xuất thêm

1. Đổi múi giờ cố định UTC+7 trong `new_plan.py` và `layer_record.py` thành
   múi giờ của máy hoặc cấu hình, để người dùng ở múi giờ khác có tên Plan và
   record đúng giờ.
2. Thêm lệnh xuất patch cải tiến (mục 8.5), giúp gộp các cải tiến chung về bản
   gốc và giảm xung đột về sau.

## Nguồn tham khảo

- [Claude Code – Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk)
- [Codex – Authentication](https://developers.openai.com/codex/auth)
- [Gemini CLI – Authentication](https://www.geminicli.com/docs/get-started/authentication)
- [GitHub Copilot CLI – Running programmatically](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)
- [ACP – TypeScript library](https://agentclientprotocol.com/libraries/typescript)
- [Gemini CLI vs Codex CLI (LogRocket)](https://blog.logrocket.com/gemini-cli-vs-codex-cli/)
- [Ink – danh sách dự án sử dụng](https://www.libhunt.com/r/ink)
