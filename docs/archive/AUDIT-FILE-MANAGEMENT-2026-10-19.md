# OHsidian 文件管理审计报告（2026-10-19）

> 审计对象：仓库存储位置、目录选择器、文档目录权限、迁移/回收站、入站文件（拖拽/分享）、临时文件与相关 UX/文档。
> 审计方式：**只读静态审计**（4 个并行子审计 + Lead 交叉复核），未修改任何源码、未运行构建、未上真机。
> 代码基线：`HEAD = c0509cd` + 未提交工作区（`docs/CHANGES-2026-10.md`、`electron/src/main/ets/pages/Index.ets`、`electron/src/main/module.json5`、`scripts/update-obsidian.mjs`、`web_engine/Index.ets`、`web_engine/.../WebAbility.ets`、`.../AppWindowAdapter.ets`、`.../app/main.js` 等）。
> **审计期间有另一个会话在并行编辑本仓库**（`scripts/update-obsidian.mjs` 行数在 3237→3247 间漂移，mtime 持续更新；`Index.ets`、`CHANGES-2026-10.md` 同样）。因此：
> - ArkTS 源文件在审计窗口内未变，行号可直接用；
> - `scripts/update-obsidian.mjs` 的行号**仅供近似定位**，证据以函数名/代码片段为准（快照：`2026-10-19T17:33:25+08:00`，150557 B，SHA-256 `53A5DF40…`）；
> - 若行号对不上，请按报告中的函数名搜索。

---

## 0. 一页结论

### 0.1 用户主诉（已定位，确定）：选择文件夹为什么停在“我的文件”根目录

触摸模式里点“管理仓库 → 打开文件夹作为仓库 / 新建仓库 → 浏览位置”时，实际链路是：

```
触摸模式抽屉 <select> 被补丁拦截
  → window.app.openVaultChooser()（打开桌面版 starter 仓库选择器）
  → starter.js 调 electron.remote.dialog.showOpenDialogSync({
        properties:["openDirectory","createDirectory","dontAddToRecent"] })
        ← 这里没有传 defaultPath（starter 里只有“移动仓库”这一处传了）
  → electron 把缺省值归一化为 defaultPath:""
  → @electron/remote 转成 ArkTS DialogAdapter.showOpenDialog(settings)
  → DialogAdapter.handleDefaultPath("")
       .trim() 后走失败分支 → 返回写死的
       DEFAULT_DIR = 'file://docs/storage/Users/currentUser'
  → DocumentViewPicker 停在“我的文件”根目录
```

**根因**：`DialogAdapter.handleDefaultPath()` 的兜底值是硬编码的用户根目录，代码里**没有任何“文档目录权限 / 文档/OHSidian”的分支**（`DialogAdapter.ets:91-92, 183-185, 244-273`）。不是引擎传了 home，也不是 `file://docs` 前缀拼错——合法目录会被正确拼成 `file://docs<path>`。

另一个入口 `FilePickerAdapter.showDirDocumentViewPicker()`（移动端“选择文件夹”桥）**完全没有设置 `defaultFilePathUri`**（`FilePickerAdapter.ets:87-110`），同样与 `文档/OHSidian` 无关。

### 0.2 最危险的不是选择器，而是三条“数据会没”的链路（P0）

| 编号 | 问题 | 后果 |
|---|---|---|
| STO-01 / 02 | 回收站把文件从**沙箱仓库**搬到 `文档/OHSidianTrash` 时用 `fs.renameSync`，跨文件系统必失败（源码注释自认 cross-device）；失败后**静默回退**到仓库内隐藏 `.trash`，而删除对话框仍写“移至 文档/OHSidianTrash”；更严重的是**回退分支不写删除时间**，30 天清理按文件内容 mtime 计龄 | 用户今天删掉一篇两个月前写的笔记 → 下次启动约 60 秒后被**永久 unlink**，30 天恢复窗口形同虚设 |
| STO-03 | “迁移仓库”对目标已存在/非空**零检查**，`copyFile` 直接覆盖同名文件；一键迁移的目标恰好是默认仓库路径 | 升级用户（旧沙箱仓库 + 新文档默认仓库并存）执行迁移 → **覆盖/混合两版数据**；在 picker 里选“文档”根还会把 vault 摊平进文档根 |
| STO-04（P1→可能 P0） | `__ohDvEnsure` 吞掉 `mkdirSync` 失败仍返回路径；`accessSync` 只判存在不判可写 | 权限被撤销/目录只读/磁盘满时，首启“快速开始”复现 **“Failed to open vault folder not found.”**，用户无法自救 |

### 0.3 与选择器同源的第二组问题（P1）

- ArkTS 侧**没有**“文档目录权限是否已授予”的判定：`checkPermissions()` 只有 JS 绑定、无 ArkTS 调用者；`publishDocumentsDir()` 在授权请求**之前**执行，且取不到路径时**只 return 不清旧值** → 渲染层只能拿“`cfg.documentsDir` 是否存在”当“已授权”猜（权限被撤销后仍是陈旧正缓存）。
- 权限被拒/撤销后：**没有任何用户可见提示**，也不引导去系统设置；下一次启动仍会无条件再弹权限框。
- `FILE_ACCESS_PERSIST` 的 URI 只存**一个槽**（`defaultDownloadUri`），且启动时**批量** `activatePermission`，一条失效 URI 可能整批失败 → 多仓库/重启后目录失权，表现像“数据丢了”。
- 触摸模式 `vault-open` 主进程补丁在**创建新窗口之前** `destroy()` 其它所有窗口；若新窗口创建失败（第 106 轮有真实失败链），旧窗口已销毁、新窗口不存在，且 `destroy()` 跳过 `beforeunload`（最后 2 秒防抖保存可能丢）。

### 0.4 最高优先的 5 个动作

1. **先修回收站**：把“搬移 + 盖删除时间”做成一个统一函数（`rename` 失败则 `copyFile + utimes + unlink`），Documents 分支和 `.trash` 回退分支共用；删除提示按“真实可写性”选文案（STO-01/02）。
2. **迁移目标守卫**：目标必须“不存在或为空”，否则二次确认；一键迁移先检查 `<docs>/OHSidian/<name>` 是否已存在；拒绝符号链接与深度/条目无限递归（STO-03/11）。
3. **目录选择器默认位置**：按下文第 2 节的补丁 A–C 落地“有文档权限 → `文档/OHSidian`，无 → 根目录”；同时修 `publishDocumentsDir` 发布 `documentsDirGranted`（SEL-01/02/03）。
4. **默认仓库落点 30 秒真机判定**：`get-default-vault-path` 的覆盖监听器可能被引擎自带的同频道监听器覆盖（后者后注册、后写 `returnValue`）——若成立，快速开始的默认仓库会退回 `<Documents>/Obsidian Vault` 或旧行为（UX-01）。先做判定再决定是否改注册方式。
5. **入站安全门收敛到一处**：目前 `text/url` 路径提升、`file://<bundle>/...`、平铺 `file:///storage/.../Documents` 三条都能绕过 S1 检查（IO-01）。统一“来源 + 域 + 归属”校验。

---

## 1. 审计范围、方法与证据基线

### 1.1 四个并行视角

| 子审计 | 覆盖 | 报告（只读产物） |
|---|---|---|
| picker-permission | 目录选择器、文档权限、FILE_ACCESS_PERSIST、默认仓库 IPC | `.cache/audit-fm-2026-10-19/picker.md`（805 行） |
| vault-storage | 默认仓库解析、迁移、回收站重定向/清理、console.log、mode 文件、vault 注册表 | `.cache/audit-fm-2026-10-19/storage.md`（246 行） |
| io-security | 拖拽/分享入站、临时副本、URI→路径、回调契约、资源泄漏 | `.cache/audit-fm-2026-10-19/io.md`（618 行） |
| ux-docs | 触摸模式流程、权限矩阵、README/文档一致性、多窗口/迁移 UX | `.cache/audit-fm-2026-10-19/ux.md`（472 行） |

主审代码：`web_engine/src/main/ets/adapter/{DialogAdapter,FilePickerAdapter,PermissionManagerAdapter,TrashAdapter,FileManagerAdapter,DragDropAdapter,ContextPathAdapter}.ets`、`web_engine/src/main/ets/common/DragParamManager.ets`、`web_engine/src/main/ets/ability/WebAbility.ets`、`scripts/update-obsidian.mjs`、`electron/src/main/module.json5`、`AppScope/app.json5`、README/CHANGES/tablet-demo/TODO。另只读抽取 `scripts/.tmp-refresh/extracted/{app.js,starter.js,main.js}` 与构建产物 `obsidian.asar` 用于核对补丁落点（引擎闭源，属于“上游原样”证据）。

### 1.2 证据基线（关键文件快照）

| 文件 | mtime | SHA-256[:16] |
|---|---|---|
| `web_engine/.../adapter/DialogAdapter.ets` | 2026-09-25 01:40 | `B8E0382758786C02` |
| `web_engine/.../adapter/FilePickerAdapter.ets` | 2026-09-29 11:54 | `30138CD2C3AADD94` |
| `web_engine/.../adapter/PermissionManagerAdapter.ets` | 2026-10-01 10:53 | `81B3D1D855230169` |
| `web_engine/.../ability/WebAbility.ets` | 2026-10-19 16:49 | `D98480FE3184A816` |
| `electron/src/main/module.json5` | 2026-10-19 00:27 | `D8BB73B2C3DD908D` |
| `scripts/update-obsidian.mjs` | 2026-10-19 17:33 | `53A5DF40A8F8EC93` |
| `web_engine/.../app/obsidian.asar` | 2026-10-19 16:41 | `EEF8AD6BAE71B05B` |

**重要事实（已验证，不是问题）**：`web_engine`（har）`module.json5` 声明的 23 个权限（含 `READ_WRITE_DOCUMENTS_DIRECTORY`、`FILE_ACCESS_PERSIST`）在构建产物 HAP 的 `electron/build/.../merge_profile/default/module.json` 中**已完整合并**，entry 模块无需重复声明。权限问题不在“声明”，在“运行时判定/发布/失败提示”。

---

## 2. 主诉专题：目录选择器默认位置与“文档/OHSidian”规则

### 2.1 真实链路（三个入口共用一个 ArkTS picker）

| 用户操作 | 引擎调用 | defaultPath | 最终 ArkTS 落点 |
|---|---|---|---|
| 管理仓库 → “打开文件夹作为仓库” | `a(l.optionOpenFolderAsVault())` | **无** | `DialogAdapter.showOpenDialog` → `DEFAULT_DIR`（根目录） |
| 新建仓库 → 位置 → “浏览” | `a(l.optionNewVaultLocation())` | **无** | 同上 |
| 仓库右键 → “移动仓库…” | `a(l.msgMoveSelectDest(), s)`（`s`=当前仓库父目录） | 有（可能是沙箱路径，见 2.6 边界） | 同上 |
| 迁移命令的 picker 分支 | `remote.dialog.showOpenDialog({properties:["openDirectory","createDirectory"], buttonLabel:"迁移仓库到这里"})` | **无**（补丁里没传） | `DialogAdapter.showOpenDialog` → 根目录 |
| 移动端“选择文件夹”（`Lf.choose()`） | 绑定 `FilePickerAdapter.ShowDirDocumentViewPicker`（待真机确认） | 方法内**未设置** | `FilePickerAdapter.showDirDocumentViewPicker` |

补充：`IOpenDialogSettings` 里定义了 `title` / `button_label`，但 `DialogAdapter.showOpenDialog` **从未读取**（HarmonyOS `DocumentViewPicker` 也没有标题入参），所以“迁移仓库到这里”“Open folder as vault”这些文案在系统选择器里全部丢失。

### 2.2 根因（确定）

```ts
// DialogAdapter.ets:91-92
private static PATH_PREFIX: string = 'file://docs';
private static DEFAULT_DIR: string = 'file://docs/storage/Users/currentUser';

// :183-185
let dirAndFile: string[] = this.handleDefaultPath(dialogSettings.default_path);
DocumentSelectOptions.defaultFilePathUri = dirAndFile[0];

// :244-273
private handleDefaultPath(default_path: string) {
  let dirAndFile: string[] = [DialogAdapter.DEFAULT_DIR, ''];
  try {
    let path: string = default_path.trim();   // undefined → 抛 TypeError；'' → 后续失败
    ...
  } catch (err) { /* 只打日志 */ }
  return dirAndFile;                          // 任何无效输入都返回根目录
}
```

三条失败路径（`undefined` / `""` / 真实根 `/storage/Users/currentUser`）**全部**收敛到 `file://docs/storage/Users/currentUser`。`grep 'storage/Users/currentUser'` 在 `web_engine/`、`electron/`、`scripts/` 源码中只命中 `DialogAdapter.ets:92`，与用户看到的落点精确吻合。

### 2.3 第二条入口：`FilePickerAdapter.showDirDocumentViewPicker()` 无默认位置（确定代码 / 落点待真机）

```ts
showDirDocumentViewPicker(file_access_persist: boolean, callback: (path: string) => void) {
  let DocumentSelectOptions = new picker.DocumentSelectOptions();
  DocumentSelectOptions.selectMode = picker.DocumentSelectMode.FOLDER;   // 仅此一行
  ...
}
```

`showSaveAsDocumentViewPicker()` 则是 `defaultFilePathUri = 'file://docs' + params.dir_name`（无判空/判域/判存在；空串、相对路径、沙箱路径、已带 `file://` 的输入都会拼成非法 URI → picker reject → 被当“用户取消”回调空串）。

### 2.4 为什么现在表达不了“有权限就默认文档/OHSidian”

| 事实 | 证据 | 影响 |
|---|---|---|
| ArkTS 侧没有权限判定 API 调用 | `PermissionManagerAdapter.checkPermissions()` 只有 JS 绑定；全 ArkTS 源码无调用者 | 无法在选择器打开前判断“文档权限是否已授予” |
| `publishDocumentsDir()` 不发布授权状态、且不清旧值 | `WebAbility.ets:1176-1209`：取不到路径 `return`；值相同 early-return，从不删除 `cfg['documentsDir']` | 权限被撤销后，模式文件永久保留陈旧 `documentsDir`，渲染层继续按“可用”处理 |
| 发布早于授权请求 | `WebAbility.ets:2260` 发布，`:2279-2311` 才请求 | 首装未授权时可能先发布一个不可用路径（`getUserDocumentDir()` 未授权时抛错还是返回路径，需真机确认） |
| 渲染层靠“字段存在”猜授权 | `update-obsidian.mjs` 的 `__ohsidianTrashNote`、`__ohDvResolve`、`ad.trashLocal`、purge、console 路径 | 删除提示、默认仓库、回收站、日志同时受影响；文案可能与实际去向不符 |

### 2.5 期望行为规格（建议作为实现标准）

1. **目录选择（FOLDER / 另存为）**：
   - 引擎显式给了**有效**默认路径（绝对路径、在 docs 可映射域、非 appdata、存在）→ 尊重它，行为不变；
   - 否则，若 `READ_WRITE_DOCUMENTS_DIRECTORY` **已授予** → 默认打开 `<Documents>/OHSidian`（不存在则创建；创建失败退到 `<Documents>`；再失败退根目录）；
   - 否则（无权限/不可用）→ 默认用户根目录，让用户自己选。
2. **打开文件（openFile）**：不强制改默认位置，避免影响“插入附件/打开文件”的既有行为。
3. **权限被拒/撤销**：选择器回根目录的同时，应用内给出一次可见说明（为什么、后果、去哪里授权），而不是静默。
4. **选择器仍可自由导航**：默认位置只是起点，不限制用户选别处（“不局限于文档”）。
5. **不做**：不修改 `starter.js`（上游 bundle，补丁只改 `app.js`/`main.js`）；把默认位置收敛在 ArkTS 层，三个入口自然同时生效。

### 2.6 可直接落地的补丁（ArkTS 最小改动）

> 以下为设计稿，未在本次审计中应用（仓库正被并行编辑）。落地时建议先只做 A–C，再联动 D–E。

#### 补丁 A：`PermissionManagerAdapter` 增加同步授权查询 + 默认目录解析

```ts
import environment from '@ohos.file.environment';
import fs from '@ohos.file.fs';

/** 同步查询一组运行时权限是否已全部授予（挑选器打开前调用一次即可）。 */
public isPermissionGrantedSync(permissionType: string): boolean {
  const permissions: Array<Permissions> | undefined = this.needPermissions.get(permissionType);
  if (permissions === undefined || permissions.length === 0) {
    return false;
  }
  try {
    const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
    const tokenId: number = info.appInfo.accessTokenId;
    for (let i = 0; i < permissions.length; i++) {
      if (this.atManager.checkAccessTokenSync(tokenId, permissions[i]) !==
          abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
        return false;
      }
    }
    return true;
  } catch (err) {
    LogUtil.error(TAG, 'isPermissionGrantedSync failed: ' + JSON.stringify(err));
    return false;
  }
}

/** <Documents>/OHSidian 的真实路径；'' = 不可用。 */
public getDocumentsVaultRootPath(): string {
  if (!this.isPermissionGrantedSync('directory_document')) {
    return '';
  }
  let docs: string = '';
  try {
    docs = environment.getUserDocumentDir();
  } catch (err) {
    return '';
  }
  if (!docs) {
    return '';
  }
  const base: string = docs.endsWith('/') ? docs.slice(0, docs.length - 1) : docs;
  const target: string = base + '/OHSidian';
  try {
    if (!fs.accessSync(target)) {
      fs.mkdirSync(target, true);          // picker 的 defaultFilePathUri 需要已存在目录
    }
    return target;
  } catch (err) {
    LogUtil.warn(TAG, 'create OHSidian dir failed, fall back to Documents: ' + JSON.stringify(err));
    return base;                            // 至少落在 文档 根
  }
}

/** 给 picker 的 docs 域 URI；'' = 不设置。 */
public getDocumentsVaultRootUri(): string {
  const p: string = this.getDocumentsVaultRootPath();
  return p ? 'file://docs' + p : '';
}
```

边界：`needPermissions.get()` 可能返回 `undefined`（现有 `checkPermissions` 直接 cast 有崩溃风险，新代码必须判空）；`mkdirSync(target, true)` 已存在会抛，已用 `accessSync` 先判；不要每帧调用，只在构造 picker options 前调用。

#### 补丁 B：`DialogAdapter.handleDefaultPath()` 改为“引擎有效路径 → 文档/OHSidian → 根目录”三级

```ts
private static DOCS_DOMAIN_ROOT: string = '/storage/';
private static APPDATA_PREFIX: string = '/storage/Users/currentUser/appdata/';

/** 只负责“引擎给的路径 → [dirUri, fileName]”；不可用返回 undefined。 */
private tryResolveDirAndFile(default_path: string): string[] | undefined {
  let path: string = '';
  try { path = default_path.trim(); } catch (err) { return undefined; }
  if (!path) return undefined;
  if (path.startsWith('file://')) return [path, ''];
  // 只接受 docs 域真实路径；沙箱 /data/storage/… 与 appdata 不能映射为 file://docs
  if (!path.startsWith(DialogAdapter.DOCS_DOMAIN_ROOT) ||
      path.startsWith(DialogAdapter.APPDATA_PREFIX)) {
    return undefined;
  }
  try {
    if (fs.accessSync(path)) {
      const stat = fs.statSync(path);
      if (stat.isDirectory()) return [DialogAdapter.PATH_PREFIX + path, ''];
      const idx = path.lastIndexOf('/');
      return [DialogAdapter.PATH_PREFIX + path.slice(0, idx), path.slice(idx + 1)];
    }
    const idx = path.lastIndexOf('/');
    const dirPath = path.slice(0, idx);
    const fileName = path.slice(idx + 1);
    if (dirPath && fs.accessSync(dirPath)) {
      return [DialogAdapter.PATH_PREFIX + dirPath, fileName];
    }
  } catch (err) { /* fallthrough */ }
  return undefined;
}

private handleDefaultPath(default_path: string): string[] {
  const fromEngine = this.tryResolveDirAndFile(default_path);
  if (fromEngine !== undefined) return fromEngine;              // 1) 尊重有效默认
  const docsUri = this.permissionManagerAdapter.getDocumentsVaultRootUri();
  if (docsUri) return [docsUri, ''];                            // 2) 有文档权限 → 文档/OHSidian
  return [DialogAdapter.DEFAULT_DIR, ''];                       // 3) 无权限 → 根目录
}
```

同时在 `showOpenDialog` 里给 `documentPicker.select` 加**一次无默认路径的重试**：若带 `defaultFilePathUri` 的调用 reject（例如目录刚好被删/权限瞬时失效），去掉该字段重试一次，避免“选择器直接打不开/被当成取消”。

#### 补丁 C：`FilePickerAdapter` 两个入口

```ts
// showDirDocumentViewPicker（FOLDER）与 showSaveAsDocumentViewPicker 构造 options 后：
const docsUri = this.permissionManagerAdapter.getDocumentsVaultRootUri();
if (docsUri) {
  DocumentSelectOptions.defaultFilePathUri = docsUri;    // 或 DocumentSaveOptions...
}

// showSaveAsDocumentViewPicker 对 params.dir_name 的兜底：
let dirName = '';
try { dirName = params.dir_name.trim(); } catch (err) { dirName = ''; }
let defaultUri = '';
if (dirName.startsWith('file://')) {
  defaultUri = dirName;
} else if (dirName.startsWith('/storage/') && !dirName.startsWith('/storage/Users/currentUser/appdata/')) {
  try { if (fs.accessSync(dirName)) defaultUri = FilePickerAdapter.PREFIX + dirName; } catch (err) { /* ignore */ }
}
if (!defaultUri) defaultUri = this.permissionManagerAdapter.getDocumentsVaultRootUri();
if (defaultUri) DocumentSaveOptions.defaultFilePathUri = defaultUri;
```

`showDocumentViewPicker`（openFile）建议保持现状，避免影响附件/打开文件流程。

#### 补丁 D：`WebAbility.publishDocumentsDir()` 发布授权标志并清陈旧值

```ts
private publishDocumentsDir(grantedHint?: boolean): void {
  const pm = Inject.get(PermissionManagerAdapter);
  const granted: boolean = grantedHint === undefined
    ? pm.isPermissionGrantedSync('directory_document') : grantedHint;
  let documentsDir = '';
  if (granted) {
    try { documentsDir = environment.getUserDocumentDir(); } catch (e) { /* keep '' */ }
  }
  // ... 读取 cfg（沿用现有逻辑）...
  const changed = cfg['documentsDir'] !== documentsDir || cfg['documentsDirGranted'] !== granted;
  if (!changed) return;
  if (documentsDir) cfg['documentsDir'] = documentsDir;
  else delete cfg['documentsDir'];             // 关键：撤销权限后不能留旧值
  cfg['documentsDirGranted'] = granted;
  this.publishModeFileAtomic(filePath, cfg);
}
```

调用点：`:2260` 保留（先按当前状态发一次）；`:2299-2309` 的授权回调改为 `this.publishDocumentsDir(granted === 0)`；建议 `onForeground()` 再发一次，覆盖“去系统设置改权限后返回”。

#### 补丁 E：渲染层联动（`scripts/update-obsidian.mjs`，函数名锚定）

以下 5 处把“`cfg.documentsDir` 存在”改为“`cfg.documentsDirGranted === true`”，并保留旧字段兼容（`documentsDirGranted === undefined && documentsDir` 时按旧逻辑）：

1. `__ohsidianDefaultVault` 的 `__ohDvResolve()`：只有 granted 才走 Documents 默认仓库，且 `accessSync` 兜底；
2. `window.__ohsidianTrashNote()`：只有 granted 才输出“移至 文档/OHSidianTrash…”；
3. `hookTrash()` 的 `ad.trashLocal`：只有 granted 才尝试 Documents，否则直接本地 `.trash`；
4. `__ohTrashPurgeOnce` 的 roots 收集；
5. console bridge 的日志目标路径。

另外建议在 `migrateVaultToVisibleFolder()` 的 `showOpenDialog` 里补 `defaultPath: docsDir ? path.join(docsDir,'OHSidian') : undefined` 作为双保险（不能依赖它，见 2.7）。

#### 补丁 F（数据面，必做）：回收站统一“带时间戳搬移”

在 `hookTrash` 里把成功分支和回退分支合并为一个函数：

```
mkdir(destDir) →
冲突时递增 "(n)" →
try renameSync(src,dest)
catch → copyFileSync(src,dest) + unlinkSync(src)   // EXDEV/EPERM 兜底
→ utimesSync(dest, now, now)
→ utimes 失败则写 <dest>.ohsidian-trash-meta.json {deletedAt}
→ （若保留引擎语义）调用 ad.reconcileInternalFile(rel)
```

删除提示文案与实际去向必须共用同一“可写探测”结果（建议 ArkTS 侧发布 `documentsDirWritable`，或渲染层做一次写探测）；回退发生时补一条 Notice。

### 2.7 边界条件与回归风险

- `DocumentSelectOptions.defaultFilePathUri` 要求指向**已存在**目录；补丁 A 已创建 `OHSidian`。若创建失败，退到 `<Documents>`，再退根目录。
- `environment.getUserDocumentDir()` 在**未授权**时是抛错、返回空还是返回路径，需真机确认（决定补丁 D 的 `granted` 判定是否足以避免陈旧值；显式 `checkAccessTokenSync` 已经消除该依赖）。
- `defaultPath → default_path` 字段名来自闭源 `libelectron.so` 的字符串池推断（字段名与 `IOpenDialogSettings` 逐字对应）；落地前用现有 hilog `ShowOpenDialog <settings>` 行确认真实 JSON。
- “移动仓库”入口会传当前仓库父目录：若仓库在沙箱（`/data/storage/...`），旧代码会拼成非法的 `file://docs/data/...`；补丁 B 的 `tryResolveDirAndFile` 会拒绝并回退到文档默认位置，这是**行为变化**（用户会从“报错/取消”变成“从文档/OHSidian 开始选”），属于改进但需在变更记录里注明。
- 权限刚授予的同一会话内，系统对 Documents 的写权限可能存在“生效延迟”（社区有“授权后需重进应用才能创建目录”的报告）；补丁 A 的 mkdir 失败会退到 `<Documents>` 或根目录，不会阻塞选择器；是否需要在授权回调后延迟重试一次，建议真机确认。

### 2.8 验证步骤（真机，tablet / HarmonyOS 6.x debug 构建）

统一日志：`hdc shell hilog | findstr /i "OHSidian Dialog Picker documents"`，重点行：
`ShowOpenDialog <settings>`、`showOpenDialog dirAndFile:`、`documents dir published:`、`startup permission NOT granted:`、`activeFileAccessPersist failed:`、`DocumentViewPicker.select failed`。

| # | 场景 | 预期 |
|---|---|---|
| 1 | 首装拒绝文档权限 → 管理仓库 → 打开文件夹作为仓库 | 停在用户根目录；模式文件无 `documentsDir`、`documentsDirGranted:false` |
| 2 | 首装授予文档权限 → 重启 → 同上 | 直接打开 `文档/OHSidian`；文件管理器可见该目录 |
| 3 | 新建仓库 → 浏览位置 | 默认 `文档/OHSidian`，创建后仓库位于 `文档/OHSidian/<名>` |
| 4 | 撤销文档权限 → 杀进程重启 → 再走 1 | 回根目录；删除提示为“未授权文档目录：… .trash”；无陈旧 `documentsDir` |
| 5 | 多仓库 + 多次选择目录 → 重启 → 依次打开 | 各仓库均可读写；`defaultDownloadUri` 含全部 URI（当前实现会只剩最后一个 → SEL-05） |
| 6 | 迁移命令（仓库在沙箱） | 一键到 `文档/OHSidian/<仓库名>`；回退 picker 时默认 `文档/OHSidian` |
| 7 | 混合模式（openFile+openDirectory）选目录 → 重启 | 目录权限仍有效（当前不持久化 → SEL-06） |

---

## 3. 缺陷清单

> 统一级别定义：**P0** = 确定可导致不可逆数据丢失/核心功能不可用/高置信私有数据外泄；**P1** = 高概率数据风险、关键功能错误、安全门缺失或明显违背承诺；**P2** = 边界健壮性、资源泄漏、体验/文档一致性。
> 状态：**确定** = 代码可证；**待真机** = 依赖系统 API/闭源引擎运行时行为。

### 3.1 P0

#### STO-01（P0，逻辑确定 / errno 待真机）回收站跨文件系统 `rename` 必然失败，静默回退隐藏 `.trash`，文案仍承诺 Documents

- 证据：`update-obsidian.mjs` `hookTrash()` 的 `ad.trashLocal` 包装里 `fsMod.renameSync(src,dest)` → `catch` → `return origLocal.call(ad,rel)`（约 L2069、L2082-2085）；补丁头注释自认 “Falls back to the stock local trash on any fs error (e.g. cross-device renames from sandbox vaults)”（约 L120-124）；`__ohsidianTrashNote` 只看 `cfg.documentsDir` 是否存在（约 L1988-2003）。
- 触发：仓库在应用沙箱（升级用户旧默认仓库；或未授权期创建的仓库）且文档权限已授予。沙箱 `/data/storage/el2/...` 与 `/storage/Users/currentUser/Documents` 是不同挂载点。
- 影响：删除对话框和 README 说“移至 文档/OHSidianTrash/仓库名/”，实际进仓库内隐藏 `.trash`：文件管理不可见、卸载随仓库丢、用户按 README 去恢复找不到。与 STO-02 叠加后恢复窗口被压缩到“下次启动前”。
- 修复：见 2.6 补丁 F（统一带时间戳搬移；rename 失败 copy+unlink；回退可见提示）。

#### STO-02（P0，确定）回收站回退分支不写删除时间 → 旧 mtime 文件在下次启动约 60 秒后被永久删除

- 证据：重定向成功分支才 `utimesSync(dest,now,now)`，失败才写 `<dest>.ohsidian-trash-meta.json`（约 L2068-2072）；回退分支 `return origLocal.call(ad,rel)` 委托引擎原生 `trashLocal`（只 `rename`，保留内容 mtime，不写任何时间戳）；`__ohTrashPurgeOnce` 按 `st.mtimeMs` 与 30 天比较后 `unlinkSync`（约 L2959-2986），60s 后执行一次、`will-quit` 再执行一次。
- 触发：任一 relocate 失败（STO-01 的跨盘场景几乎必触发）；被删文件内容 mtime 早于 30 天前。
- 影响：**用户今天删除的旧笔记，下次启动约 60 秒后被永久删除，无确认、无撤销**；“30 天恢复窗口”只对重定向成功分支成立。
- 修复：删除时间戳必须在**所有**分支写入（先写 meta 再搬移，或搬移后立即写；purge 跳过最近 10 分钟的条目作为双保险）。

#### STO-03（P0，确定）迁移对目标已存在/非空零检查：静默覆盖、混合两版数据

- 证据：`pickMigration` 的 `copyDir`（约 L2499-2517）与一键迁移的 `copyDir2`（约 L2547-2564）都直接 `fsMod.copyFile(sp,dp,...)`；Node `copyFile` 对已存在目标**直接截断覆盖**；无 `existsSync`/非空检查/二次确认/空间检查。一键迁移 `dest = join(docsDir,"OHSidian",name)`（约 L2540）恰好是默认仓库路径；唯一守卫“目标在源内”只在 picker 分支有（约 L2494-2496），一键分支没有。
- 触发（现实路径）：
  - 升级用户：旧沙箱仓库 + 文档里已有的默认仓库并存，打开旧仓库执行迁移 → 覆盖文档仓库同名文件，保留其独有文件 → **混合两版数据**；
  - 用户在 picker 里选中非空目录（甚至“文档”根）→ vault 内容摊平进该目录并覆盖同名文件。
- 影响：目标已有内容被静默覆盖（不可恢复）；知识库出现两版混合；选根目录会把 `.obsidian` 写进文档根，把整个“文档”变成 vault。
- 修复：目标必须不存在或为空；否则二次确认并列出将覆盖文件数；一键迁移固定目标并先检查；或先复制到 `dest.partial-<ts>`，成功后原子 rename；失败回滚本次新建目录。

### 3.2 P1

| 编号 | 主题 | 关键证据 | 影响 | 修复方向 |
|---|---|---|---|---|
| SEL-01 | **用户主诉**：目录选择器默认根目录（确定） | `DialogAdapter.ets:91-92,183-185,244-273`；starter.js 的 `showOpenDialogSync` 两处缺省调用 | 三个入口都停在“我的文件”；有文档权限也永远不默认 `文档/OHSidian` | 补丁 A–C |
| SEL-02 | `FilePickerAdapter.showDirDocumentViewPicker` 无默认位置（确定代码/落点待真机） | `FilePickerAdapter.ets:87-110` | 移动端“选择文件夹”落系统默认位置 | 补丁 C |
| SEL-03 | ArkTS 无文档权限判定；`publishDocumentsDir` 发布早于授权、取不到只 return 不清旧值（确定） | `WebAbility.ets:1176-1209,2260,2279-2311`；`PermissionManagerAdapter.ets:178-206` 无 ArkTS 调用者 | 渲染层把“字段存在”当“已授权”；权限撤销后陈旧正缓存 → 默认仓库/回收站/日志一起错 | 补丁 A/D；`documentsDirGranted` |
| SEL-04 | 权限被拒/撤销后零提示、无设置引导、每次启动重弹（确定） | `WebAbility.ets:2299-2309` 只 hilog；`PermissionManagerAdapter.openPermissionConfirm` 只有 pasteboard 分支；asar app.js 无该调用点 | 用户点一次“不允许”即永久退回沙箱（卸载丢数据），界面一切正常 | 删除/启动提示条 + 引导设置；记录 denied 状态 |
| SEL-05 | `FILE_ACCESS_PERSIST` 单槽覆盖 + 批量 activate（确定机制） | `PermissionManagerAdapter.ets:223-243`（`putSync` 整体替换）、`:264-285`（整批 activate，失败仅日志） | 选 A 再选 B 只剩 B；重启只激活最后一批；一条坏 URI 可能整批失败 → 外部目录仓库打不开（Documents/Download/Desktop 三目录权限覆盖的仓库不受影响，其余受影响） | union 合并去重 + 串行写队列；activate 逐条降级并剔除坏 URI；persist 成功后再落盘 |
| STO-04 | `__ohDvEnsure` 吞 `mkdirSync` 失败仍返回路径；回退 userData 静默、日志无条件（确定） | 约 L2857-2881；引擎 `p()` 返回 `"folder not found"` / `"no permission to access folder"` | 首启复现 “Failed to open vault folder not found.”；用户无法关联到权限 | mkdir 后做可写探测；失败返回 null 并回退 userData + 明确提示；分支化日志 |
| STO-05 | 迁移无 flush/进度/取消/回滚/锁/空间检查/mtime 保留；旧 `.trash` 不随迁；失败残留（确定） | 约 L2462-2577 | 大仓库像卡死；半份副本再迁移继续合并；mtime 重置导致全量重索引/同步重传；旧回收站变孤儿 30 天后被清 | 全局锁 + 进度 + partial 目录 + 原子 rename + utimes 保留 + flush + 迁移后提示旧路径 |
| STO-06 | `hookTrash` 替换整个 `adapter.trashLocal`，绕过引擎 `queue` 与 `reconcileInternalFile`（确定，影响待真机） | 补丁约 L2033-2086；引擎原实现末尾 `reconcileInternalFile(e)`（asar app.js） | 删除后文件树/索引可能残留幽灵条目（watcher 可能兜底，但这是行为变化） | 搬移后调用 `ad.reconcileInternalFile(rel)`；或保留原方法并在其内部盖时间 |
| STO-07 | 30 天 purge 清理“每个已注册 vault 的 `.trash`”+`OHSidianTrash`，无 marker/清单/确认（确定） | 约 L2949-2986 | 用户/插件自建 `.trash`、用户放进 `OHSidianTrash` 的 >30 天归档被永久删；depth>16 永不清理；多进程无锁，`rename→utimes` 间隙可能按旧 mtime 立即清（小概率、P0 后果） | `.ohsidian-trash-owner.json` marker / 清单；提高深度；最近 10 分钟跳过；单实例锁 |
| STO-08 | `ohsidian-mode.json` 多写者全量 RMW + 共用同一 `.tmp`（确定） | 渲染层 `writeModeFileSync`（约 L229-241）与 ArkTS `publishModeFileAtomic`（`WebAbility.ets:325-352`）都用 `ohsidian-mode.json.tmp` | 后写者覆盖先写者字段（丢 `documentsDir`/`fontScale`/`override`）；同一 tmp 交替 O_TRUNC 可 torn JSON；损坏后有损恢复 | `.tmp` 加 pid/随机串；ArkTS 单写者 + IPC；写前重读、只改自己的键；损坏时备份并重建 |
| STO-09 | 触摸模式 `vault-open` 在创建新窗口之前 `destroy()` 其它所有窗口；失败无回滚；`destroy()` 跳过 beforeunload；`__vrTouch` 忽略 override（确定） | 约 L2991-3066；第 106 轮有真实启动失败链 | 新窗口创建失败 → 旧窗已销毁、无窗口；最后 2s 防抖编辑可能丢；PC 模式 override=touch 时两套回收机制判定不一致 | 先新窗成功后再收旧窗（`browser-window-created`）；失败恢复/提示；`__vrTouch` 与渲染层统一 override 优先 |
| IO-01 | 入站安全门 S1 三条绕过：①路径样 text/url 提升 fileUris 不过门；②`file://<bundle>/...` 不校验 authority 是否本应用；③平铺 `file:///storage/.../Documents` 一律放行（确定门缺失，端到端待真机） | `DragParamManager.ets:382-516`；`WebAbility.ets:2820-2838,2695-2727` | 任意应用可让 OHSidian 代读自身 sandbox / Documents 文件并作为附件插入（可能随同步外传）；本应用私有文件（`obsidian.json`、`ohsidian-protocol.json`、回退态整个仓库）可被复制进仓库 | 统一 `UriGuard`：authority 非空时必须是外部 bundle；resolve 后拒绝自身 sandbox/appdata//data/storage；平铺 `/storage` 要求本次会话显式授予；文本提升只接受系统受管记录 |
| IO-02 | `DragDropAdapter.startDrag` 早退不清理 `dragSourceWindowId`（确定） | `DragDropAdapter.ets:70-80,110-115,177-190` | 之后所有外部拖拽被误判“本地”，跳过 sanitize → 拖入静默失效/变“打开链接”弹窗；难复现 | 入口先 `clearDragParam()`；每个 return 前清理；改用带 id 的会话对象 + 超时兜底 |
| IO-03 | `openPermissionConfirm` 无 activeContext 时直接 return 不回调（确定） | `PermissionManagerAdapter.ets:308-315` | 渲染层权限 Promise 永久 pending（相机/麦克风/粘贴板流程挂死） | 所有 early return 前 `callback(ERROR)`；callback 包 once |
| IO-04 | FilePicker 媒体副本在 UI 线程同步 `copyFileSync`，最多 500 个（确定） | `FilePickerAdapter.ets:48,78-80,140-194` | 多选相册/大视频 → 冻结数秒到数十秒/ANR；tempDir 无配额膨胀 | 改 `await fs.copyFile`；限单文件/总量；失败返回结构化错误 |
| UX-01 | 默认仓库覆盖监听器可能被引擎同频道监听器覆盖（静态推演，**待 30 秒真机判定**） | 补丁在 `app.on("ready")` 注册；引擎监听器在 `app.whenReady().then` 内注册（后者后注册、后写 `returnValue`） | 若成立：快速开始默认仓库退回 `<Documents>/Obsidian Vault`（第 38 轮实证不可写 → “folder not found”复发）或旧 userData 行为 | 不依赖监听器顺序：在 `vault-open` 前按 `documentsDirGranted` 幂等重写路径；或注册在引擎首次写入之后 |
| UX-02 | 拒绝文档权限 = 静默降级沙箱、卸载即丢数据，README 未写默认仓库/权限后果（确定） | README/README_EN 全文无“卸载/默认仓库”说明；`CHANGES-2026-09.md:1927-1929` 承诺“README 后续补充”，未兑现 | 用户以为“装完就安全”，实际取决于一次授权 | README 增加“仓库位置与卸载”小节；权限 reason 写明后果 |
| UX-03 | 删除弹窗“实际去向”只判 `documentsDir` 存在不判可写（确定） | `__ohsidianTrashNote` 约 L1980-1995；`trashLocal` 失败静默回退 | 弹窗可能“骗人”；用户按提示去文件管理找不到（与 STO-01/02 同一条链） | 与 STO-01/02 一起修：可写探测 + 真实去向 Notice |

### 3.3 P2（汇总）

| 编号 | 问题 | 证据/位置 | 影响 |
|---|---|---|---|
| SEL-06 | 另存为 `'file://docs'+dir_name` 无校验；`handleDefaultPath` 对沙箱路径盲加前缀；MIXED 模式选目录不持久化；`title`/`buttonLabel` 被丢弃 | `FilePickerAdapter.ets:113-116`；`DialogAdapter.ets:168-172,194-197,254/260/265` | 保存失败被当“取消”；选择器无标题无法区分场景；“移动仓库”遇到沙箱路径会报错 |
| SEL-07 | 权限元数据卫生：`usedScene.abilities` 含不存在的 `FormAbility`；`READ_WRITE_DESKTOP_DIRECTORY` 声明但全仓无请求/使用；reason 文案未说明后果 | `web_engine/src/main/module.json5:47-88`；`PermissionManagerAdapter.ets:86-88` | 上架材料/权限审查信息错误；用户看到一个永不使用的敏感目录权限 |
| IO-05 | 临时副本生命周期：`drag-in` 无单文件/总量上限、失败留半文件、同毫秒同名可覆盖、只在“下一次外部落点”清理；picker 的 `tempDir` 副本无任何清理、无 TRUNC/EXCL、TOCTOU、文件名未净化 | `DragParamManager.ets:445-561`；`FilePickerAdapter.ets:140-194` | 缓存/临时目录膨胀；极端并发下附件内容错乱；半文件 |
| IO-06 | 回调契约：`checkPermissions` 的 `await` 在 try 外；`MediaAdapter.getPreviewSurfaceId` catch 不回调；成功回调抛错触发链尾 catch 二次回调；Screenshot 路径同时泄漏 PixelMap | `PermissionManagerAdapter.ets:178-206`；`MediaAdapter.ets:59-66`；`FilePickerAdapter/DialogAdapter/ScreenshotAdapter` 的 `.then(...).catch(...)` | 渲染层 Promise 悬空/双完成；相机预览卡“准备中” |
| IO-07 | `TrashAdapter` 无仓库/`.obsidian`/sandbox 边界，失败以 `false` 而非 reject；`'file://docs'+path` 直接拼接；`convertUrisToPaths` 失败回退原始 URI；`getFilterArray` 无 try | `TrashAdapter.ets:46-89`；`DialogAdapter.ets:244-295`；`FilePickerAdapter.ets:196-214` | 非仓库文件/配置可被系统回收；调用方误判成功；非法输入让对话框调用无回调 |
| IO-08 | MessageBox 的 PixelMap 与注册表条目永不释放（`removeMessageBox` 全仓无调用者）；`DragDropAdapter.pixmap` 覆盖/重复 release | `DialogAdapter.ets:105-132,297-316`；`AbilityManager.ets:151-159`；`WebWindow.ets:206-220`；`DragDropAdapter.ets:48,288-296` | 每次弹框/每窗口泄漏原生像素内存；最终 OOM |
| IO-09 | 原生视频缩略图写面：renderer 可指定 `filesDir` 内 `thumbFile`（仅校验前缀/`..`）；文件轮询通道无 token | `electron/src/main/ets/pages/Index.ets`（快照约 L293-351、L182-198、L453-465） | 与“渲染层已有 Node fs”重叠，提权有限；未来配置解析放宽时可被利用 |
| IO-10 | 出站拖拽 / `openVerifiedItem` 无仓库/沙箱边界，且携带 `FLAG_AUTH_WRITE_URI_PERMISSION` | `DragDropAdapter.ets:173-186`；`FileManagerAdapter.ets:69-81` | 恶意/有 bug 插件可把 sandbox/任意可读文件拖/打开给其他应用并附写权限 |
| STO-10 | `console.log` 写 `<Documents>/OHSidian/`（与默认仓库同父目录）；轮转 rename 失败静默可无限增长；路径缓存不失效；capture 含路径/URL/插件输出 | 约 L2887-2926 | 用户可见目录被日志污染/被云备份；敏感信息面（opt-in 缓解） |
| STO-11 | 迁移/路径边界：`stat` 跟随符号链接（无深度/条目上限）、`inSandbox` 字符串前缀、vault 名清洗可冲突（`a/b` 与 `a_b` 同根）、一键迁移无 dest-inside-src 守卫 | 约 L2521-2577；`hookTrash` 约 L2033-2061 | 软链导致无限递归/越界拷贝；回收站混用/恢复路径歧义 |
| STO-12 | 删除承诺覆盖有限：插件可直接 `adapter.remove`/`vault.delete`/`shell.trashItem`，绕过统一步骤且不盖时间戳 | `hookTrash` 只包装 `v.trash`/`ad.trashLocal`；resfile `app/main.js:126-192` | README“绝不直接永久删除”只对核心 UI 成立 |
| STO-13 | `obsidian.json` 由引擎非原子写，purge 读取 parse 失败会跳过该轮（fail-safe）；`verify-asar.cjs` 仍断言 patch v21 而源码 v22（可能并行会话在修） | 引擎 asar main.js；`scripts/verify-asar.cjs` | 清理静默失效；新构建 verify 可能失败 |
| UX-04 | `docs/tablet-demo.md:86-88` 说删除“强制进仓库 `.trash`”，与 README/代码（文档/OHSidianTrash）直接冲突；README 迁移描述过时；版本号 1.0.0 vs 1.3.0；“与仓库平级”不准确；30 天计龄描述自相矛盾；TODO 无文件管理条目 | README.md/README_EN.md/tablet-demo/TODO | 评审/新用户被误导；最重要的数据安全承诺不可发现 |
| UX-05 | 收兄弟窗口靠 URL 子串白名单（`starter.html\|help\|sandbox\|devtools`），无法区分 popout/插件窗口；只在 `systemMode==="touch"` 生效，忽略 `override` | 约 L2387-2461、L3036-3058 | 触摸模式下插件独立窗口被静默 destroy（未落盘状态丢）；锁定“始终桌面”后旧症状回归 |
| UX-06 | `vault-open` 失败只显示引擎原始错误串（“Failed to open vault folder not found.”） | starter.js；约 L2570 | 用户没有下一步（检查权限/重选/用默认目录） |

> 注：以上 P2 的完整证据、代码片段与逐条修复建议见四份子报告；本表只做去重后的汇总。

---

## 4. 分主题补充说明

### 4.1 回收站与迁移（数据安全，优先级最高）

当前设计有三层“回收站语义”并存，彼此不一致：

1. **应用内删除 UI** → `v.trash(file,false)` → 补丁替换的 `ad.trashLocal` → 尝试搬到 `文档/OHSidianTrash/<vault>/<rel>`；
2. **回退分支** → 引擎原生 `trashLocal` → 仓库内 `.trash`（无时间戳）；
3. **原生 `TrashAdapter`** → `fileManagerService.deleteToTrash` → 系统回收站（核心路径当前不走它）；
4. **resfile `app/main.js` 的 `shell.trashItem` 包装** → 也放仓库 `.trash`（无时间戳）。

四条路径的“计龄/可见性/可恢复性”都不同，但 UI 和 README 只按最理想的一条描述。建议做一次收敛：

- 定义一个 `moveToTrash(vault, rel)` 单一实现（同盘 rename；跨盘 copy+unlink；统一 utimes/meta；冲突递增；调用 `reconcileInternalFile`；失败返回结构化错误）；
- `hookTrash`、`shell.trashItem` 包装、`adapter.remove` 兜底都调用它；
- purge 只清“带 owner marker/清单”的根，且跳过最近 10 分钟条目；
- 删除对话框文案与 Notice 都从同一“可写探测”结果生成。

### 4.2 默认仓库与权限

- 默认仓库的**唯一事实源**目前是渲染层 `get-default-vault-path` 的返回值，而它是“两个 `ipcMain.on` 监听器谁后写谁赢”的竞态（UX-01）。建议改成幂等重定向：在 `vault-open` 之前由渲染层按 `cfg.documentsDirGranted && cfg.documentsDir` 重写路径，或让 ArkTS 直接在主进程注册**唯一**处理器并移除引擎的默认行为依赖。
- 文档目录权限的“判定/发布/使用”三处目前没有统一契约：ArkTS 不判定、模式文件不发布 granted、渲染层靠字段猜。补丁 A/D/E 是把这个契约补齐的最小集合。
- “卸载不丢数据”是有条件承诺：只有“文档权限已授予 + 仓库确实在 Documents”才成立。README 应无条件写明这一点，并在权限被拒时给出可见提示。

### 4.3 入站文件（拖拽/分享）安全边界

S1 门本身的设计意图是对的（`WebAbility.ets:2810-2819` 注释明确要阻止“任意应用把本应用私有文件诱导成附件插入并随同步外传”），但三条绕过说明“门只装在部分入口”：

1. `DragParamManager.sanitizeExternalDropData` 把 `text`/`url` 里的路径样字符串提升为 `fileUris`，不再经过 S1；
2. `isAcceptableSharedUri` 对 `file://<bundle>/...` 形态直接返回 true，不比较 `<bundle>` 是否本应用；
3. 平铺 `file:///storage/Users/currentUser/Documents/...` 一律放行，而本应用有 Documents 权限 → confused deputy。

建议抽一个 `UriGuard`，所有入口（`onNewWant`、share 参数、Share Kit records、UDMF records、文本提升、`ingestExternalContent`）统一调用；失败时保留原 text（让用户看到链接）而不是静默插入。端到端可利用性需要真机验证（`fs.openSync(自身 bundle URI)` 是否成功、viewData 是否可无交互直达），但**门缺失是确定的**。

### 4.4 模式文件、窗口与临时文件

- `ohsidian-mode.json` 是跨 ArkTS/渲染层/多窗口/多进程的共享状态，但写入方式是“读整个 JSON → 改一个键 → 写整个 JSON”，且两侧共用同一个 `.tmp` 文件名。丢 `documentsDir` 会连锁影响默认仓库/回收站/日志。最小修：`.tmp` 唯一化 + 只改自己的键 + 写前重读；根治：ArkTS 单写者。
- 触摸模式“单窗口”策略在窗口管理上有效，但 `vault-open` 的“先 destroy 再创建”没有失败回滚，且会销毁 popout/插件窗口；建议改为“新窗口成功后再收旧窗”，并用窗口身份（ArkTS 发布 `windowKind`）替代 URL 白名单。
- 临时文件：`drag-in` 有 24h 清理但只在“下一次外部落点”触发、无大小上限；picker 的 `tempDir` 副本完全没有清理。建议统一临时文件管理器（唯一命名、失败清理、单文件/总量配额、启动时清扫）。

### 4.5 UX 与文档一致性

| 文档 | 问题 | 建议 |
|---|---|---|
| `docs/tablet-demo.md:86-88` | 说删除“强制进入仓库 `.trash`”，与 README/代码（`文档/OHSidianTrash`）冲突 | 改为“先进入 文档/OHSidianTrash/；未授权或搬移失败回退仓库内 `.trash`” |
| `README.md:96` / `README_EN.md:94` | 迁移描述仍写“选择器授权的目录”，漏掉一键迁移 | 补一键分支与“纯复制、旧仓库不动”的说明 |
| `README.md:56` / `README_EN.md:56` | 版本仍写 1.0.0 / 1000000（实际 1.3.0 / 1030001） | 更新或改为“见 app.json5” |
| `README.md:149` | “该目录与仓库平级” | 实际是“与仓库的父目录平级”（`文档/OHSidianTrash` vs `文档/OHSidian/Obsidian Vault`） |
| `README.md:151` / `README_EN.md:149` | “按文件修改时间计算”与 30 天 sidecar 描述自相矛盾 | 统一为“删除时刻（sidecar/deletedAt），否则 mtime” |
| README 全文 | 没有“默认仓库在哪、拒绝权限会怎样、卸载是否丢数据” | 新增“仓库位置与卸载”小节 |
| `TODO.md` | 8 项全是窗口/键盘/字体，无文件管理条目 | 新增“文件管理/仓库位置”小节，把 SEL/STO/IO 的高优先项记入 |
| 权限 `string.json` | reason 只说“访问什么”，不说“为什么/拒绝后果” | 改为“用于把笔记库保存到 文档/OHSidian，卸载不会删除；拒绝则保存到应用私有目录，卸载会丢失” |
| CI | `verify-asar.cjs` 只断言补丁 marker，不校验合并 HAP 权限清单与 `starter.js` 契约 | 增加“HAP 权限包含 Documents/Persist”“starter picker 包装仍无 defaultPath”等断言（上游一变，本报告的落点结论就会失效但构建仍绿） |

---

## 5. 修复路线图（建议）

### Sprint 1 — 数据安全（先做，优先级最高）

1. STO-01/02：统一“带时间戳搬移”（rename → copy+unlink 兜底 → utimes/meta → reconcile；回退可见提示）。
2. STO-03：迁移目标守卫（不存在或空；二次确认；一键迁移检查目标已存在；partial + 原子 rename）。
3. STO-04：`__ohDvEnsure` 可写探测 + 明确回退提示；STO-05 的锁/flush/mtime 一并做。
4. STO-07：purge marker/清单 + 最近 10 分钟跳过 + 单实例锁；STO-06 的 reconcile 一并修。

### Sprint 2 — 选择器与权限（用户主诉）

5. SEL-01/02：补丁 A–C（`isPermissionGrantedSync` + `getDocumentsVaultRootUri` + `handleDefaultPath` 三级 + FilePicker 默认 URI）。
6. SEL-03/04 + UX-02：补丁 D/E（`documentsDirGranted`、清陈旧值、渲染层 5 处联动、权限拒绝提示/设置引导）。
7. SEL-05：`saveUris` union + 串行写 + activate 逐条降级。
8. UX-01：先做 30 秒真机判定；若成立，改为 `vault-open` 前幂等重定向，不依赖监听器顺序。

### Sprint 3 — 安全与稳定性

9. IO-01：统一 `UriGuard`，封三条绕过。
10. IO-02/03/04：拖拽状态清理、权限回调兜底、picker 异步复制/限额。
11. STO-08/09：mode 文件 `.tmp` 唯一化/单写者；vault-open 改“新窗成功后再收旧窗”。
12. IO-05/08：统一临时文件管理器；MessageBox PixelMap/注册表释放。

### Sprint 4 — UX/文档/CI

13. UX-04 的文档修正 + README “仓库位置与卸载”小节 + 权限文案。
14. UX-05/06：窗口身份替代 URL 白名单；vault-open 错误文案映射。
15. CI：合并 HAP 权限清单 + starter 契约 + picker 默认位置断言。

---

## 6. 真机验证清单（关键项）

> 前置：debug 构建，`hdc shell hilog | findstr /i "OHSidian Dialog Picker documents trash vault"`。

1. **首装 · 拒绝文档权限**：管理仓库 → 打开文件夹作为仓库 → 停在根目录；模式文件无 `documentsDir`、`documentsDirGranted:false`；应用提示“仓库将在应用私有目录，卸载会丢失”。
2. **首装 · 授予文档权限**：重启后同一入口 → 直接打开 `文档/OHSidian`；文件管理器可见。
3. **新建仓库**：默认 `文档/OHSidian`，创建后路径为 `文档/OHSidian/<名>`。
4. **撤销权限后重启**：选择器回根目录；删除提示回到“未授权文档目录… .trash”；无陈旧 `documentsDir`。
5. **回收站（沙箱仓库 + 已授权）**：删除一篇“内容 mtime 两个月前”的笔记 → 检查实际落点（Documents 还是 `.trash`）；等待 >60s 后重启 → 文件是否仍存在（验证 STO-02 是否被修）。
6. **迁移覆盖**：先建 `文档/OHSidian/<名>` 并放入一个不同内容的同名文件 → 从旧沙箱仓库执行迁移 → 是否二次确认/改名/覆盖（验证 STO-03）。
7. **默认仓库监听器（UX-01）**：清数据首装 → 快速开始 → 看 hilog `[OHSidian] default vault root` 与 `obsidian.json` 的 `path`：是 `文档/OHSidian/Obsidian Vault`、`文档/Obsidian Vault` 还是 userData？30 秒可判定。
8. **多仓库持久授权**：选 A、选 B → 杀进程重启 → 依次打开 A/B；`preferences/myStore` 的 `defaultDownloadUri` 是否含两条。
9. **入站安全门（IO-01）**：用测试应用 `startAbility` 传 `file:///storage/Users/currentUser/Documents/<测试文件>`、`file://com.mikannqaq.obsidian/data/storage/el2/base/files/obsidian.json`、以及 PlainText 形式的 sandbox 路径 → 是否会被拒绝（修复后）或插入为附件（修复前）。
10. **模式文件竞态（STO-08）**：PC 模式双窗口，同时拖动窗口（几何写入）+ 命令面板切字号/触屏模式 → `documentsDir`/`fontScale`/`override` 是否互相丢失。
11. **触屏切库失败回滚（STO-09）**：模拟新窗口创建失败（如目标路径不可写）→ 旧窗口是否还在、是否有提示。
12. **触摸模式 popout（UX-05）**：命令面板开一个 popout/插件窗口 → 再切换仓库 → popout 是否被静默销毁。

---

## 7. 附录

### 7.1 子报告与证据快照

- `.cache/audit-fm-2026-10-19/picker.md` — 选择器/权限链路，805 行，含二进制字符串证据与 ArkTS 补丁稿。
- `.cache/audit-fm-2026-10-19/storage.md` — 存储生命周期，246 行，含 Q1–Q7 逐条结论与流程图。
- `.cache/audit-fm-2026-10-19/io.md` — I/O 边界，618 行，含 26 条入口→校验→sink 信任边界表。
- `.cache/audit-fm-2026-10-19/ux.md` — UX/文档一致性，472 行，含权限矩阵与逐行文档改法。

四份子报告均在 `.cache/`（git 忽略），本报告是持久的汇总交付物；如需把子报告纳入仓库，可移到 `docs/audit-2026-10-19/`。

### 7.2 待设备验证项（不要当成结论）

1. `environment.getUserDocumentDir()` 在**未授权**时：抛错 / 返回空 / 返回路径？（决定 SEL-03 的触发条件与补丁 D 的必要性）
2. asar 主进程 Node `fs.accessSync('/storage/Users/currentUser/Documents')` 在未授权时是否抛 EACCES？（决定 UX-01/STO-04 的兜底是否可靠）
3. `DocumentSelectOptions.defaultFilePathUri` 传非法 URI 时 picker 是忽略还是 reject？（决定是否必须加重试）
4. `Lf.choose()`（移动端“选择文件夹”）是否真的落到 `FilePickerAdapter.ShowDirDocumentViewPicker`？
5. `fileShare.activatePermission` 批量行为：一条失效 URI 是否导致整批失败？（决定 SEL-05 的降级策略）
6. `defaultPath → default_path` 字段名：用 hilog `ShowOpenDialog <settings>` 行确认。
7. 沙箱 `/data/storage/...` 与 `/storage/Users/currentUser/Documents` 是否确实不同挂载（EXDEV）？（决定 STO-01 的实际触发面）
8. 引擎 `p()` 的 `no permission to access folder` 分支是否会在本场景出现（与 `folder not found` 区分）。

### 7.3 与既有审计的关系 / 已确认的正向项

- 既有 `docs/AUDIT-FIXES-2026-09-29.md` 已覆盖 F27（persist/activate 两段式命名）、F29/F30/F31/F32 等；本报告不重复“命名误导”类结论，SEL-05 只保留**覆盖式保存 + 批量失败**这一实质缺陷。
- 正向项（说明这套代码并非到处漏）：
  - HAP 权限合并正确（23 项含 Documents/Persist）；
  - `dirFilter` 的 fd 在 `finally` 中关闭；拖拽 `copyViaOpen` 也在 `finally` 关闭；
  - `hookTrash` 的 S2 containment（`resolve` + `trashRoot/<vault>` 前缀）是正确的越界防护；
  - JSON 解析失败基本都有兜底；`publishModeFileAtomic` 用 tmp+rename 保证单次写入原子；
  - 迁移命令的“目标在源内”检查（picker 分支）与“目标在仓库内拒绝”提示是正确的；
  - `TrashAdapter` 的候选 URI 顺序尝试在注释里明确“错误候选无害”，方向合理（但缺少边界校验，见 IO-07）。

---

## 8. 实施记录（2026-10-19，Sprint 1 + 2）

> 按本报告建议落地了 **Sprint 1（数据安全）** 与 **Sprint 2（选择器/权限链路）**。
> 原则：只改与文件管理直接相关的代码；先做不会更坏的数据保护；不删除任何用户数据、不改变现有仓库布局；
> 所有对 `update-obsidian.mjs` 的批量修改都通过“读取 → 8 处替换逐一唯一匹配 → 写入前重新校验 hash”的 CAS 脚本完成
> （备份：`.cache/audit-fm-2026-10-19/update-obsidian.before-safety-634d39147359.mjs`），避免与并行会话互相覆盖。

### 8.1 改动文件

| 文件 | 改动 |
|---|---|
| `web_engine/src/main/ets/adapter/PermissionManagerAdapter.ets` | 新增 `isPermissionGrantedSync()` / `getDocumentsVaultRootPath()` / `getDocumentsVaultRootUri()`；`saveUris()` 改为“队列内合并去重”；`activateFileAccessPersist()` 批量失败后逐条降级并剔除坏 URI；`fileAccessPersist()` 成功后才会落盘；`checkPermissions()` 全程 try/catch 且必定回调；`openPermissionConfirm()` 无 activeContext 时回调 `ERROR` |
| `web_engine/src/main/ets/adapter/DialogAdapter.ets` | `handleDefaultPath()` 改为“引擎有效默认 → 文档/OHSidian（有权限）→ 用户根目录”；新增 `tryResolveDirAndFile()`，拒绝沙箱/appdata 路径被拼成 `file://docs`；picker 失败时去掉默认 URI 重试一次；目录选择只在 persist 成功后记录 URI |
| `web_engine/src/main/ets/adapter/FilePickerAdapter.ets` | 移动端“选择文件夹”与“另存为”默认到 `文档/OHSidian`（有权限时）；`dir_name` 判空/判域/判存在，非法时回退文档默认；picker 失败时无默认路径重试一次；去掉与 persist 重复的 `saveUris` |
| `web_engine/src/main/ets/ability/WebAbility.ets` | `publishDocumentsDir()` 发布 `documentsDirGranted`，未授权时写入空 `documentsDir`（清陈旧值）；启动授权回调把真实 `granted` 传入发布 |
| `scripts/update-obsidian.mjs` | 见 8.2（回收站、迁移、默认仓库、purge、console、渲染层 granted 联动） |
| `scripts/verify-asar.cjs` | 修正 touch patch 版本断言（v21 → 任意数字，原先与实际 v22 漂移会让 verify 必失败）；新增 5 条本次补丁的标记断言 |
| `web_engine/src/main/resources/resfile/resources/app/obsidian.asar` | 用 `node scripts/refresh-app-patch.mjs` 重新注入补丁并重建（已通过 `verify-asar.cjs`） |
| `docs/AUDIT-FILE-MANAGEMENT-2026-10-19.md` | 本节 |

### 8.2 `update-obsidian.mjs` 的运行时补丁改动

1. **回收站统一搬移（STO-01/02）**：新增 `stampTree()`、`moveSync()`（`rename` 失败 → `copyFile/copyTree + unlink/remove`）、`uniqueDest()`、`ownerStamp()`；Documents 分支与仓库内 `.trash` 回退分支共用同一实现，**所有被移入回收站的文件/目录都会写入删除时间**（`utimes`，失败则写 `.ohsidian-trash-meta.json`）；回退时给出可见 Notice；移动完成后调用引擎的 `reconcileInternalFile(rel)`（补回原先被绕过的索引更新）。
2. **30 天清理（STO-07）**：只清理带 `.ohsidian-trash-owner.json` 标记的根（本功能创建的回收站）；跳过最近 10 分钟的条目（`rename → utimes` 竞态防护）；深度上限 16 → 64；清理文件时一并清理 sidecar；不再无差别清理用户/插件自建的 `.trash`。
3. **迁移（STO-03/05/11）**：目标“已存在且非空”直接拒绝（未写入任何文件）；一键迁移目标已存在时自动选用 `name (2)`/`(3)`；使用 `lstat` 并跳过符号链接（防递归/越界）；复制保留源 mtime；迁移前 flush 编辑器并有 300ms 沉降；`__ohsidianMigrating` 防重复点击；只有“本次新建的目标目录”在失败时回滚，用户已有的空目录不会被删除；迁移 picker 补 `defaultPath` 双保险。
4. **默认仓库（STO-04/UX-01）**：`__ohDvEnsure` 增加写探针，目录不可写时回退 userData 并输出分支日志（不再无条件打印误导日志）；`__ohDvResolve` 尊重 `documentsDirGranted === false`；监听器改为在 `setTimeout(0)` 注册（晚于引擎 `whenReady().then` 内的注册；若 Electron 同步 IPC 为“最后写入 returnValue 者胜”，本覆盖即生效；若为“首个胜”，行为与之前一致）。
5. **console.log（STO-10）**：仅当 `documentsDirGranted !== false` 时才写 `<Documents>/OHSidian`，否则落 userData。
6. **渲染层 granted 联动**：新增 `documentsDirPath(cfg)`，用于删除提示、回收站搬移、迁移入口、purge root 解析；旧模式文件（无 `documentsDirGranted` 字段）保持原有行为。

### 8.3 验证结果

| 验证 | 命令 / 方式 | 结果 |
|---|---|---|
| 补丁源语法 | `node --check scripts/update-obsidian.mjs` | ✅ 通过 |
| 两段补丁体语法 | 提取 `TOUCH_MODE_PATCH` / `MAIN_PROCESS_PATCH` 后 `new Function(body)` | ✅ 通过（125680 / 17909 字节） |
| asar 重建 + 新鲜进程校验 | `node scripts/refresh-app-patch.mjs` | ✅ `app.js` / `main.js` 语法 OK，全部 marker（含新增 5 条）通过 |
| ArkTS 编译 + HAP 打包 | `hvigorw assembleHap --mode module -p product=default`（`DEVECO_SDK_HOME=D:\program\DevEco Studio\sdk`） | ✅ `CompileArkTS` 成功，`BUILD SUCCESSFUL` |
| 产物 | `electron/build/default/outputs/default/*.hap` | ✅ 已重新生成 |
| 回收站逻辑仿真 | `.cache/test-trash-safety.mjs`：从补丁源中提取**真实的** `hookTrash()`，在临时目录上模拟 EXDEV、文档目录不可写、无授权、`..` 越界、同名重复删除 | ✅ 16/16 通过（时间戳、owner marker、reconcile、不回退 stock trashLocal 均验证） |
| 迁移逻辑仿真 | `.cache/test-migration-safety.mjs`：提取真实 `migrateVaultToVisibleFolder()`，验证同名已有副本不覆盖、自动 `(2)`、软链跳过、mtime 保留、非空 picker 目标拒绝 | ✅ 11/11 通过 |
| 清理逻辑仿真 | `.cache/test-purge-safety.mjs`：提取真实 `__ohTrashPurgeOnce`，验证 marker 门槛、最近 10 分钟跳过、sidecar 随文件删除、深层清理、无 marker 的 `.trash` 不受影响 | ✅ 8/8 通过 |

> 备注：ArkTS 编译输出的 `Classes cannot be used as objects`、`Function may throw exceptions` 等警告在本次改动前即大量存在，非本次引入；本次新增代码的 `fs`/`environment` 调用均已包在 try/catch 中。

### 8.4 行为变化与兼容性

- **删除**：正常路径仍然优先去 `文档/OHSidianTrash/<vault>/`；跨盘/权限失败时**一定**带删除时间回退仓库内 `.trash`，并弹出实际去向提示（文案已改为“优先/回退”双分支，不再无条件承诺 Documents）。
- **清理**：升级后，旧的 `OHSidianTrash` 与旧 `.trash` 在**没有 owner marker** 前不会被自动清理（更安全，但可能暂时保留旧文件）；下一次通过本版本删除时会创建 marker，此后按 30 天规则清理。
- **迁移**：不再合并进非空目录；一键迁移遇到同名会创建 `name (2)`，不会覆盖已有副本。
- **默认仓库**：有文档权限时快速开始目标为 `<Documents>/OHSidian/Obsidian Vault`（监听器顺序若如预期）；无权限时明确回退 userData 并记录日志。
- **选择器**：有文档权限时“打开文件夹作为仓库 / 新建仓库浏览位置 / 移动仓库 / 另存为”默认 `文档/OHSidian`；无权限保持用户根目录；引擎显式给出的有效默认路径仍被尊重；用户仍可自由导航到任意位置。

### 8.5 本次未做（仍按 Sprint 3/4）
- IO-01 入站安全门收敛（`UriGuard`）、IO-02 拖拽状态泄漏、IO-04 picker 异步复制/限额、IO-05/08 临时文件/像素内存。
- STO-08 模式文件 `.tmp` 唯一化/单写者、STO-09 `vault-open` 先建后收、STO-12 插件删除路径统一。
- 权限被拒后的可见引导 UI、README/tablet-demo/TODO/权限文案修正、CI 增加 HAP 权限清单与 starter 契约断言。
- 真机验证（尤其 UX-01 监听器顺序、EXDEV 是否真实触发、picker 对 `defaultFilePathUri` 的容错、批量 `activatePermission` 行为）。

### 8.6 提交范围说明（2026-10-19 commit）

本报告实施记录对应的提交**只包含文件管理工作流**（提交在第二次独立复审后 amend，包含 8.7 的 P0/P1 修复）：
- 提交的 `scripts/update-obsidian.mjs` 与 `web_engine/.../WebAbility.ets` 是 **HEAD + 本次文件管理改动（含第二次复审修复）**（提交 blob：`update-obsidian` SHA-256 `a1800eb52adf1115697768744e4414432a3659c377bd61aec06172e7f35e3aac`；`WebAbility` SHA-256 `a3b1d1800ef03cab4dcea61c604baffe9d6086053ffce2f7131e2af016bbd905`）。
- 工作区中另一并行会话的未提交改动 **rounds 108–110（内嵌 HEVC/原生视频覆盖层）** 保持未提交状态；因此提交树中的这两个文件不包含 `__ohsidianNativeVideoSeq`、`native overlay`、`xcomponentId` 发布等视频改动，也不包含其版本号/窗口 reaper 的未提交调整。
- 提交前已在**提交所用的补丁源**上重新执行 `node --check`、补丁体 `new Function` 语法检查与全部三套回归测试（23+13+9）并通过；ArkTS 编译/HAP 打包在当前工作区（含并行改动）上 `BUILD SUCCESSFUL`。
- 提交后工作区仍会显示并行会话的文件改动（`docs/CHANGES-2026-10.md`、`electron/.../Index.ets`、`module.json5`、`update-obsidian.mjs` 剩余 hunk、`WebAbility.ets` 剩余 hunk 等），这是预期状态。

### 8.7 第二次独立复审（提交后）发现的 P0/P1 与修复

提交 `ee812f5` 之后，独立复审子代理（只读，基于 staged/提交快照）返回 **2×P0 + 1×P1 + 7×P2**；已逐项复核并在同一提交（amend）中修复：

| 编号 | 级别 | 问题 | 修复 |
|---|---|---|---|
| A-1 | P0 | `safeCopyDir` 的“完成回调”被空目录分支当作全局完成（实测 59 次、首个在 61/824 文件），迁移在副本残缺时提示“已复制”并 `vault-open` | 每层目录独立 `doneDir`，空目录只完成父层；根 `walk` 调用一次 `finish`（含 `finished` 守卫）；“已复制”/`vault-open` 只在全部落盘后执行一次 |
| A-2 | P0 | 上述多次回调可造成“先成功后迟到错误”，`targetExisted=false` 时 `rmSync(target,{recursive})` 会删掉已经交给应用使用的新仓库 | 增加 `opened` 标志，`vault-open` 之后永不回滚；单次回调也消除了 success→error 路径 |
| A-3 | P1 | 回收站 containment 对“等于根”放行（`rel="."`/`a/..`），会把整个仓库 rename 进 `OHSidianTrash`（S2 防护回归） | 源必须是严格子路径（`base+sep` 前缀，拒绝相等）；目的允许等于 `targetRoot`（根级文件合法）但严格拒绝越界；空/非法 rel 直接拒绝，**不再交给无防护的 stock trashLocal** |
| A-4 | P2 | purge 的 `recentGuard` 用旧 mtime 判断，挡不住 rename→utimes 竞态；引擎回退搬移无时间戳落入已认领 `.trash` | 增加 `ctime` 10 分钟守卫；`localFallback` 调用引擎 `trashLocal` 后扫描 `.trash` 并给本次搬移的条目补盖删除时间（utimes/meta） |
| A-5 | P2 | 跨盘目录搬移 `copyTreeSync` 静默丢弃嵌套软链后删源 | 用 `readlinkSync + symlinkSync` 保留软链；平台不支持则抛错，回退同盘 `rename`（保留软链） |
| A-6 | P2 | `showSaveDialog` 丢文件名且无重试；`showOpenDialog` 的 `.then` 抛错会触发 `.catch` 重试 → 双弹窗 | 两个对话框都改为 `buildOptions/attempt` + `settled` 一次性 `finish`；save 同样支持无默认 URI 重试一次 |
| A-7 | P2 | `saveUris` 超限丢最新、`getUris` 非数组时 merge 抛错被吞、全失效列表永不清 | merge 时新 URI 优先（超限丢最旧）；`getUris` 校验数组；新增 `writeUrisExact()` 用存活列表（含空列表）覆盖，`activate` 用 `finished` 守卫并 `then(onOk,onErr)` 防双回调 |
| A-8 | P2 | owner marker 门槛使升级前旧 trash 在再删一次前不清理；`verify-asar` 版本断言放宽 | 保留 marker 策略（无新增误删），行为写入本节；`verify-asar` 增加 2nd-audit 四条断言（单次完成、严格 containment、fallback stamping、ctime 守卫） |

**修复后验证**：fixed patch source `node --check` ✅；回归仿真 **23（trash）+ 13（migration）+ 9（purge）= 45/45** 通过（新增：`rel="."` 拒绝、跨盘软链保留、迁移空目录只回调一次且 open 时副本完整/只 open 一次、ctime 竞态保护）；asar 重建 + `verify-asar`（含新断言）全绿；`hvigorw assembleHap` **BUILD SUCCESSFUL**。

---

*报告生成：2026-10-19 17:5x +08:00；实施记录追加于 2026-10-19 18:2x +08:00；提交范围说明与提交前复审追加于 2026-10-19 19:2x +08:00；第二次独立复审与修复追加于 2026-10-19 19:5x +08:00。审计/实施期间仓库存在并行编辑；引用行号请按函数名/片段重新定位。*
