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

import { inject, injectable } from 'inversify';
import window from '@ohos.window';
import { IParams,
         ISubWindowInfo,
         NewWindowParam,
         SubWindowCancelToken,
         WindowBound } from '../interface/CommonInterface';
import { AbilityManager } from '../common/AbilityManager';
import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';
import { BusinessError } from '@kit.BasicServicesKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { SystemFloatingWindowManager } from '../common/SystemFloatingWindowManager';

const TAG: string = 'SubWindow';
const FEEDBACK_X: number = 2;

@injectable()
export class SubWindowAdapter extends BaseAdapter {
  private abilityManager: AbilityManager;
  private systemFloatingWindowManager: SystemFloatingWindowManager;
  private subWindowList: (ISubWindowInfo)[] = [];

  constructor(
    @inject(AbilityManager) abilityManager: AbilityManager,
    @inject(SystemFloatingWindowManager) systemFloatingWindowManager: SystemFloatingWindowManager,
  ) {
    super();
    this.abilityManager = abilityManager;
    this.systemFloatingWindowManager = systemFloatingWindowManager;
  }

  @LogMethod
  createSubWindow(param: NewWindowParam,
    callback: (ready: boolean, id: string) => void) {
    let parentId = param.parent_id
    let fixedBounds = this.adjustBounds(parentId, param.bounds);
    // Mobile-emulated requests carry no window geometry: the fields arrive as
    // undefined (NaN arithmetic), which silently bypasses numeric checks.
    // Creating a zero/NaN-sized window makes WMS time out attaching it.
    // Size it to the parent window's rect instead.
    if (!(fixedBounds.width > 0) || !(fixedBounds.height > 0) ||
      isNaN(fixedBounds.width) || isNaN(fixedBounds.height) ||
      isNaN(fixedBounds.left) || isNaN(fixedBounds.top)) {
      const parentWindow = this.getParentWindow(parentId);
      const prop = parentWindow?.getWindowProperties();
      if (prop) {
        fixedBounds.width = prop.windowRect.width;
        fixedBounds.height = prop.windowRect.height;
        fixedBounds.left = prop.windowRect.left;
        fixedBounds.top = prop.windowRect.top;
      } else {
        fixedBounds.width = 800;
        fixedBounds.height = 600;
        fixedBounds.left = 0;
        fixedBounds.top = 0;
      }
      LogUtil.warn(TAG, 'sub window requested with empty bounds, using ' + JSON.stringify(fixedBounds));
    }
    // LogMethod prints JSBind objects as {} - log the resolved geometry
    // explicitly so popup sizing issues are visible in the log.
    LogUtil.info(TAG, 'sub window ' + param.window_id + ' bounds: ' + JSON.stringify(fixedBounds));
    // Sub-window reuse is disabled on purpose. A reused window keeps the
    // XComponent and web surface of its previous session, so the engine's
    // content for the new popup never displays (vault-manager popup stuck on
    // a stale page in touch mode). Rebuilding the page in place was tried and
    // is worse: the engine can attach between the old surface's teardown and
    // the new one's registration, breaking the popup entirely. Cancel now
    // destroys the window (see cancelSubWindow), so createSubWindow always
    // takes the fresh-create path - the lifecycle that provably works (first
    // popup of a session): the engine allocates the id, the window is created
    // with it, and the browser attaches only after onLoad.
    // Shared between this adapter and the page's XComponent (via the params
    // record): flipped on every failure path so a running SurfaceReady poll
    // stops instead of reporting readiness for a dead window.
    const cancelToken: SubWindowCancelToken = { cancelled: false };
    const para: Record<string, IParams> = {
      'subWindowParams': {
        id: param.window_id,
        callback: callback,
        size: [fixedBounds.width, fixedBounds.height],
        initColorRgb: param.init_color_argb,
        cancelToken: cancelToken,
      }
    };
    let subStorage: LocalStorage = new LocalStorage(para);
    this.createNewWindow(parentId, param.window_id, fixedBounds, subStorage, callback, cancelToken);
  }

  private getParentWindow(parentId: string): window.Window | undefined {
    let mainWindow = this.abilityManager.getProxy(parentId)?.getWindow();
    if (!mainWindow) {
      let mainWindowId = this.systemFloatingWindowManager.getMainWindowId(parentId);
      mainWindow = this.abilityManager.getProxy((mainWindowId as string))?.getWindow();
    }
    return mainWindow;
  }

  private adjustBounds(parentId: string, bounds: WindowBound): WindowBound {
    // The engine normally sends bounds, but a degenerate request must not
    // crash the adapter here (a throw would leave the engine waiting for a
    // callback forever); the caller has a zero-size fallback for that case.
    // NOTE: the engine sends PHYSICAL px (verified: a tooltip popup bottom
    // lands exactly on the bottom-bar top edge), so no DIP scaling here.
    let out_bounds = bounds;
    if (!out_bounds) {
      out_bounds = { left: 0, top: 0, width: 0, height: 0 };
    }
    let mainWindow = this.getParentWindow(parentId);
    if (!mainWindow) {
      return out_bounds;
    }
    const windowProp = mainWindow.getWindowProperties();
    if (windowProp && windowProp.drawableRect.top !== 0) {
      out_bounds.top += windowProp.drawableRect.top;
    } else {
      // In full-screen mode, when a sub-window is created, the window is
      // moved left by two pixels to adjust its position relative to the cursor point.
      out_bounds.top += FEEDBACK_X;
    }
    return out_bounds;
  }

  private findSubWindow(id: string): ISubWindowInfo | undefined {
    for (let i = 0; i < this.subWindowList.length; i++) {
      const item = this.subWindowList[i];
      if (item && item.id === id) {
        return item;
      }
    }
    return undefined;
  }

  private createNewWindow(parentId: string,
                          id: string,
                          bounds: WindowBound,
                          subStorage: LocalStorage,
                          callback: (ready: boolean, id: string) => void,
                          cancelToken: SubWindowCancelToken) {
    let proxy = this.abilityManager.getProxy(parentId);
    if (!proxy) {
      let mainWindowId = this.systemFloatingWindowManager.getMainWindowId(parentId);
      proxy = this.abilityManager.getProxy((mainWindowId as string));
    }
    if (!proxy) {
      // Without a parent proxy the window can never be created; report the
      // failure instead of leaving the engine waiting for a callback.
      LogUtil.error(TAG, 'Failed to resolve the parent proxy: ' + parentId);
      cancelToken.cancelled = true;
      callback(false, id);
      return;
    }
    proxy.createSubWindow(id)
      .then((data: window.Window) => {
        this.initSubWindow(data, parentId, id, bounds, subStorage, callback, cancelToken);
      }).catch((error: BusinessError) => {
      LogUtil.error(TAG, 'Failed to create the subWindow. Cause: ' + JSON.stringify(error));
      cancelToken.cancelled = true;
      callback(false, id);
    });
  }

  private initSubWindow(data: window.Window,
                        parentId: string,
                        id: string,
                        bounds: WindowBound,
                        subStorage: LocalStorage,
                        callback: (ready: boolean, id: string) => void,
                        cancelToken: SubWindowCancelToken) {
    try {
      let windowClass = data;
      windowClass.keepKeyboardOnFocus(true);
      this.subWindowList.push({
        id: id,
        parentId: parentId,
        subWindow: windowClass,
        localStorage: subStorage,
        cancelToken: cancelToken
      });

      windowClass.on('windowSizeChange', (size) => {
        const prop = data.getWindowProperties();
        let windowBound: WindowBound = {
          left: prop.windowRect.left,
          top: prop.windowRect.top,
          width: prop.windowRect.width,
          height: prop.windowRect.height,
        };
        this.nativeContext.OnWindowSizeChange(id, windowBound);
      });

      this.moveSubWindow(windowClass, bounds.left, bounds.top, parentId);
      if (bounds.width > 0 && bounds.height > 0) {
        this.resizeSubWindow(windowClass, bounds.width, bounds.height);
      }
      windowClass.loadContent('pages/SubWindow', subStorage, (err) => {
        if (err.code) {
          LogUtil.error(TAG, 'Failed to load the content. Cause:' + JSON.stringify(err));
          // Report the failure so the renderer does not wait forever, and
          // destroy the dead window instead of leaking it.
          cancelToken.cancelled = true;
          callback(false, id);
          this.discardFailedSubWindow(id, windowClass);
          return;
        }
        windowClass.setWindowFocusable(false)
          .then(() => {
            windowClass.showWindow()
              .catch((err: BusinessError) => {
                LogUtil.error(TAG, 'Failed to show SubWindow. Cause: ' + JSON.stringify(err));
                this.discardFailedSubWindow(id, windowClass);
                callback(false, id);
              });
          }).catch(() => {
          LogUtil.error(TAG, 'set focusable false failed');
          this.discardFailedSubWindow(id, windowClass);
          callback(false, id);
        });
      });
    } catch (exception) {
      LogUtil.error(TAG,'Failed to create sub window. Cause: ' + JSON.stringify(exception));
      // A synchronous failure here happens before any async callback fired,
      // so the engine is still waiting - report the failure.
      cancelToken.cancelled = true;
      callback(false, id);
    }
  }

  // Removes a half-initialized sub window from the live list and destroys it,
  // so a failed popup does not leak a hidden, unusable window. Flips the
  // cancel token first so a SurfaceReady poll that already started on this
  // window's XComponent stops instead of later firing callback(true).
  private discardFailedSubWindow(id: string, windowClass: window.Window): void {
    for (let i = 0; i < this.subWindowList.length; i++) {
      const item = this.subWindowList[i];
      if (item && item.id === id) {
        if (item.cancelToken) {
          item.cancelToken.cancelled = true;
        }
        this.subWindowList.splice(i, 1);
        break;
      }
    }
    windowClass.destroyWindow().catch((err: BusinessError) => {
      LogUtil.warn(TAG, 'destroy failed subWindow: ' + JSON.stringify(err));
    });
  }

  private async resizeSubWindow(windowClass: window.Window, width: number, height: number) {
    return await windowClass.resize(width, height);
  }

  private moveSubWindow(windowClass: window.Window, x: number, y: number, parentId: string) {
    if (deviceInfo.sdkApiVersion >= 15) {
      let displayId : number | undefined;
      let mainWindow = this.getParentWindow(parentId);
      if (mainWindow) {
        const prop = mainWindow.getWindowProperties();
        displayId = prop.displayId;
      }
      try {
        let config: window.MoveConfiguration = {
          displayId: displayId
        };
        let promise = windowClass.moveWindowToAsync(x, y, config);
        promise.then(() => {
          LogUtil.info(TAG, `Succeeded in moving the window, display id: ${displayId}`);
        }).catch((err: BusinessError) => {
          LogUtil.error(TAG, `Failed to move the window. Cause code: ${err.code},
            message: ${err.message}, display id: ${displayId}`);
        });
      } catch (exception) {
        LogUtil.error(TAG, `Failed to move the window. Cause code: ${exception.code},
          message: ${exception.message}, display id: ${displayId}`);
      }
    } else {
      windowClass.moveWindowTo(x, y, (err) => {
        if (err.code) {
          LogUtil.error(TAG, 'Failed to move the subWindow. Cause:' + JSON.stringify(err));
        }
      });
    }
  }

  @LogMethod
  cancelSubWindow(id: string) {
    for (let i = 0; i < this.subWindowList.length; i++) {
      const item = this.subWindowList[i];
      if (item && item.id === id) {
        this.subWindowList.splice(i, 1);
        // Stop a pending SurfaceReady poll: the window is going away, so it
        // must never report readiness to the engine afterwards.
        if (item.cancelToken) {
          item.cancelToken.cancelled = true;
        }
        // Destroy instead of caching for reuse: a kept window still carries
        // the previous session's XComponent/web surface, and reusing it
        // leaves the engine's fresh content invisible (popups stuck on a
        // stale page). The next popup goes through the fresh-create path.
        item.subWindow.destroyWindow().catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to destroy the subWindow. Cause:' + JSON.stringify(err));
        });
        break;
      }
    }
  }

  @LogMethod
  hideSubWindow(id: string) {
    const item = this.findSubWindow(id);
    item?.subWindow.minimize().catch((err: BusinessError) => {
      LogUtil.error(TAG, 'Failed to hide SubWindow. Cause: ' + JSON.stringify(err));
    });
  }

  @LogMethod
  showSubWindow(id: string) {
    const item = this.findSubWindow(id);
    item?.subWindow.showWindow().catch((err: BusinessError) => {
      LogUtil.error(TAG, 'Failed to show SubWindow. Cause: ' + JSON.stringify(err));
    });
  }

  @LogMethod
  setSubWindowBounds(id: string, r: WindowBound) {
    try {
      let windowClass = window.findWindow(id);
      if (!windowClass) {
        LogUtil.warn(TAG, 'setSubWindowBounds: window not found: ' + id);
        return;
      }
      // Engine updates can arrive with missing geometry ({}); NaN arithmetic
      // would make WMS reject the calls. Only apply fields that are present.
      if (r && r.width > 0 && r.height > 0) {
        windowClass?.resize(r.width, r.height, (err) => {
          if (err.code) {
            LogUtil.error(TAG, 'Failed to change the subWindow size. Cause:' + JSON.stringify(err));
            return;
          }
        });
      }
      if (r && !isNaN(r.left) && !isNaN(r.top)) {
        windowClass?.moveWindowTo(r.left, r.top, (err) => {
          if (err.code) {
            LogUtil.error(TAG, 'Failed to move the subwindow. Cause:' + JSON.stringify(err));
            return;
          }
        });
      }
    } catch (exception) {
      LogUtil.error(TAG, 'Failed to find the Window. Cause: ' + JSON.stringify(exception));
    }
  }
}
