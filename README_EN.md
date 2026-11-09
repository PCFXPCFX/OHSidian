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
  Run official Obsidian on HarmonyOS tablets and 2-in-1 PCs, with multi-window support, native system integration and Huawei M-Pencil handwriting.<br>
  Tablets and 2-in-1 PCs only; phones are not supported.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/HarmonyOS-6.0.2%2B-blue?logo=harmonyos" alt="HarmonyOS" />
  <img src="https://img.shields.io/badge/Obsidian-1.13.7-purple?logo=obsidian" alt="Obsidian" />
  <img src="https://img.shields.io/badge/license-BSD%203--Clause-green" alt="License" />
</p>

---

## Introduction

OHsidian is an unofficial port of Obsidian to HarmonyOS. It does not reimplement Obsidian: an ArkTS adapter layer plus a C++ native library wrap HarmonyOS APIs in an Electron-compatible surface, and the official `obsidian.asar` runs on top of it (compatibility patches are injected at build time).

This project is based on [HanversionOvO/OHSidian][upstream] (by MikannQAQ): Huawei Cloud Sync, Huawei account sign-in and AGC initialization have been removed, and issues with window layout, touch input, drag and drop, sharing, and deletion safety have been fixed.

HarmonyOS 6.0.2+ (compatible API 22 / target API 24) · tablets / 2-in-1

## Features

- **Stylus**: Huawei M-Pencil pressure ink, hold-to-straighten, one-stroke shapes (square/circle), lasso move/copy, point prediction, barrel double-tap/squeeze; works on notes, PDF, embedded PDF and Canvas; PDF annotations are written back as real annotations. See the [stylus documentation][stylus] (Chinese).
- **Real Obsidian core**: the full editing experience, with community plugins, themes, Markdown preview, graph view and backlinks.
- **Multi-window**: main, sub, embedded and floating windows, with position and size persisted.
- **Tablet-ready**: touch/desktop layout follows the system, keyboard avoidance, free windows clamped to the screen.
- **External content**: drag-and-drop insertion, automatic retrieval of files from other apps, and Share Kit targets that land in the focused note.
- **Safer deletes**: deleted notes go to `Documents/OHSidianTrash/`, auto-cleaned after 30 days and restorable from the file manager.
- **Deep links**: `obsidian://` works, so browser OAuth in plugins such as Remotely Save works too.

> Stylus mode is off by default: **Settings → Stylus → Stylus mode**. PDF write-back runs when leaving the PDF and backs up the original file before the first write.

## Build

Requires DevEco Studio 5.0+, HarmonyOS SDK API 24, and Node.js 18+.

```bash
git clone https://github.com/PCFXPCFX/OHSidian.git
cd OHSidian

# obsidian.asar is not committed; the first build downloads, verifies and patches it (~27 MB, one time)
hvigorw assembleHap --mode module -p product=default

# Output: electron/build/default/outputs/default/*.hap
```

You can also open the project in DevEco Studio and run **Build > Build HAP(s)**. Signing is configured in `build-profile.json5`; see `build-profile.example.json5`. The release build, signing, checksums and tag flow are documented in [docs/RELEASE.md](docs/RELEASE.md) (Chinese).

## Documentation

Full index: [docs/README.md](docs/README.md) (Chinese).

- [Features and differences from official Obsidian][features] (Chinese)
- [Stylus design and regression harness][stylus] (Chinese)
- [Release, signing and checksums][release] (Chinese)
- [Architecture][architecture] (Chinese)
- [Development environment][dev-env] (Chinese)
- [Tablet feature demo][tablet-demo] (Chinese)
- [Changelog][changelog] (Chinese)

## License

The source code is released under BSD 3-Clause; see [LICENSE][license-file]. Obsidian itself (`obsidian.asar`) is proprietary software and is not covered by this license.

## Acknowledgments

[Obsidian][obsidian], [Electron][electron], [HarmonyOS][harmonyos], [InversifyJS][inversify], and HanversionOvO (MikannQAQ), the original OHsidian porter.

---

<p align="center">
  <sub>OHsidian is a community project, not affiliated with Obsidian.</sub>
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
