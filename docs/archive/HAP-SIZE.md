# HAP 体积与压缩（归档）

> 历史发布工程的记录，2026-10 实测。当前构建沿用 `ohos.pack.compressLevel = standard`。

## 根因

`app_packing_tool` 在 `module.compressNativeLibs` 为 `false`（SDK 默认）时，
**整个 HAP 一律按 STORED 写**（zip 不压缩）。所以 222 MB 里 99.5% 是载荷本身，
不是签名/对齐开销。

## 开关

`hvigor/hvigor-config.json5`：

```json5
"properties": {
  "ohos.pack.compressLevel": "standard"   // fast=1 / standard=5 / ultimate=9
}
```

hvigor 看到该属性后会：① 在打包用的 `module.json` 里写入
`"compressNativeLibs": true`；② 给打包工具追加 `--compress-level 1|5|9`
（只在模块存在 `libs/` 目录时追加；`electron/libs` 存在）。

## 实测（debug，同一份代码）

| 指标 | 未开启 | `standard` |
|---|---|---|
| HAP（signed） | 222,004,002 B | **120,534,845 B（−45.7%）** |
| zip 载荷合计 | 220.6 MB | 114.9 MB |
| `libelectron.so` | 153.28 MiB | 61.49 MiB（40.1%） |
| `libffmpeg.so` | 2.08 MiB | 0.94 MiB（45.3%） |
| PackageHap 耗时 | 1.1 s | 8.3 s |
| 整体构建耗时 | ~19 s | ~34 s |

**这个开关只压缩 `libs/**.so`。** 其余条目（`obsidian.asar` 24.75 MB、`icudtl.dat`
9.98 MB、`resources.pak` 5.51 MB、PNG、`ets/modules.abc`、`sourceMaps.map`、locales）
仍是 STORED，打包工具没有“压缩非 so 条目”的开关。

## 代价

`.so` 不再能从 HAP 直接映射，改为安装时解压（`extractNativeLibs` 默认 true），
安装变慢、设备上出现“HAP + 解压副本”双份占用（总量仍小于未压缩包）。

必须真机验证冷启动、视频播放、多窗口，以及引擎侧 `dlopen` 是否正常。

## 检查条目是否真的被压缩

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead('electron\build\default\outputs\default\electron-default-signed.hap')
$z.Entries | Where-Object { $_.FullName -like 'libs/*' } |
  Select-Object FullName, Length, CompressedLength   # 两列相等 = STORED（没压）
$z.Dispose()
```

## 未做的瘦身候选

| 改动 | 收益（原始） | 风险 |
|---|---|---|
| 删 3 个未被引用的相同 PNG | 4.8 MB | 低 |
| `obsidian.asar` 以 `.gz` 入包、首启解压 | ~16 MB | 中（加载路径 + 首启耗时） |
| i18n 只留 zh/zh-TW/en-GB | 4.5 MB | 中（需测非中英系统语言） |
| `startIcon.png`/`tray.png` 降尺寸 | 1.9 MB | 低 |
| release 构建不打包 `sourceMaps.map` | 0.77 MB | 低 |
