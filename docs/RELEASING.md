# Memo: phát hành PIRL CLI lên npm (đăng thủ công từ máy)

Quy trình đăng gói `pirl-cli` lên npm từ máy cá nhân, kèm cách tăng version cho các bản sau.
Lệnh trong memo chạy được cả trong PowerShell lẫn bash; mỗi dòng là một lệnh, chạy lần lượt.

- Repo: https://github.com/tdmadc107/PIRL-CLI
- Gói npm: https://www.npmjs.com/package/pirl-cli
- Nhánh: phát triển trên `develop`, phát hành từ `main`. Mọi thay đổi vào `main` đi qua PR.

## Tóm tắt một lần phát hành

| # | Việc | Ở đâu |
| --- | --- | --- |
| 1 | Tăng version, ghi CHANGELOG, chạy kiểm tra | Máy, nhánh `develop` |
| 2 | Commit, push, mở PR `develop` → `main`, đợi CI xanh, merge | Máy + GitHub |
| 3 | Lấy `main` mới nhất, `npm publish` | Máy, nhánh `main` |
| 4 | Kiểm tra gói trên npm | Máy |
| 5 | Gắn tag `v<version>` và push: workflow tạo GitHub release | Máy + GitHub Actions |

Chi tiết từng bước ở Phần 3. Lần đầu tiên (1.0.0) làm theo Phần 2.

---

## Phần 1. Chuẩn bị (làm một lần)

### 1.1. Công cụ trên máy

| Công cụ | Phiên bản | Kiểm tra |
| --- | --- | --- |
| Node.js | 22 trở lên (kèm npm 10+) | `node --version` |
| Git | bất kỳ bản gần đây | `git --version` |
| Python | 3.9 trở lên (test của framework cần) | `python --version` (Windows: `py --version`) |

### 1.2. Mã nguồn

```bash
git clone https://github.com/tdmadc107/PIRL-CLI.git
cd PIRL-CLI
```

Máy dùng email noreply của GitHub cho commit, để email cá nhân không lộ trong lịch sử:

```bash
git config --global user.email "115369648+tdmadc107@users.noreply.github.com"
```

### 1.3. Tài khoản npm và 2FA

1. Tạo tài khoản tại https://www.npmjs.com/signup và bấm link xác nhận trong email (chưa xác nhận thì không đăng được).
2. Bật 2FA: avatar → **Account** → **Two-Factor Authentication** → chọn **Security key** → **Continue**.
3. Đặt tên khoá (ví dụ `Windows Hello - PC`) → **Add security key** → chọn nơi lưu passkey:
   - **Thiết bị Windows này**: xác nhận bằng PIN, vân tay hoặc khuôn mặt (Windows Hello);
   - **Điện thoại**: Chrome hiện mã QR, quét bằng camera điện thoại (máy tính cần bật Bluetooth);
   - **Khoá USB/NFC** (YubiKey) nếu có.
4. **Lưu mã khôi phục (recovery codes)**: in ra giấy hoặc cất trong trình quản lý mật khẩu, không chỉ để trong
   một file trên máy.
5. **Thêm khoá thứ hai** trên thiết bị khác (ví dụ passkey trên điện thoại nếu khoá đầu là Windows Hello), để
   mất một thiết bị vẫn vào được tài khoản.

### 1.4. Quy tắc bảo vệ nhánh `main` trên GitHub

Settings → Branches (hoặc Rules → Rulesets) → quy tắc cho `main`:

- Require a pull request before merging, **Required approvals = 0** (repo một người: GitHub không cho tự duyệt
  PR của mình; chỉ người có quyền ghi mới merge được, nên người ngoài vẫn không merge được);
- Require status checks to pass;
- Block force pushes, Restrict deletions.

---

## Phần 2. Phát hành lần đầu: 1.0.0

Version `1.0.0` và mục `## [1.0.0]` trong `CHANGELOG.md` đã có sẵn, nên bỏ qua bước tăng version.

1. **Merge PR #4** (https://github.com/tdmadc107/PIRL-CLI/pull/4): sửa workflow để bước gắn tag ở cuối chỉ tạo
   GitHub release cho bản đã đăng thủ công. Đợi CI xanh → **Merge pull request** → **Confirm merge**.
2. Lấy `main` mới nhất:
   ```bash
   git checkout main
   git pull
   ```
3. Làm tiếp **bước 3.4 đến 3.7** ở Phần 3, với version `1.0.0`.

---

## Phần 3. Cập nhật version và phát hành bản mới

Ví dụ dưới đây phát hành `1.0.1`; thay bằng version thật của lần đó.

### 3.1. Chọn số version (Semantic Versioning)

Version hiện tại: `node -p "require('./package.json').version"`.

| Thay đổi từ bản trước | Tăng | Ví dụ |
| --- | --- | --- |
| Chỉ sửa lỗi, không đổi cách dùng | patch | 1.0.0 → 1.0.1 |
| Thêm tính năng, cách dùng cũ vẫn chạy | minor | 1.0.1 → 1.1.0 |
| Đổi hoặc bỏ cách dùng cũ (lệnh, cấu hình, yêu cầu Node…) | major | 1.1.0 → 2.0.0 |

Một số version đã đăng thì không bao giờ dùng lại được, kể cả khi gỡ bản đó.

### 3.2. Cập nhật version trên `develop`

```bash
git checkout develop
git pull
npm version 1.0.1 --no-git-tag-version
```

`npm version` sửa version trong cả `package.json` và `package-lock.json`; `--no-git-tag-version` để nó không tự
commit và tạo tag (tag tạo ở bước 3.7, sau khi gói đã lên npm). Có thể dùng `npm version patch` / `minor` /
`major` thay cho số cụ thể.

**Framework có đổi không?** Xem các file framework đã đổi từ bản trước:

```bash
git diff v1.0.0..HEAD --stat -- pirl-framework
```

(thay `v1.0.0` bằng tag của bản phát hành trước). Nếu có file đổi:

- tăng `pirl.frameworkVersion` trong `package.json` (ví dụ `1.1.0` → `1.1.1`, cùng quy tắc semver). Hub của người
  dùng so số này với bản framework họ đang có để báo có framework mới; quên tăng thì họ không được báo;
- thêm mục `### Framework fw-<version mới>` trong CHANGELOG (bước 3.3).

### 3.3. Ghi `CHANGELOG.md`

Thêm mục mới **ở trên cùng**, ngay dưới phần giới thiệu, theo mẫu:

```markdown
## [1.0.1] - 2026-11-02

### Sửa

- Mô tả lỗi đã sửa, theo cách người dùng thấy.

### Thêm

- Tính năng mới.

### Thay đổi

- Hành vi đã đổi.

### Framework fw-1.1.1

- Thay đổi của framework (chỉ khi framework đổi).
```

Chỉ giữ các mục có nội dung. Workflow tạo GitHub release trỏ người đọc về `CHANGELOG.md`.

### 3.4. Kiểm tra trên máy

```bash
npm ci
npm run typecheck
npm test
npm run pack:check
```

- `npm test` chạy toàn bộ test (trên Windows mất vài phút).
- `npm run pack:check` build, đóng gói, cài gói vào thư mục tạm rồi chạy `pirl --version` và `pirl --help`.
- Test của framework (chạy khi framework đổi):
  ```bash
  python -B -m unittest discover -s pirl-framework/.agents/evals/tests -p "test_*.py"
  ```

Tất cả phải xanh. Khi phát hành 1.0.0 từ `main` (Phần 2), chạy bước này trên `main`, rồi sang thẳng 3.6.

### 3.5. Commit, PR và merge vào `main`

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release 1.0.1"
git push origin develop
```

1. Mở https://github.com/tdmadc107/PIRL-CLI/compare/main...develop → **Create pull request** (tiêu đề:
   `Release 1.0.1`) → **Create pull request**.
2. Đợi tất cả check CI xanh (khoảng 6 phút, Windows chậm nhất).
3. **Merge pull request** → **Confirm merge**.

### 3.6. Đăng lên npm từ `main`

```bash
git checkout main
git pull
node -p "require('./package.json').version"
```

Lệnh cuối phải in đúng version sắp đăng. Rồi:

```bash
npm whoami
```

In ra tên tài khoản npm của bạn. Nếu báo lỗi `ENEEDAUTH`, đăng nhập:

```bash
npm login
```

(npm mở trình duyệt; đăng nhập và xác nhận bằng security key.) Xem trước nội dung gói nếu muốn:

```bash
npm pack --dry-run
```

(khoảng 90 file: `dist/`, `bundled-framework/`, README, LICENSE, CHANGELOG; không có source TypeScript, test hay
`docs/`). Đăng:

```bash
npm publish
```

- npm tự chạy lại typecheck, toàn bộ test và build trước khi đăng; test lỗi thì dừng, không có gì được đăng.
- npm in `Authenticate your account at: https://www.npmjs.com/auth/cli/...` → nhấn Enter để mở trình duyệt →
  xác nhận bằng security key → quay lại terminal.
- Thành công khi thấy `+ pirl-cli@1.0.1`.

### 3.7. Kiểm tra gói, gắn tag

```bash
npm view pirl-cli version
npm install -g pirl-cli
pirl --version
```

Cả hai phải in version vừa đăng. Rồi gắn tag cho đúng commit đã đăng (đang ở `main`):

```bash
git tag v1.0.1
git push origin v1.0.1
```

Workflow **Release** (tab Actions của repo) chạy: thấy bản này đã có trên npm nên bỏ qua bước đăng, chỉ tạo
GitHub release. Kiểm tra release mới ở https://github.com/tdmadc107/PIRL-CLI/releases.

### 3.8. Quay lại làm việc

```bash
git checkout develop
git pull
git merge main
git push origin develop
```

Đưa commit merge của `main` về `develop`, để PR lần sau không lệch lịch sử.

---

## Phần 4. Lỗi thường gặp

| Thông báo | Nguyên nhân | Cách xử lý |
| --- | --- | --- |
| `ENEEDAUTH`, `E401` | Chưa đăng nhập npm trên máy | `npm login` |
| `EOTP`, hoặc bị hỏi xác thực | Cần xác nhận 2FA | Mở link npm in ra, xác nhận bằng security key |
| `You cannot publish over the previously published versions` | Version đã tồn tại trên npm | Tăng version (Phần 3), không dùng lại số cũ |
| `Package name too similar to existing packages` | npm chặn tên dễ nhầm | Đổi tên gói, ví dụ `@tdmadc107/pirl-cli` |
| Test lỗi khi `npm publish` | Thường do thiếu Python hoặc thay đổi chưa kiểm tra | Cài Python 3.9+, chạy lại bước 3.4 |
| Workflow lỗi ở *Tag matches package.json* | Tag khác version trong `package.json` | Xoá tag: `git tag -d v1.0.1` và `git push origin :refs/tags/v1.0.1`, gắn lại đúng tag |
| Nút Merge bị khoá dù CI xanh | Quy tắc `main` đòi approval | Đặt Required approvals = 0 (Phần 1.4) |

**Lỡ đăng nhầm:**

- Trong 72 giờ đầu: `npm unpublish pirl-cli@1.0.1` (số version đó vẫn không dùng lại được).
- Sau 72 giờ: chỉ đánh dấu được, gói vẫn còn: `npm deprecate pirl-cli@1.0.1 "Lỗi X, dùng 1.0.2"`. Rồi phát hành
  bản sửa ngay.

---

## Phần 5. Đổi máy hoặc mất máy

**Đổi máy (máy cũ còn):**

1. Làm lại Phần 1.1 và 1.2 trên máy mới.
2. `npm login`, xác nhận bằng passkey trên điện thoại (quét QR, máy tính bật Bluetooth) hoặc khoá USB.
3. npmjs.com → Account → Two-Factor Authentication: thêm Windows Hello của máy mới, xoá khoá của máy cũ.

**Mất máy:**

1. Đăng nhập npmjs.com từ thiết bị khác bằng khoá còn lại, hoặc chọn dùng recovery code khi được hỏi 2FA.
2. Xoá khoá của máy bị mất trong Two-Factor Authentication.
3. Đã dùng recovery code thì tạo bộ mã mới và cất lại.
4. Access Tokens: xoá mọi token từng nằm trên máy bị mất.

Gói đã đăng và repo GitHub không bị ảnh hưởng; chỉ việc đăng bản mới phải đợi lấy lại quyền vào npm.

---

## Phụ lục: lệnh nhanh cho một lần phát hành

```bash
# Trên develop
git checkout develop
git pull
npm version 1.0.1 --no-git-tag-version
git diff v1.0.0..HEAD --stat -- pirl-framework   # framework đổi thì tăng pirl.frameworkVersion
# sửa CHANGELOG.md
npm ci
npm run typecheck
npm test
npm run pack:check
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release 1.0.1"
git push origin develop
# GitHub: PR develop -> main, đợi CI xanh, merge

# Trên main
git checkout main
git pull
npm whoami
npm publish
npm view pirl-cli version
git tag v1.0.1
git push origin v1.0.1

# Quay lại develop
git checkout develop
git merge main
git push origin develop
```
