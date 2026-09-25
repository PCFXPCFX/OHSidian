# 发布流程(HAP 构建 / 校验 / 签名 / Release)

## 一、CI 如何工作

`.github/workflows/build-release.yml` 在 **推送 `v*` 标签** 或 **手动触发** 时:

1. Checkout(含 LFS:`libelectron.so`、`obsidian.asar` 等大文件);
2. 下载官方 **HarmonyOS command-line-tools**(内含 hvigor、ohpm 与 HarmonyOS SDK);
3. 从 `build-profile.example.json5` 生成 CI 专用 `build-profile.json5`
   (`compatibleSdkVersion: 6.0.2(22)`,`targetSdkVersion: 6.1.1(24)`,
   与真机验证过的组合一致;签名配置按需注入);
4. `hvigorw assembleHap` 构建;
5. 产出 `*.hap` + `SHA256SUMS.txt` + `MD5SUMS.txt`;
6. 标签推送时自动创建 GitHub Release 并附上上述文件;手动触发时作为
   workflow artifact 供下载。

### 必须配置一次:command-line-tools 下载地址

在仓库 **Settings → Secrets and variables → Actions → Variables** 新建
变量 `HARMONYOS_CLI_URL`,值为 **linux 版 Command Line Tools 的下载直链**。

获取步骤:
1. 打开 <https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos>;
2. 找到 **Command Line Tools** 的 **Linux X64** 包(文件名形如
   `command-line-tools-linux-x64-6.1.x.xxx.tar.gz`);
3. 右键复制其下载直链(注意选 **linux** 平台,不是 windows/mac);
4. 粘贴到 `HARMONYOS_CLI_URL`。

注意:
- 包格式为 **.tar.gz**(工作流已自动识别 tar.gz/zip 两种格式);
- 华为 CDN 直链**有时效性**,若 CI 报下载 403/404,回到下载页复制
  最新直链更新该变量即可(版本至少需 6.1.x,内置 API 24 SDK);
- 若官网下载需要登录,可改用社区镜像
  <https://huggingface.co/csukuangfj/harmonyos-commandline-tools>
  中对应 linux 包的直链;
- 不配置该变量时工作流会告警并跳过构建。
手动触发时也可以在输入框临时填 URL。

## 二、签名(决定别人能不能直接安装)

HarmonyOS NEXT 之后的 HAP **必须签名才能安装**,签名证书与开发者账号绑定。

| 方案 | 配置 | 适用 |
|---|---|---|
| A. CI 内置签名(推荐) | 配置下述 6 个 Secrets | Release 里的 HAP 开箱即装 |
| B. 用户自行签名 | 无需配置 | 用户用图形化工具或 DevEco Studio 签名后安装 |
| C. 用户自己编译 | 无需配置 | 开发者/贡献者 |

**方案 B 推荐的图形化工具**(写给使用者,Release 页也附同样说明):

- [小白调试助手](https://github.com/likuai2010/auto-installer)(原名
  Auto-Installer):基于 OpenHarmony HDC 工具的 Flutter 重构项目,图形化
  安装/调试 HAP;
- [HoKit](https://github.com/yabi-zzh/HoKit):一站式 Harmony NEXT 应用
  开发辅助工具,支持应用解析、重签名与一键安装。

**方案 A 需要的 Secrets**(Base64 用 `base64 -w0 文件` 生成):

| Secret | 内容 |
|---|---|
| `SIGN_STORE_P12` | 签名密钥库 `.p12`(Base64) |
| `SIGN_CERT_CER` | 证书 `.cer`(Base64) |
| `SIGN_PROFILE_P7B` | Profile `.p7b`(Base64) |
| `SIGN_KEY_ALIAS` | 密钥别名 |
| `SIGN_STORE_PASSWORD` | 密钥库密码 |
| `SIGN_KEY_PASSWORD` | 密钥密码 |

证书与 Profile 来源:登录 [AGC](https://developer.huawei.com/consumer/console/) →
证书/APP ID/Profile 页签,生成 release 证书与 release Profile(注意
release Profile 要关联本应用的包名 `com.mikannqaq.obsidian`)。
未配置 Secrets 时,CI 产出 **unsigned HAP** 并在日志中说明。

> 注意:未签名/调试签名 HAP 的分发受华为签名体系限制;release 证书签名
> 的 HAP 才能被其他用户直接安装。若暂时没有 release 证书,先发 unsigned
> 包并引导用户走方案 B/C。

## 三、校验哈希

Release 附件里的 `SHA256SUMS.txt` / `MD5SUMS.txt` 与 HAP 同时生成
(产物命名为 `OHSidian-v<版本>-unsigned.hap`),哈希值同时写进 Release
正文,可直接比对:

```bash
# Linux / macOS
sha256sum -c SHA256SUMS.txt
md5sum -c MD5SUMS.txt
# Windows PowerShell
Get-FileHash .\OHSidian-v1.2.0-unsigned.hap -Algorithm SHA256
Get-FileHash .\OHSidian-v1.2.0-unsigned.hap -Algorithm MD5
```

## 四、发布操作顺序

1. 本地按 `docs/CHANGES-2026-09.md` 的提交计划完成 commit
   (可用 `bash scripts/make-commits.sh` 分批执行);
2. `git push origin main`(或当前分支);
3. 确认 GitHub Actions 里的 `build-release`(workflow_dispatch)能跑通;
4. 把 `AppScope/app.json5` 的 `versionName`/`versionCode` 提到目标版本,
   然后 `git tag v1.2.0 && git push origin v1.2.0`(tag 名与 versionName 对齐);
5. Actions 自动构建并创建 Release,检查附件(hap + 两个哈希文件);
6. Release 正文由 `scripts/ci/release-notes-template.md` 渲染生成
   (想改文案直接编辑该模板,`{{HAP_TABLE}}`/`{{SHA256}}`/`{{MD5}}`/
   `{{VERSION}}` 为自动填充的占位符);如需补充单次发布的已知问题等,
   在 Release 页面上手动编辑即可。
