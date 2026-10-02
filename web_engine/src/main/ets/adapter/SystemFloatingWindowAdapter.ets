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
import { BusinessError } from '@ohos.base';
import { window } from '@kit.ArkUI';
import { BaseWindowAdapter } from '../common/BaseWindowAdapter';
import LogUtil from '../utils/LogUtil';
import { AbilityManager } from '../common/AbilityManager';
import LogMethod from '../common/LogDecorator';
import { NewWindowParam, WindowBound, WindowType } from '../interface/CommonInterface';
import lazy { SystemFloatingWindowManager } from '../common/SystemFloatingWindowManager';
import lazy { ContextAdapter } from './ContextAdapter';
import { common } from '@kit.AbilityKit';
import { WindowStyle, IStyleData, IUpdateStyle } from '../common/WindowStyle';

const TAG: string = 'SystemFloatingWindowWindow';

@injectable()
export class SystemFloatingWindowAdapter extends BaseWindowAdapter {
  private abilityManager: AbilityManager;
  private systemFloatingWindowManager: SystemFloatingWindowManager;

  constructor(
    @inject(ContextAdapter) ctxAdapter: ContextAdapter,
    @inject(AbilityManager) abilityManager: AbilityManager,
    @inject(SystemFloatingWindowManager) systemFloatingWindowManager: SystemFloatingWindowManager,
  ) {
    super(ctxAdapter);
    this.abilityManager = abilityManager;
    this.systemFloatingWindowManager = systemFloatingWindowManager;
  }

  @LogMethod
  createWindow(param: NewWindowParam) {
    let activeContext = this.ctxAdapter.getActiveContext() as common.UIAbilityContext;
    if (!activeContext) {
      LogUtil.warn(TAG, 'Failed to get active context');
      return;
    }
    // Capture the owning context for getWindowContext(): answering with the
    // live active-context lookup would recurse when this adapter is itself
    // the active window.
    this.windowContext = activeContext;

    let bounds: WindowBound = {
      left: param.bounds.left,
      top: param.bounds.top,
      width: param.bounds.width,
      height: param.bounds.height,
    };
    const out_bounds = this.adjustBounds(bounds);
    let config: window.Configuration = {
      name: param.window_id,
      windowType: window.WindowType.TYPE_FLOAT,
      ctx: activeContext,
      decorEnabled: true
    };
    window.createWindow(config, (err: BusinessError, data) => {
      if (err.code) {
        LogUtil.error(TAG, 'Failed to create window. Cause: ' + JSON.stringify(err));
        return;
      }

      try {
        data.moveWindowTo(out_bounds.left, out_bounds.top)
          .then(() => {
            data.resize(out_bounds.width, out_bounds.height)
              .catch((err: BusinessError) => {
                LogUtil.error(TAG, 'Failed to change the window size. Cause:' + JSON.stringify(err));
              });
          }).catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to move the window. Cause:' + JSON.stringify(err));
        });
      } catch (exception) {
        LogUtil.error(TAG, 'move the window exception. Cause:' + JSON.stringify(exception));
      }

      try {
        data.on('windowSizeChange', (size) => {
          const windowProp = data.getWindowProperties();
          // Outer -> content conversion. Per-side borders (round 95, Bug 2):
          // the old symmetric subtraction removed 2x drawableRect.left from
          // the width and 2x drawableRect.top from the height - on native
          // frames only the TOP caption exists, so the height was reported
          // one caption too short and the viewport shrank on every
          // resize event.
          const drawable = windowProp.drawableRect;
          const windowRect = windowProp.windowRect;
          let rightBorder: number = 0;
          let bottomBorder: number = 0;
          if (drawable.width > 0 && drawable.height > 0) {
            rightBorder = Math.max(0, windowRect.width - drawable.left - drawable.width);
            bottomBorder = Math.max(0, windowRect.height - drawable.top - drawable.height);
          }
          let windowBound: WindowBound = {
            left: windowRect.left + drawable.left,
            top: windowRect.top + drawable.top,
            width: size.width - drawable.left - rightBorder,
            height: size.height - drawable.top - bottomBorder,
          };
          this.nativeContext.OnWindowSizeChange(param.window_id, windowBound);
        });
      } catch (exception) {
        LogUtil.error(TAG,'Failed to enable the listener for window size changes. Cause: ' + JSON.stringify(exception));
      }

      try {
        data.on("windowRectChange", (option) => {
          this.nativeContext.OnWindowRectChange(param.window_id, option.rect, option.reason.valueOf());
        });
      } catch (exception) {
        LogUtil.error(TAG,'Failed to enable the listener for window rect changes. Cause: ' + JSON.stringify(exception));
      }

      try {
        data.on('windowEvent', (type) => {
          this.nativeContext.OnWindowEvent(param.window_id, type.valueOf());
        });
      } catch (exception) {
        LogUtil.error(TAG, 'Failed to register callback. Cause: ' + JSON.stringify(exception));
      }

      try {
        data.on("windowVisibilityChange", (visible) => {
          this.nativeContext.OnWindowVisibilityChange(param.window_id, visible);
        });
      } catch (exception) {
        LogUtil.error(TAG, 'Failed to register callback. Cause: ' + JSON.stringify(exception));
      }

      let windowClass = data;
      this.cacheWindow(param.parent_id, param.window_id, windowClass);

      let startUri: string = ''
      const para: Record<string, string | IUpdateStyle> = {
        'xcomponentId': param.window_id,
        'startUri': startUri,
        'updateStyle': {
          'registerUpdateStyleFunction': WindowStyle.registerUpdateStyleFunction,
          'removeUpdateStyleFunction': WindowStyle.removeUpdateStyleFunction
        }
      };
      let storage: LocalStorage = new LocalStorage(para);
      windowClass.loadContent("pages/Index", storage, (err, data) => {
        let errCode: number = err.code;
        if (errCode) {
          LogUtil.error(TAG, 'Failed to load the content. Cause:' + JSON.stringify(err));
          // The window is unusable without content; tear it down fully so
          // nothing is left on screen and the id can be recreated later
          // (window + manager cache + proxy registration). Destroy the
          // outer windowClass, not the (void) loadContent data param.
          windowClass.destroyWindow((destroyErr: BusinessError) => {
            LogUtil.warn(TAG, 'destroy failed floating window: ' + JSON.stringify(destroyErr));
          });
          this.systemFloatingWindowManager.removeSystemFloatingWindow(
            param.parent_id, param.window_id);
          this.abilityManager.removeProxy(param.window_id);
          return;
        }
      })
    });
  }

  @LogMethod
  closeWindow(id: number) {
    let mainWindowId = this.systemFloatingWindowManager.getMainWindowId(id);
    if (mainWindowId) {
      this.systemFloatingWindowManager.getWindow(id)?.destroyWindow()
        .then(() => {
          // Drop the proxy registration on success: a stale entry blocks
          // re-creating a floating window with the same id (addProxy dedup)
          // and routes engine calls to the destroyed window.
          this.abilityManager.removeProxy(id);
        })
        .catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to destroy the floating window. Cause: ' + JSON.stringify(err));
        });
      this.systemFloatingWindowManager.removeSystemFloatingWindow(mainWindowId, id);
    }
  }

  @LogMethod
  showWindow(id: number) {
    let windowClass = this.abilityManager.getProxy(id)?.getWindow();
    let promise = windowClass?.showWindow();
    promise?.then(() => {
        LogUtil.info(TAG, 'Succeeded in showing the window.');
    }).catch((err: BusinessError) => {
        LogUtil.error(TAG, `Failed to show the window. Cause code: ${err.code}, message: ${err.message}`);
    });
  }

    @LogMethod
  hideWindow(id: number) {
    let windowClass = this.abilityManager.getProxy(id)?.getWindow();
    let promise = windowClass?.minimize();
    promise?.then(() => {
        LogUtil.info(TAG, 'Succeeded in hiding the window.');
    }).catch((err: BusinessError) => {
        LogUtil.error(TAG, `Failed to hide the window. Cause code: ${err.code}, message: ${err.message}`);
    });
  }

  @LogMethod
  setBounds(id: number,
            bounds: WindowBound,
            onCompleted: (ret: boolean) => void) {
    let windowClass = this.systemFloatingWindowManager.getWindow(id);
    if (!windowClass) {
      onCompleted(false);
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    const windowProp = windowClass?.getWindowProperties();
    let xComBorder: number = windowProp?.drawableRect.left || 0;
    let xComTop: number = windowProp?.drawableRect.top || 0;
    // Per-side borders (round 95, Bug 2 - see AppWindowAdapter.setBounds):
    // width grows by left+right, height by top+bottom. Native frames carry
    // only the top caption, so the symmetric "+2x top" grew the height by
    // an extra caption on every call.
    let xComRight: number = 0;
    let xComBottom: number = 0;
    if (windowProp && windowProp.drawableRect.width > 0 &&
      windowProp.drawableRect.height > 0) {
      xComRight = Math.max(0, windowProp.windowRect.width -
        windowProp.drawableRect.left - windowProp.drawableRect.width);
      xComBottom = Math.max(0, windowProp.windowRect.height -
        windowProp.drawableRect.top - windowProp.drawableRect.height);
    }
    bounds.left -= xComBorder;
    bounds.top -= xComTop;
    bounds.width = bounds.width + xComBorder + xComRight;
    bounds.height = bounds.height + xComTop + xComBottom;

    try {
      windowClass.moveWindowTo(bounds.left, bounds.top)
        .then(() => {
          windowClass?.resize(bounds.width, bounds.height)
            .then(() => {
              onCompleted(true);
            }).catch((err: BusinessError) => {
            onCompleted(false);
            LogUtil.error(TAG, 'Failed to change the window size. Cause:' + JSON.stringify(err));
          });
        }).catch((err: BusinessError) => {
        onCompleted(false);
        LogUtil.error(TAG, 'Failed to move the window. Cause:' + JSON.stringify(err));
      });
    } catch (exception) {
      onCompleted(false);
      LogUtil.error(TAG, 'move the window exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  setWindowLimits(minWidth: number,
                  minHeight: number,
                  maxWidth: number,
                  maxHeight: number,
                  id: number) {
    let windowClass = this.systemFloatingWindowManager.getWindow(id);
    const windowProp = windowClass?.getWindowProperties();
    let xComBorder: number = windowProp?.drawableRect.left || 0;
    let xComTop: number = windowProp?.drawableRect.top || 0;
    // Per-side borders (round 95, Bug 2 - see setBounds above): the limits
    // apply to the OUTER window, so content limits grow by left+right /
    // top+bottom.
    let xComRight: number = 0;
    let xComBottom: number = 0;
    if (windowProp && windowProp.drawableRect.width > 0 &&
      windowProp.drawableRect.height > 0) {
      xComRight = Math.max(0, windowProp.windowRect.width -
        windowProp.drawableRect.left - windowProp.drawableRect.width);
      xComBottom = Math.max(0, windowProp.windowRect.height -
        windowProp.drawableRect.top - windowProp.drawableRect.height);
    }

    try {
      let windowLimits: window.WindowLimits = {
        minWidth: minWidth === 0 ? minWidth : minWidth + xComBorder + xComRight,
        minHeight: minHeight === 0 ? minHeight : minHeight + xComTop + xComBottom,
        maxWidth: maxWidth === 0 ? maxWidth : maxWidth + xComBorder + xComRight,
        maxHeight: maxHeight === 0 ? maxHeight : maxHeight + xComTop + xComBottom,
      };
      windowClass?.setWindowLimits(windowLimits)
        .catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to change the window limits. Cause: ' + JSON.stringify(err));
        });
    } catch (exception) {
      LogUtil.error(TAG, 'change the window limits exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  startWindowMoving(id: number) {
    let window = this.systemFloatingWindowManager.getWindow(id);
    window?.startMoving().then(() => {
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `startWindowMoving fail, error info: ${JSON.stringify(err)}`);
    });
  }

  private adjustBounds(bounds: WindowBound): WindowBound {
    let out_bounds = bounds;
    let mainWindow = this.ctxAdapter.getActiveProxy().getWindow();
    if (!mainWindow) {
      return out_bounds;
    }
    const windowProp = mainWindow?.getWindowProperties();
    let xComBorder: number = windowProp?.drawableRect.left || 0;
    let xComTop: number = windowProp?.drawableRect.top || 0;
    // Per-side borders (round 95, Bug 2 - see setBounds above). The new
    // floating window carries the parent's frame style, so the parent's
    // chrome dimensions are the right ones.
    let xComRight: number = 0;
    let xComBottom: number = 0;
    if (windowProp && windowProp.drawableRect.width > 0 &&
      windowProp.drawableRect.height > 0) {
      xComRight = Math.max(0, windowProp.windowRect.width -
        windowProp.drawableRect.left - windowProp.drawableRect.width);
      xComBottom = Math.max(0, windowProp.windowRect.height -
        windowProp.drawableRect.top - windowProp.drawableRect.height);
    }
    out_bounds.left -= xComBorder;
    out_bounds.top -= xComTop;
    out_bounds.width += xComBorder + xComRight;
    out_bounds.height += xComTop + xComBottom;
    return out_bounds;
  }

  private cacheWindow(parentId: string, windowId: string, windowClass: window.Window) {
    let mainWindowId = this.abilityManager.getProxy(parentId)?.getWindowId();
    if (mainWindowId) {
      super.initialize(windowId, windowClass);
      this.abilityManager.addProxy(this);
      this.systemFloatingWindowManager.addSystemFloatingWindow(mainWindowId, {
        "id": windowId,
        "window": windowClass
      });
    }
  }
};
