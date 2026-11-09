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
  在 HarmonyOS 平板与 2in1 电脑上运行官方 Obsidian，支持多窗口、系统级适配与华为 M-Pencil 手写。<br>
  仅支持平板与 2in1，暂不支持手机。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/HarmonyOS-6.0.2%2B-blue?logo=harmonyos" alt="HarmonyOS" />
  <img src="https://img.shields.io/badge/Obsidian-1.13.7-purple?logo=obsidian" alt="Obsidian" />
  <img src="https://img.shields.io/badge/version-2.0.0-orange" alt="Version" />
  <img src="https://img.shields.io/badge/license-BSD%203--Clause-green" alt="License" />
</p>

---

## 简介

OHsidian 是 Obsidian 在 HarmonyOS 上的非官方移植。它不重写 Obsidian：ArkTS 适配层加 C++ 原生库把 HarmonyOS 能力包装成 Electron 兼容接口，直接运行官方 `obsidian.asar`（构建时注入兼容补丁）。

本项目基于 [HanversionOvO/OHSidian][upstream]（作者 MikannQAQ）移除了华为云同步、华为账号登录与 AGC 初始化，并修复了窗口布局、触摸输入、拖拽与分享、删除安全等问题。

`com.mikannqaq.obsidian` · **2.0.0**（versionCode 2000000）· HarmonyOS 6.0.2 起（compatible API 22 / target API 24）· 平板 / 2in1

## 主要特性

- **手写笔**：华为 M-Pencil 压力墨迹、长按拉直、一笔成形（方形/圆形）、套索移动/复制、点预测、笔杆双击/轻捏；笔记、PDF、内嵌 PDF 与 Canvas 均可书写；PDF 标注可写回真实注释。见[手写笔文档][stylus]。
- **原版内核**：完整 Obsidian 编辑体验，兼容社区插件与主题、Markdown 预览、图谱与反向链接。
- **多窗口**：主窗口、子窗口、嵌入窗口与浮动窗口，位置与大小持久化。
- **平板适配**：触摸/桌面布局跟随系统、键盘避让、自由窗口钳制到屏幕内。
- **外部内容**：拖入即插入、跨应用文件自动取回、系统分享直达当前笔记。
- **删除更安全**：删除的笔记进 `文档/OHSidianTrash/`，30 天后自动清理，可在文件管理恢复。
- **深链**：支持 `obsidian://`，Remotely Save 等插件可完成浏览器 OAuth 登录。

> 手写笔模式默认关闭：**设置 → 手写笔 → 手写笔模式**。PDF 写回默认在离开 PDF 时执行，首次写入前自动备份原文件。

## 构建

需要 DevEco Studio 5.0+、HarmonyOS SDK API 24、Node.js 18+。

```bash
git clone https://github.com/PCFXPCFX/OHSidian.git
cd OHSidian

# obsidian.asar 不入库，首次构建自动下载、校验并注入补丁（约 27 MB，仅一次）
hvigorw assembleHap --mode module -p product=default

# 产物：electron/build/default/outputs/default/*.hap
```

也可以用 DevEco Studio 打开项目执行 **Build > Build HAP(s)**。签名在 `build-profile.json5` 中配置，参考 `build-profile.example.json5`；发布包的构建、签名、校验与 tag 流程见[发布文档][release]。

## 文档

完整索引见 [docs/README.md](docs/README.md)。

- [功能与相对原版的差异][features]
- [手写笔方案与回归评测][stylus]
- [发布流程、签名与校验][release]
- [技术架构][architecture]
- [开发环境搭建][dev-env]
- [平板功能演示][tablet-demo]
- [版本记录][changelog]

## 许可

源码以 BSD 3-Clause 发布，见 [LICENSE][license-file]。Obsidian 本体（`obsidian.asar`）为专有软件，不在本许可范围内。

## 致谢

[Obsidian][obsidian]、[Electron][electron]、[HarmonyOS][harmonyos]、[InversifyJS][inversify]，以及 OHsidian 原始移植作者 HanversionOvO（MikannQAQ）。

---

<p align="center">
  <sub>OHsidian 是一个社区项目，与 Obsidian 官方无关。</sub>
</p>

[upstream]: https://github.com/HanversionOvO/OHSidian
[tablet-demo]: docs/tablet-demo.md
[architecture]: docs/ARCHITECTURE.md
[features]: docs/FEATURES.md
[stylus]: docs/STYLUS.md
[release]: docs/RELEASE.md
[dev-env]: docs/DEV-ENV-SETUP.md
[changelog]: docs/CHANGELOG.md
[license-file]: LICENSE
[obsidian]: https://obsidian.md
[electron]: https://www.electronjs.org
[harmonyos]: https://developer.huawei.com/consumer/cn/harmonyos/
[inversify]: https://inversify.io
