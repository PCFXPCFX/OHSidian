OHSidian 是 [Obsidian](https://obsidian.md) 的非官方 HarmonyOS 移植版：在 HarmonyOS 手机 / 平板上直接运行原版 Obsidian。

> 目标系统：HarmonyOS NEXT / HarmonyOS 6（API 24 真机验证）。遇到问题欢迎提 [Issue](https://github.com/PCFXPCFX/OHSidian/issues)。

## 下载

{{HAP_TABLE}}

## 安装与签名

HAP **未签名**，不能直接安装到设备。推荐使用图形化工具完成签名安装：

1. **小白调试助手**（原名 Auto-Installer）—— 基于 OpenHarmony HDC 工具的
   Flutter 图形化安装器：<https://github.com/likuai2010/auto-installer>
2. **HoKit** —— 一站式 Harmony NEXT 应用开发辅助工具，支持应用解析、
   重签名与一键安装：<https://github.com/yabi-zzh/HoKit>

也可以用 DevEco Studio 手动签名后安装，步骤见仓库
[docs/RELEASE.md](https://github.com/PCFXPCFX/OHSidian/blob/main/docs/RELEASE.md)。

## 校验值（OHSidian v{{VERSION}}）

下载后建议先校验文件完整性：

- Linux / macOS / Git Bash：`sha256sum -c SHA256SUMS.txt`
- Windows PowerShell：`Get-FileHash .\OHSidian-v{{VERSION}}-unsigned.hap -Algorithm SHA256`

SHA-256:

```
{{SHA256}}
```

MD5:

```
{{MD5}}
```
