OHSidian 是 [Obsidian](https://obsidian.md) 的非官方 HarmonyOS 移植版：在 HarmonyOS **平板 / 2in1 电脑**上直接运行原版 Obsidian。仅支持平板与 2in1 电脑，暂不支持手机。

> 目标系统：HarmonyOS 6.0.2 起（compatible API 22 / target API 24，真机验证）。遇到问题欢迎提 [Issue](https://github.com/PCFXPCFX/OHSidian/issues)。

## 本版修复（2.0.1）

- **触屏模式下依赖 Node 模块的插件不再"加载失败"**。内核只允许插件 `require` 白名单内的模块（`obsidian` + CodeMirror/Lezer），
  其余在"模拟移动端"时返回 `null`；本移植的触屏模式正是靠模拟移动端实现，而渲染层其实有完整 Node，
  于是插件一 `require("fs"/"path"/"electron")` 就报错。现已改为始终走真实 `require`。
- 由此**触屏模式与桌面窗口模式的插件加载语义一致**，不会再"一动模式插件全变"；设置页里懒加载 Node 的插件也不再空白。
- **手写笔**：绘图工具激活时，笔尖点在界面上会提示"笔尖只画不点界面，请用手指或切回「指针」"（拦笔行为不变）。
- 完整清单见 [docs/CHANGELOG.md](https://github.com/PCFXPCFX/OHSidian/blob/main/docs/CHANGELOG.md)。

**仍存在的插件失败面（与 2.0.1 无关，属内核策略）**：内核硬拒载名单（`settings-search`、旧版 `cmdr` / `obsidian-image-toolkit`、
`better-pdf-plugin` 1.4.0）、deprecated 版本表、真正只支持移动端的插件、以及依赖原生模块或未实现 Electron API 的插件。

**已知问题**：关闭应用前刚改过文件名、且此后再未书写时，最后一笔仍可能在退出时丢失（下一版补 `beforeunload` 兜底）；
同一 PDF 在第二个窗口打开时，"恢复原始 PDF"只对执行恢复的窗口立即生效，另一窗口重开该文档后同步。

## 下载

{{HAP_TABLE}}

同一版本提供两种桌面图标（下载表第一列即为图标预览）：**OHsidian 图标版**（本移植版专属）与
**Obsidian 官方图标版**，功能完全一致，按桌面图标喜好选择下载。
文件名中也带有图标标识，如 `OHSidian-v{{VERSION}}-obsidian-icon-unsigned.hap`
为 Obsidian 官方图标版。两个包签名后任选其一安装；换装另一版本时请先卸载
（或使用同一签名直接覆盖）。

## 安装与签名

HAP 是否可直接安装取决于文件名：含 `unsigned` 的需要先签名，含 `signed` 的已由项目证书签名。推荐使用图形化工具完成签名安装：

1. **小白调试助手**（原名 Auto-Installer）—— 基于 OpenHarmony HDC 工具的
   Flutter 图形化安装器：<https://github.com/likuai2010/auto-installer>
2. **HoKit** —— 一站式 Harmony NEXT 应用开发辅助工具，支持应用解析、
   重签名与一键安装：<https://github.com/yabi-zzh/HoKit>

也可以用 DevEco Studio 手动签名后安装，步骤见仓库
[docs/RELEASE.md](https://github.com/PCFXPCFX/OHSidian/blob/main/docs/RELEASE.md)。

## 校验值（OHSidian v{{VERSION}}）

下载后建议先校验文件完整性：

- Linux / macOS / Git Bash：`sha256sum -c SHA256SUMS.txt`
- Windows PowerShell：`Get-FileHash .\OHSidian-v{{VERSION}}-*-icon-unsigned.hap -Algorithm SHA256`

SHA-256:

```
{{SHA256}}
```

MD5:

```
{{MD5}}
```
