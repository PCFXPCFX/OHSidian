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
import { ConfigData } from '../common/Constants';
import { ContextAdapter } from './ContextAdapter';
import { IStyleData, IUpdateStyle, WindowStyle } from '../common/WindowStyle';
import { WebProxy } from '../interface/WebProxy';
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
  // Set synchronously on show=true, cleared when the create callback settles
  // - closes the window between "show requested" and "window assigned".
  private loginWindowCreating: boolean = false;
  // Round 106: engine window ids that have been told to close but whose ability
  // is still tearing down (closeWindow -> terminateSelf is async, and the proxy
  // only disappears in onWindowStageDestroy). createWindow must never launch a
  // new window FROM such a window: its context is already terminating and every
  // startAbility fails (16000067, then 16200001). Device log 09.070 closeWindow(1)
  // -> 09.079 "launch from primary window context" (browser1, the closing one)
  // -> three failed launches -> browser4 never appeared, the engine waited ~20 s.
  // Engine window ids are monotonically allocated per process, so entries never
  // need recycling.
  private closingWindows: Set<string> = new Set<string>();
  // Round 154: last limits requested by the engine (min-max tuple). Used to
  // drop identical repeats in the touch form factor, where WMS ignores the
  // limits anyway (device log 07:39:36.951 and 07:39:59.646 both requested
  // 450x282 and both produced "could not update new size").
  private lastLimitsKey: string = '';

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

  private isClosing(proxyId: string): boolean {
    return this.closingWindows.has(proxyId);
  }

  // Round 106: a FULL_SCREEN window cannot honour move/resize/limits - WMS
  // rejects moveWindowToAsync with 1300010 and ignores size limits
  // ("fullscreen or compatible mode could not update new size"). The engine
  // keeps issuing them (device log: setBounds x4, then limits 0..MAX ->
  // 1800x1463 -> 1800x1519 while the window stayed 2800x1840), which left the
  // engine's own size model diverged from the real window.
  private isFullscreenWindow(windowClass: window.Window | undefined): boolean {
    if (!windowClass) {
      return false;
    }
    try {
      return windowClass.getWindowStatus() === window.WindowStatusType.FULL_SCREEN;
    } catch (exception) {
      return false;
    }
  }

  // setBounds is allowed to take a fullscreen window OUT of fullscreen (the
  // engine's remembered-rect restore), so the skip needs the form factor too:
  // only the TOUCH regime (tablet without PC mode, phone) is guaranteed
  // single-window/full-display.
  private isTouchFullscreen(windowClass: window.Window | undefined): boolean {
    if (!this.isFullscreenWindow(windowClass)) {
      return false;
    }
    return this.isTouchFormFactorStrict();
  }

  // Audit P2-2: for a DESTRUCTIVE decision (skip the engine's remembered-rect
  // restore) a settings read failure must NOT be translated into "touch".
  // Only a successful read of 'false' counts as touch on a tablet; unknown or
  // PC stays non-touch, same direction as WebAbility's "read failure keeps the
  // window form factor" invariant. Phone has no PC mode at all.
  private isTouchFormFactorStrict(): boolean {
    if (deviceInfo.deviceType === 'phone') {
      return true;
    }
    if (deviceInfo.deviceType !== 'tablet') {
      return false;
    }
    try {
      const ctx = this.ctxAdapter.getActiveContext() || this.ctxAdapter.getContext();
      const value: string = settings.getValueSync(ctx, 'window_pcmode_switch_status',
        'true', settings.domainName.USER_PROPERTY);
      return value === 'false';
    } catch (exception) {
      LogUtil.warn(TAG, 'touch form factor read failed, not skipping setBounds: ' +
        JSON.stringify(exception));
      return false;
    }
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

  // Round 99: the vault chooser (starter window) is the one that calls
  // createWindow, and it destroys itself the moment the synchronous
  // vault-open IPC returns (starter.js does window.close() right after
  // sendSync). Starting the new vault ability FROM that dying context made
  // the system background the fresh window a few seconds later and hand
  // focus back to the previous window - the reported "打开新仓库时窗口跳转"
  // (docs/CHANGES-2026-09.md round 31 recorded the 3.3s focus bounce and
  // could not name the trigger). Launch from a STABLE window instead: the
  // primary ability when it is alive, else the oldest live window. The
  // active context is only correct for the app's very first window, where no
  // other window exists yet.
  private launchContext(): Context | undefined {
    try {
      const list: WebProxy[] = this.abilityManager.getProxyList();
      // Round 106: never launch from a window that has been asked to close -
      // its context is already terminating and startAbility fails every retry
      // (device log 09.070..09.096: primary closed, then "launch from primary
      // window context", then 16000067 / 16200001 / 16200001). The primary is
      // still preferred when it is alive; otherwise the oldest LIVE window.
      // Audit fix: prune marks whose proxy is gone (a rejected terminateSelf
      // or an engine id that was never in this proxy list must not blacklist a
      // live window for the rest of the process).
      this.pruneClosingWindows(list);
      let fallback: Context | undefined = undefined;
      let fallbackId: string = '';
      for (let i = 0; i < list.length; i++) {
        if (this.isClosing(list[i].getWindowId())) {
          LogUtil.warn(TAG, 'launch context: window ' + list[i].getWindowId() +
            ' is closing, skipping');
          continue;
        }
        const ctx = list[i].getWindowContext() as Context | undefined;
        if (ctx === undefined) {
          continue;
        }
        if (list[i].getWindowId() === ConfigData.DEFAULT_WINDOW_ID) {
          LogUtil.info(TAG, 'launch from primary window context');
          return ctx;
        }
        if (fallback === undefined) {
          fallback = ctx;
          fallbackId = list[i].getWindowId();
        }
      }
      if (fallback !== undefined) {
        LogUtil.info(TAG, 'launch from oldest live window context: ' + fallbackId +
          ' (primary ' + ConfigData.DEFAULT_WINDOW_ID + ' unavailable)');
        return fallback;
      }
      // Every window is closing: there is no stable context left. Fall back to
      // the active context - it may already be terminating, in which case the
      // failure callback reports it. warn, not error: this path can still
      // succeed and a device-log grep must not read it as a failure.
      LogUtil.warn(TAG, 'launch context: all windows are closing, falling back to active context');
    } catch (exception) {
      LogUtil.warn(TAG, 'launchContext failed: ' + JSON.stringify(exception));
    }
    return this.ctxAdapter.getActiveContext();
  }

  private pruneClosingWindows(list: WebProxy[]): void {
    if (this.closingWindows.size === 0) {
      return;
    }
    const live: Set<string> = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      live.add(list[i].getWindowId());
    }
    const stale: Array<string> = [];
    this.closingWindows.forEach((id: string) => {
      if (!live.has(id)) {
        stale.push(id);
      }
    });
    for (let i = 0; i < stale.length; i++) {
      this.closingWindows.delete(stale[i]);
    }
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
    // Per-side borders (round 95, Bug 2): HarmonyOS 2in1 / tablet native
    // frames carry ONLY a top caption (~32-71 px); left/right/bottom are 0.
    // The old symmetric assumption (width += 2x left, height += 2x top) grew
    // the height by an extra caption per conversion. Right/bottom come from
    // the PARENT window's chrome (the new window carries the same frame
    // style); zeroed while the drawable rect has not been composed yet.
    let leftBorder: number = param.hide_title_bar ? 0 : windowProp?.drawableRect.left || 0;
    let topBorder: number = param.hide_title_bar ? 0 : windowProp?.drawableRect.top || 0;
    let rightBorder: number = 0;
    let bottomBorder: number = 0;
    if (!param.hide_title_bar && windowProp && windowProp.drawableRect.width > 0 &&
      windowProp.drawableRect.height > 0) {
      rightBorder = Math.max(0, windowProp.windowRect.width -
        windowProp.drawableRect.left - windowProp.drawableRect.width);
      bottomBorder = Math.max(0, windowProp.windowRect.height -
        windowProp.drawableRect.top - windowProp.drawableRect.height);
    }

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
      rightBorder = 0;
      bottomBorder = 0;
      centered = true;
      LogUtil.warn(TAG, 'createWindow without valid bounds, using 800x650 DIP centered');
    }

    // Per-side borders (see above): width grows by left+right, height by
    // top+bottom - NOT 2x each. Borders are px; the engine bounds are
    // DIP - convert borders to DIP before adding.
    let widthDip: number = Math.round(bounds.width + (leftBorder + rightBorder) / density);
    let heightDip: number = Math.round(bounds.height + (topBorder + bottomBorder) / density);
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

    // Touch mode runs single-window, so a new vault window created STARTUP_HIDE
    // leaves the app with NO visible window for the 1-2 s the page takes to
    // load; the system fills that gap with its "app leaves, icon flies home"
    // exit animation (the flash reported when switching vaults). Showing the
    // start window immediately keeps a window on screen the whole time - the
    // splash colour covers the load instead of the launcher animation.
    const touchFullscreen: boolean = deviceInfo.deviceType === 'tablet' && !this.isTabletPcMode();
    const startupVisibility: contextConstant.StartupVisibility =
      (param.show || touchFullscreen) ? contextConstant.StartupVisibility.STARTUP_SHOW :
        contextConstant.StartupVisibility.STARTUP_HIDE;

    const launch = (icon: image.PixelMap | undefined): void => {
      let options: StartOptions = {
        processMode: contextConstant.ProcessMode.ATTACH_TO_STATUS_BAR_ITEM,
        startupVisibility: startupVisibility,
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
      if (touchFullscreen) {
        options.windowMode = AbilityConstant.WindowMode.WINDOW_MODE_FULLSCREEN;
        options.windowLeft = 0;
        options.windowTop = 0;
      }
      if (param.display_id != -1) {
        options.displayId = param.display_id;
      }
      LaunchHelper.LaunchWithOptions(this.launchContext(), want, options, () => {
        // Round 106: the whole retry ladder is exhausted - this window id will
        // never get an XComponent. Without this line the only trace was the
        // engine's own "getProxy failed, proxyId: browserN" loop for ~20 s.
        LogUtil.error(TAG, 'createWindow: every launch attempt failed for window ' +
          param.window_id + ' - no XComponent will be created for it');
      });
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
    // Round 106: record the close BEFORE terminateSelf (async). createWindow
    // may run in the same task and must not choose this window as its launch
    // context (see closingWindows).
    let closingId: string = '';
    if (proxy !== undefined) {
      closingId = proxy.getWindowId();
      this.closingWindows.add(closingId);
      LogUtil.info(TAG, 'closeWindow: window ' + closingId + ' marked closing');
    }
    let context = proxy?.getWindowContext() as common.UIAbilityContext;
    if (!context) {
      // Without a context the terminate call is a silent no-op and the
      // engine believes the window closed while it is still on screen.
      LogUtil.error(TAG, 'closeWindow: no context for window ' + id +
        ', proxy=' + JSON.stringify(proxy !== undefined));
      // Audit fix: the close did not happen - do not blacklist a live window.
      if (closingId !== '') {
        this.closingWindows.delete(closingId);
      }
      return;
    }
    context.terminateSelf()
      .then(() => {
        LogUtil.info(TAG, 'closeWindow success: ' + id);
      })
      .catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to close window. Cause: ' + JSON.stringify(err));
        // Audit fix: a rejected terminate means the window may still be alive;
        // keep it eligible as a launch context (prune would also drop it only
        // once its proxy disappears, which never happens if it stays up).
        if (closingId !== '') {
          this.closingWindows.delete(closingId);
        }
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
    let proxy = this.abilityManager.getProxy(id);
    let context = proxy?.getWindowContext() as common.UIAbilityContext;
    context?.showAbility().then(() => {
      LogUtil.info(TAG, `showAbility success`);
    }).catch((err: BusinessError) => {
      // This WMS build rejects showAbility's internally-attached StartOptions
      // with 16000067 (the same quirk the LaunchHelper retry ladder works
      // around, docs/CHANGES-2026-09.md rounds 22/31). At startup the
      // ability is already foreground, so the rejected call is a no-op -
      // expected, not an error.
      if (err.code === 16000067) {
        // Round 111 audit: the rejection is benign ONLY while the window is
        // really in front. The one state that used to trap the app is
        // MINIMIZE (device log: minimize at 42.298, rejected show at 42.616,
        // then nothing). Only that state gets the window-level fallback:
        // Obsidian calls show() two or three times during startup while the
        // window is already FULL_SCREEN, and an unconditional window.show()
        // there would be a redundant WMS round-trip on every launch.
        if (this.isTouchFormFactorStrict()) {
          const windowClass = proxy?.getWindow();
          try {
            if (windowClass &&
              windowClass.getWindowStatus() === window.WindowStatusType.MINIMIZE) {
              this.bringWindowToFront(windowClass);
              return;
            }
          } catch (statusException) {
            LogUtil.warn(TAG, 'read window status failed: ' + JSON.stringify(statusException));
          }
        }
        LogUtil.info(TAG, 'showAbility rejected by WMS (16000067), window left as-is');
        return;
      }
      LogUtil.error(TAG, `showAbility fail, err: ${JSON.stringify(err)}`);
    });
  }

  // Round 111: foreground recovery for a MINIMISED touch-form-factor window,
  // used when the ability-level show is rejected with 16000067. A failing
  // restore() must not skip show(): the window may still be showable.
  private bringWindowToFront(windowClass: window.Window): void {
    try {
      windowClass.restore()
        .catch((restoreError: BusinessError) => {
          LogUtil.warn(TAG, 'restore minimised window failed: ' + JSON.stringify(restoreError));
        })
        .then(() => windowClass.show())
        .then(() => {
          LogUtil.info(TAG, 'showAbility rejected; minimised window restored and shown');
        })
        .catch((err: BusinessError) => {
          LogUtil.warn(TAG, 'bring window to front failed: ' + JSON.stringify(err));
        });
    } catch (exception) {
      LogUtil.warn(TAG, 'bring window to front threw: ' + JSON.stringify(exception));
    }
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

    // Round 106 (P2-5): touch-mode window == the whole display. WMS rejects
    // the move with 1300010 and there is no rect to restore, so every engine
    // push only cost a round-trip (device log: setBounds x4 in 60 ms, all
    // rejected). Window mode is exempt - setBounds is how the engine restores
    // a remembered floating rect there.
    if (this.isTouchFullscreen(windowClass)) {
      LogUtil.info(TAG, 'setBounds skipped: window ' + id + ' is fullscreen on touch form factor');
      callback && callback();
      return;
    }

    const windowProp = windowClass?.getWindowProperties();

    // Mobile-emulated window requests can carry no geometry at all ({}):
    // moving/resizing with NaN gets rejected by the system (1300010). Treat
    // missing width/height as "keep the current rect" and fill missing
    // position fields from the current rect.
    // isNaN cannot detect those missing fields: ArkTS isNaN does NOT coerce
    // (Number.isNaN semantics), so isNaN(undefined) is false and {} used to
    // reach moveWindowToAsync and die with 1300010. Comparisons do catch
    // undefined (undefined > 0 is false), same idiom as the
    // SubWindowAdapter.createSubWindow guard.
    if (!(bounds.width > 0) || !(bounds.height > 0)) {
      LogUtil.error(TAG, 'setBounds without usable geometry, keeping current rect');
      callback && callback();
      return;
    }
    if (!(bounds.left >= 0)) {
      bounds.left = windowProp?.windowRect.left || 0;
    }
    if (!(bounds.top >= 0)) {
      bounds.top = windowProp?.windowRect.top || 0;
    }

    // xComponent bounds need to add a border. Per-side (round 95, Bug 2):
    // the old symmetric assumption (width += 2x left, height += 2x top) is
    // wrong on native-frame windows where only the TOP caption is non-zero
    // (left/right/bottom are 0) - every restore grew the height by an extra
    // caption and the saved height drifted on every launch (user report:
    // "width remembers, height drifts"). With per-side borders the outer
    // rect is exactly content + chrome, so the saved content size is stable.
    const drawable = windowProp?.drawableRect;
    const windowRect = windowProp?.windowRect;
    let leftBorder: number = hasFrame ? drawable?.left || 0 : 0;
    let topBorder: number = hasFrame ? drawable?.top || 0 : 0;
    let rightBorder: number = 0;
    let bottomBorder: number = 0;
    if (hasFrame && drawable && windowRect && drawable.width > 0 &&
      drawable.height > 0) {
      rightBorder = Math.max(0, windowRect.width - drawable.left - drawable.width);
      bottomBorder = Math.max(0, windowRect.height - drawable.top - drawable.height);
    }
    bounds.left -= leftBorder;
    bounds.top -= topBorder;
    bounds.width = bounds.width + leftBorder + rightBorder;
    bounds.height = bounds.height + topBorder + bottomBorder;

    // Diagnostic: the engine manages window bounds itself (desktop behavior);
    // on fullscreen windows the system rejects the calls. Log both the
    // requested and the actual rect to attribute viewport gaps. Scalar fields
    // (round 106): JSON.stringify of the napi-backed WindowBound printed "{}",
    // so device logs showed "setBounds requested={}" with no geometry.
    LogUtil.error(TAG, 'setBounds requested=' +
      bounds.left + ',' + bounds.top + ' ' + bounds.width + 'x' + bounds.height +
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
    // Round 106 (P2-5): limits cannot resize a FULL_SCREEN window (WMS logs
    // "fullscreen or compatible mode could not update new size" and keeps the
    // rect). The engine's repeated limit churn (0..MAX -> 1800x1463 ->
    // 1800x1519) made its size model diverge from the real 2800x1840 window.
    // Round 106 (P2-5) reverted for limits (audit P2-1): a FULL_SCREEN window
    // ignores the limits today, but the call carries STATE ("this window must
    // stay 1800x1463") that is lost if the window later leaves fullscreen
    // without a new setWindowLimits. WMS answering "could not update new size"
    // is the accepted cost; only setBounds (guaranteed 1300010, no state) is
    // short-circuited.

    const windowProp = windowClass.getWindowProperties();
    let xComBorder: number = windowProp?.drawableRect.left || 0;
    let xComTop: number = windowProp?.drawableRect.top || 0;
    // Per-side borders (round 95, Bug 2 - see setBounds): limits apply to
    // the OUTER window, so the content limits grow by left+right / top+bottom.
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

      // Round 154: drop identical repeats in the touch form factor. The
      // limits cannot resize a FULL_SCREEN window (round 106 P2-5 kept the
      // call for the state it carries), but an identical repeat carries no
      // new state - the device log shows the same 450x282 requested twice
      // (07:39:36.951 on backgrounding, 07:39:59.646 on the next
      // backgrounding) with WMS answering "could not update new size" both
      // times. Values still change with density (383x311 @1.9125 in window
      // mode in the same log), so a mode/density transition still applies.
      // Window-mode calls are always forwarded: a re-created window has
      // default limits and must receive the engine's values again.
      const limitsKey: string = windowLimits.minWidth + 'x' + windowLimits.minHeight +
        '-' + windowLimits.maxWidth + 'x' + windowLimits.maxHeight;
      if (this.isTouchFormFactorStrict() && limitsKey === this.lastLimitsKey) {
        LogUtil.info(TAG, 'setWindowLimits skipped: identical limits in touch form factor (' +
          limitsKey + ')');
        return;
      }
      this.lastLimitsKey = limitsKey;

      windowClass.setWindowLimits(windowLimits)
        .catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to change the window limits. Cause: ' + JSON.stringify(err));
        });    } catch (exception) {
      LogUtil.error(TAG, 'change the window limits exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  maximize(id: number) {
    // Round 111: in the touch form factor the window already IS the display;
    // win.maximize() is only the desktop window-state restore. This WMS
    // answers "Maximize: The device is not supported" while the promise still
    // resolves, so the old "Succeeded in maximizing the window." log made
    // Obsidian persist isMaximized=true for a window that was never maximized
    // (device log 18:08:42.293).
    if (this.isTouchFormFactorStrict()) {
      LogUtil.info(TAG, 'maximize ignored: touch form factor window is already the display');
      return;
    }
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
    // Round 111: a touch-form-factor window has NO minimised state - the app
    // is a single full-display window and leaving it must go through the
    // system (Home/back), not through the desktop `win.minimize()` path.
    // The device log showed the engine minimising the window 8 ms after
    // startup (42.298) with no input event at all, and the app then stayed in
    // the background because the follow-up showAbility is rejected with
    // 16000067. Cancelling here is the non-destructive direction; the settings
    // read is strict so a read failure keeps the old behaviour (R106 P2-2).
    if (this.isTouchFormFactorStrict()) {
      LogUtil.warn(TAG, 'minimize ignored: touch form factor has no minimized state');
      return;
    }
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
      // [OHSidian] BUG-002: this is the OTHER writer of button visibility. If
      // the trio still appears with 窗口边框样式 = 隐藏, this call (from the
      // engine's frame-style handling) is the one that re-shows it - the log
      // below says whether that happened.
      LogUtil.info(TAG, '[OHSidian] setUseNativeFrame: useNativeFrame=' + useNativeFrame +
        ' id=' + id);
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
  setBackgroundColor(id: number, argbColor: number) {    let windowClass = this.getWindow(id);
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
    // Round 106 (P2-5) reverted for resizable (audit P2-1): the call carries
    // STATE (a non-resizable window must stay non-resizable) and costs one
    // drag-enable toggle, so it is sent even on FULL_SCREEN - dropping it here
    // would silently re-enable drag-resize for a window that later leaves
    // fullscreen.
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

    if (!show) {
      if (this.loginWindow) {
        // Release the reference BEFORE the async destroy: if destroy fails,
        // keeping it would make every later show=true fail fast forever
        // (login permanently broken until restart). Recover instead - the
        // stale window object is dropped and a fresh one can be created.
        const staleWindow = this.loginWindow;
        this.loginWindow = null;
        staleWindow.destroyWindow((err: BusinessError) => {
          let errCode: number = err.code;
          if (errCode) {
            LogUtil.error(TAG, 'Failed to destroy the login window. Cause: ' + JSON.stringify(err));
            return;
          }
          LogUtil.info(TAG, 'Succeeded in destroying the login window.');
        });
      }
      this.loginWindowCreating = false;
      return;
    }

    // The window reference is only assigned inside the async createWindow
    // callback, so a second show=true arriving before that must fail fast
    // here too - otherwise two windows get created and one leaks.
    if (this.loginWindow || this.loginWindowCreating) {
      callback(loginFailInfo);
      return;
    }
    this.loginWindowCreating = true;

    let activeContext = this.ctxAdapter.getActiveContext() as common.UIAbilityContext;
    if (!activeContext) {
      LogUtil.error(TAG, 'Failed to get active context');
      this.loginWindowCreating = false;
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
        this.loginWindowCreating = false;
        return;
      }
      let windowClass: window.Window = data;
      this.loginWindow = windowClass;
      this.loginWindowCreating = false;
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
