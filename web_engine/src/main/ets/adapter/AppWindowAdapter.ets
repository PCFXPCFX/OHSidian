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
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import bundleManager from '@ohos.bundle.bundleManager';
import { BusinessError } from '@ohos.base';
import common from '@ohos.app.ability.common';
import { contextConstant, StartOptions } from '@kit.AbilityKit';
import { display, window } from '@kit.ArkUI';
import { deviceInfo, settings } from '@kit.BasicServicesKit';
import { image } from '@kit.ImageKit';
import Want from '@ohos.app.ability.Want';

import { AbilityManager } from '../common/AbilityManager';
import { BaseAdapter } from '../common/BaseAdapter';
import { ContextAdapter } from './ContextAdapter';
import { IStyleData, IUpdateStyle, WindowStyle } from '../common/WindowStyle';
import LaunchHelper from '../utils/LaunchHelper';
import LogMethod from '../common/LogDecorator';
import LogUtil from '../utils/LogUtil';
import { NewWindowParam, PointCoordinate, WindowType, WindowBound, WindowPreferences, ILoginInfo, ILogin } from "../interface/CommonInterface"

const TAG: string = 'AppWindow';

@injectable()
export class AppWindowAdapter extends BaseAdapter {
  private abilityManager: AbilityManager;
  private bundleName: string = 'com.huawei.ohos_electron';
  private bundleFlags = bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION |
                        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_METADATA;
  private queryWindowNum: number = 10;  
  private ctxAdapter: ContextAdapter;
  private defaultBackgroundColor: string = '#00000000';
  private loginWindow: window.Window | null = null;

  constructor(
    @inject(AbilityManager) abilityManager: AbilityManager,
    @inject(ContextAdapter) ctxAdapter: ContextAdapter
  ) {
    super();
    this.abilityManager = abilityManager;
    this.ctxAdapter = ctxAdapter;

    try {
      let data = bundleManager.getBundleInfoForSelfSync(this.bundleFlags);
      this.bundleName = data.name;
    } catch (err) {
      let message = (err as BusinessError).message;
      LogUtil.error(TAG, `getBundleInfoForSelfSync failed.: ${message}`);
    }
  }

  private getWindow(id: number): window.Window | undefined {
    return this.abilityManager.getProxy(id)?.getWindow();
  }

  private getDisplayDensity(): number {
    try {
      let d = display.getDefaultDisplaySync().densityPixels;
      if (d && d > 0) {
        return d;
      }
    } catch (exception) {
      LogUtil.warn(TAG, 'getDisplayDensity failed: ' + JSON.stringify(exception));
    }
    return 1;
  }

  // Mirrors WebAbility.pcModeEnabled for window-creation decisions: reads
  // the same system setting the ability tracks. 'true' = tablet PC mode
  // (floating desktop windows), 'false'/unavailable = tablet touch mode
  // (windows are fullscreen).
  private isTabletPcMode(): boolean {
    try {
      let ctx = this.ctxAdapter.getActiveContext() || this.ctxAdapter.getContext();
      let value = settings.getValueSync(ctx, 'window_pcmode_switch_status', 'false',
        settings.domainName.USER_PROPERTY);
      return value === 'true';
    } catch (exception) {
      LogUtil.warn(TAG, 'isTabletPcMode read failed: ' + JSON.stringify(exception));
      return false;
    }
  }

  private applyWindowTitleButtonVisible(id: number) {
    let proxy = this.abilityManager.getProxy(id);
    let preferences: WindowPreferences | undefined = proxy?.getWindowPreferences();
    if (!preferences) {
      return;
    }
    proxy?.getWindow()?.setWindowTitleButtonVisible(preferences.maximizable, preferences.minimizable, preferences.closable);
  }

  private showWindowTitleButtons(id: number) {
    let proxy = this.abilityManager.getProxy(id);
    let preferences: WindowPreferences | undefined = proxy?.getWindowPreferences();
    if (preferences) {
      preferences.maximizable = true;
      preferences.minimizable = true;
      preferences.closable = true;
      proxy?.setWindowPreferences(preferences);
    }
    proxy?.getWindow()?.setWindowTitleButtonVisible(true, true, true);
  }

  @LogMethod
  createWindow(param: NewWindowParam) {
    let abilityName: string = "EntryAbility";
    if (param.is_stateless) {
      abilityName = "StatelessAbility";
    }
    const want: Want = {
      bundleName: this.bundleName,
      abilityName: abilityName,
      parameters: {
        'xcomponentId': param.window_id,
        'windowType': WindowType.MAIN_WINDOW,
        instanceKey: param.window_id,
        'hideTitleBar': param.hide_title_bar,
        'useDarkMode': param.use_dark_mode,
        'minimizable': param.minimizable,
        'maximizable': param.maximizable,
        'closable': param.closable,
        'alwaysOntop': param.always_on_top,
        'resizable': param.resizable,
        'isModal': param.is_modal,
        'isPanel': param.is_panel,
      }
    };

    let windowClass = this.ctxAdapter.getActiveProxy().getWindow();
    const windowProp = windowClass?.getWindowProperties();
    let leftBorder: number = param.hide_title_bar ? 0 : windowProp?.drawableRect.left || 0;
    let topBorder: number = param.hide_title_bar ? 0 : windowProp?.drawableRect.top || 0;

    // The engine can request a window without geometry (mobile-emulated
    // flows send undefined fields, exactly like the empty setBounds calls).
    // NaN/zero in StartOptions windowWidth/windowHeight fails the system
    // StartOptions check with 16000067, the ability never launches and the
    // engine times out waiting for the window. The engine sends no geometry
    // for these windows, and the starter/vault-chooser UI is designed for
    // 800x650 DIP - a parent-rect fallback produced a fullscreen window with
    // a small fixed-size UI floating in it ("cannot fill the screen"). Size
    // such windows to 800x650 DIP, centered on the display.
    let bounds = param.bounds;
    if (!bounds) {
      bounds = { left: 0, top: 0, width: 0, height: 0 };
    }
    const density = this.getDisplayDensity();
    const invalidSize = (v: number): boolean => {
      return isNaN(v) || !(v > 0);
    };
    let centered = false;
    if (invalidSize(bounds.width) || invalidSize(bounds.height) ||
      isNaN(bounds.left) || isNaN(bounds.top)) {
      bounds = { left: 0, top: 0, width: 800, height: 650 };
      leftBorder = 0;
      topBorder = 0;
      centered = true;
      LogUtil.warn(TAG, 'createWindow without valid bounds, using 800x650 DIP centered');
    }

    // Frame borders are symmetric (see setBounds): width grows by 2x the
    // left border, height by 2x the top border. Upstream mixed leftBorder
    // into the height, mis-sizing framed windows. Borders are px; the engine
    // bounds are DIP - convert borders to DIP before adding.
    let widthDip: number = Math.round(bounds.width + (leftBorder + leftBorder) / density);
    let heightDip: number = Math.round(bounds.height + (topBorder + topBorder) / density);
    // StartOptions units (SDK): windowLeft/windowTop are px, while
    // windowWidth/windowHeight are vp. Engine DIP == vp, so sizes pass
    // through and only the position converts to px.
    let outerLeft: number = Math.floor(bounds.left * density) - Math.floor(leftBorder);
    let outerTop: number = Math.floor(bounds.top * density) - Math.floor(topBorder);
    if (centered) {
      const displayClass = display.getDefaultDisplaySync();
      outerLeft = Math.floor((displayClass.width - widthDip * density) / 2);
      outerTop = Math.floor((displayClass.height - heightDip * density) / 2);
    }
    let color = new ArrayBuffer(0);

    const launch = (icon: image.PixelMap | undefined): void => {
      let options: StartOptions = {
        processMode: contextConstant.ProcessMode.ATTACH_TO_STATUS_BAR_ITEM,
        startupVisibility: param.show ? contextConstant.StartupVisibility.STARTUP_SHOW : contextConstant.StartupVisibility.STARTUP_HIDE,
        windowLeft: outerLeft,
        windowTop: outerTop,
        windowWidth: widthDip,
        windowHeight: heightDip,
        startWindowBackgroundColor: this.defaultBackgroundColor
      };
      if (icon) {
        options.startWindowIcon = icon;
      }
      if (param.is_panel) {
        options.windowMode = AbilityConstant.WindowMode.WINDOW_MODE_FULLSCREEN;
      }
      // Tablet touch mode: every engine-created window (starter vault
      // chooser, vault windows opened from it) must fill the display -
      // the engine requests desktop-sized bounds (800x600/800x650 DIP)
      // which land as a small floating rect on the tablet (the reported
      // "仓库管理初始界面跳转后长宽不对"). Read the same system setting
      // WebAbility tracks (window_pcmode_switch_status): 'false' on a
      // tablet means touch mode → launch fullscreen. PC mode / 2in1 keep
      // the desktop-window behavior.
      if (deviceInfo.deviceType === 'tablet' && !this.isTabletPcMode()) {
        options.windowMode = AbilityConstant.WindowMode.WINDOW_MODE_FULLSCREEN;
        options.windowLeft = 0;
        options.windowTop = 0;
      }
      if (param.display_id != -1) {
        options.displayId = param.display_id;
      }
      LaunchHelper.LaunchWithOptions(this.ctxAdapter.getActiveContext(), want, options);
    };

    image.createPixelMap(color, {
      size: {
        height: Math.round(heightDip * density),
        width: Math.round(widthDip * density),
      }
    }).then((data) => {
      launch(data);
    }).catch((err: BusinessError) => {
      // A failed icon must not silently skip the launch (the engine would
      // wait for a window that is never started).
      LogUtil.warn(TAG, 'createPixelMap failed, launching without icon: ' + JSON.stringify(err));
      launch(undefined);
    });
  }

  @LogMethod
  closeWindow(id: number) {
    let proxy = this.abilityManager.getProxy(id);
    let context = proxy?.getWindowContext() as common.UIAbilityContext;
    if (!context) {
      // Without a context the terminate call is a silent no-op and the
      // engine believes the window closed while it is still on screen.
      LogUtil.error(TAG, 'closeWindow: no context for window ' + id +
        ', proxy=' + JSON.stringify(proxy !== undefined));
      return;
    }
    context.terminateSelf()
      .then(() => {
        LogUtil.info(TAG, 'closeWindow success: ' + id);
      })
      .catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to close window. Cause: ' + JSON.stringify(err));
      });
  }

  @LogMethod
  setMaximizable(id: number, maximizable: boolean) {
    let proxy = this.abilityManager.getProxy(id);
    let preferences: WindowPreferences | undefined = proxy?.getWindowPreferences();
    if (preferences) {
      preferences.maximizable = maximizable;
      proxy?.setWindowPreferences(preferences);
      this.applyWindowTitleButtonVisible(id);
    }
    let windowStage = proxy?.getWindowStage();
    if (!maximizable) {
      windowStage?.setSupportedWindowModes([bundleManager.SupportWindowMode.FLOATING]);
    } else {
      windowStage?.setSupportedWindowModes([bundleManager.SupportWindowMode.FLOATING, bundleManager.SupportWindowMode.SPLIT, bundleManager.SupportWindowMode.FULL_SCREEN]);
    }
  }

  @LogMethod
  setMinimizable(id: number, minimizable: boolean) {
    let proxy = this.abilityManager.getProxy(id);
    let preferences: WindowPreferences | undefined = proxy?.getWindowPreferences();
    if (preferences) {
      preferences.minimizable = minimizable;
      proxy?.setWindowPreferences(preferences);
      this.applyWindowTitleButtonVisible(id);
    }
  }

  @LogMethod
  setClosable(id: number, closable: boolean) {
    let proxy = this.abilityManager.getProxy(id);
    let preferences: WindowPreferences | undefined = proxy?.getWindowPreferences();
    if (preferences) {
      preferences.closable = closable;
      proxy?.setWindowPreferences(preferences);
      this.applyWindowTitleButtonVisible(id);
    }
  }

  @LogMethod
  setWindowButtonVisibility(id: number, visible: boolean) {
    let proxy = this.abilityManager.getProxy(id);
    let preferences: WindowPreferences | undefined = proxy?.getWindowPreferences();
    if (preferences) {
      preferences.maximizable = visible;
      preferences.minimizable = visible;
      preferences.closable = visible;
      proxy?.setWindowPreferences(preferences);
      this.applyWindowTitleButtonVisible(id);
    }
  }

  @LogMethod
  getWindowButtonVisibility(id: number): boolean {
    let proxy = this.abilityManager.getProxy(id);
    let preferences: WindowPreferences | undefined = proxy?.getWindowPreferences();
    if (preferences) {
      return preferences.maximizable || preferences.minimizable || preferences.closable;
    }
    return false;
  }

  @LogMethod
  setAlwaysOnTop(id: number, onTop: boolean) {
    let windowClass = this.getWindow(id);
    let promise = windowClass?.setWindowTopmost(onTop);
    promise?.then(() => {
      LogUtil.info(TAG, `Succeeded in setting the window to be topmost.`);
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `Failed to set the window to be topmost. Cause code: ${err.code}, message: ${err.message}`);
    });
  }

  @LogMethod
  showWindow(id: number) {
    let context = this.abilityManager.getProxy(id)?.getWindowContext() as common.UIAbilityContext;
    context?.showAbility().then(() => {
      LogUtil.info(TAG, `showAbility success`);
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `showAbility fail, err: ${JSON.stringify(err)}`);
    });
  }

  @LogMethod
  hideWindow(id: number) {
    let context = this.abilityManager.getProxy(id)?.getWindowContext() as common.UIAbilityContext;
    context?.hideAbility().then(() => {
      LogUtil.info(TAG, `hideAbility success`);
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `hideAbility fail, err: ${JSON.stringify(err)}`);
    });
  }

  @LogMethod
  activateWindow(id: number) {
    this.showWindow(id);
  }

  @LogMethod
  setFullScreen(fullScreen: boolean, id: number) {
    if (fullScreen) {
      let windowClass = this.getWindow(id);
      if (!windowClass) {
        LogUtil.error(TAG, 'Failed to obtain the main window.');
        return;
      }

      windowClass.maximize(window.MaximizePresentation.ENTER_IMMERSIVE)
      .catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to maximize the window. Cause:' + JSON.stringify(err));
      });
    } else {
      this.unMaximize(id);
    }
  }

  @LogMethod
  setSimpleFullScreen(fullScreen: boolean, id: number) {
    if (fullScreen) {
      let windowClass = this.getWindow(id);
      if (!windowClass) {
        LogUtil.error(TAG, 'Failed to obtain the main window.');
        return;
      }

      windowClass.maximize(window.MaximizePresentation.ENTER_IMMERSIVE_DISABLE_TITLE_AND_DOCK_HOVER)
        .then(() => {
          LogUtil.info(TAG, 'Succeeded in maximizing the window.');
        }).catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to maximize the window. Cause:' + JSON.stringify(err));
      });
    } else {
      this.unMaximize(id);
    }
  }

  @LogMethod
  restore(id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    windowClass.restore().then(() => {
      console.info('Succeeded in restoring the window.');
    }).catch((err: BusinessError) => {
      console.error(`Failed to restore the window. Cause code: ${err.code}, 
      message: ${err.message}`);
    })
  }

  @LogMethod
  setBounds(id: number,
            hasFrame: boolean,
            bounds: WindowBound,
            callback: () => void) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    const windowProp = windowClass?.getWindowProperties();

    // Mobile-emulated window requests can carry no geometry at all ({}):
    // moving/resizing with NaN gets rejected by the system (1300010). Treat
    // missing width/height as "keep the current rect" and fill missing
    // position fields from the current rect.
    if (isNaN(bounds.width) || isNaN(bounds.height)) {
      LogUtil.error(TAG, 'setBounds without geometry, keeping current rect');
      callback && callback();
      return;
    }
    if (isNaN(bounds.left)) {
      bounds.left = windowProp?.windowRect.left || 0;
    }
    if (isNaN(bounds.top)) {
      bounds.top = windowProp?.windowRect.top || 0;
    }

    // xComponent bounds need to add a border
    let leftBorder: number = hasFrame ? windowProp?.drawableRect.left || 0 : 0;
    let topBorder: number = hasFrame ? windowProp?.drawableRect.top || 0 : 0;
    bounds.left -= leftBorder;
    bounds.top -= topBorder;
    // Frame borders are symmetric: the width grows by one border on each
    // side, the height by the top border on each side. (Upstream added
    // leftBorder to the height, which mis-sized framed windows whenever the
    // frame width differed from the frame height.)
    bounds.width = bounds.width + leftBorder + leftBorder;
    bounds.height = bounds.height + topBorder + topBorder;

    // Diagnostic: the engine manages window bounds itself (desktop behavior);
    // on fullscreen windows the system rejects the calls. Log both the
    // requested and the actual rect to attribute viewport gaps.
    LogUtil.error(TAG, 'setBounds requested=' + JSON.stringify(bounds) +
      ', hasFrame=' + hasFrame +
      ', actual windowRect=' + JSON.stringify(windowProp?.windowRect) +
      ', drawableRect=' + JSON.stringify(windowProp?.drawableRect));

    windowClass.moveWindowToAsync(bounds.left, bounds.top)
      .then(() => {
        windowClass?.resizeAsync(bounds.width, bounds.height)
          .then(() => {
            callback && callback();
          })
      })
      .catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to set the window bounds. Cause:' + JSON.stringify(err));
        callback && callback();
      });
  }

  @LogMethod
  setEnabled(enable: boolean, id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }
    windowClass.setWindowTouchable(enable)
      .catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to set the window to be touchable. Cause:' + JSON.stringify(err));
      });
  }

  @LogMethod
  setWindowLimits(minWidth: number,
                  minHeight: number,
                  maxWidth: number,
                  maxHeight: number,
                  id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    const windowProp = windowClass.getWindowProperties();
    let xComBorder: number = windowProp?.drawableRect.left || 0;
    let xComTop: number = windowProp?.drawableRect.top || 0;

    try {
      let windowLimits: window.WindowLimits = {
        minWidth: minWidth === 0 ? minWidth : minWidth + xComBorder + xComBorder,
        minHeight: minHeight === 0 ? minHeight : minHeight + xComTop + xComBorder,
        maxWidth: maxWidth === 0 ? maxWidth : maxWidth + xComBorder + xComBorder,
        maxHeight: maxHeight === 0 ? maxHeight : maxHeight + xComTop + xComBorder,
      };

      windowClass.setWindowLimits(windowLimits)
        .catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to change the window limits. Cause: ' + JSON.stringify(err));
        });
    } catch (exception) {
      LogUtil.error(TAG, 'change the window limits exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  maximize(id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    if (windowClass.getWindowStatus() === window.WindowStatusType.MAXIMIZE) {
      return;
    }

    try {
      windowClass.maximize(window.MaximizePresentation.EXIT_IMMERSIVE).then(() => {
        LogUtil.info(TAG, 'Succeeded in maximizing the window.');
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to maximize the window. Cause:' + JSON.stringify(err));
      });
    } catch (exception) {
      LogUtil.error(TAG, 'maximize the window exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  unMaximize(id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    try {
      windowClass.recover().then(() => {
        LogUtil.info(TAG, 'Succeeded in setting the system bar to be invisible.');
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to recover the window. Cause: ' + JSON.stringify(err));
      });
    } catch (exception) {
      LogUtil.error(TAG, 'recover the window exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  minimize(id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }
    windowClass.minimize()
      .catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to minimize the window. Cause: ' + JSON.stringify(err));
      });
  }

  @LogMethod
  setTitle(id: number, title: string) {
    let proxy = this.abilityManager.getProxy(id);
    proxy?.setWindowTitle(title);
  }

  @LogMethod
  setAspectRatio(id: number, aspectRatio: number) {
    let windowClass = this.getWindow(id);
    try {
      let promise = aspectRatio > 0 ? windowClass?.setAspectRatio(aspectRatio) : windowClass?.resetAspectRatio();
      promise?.then(() => {
        LogUtil.info(TAG, 'Succeeded in setting aspect ratio of window.');
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to set the aspect ratio of window. Cause:' + JSON.stringify(err));
      });
    } catch (exception) {
      LogUtil.error(TAG, 'Failed to set the aspect ratio of window. Cause: ' + JSON.stringify(exception));
    }
  }

  @LogMethod
  setUseNativeFrame(id: number, useNativeFrame: boolean) {
    let proxy = this.abilityManager.getProxy(id);
    let windowClass = proxy?.getWindow();
    try {
      windowClass?.setWindowDecorVisible(useNativeFrame);
      // Keep title-bar dragging enabled regardless of the frame style: on
      // this engine the web content has no -webkit-app-region support, so
      // the system caption is the only drag surface. When the native frame
      // is hidden (Obsidian-drawn style), the WMS caption strip is not
      // drawn anyway, so enabling move costs nothing and keeps free
      // windows draggable whenever the caption is re-shown.
      windowClass?.setWindowTitleMoveEnabled(true);
      let preferences: WindowPreferences | undefined = proxy?.getWindowPreferences();
      if (preferences) {
        preferences.hideTitleBar = !useNativeFrame;
        proxy?.setWindowPreferences(preferences);
      }
      if (useNativeFrame) {
        this.showWindowTitleButtons(id);
      } else {
        this.applyWindowTitleButtonVisible(id);
      }
    } catch (exception) {
      LogUtil.error(TAG, `Failed to set the visibility of window decor. Cause code: ${exception.code}, message: ${exception.message}`);
    }
  }

  @LogMethod
  setBackgroundColor(id: number, argbColor: number) {
    let windowClass = this.getWindow(id);
    let data = WindowStyle.getStyleData(id);
    if (data !== undefined) {
      data.backgroundColor = `${WindowStyle.decimalColorToHex(argbColor)}`;
      WindowStyle.getUpdateStyleFunc(id)?.(data);
      windowClass?.setWindowBackgroundColor(`#${WindowStyle.decimalColorToHex(argbColor)}`);
      WindowStyle.updateStyleData(id, data);
    }
  }

  @LogMethod
  setOpacity(id: number, opacity: number) {
    let windowClass = this.getWindow(id);
    let data = WindowStyle.getStyleData(id);
    if (data !== undefined) {
      data.opacity = opacity;
      WindowStyle.getUpdateStyleFunc(id)?.(data);
      let lastColor = data.backgroundColor;
      windowClass?.setWindowBackgroundColor(`#${WindowStyle.decimalOpacityToHex(opacity)}${lastColor.slice(2)}`);
      WindowStyle.updateStyleData(id, data);
    }
  }

  @LogMethod
  setContentProtection(id: number, enable: boolean) {
    let windowClass = this.getWindow(id);
    try {
      windowClass?.setWindowPrivacyMode(enable, (err: BusinessError) => {
        const errCode: number = err.code;
        if (errCode) {
          LogUtil.error(TAG, `Failed to set the window to privacy mode. Cause code: ${err.code}, message: ${err.message}`);
          return;
        }
        LogUtil.info(TAG, 'Succeeded in setting the window to privacy mode.');
      });
    } catch (exception) {
      LogUtil.error(TAG, `Failed to set the window to privacy mode. Cause code: ${exception.code}, message: ${exception.message}`);
    }
  }

  @LogMethod
  setMovable(id: number, movable: boolean) {
    let windowClass = this.getWindow(id);
    try {
      windowClass?.setWindowTitleMoveEnabled(movable);
    } catch (exception) {
      LogUtil.error(TAG, `Failed to set the window Movable. Cause code: ${exception.code}, message: ${exception.message}`);
    }
  }

  @LogMethod
  setResizable(id: number, resizable: boolean) {
    let windowClass = this.getWindow(id);
    try {
      windowClass?.setResizeByDragEnabled(resizable).then(() => {}).catch((err: BusinessError) => {
        LogUtil.error(TAG, `Failed to set the window resizable. Cause ${JSON.stringify(err)}`);
      });
    } catch (exception) {
      LogUtil.error(TAG, `Failed to set the window resizable. Cause code: ${exception.code}, message: ${exception.message}`);
    }
  }

  @LogMethod
  startWindowMoving(id: number) {
    let window = this.getWindow(id);
    window?.startMoving().then(() => {
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `startWindowMoving fail, error info: ${JSON.stringify(err)}`);
    });
  }

  @LogMethod
  startWindowMovingWithOffset(id: number, offsetX: number, offsetY: number) {
    let window = this.getWindow(id);
    if (deviceInfo.sdkApiVersion >= 15) {
      window?.startMoving(offsetX, offsetY).then(() => {
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, `startWindowMovingWithOffset fail, error info: ${JSON.stringify(err)}`);
      });
    } else {
      LogUtil.error(TAG, 'startWindowMovingWithOffset fail, sdkApiVersion is less than 15');
    }
  }

  @LogMethod
  getWindowsByCoordinate(coordinate: PointCoordinate,
                         callback: (windowIds: Array<string>) => void) {
    let windowIds = new Array<string>();
    try {
      let displayId: number = display.getDefaultDisplaySync().id;
      window.getWindowsByCoordinate(displayId, this.queryWindowNum,
                                    coordinate.x, coordinate.y).then((windows) => {
        for (let win of windows) {
          let originWindowId: number = win.getWindowProperties().id
          let windowId = this.abilityManager.getWindowIdByOriginWindow(originWindowId);
          if (windowId) {
            windowIds.push(windowId);
          }
        }
        callback(windowIds);
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, 'window.getWindowsByCoordinate fail, code:' + JSON.stringify(err.code) +
          ',message:' + JSON.stringify(err.message));
        callback(windowIds);
      });
    } catch (err) {
      LogUtil.error(TAG, 'getWindowsByCoordinate fail, error:' + JSON.stringify(err));
      callback(windowIds);
    }
	}

  @LogMethod
  setWindowModal(modal: boolean, id: number) {
    let windowStage = this.abilityManager.getProxy(id)?.getWindowStage();
    windowStage?.setWindowModal(modal);
  }

  @LogMethod
  getWindowStatus(id: number): window.WindowStatusType {
    let windowClass = this.getWindow(id);
    let type = windowClass?.getWindowStatus();
    if (type !== undefined) {
      return type;
    }
    return window.WindowStatusType.UNDEFINED;
  }

  @LogMethod
  getOriginWindowIds(windowIds: Array<number>): Array<number> {
    let originWindowIds = new Array<number>();
    try {
      for (let i = 0; i < windowIds.length; i++) {
        let originWindowId = this.abilityManager.getProxy(windowIds[i])?.getOriginWindowId();
        originWindowIds.push(originWindowId ? originWindowId : -1);
      }
    } catch (err) {
      let message = (err as BusinessError).message;
      LogUtil.error(TAG, `getOriginWindowIds failed.: ${message}`);
    }
    return originWindowIds;
  }

  @LogMethod
  shiftWindowEvent(sourceId: number, targetId: number,
    callback: (result: boolean) => void): void {
    if (deviceInfo.sdkApiVersion >= 15) {
      try {
        let sourceOriginWindowId = this.abilityManager.getProxy(sourceId)?.getOriginWindowId();
        let targetOriginWindowId = this.abilityManager.getProxy(targetId)?.getOriginWindowId();
        window.shiftAppWindowPointerEvent(sourceOriginWindowId, targetOriginWindowId).then(() => {
          LogUtil.info(TAG, 'shiftWindowEvent success.');
          callback(true);
        }).catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to shiftWindowEvent. Cause: ' + JSON.stringify(err));
          callback(false);
        })
      } catch (err) {
        let message = (err as BusinessError).message;
        LogUtil.error(TAG, `shiftWindowEvent failed.: ${message}`);
        callback(false);
      }
    } else {
      LogUtil.error(TAG, 'shiftWindowEvent fail, sdkApiVersion is less than 15');
      callback(false);
    }
  }

  @LogMethod
  showHuaweiQuickLogin(
      id: number,
      show: boolean,
      bounds: WindowBound,
      callback: (loginInfo: ILoginInfo) => void) {
    const loginFailInfo: ILoginInfo = {
      status: false,
      authCode: '',
      unionId: '',
      openId: '',
      idToken: '',
      anonymousPhone: ''
    };

    if (!show && this.loginWindow) {
      this.loginWindow.destroyWindow((err: BusinessError) => {
        let errCode: number = err.code;
        if (errCode) {
          LogUtil.error(TAG, 'Failed to destroy the window. Cause: ' + JSON.stringify(err));
          return;
        }
        LogUtil.info(TAG, 'Succeeded in destroying the window.');

        this.loginWindow = null;
      });
      return;
    };

    if (this.loginWindow) {
      callback(loginFailInfo);
      return;
    }

    let activeContext = this.ctxAdapter.getActiveContext() as common.UIAbilityContext;
    if (!activeContext) {
      LogUtil.error(TAG, 'Failed to get active context');
      return;
    }
    let config: window.Configuration = {
      name: 'login',
      windowType: window.WindowType.TYPE_DIALOG,
      ctx: activeContext
    };
    window.createWindow(config, (err: BusinessError, data) => {
      if (err.code) {
        LogUtil.error(TAG, 'Failed to create window. Cause: ' + JSON.stringify(err));
        return;
      }
      let windowClass: window.Window = data;
      if (!this.loginWindow) {
        this.loginWindow = windowClass;
      }
      windowClass.moveWindowTo(bounds.left, bounds.top, (err: BusinessError) => {
        let errCode: number = err.code;
        if (errCode) {
          LogUtil.error(TAG, `Failed to move the window. Cause:${JSON.stringify(err)}`);
          return;
        }
        LogUtil.info(TAG, `succeeded in moving the window.`);
      });
      windowClass.resize(bounds.width, bounds.height, (err: BusinessError) => {
        let errCode: number = err.code;
        if (errCode) {
          LogUtil.error(TAG, `Failed to change the window size. Cause:${JSON.stringify(err)}`);
          return;
        }
        LogUtil.info(TAG, `succeeded in changing the window size.`);
      });
      windowClass.showWindow((err: BusinessError) => {
        const errCode: number = err.code;
        if (errCode) {
          LogUtil.error(TAG, `Failed to show the window. Cause: ${JSON.stringify(err)}`);
          return;
        }
        LogUtil.info(TAG, 'Succeeded in showing the window.');
      });
      const para: Record<string, ILogin> = {
        'login': {
          'loginCallbackFunc': callback
        }
      };
      let storage: LocalStorage = new LocalStorage(para);
      windowClass.loadContent("pages/Login", storage, (err, data) => {
        let errCode: number = err.code;
        if (errCode) {
          LogUtil.error(TAG, 'Failed to load the content. Cause:' + JSON.stringify(err));
          return;
        }
        windowClass.setWindowBackgroundColor('#00000000'); // argb
      });
    });
  }

  @LogMethod
  getWindowId(id: number): number {
    let windowClass = this.getWindow(id);
    let windowId = windowClass?.getWindowProperties().id;
    if (windowId === undefined) {
      LogUtil.error(TAG, 'getWindowId failed, return -1.');
      return -1;
    }
    return windowId;
  }
};
