<p align="center">
  <img src="AppScope/resources/base/media/startIcon.png" alt="OHsidian Logo" width="120" />
</p>

<h1 align="center">OHsidian</h1>

<p align="center">
  <strong>Obsidian for HarmonyOS</strong>
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  Run real Obsidian on HarmonyOS tablets and 2-in-1 PCs, with multi-window support and native system integration.<br>
  Tablets and 2-in-1 PCs only; phones are not supported.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/HarmonyOS-6.1.1%2824%29-blue?logo=harmonyos" alt="HarmonyOS" />
  <img src="https://img.shields.io/badge/Obsidian-1.13.7-purple?logo=obsidian" alt="Obsidian" />
  <img src="https://img.shields.io/badge/license-BSD%203--Clause-green" alt="License" />
</p>

---

## Introduction

OHsidian is an unofficial port of Obsidian to HarmonyOS. It does not reimplement Obsidian: an ArkTS adapter layer plus a C++ native library wrap HarmonyOS APIs in an Electron-compatible surface, and the official `obsidian.asar` runs on top of it (a few compatibility patches are injected at build time).

This repository is a fork of [HanversionOvO/OHSidian][upstream]. It removes Huawei cloud sync, Huawei account login and AGC initialization, and fixes window layout, touch input, drag-and-drop/share, and deletion safety.

`com.mikannqaq.obsidian` · 1.4.1 (versionCode 1040001) · HarmonyOS 6.1.1 (API 24) · tablets / 2-in-1

## Features

- **Real Obsidian core**: the full editing experience, with community plugins, themes, Markdown preview, graph view and backlinks.
- **Multi-window**: main, sub, embedded and floating windows, with position and size persisted.
- **Tablet-ready**: touch mode follows the system, keyboard avoidance, free windows clamped to the screen.
- **External content**: drag-and-drop insertion, automatic retrieval of files from other apps, and Share Kit targets that land in the focused note.
- **Safer deletes**: deleted notes go to `Documents/OHSidianTrash/`, auto-cleaned after 30 days and restorable from the file manager.
- **Deep links**: `obsidian://` works, so browser OAuth in plugins such as Remotely Save works too.

## Build

Requires DevEco Studio 5.0+, HarmonyOS SDK API 24, and Node.js 18+.

```bash
git clone https://github.com/PCFXPCFX/OHSidian.git
cd OHSidian

# obsidian.asar is not committed; the first build downloads and verifies it (~27 MB, one time)
hvigorw install
hvigorw assembleHap
# Output: build/outputs/default/electron-default-signed.hap
```

You can also open the project in DevEco Studio and run **Build > Build HAP(s)**. Signing is configured in `build-profile.json5`; see `build-profile.example.json5`.

## Documentation

- [Tablet feature demo][tablet-demo] (Chinese)
- [Architecture and project layout][architecture] (Chinese)
- [Feature details and fork changes][features] (Chinese)
- [Release and checksums][release] (Chinese)
- [Development environment setup][dev-env] (Chinese)

## License

The source code is released under BSD 3-Clause; see [LICENSE][license-file]. Obsidian itself (`obsidian.asar`) is proprietary software and is not covered by this license.

## Acknowledgments

[Obsidian][obsidian], [Electron][electron], [HarmonyOS][harmonyos], [InversifyJS][inversify].

---

<p align="center">
  <sub>OHsidian is a community project, not affiliated with Obsidian.</sub>
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
