# 发版流程

本仓库的发布分两段：GitHub Actions 构建并挂资产，维护者在本地用 2FA 窗口把包发到 npm。
CI **不**发布 npm——账号开启了 auth-and-writes 两步验证，runner 里没有 OTP；也不使用
npm Trusted Publisher（已明确放弃，见文末）。

## 1. 定版本

以下位置必须一致：

| 位置 | 字段 |
| --- | --- |
| `plugin/package.json` | `version` |
| `plugin/package-lock.json` | 顶层 `version` 与 `packages[""].version` |
| `README.md`、`README.zh.md`、`README.ja.md`、`README.zh-tw.md`、`README.de.md` | 安装示例里的 `dsh-desktop-pet-codex@x.y.z` |

`plugin/README*.md` 不是手写文件：`node tools/sync-plugin-readmes.mjs` 从上面五份根 README 生成
（图片改成绝对 raw 链接、HTML 画廊改成 markdown 图片行），`check-plugin-readmes` 工作流校验两边
同步。改完根 README 要重跑脚本，否则 CI 直接失败。

版本号遵循 semver：0.x 阶段 patch 修 bug，minor 用于兼容性变化。**已发布的版本号不可复用**。

## 2. 提交并打 tag

```bash
git add -A
git commit -m "release v0.1.2"
git tag v0.1.2
git push origin main
git push origin v0.1.2
```

tag 必须是 `v<version>` 且与 `plugin/package.json` 完全一致；tag 与版本不一致时
`release.yml` 会直接失败。

## 3. 等 CI 产出资产

push tag 触发 `.github/workflows/release.yml`：

1. 四个平台构建：win32-x64、linux-x64、darwin-arm64、darwin-x64；
2. `pack` 作业：`npm ci` → `tools/pack-release.mjs --skip-build --require-all` →
   校验 tag 与版本 → 上传 artifact → 挂到 GitHub Release。

成功后 Release 下应有：

- `dsh-desktop-pet-codex-v<version>.tgz`
- `dsh-desktop-pet-codex.tgz`（版本无关名；`releases/latest/download/...` 永远指向最新）

CI 不碰 npm，所以 CI 红了不会留下半发布的 npm 版本；修好构建后重跑即可。

## 4. 人工发布到 npm（需要用户完成 2FA）

npm 账号开启了 auth-and-writes 两步验证，必须在能交互输入一次性密码的终端里发布。
Agent 开窗口的方式：

```powershell
Start-Process powershell -ArgumentList '-NoExit','-Command',"cd '$PWD\plugin'; npx -y npm@latest publish --registry=https://registry.npmjs.org --access public"
```

用户在窗口中输入 OTP，看到 `+ dsh-desktop-pet-codex@<version>` 即成功。

注意：

- 命令必须在 `plugin/` 目录执行（manifest、`bin/`、`cordis.patch.yml` 都在那里）。
- 版本已存在会报 403 / `EPUBLISHCONFLICT`：不要重发同版本，改版本号。
- 窗口关闭或超时，重开窗口重跑同一条命令即可。

## 5. 验证

```bash
npm view dsh-desktop-pet-codex version
npm view dsh-desktop-pet-codex dist-tags
npm view dsh-desktop-pet-codex@<version> dist.tarball
```

`version` 与 `dist-tags.latest` 都应指向新版本，tarball 可下载。

## 6. 目录（awesome-dsh-plugin）要不要改

不用改。目录 entry 的 `tarball` 指向
`https://github.com/Mng12345/dsh-desktop-pet-codex/releases/latest/download/dsh-desktop-pet-codex.tgz`，
新 Release 挂好后自动跟随最新；npm 安装名也不变。只有仓库地址或包名变化时才需要重新提 PR。

## 不要做的事

- 不要在 `release.yml` 里重新加 `npm publish` 或 `id-token: write`：没有 Trusted Publisher
  配置时 CI 发布必失败，而且失败发生在挂资产之前，会让 Release 缺资产。
- 不要把 npm token 提交进仓库或写进 Secrets（当前不使用）。
- 不要复用已发布的版本号。
