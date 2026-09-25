# 鸿蒙开发环境搭建指南(新手向)

目标:让 OHsidian 在你的 Windows 电脑上能构建,并安装到你的华为平板上调试。

---

## 第 0 步:准备华为开发者账号

1. 打开 https://developer.huawei.com/consumer/cn/ 注册并**实名认证**(免费,
   但签名调试必须要有)。

## 第 1 步:安装 DevEco Studio

DevEco Studio 是华为官方 IDE(基于 IntelliJ 平台,和 Android Studio 类似)。

1. 下载地址:https://developer.huawei.com/consumer/cn/deveco-studio/
   (选 Windows 64 位,建议最新版本,需支持 **HarmonyOS 6.0.2 (API 22)** 的 SDK)
2. 双击安装包一路 Next,勾选"添加到 PATH"和"创建桌面快捷方式"。
3. 首次启动按向导完成:
   - 导入/新建设置(选 Do not import settings 即可)
   - **登录华为开发者账号**(右上角头像图标,后面自动签名要用)
   - 在 **Settings > HarmonyOS SDK** 里确认勾选了 HarmonyOS SDK,
     API 版本选 **6.0.2(22)**(项目 targetSdkVersion 就是它),点 Apply 等待下载完成。

> 项目要求 Node.js 18+,DevEco Studio 自带 Node,无需单独安装。

## 第 2 步:打开项目并补齐本地配置

仓库里有两个文件**故意不提交**(含个人信息/密钥),需要你本地生成:

### 2.1 build-profile.json5(签名配置)

1. `File > Project Structure > Project > Signing Configs`,勾选
   **"Support HarmonyOS"** 和 **"Automatically generate signature"**。
2. 确保已登录开发者账号,点 **Sign in** 后 DevEco 会自动生成调试证书/Profile,
   自动写出 `build-profile.json5`。
3. 如果想手动配置,参考仓库里的 `build-profile.example.json5`。

> 注意:项目的 `bundleName` 是 `com.mikannqaq.obsidian`(原作者的包名)。
> 本地调试签名不校验包名归属,**可以直接构建安装**;
> 只有要发布到应用市场 / 使用华为 AGC 服务时才需要改成你自己注册的包名。

### 2.2 agconnect-services.json(华为账号登录 / 云同步配置,可选)

- 仓库里只有 `electron/src/main/resources/rawfile/agconnect-services.example.json`。
- 不放这个文件**应用可以正常构建运行**,只是"华为账号一键登录"和"华为云同步"功能
  会在启动日志里报初始化失败(代码里做了容错)。
- 想启用这两个功能:去 https://developer.huawei.com/consumer/cn/service/josp/agc/
  创建应用(包名要和你 app.json5 里的 bundleName 一致),开通 Account Kit 和
  Cloud Foundation Kit,下载 agconnect-services.json 放到上述 rawfile 目录。

## 第 3 步:构建

DevEco Studio 里:**Build > Build Hap(s)/APP(s) > Build Hap(s)**。
成功后产物在 `electron/build/default/outputs/default/*.hap`。

命令行方式(可选):

```bash
hvigorw assembleHap --mode module -p product=default
```

## 第 4 步:平板上安装调试

1. **平板开启开发者模式**:
   `设置 > 关于平板电脑 > 版本号` 连点 7 次 →
   `设置 > 系统和更新 > 开发人员选项` → 打开 **USB 调试**。
2. 数据线连接电脑,平板上弹窗允许调试。
3. DevEco Studio 顶部设备选择器里应能看到你的平板(也可用 `hdc list targets` 验证)。
4. 点绿色 **Run ▶** 按钮 → 自动签名、安装、启动。
5. 看日志:底部 **Log** 窗口,可按标签过滤(`WebAbility`、`EngineFlags`、`ohos` 等)。

## 第 5 步:验证本次修改的效果

| 修改点 | 预期现象 |
|--------|---------|
| Obsidian 1.13.7 | 启动后 `帮助 > 关于` 显示 1.13.7;若启动异常,回滚命令见 docs/CHANGES-2026-09.md |
| 状态栏自动隐藏 | 平板模式进入应用后顶部时间/电量条消失,内容满屏;从屏幕顶缘下拉仍能呼出控制中心 |
| 触摸触发范围 | 按钮更容易按中;若还难按,把 ohsidian-flags.json 的 touchSlopDistance 调大(见 docs/CHANGES-2026-09.md) |
| 触屏模式 | Ctrl+Shift+P 或侧栏命令面板搜"触屏"或 "touch mode",执行后切换为移动布局 |

## 常见问题

- **hvigor 下载依赖很慢**:Settings > Build 找到 Hvigor 配置,可在
  `hvigor/hvigor-config.json5` 里配国内镜像(华为官方 mirror)。
- **签名失败 `sign tool` 报错**:删除 `~/.ohos/config` 下的调试证书缓存后,
  在 Signing Configs 里重新自动生成。
- **安装到一半失败**:卸载旧的 OHsidian(com.mikannqaq.obsidian)再装,
  因为签名不一致时系统会拒绝覆盖安装(旧版数据先备份 Vault)。
- **DevEco 版本太新没有 API 22 的 SDK**:在 SDK 管理器勾选"显示历史版本"安装
  6.0.2(22),或把 build-profile 里的 targetSdkVersion 一并升级(需回归测试)。
