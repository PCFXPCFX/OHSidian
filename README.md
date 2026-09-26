<p align="center">
  <img src="AppScope/resources/base/media/startIcon.png" alt="OHsidian Logo" width="120" />
</p>

<h1 align="center">OHsidian</h1>

<p align="center">
  <strong>Obsidian for HarmonyOS</strong>
</p>

<p align="center">
  在 HarmonyOS 设备上运行你熟悉的 Obsidian 笔记体验 —— 支持多窗口、华为账号一键登录以及完整的系统级原生适配。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/HarmonyOS-6.0.2%2822%29-blue?logo=harmonyos" alt="HarmonyOS" />
  <img src="https://img.shields.io/badge/Obsidian-1.13.7-purple?logo=obsidian" alt="Obsidian" />
  <img src="https://img.shields.io/badge/ArkTS-API%2022-orange" alt="ArkTS" />
  <img src="https://img.shields.io/badge/license-BSD%203--Clause-green" alt="License" />
</p>

---

## 目录

- [项目简介](#项目简介)
- [本 Fork 相对原版的改进](#本-fork-相对原版的改进)
- [技术架构](#技术架构)
- [功能特性](#功能特性)
- [模块结构](#模块结构)
- [适配层](#适配层)
- [构建与运行](#构建与运行)
- [项目结构](#项目结构)
- [依赖说明](#依赖说明)
- [许可协议](#许可协议)
- [致谢](#致谢)

---

## 项目简介

**OHsidian** 是 Obsidian 笔记应用在 HarmonyOS（鸿蒙）平台上的非官方移植项目。它并非重新实现 Obsidian，而是通过构建一个完整的 Electron 兼容层，将原版 Obsidian（`obsidian.asar`）运行在 HarmonyOS 原生运行时之上。

核心思路是：**用 HarmonyOS 原生能力模拟 Electron API 表面**，通过 C++ 原生库（`libadapter.so`）+ ArkTS 适配层 + JSBind 桥接，让 Obsidian 的 Node.js/Electron 运行时在 HarmonyOS 上正常运转。同时，项目深度集成了华为生态能力 —— 账号 Kit、云存储 Kit、状态栏扩展等，让体验更像原生应用。

| 项目信息 | |
|---------|------|
| 应用 ID | `com.mikannqaq.obsidian` |
| 版本号 | 1.0.0（versionCode: 1000000） |
| 目标 SDK | HarmonyOS 6.1.1(24) / API 24(CI 构建组合;兼容 6.0.2(22)) |
| 目标设备 | 2in1（折叠屏/平板）、平板 |
| 开发语言 | ArkTS (TypeScript) |
| 构建系统 | Hvigor |
| 内核版本 | Obsidian 1.13.7 |

---

## 本 Fork 相对原版的改进

本 Fork([PCFXPCFX/OHSidian](https://github.com/PCFXPCFX/OHSidian))基于
原版([HanversionOvO/OHSidian](https://github.com/HanversionOvO/OHSidian),
作者 Mikann/MikannQAQ)构建,在其 Electron 兼容层之上做了大量窗口、
输入、数据与工程化修复。完整变更记录见
[docs/CHANGES-2026-09.md](docs/CHANGES-2026-09.md)(45 轮,含逐轮审计)。

### 窗口与显示

- 按官方沉浸式规范重做窗口链路:layout fullscreen + 真实系统条 insets,
  触摸模式状态栏/导航条正确避让;修复启动铺不满、底部死区;
- 引擎只读一次 surface 尺寸:增加几何稳定门控与首启强制整屏,
  修复首次进入视口超宽、控件超出屏幕;
- 多窗口(自由窗口):系统标题条 + 内容避让,消除双关闭按钮与白条;
  恢复矩形超出屏幕时自动钳制到 80% 居中;
- 触摸/多窗口模式跟随系统 PC 模式开关自动切换。

### 输入与首次启动

- 修复触摸模式下仓库切换/管理(绕过引擎有缺陷的原生下拉弹窗);
- 发布输入法高度(--keyboard-height),移动格式化工具栏(加粗等)
  正确悬浮在键盘上方;
- 修复快速开始 "folder not found"(默认仓库重定向到可写目录)。

### 数据安全与耗电

- 应用内删除强制进入仓库 `.trash` 文件夹(引擎回收站桥在鸿蒙上
  行为不可控,可能永久删除);
- 命令面板新增 "迁移仓库到文件管理可见的位置":把仓库(含 .trash)
  复制到系统文件夹选择器授权的目录,文件管理器/电脑可直接访问
  (沙箱目录本身无法暴露,这是鸿蒙约束);
- 自动更新彻底关闭(鸿蒙分发走本仓库 Release);
- 移除无效的云同步轮询、GNSS 单订阅共享、亮屏锁前台守卫、
  日志截断——更省电。

### 深链与工程化

- `obsidian://` 深链桥接:Remotely Save 等插件的浏览器 OAuth 登录可用;
- GitHub Actions 全自动构建:Release 附 SHA-256/MD5,可选签名、
  同版双图标发布(OHsidian 图标 / Obsidian 官方图标)与可选变体、
  SDK 组合与构建模式;
- **关闭 release 构建的 ArkGuard 混淆**——原版以 release 模式构建会
  因混淆在启动时闪退,这是本 Fork 能正常分发的关键修复。

---

## 技术架构

```
┌──────────────────────────────────────────────────────┐
│                     Obsidian 1.13.7                   │
│                   (obsidian.asar)                     │
├──────────────────────────────────────────────────────┤
│               Electron API Compatibility              │
│    ┌──────────────┐  ┌──────────────┐                │
│    │  @electron/   │  │   Node.js    │                │
│    │    remote     │  │   Runtime    │                │
│    └──────┬───────┘  └──────┬───────┘                │
├──────────┼──────────────────┼────────────────────────┤
│          │     JSBind 桥接层  │                        │
│          ▼                  ▼                        │
│  ┌──────────────────────────────────────┐            │
│  │           C++ libadapter.so           │            │
│  └──────────────────────────────────────┘            │
├──────────────────────────────────────────────────────┤
│               ArkTS 适配层 (~50 Adapters)              │
│  CloudSync │ FileSys │ Notify │ IME │ Theme │ ...    │
├──────────────────────────────────────────────────────┤
│              HarmonyOS Native Runtime                 │
│   Ability │ ArkUI │ AccountKit │ CloudFoundation     │
└──────────────────────────────────────────────────────┘
```

**分层说明：**

- **Obsidian 层** —— 原版 `obsidian.asar`，未经修改的 Obsidian 1.13.7 应用代码
- **Electron 兼容层** —— `@electron/remote` 提供 remote 模块 API，`main.js` 负责加载 asar 和更新管理
- **JSBind 桥接层** —— 连接 JS 运行时与 ArkTS 原生层，将 Electron API 调用转发到对应适配器
- **C++ 原生库** —— `libadapter.so` 提供核心系统级 API 对接
- **ArkTS 适配层** —— 约 50 个适配器，将 HarmonyOS API 包装为 Electron 兼容接口
- **HarmonyOS 底层** —— 系统原生能力：Ability 组件、ArkUI 界面、华为账号、云存储等

---

## 功能特性

### Obsidian 核心体验

- 完整的 Obsidian 1.13.7 笔记编辑与管理功能
- 所有社区插件和主题的完整兼容
- 本地 Vault（知识库）的创建、管理与浏览
- Markdown 实时预览与编辑
- 图谱视图、反向链接等高级特性

### 多窗口支持

- 主窗口、子窗口、嵌入窗口、浮动窗口
- 窗口位置与大小持久化记忆
- 独立渲染进程隔离（通过 `ChildProcess`）
- 状态栏扩展窗口

### 华为生态集成

- **华为账号一键登录** —— 通过 Account Kit 的 `LoginWithHuaweiIDButton` 实现无感认证
- **状态栏扩展** —— 通过 `StatusBarViewExtensionAbility` 常驻系统状态栏

### 系统级原生适配

| 类别 | 适配内容 |
|------|---------|
| 文件系统 | 文件管理器、文件选择器、原生对话框、回收站兼容层 |
| 输入 | IME 输入法框架、拖拽放置、多点触控 |
| 显示 | 多显示器管理、深色/浅色主题跟随、自定义光标 |
| 通知 | 系统通知推送、锁屏事件监听 |
| 设备 | 电池状态、蓝牙（经典 + BLE）、电源管理、屏幕截图 |
| 安全 | 证书管理、生物识别认证、剪贴板访问 |
| 其他 | 打印服务、文字转语音、OCR 识别、地理定位、外部协议处理 |

### 自动更新

- 本 Fork **关闭了 Obsidian 的自动更新**：鸿蒙分发走本仓库 Release，
  引擎内的更新链路（检测 `obsidian-{version}.asar` 更新包、RSA 校验、
  热加载）保留但不会触发，避免无意义的联网探测；
- 版本升级：下载新版本 Release 包覆盖安装即可。

---

## 模块结构

项目采用 HarmonyOS 标准双模块架构：

### `web_engine`（HAR 静态库）

核心引擎模块，提供所有 Electron 兼容功能和适配层。可被其他 HarmonyOS 应用复用。

```typescript
// 公共导出（Index.ets）
export { WebAbilityStage } from './src/main/ets/application/AbilityStage'
export { WebAbility } from './src/main/ets/ability/WebAbility'
export { WebEmbeddedAbility } from './src/main/ets/ability/WebEmbeddedAbility'
export { WebWindow, WebSubWindow, WebEmbeddedWindow, WebWindowNode } from './src/main/ets/components/...'
export { WebChildProcess } from './src/main/ets/process/WebChildProcess'
```

**依赖注入** —— 使用 InversifyJS 管理约 50 个适配器的单例注册：

```
CommonModule  → AbilityManager, DragParamManager, SystemFloatingWindowManager
AdapterModule → ContextAdapter, DragDropAdapter, MultiInputAdapter,
                NativeThemeAdapter, PermissionManagerAdapter, DialogAdapter,
                TrashAdapter, CloudSyncAdapter ...
```

### `electron`（HAP 入口包）

可执行的应用模块，包含所有 UI 页面和应用逻辑。

**Ability 组件：**

| Ability | 页面 | 用途 |
|---------|------|------|
| `EntryAbility` | Index.ets | 主入口，初始化 AGC |
| `BrowserAbility` | WindowNode.ets | 浏览器进程窗口 |
| `StatelessAbility` | Index.ets | 无状态窗口 |
| `BrowserEmbeddedAbility` | EmbeddedWindow.ets | 嵌入 UI |
| `StatusBarEntryAbility` | StatusBarPage.ets | 状态栏扩展 |

**UI 页面：**

| 页面 | 说明 |
|------|------|
| `Index.ets` | 主界面，承载 `WebWindow` 组件 |
| `WindowNode.ets` | 浏览器窗口节点 |
| `SubWindow.ets` | 子窗口（弹窗、设置等） |
| `EmbeddedWindow.ets` | 嵌入式窗口 |
| `Login.ets` | 华为账号登录页 |
| `StatusBarPage.ets` | 状态栏页面 |
| `WebPage.ets` | 隐私协议等 WebView 页面 |

---

## 适配层

适配层是 OHsidian 最重要的基础设施 —— 它将 HarmonyOS 原生 API 包装为 Electron 兼容的调用接口，使 Obsidian 在毫无感知的情况下运行在 HarmonyOS 上。

### 适配器清单

每个适配器都继承自 `BaseAdapter`，通过 InversifyJS 注册为单例，并配有对应的 JSBind 绑定类：

```
web_engine/src/main/ets/adapter/
├── Accessibility.ets           # 无障碍功能
├── AppLifecycle.ets            # 应用生命周期
├── AppWindow.ets               # 应用窗口操作
├── Battery.ets                 # 电池状态
├── Bluetooth.ets               # 蓝牙经典
├── BluetoothLowEnergy.ets      # 低功耗蓝牙
├── BrowserPolicy.ets           # 浏览器安全策略
├── CertManager.ets             # 证书管理
├── CloudSync.ets               # 华为云同步 ⭐
├── Context.ets                 # 应用上下文
├── ContextPath.ets             # 文件路径解析
├── Cursor.ets                  # 自定义光标
├── Device.ets                  # 设备信息
├── DeviceInfo.ets              # 硬件信息
├── DeviceUserAuth.ets          # 生物识别
├── Dialog.ets                  # 原生对话框
├── Display.ets                 # 显示器管理
├── DragDrop.ets                # 拖拽放置
├── ElectronApp.ets             # Electron App API
├── ExternalProtocol.ets        # 外部协议处理
├── FileManager.ets             # 文件管理
├── FilePicker.ets              # 文件选择器
├── Font.ets                    # 系统字体枚举
├── Geolocation.ets             # 地理位置
├── I18n.ets                    # 国际化
├── IMF.ets                     # 输入法框架
├── Media.ets                   # 媒体播放
├── MimeType.ets                # MIME 类型
├── MultiInput.ets              # 多窗口输入
├── NativeTheme.ets             # 系统主题
├── NetConnection.ets           # 网络连接
├── Notification.ets            # 系统通知
├── Ocr.ets                     # OCR 识别
├── PasteBoard.ets              # 剪贴板
├── PermissionManager.ets       # 权限管理
├── PopupWindow.ets             # 弹出窗口
├── PowerMonitor.ets            # 电源监听
├── Print.ets                   # 打印服务
├── Process.ets                 # 进程管理
├── RunningLock.ets             # 唤醒锁
├── ScreenlockMonitor.ets       # 锁屏监听
├── Screenshot.ets              # 屏幕截图
├── ShapeDetection.ets          # 形状检测
├── Speech.ets                  # 文字转语音
├── StatusBar.ets               # 状态栏控制
├── SubWindow.ets               # 子窗口管理
├── SystemFloatingWindow.ets    # 系统悬浮窗
└── Trash.ets                   # 回收站操作
```

### JSBind 绑定机制

每个适配器配有一个 Bind 类，将方法注册到 JS 运行时：

```typescript
// 示例：CloudSync 适配器的 JSBind 注册
JsBindingUtils.bindFunction("CloudSync.uploadFile", cloudSyncAdapter.uploadFile)
JsBindingUtils.bindFunction("CloudSync.downloadFile", cloudSyncAdapter.downloadFile)
JsBindingUtils.bindFunction("CloudSync.listCloudFiles", cloudSyncAdapter.listCloudFiles)
// ...
```

所有绑定在应用启动时通过 `JsBindingMethod.ets` 统一激活。

---


## 构建与运行

### 环境要求

| 工具 | 版本要求 |
|------|---------|
| DevEco Studio | 5.0.0+ |
| HarmonyOS SDK | API 22 (6.0.2) |
| Node.js | 18.x+ |
| Hvigor | 5.0.0+ |

### 构建步骤

```bash
# 1. 克隆仓库
git clone https://github.com/your-username/ohsidian.git
cd ohsidian

# 2. 安装依赖（在 DevEco Studio 中自动完成）
#    或手动:
hvigorw install

# 3. 构建 HAP
hvigorw assembleHap

# 4. 产物位于
# build/outputs/default/electron-default-signed.hap
```

或者直接在 DevEco Studio 中打开项目，点击 **Build > Build HAP(s)**。

### 签名配置

在 `build-profile.json5` 中配置签名信息：

```json5
{
  "app": {
    "signingConfigs": [
      {
        "name": "default",
        "type": "HarmonyOS",
        "material": {
          "certpath": "~/.ohos/config/your_cert.cer",
          "storePassword": "******",
          "keyAlias": "debugKey",
          "keyPassword": "******",
          "profile": "~/.ohos/config/your_profile.p7b",
          "signAlg": "SHA256withECDSA"
        }
      }
    ]
  }
}
```


## 项目结构

```
obsidian/
├── AppScope/                         # 全局应用配置
│   ├── app.json5                     # bundleName、版本、多实例模式
│   └── resources/base/
│       ├── element/string.json       # 应用名称 "OHsidian"
│       ├── media/                    # 应用图标（startIcon、trayIcon）
│       └── profile/                  # 字体缩放配置
│
├── web_engine/                       # HAR 静态库（核心引擎）
│   ├── Index.ets                     # 公共 API 导出
│   ├── childProcess.ets              # 子进程导出
│   ├── oh-package.json5              # 依赖：inversify、reflect-metadata
│   ├── hvigorfile.ts                 # harTasks 构建
│   └── src/main/
│       ├── ets/
│       │   ├── ability/              # WebAbility、WebEmbeddedAbility 基类
│       │   ├── adapter/              # ~50 个系统适配器
│       │   ├── application/          # AbilityStage
│       │   ├── common/               # DI 容器、常量、管理器
│       │   ├── components/           # WebWindow、WebSubWindow 等 UI 组件
│       │   ├── interface/            # TypeScript 接口定义
│       │   ├── jsbindings/           # JSBind 绑定注册
│       │   ├── process/              # ChildProcess 管理
│       │   └── utils/                # 日志、工具函数
│       ├── cpp/types/libadapter/     # C++ 原生库类型声明
│       └── resources/resfile/resources/app/
│           ├── main.js               # Electron 启动入口
│           ├── package.json           # Obsidian 1.13.7 包装配置
│           └── obsidian.asar          # Obsidian 应用包
│
├── electron/                         # HAP 入口模块
│   ├── oh-package.json5              # 依赖：web_engine、AGC hmcore
│   ├── hvigorfile.ts                 # hapTasks 构建
│   └── src/main/
│       ├── module.json5              # 模块清单（Ability、页面、权限）
│       ├── ets/
│       │   ├── Application/          # MyAbilityStage
│       │   ├── entryability/         # Entry、Browser、Stateless Ability
│       │   ├── extensionAbility/     # EmbeddedAbility、StatusBar
│       │   ├── pages/                # UI 页面
│       │   └── process/              # CustomChildProcess
│       ├── resources/
│       │   ├── base/element/         # 字符串资源
│       │   ├── base/profile/         # main_pages 路由配置
│       │   ├── rawfile/              # agconnect-services.json
│       │   └── zh_CN|en_US/element/  # 国际化字符串
│       └── ohosTest/                 # 单元测试
│
├── hvigor/                           # Hvigor 构建配置
├── hvigorfile.ts                     # 根构建文件（appTasks）
├── build-profile.json5               # 构建配置（签名、SDK、模块）
├── oh-package.json5                  # 根包配置
└── oh-package-lock.json5             # 依赖锁定文件
```

---

## 依赖说明

### 运行时依赖

| 依赖 | 版本 | 说明 |
|------|------|------|
| `inversify` | ^6.0.1 | IoC 容器，管理适配器依赖注入 |
| `reflect-metadata` | ^0.1.13 | TypeScript 装饰器元数据 |
| `@electron/remote` | ^2.1.3 | Electron remote 模块兼容 |
| `@hw-agconnect/hmcore` | ^1.0.1 | 华为 AGC 核心服务 |
| `libadapter.so` | — | C++ 原生适配库（本地引用） |
| `btime` | — | 文件时间处理 |
| `get-fonts` | — | 系统字体枚举 |

### 开发依赖

| 依赖 | 版本 | 说明 |
|------|------|------|
| `@ohos/hypium` | ^1.0.6 | HarmonyOS 测试框架 |
| `@ohos/hvigor-ohos-plugin` | — | Hvigor 构建插件 |

---

## 许可协议

本项目基于 **BSD 3-Clause License** 开源。

```
Copyright (c) 2023-2025, Haitai FangYuan Co., Ltd.
All rights reserved.
```

### 第三方许可

- **Obsidian** 是其各自所有者的商标，本项目为己编译的 `obsidian.asar` 提供 HarmonyOS 兼容运行环境
- **Electron** 及 `@electron/remote` 遵循 MIT License
- **InversifyJS** 遵循 MIT License
- **Huawei SDK** 各组件遵循华为开发者协议

---

## 致谢

本项目站在以下巨人的肩膀上：

- [Obsidian](https://obsidian.md) — 改变知识管理方式的笔记应用
- [Electron](https://www.electronjs.org) — 跨平台桌面应用框架
- [HarmonyOS](https://developer.huawei.com/consumer/cn/harmonyos/) — 全场景分布式操作系统
- [InversifyJS](https://inversify.io) — 强大的 TypeScript IoC 容器

---

<p align="center">
  <sub>OHsidian 是一个社区项目，与 Obsidian 官方无关。</sub>
</p>
