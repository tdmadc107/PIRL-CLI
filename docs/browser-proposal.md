# Đề xuất: cho agent dùng trình duyệt trong PIRL CLI (Playwright)

Trạng thái: đề xuất, chưa triển khai.
Cập nhật: 2026-10-27 (lần 1).

## 1. Kết luận

PIRL CLI cho agent dùng một trình duyệt thật, điều khiển bằng Playwright, ở đúng hai chỗ framework đã cho phép:

- **Điều tra nguyên nhân gốc** khi người dùng yêu cầu, trong run Plan hoặc chat: role điều tra mở ứng dụng để tái hiện lỗi và phân biệt các giả thuyết.
- **Layout verification với mock** trong run Implement có diff đổi UI: `frontend-developer` chụp ảnh và đo bố cục.

PIRL tự khởi động và tắt dev server của repo đích, rồi truyền URL cho run.
Công cụ trình duyệt chỉ được nạp cho run cần nó, chỉ cấp cho role cần nó, và không bao giờ cấp cho Review.
Tính năng mặc định tắt.

Kết quả chạy trình duyệt **không** trở thành bằng chứng cho QG, trừ ảnh và số đo của layout verification như framework đã quy định.
Triết lý "kiểm chứng bằng suy luận trên mã nguồn" giữ nguyên.

Còn một điểm cần chốt lại trước khi làm: dùng Playwright MCP hay Playwright CLI (mục 4).
Chính README của Playwright MCP khuyên coding agent dùng Playwright CLI vì tiết kiệm token hơn.
Phần còn lại của đề xuất dùng chung cho cả hai.

## 2. Quyết định đã chốt

| Chủ đề | Quyết định |
| --- | --- |
| Phạm vi so với triết lý framework | Phương án A: trình duyệt chỉ phục vụ điều tra/tái hiện lỗi và layout verification. Không trở thành bằng chứng kiểm chứng hành vi. Review không chạy gì. |
| Dev server | PIRL CLI tự khởi động và tắt theo lệnh ghi trong tài liệu ngữ cảnh của repo đích, rồi truyền URL cho run. Vòng đời nằm ngoài `claude -p`. |
| Chi phí token | Chỉ nạp công cụ trình duyệt cho run cần đến. Chỉ cấp cho role cần (`frontend-developer`, role điều tra) qua `roleTools`. Không cấp ở Review. |
| Chia giai đoạn | Giai đoạn 1: điều tra và tái hiện lỗi. Giai đoạn 2: chụp layout bằng script. |
| An toàn và cô lập | Profile trình duyệt riêng, giới hạn origin, đầu ra trong `.tmp/` của Hub, đóng trình duyệt khi xong. |
| Cài đặt và vận hành | Pin cứng phiên bản, `/doctor` kiểm tra, tính đến máy offline và Windows. |
| Bật/tắt | Một mục trong `/settings`, mặc định tắt. |
| Đa provider | Cấu hình trình duyệt nằm ở tầng provider, không hard-code trong runner. |

## 3. Hiện trạng (đã đọc trong repo)

- `src/engine/claudeRunner.ts` truyền `--strict-mcp-config` mà không kèm `--mcp-config`, nên run không nạp MCP server nào.
  `--tools` chỉ cấp `Read, Write, Edit, Bash, Glob, Grep, Agent`.
- `src/engine/permissions.ts` chỉ cho Bash chạy git đọc, script Python của framework và `TEST_RUNNERS` (chỉ ở Implement).
  `npm run dev`, `node …`, `npx playwright …` đều bị từ chối ở chế độ `dontAsk`.
- Runner đặt `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, nên run không giữ được một tiến trình chạy nền như dev server.
- Framework đã có chỗ cho trình duyệt:
  - `layout-verification.instructions.md`: Implement có diff đổi UI phải chụp layout với mock. Thiếu kết quả này thì task không được ghi `implemented`, không có trình duyệt thì phần layout là `BLOCKED`.
  - `layered-task-execution.instructions.md`, mục Verification by reasoning: khi người dùng yêu cầu điều tra nguyên nhân gốc, role điều tra được chạy ứng dụng để tái hiện lỗi.
  - `AGENTS.md`, mục Target repository: tài liệu ngữ cảnh của repo đích ghi cách chạy dev server ổn định và công cụ tự động hoá trình duyệt.

Hệ quả: qua PIRL CLI, task có đổi UI hiện gần như luôn kẹt `BLOCKED` ở phần layout, và việc điều tra không tái hiện được lỗi trên giao diện.
Đây là suy ra từ code và luật quyền, chưa chạy thử trên repo thật.

## 4. Chọn công cụ: Playwright MCP hay Playwright CLI (cần xác nhận)

Cả hai đều do Microsoft phát hành, dùng chung Playwright 1.64 (bản alpha) và có cùng nhóm năng lực: điều hướng, thao tác, snapshot accessibility, chụp ảnh, đổi kích thước, mock request, đọc console và network.

| Tiêu chí | Playwright MCP (`@playwright/mcp` 0.0.83) | Playwright CLI (`@playwright/cli` 0.1.22) |
| --- | --- | --- |
| Cách agent gọi | Tool MCP `mcp__playwright__browser_*` | Lệnh Bash `playwright-cli <lệnh>` |
| Context mỗi request | Thêm định nghĩa của khoảng 24 tool lõi, cộng 4 tool network khi bật `--caps=network` | Không thêm định nghĩa tool. Agent đọc `--help` hoặc skill khi cần. |
| Snapshot trang | Mặc định trả snapshot sau mỗi thao tác vào context (tắt được bằng `--snapshot-mode none`) | Ghi snapshot ra file, agent đọc phần cần |
| Cưỡng chế quyền trong PIRL | Luật theo tên tool, cần thêm `--mcp-config` và danh sách tool cho subagent | Luật `Bash(...)` theo tiền tố lệnh, đúng cơ chế PIRL đang dùng |
| Mock request | `browser_route` | `playwright-cli route` |
| Giữ trạng thái giữa các lệnh | Phiên MCP sống cùng tiến trình provider | Session có tên (`-s=<tên>`) chạy dưới dạng daemon |
| Provider khác | Mỗi CLI khai báo MCP theo cách riêng | Mọi agent có shell đều dùng được |
| Lời khuyên của nhà phát hành | "If you are using a coding agent, you might benefit from using the CLI+SKILLS instead" | "If you are using coding agents, that is the best fit" |

**Khuyến nghị: dùng Playwright CLI làm mặc định.**

- Nó khớp với quyết định cũ của PIRL là bỏ MCP để giảm context (đề xuất PIRL CLI, mục 14.5: từ 25k xuống 18k token).
- Luật quyền viết được bằng đúng cơ chế `Bash(...)` sẵn có, từng lệnh con một (mục 8.1).
- Nó dùng được ngay cho Codex, Gemini CLI và Copilot CLI ở giai đoạn 4 của PIRL.

Nếu bạn vẫn muốn MCP, thiết kế ở các mục sau vẫn dùng được, chỉ khác phần ánh xạ quyền (mục 8.2).
Thiết kế tách một lớp `BrowserBackend` để có thể đổi qua lại mà engine không đổi.

## 5. Phạm vi theo layer và role

| Run | Role có trình duyệt | Khi nào | Kết quả là gì |
| --- | --- | --- | --- |
| Plan | `code-analyst` | Người dùng yêu cầu điều tra nguyên nhân gốc | Bằng chứng chẩn đoán để phân biệt giả thuyết. Plan ghi nguyên nhân, không biến kết quả tái hiện thành QG. |
| Chat (standalone task) | `code-analyst` | Như trên | Như trên |
| Implement | `frontend-developer` (giai đoạn 2) | Diff đổi giao diện | Ảnh chụp và số đo trong `.tmp/layout-snapshots/...`, là bằng chứng của phần layout |
| Implement | `ux-designer`, `code-reviewer`, `code-analyst` | Không | Đọc ảnh và số đo, không chạy trình duyệt |
| Review | Không role nào | Không | Đọc ảnh và tóm tắt của Implement |
| Mọi run | coordinator | Không | Chỉ điều phối |

Giai đoạn 1 chỉ làm hai dòng đầu.
Implement vẫn như hiện nay cho đến giai đoạn 2.

## 6. Luồng hoạt động

### 6.1. Mục cài đặt

`/settings` có thêm mục **Trình duyệt cho agent**, ba giá trị:

| Giá trị | Ý nghĩa |
| --- | --- |
| Tắt (mặc định) | PIRL chạy như hiện nay. Không cài gì, không chạy dev server. |
| Hỏi mỗi lần | Mỗi lần agent xin trình duyệt, PIRL hỏi người dùng trước khi chạy dev server. |
| Tự động | PIRL tự chạy khi lệnh dev server đã được duyệt trước đó cho repo này. Lệnh mới hoặc lệnh đổi vẫn hỏi. |

Khi chuyển từ Tắt sang giá trị khác, PIRL hỏi cài công cụ (mục 8.4) và `/doctor` bắt đầu kiểm tra nó.

### 6.2. Agent xin trình duyệt

Run không nạp công cụ trình duyệt ngay từ đầu.
Khi framework đến chỗ cần trình duyệt, coordinator kết thúc lượt bằng một khối mà PIRL đọc được, giống khối `pirl-suggest` đang có:

````text
```pirl-browser
purpose: investigate
reason: Tái hiện lỗi nút "Huỷ đơn" không phản hồi trên mobile
command: npm run dev
cwd: apps/web
url: http://localhost:5173
ready: Local:
origins: http://localhost:5173; http://localhost:8080
```
````

- `purpose` là `investigate` hoặc `layout`.
- `command`, `cwd`, `url` và dấu hiệu sẵn sàng `ready` lấy từ tài liệu ngữ cảnh của repo đích.
  PIRL không tự phân tích tài liệu, việc đó là của coordinator.
- `origins` là các origin trình duyệt được gọi tới (dev server, API thật nếu điều tra cần).

PIRL kiểm tra khối này:

- Run có loại và role đúng phạm vi ở mục 5.
- Có repo đích, `cwd` nằm trong repo đích, `url` là `http://localhost`, `127.0.0.1` hoặc `[::1]`.
- Khối nào không hợp lệ thì trả lại run kèm lý do, giống cách PIRL đang trả lại khi validator báo lỗi.

### 6.3. Người dùng duyệt

Khung chat hiện một thẻ hỏi, dùng lại cơ chế câu hỏi của run:

```text
Agent cần mở ứng dụng trong trình duyệt để tái hiện lỗi.
  Lệnh:  npm run dev   (trong apps/web)
  URL:   http://localhost:5173
  1. Cho phép
  2. Khác: sửa lệnh hoặc URL
  3. Không, tiếp tục bằng suy luận
```

- "Cho phép" lưu lệnh đã duyệt cho repo này (mục 7.1).
- "Không" cho run chạy tiếp mà không có trình duyệt: điều tra bằng suy luận, phần layout `BLOCKED` như hiện nay.
- Ở mức "Tự động" với lệnh đã duyệt, PIRL bỏ qua thẻ này và chỉ ghi một dòng thông báo.

### 6.4. PIRL chạy và nối lại run

1. Khởi động dev server và chờ sẵn sàng (mục 7).
2. Mở session trình duyệt với cấu hình cố định (mục 8.3).
3. Nối lại phiên của coordinator bằng `--resume`, với công cụ trình duyệt được thêm vào quyền và vào định nghĩa role, kèm thông điệp nêu URL và cách dùng.
4. Khi tiến trình provider kết thúc (hết lượt, Esc, lỗi, PIRL thoát), PIRL đóng trình duyệt và tắt dev server.
   Nếu run còn tiếp sau câu hỏi khác, PIRL khởi động lại ở lượt sau.

Mỗi lần gọi `claude -p` là một tiến trình mới, nên đổi quyền giữa hai lượt là hợp lệ.
Dòng "The run's permissions are fixed by PIRL CLI and cannot change during the run" trong `src/engine/protocol.ts` sẽ thêm ngoại lệ cho khối `pirl-browser`.

## 7. Dev server

### 7.1. Nguồn lệnh và lưu lệnh đã duyệt

- Nguồn sự thật là tài liệu ngữ cảnh của repo đích, đúng như `AGENTS.md` của framework quy định.
- Lệnh người dùng đã duyệt được lưu trong `~/.pirl/browser/<mã repo>.json` (command, cwd, url, ready, origins, thời điểm duyệt), không ghi vào repo đích.
- Khi khối `pirl-browser` khác bản đã lưu, PIRL hỏi lại.

Chạy lệnh dev server là chạy mã của repo, cùng mức rủi ro với `npm test` mà Implement đã được chạy.
Vì vậy người dùng phải thấy đúng lệnh trước lần chạy đầu.

### 7.2. Khởi động

- Chạy bằng `cross-spawn` trong `cwd`, không qua shell, nên không có pipe, `&&` hay chuyển hướng.
  Lệnh cần biến môi trường thì người dùng ghi vào tài liệu của repo dưới dạng script của package.
- Trước khi chạy, PIRL thử gọi `url`.
  Nếu đã có server trả lời, PIRL hỏi: dùng server đang chạy (và không tắt nó khi xong) hoặc huỷ.
  PIRL không bao giờ tắt tiến trình nó không tự khởi động.
- Log của dev server ghi vào `.tmp/pirl-run/dev-server.log` trong Hub, để agent đọc bằng `Read` khi cần.

### 7.3. Chờ sẵn sàng

- PIRL gọi `url` mỗi 500 ms, sẵn sàng khi nhận bất kỳ phản hồi HTTP nào hoặc khi log có dòng chứa `ready`.
- Quá 120 giây (chỉnh được trong `/settings`), PIRL tắt server và trả về run 20 dòng log cuối.
  Coordinator ghi lại trở ngại và tiếp tục như khi người dùng chọn "Không".

### 7.4. Tắt

- Tách hàm `killTree` từ `src/engine/claudeRunner.ts` ra `src/core/process.ts` để dùng chung.
  Trên Windows là `taskkill /T /F`, trên các hệ khác là gửi tín hiệu cho cả nhóm tiến trình.
- Tắt khi tiến trình provider kết thúc, khi người dùng nhấn Esc và khi PIRL thoát (cùng chỗ với tập `running` hiện có).

## 8. Công cụ trình duyệt và quyền

### 8.1. Với Playwright CLI (khuyến nghị)

PIRL tự mở session trước khi nối lại run, với tên riêng cho từng run:

```text
playwright-cli -s=pirl-<runId> open --config=<Hub>/.tmp/pirl-run/browser.json <url>
```

Agent chỉ được dùng các lệnh con thao tác trong đúng session đó, mỗi lệnh con một luật:

| Nhóm | Luật cho phép (ví dụ) |
| --- | --- |
| Điều hướng và thao tác | `Bash(playwright-cli -s=pirl-<runId> goto *)`, `click`, `fill`, `type`, `press`, `hover`, `select`, `check`, `uncheck`, `go-back`, `dialog-accept`, `dialog-dismiss` |
| Quan sát | `snapshot`, `find`, `screenshot`, `console`, `requests`, `eval` |
| Bố cục | `resize`, `set-color-scheme`, `set-reduced-motion` |
| Mock | `route`, `route-list`, `unroute` |

Bị từ chối, vì không có trong danh sách hoặc bị cấm rõ:

- `open`, `attach` (gắn vào trình duyệt thật của người dùng), `close-all`, `kill-all`, `delete-data`, `install`.
- `run-code` (chạy mã Node trong tiến trình Playwright) ở giai đoạn 1.
- Mọi lệnh `playwright-cli` không có `-s=pirl-<runId>`.

`eval` chạy JavaScript trong trang để đo (bounding box, style đã tính).
Framework cho phép dùng nó để chẩn đoán, nhưng kết quả không phải bằng chứng QG.

Các luật này chỉ thêm vào run có khối `pirl-browser` đã duyệt.
`roleTools` đã cấp Bash cho `code-analyst` và `frontend-developer`, nên không cần thêm tool mới.
Lời dặn trong `toolRules` của `src/engine/agents.ts` thêm một dòng cho lệnh `playwright-cli` với tên session của run.

### 8.2. Với Playwright MCP (nếu chọn)

- Runner thêm `--mcp-config <Hub>/.tmp/pirl-run/mcp.json` chỉ khai báo server `playwright`, và giữ `--strict-mcp-config`.
- Server chạy bằng bản đã cài sẵn trong `~/.pirl/tools` (mục 8.4), không dùng `npx @playwright/mcp@latest`.
- Cờ khởi động: `--headless --isolated --browser <trình duyệt> --output-dir <Hub>/.tmp/pirl-run/browser --caps network --snapshot-mode none --image-responses omit --allowed-origins <origins>`.
- `--allowedTools` liệt kê từng tool `mcp__playwright__browser_*` cần dùng.
  `--disallowedTools` cấm `mcp__playwright__browser_run_code_unsafe` (README ghi là tương đương chạy mã từ xa) và `browser_file_upload`.
- `roleTools` thêm đúng các tên tool đó cho `code-analyst` (Plan, chat) và `frontend-developer` (Implement, giai đoạn 2).

Cần kiểm chứng ở bước spike (mục 13):

- Định nghĩa tool MCP có vào context của coordinator không, kể cả khi chỉ subagent dùng. Nếu `--agents` hỗ trợ khai báo MCP server riêng cho từng subagent thì dùng cách đó.
- Luật quyền là chung cho cả phiên, nên coordinator cũng gọi được tool. Lời dặn trong host prompt là lớp chặn duy nhất.

### 8.3. Cô lập và an toàn

| Biện pháp | Cách làm |
| --- | --- |
| Không đụng trình duyệt của người dùng | Profile chỉ trong bộ nhớ (mặc định của CLI, `--isolated` của MCP), headless. Cấm `attach` và `--extension`. |
| Giới hạn nơi trình duyệt gọi tới | `origins` của khối `pirl-browser`. README của cả hai ghi rõ đây không phải ranh giới bảo mật, chỉ là giảm rủi ro. |
| Đầu ra | Ảnh, snapshot, log nằm trong `.tmp/pirl-run/browser/` của Hub (bị Git bỏ qua, xoá khi run kết thúc). Ảnh layout ở `.tmp/layout-snapshots/...` được giữ, đúng quy tắc framework. |
| Nội dung trang là dữ liệu không tin cậy | Host prompt nhắc agent không làm theo chỉ dẫn xuất hiện trong trang. |
| Dữ liệu nhạy cảm | Ảnh có thể chứa dữ liệu thật khi điều tra với backend thật. Chúng không rời máy và không vào commit. |
| Dọn dẹp | PIRL đóng session và tắt dev server, không phụ thuộc agent nhớ dọn. |

### 8.4. Cài đặt

- Khi người dùng bật tính năng, PIRL hỏi rồi cài bản đã pin vào `~/.pirl/tools/` bằng `npm install --prefix`.
  Không thêm vào `dependencies` của PIRL, vì Playwright nặng và nhiều người không cần.
- Tiến trình provider nhận `PATH` có thư mục `bin` của bản đã pin đứng đầu, để `playwright-cli` luôn là bản đó.
- Trình duyệt: ưu tiên Chrome hoặc Edge đã có trên máy (`--browser=chrome|msedge`), không phải tải gì.
  Không có thì hỏi trước khi tải Chromium của Playwright (vài trăm MB).
- Máy offline hoặc sau proxy công ty: `/doctor` báo rõ bước nào thiếu và lệnh để tự cài.
- Nâng phiên bản Playwright là một thay đổi của PIRL, có test, không tự nâng.

`/doctor` thêm một dòng **Trình duyệt cho agent** khi tính năng đang bật: phiên bản công cụ, trình duyệt sẽ dùng, trạng thái lệnh dev server đã duyệt cho repo hiện tại.

## 9. Chi phí token

- Không nạp gì khi tính năng tắt hoặc run không xin trình duyệt, nên chi phí của đa số run không đổi.
- Nối lại phiên với bộ quyền mới làm lỡ prompt cache một lần cho mỗi run có trình duyệt.
- Với CLI, chi phí thêm chủ yếu là lời gọi Bash và phần snapshot agent chọn đọc.
  Với MCP, thêm định nghĩa tool ở mọi request sau khi nạp, cộng snapshot nếu không tắt.
- Ảnh không đưa vào context mặc định.
  Agent mở ảnh bằng `Read` khi thật sự cần nhìn.

Bước spike đo trên repo demo: cùng một yêu cầu điều tra, so số token và chi phí giữa không có trình duyệt, CLI và MCP.

## 10. Thay đổi framework (fw-1.4.0)

Framework vẫn không phụ thuộc host, nên thay đổi nhỏ:

- `AGENTS.md`, mục Target repository: liệt kê các thông tin về dev server mà tài liệu ngữ cảnh nên có (lệnh, thư mục, URL, dấu hiệu sẵn sàng, origin của API).
  Mục này đã nhắc "how to run a stable dev server", chỉ cần cụ thể hơn.
- Không đổi quy tắc bằng chứng (phương án A).
- Không đổi Review.

Khối `pirl-browser` và cách xin trình duyệt nằm trong host prompt của PIRL (`src/engine/protocol.ts`), không nằm trong framework.

## 11. Thay đổi code PIRL CLI

| File | Thay đổi |
| --- | --- |
| `src/core/config.ts` | Thêm `browser: 'off' \| 'ask' \| 'auto'` và thời gian chờ dev server |
| `src/ui/App.tsx` (`settingsRows`) | Mục cài đặt mới |
| `src/core/process.ts` (mới) | `killTree` tách từ `claudeRunner.ts` |
| `src/engine/devServer.ts` (mới) | Kiểm tra cổng, khởi động, chờ sẵn sàng, ghi log, tắt |
| `src/engine/browser.ts` (mới) | `BrowserBackend`: cài và kiểm tra công cụ, mở và đóng session, luật quyền, lời dặn cho role |
| `src/engine/permissions.ts` | Hàm `browserRules` thêm luật cho run đã duyệt trình duyệt |
| `src/engine/agents.ts` | `roleTools` và `toolRules` nhận thêm tuỳ chọn trình duyệt cho đúng role |
| `src/engine/protocol.ts` | Khối `pirl-browser`: hướng dẫn trong host prompt và hàm đọc khối |
| `src/engine/run.ts` | Nhận khối, hỏi người dùng, chạy dev server, nối lại phiên, dọn khi kết thúc |
| `src/engine/claudeRunner.ts` | `PATH` có công cụ đã pin. Với MCP: `--mcp-config`. |
| `src/providers/types.ts` | Năng lực `browser` của provider |
| `src/doctor/doctor.ts` | `browserCheck` |
| `docs/user-guide.md`, `CHANGELOG.md` | Tài liệu cho người dùng |

## 12. Kiểm thử

- Test đơn vị: đọc và kiểm tra khối `pirl-browser`, luật quyền theo loại run và role, tham số runner khi có hoặc không có trình duyệt.
- `devServer`: dùng một script Node nhỏ làm server giả để thử khởi động, chờ sẵn sàng, quá thời gian, cổng đã bận, tắt cả cây tiến trình (có nhánh Windows).
- Luồng trong TUI với provider giả lập: run xin trình duyệt, thẻ duyệt hiện ra, các lựa chọn "Cho phép", "Khác", "Không", run được nối lại với quyền mới, dọn dẹp khi Esc.
- CI không chạy trình duyệt thật, giống chính sách hiện tại chỉ dùng provider giả lập.
- Thử tay với Claude Code thật trên repo demo có giao diện web, trên Linux, macOS và Windows (PowerShell).

## 13. Lộ trình

| Giai đoạn | Nội dung | Kết quả kiểm chứng |
| --- | --- | --- |
| 0. Spike | Chốt mục 4. Kiểm chứng với Claude Code: luật `Bash(...)` khớp đúng lệnh con của `playwright-cli`, daemon của session không giữ `claude -p` mở khi background task bị tắt, `--resume` với bộ quyền mới. Với MCP thì thêm hai câu hỏi ở mục 8.2. Đo token (mục 9). | Bảng số đo và câu trả lời cho từng câu hỏi, ghi vào đề xuất này |
| 1. Điều tra | Mục cài đặt, cài công cụ, `/doctor`, dev server, khối `pirl-browser`, quyền cho `code-analyst` ở Plan và chat | Yêu cầu điều tra một lỗi giao diện trên repo demo: agent tái hiện được lỗi, Plan ghi đúng nguyên nhân, dev server và trình duyệt được dọn |
| 2. Layout | `frontend-developer` ở Implement viết script chụp vào `.tmp/layout-snapshots/...` và chạy nó qua session của run. Cách chạy script (`run-code --filename` giới hạn trong thư mục chụp, hoặc một lệnh riêng của PIRL) chốt sau giai đoạn 1. | Task có đổi UI trên repo demo được ghi `implemented` với `layout_verification` đầy đủ, Review đọc được ảnh |
| 3. Provider khác | Ánh xạ `BrowserBackend` cho Codex, Gemini CLI, Copilot CLI theo giai đoạn 4 của PIRL | Cùng kịch bản giai đoạn 1 chạy được trên provider thứ hai |

## 14. Rủi ro

1. **Công cụ còn ở bản 0.x và phụ thuộc Playwright alpha.**
   Pin phiên bản, nâng có kiểm soát, giữ lớp `BrowserBackend` để đổi công cụ khi cần.
2. **Dev server mỗi repo một kiểu.**
   Monorepo, biến môi trường, cần backend thật, cổng thay đổi.
   PIRL chỉ hỗ trợ lệnh chạy được không qua shell và URL localhost. Còn lại thì báo rõ trở ngại và chạy tiếp bằng suy luận.
3. **Cây tiến trình trên Windows.**
   Dev server thường chạy dưới `cmd.exe` của `npm`, nên phải tắt cả cây như cách runner đã làm với `claude.cmd`.
4. **Coordinator dùng công cụ dành cho role.**
   Luật quyền là chung cho phiên, nên chỉ chặn được bằng lời dặn. Spike kiểm tra xem có cách khai báo theo subagent không.
5. **Nội dung trang điều khiển agent.**
   Ứng dụng của chính repo nên rủi ro thấp, nhưng điều tra với backend thật có thể đưa dữ liệu ngoài vào trang. Giới hạn origin và lời dặn trong host prompt.
6. **Tài nguyên máy.**
   Dev server cộng trình duyệt tốn RAM và CPU. Chỉ chạy khi run cần, tắt ngay khi lượt kết thúc.

## 15. Câu hỏi còn mở

1. Chốt Playwright CLI (khuyến nghị) hay Playwright MCP (mục 4)?
2. Ba mức "Tắt / Hỏi mỗi lần / Tự động" cho mục cài đặt có hợp không, hay chỉ cần Tắt/Bật?
3. Lưu lệnh dev server đã duyệt trong `~/.pirl` (không chạm repo đích) có ổn không?
4. Khi run dừng chờ người dùng trả lời câu hỏi khác, tắt dev server rồi khởi động lại ở lượt sau (đề xuất), hay giữ nó chạy?
5. Role điều tra chỉ là `code-analyst`, hay để coordinator chọn role nào được trình duyệt?

## Nguồn tham khảo

- [Playwright MCP](https://github.com/microsoft/playwright-mcp), README của gói `@playwright/mcp` 0.0.83 trên npm
- [Playwright CLI](https://github.com/microsoft/playwright-cli), README của gói `@playwright/cli` 0.1.22 trên npm
- [Claude Code – MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code – Subagents](https://code.claude.com/docs/en/sub-agents)
- [Đề xuất PIRL CLI](pirl-cli-proposal.md), mục 7.2 (quyền theo role và layer) và 14.5 (tiết kiệm token)
