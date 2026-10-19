/*
 * Copyright (c) 2023-2025 Haitai FangYuan Co., Ltd.
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this list of
 *    conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list
 *    of conditions and the following disclaimer in the documentation and/or other materials
 *    provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used
 *    to endorse or promote products derived from this software without specific prior written
 *    permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
 * OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
 * OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
 * ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { injectable, inject } from 'inversify';
import abilityAccessCtrl from '@ohos.abilityAccessCtrl';
import { Permissions } from '@ohos.abilityAccessCtrl';
import { BusinessError } from '@ohos.base';
import bundleManager from '@ohos.bundle.bundleManager';
import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';
import LaunchHelper from '../utils/LaunchHelper';
import { ContextAdapter } from './ContextAdapter';
import { fileShare } from '@kit.CoreFileKit';
import preferences from '@ohos.data.preferences';
import prompt from '@ohos.promptAction'
import { promptAction } from '@kit.ArkUI';
import { Want, common } from '@kit.AbilityKit';
import environment from '@ohos.file.environment';
import fs from '@ohos.file.fs';

const CONFIRM: number = 0;
const ERROR: number = -1;
const ACTIVATE_SUCCESS: number = 1;
const EMPTY_ARRAY: number = -1;
const TAG: string = 'PermissionManagerAdapter';
const REQUEST_PERMISSION_FAIL: number = -2;
const REQUEST_PERMISSION_SUCCESS: number = 0;
let dataPreferences: preferences.Preferences | null = null;
let options: preferences.Options = { name: 'myStore' };
// Serialize preference writes: two windows (or a picker result racing the
// startup activation) can call saveUris concurrently, and the previous
// read-modify-write silently dropped the other writer's URIs. The queue keeps
// every write ordered in this process.
let persistWriteQueue: Promise<void> = Promise.resolve();

interface ConfirmParams {
  title: string,
  content: string,
  label: string,
  confirm: string,
  cancel: string
}

@injectable()
export class PermissionManagerAdapter extends BaseAdapter {
  private readonly needPermissions: Map<string, Array<Permissions>> = new Map([
    ['location', [
      'ohos.permission.APPROXIMATELY_LOCATION',
      'ohos.permission.LOCATION',
    ]],
    ['microphone', [
      'ohos.permission.MICROPHONE',
    ]],
    ['camera', [
      'ohos.permission.CAMERA',
    ]],
    ['pasteboard', [
      'ohos.permission.READ_PASTEBOARD',
    ]],
    ['bluetooth', [
      'ohos.permission.ACCESS_BLUETOOTH',
    ]],
    ['directory_download', [
      'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
    ]],
    ['directory_desktop', [
      'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY',
    ]],
    ['directory_document', [
      'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
    ]],
    ['screen_capture', [
      'ohos.permission.CUSTOM_SCREEN_CAPTURE',
    ]]
  ]);
  // The system caps persisted URIs per app (500); keep a deliberate margin.
  private static readonly MAX_PERSIST_URIS: number = 100;
  private atManager: abilityAccessCtrl.AtManager;
  private tokenId: number = 0;
  private ctxAdapter: ContextAdapter;
  private isInitialized: boolean = false;
  private appLabelId: number = 0;
  private bundleName: string = 'com.huawei.ohos_electron';
  private bundleFlags = bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION |
                        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_METADATA;

  constructor(@inject(ContextAdapter) ctxAdapter: ContextAdapter) {
    super();
    this.ctxAdapter = ctxAdapter;
    this.atManager = abilityAccessCtrl.createAtManager();

    try {
      let data = bundleManager.getBundleInfoForSelfSync(this.bundleFlags);
      this.bundleName = data.name;
      this.tokenId = data.appInfo.accessTokenId;
      this.appLabelId =  data.appInfo.labelId;
    } catch (err) {
      let message = (err as BusinessError).message;
      LogUtil.error(TAG, `getBundleInfoForSelfSync failed.: ${message}`);
    }
  }

  @LogMethod
  requestPermissions(permissionType: string, callback: (granted: number) => void) {
    const permissions = this.needPermissions.get(permissionType);
    if (!permissions) {
      LogUtil.error(TAG, 'unsupported permission:' + permissionType);
      callback(REQUEST_PERMISSION_FAIL);
      return;
    }
    let activeContext = this.ctxAdapter.getActiveContext();
    if (!activeContext) {
      LogUtil.error(TAG, 'requestPermissions, no active context');
      callback(REQUEST_PERMISSION_FAIL);
      return;
    }
    this.requestPermissionsForContext(activeContext as common.UIAbilityContext,
      permissionType, callback);
  }

  // Startup requests fire before the renderer registers the active window -
  // ContextAdapter.getActiveContext() stays unset until setActiveWindow, so
  // the JSBind-bound requestPermissions above always fails with code=-2
  // during onWindowStageCreate. Those requests must carry the ability
  // context explicitly (this method is ArkTS-only, not exposed to JS).
  requestPermissionsForContext(context: common.UIAbilityContext,
    permissionType: string, callback: (granted: number) => void) {
    const permissions = this.needPermissions.get(permissionType);
    if (!permissions) {
      LogUtil.error(TAG, 'unsupported permission:' + permissionType);
      callback(REQUEST_PERMISSION_FAIL);
      return;
    }

    try {
      this.atManager.requestPermissionsFromUser(context, permissions || [])
        .then((data) => {
          let grantStatus: Array<number> = data.authResults;
          for (let i = 0; i < grantStatus.length; i++) {
            if (grantStatus[i] !== 0) {
              LogUtil.error(TAG, 'Request permissions is failed, err:' + JSON.stringify(data));
              callback(grantStatus[i]);
              return;
            }
          }
          callback(REQUEST_PERMISSION_SUCCESS);
        }).catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Request permissions is failed, type:' + permissionType +
        ', err:BusinessError: ' + JSON.stringify(err));
        callback(REQUEST_PERMISSION_FAIL);
      });
    } catch (err) {
      LogUtil.error(TAG, 'Request permissions is failed, type:' + permissionType +
      ', err:' + JSON.stringify(err));
      callback(REQUEST_PERMISSION_FAIL);
    }
  }

  @LogMethod
  async checkPermissions(permissionType: string, callback: (granted: boolean) => void): Promise<void> {
    try {
      const permissions = this.needPermissions.get(permissionType) as Array<Permissions>;
      if (!permissions || permissions.length === 0) {
        LogUtil.error(TAG, 'unsupported permission:' + permissionType);
        callback(false);
        return;
      }
      const bundleInfo: bundleManager.BundleInfo =
        await bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      const appInfo: bundleManager.ApplicationInfo = bundleInfo.appInfo;
      this.tokenId = appInfo.accessTokenId;
      for (let i = 0; i < permissions.length; i++) {
        const grantStatus: abilityAccessCtrl.GrantStatus =
          this.atManager.checkAccessTokenSync(this.tokenId, permissions[i]);
        if (grantStatus !== abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
          LogUtil.error(TAG, 'checkPermission error');
          callback(false);
          return;
        }
      }
      callback(true);
    } catch (err) {
      // getBundleInfoForSelf / checkAccessTokenSync used to reject this async
      // method while the renderer kept waiting for the callback - the whole
      // permission flow then hung. Always answer exactly once.
      LogUtil.error(TAG, `checkPermissions failed: ${JSON.stringify(err)}`);
      callback(false);
    }
  }

  // Synchronous grant check for callers that must decide BEFORE opening a
  // picker (the async checkPermissions above is JS-bound only). The token id
  // is refreshed because it can change across upgrades / multi-user setups.
  public isPermissionGrantedSync(permissionType: string): boolean {
    const permissions: Array<Permissions> | undefined = this.needPermissions.get(permissionType);
    if (permissions === undefined || permissions.length === 0) {
      return false;
    }
    try {
      const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      this.tokenId = info.appInfo.accessTokenId;
      for (let i = 0; i < permissions.length; i++) {
        if (this.atManager.checkAccessTokenSync(this.tokenId, permissions[i]) !==
          abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
          return false;
        }
      }
      return true;
    } catch (err) {
      LogUtil.error(TAG, `isPermissionGrantedSync failed: ${JSON.stringify(err)}`);
      return false;
    }
  }

  // <Documents>/OHSidian, the user-visible default vault root. Returns '' when
  // the Documents permission is missing or the directory is unusable. The
  // directory is created lazily because DocumentViewPicker's
  // defaultFilePathUri must point at an existing directory.
  public getDocumentsVaultRootPath(): string {
    if (!this.isPermissionGrantedSync('directory_document')) {
      return '';
    }
    let docs: string = '';
    try {
      docs = environment.getUserDocumentDir();
    } catch (err) {
      LogUtil.warn(TAG, `getUserDocumentDir failed: ${JSON.stringify(err)}`);
      return '';
    }
    if (!docs) {
      return '';
    }
    const base: string = docs.endsWith('/') ? docs.slice(0, docs.length - 1) : docs;
    const target: string = base + '/OHSidian';
    try {
      if (!fs.accessSync(target)) {
        fs.mkdirSync(target, true);
      }
      return target;
    } catch (err) {
      // Creating the subdirectory must never make the picker unusable: fall
      // back to the Documents root (still visible in 文件管理).
      LogUtil.warn(TAG, `create OHSidian dir failed, fall back to Documents: ${JSON.stringify(err)}`);
      return base;
    }
  }

  // docs-domain URI for DocumentSelectOptions/DocumentSaveOptions; '' means
  // "do not set defaultFilePathUri". Only paths under /storage/ can be
  // expressed as file://docs URIs.
  public getDocumentsVaultRootUri(): string {
    const path: string = this.getDocumentsVaultRootPath();
    if (!path || !path.startsWith('/storage/')) {
      return '';
    }
    return 'file://docs' + path;
  }

  @LogMethod
  public async initPermissions(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    this.activateFileAccessPersist(this.getUris(), (code) => {
      if (code === ACTIVATE_SUCCESS) {
        this.isInitialized = true;
      } else {
        LogUtil.error(TAG, 'No URI required for activation or activation failed');
      }
    });
  }

  @LogMethod
  public saveUris(uris: string[]) {
    // MERGE with the URIs already persisted. The previous implementation
    // replaced the single slot with the latest picker result, so selecting a
    // second folder silently dropped the first one's persisted permission
    // (multi-vault users then could not reopen the first vault after restart).
    persistWriteQueue = persistWriteQueue.then((): void => {
      try {
        // Merge INSIDE the queued write: two windows may otherwise compute
        // their merge from the same old snapshot and the later write would
        // drop the earlier window's URI.
        const merged: string[] = PermissionManagerAdapter.mergeUris(this.getUris(), uris);
        if (!dataPreferences) {
          dataPreferences = preferences.getPreferencesSync(this.ctxAdapter.getContext(), options);
        }
        if (!dataPreferences) {
          return;
        }
        dataPreferences.putSync('defaultDownloadUri', JSON.stringify(merged));
        dataPreferences.flush((err: BusinessError) => {
          if (err) {
            LogUtil.error(TAG, `Failed to flush. Code:${err.code}, message:${err.message}`);
            return;
          }
          LogUtil.info(TAG, 'Succeeded in flushing.');
        });
      } catch (err) {
        LogUtil.error(TAG, `Failed to save uris. Code:${err.code}, message:${err.message}`);
      }
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `saveUris queue failed: ${JSON.stringify(err)}`);
    });
  }

  // Replace the persisted list verbatim (used to prune dead URIs). Unlike
  // saveUris() this does NOT merge with the old list, so an empty list really
  // clears the preference instead of resurrecting dead entries forever.
  private writeUrisExact(uris: string[]) {
    persistWriteQueue = persistWriteQueue.then((): void => {
      try {
        if (!dataPreferences) {
          dataPreferences = preferences.getPreferencesSync(this.ctxAdapter.getContext(), options);
        }
        if (!dataPreferences) {
          return;
        }
        dataPreferences.putSync('defaultDownloadUri', JSON.stringify(uris));
        dataPreferences.flush((err: BusinessError) => {
          if (err) {
            LogUtil.error(TAG, `Failed to flush. Code:${err.code}, message:${err.message}`);
          }
        });
      } catch (err) {
        LogUtil.error(TAG, `Failed to write uris. Code:${err.code}, message:${err.message}`);
      }
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `writeUrisExact queue failed: ${JSON.stringify(err)}`);
    });
  }

  private static mergeUris(oldUris: string[], newUris: string[]): string[] {
    const out: string[] = [];
    const seen: Set<string> = new Set<string>();
    // New URIs first: when the list hits the cap the OLDEST entries are the
    // ones dropped, never the folder the user just picked.
    const all: string[] = newUris.concat(oldUris);
    for (let i = 0; i < all.length; i++) {
      const uri: string = all[i];
      if (!uri || seen.has(uri)) {
        continue;
      }
      seen.add(uri);
      out.push(uri);
      if (out.length >= PermissionManagerAdapter.MAX_PERSIST_URIS) {
        break;
      }
    }
    return out;
  }

  @LogMethod
  private getUris(): string[] {
    try {
      dataPreferences = preferences.getPreferencesSync(this.ctxAdapter.getContext(), options);
    } catch (err) {
      LogUtil.error(TAG, `Failed to get preference. Code:${err.code}, message:${err.message}`);
    }
    if (dataPreferences) {
      try {
        let uris: string = dataPreferences.getSync('defaultDownloadUri', '[]') as string;
        const parsed: Object = JSON.parse(uris);
        // A corrupted/legacy value must not make mergeUris() throw and
        // silently drop the new URI.
        return Array.isArray(parsed) ? parsed as string[] : [];
      } catch (err) {
        LogUtil.error(TAG, `Failed to get uris. Code:${err.code}, message:${err.message}`);
      }
    }
    return [];
  }

  @LogMethod
  public activateFileAccessPersist(uris: string[], callback: (code: number) => void) {
    if (uris.length === 0) {
      LogUtil.error(TAG,'No URI required to activate');
      callback(EMPTY_ARRAY);
      return;
    }
    let finished = false;
    const finish = (code: number): void => {
      if (finished) {
        return;
      }
      finished = true;
      callback(code);
    };
    fileShare.activatePermission(this.buildPolicies(uris)).then(() => {
      finish(ACTIVATE_SUCCESS);
    }, (err: BusinessError<Array<fileShare.PolicyErrorResult>>) => {
      // One stale/revoked URI used to reject the whole batch, leaving EVERY
      // persisted folder unactivated for the session. Retry one URI at a time
      // and rewrite the preference list with the survivors (including an empty
      // list, otherwise a dead list is retried forever on every launch).
      LogUtil.warn(TAG, `batch activate failed, degrading per-uri: ${JSON.stringify(err)}`);
      const alive: string[] = [];
      let pending: number = uris.length;
      const done = (): void => {
        pending--;
        if (pending === 0) {
          if (alive.length !== uris.length) {
            this.writeUrisExact(alive);
          }
          finish(alive.length > 0 ? ACTIVATE_SUCCESS : EMPTY_ARRAY);
        }
      };
      uris.forEach((uri: string) => {
        fileShare.activatePermission(this.buildPolicies([uri]))
          .then(() => {
            alive.push(uri);
            done();
          }, (uriErr: BusinessError) => {
            LogUtil.error(TAG, `drop bad persisted uri: ${uri} ${JSON.stringify(uriErr)}`);
            done();
          });
      });
    });
  }

  private buildPolicies(uris: string[]): Array<fileShare.PolicyInfo> {
    const policies: Array<fileShare.PolicyInfo> = [];
    for (let i = 0; i < uris.length; i++) {
      policies.push({
        uri: uris[i],
        operationMode: fileShare.OperationMode.READ_MODE |
          fileShare.OperationMode.WRITE_MODE,
      });
    }
    return policies;
  }

  @LogMethod
  public fileAccessPersist(uris: string[]) {
    if (uris.length === 0) {
      LogUtil.error(TAG, 'No URI needs to be persisted');
      return;
    }
    // Persist FIRST and only record the URI after the system accepted it:
    // the previous fire-and-forget + unconditional saveUris() left the
    // preference list claiming a permission that was never persisted.
    fileShare.persistPermission(this.buildPolicies(uris))
      .then(() => {
        this.saveUris(uris);
      })
      .catch((err: BusinessError<Array<fileShare.PolicyErrorResult>>) => {
        LogUtil.error(TAG, `fileAccessPersist failed: ${JSON.stringify(err)}`);
      });
  }

  @LogMethod
  openPermissionConfirm(type:string, callback: Function) {
    LogUtil.info(TAG, `permision type is: ${JSON.stringify(type)}`);
    let activeContext = this.ctxAdapter.getActiveContext();
    if (!activeContext) {
      LogUtil.error(TAG, 'openPermissionConfirm, Failed to get active context');
      // The renderer awaits this callback; a silent return left the permission
      // Promise pending forever (camera / microphone / pasteboard flows).
      callback(ERROR);
      return;
    }
    let confirmParams: ConfirmParams = {
      title: '',
      content: '',
      label: '',
      confirm: '',
      cancel: ''
    };
    switch(type) {
      case "pasteboard":
        this.openPasteboardPermissionConfirm(activeContext, confirmParams);
        break;
      default:
        break;
    }
    if (!confirmParams.title||!confirmParams.content) {
      // Only pasteboard has a confirm dialog today. Every other type MUST
      // still callback - the renderer blocks waiting for the result, and a
      // silent return here hung the whole permission flow (camera, mic...).
      LogUtil.error(TAG, 'openPermissionConfirm, no dialog for type ' + type);
      callback(ERROR);
      return;
    }
    this.openPermissionConfirmDialog(activeContext, confirmParams, callback);
  }

  private openPasteboardPermissionConfirm(activeContext: Context, pasteboardConfirmParams: ConfirmParams) {
    pasteboardConfirmParams.title = activeContext.resourceManager.getStringSync($r("app.string.pasteBoard_dialog_title").id);
    pasteboardConfirmParams.content = activeContext.resourceManager.getStringSync($r("app.string.pasteBoard_dialog_content").id);
    pasteboardConfirmParams.label = activeContext.resourceManager.getStringSync(this.appLabelId);
    pasteboardConfirmParams.content = pasteboardConfirmParams.content.replace("label", pasteboardConfirmParams.label);
    pasteboardConfirmParams.confirm = activeContext.resourceManager.getStringSync($r("app.string.dialog_confirm_button").id);
    pasteboardConfirmParams.cancel = activeContext.resourceManager.getStringSync($r("app.string.dialog_cancel_button").id);
  }

  private async openPermissionConfirmDialog(activeContext: Context, confirmParams: ConfirmParams, callback: Function) {
    promptAction.showDialog({
      title: confirmParams.title,
      message: confirmParams.content,
      buttons: [
        {
          text: confirmParams.confirm,
          color: '#000000'
        },
        {
          text: confirmParams.cancel,
          color: '#000000'
        }
      ],
    }).then(data => {
      if (data.index === CONFIRM) {
        let wantInfo: Want = {
          bundleName: 'com.huawei.hmos.settings',
          abilityName: 'com.huawei.hmos.settings.MainAbility',
          uri: 'application_info_entry',
          parameters: {
            pushParams: this.bundleName
          }
        }
        LaunchHelper.Launch(activeContext, wantInfo);
      }
      callback(data.index);
    }).catch((err: Error) => {
      callback(ERROR);
      LogUtil.error(TAG, `showDialog failed, caused by:${JSON.stringify(err)}`);
    });
  }
}
