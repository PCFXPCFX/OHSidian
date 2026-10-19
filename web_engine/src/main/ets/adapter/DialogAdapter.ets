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

import fs from '@ohos.file.fs';
import fileUri from '@ohos.file.fileuri';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';
import picker from '@ohos.file.picker';

import { AbilityManager } from '../common/AbilityManager';
import { BaseAdapter } from '../common/BaseAdapter';
import { BusinessError } from '@ohos.base';
import { image } from '@kit.ImageKit';
import { inject, injectable } from 'inversify';
import { ContextAdapter } from './ContextAdapter';
import { PermissionManagerAdapter } from './PermissionManagerAdapter';

const TAG: string = 'Dialog';

interface IMessageBoxSettings {
  parent_id: number,
  type: string,
  title: string,
  message: string,
  detail: string,
  checkbox_label: string,
  checkbox_checked: boolean,
  cancel_id: number,
  default_id: number,
  buttons: string[]
}

interface IFilter {
  name: string,
  extensions: string[]
}

interface IOpenDialogSettings {
  parent_id: number,
  title: string,
  message: string,
  button_label: string,
  default_path: string,
  filters: IFilter[],
  properties_open_directory: boolean,
  properties_open_mixed: boolean,
  properties_multi_selections: boolean
}

export interface IMessageBoxParams {
  messageBoxSettings: IMessageBoxSettings | undefined,
  icon: image.PixelMap | undefined,
  callback: (buttonId: number, checkboxChecked: boolean) => void
}

export interface MessageBoxData {
  id: string,
  dialogController: CustomDialogController,
  setMessageBoxParams: (messageBoxParams: IMessageBoxParams) => void;
}

@injectable()
export class DialogAdapter extends BaseAdapter {
  private abilityManager: AbilityManager = new AbilityManager();
  private static PATH_PREFIX: string = 'file://docs'; 
  private static DEFAULT_DIR: string = 'file://docs/storage/Users/currentUser';
  // Only paths under the docs-domain root can be expressed as file://docs
  // URIs. The app's own sandbox (/data/storage/... and the appdata mount) can
  // NOT, so mapping them produced an invalid picker default.
  private static DOCS_DOMAIN_ROOT: string = '/storage/';
  private static APPDATA_PREFIX: string = '/storage/Users/currentUser/appdata/';
  private static MAX_SELECT_NUMBER: number = 500;
  private ctxAdapter: ContextAdapter;
  private permissionManagerAdapter: PermissionManagerAdapter;
  private allFIleDescriptionId: number = $r("app.string.upload_all_file_description").id;

  constructor(@inject(ContextAdapter) ctxAdapter: ContextAdapter,
    @inject(PermissionManagerAdapter) permissionManagerAdapter: PermissionManagerAdapter) {
    super();
    this.ctxAdapter = ctxAdapter;
    this.permissionManagerAdapter = permissionManagerAdapter;
  }

  @LogMethod
  showMessageBox(settings: string, buffer: ArrayBuffer, width: number, height: number,  callback: (button_id: number, checkbox_checked: boolean) => void) {
    LogUtil.info(TAG, 'messagebox settings ' + settings);
    let icon: image.PixelMap | undefined = this.convertImagePixelMap(width, height, buffer);
    let boxSettings: IMessageBoxSettings;
    try {
      boxSettings = JSON.parse(settings) as IMessageBoxSettings;
    } catch (err) {
      LogUtil.error(TAG, 'messagebox settings parse failed: ' + JSON.stringify(err));
      callback(-1, false);
      return;
    }
    let params: IMessageBoxParams = {
      messageBoxSettings: boxSettings,
      icon: icon,
      callback: callback
    };
    LogUtil.error(TAG, 'parentId ' + boxSettings.parent_id);
    let parentId = boxSettings.parent_id === -1 ? 1 : boxSettings.parent_id;
    let messageBoxManager: MessageBoxData | undefined = this.abilityManager.getMessageBox(parentId);
    if (messageBoxManager === undefined) {
      LogUtil.error(TAG, 'messageBoxManager not found for parentId ' + parentId);
      callback(-1, false);
      return;
    }
    messageBoxManager.setMessageBoxParams(params);
    messageBoxManager.dialogController.open();
  }

  @LogMethod
  showErrorBox(title: string, content: string, callback: (result: boolean) => void) {
    let isClicked = false;
    AlertDialog.show({
      title: title,
      message: content,
      autoCancel: false,
      cancel: () => {},
      primaryButton: {
        value: $r('app.string.button_ok'),
        style: DialogButtonStyle.HIGHLIGHT,
        action: () => {
          if (isClicked) {
            return;
          }
          isClicked = true;
          callback(true);
        },
      }
    });
  }

  @LogMethod
  showOpenDialog(settings: string, callback: (filePaths: string[], canceled: boolean) => void) {
    LogUtil.info(TAG, 'ShowOpenDialog ' + settings);
    let dialogSettings: IOpenDialogSettings;
    try {
      dialogSettings = JSON.parse(settings) as IOpenDialogSettings;
    } catch (err) {
      LogUtil.error(TAG, 'ShowOpenDialog settings parse failed: ' + JSON.stringify(err));
      callback([], true);
      return;
    }
    const context = this.ctxAdapter.getContext();
    let allFileDescription = context.resourceManager.getStringSync(this.allFIleDescriptionId);
    let dirAndFile: string[] = this.handleDefaultPath(dialogSettings.default_path);
    LogUtil.info(TAG, 'showOpenDialog dirAndFile: ' + `${dirAndFile[0]}-${dirAndFile[1]}`);

    const buildOptions = (useDefaultPath: boolean): picker.DocumentSelectOptions => {
      let options = new picker.DocumentSelectOptions();
      if (dialogSettings.properties_open_directory) {
        options.selectMode = picker.DocumentSelectMode.FOLDER;
        if (dialogSettings.properties_open_mixed) {
          options.selectMode = picker.DocumentSelectMode.MIXED;
        }
      }
      if (dialogSettings.properties_multi_selections) {
        options.maxSelectNumber = DialogAdapter.MAX_SELECT_NUMBER;
      }
      if (dialogSettings.filters && dialogSettings.filters.length > 0) {
        options.fileSuffixFilters = this.getFilterArray(dialogSettings.filters);
      } else {
        options.fileSuffixFilters = [allFileDescription + "|.*"];
      }
      if (useDefaultPath && dirAndFile[0]) {
        options.defaultFilePathUri = dirAndFile[0];
      }
      return options;
    };

    let settled = false;
    const finish = (filePaths: string[], canceled: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      callback(filePaths, canceled);
    };

    const attempt = (useDefaultPath: boolean): void => {
      let documentPicker = new picker.DocumentViewPicker();
      documentPicker.select(buildOptions(useDefaultPath))
        .then((DocumentSelectResult: Array<string>) => {
          if (settled) {
            return;
          }
          try {
            LogUtil.info(TAG, 'DocumentViewPicker.select successfully, DocumentSelectResult uri: ' +
              JSON.stringify(DocumentSelectResult));
            if (DocumentSelectResult.length === 0) {
              finish([], true);
              return;
            }
            let filePaths = this.convertUrisToPaths(DocumentSelectResult);
            // 持久化文件夹访问权限，下次打开无需重复授权（persist 成功后才落盘）
            if (dialogSettings.properties_open_directory) {
              this.permissionManagerAdapter.fileAccessPersist(DocumentSelectResult);
            }
            finish(filePaths, false);
          } catch (err) {
            // The renderer callback must never be invoked twice: a throw here
            // used to fall into the .catch below and open a SECOND picker.
            LogUtil.error(TAG, 'showOpenDialog completion failed: ' + JSON.stringify(err));
            finish([], true);
          }
        }).catch((err: BusinessError) => {
          if (settled) {
            return;
          }
          LogUtil.error(TAG, 'DocumentViewPicker.select failed with err: ' + JSON.stringify(err));
          if (useDefaultPath && dirAndFile[0]) {
            // A stale default URI must never make the picker unusable: retry
            // once at the system default location instead of reporting cancel.
            LogUtil.warn(TAG, 'retrying picker without defaultFilePathUri');
            attempt(false);
            return;
          }
          finish([], true);
        });
    };
    attempt(true);
  }

  @LogMethod
  showSaveDialog(settings: string, callback: (filePath: string, canceled: boolean) => void) {
    LogUtil.info(TAG, 'ShowSaveDialog ' + settings);
    let dialogSettings: IOpenDialogSettings;
    try {
      dialogSettings = JSON.parse(settings) as IOpenDialogSettings;
    } catch (err) {
      LogUtil.error(TAG, 'ShowSaveDialog settings parse failed: ' + JSON.stringify(err));
      callback('', true);
      return;
    }
    const context = this.ctxAdapter.getContext();
    let allFileDescription = context.resourceManager.getStringSync(this.allFIleDescriptionId);
    let dirAndFile: string[] = this.handleDefaultPath(dialogSettings.default_path);
    LogUtil.info(TAG, 'ShowSaveDialog dirAndFile: ' + `${dirAndFile[0]}-${dirAndFile[1]}`);
    let settled = false;
    const finish = (filePath: string, canceled: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      callback(filePath, canceled);
    };
    const buildOptions = (useDefaultPath: boolean): picker.DocumentSaveOptions => {
      let options = new picker.DocumentSaveOptions();
      options.newFileNames = [`${dirAndFile[1]}`];
      if (useDefaultPath && dirAndFile[0]) {
        options.defaultFilePathUri = dirAndFile[0];
      }
      if (dialogSettings.filters && dialogSettings.filters.length > 0) {
        options.fileSuffixChoices = this.getFilterArray(dialogSettings.filters);
      } else {
        options.fileSuffixChoices = [allFileDescription + "|.*"];
      }
      return options;
    };
    const attempt = (useDefaultPath: boolean): void => {
      let documentPicker = new picker.DocumentViewPicker();
      documentPicker.save(buildOptions(useDefaultPath)).then((DocumentSaveResult: Array<string>) => {
        if (settled) {
          return;
        }
        try {
          LogUtil.info(TAG, 'DocumentViewPicker.save successfully, DocumentSaveResult uri: ' +
            JSON.stringify(DocumentSaveResult));
          if (DocumentSaveResult.length === 0) {
            finish('', true);
            return;
          }
          let filePaths = this.convertUrisToPaths(DocumentSaveResult);
          finish(filePaths[0], false);
        } catch (err) {
          LogUtil.error(TAG, 'showSaveDialog completion failed: ' + JSON.stringify(err));
          finish('', true);
        }
      }).catch((err: BusinessError) => {
        if (settled) {
          return;
        }
        LogUtil.error(TAG, 'DocumentViewPicker.save failed with err: ' + JSON.stringify(err));
        if (useDefaultPath && dirAndFile[0]) {
          // Same stale-default protection as showOpenDialog: retry without the
          // default URI instead of silently reporting "canceled".
          LogUtil.warn(TAG, 'retrying save picker without defaultFilePathUri');
          attempt(false);
          return;
        }
        finish('', true);
      });
    };
    attempt(true);
  }

  // Resolve the engine-provided default path only when it can actually be
  // expressed in the docs domain. Returns undefined for undefined/empty
  // input, sandbox paths (/data/storage/...) and the appdata mount - those
  // used to be prefixed with file://docs and became invalid picker URIs.
  private tryResolveDirAndFile(default_path: string): string[] | undefined {
    let path: string = '';
    try {
      path = default_path.trim();
    } catch (err) {
      return undefined;
    }
    if (!path) {
      return undefined;
    }
    if (path.startsWith('file://')) {
      return [path, ''];
    }
    if (!path.startsWith(DialogAdapter.DOCS_DOMAIN_ROOT) ||
      path.startsWith(DialogAdapter.APPDATA_PREFIX)) {
      return undefined;
    }
    try {
      if (fs.accessSync(path)) {
        const stat = fs.statSync(path);
        if (stat.isDirectory()) {
          return [DialogAdapter.PATH_PREFIX + path, ''];
        }
        const fileIndex: number = path.lastIndexOf('/');
        return [DialogAdapter.PATH_PREFIX + path.slice(0, fileIndex), path.slice(fileIndex + 1)];
      }
      const dirIndex: number = path.lastIndexOf('/');
      const dirPath: string = path.slice(0, dirIndex);
      const fileName: string = path.slice(dirIndex + 1);
      if (dirPath && fs.accessSync(dirPath)) {
        // Save dialog: the target file does not exist yet, only its directory.
        return [DialogAdapter.PATH_PREFIX + dirPath, fileName];
      }
    } catch (err) {
      LogUtil.error(TAG, 'tryResolveDirAndFile failed with err: ' + JSON.stringify(err));
    }
    return undefined;
  }

  // Default location policy for directory pickers / save dialogs:
  //   1. an explicit, valid engine default (respect it - e.g. "move vault");
  //   2. granted Documents permission -> 文档/OHSidian (user-visible, survives
  //      uninstall); created lazily by PermissionManagerAdapter;
  //   3. otherwise the user root, so the user can choose freely.
  private handleDefaultPath(default_path: string): string[] {
    const fromEngine: string[] | undefined = this.tryResolveDirAndFile(default_path);
    if (fromEngine !== undefined) {
      return fromEngine;
    }
    const docsUri: string = this.permissionManagerAdapter.getDocumentsVaultRootUri();
    if (docsUri) {
      return [docsUri, ''];
    }
    return [DialogAdapter.DEFAULT_DIR, ''];
  }

  private getFilterArray(filters: IFilter[]): Array<string> {
    let copy = new Array<string>();
    for (const filter of filters) {
      copy.push(filter.name + "(*." + filter.extensions.join(";*.") + ")|." + filter.extensions.join(",."));
    }
    return copy;
  }

  private convertUrisToPaths(uris: string[]): string[] {
    let filePaths: string[] = [];
    uris.forEach((uri) => {
      try {
        let uriObj = new fileUri.FileUri(uri);
        filePaths.push(uriObj.path);
      } catch (err) {
        LogUtil.error(TAG, `convertUrisToPaths failed for uri ${uri}: ${JSON.stringify(err)}`);
        filePaths.push(uri);
      }
    });
    return filePaths;
  }

  private convertImagePixelMap(width: number, height: number, buff: ArrayBuffer): image.PixelMap | undefined {
    let pixmap: image.PixelMap;
    if (width === 0 || height === 0) {
      LogUtil.warn(TAG, 'image is empty, no conversion required');
      return undefined;
    }
    let opts: image.InitializationOptions = {
      size: {
        height: height,
        width: width
      }
    }
    try {
      pixmap = image.createPixelMapSync(buff, opts);
      return pixmap;
    } catch (error) {
      LogUtil.error(TAG, 'failed convert image pixel map because: ' +  JSON.stringify(error));
      return undefined;
    }
  }
}
