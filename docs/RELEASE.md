# 发布流程：构建、门禁、签名与 Release

> 适用版本：**v2.0.0（手写线首个正式版）**。发布前按第 1 节逐项打勾；构建细节与
> CI 实现见第 2–5 节。安装包体积分析已归档到 [archive/HAP-SIZE](archive/HAP-SIZE.md)。

## 1. 发布前检查清单

按顺序执行，任何一项失败都不要打 tag。

### 1.1 版本与文档

- [ ] `AppScope/app.json5`：`versionName` 与本次 tag 一致，`versionCode = 主*1e6+次*1e4+修订`
      （2.0.0 → `2000000`）。
- [ ] `README.md` / `README_EN.md` 的版本号、系统要求、构建命令与当前实现一致。
- [ ] `node scripts/check-docs.cjs` 通过（相对链接无失效）。
- [ ] [CHANGELOG](CHANGELOG.md) 已写本次发布内容；[STYLUS](STYLUS.md) 的 `ink rev`
      与 `scripts/patches/ohsidian-ink.js` 一致。
- [ ] `git status` 干净，没有把 `artifacts/`、`config.local.json`、`scripts/patches/ohsidian-probe.js`
      提交进去。

### 1.2 门禁

```powershell
# release asar 必须干净
node scripts/verify-release.cjs
node scripts/verify-asar.cjs

# 手写回归（需要设备 + 笔；只跑断言，不录屏）
node scripts/stylus-eval/run.mjs --mode gate
```

手写改动（`ohsidian-ink.js`、Pen Kit、PDF 写回）必须跑 gate；纯文档/构建改动可只跑前两条。
需要宣传素材时用 `--mode capture`，详见 [STYLUS](STYLUS.md) 第 9 节。

### 1.3 本地构建与真机冒烟

```powershell
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

安装 `electron/build/default/outputs/default/electron-default-signed.hap`，确认：

- [ ] 冷启动进入上次仓库，窗口铺满（平板触摸形态）；
- [ ] 设置 → 手写笔可打开，笔能出墨，关闭后 PDF 叠层为 0；
- [ ] 打开 PDF 写一笔，离开后注释位置正确（不整体左下偏移）；
- [ ] 关于页显示 `2.0.0`。

本地 HAP 只用于冒烟；对外发布包由 CI 以 tag 重新构建。

### 1.4 agent 包不会混入发布

agent 探针只通过 `node scripts/build-agent.mjs` 临时注入，产物在
`artifacts/agent/OHSidian-agent-<版本>-<时间>.hap`，脚本结束会恢复 release asar。
不要用 agent 包打 tag，也不要把 agent HAP 上传到 Release。

## 2. CI 如何工作

`.github/workflows/build-release.yml` 在**推送 `v*` 标签**或**手动触发**时运行：

1. Checkout（含 LFS：`libelectron.so` 等大文件）；
2. 下载官方 **HarmonyOS command-line-tools**（含 hvigor、ohpm、SDK）；
3. 从 `build-profile.example.json5` 生成 CI 专用 `build-profile.json5`：
   **compatible `6.0.2(22)` / target `6.1.1(24)`**（与真机验证组合一致）；
4. `update-obsidian.mjs --repatch` 下载、校验并注入补丁；
5. `verify-asar.cjs` + `verify-release.cjs`；
6. `hvigorw assembleHap`；
7. 按桌面图标矩阵（`ohsidian` / `obsidian`）各产出一个 HAP，附
   `SHA256SUMS.txt`、`MD5SUMS.txt` 与图标预览；
8. tag 推送时合并矩阵产物，创建 GitHub Release；手动触发时作为 workflow artifact。

### 2.1 必须配置一次的变量

在仓库 **Settings → Secrets and variables → Actions → Variables** 新建：

| 变量 | 作用 |
|---|---|
| `HARMONYOS_CLI_URL` | **Linux x64** Command Line Tools 的下载直链（`.tar.gz` 或 `.zip`） |
| `HARMONYOS_CLI_SHA256` | 可选但强烈建议：该压缩包的 SHA-256；设置后 CI 校验失败即中止 |

获取直链：<https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos>
→ 选 **Linux X64** → 复制下载链接。华为 CDN 直链有时效，403/404 时回下载页换新链接。
若官网需要登录，可用社区镜像
<https://huggingface.co/csukuangfj/harmonyos-commandline-tools> 的对应 linux 包。

不配置 `HARMONYOS_CLI_URL` 时工作流会告警并跳过构建；手动触发时可在输入框临时填 URL。

### 2.2 SDK 版本不要改错

`compatibleSdkVersion` 是 HAP 能安装的**最低**系统版本，必须 ≤ 23：

- API 22 = `6.0.2(22)`（本项目默认，也是闭源中间层验证过的版本）
- API 23 = `6.1.0(23)`
- API 24 = `6.1.1(24)`

`targetSdkVersion` 只声明行为语义，可以保留 24。工作流输入与 `gen-build-profile.js`
的默认值都是 22；如果手动改成 24，HAP 将无法安装到 HarmonyOS 6.0.2 设备上。

## 3. 签名（决定别人能不能直接安装）

HarmonyOS NEXT 之后的 HAP **必须签名才能安装**，签名证书与开发者账号绑定。

| 方案 | 配置 | 适用 |
|---|---|---|
| A. CI 内置签名（推荐） | 配置 6 个 Secrets | Release 里的 HAP 开箱即装 |
| B. 用户自行签名 | 无需配置 | 用户用图形化工具或 DevEco Studio 签名后安装 |
| C. 用户自己编译 | 无需配置 | 开发者/贡献者 |

**方案 B 的图形化工具**（Release 页附同样说明）：

- [小白调试助手](https://github.com/likuai2010/auto-installer)（原 Auto-Installer）
- [HoKit](https://github.com/yabi-zzh/HoKit)

**方案 A 需要的 Secrets**（Base64 用 `base64 -w0 文件` 生成）：

| Secret | 内容 |
|---|---|
| `SIGN_STORE_P12` | 签名密钥库 `.p12`（Base64） |
| `SIGN_CERT_CER` | 证书 `.cer`（Base64） |
| `SIGN_PROFILE_P7B` | Profile `.p7b`（Base64） |
| `SIGN_KEY_ALIAS` | 密钥别名 |
| `SIGN_STORE_PASSWORD` | 密钥库密码 |
| `SIGN_KEY_PASSWORD` | 密钥密码 |

证书与 Profile 来源：登录 [AGC](https://developer.huawei.com/consumer/console/) → 证书 /
APP ID / Profile，生成 release 证书与 release Profile（关联包名
`com.mikannqaq.obsidian`）。未配置 Secrets 时 CI 产出 **unsigned HAP** 并在日志说明；
此时需要引导用户走方案 B/C。

## 4. 校验哈希

Release 附件的 `SHA256SUMS.txt` / `MD5SUMS.txt` 与 HAP 同时生成。产物命名：

```text
OHSidian-v<版本>-<图标>-icon-<signed|unsigned>.hap
# 例：OHSidian-v2.0.0-obsidian-icon-unsigned.hap
```

图标段 `ohsidian` / `obsidian` 对应两种桌面图标变体。校验：

```bash
# Linux / macOS
sha256sum -c SHA256SUMS.txt
md5sum -c MD5SUMS.txt
```

```powershell
# Windows PowerShell
Get-FileHash .\OHSidian-v2.0.0-*-icon-unsigned.hap -Algorithm SHA256
Get-FileHash .\OHSidian-v2.0.0-*-icon-unsigned.hap -Algorithm MD5
```

## 5. 发布操作顺序

1. 完成第 1 节清单，提交并推送 `main`；
2. 确认 `build-release` 的 `workflow_dispatch` 能跑通（不创建 Release，只产 artifact）；
3. 打 tag 并推送：

   ```bash
   git tag -a v2.0.0 -m "OHSidian 2.0.0（手写线首个正式版）"
   git push origin v2.0.0
   ```

   **tag 就是版本号**：CI 以 tag 为准，自动把 `versionName`/`versionCode` 写入
   `app.json5` 再构建；`app.json5` 的值只是无 tag 手动构建时的回退。
4. Actions 构建完成后检查 Release 附件：两个图标各一个 HAP + 两个哈希文件 + 图标预览；
5. 下载其中一个 HAP，核对 `SHA256SUMS.txt`，安装并做一次冷启动冒烟；
6. Release 正文由 `scripts/ci/release-notes-template.md` 渲染（`{{HAP_TABLE}}` /
   `{{SHA256}}` / `{{MD5}}` / `{{VERSION}}` 自动填充）；单次发布的已知问题可在页面上
   手动补充。

## 6. 常见问题

- **CI 报 403/404 下载 command-line-tools**：直链过期，更新 `HARMONYOS_CLI_URL`。
- **HAP 装到 6.0.2 设备提示版本不兼容**：检查 CI 日志里的 `compatibleSdkVersion` 是否
  被改成了 24；应为 `6.0.2(22)`，HAP `minAPIVersion=60002022`。
- **Release 里 HAP 是 unsigned**：未配置签名 Secrets，属预期；按第 3 节方案 B 引导用户。
- **手写 gate 失败**：先确认设备装的是 agent 包（`--mode doctor` 看 `boot.rev`），
  再检查对应场景的探针；不要在 gate 未过时发版。
- **构建成功但启动闪退**：确认 `buildMode` 为 `release` 时 ArkGuard 仍关闭；本仓库
  已在构建配置中关闭混淆，若手动改动过请恢复。
