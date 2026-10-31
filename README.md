<p align="center">
  <img src="AppScope/resources/base/media/startIcon.png" alt="OHsidian Logo" width="120" />
</p>

<h1 align="center">OHsidian</h1>

<p align="center">
  <strong>Obsidian for HarmonyOS</strong>
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="README_EN.md">English</a>
</p>

<p align="center">
  在 HarmonyOS 平板与 2in1 电脑上运行真正的 Obsidian，支持多窗口与系统级原生适配。<br>
  仅支持平板与 2in1，暂不支持手机。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/HarmonyOS-6.1.1%2824%29-blue?logo=harmonyos" alt="HarmonyOS" />
  <img src="https://img.shields.io/badge/Obsidian-1.13.7-purple?logo=obsidian" alt="Obsidian" />
  <img src="https://img.shields.io/badge/license-BSD%203--Clause-green" alt="License" />
</p>

---

## 简介

OHsidian 是 Obsidian 在 HarmonyOS 上的非官方移植。它不重写 Obsidian，而是用 ArkTS 适配层加 C++ 原生库把 HarmonyOS 的能力包装成 Electron 兼容接口，直接运行官方 `obsidian.asar`（构建时注入少量兼容补丁）。

本项目基于 [HanversionOvO/OHSidian][upstream] 移除了华为云同步、华为账号登录与 AGC 初始化，并修复了窗口布局、触摸输入、拖拽与分享、删除安全等问题。

`com.mikannqaq.obsidian` · 1.4.2（versionCode 1040002）· HarmonyOS 6.0.2 起（compatible API 22 / target API 24）· 平板 / 2in1

## 主要特性

- **原版内核**：完整 Obsidian 编辑体验，兼容社区插件与主题、Markdown 预览、图谱与反向链接。
- **多窗口**：主窗口、子窗口、嵌入窗口与浮动窗口，位置与大小持久化。
- **平板适配**：触摸模式跟随系统切换、键盘避让、自由窗口自动钳制到屏幕内。
- **外部内容**：拖入即插入、跨应用文件自动取回、系统分享（Share Kit）直达当前笔记。
- **删除更安全**：删除的笔记进 `文档/OHSidianTrash/`，30 天后自动清理，可随时在文件管理中恢复。
- **深链**：支持 `obsidian://`，Remotely Save 等插件可完成浏览器 OAuth 登录。

## 构建

需要 DevEco Studio 5.0+、HarmonyOS SDK API 24、Node.js 18+。

```bash
git clone https://github.com/PCFXPCFX/OHSidian.git
cd OHSidian

# obsidian.asar 不入库，首次构建自动下载并校验（约 27 MB，仅一次）
hvigorw install
hvigorw assembleHap
# 产物：build/outputs/default/electron-default-signed.hap
```

也可以直接用 DevEco Studio 打开项目，执行 **Build > Build HAP(s)**。签名在 `build-profile.json5` 中配置，可参考 `build-profile.example.json5`。

## 文档

- [平板功能演示][tablet-demo]
- [技术架构与目录结构][architecture]
- [功能细节与 Fork 改动][features]
- [发布与校验值][release]
- [开发环境搭建][dev-env]

## 许可

源码以 BSD 3-Clause 发布，见 [LICENSE][license-file]。Obsidian 本体（`obsidian.asar`）为专有软件，不在本许可范围内。

## 致谢

[Obsidian][obsidian]、[Electron][electron]、[HarmonyOS][harmonyos]、[InversifyJS][inversify]。

---

<p align="center">
  <sub>OHsidian 是一个社区项目，与 Obsidian 官方无关。</sub>
</p>

[upstream]: https://github.com/HanversionOvO/OHSidian
[tablet-demo]: docs/tablet-demo.md
[architecture]: docs/ARCHITECTURE.md
[features]: docs/FEATURES.md
[release]: docs/RELEASE.md
[dev-env]: docs/DEV-ENV-SETUP.md
[license-file]: LICENSE
[obsidian]: https://obsidian.md
[electron]: https://www.electronjs.org
[harmonyos]: https://developer.huawei.com/consumer/cn/harmonyos/
[inversify]: https://inversify.io
