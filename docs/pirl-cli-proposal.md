# Đề xuất: biến PIRL framework thành PIRL CLI

Trạng thái: bản đề xuất, chưa triển khai. Ngày: 2026-10-23.

## 1. Kết luận

Có, làm được. Cách đúng là để PIRL CLI **điều khiển các agent CLI chính chủ**
mà người dùng đã cài và tự đăng nhập bằng subscription của họ (Claude Code,
Codex CLI, Gemini CLI, Copilot CLI). PIRL CLI **không** tự làm màn hình đăng
nhập, không đọc hay lưu token subscription, không gọi API thay người dùng bằng
token đó.

Lý do: Anthropic cấm bên thứ ba đưa "Claude.ai login" vào ứng dụng của mình,
cấm chuyển request qua credential gói Free/Pro/Max thay người dùng, và cấm thu
thập hay trung chuyển token đăng nhập. Cùng trang đó cho phép người dùng cuối
tự đăng nhập vào **binary Claude Code không sửa đổi** bằng subscription của
chính họ ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
Vì vậy "gọi `claude -p ...` mà người dùng đã đăng nhập" là đường hợp lệ; "tự
gọi API bằng OAuth token lấy từ máy người dùng" thì không.

Giá trị PIRL CLI mang lại so với việc mở Claude Code rồi gõ yêu cầu như hiện
nay nằm ở mục 3: nó chuyển các quy tắc hiện chỉ nằm trong file markdown thành
code chạy chắc chắn, và cho mỗi role một agent độc lập thật sự trên mọi
provider.

## 2. Hiện trạng PIRL framework (đã đọc trong repo)

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

## 3. PIRL CLI bổ sung được gì

| Vấn đề hiện tại | PIRL CLI xử lý thế nào |
| --- | --- |
| Layer được suy ra từ lời nói, có thể nhầm hoặc tự mở layer tiếp theo | Lệnh rõ ràng `pirl plan`, `pirl implement`, `pirl review`, `pirl fix`. Lệnh tự do `pirl "<yêu cầu>"` thì phân loại rồi hỏi xác nhận đúng 1 layer. Quy tắc "không tự mở layer tiếp theo" thành code. |
| Sub-agent tùy host; Codex/Gemini/Copilot khác Claude Code | CLI tự là coordinator: mỗi role = một tiến trình agent headless riêng. Có độc lập thật trên mọi provider, `mode: self` gần như không còn cần. |
| Độc lập giữa role chỉ là lời dặn | CLI quyết định role thấy gì: chỉ truyền file role + nguồn được phép; với Review có thể chạy trên git worktree riêng không chứa bản nháp. |
| Bước quy trình do LLM tự nhớ | CLI tự chạy `layer_record.py start`, `new_plan.py`, validator (lặp đến khi PASS), `append`/`check`, cleanup. LLM chỉ làm phần cần suy luận. |
| Người dùng phải clone Hub, nhớ đường dẫn | `pirl init` dựng Hub; framework đóng gói kèm CLI, có phiên bản. |
| Không biết đã tốn bao nhiêu quota | CLI đọc output JSON của provider, ghi số lượt gọi/token mỗi role vào record. |

## 4. Kiến trúc đề xuất

```text
pirl (CLI)
├── commands        init | plan | implement | review | fix | ask | status | records | doctor | config
├── engine          máy trạng thái của layer: mở run → chọn role → giao việc → gộp kết quả
│                   → validate → process-auditor → ghi record → cleanup → báo cáo
├── framework       bản PIRL framework đóng gói (AGENTS.md, instructions, roles, skills, evals)
├── tools           gọi trực tiếp các script Python sẵn có (không qua LLM)
└── providers       adapter điều khiển agent CLI người dùng đã đăng nhập
    ├── claude      claude -p ... --output-format stream-json
    ├── codex       codex exec --json ...
    ├── gemini      gemini -p ... --output-format json
    ├── copilot     copilot -p ...
    └── api-key     (tuỳ chọn) Claude Agent SDK / API bằng key của người dùng
```

### 4.1. Provider adapter

Mỗi adapter cài một interface chung:

```text
detect()      có binary không, phiên bản nào, đã đăng nhập chưa (chạy lệnh status/version của chính CLI đó)
run(task)     prompt hệ thống + prompt role, thư mục làm việc, thư mục được đọc,
              quyền (chỉ đọc | sửa file | chạy lệnh), model, timeout
              → kết quả văn bản, danh sách file đã sửa, usage, mã thoát
resume(id)    tiếp tục một phiên khi role cần hỏi thêm
capabilities  có sub-agent không, có sandbox không, có JSON output không
```

Ánh xạ quyền theo layer (cưỡng chế bằng cờ của provider, không chỉ bằng lời):

| Role / layer | Quyền |
| --- | --- |
| Plan: business-analyst, solution-architect, code-analyst | Chỉ đọc target repo |
| Implement: backend/frontend-developer, technical-writer | Sửa file trong target repo, chạy test FUT |
| Review: code-reviewer | Chỉ đọc |
| process-auditor | Sửa file trong framework (overlay, xem 6.3) |

Cờ cụ thể (cần kiểm tra lại theo phiên bản khi viết adapter):

- Claude Code: `claude -p`, `--output-format stream-json`,
  `--append-system-prompt`, `--allowedTools`/`--disallowedTools`,
  `--permission-mode`, `--add-dir`, `--model`, `--resume`.
- Codex: `codex exec --json --sandbox read-only|workspace-write --cd <dir>`;
  đăng nhập ChatGPT Plus/Pro/Team dùng được cho `codex exec`
  ([Codex auth](https://developers.openai.com/codex/auth)).
- Gemini CLI: `gemini -p`. Lưu ý: tài liệu chính thức khuyên dùng API key hoặc
  Vertex AI cho chế độ headless; đăng nhập Google subscription chủ yếu cho chế
  độ tương tác ([Gemini CLI auth](https://www.geminicli.com/docs/get-started/authentication)).
- Copilot CLI: `copilot -p`; mỗi prompt tiêu tốn premium request
  ([Copilot CLI programmatic](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)).

Phương án dài hạn: dùng **Agent Client Protocol (ACP)** (JSON-RPC qua
stdin/stdout) làm giao thức chung; Gemini CLI hỗ trợ trực tiếp, Claude Code và
Codex có adapter. Khi đó thêm provider chỉ là đổi lệnh khởi chạy. MVP nên gọi
headless trực tiếp cho đơn giản, thiết kế interface sao cho thay bằng ACP sau
không đổi engine.

### 4.2. Engine: phần nào là code, phần nào là LLM

| Bước | Ai làm |
| --- | --- |
| Chọn layer | Code (theo lệnh) hoặc 1 lần gọi LLM phân loại + người dùng xác nhận |
| `layer_record.py start`, ghim `framework_ref` | Code |
| Đọc context doc của target repo | LLM (coordinator) |
| Chọn đội role | LLM đề xuất, code kiểm tra role hợp lệ với layer (dùng bảng role sẵn có trong `validate_layer_artifact.load_roles`) |
| Giao việc từng role, chạy song song khi không phụ thuộc | Code điều phối, LLM thực hiện |
| Gộp kết quả theo bằng chứng | LLM (coordinator) |
| Tạo file Plan/report từ template | Code (`new_plan.py`, `new_review.py`) |
| Validate, lặp sửa đến khi PASS | Code chạy validator, LLM sửa |
| Hỏi người dùng khi thiếu quyết định | Code hiển thị câu hỏi, lưu câu trả lời vào record |
| process-auditor | LLM ở tiến trình riêng |
| `append`/`check` record, cleanup | Code |
| Commit/push | Chỉ khi người dùng chạy `pirl commit` hoặc thêm cờ `--commit` |

## 5. Trải nghiệm dùng thử (ví dụ)

```console
$ pirl doctor
claude   2.x   đã đăng nhập (subscription)
codex    —     chưa cài
python   3.12  OK

$ pirl plan --repo ../shop-web "Khách nhận email khi đơn hàng bị huỷ"
[plan] roles: business-analyst, solution-architect, code-analyst   (provider: claude)
[plan] business-analyst ▸ đang đọc AGENTS.md của shop-web ...
? Cần quyết định: gửi email cả khi admin huỷ đơn? (y/n)
...
✔ Plan: order-cancel-email_20261023-101500/ (3 task) — validator PASS
✔ Tự cải tiến: 1 sửa ở .agents/roles/code-analyst.role.md (record R-...)
Tiếp theo (chỉ chạy khi bạn yêu cầu): pirl implement order-cancel-email_20261023-101500/T01

$ pirl implement order-cancel-email_20261023-101500/T01 --provider codex
$ pirl review order-cancel-email_20261023-101500/T01 --provider claude   # role review khác provider với implement
```

Gợi ý tính năng: cho phép mỗi role dùng provider/model khác nhau
(`pirl config set roles.code-reviewer.provider codex`). Review bằng model khác
với model đã implement làm tăng tính độc lập, đúng tinh thần "role không tự
kiểm output của mình".

## 6. Rủi ro và điểm cần thiết kế lại

1. **Quota subscription.** Một lần chạy layer = 1 coordinator + N role +
   process-auditor + các vòng sửa validator, dễ thành 5–15 lần gọi agent.
   Anthropic ghi rõ giới hạn của gói Pro/Max giả định "mức dùng cá nhân thông
   thường". Cần: giới hạn số role chạy song song, chế độ `--lean` (gộp role ít
   quan trọng), hiển thị usage, dừng an toàn khi gặp rate limit và cho tiếp tục
   (`pirl resume`).
2. **Không phân phối lại quyền dùng.** Nếu sau này PIRL CLI chạy trên server
   cho người khác dùng thì mỗi người dùng phải tự đăng nhập bằng tài khoản của
   họ; không dùng chung một subscription. Không dùng tên/logo "Claude Code"
   trong tên sản phẩm.
3. **Tự cải tiến khi framework đóng gói.** Hiện process-auditor sửa thẳng file
   trong Hub. Khi framework nằm trong package cài đặt, sửa trực tiếp sẽ mất khi
   nâng cấp. Đề xuất: Hub của người dùng (`pirl init` tạo ra) là một bản sao
   git có thể sửa; CLI so `framework_ref` với bản đóng gói và hỗ trợ
   `pirl framework upgrade` (merge bản mới vào bản đã tự cải tiến).
4. **Khác biệt năng lực provider.** Không phải provider nào cũng có sandbox,
   JSON output hay chế độ chỉ đọc. Adapter phải khai báo `capabilities`; layer
   nào cần quyền mà provider không cưỡng chế được thì CLI cảnh báo và ghi mức
   độc lập thực tế vào record (đúng quy tắc hiện có của router).
5. **Gemini headless với subscription** chưa được hỗ trợ chính thức; MVP nên
   coi Gemini là provider dùng API key.
6. **Đa nền tảng.** README và skill dùng khối lệnh PowerShell; script Python
   chạy được trên Linux (đã chạy test ở môi trường Linux). Múi giờ đang cố định
   UTC+7 (`TZ = timezone(timedelta(hours=7))` trong `new_plan.py`,
   `layer_record.py`); nên chuyển thành cấu hình.
7. **Câu hỏi giữa chừng.** Agent headless không hỏi người dùng được. Cần quy
   ước: role trả về khối "câu hỏi cần quyết định" dạng JSON, CLI dừng phần phụ
   thuộc, hỏi người dùng, rồi `resume` phiên đó với câu trả lời.

## 7. Công nghệ

Đề xuất **Python** (Typer + Rich, phát hành qua `pipx`/`uv tool install`), vì:
framework đã yêu cầu Python 3.9+, toàn bộ validator/record/script là Python và
có test, CLI gọi trực tiếp các hàm đó thay vì qua tiến trình con.

Phương án thay thế là TypeScript/Node: các agent CLI đều phát hành qua npm và
Agent SDK có bản TS, nhưng phải viết lại hoặc gọi vòng các script Python. Chỉ
nên chọn nếu muốn TUI phức tạp (Ink).

## 8. Lộ trình

| Giai đoạn | Nội dung | Kết quả kiểm chứng |
| --- | --- | --- |
| 0. Khung | Cấu trúc package, `pirl init`, `pirl doctor`, đóng gói framework, cấu hình | `pirl doctor` nhận ra `claude` đã đăng nhập |
| 1. MVP 1 provider | Adapter Claude Code; `pirl plan` chạy đủ vòng: start → roles → new_plan → validator → auditor → record | Tạo Plan hợp lệ cho một repo mẫu, validator PASS |
| 2. Đủ 3 layer | `implement`, `review`, `fix`, cưỡng chế quyền theo role, câu hỏi giữa chừng + `resume` | Chạy trọn chuỗi Plan → Implement → Review trên repo mẫu |
| 3. Đa provider | Codex, Copilot, Gemini (API key), cấu hình provider theo role | Review bằng provider khác với Implement |
| 4. Hoàn thiện | Usage/quota, `pirl status`, `pirl records`, `framework upgrade`, cân nhắc ACP | Test tích hợp với provider giả lập (fake adapter) chạy trong CI |

Mỗi giai đoạn kèm test dùng **fake provider** (adapter trả kết quả dựng sẵn)
để kiểm engine mà không tốn quota.

## Cần xác nhận

1. Ngôn ngữ cài đặt: chọn Python? (khuyến nghị: Có). Chưa trả lời thì chưa dựng
   khung giai đoạn 0.
2. Provider cho MVP: chỉ Claude Code trước? (khuyến nghị: Có; Codex ở giai đoạn
   3). Chưa trả lời thì chưa viết adapter.
3. Phạm vi dùng: chỉ cá nhân trên máy mình, hay sau này chạy cho nhiều người
   (server/nhóm)? Câu trả lời đổi yêu cầu về xác thực ở mục 6.2.
4. Bản framework tự cải tiến lưu ở Hub git của người dùng như mục 6.3?
   (khuyến nghị: Có).

## Nguồn tham khảo

- [Claude Code – Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk)
- [Codex – Authentication](https://developers.openai.com/codex/auth)
- [Gemini CLI – Authentication](https://www.geminicli.com/docs/get-started/authentication)
- [GitHub Copilot CLI – Running programmatically](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)
- [Agent Client Protocol – tổng quan](https://www.morphllm.com/agent-client-protocol)
