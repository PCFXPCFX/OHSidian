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

import LogUtil from '../utils/LogUtil';
import window from '@ohos.window';
import { display } from '@kit.ArkUI';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import { BusinessError, deviceInfo, settings } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { NativeThemeAdapter } from '../adapter/NativeThemeAdapter';
import { AbilityManager } from '../common/AbilityManager';
import { Configuration } from '@ohos.app.ability.Configuration';
import Inject from '../common/InjectModule';
import { CaptionButtonRect, WindowBound } from '../interface/CommonInterface';
import CheckEmptyUtils from '../utils/CheckEmptyUtils';
import { WebBaseAbility } from './WebBaseAbility';
import { WindowStyle, IStyleData, IUpdateStyle } from '../common/WindowStyle';
import { CommandType, ConfigData } from '../common/Constants';
import { CloudSyncAdapter } from '../adapter/CloudSyncAdapter';
import { PermissionManagerAdapter } from '../adapter/PermissionManagerAdapter';
import { RunningLockAdapter } from '../adapter/RunningLockAdapter';
import { ConfigurationConstant } from '@kit.AbilityKit';

const TAG: string = 'WebAbility';

export class WebAbility extends WebBaseAbility {
  private static WINDOW_CLOSE: number = 1000;
  private abilityManager: AbilityManager | undefined = undefined;
  private nativeThemeAdapter: NativeThemeAdapter | undefined = undefined;
  // PC-mode (floating windows) state on tablets; kept in sync with the
  // window_pcmode_switch_status system setting by the observer registered in
  // onWindowStageCreate. Drives the forced-maximize policy and the touch-mode
  // file.
  private pcModeEnabled: boolean = false;
  // Free-window caption strip height in CSS px (1 vp == 1 css px), tracked
  // from windowTitleButtonRectChange and published through the mode file so
  // the web content can avoid the strip. 0 = fullscreen / no caption.
  private captionCss: number = 0;
  private mainWindow: window.Window | undefined = undefined;

  // Display-mode state machine (see updateWindowPcmodeSwitchStatus):
  // Official immersive pattern: the window uses layout fullscreen, so the
  // app background extends edge-to-edge under the (visible, system-managed)
  // status bar and navigation indicator; the WEB CONTENT avoids them using
  // the real insets we publish through ohsidian-mode.json (see
  // pushSafeAreaInsets). We never hide the bars.
  //  - tablet, PC mode off  -> fullscreen layout; window forced back to
  //    maximize on launch / after PC-mode switches (the system restores the
  //    app in whatever state it last had, including a floating window);
  //    maximize follows the app's fullscreen setting, so the bars stay.
  //  - tablet, PC mode on   -> free-floating windows; insets published as 0
  //    (floating windows never overlap the bars).
  //  - phone                -> same fullscreen layout with real insets.
  //  - 2in1 / PC            -> plain windowed behavior, insets 0.

  // Synthesizes the engine viewport from window properties. With layout
  // fullscreen the system reports drawableRect == windowRect (no bars are
  // subtracted), so the full window rect is correct; PC-mode floating
  // windows keep the decorated drawableRect semantics in case a frame is
  // present. All bounds listeners and the re-push timer share this single
  // implementation.
  private computeViewportBound(prop: window.WindowProperties): WindowBound {
    const full = !this.pcModeEnabled;
    return {
      left: full ? prop.windowRect.left : prop.windowRect.left + prop.drawableRect.left,
      top: full ? prop.windowRect.top : prop.windowRect.top + prop.drawableRect.top,
      width: full ? prop.windowRect.width : prop.drawableRect.width,
      height: full ? prop.windowRect.height : prop.drawableRect.height,
    };
  }

  // Publishes the real system-bar insets (CSS px) to the renderer through
  // ohsidian-mode.json. This is the officially recommended immersive
  // pattern: the background extends under the bars, while interactive
  // content avoids them using these values (Obsidian's mobile CSS consumes
  // --safe-area-inset-top/bottom, which otherwise fall back to a hardcoded
  // simulated iPhone notch). Zero for PC-mode floating windows and for
  // 2in1/PC, whose windows never overlap the bars.
  private pushSafeAreaInsets(): void {
    let topPx: number = 0;
    let bottomPx: number = 0;
    const winObj = this.mainWindow;
    try {
      const handheld: boolean = deviceInfo.deviceType === 'tablet' ||
        deviceInfo.deviceType === 'phone';
      if (handheld && !this.pcModeEnabled && winObj) {
        const sysAvoid = winObj.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
        const navAvoid = winObj.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
        topPx = sysAvoid.topRect.height;
        // Gesture indicator on tablets/phones; the system nav bar (three-key
        // mode) reports through TYPE_SYSTEM instead - take whichever applies.
        bottomPx = Math.max(navAvoid.bottomRect.height, sysAvoid.bottomRect.height);
      }
    } catch (exception) {
      LogUtil.warn(TAG, 'read avoid areas failed: ' + JSON.stringify(exception));
    }
    let density: number = 1;
    try {
      density = display.getDefaultDisplaySync().densityPixels;
    } catch (exception) {
      LogUtil.warn(TAG, 'read display density failed: ' + JSON.stringify(exception));
    }
    if (!density || density <= 0) {
      density = 1;
    }
    // Physical px -> CSS px (Chromium maps 1 css px to one density pixel).
    const topCss: number = Math.round(topPx / density * 100) / 100;
    const bottomCss: number = Math.round(bottomPx / density * 100) / 100;
    // Title-bar handling for free windows: the WMS caption strip (name +
    // minimize/maximize/close) is the only title bar that exists in EVERY
    // layout - the emulated-mobile web layout has none at all (hiding the
    // system caption there left the window with no bar whatsoever). Keep it
    // visible and let the web content avoid it via the published caption
    // height. Fullscreen windows have no caption. Re-evaluated on every
    // windowSizeChange: the caption only exists once the window becomes a
    // free window.
    let decor: string = 'none';
    try {
      const displayClass = display.getDefaultDisplaySync();
      let fullscreenLike: boolean = false;
      if (winObj !== undefined) {
        const rect = winObj.getWindowProperties().windowRect;
        fullscreenLike = rect.width >= displayClass.width &&
          rect.height >= displayClass.height;
      }
      if (winObj !== undefined && !fullscreenLike) {
        try {
          winObj.setWindowDecorVisible(true);
          winObj.setWindowTitleButtonVisible(true, true, true);
        } catch (captionException) {
          LogUtil.warn(TAG, 'show system caption failed: ' + JSON.stringify(captionException));
        }
        decor = 'system';
      }
    } catch (exception) {
      decor = 'none';
    }
    this.writeInsetsToFile(topCss, bottomCss, decor, this.captionCss);
  }

  // Read-modify-write for ohsidian-mode.json, preserving systemMode/override.
  private writeInsetsToFile(topCss: number, bottomCss: number, decor: string,
    captionCss: number): void {
    try {
      const filesDir: string = this.context.getApplicationContext().filesDir;
      const filePath: string = filesDir + '/ohsidian-mode.json';
      let cfg: Record<string, Object> = {};
      try {
        if (fileIo.accessSync(filePath)) {
          cfg = JSON.parse(fileIo.readTextSync(filePath)) as Record<string, Object>;
          if (!cfg) {
            cfg = {};
          }
        }
      } catch (e) {
        cfg = {};
      }
      const insets: Record<string, number> = { 'top': topCss, 'bottom': bottomCss };
      // windowSizeChange fires continuously during drag-resizes; skip the
      // file write when nothing actually changed.
      const unchanged: boolean = cfg['windowDecor'] === decor &&
        cfg['caption'] === captionCss &&
        cfg['insets'] !== undefined &&
        (cfg['insets'] as Record<string, number>)['top'] === topCss &&
        (cfg['insets'] as Record<string, number>)['bottom'] === bottomCss;
      if (unchanged) {
        return;
      }
      cfg['insets'] = insets;
      cfg['windowDecor'] = decor;
      cfg['caption'] = captionCss;
      const file = fileIo.openSync(filePath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(cfg));
      } finally {
        fileIo.closeSync(file);
      }
      LogUtil.info(TAG, 'safe-area insets updated: top=' + topCss + ', bottom=' + bottomCss);
    } catch (err) {
      LogUtil.error(TAG, 'failed to write insets to mode file: ' + JSON.stringify(err));
    }
  }

  // The engine can latch the viewport and miss resize events that fire before
  // its surface is attached (first launch), or keep a stale inset across
  // tablet/PC-mode switches. Re-push the current bounds so the viewport
  // converges to the actual window.
  private repushViewportBounds(): void {
    try {
      const win = this.mainWindow;
      if (!win) {
        return;
      }
      const bound = this.computeViewportBound(win.getWindowProperties());
      this.nativeContext.OnWindowSizeChange(this.xcomponentId, bound);
      LogUtil.info(TAG, 're-pushed viewport bounds: ' + JSON.stringify(bound));
    } catch (exception) {
      LogUtil.warn(TAG, 're-push viewport bounds failed: ' + JSON.stringify(exception));
    }
  }

  // Deferred variant of repushViewportBounds, optionally forcing the window
  // back to maximized first. Used by the first-launch settle and by the
  // PC-mode switch handler while the window rect is still settling.
  private settleViewportLater(delayMs: number, forceFullscreen: boolean): void {
    setTimeout(() => {
      if (forceFullscreen) {
        this.forceFullscreenWindow();
      }
      this.repushViewportBounds();
    }, delayMs);
  }

  // Forces the window back to fullscreen. The system restores the app window
  // in its previous state - including a floating free-window from a PC-mode
  // session - and in tablet mode the touch experience needs a fullscreen
  // window. maximize() does not reliably fill the screen for a restored
  // floating window (WMS may time out or leave a clamped rect, observed as
  // 2385x1711 against a 2800x1753 work area), so set the rect explicitly.
  //
  // Official immersive pattern (API 24): the rect is the WHOLE display at
  // (0,0) - no avoid-area subtraction. With layout fullscreen the window
  // then extends under the visible status bar / navigation indicator, and
  // the window-relative avoid areas are exactly the bar heights, which
  // pushSafeAreaInsets publishes to the web content. The previous
  // display.height-minus-inset rect at y=inset left the status-bar strip
  // OUTSIDE the window (dead background above the app) and zeroed the
  // window-relative top avoid area, so the renderer never received a top
  // inset - the reported "top bar not avoided" symptom.
  //
  // MAIN WINDOW ONLY: every EntryAbility instance (including new windows)
  // extends WebAbility and would otherwise yank itself to fullscreen right
  // after the engine placed it at its requested bounds - often a floating
  // window with a title bar. Resizing such a window mid-layout wedges it
  // (WMS "MoveToAsync Layout timeout"): the window shows but is unresponsive
  // - creation looks broken and the title-bar X does nothing.
  private forceFullscreenWindow(): void {
    if (this.xcomponentId !== ConfigData.DEFAULT_WINDOW_ID) {
      return;
    }
    const winObj = this.mainWindow;
    if (!winObj) {
      return;
    }
    try {
      const displayClass = display.getDefaultDisplaySync();
      // Already fullscreen-sized (layout fullscreen succeeded, window at
      // [0,0,display.w,display.h])? Resizing again is rejected by WMS with
      // 1300002 ("window state abnormal") - leave it alone.
      const prop = winObj.getWindowProperties();
      if (prop.windowRect.width >= displayClass.width &&
        prop.windowRect.height >= displayClass.height) {
        return;
      }
      winObj.resize(displayClass.width, displayClass.height)
        .then(() => {
          return winObj.moveWindowTo(0, 0);
        })
        .then(() => {
          LogUtil.info(TAG, 'forced fullscreen rect: ' + displayClass.width + 'x' +
            displayClass.height + ' @ (0,0)');
        })
        .catch((err: BusinessError) => {
          LogUtil.warn(TAG, 'force fullscreen (rect) failed: ' + JSON.stringify(err));
        });
    } catch (exception) {
      LogUtil.warn(TAG, 'force fullscreen (rect) threw: ' + JSON.stringify(exception));
    }
  }

  onConfigurationUpdate(config: Configuration) {
    if (config.colorMode !== undefined) {
      this.nativeThemeAdapter?.setSystemNativeTheme(config.colorMode);
    }
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam) {
    super.onCreate(want, launchParam);

    this.abilityManager = Inject.get(AbilityManager);
    this.nativeThemeAdapter = Inject.get(NativeThemeAdapter);

    Inject.get(PermissionManagerAdapter).initPermissions();

    // Initialize cloud sync. The login-trigger poll is NOT started here:
    // its trigger file (.hcs-login-pending) was written by the hcs-login IPC
    // handler the upstream fork injected into the 1.12.7 asar main.js, which
    // no longer exists in the stock 1.13.7 kernel (no writer greps in the
    // asar), so the poll could never fire. Restart it via
    // startLoginTriggerPolling once a login trigger writer is (re)introduced;
    // the foreground gating in the adapter is already in place.
    try {
      const cloudSync = Inject.getOrCreate(CloudSyncAdapter);
      cloudSync.initCloudSync(this.context, (ret: boolean) => {
        LogUtil.info(TAG, 'CloudSync init: ' + (ret ? 'success' : 'failed'));
      });
    } catch (e) {
      LogUtil.warn(TAG, 'CloudSync not available: ' + e);
    }
  }

  // Foreground/background hooks shared by every window ability (Entry,
  // Browser, Stateless all extend WebAbility). They gate the battery-sensitive
  // pieces on actual app visibility:
  //  - CloudSync login-trigger poll: DORMANT (no trigger-file writer exists
  //    in the 1.13.7 kernel, see onCreate); the notify calls are no-op
  //    counter updates until the poll is re-enabled, and then the poll will
  //    automatically run only while the app is visible.
  //  - RunningLock guard: a leaked engine keep-screen-on request must not
  //    hold the screen awake after the last window is backgrounded.
  onForeground(): void {
    try {
      Inject.getOrCreate(CloudSyncAdapter).notifyAppForeground();
    } catch (e) {
      LogUtil.warn(TAG, 'onForeground cloudSync notify failed: ' + e);
    }
    try {
      Inject.getOrCreate(RunningLockAdapter).notifyAppForeground();
    } catch (e) {
      LogUtil.warn(TAG, 'onForeground runningLock notify failed: ' + e);
    }
  }

  onBackground(): void {
    try {
      Inject.getOrCreate(CloudSyncAdapter).notifyAppBackground();
    } catch (e) {
      LogUtil.warn(TAG, 'onBackground cloudSync notify failed: ' + e);
    }
    try {
      Inject.getOrCreate(RunningLockAdapter).notifyAppBackground();
    } catch (e) {
      LogUtil.warn(TAG, 'onBackground runningLock notify failed: ' + e);
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage) {
    super.onWindowStageCreate(windowStage);

    if (this.checkSingleInstance()) {
      LogUtil.warn(TAG, 'repeat launch from desktop, need terminate');
      return;
    }

    this.abilityManager?.addProxy(this);

    this.mainWindow = windowStage.getMainWindowSync();
    // Diagnostic: dump the device shape - the mode branches below gate on it.
    LogUtil.error(TAG, 'diagnostic: deviceType=' + deviceInfo.deviceType +
      ', sdkApiVersion=' + deviceInfo.sdkApiVersion);
    // Layout fullscreen BEFORE loadContent (official immersive step 1): the
    // app background then extends under the visible status bar / navigation
    // indicator, and the real insets are published to the renderer via
    // pushSafeAreaInsets for the content avoidance. Without this the window
    // is inset by the system and a dead background strip shows above the
    // navigation indicator.
    try {
      this.mainWindow.setWindowLayoutFullScreen(true)
        .then(() => {
          LogUtil.info(TAG, 'Succeeded in setting window layout full screen');
        })
        .catch((err: BusinessError) => {
          LogUtil.warn(TAG, 'Failed to set window layout full screen: ' + JSON.stringify(err));
        });
    } catch (exception) {
      LogUtil.warn(TAG, 'Failed to call window layout full screen API: ' + JSON.stringify(exception));
    }

    windowStage.getMainWindow((err, data) => {
      if (err.code) {
        LogUtil.error(TAG, 'Failed to obtain the main window: ' + JSON.stringify(err));
        return;
      }
      
      try {
        data.on('windowStatusChange', (status) => {
          this.nativeContext.OnWindowStatusChange(this.xcomponentId, status);
        })
      } catch (exception) {
        LogUtil.error(TAG,'Failed to listener for window status changes: ' + JSON.stringify(exception));
      }

      try {
        data.on('windowSizeChange', (size) => {
          // Re-publish on every resize: the window-relative avoid areas AND
          // the system-caption detection (whole-display test) both follow the
          // window rect, and a plain resize does not fire avoidAreaChange.
          this.pushSafeAreaInsets();
          this.nativeContext.OnWindowSizeChange(this.xcomponentId,
            this.computeViewportBound(data.getWindowProperties()));
        });
      } catch (exception) {
        LogUtil.error(TAG,'Failed to listener for window size changes: ' + JSON.stringify(exception));
      }

      try {
        data.on("windowRectChange", (option) => {
          this.nativeContext.OnWindowRectChange(this.xcomponentId,
            this.computeViewportBound(data.getWindowProperties()),
            option.reason.valueOf());
        });
      } catch (exception) {
        LogUtil.error(TAG,'Failed to listener for window rect changes: ' + JSON.stringify(exception));
      }

      // Official immersive guidance: keep monitoring the avoid areas and
      // re-adapt when they change. Re-push the viewport (layout may rotate
      // or the bars may show/hide) and re-publish the real insets so the
      // web content avoidance follows the system.
      try {
        data.on('avoidAreaChange', (info) => {
          this.pushSafeAreaInsets();
          this.repushViewportBounds();
        });
      } catch (exception) {
        LogUtil.error(TAG,'Failed to listener for avoid area changes: ' + JSON.stringify(exception));
      }

      try {
        data.on('windowEvent', (type) => {
          if (type == window.WindowEventType.WINDOW_SHOWN) {
            this.nativeContext.OnWindowRectChange(this.xcomponentId,
              this.computeViewportBound(data.getWindowProperties()), 0);
          }
          this.nativeContext.OnWindowEvent(this.xcomponentId, type.valueOf());
        });
      } catch (exception) {
        LogUtil.error(TAG, 'Failed to register callback: ' + JSON.stringify(exception));
      }

      try {
        data.on("windowVisibilityChange", (visible) => {
          this.nativeContext.OnWindowVisibilityChange(this.xcomponentId, visible);
        });
      } catch (exception) {
       LogUtil.error(TAG, 'Failed to register callback: ' + JSON.stringify(exception));
      }
    });

    const para: Record<string, Object | string[] | IUpdateStyle> = {
      'xcomponentId': this.xcomponentId,
      'startUri': this.startUri,
      'electronRelaunchArgs': this.electronRelaunchArgs,
      'updateStyle': {
        'registerUpdateStyleFunction': WindowStyle.registerUpdateStyleFunction,
        'removeUpdateStyleFunction': WindowStyle.removeUpdateStyleFunction
      }
    };
    let storage: LocalStorage = new LocalStorage(para);
    windowStage.loadContent(this.getContentPath(), storage, (err, data) => {
      if (err.code) {
        LogUtil.error(TAG, 'Failed to load the content: ' + JSON.stringify(err));
        return;
      }

      let mainWin = windowStage.getMainWindowSync();
      this.mainWindow = mainWin;
      if (deviceInfo.deviceType === 'tablet') {
        // Publish the initial real insets once the window geometry exists;
        // avoidAreaChange keeps them fresh afterwards.
        this.pushSafeAreaInsets();
        // Diagnostics: dump avoid areas + rects after the hides settle, so a
        // persisting top gap can be attributed from the hilog.
        setTimeout(() => {
          try {
            const prop = mainWin.getWindowProperties();
            const sysAvoid = mainWin.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
            const navAvoid = mainWin.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
            LogUtil.error(TAG, 'avoid-area diagnostics: windowRect=' + JSON.stringify(prop.windowRect) +
              ', drawableRect=' + JSON.stringify(prop.drawableRect) +
              ', systemAvoid=' + JSON.stringify(sysAvoid) +
              ', navIndicatorAvoid=' + JSON.stringify(navAvoid));
          } catch (exception) {
            LogUtil.warn(TAG, 'avoid-area diagnostics failed: ' + JSON.stringify(exception));
          }
        }, 2000);
        // First launch only: the window is created at a smaller size and
        // maximized right after, and the engine can latch the initial viewport
        // and miss the resize events that fire before its surface is attached.
        // Re-push the current bounds a few times so the viewport settles at
        // the full window size.
        const startupSettleDelays: Array<number> = [600, 1500, 3000];
        startupSettleDelays.forEach((delayMs: number) => {
          // Touch mode needs the FULL display rect; the system may restore a
          // smaller (PC-mode session) rect on first launch. Force it here -
          // the engine latches the surface size once, so the window must be
          // final before the browser starts (SurfaceReady gates on that).
          const force: boolean = deviceInfo.deviceType === 'tablet' && !this.pcModeEnabled;
          this.settleViewportLater(delayMs, force);
        });
      }
      // hide title bar
      try {
        mainWin.setWindowDecorVisible(!this.hideTitleBar);
      } catch (exception) {
        LogUtil.warn(TAG, 'Failed to set window decor visible: ' + JSON.stringify(exception));
      }

      if (this.useDarkMode) {
        let buttonStyle: window.DecorButtonStyle = {
          colorMode: ConfigurationConstant.ColorMode.COLOR_MODE_DARK
        };
        try {
          mainWin.setDecorButtonStyle(buttonStyle);
        } catch (exception) {
          LogUtil.warn(TAG, 'Failed to set window decor button style: ' + JSON.stringify(exception));
        }
      }
      try {
        mainWin.setWindowTitleMoveEnabled(!this.hideTitleBar);
      } catch (exception) {
        LogUtil.warn(TAG, 'Failed to set window title move enabled: ' + JSON.stringify(exception));
      }
      try {
        mainWin.setWindowTitleButtonVisible(this.maximizable, this.minimizable, this.closable);
      } catch (exception) {
        LogUtil.warn(TAG, 'Failed to set window title button visible: ' + JSON.stringify(exception));
      }
      try {
        mainWin.setWindowTopmost(this.alwaysOntop);
      } catch (exception) {
        LogUtil.warn(TAG, 'Failed to set window topmost: ' + JSON.stringify(exception));
      }
      try {
        mainWin.setResizeByDragEnabled(this.resizable);
      } catch (exception) {
        LogUtil.warn(TAG, 'Failed to set resize by drag enabled: ' + JSON.stringify(exception));
      }
      try {
        windowStage.setWindowModal(this.isModal);
      } catch (exception) {
        LogUtil.warn(TAG, 'Failed to set window modal: ' + JSON.stringify(exception));
      }
      if (this.isPanel) {
        try {
          mainWin.setTitleAndDockHoverShown(false, false);
        } catch (exception) {
          LogUtil.warn(TAG, 'Failed to set title and dock hover shown: ' + JSON.stringify(exception));
        }
      }

      // window title button rect change callback must registered after loadContent/setUIContent
      try {
        mainWin.on("windowTitleButtonRectChange", (titleButtonRect) => {
          let rect: CaptionButtonRect = {
            right: vp2px(titleButtonRect.right),
            top: vp2px(titleButtonRect.top),
            width: vp2px(titleButtonRect.width),
            height: vp2px(titleButtonRect.height)
          };
          this.nativeContext.OnCaptionButtonRectChange(this.xcomponentId, rect);
          // Track the caption strip height for the web content (1 vp == 1
          // css px: the buttons sit inside the strip, so bottom-of-buttons
          // approximates the strip height). Re-publish the mode file when it
          // changes so the renderer can pad the content below the strip.
          const caption: number = Math.round(titleButtonRect.top + titleButtonRect.height);
          if (caption !== this.captionCss) {
            this.captionCss = caption;
            this.pushSafeAreaInsets();
          }
        });
      } catch (exception) {
        LogUtil.error(TAG, 'Failed to register window title button change callback: ' + JSON.stringify(exception));
      }

      if (deviceInfo.sdkApiVersion >= 15) {
        this.nativeContext.RegisterWindowEventFilter(mainWin.getWindowProperties().id);
      }

      if(deviceInfo.deviceType == 'tablet') {
        const context: Context = getContext(this);
        let res: boolean = settings.registerKeyObserver(context,
          'window_pcmode_switch_status', settings.domainName.USER_PROPERTY, () => {
          this.updateWindowPcmodeSwitchStatus(context);
        });
        LogUtil.info(TAG, 'register window_pcmode_switch_status,res:' + res + ',xcomponentId:' + this.xcomponentId);
        // Whether or not the observer registered, the current value must be
        // read once: a tablet already in PC mode at launch needs the right
        // mode, and the first read also triggers the fullscreen settle.
        this.updateWindowPcmodeSwitchStatus(context);
      } else {
        this.writeTouchModeFile(false);
      }
    });

    try {
      windowStage.on('windowStageClose', () => {
        this.nativeContext.OnWindowEvent(this.xcomponentId, WebAbility.WINDOW_CLOSE);
        return true;
      });
    } catch (exception) {
      console.error(`Failed to enable the listener for window stage close event. Cause code: ${exception.code}, message: ${exception.message}`);
    }
  }

  onWindowStageDestroy() {
    if (CheckEmptyUtils.isEmpty(this.xcomponentId)) {
      LogUtil.warn(TAG, 'onWindowStageDestroy component is not instantiated');
      return;
    }
    if (deviceInfo.sdkApiVersion >= 15) {
      let originWindowId = this.abilityManager?.getOriginWindowId(this.xcomponentId);
      this.nativeContext.ClearWindowEventFilter(originWindowId);
    }
    // Main window is destroyed, release UI related resources
    this.abilityManager?.removeProxy(this.xcomponentId);
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    let uriNotNull = want["uri"] !== undefined && want["uri"] !== '';
    if(want!== undefined && want !== null) {
      LogUtil.info(TAG, 'onNewWant begin, want: ' +
        'bundleName: ' + JSON.stringify(want.bundleName) +
        ', abilityName: ' + JSON.stringify(want.abilityName) +
        ', deviceId: ' + JSON.stringify(want.deviceId) +
        ', uri not null: ' + JSON.stringify(uriNotNull) +
        ', type: ' + JSON.stringify(want.type) +
        ', flags: ' + JSON.stringify(want.flags) +
        ', action: ' + JSON.stringify(want.action) +
        ', parameters: ' + JSON.stringify(want.parameters) +
        ', entities: ' + JSON.stringify(want.entities) +
        ', moduleName: ' + JSON.stringify(want.moduleName) +
        ', LaunchParam: ' + JSON.stringify(launchParam));
    }
    if (uriNotNull) {
      let uri = want['uri'] as string;
      this.openNewWindow(uri);
    }
  }

  onPrepareToTerminate(): boolean {
    this.nativeContext.OnWindowEvent(this.xcomponentId, WebAbility.WINDOW_CLOSE);
    return true;
  }

  private checkSingleInstance(): boolean {
    if (!CheckEmptyUtils.isEmpty(this.xcomponentId)) {
      return false;
    }
    this.openNewWindow(this.startUri);
    this.closeWindow();
    return true;
  }

  private openNewWindow(open_url: string) {
    // obsidian:// deep links (OAuth callbacks, e.g. Remotely Save / 坚果云
    // browser login) must be handed to the running Obsidian instance instead
    // of being opened as a new window.
    if (open_url.startsWith('obsidian://')) {
      this.writeProtocolUriFile(open_url);
      return;
    }
    this.nativeContext.ExecuteCommand(CommandType.kNewWindow, { url: open_url });
  }

  // Appends the deep link to <userData>/ohsidian-protocol.json. The patched
  // asar main.js polls this file and feeds new URIs into Obsidian's own
  // protocol handling (second-instance / open-url listeners), which routes
  // them to the registered plugin callback.
  private writeProtocolUriFile(uri: string) {
    try {
      const filesDir: string = this.context.getApplicationContext().filesDir;
      const filePath: string = filesDir + '/ohsidian-protocol.json';
      let cfg: Record<string, Object> = {};
      try {
        if (fileIo.accessSync(filePath)) {
          cfg = JSON.parse(fileIo.readTextSync(filePath)) as Record<string, Object>;
          if (!cfg) {
            cfg = {};
          }
        }
      } catch (e) {
        cfg = {};
      }
      let items: Array<Record<string, Object>> = [];
      if (cfg['items'] !== undefined && cfg['items'] !== null) {
        items = cfg['items'] as Array<Record<string, Object>>;
      }
      // Monotonic sequence: the renderer-side dispatcher compares against
      // lastDispatchedSeq, immune to system clock adjustments.
      let seq: number = 0;
      if (cfg['seq'] !== undefined && typeof cfg['seq'] === 'number') {
        seq = cfg['seq'] as number;
      }
      seq = seq + 1;
      const entry: Record<string, Object> = {
        'uri': uri,
        'seq': seq
      };
      items.push(entry);
      while (items.length > 5) {
        items.shift();
      }
      cfg['items'] = items;
      cfg['seq'] = seq;
      const file = fileIo.openSync(filePath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(cfg));
      } finally {
        fileIo.closeSync(file);
      }
      // Log without the query string: OAuth callbacks may carry tokens/codes.
      const queryIndex = uri.indexOf('?');
      const logSafe = queryIndex > 0 ? uri.substring(0, queryIndex) + '?…' : uri;
      LogUtil.info(TAG, 'protocol uri queued: ' + logSafe);
    } catch (err) {
      LogUtil.error(TAG, 'failed to write protocol uri file: ' + JSON.stringify(err));
    }
  }

  private updateWindowPcmodeSwitchStatus(context: Context) {
    try {
      let value = settings.getValueSync(context, 'window_pcmode_switch_status', 'false',
        settings.domainName.USER_PROPERTY);
      LogUtil.info(TAG, 'update window_pcmode_switch_status, ' +
        'new status:' + value + ',xcomponentId:' + this.xcomponentId);
      let newStatus: boolean = false;
      if (value === 'true') {
        newStatus = true;
      }
      const modeChanged: boolean = this.pcModeEnabled !== newStatus;
      this.pcModeEnabled = newStatus;
      this.nativeContext.UpdateWindowPcmodeSwitchStatusCB(newStatus);
      this.writeTouchModeFile(newStatus);
      // Floating PC-mode windows never overlap the bars -> publish zero
      // insets; back in tablet mode the real avoid areas apply again.
      this.pushSafeAreaInsets();
      if (deviceInfo.deviceType !== 'tablet') {
        return;
      }
      if (!this.mainWindow) {
        return;
      }
      // The window rect changes across the mode switch and the engine may
      // keep a stale viewport; re-sync after the window settles. Tablet mode
      // (including the first read at launch) additionally forces the window
      // back to maximized, because the system restores it as a floating
      // free-window from a previous PC-mode session.
      const settleDelays: Array<number> = [500, 1500];
      settleDelays.forEach((delayMs: number) => {
        this.settleViewportLater(delayMs, !newStatus);
      });
      LogUtil.info(TAG, 'pc mode handled: enabled=' + newStatus +
        ', changed=' + modeChanged);
    } catch (err) {
      LogUtil.error(TAG, 'update window_pcmode_switch_status fail, err:' + JSON.stringify(err));
    }
  }

  // Tells the patched Obsidian renderer (app.js touch-mode patch) which layout to
  // use. The renderer reads <userData>/ohsidian-mode.json and applies Obsidian's
  // mobile layout unless the user overrode it via the command-palette command.
  // userData is the application files dir, same value the engine passes as
  // --user-data-dir, so this.context.getApplicationContext().filesDir matches.
  private writeTouchModeFile(pcModeEnabled: boolean) {
    let systemMode: string = 'desktop';
    if (deviceInfo.deviceType === 'phone' ||
      (deviceInfo.deviceType === 'tablet' && !pcModeEnabled)) {
      systemMode = 'touch';
    }
    try {
      const filesDir: string = this.context.getApplicationContext().filesDir;
      const filePath: string = filesDir + '/ohsidian-mode.json';
      let cfg: Record<string, Object> = {};
      try {
        if (fileIo.accessSync(filePath)) {
          cfg = JSON.parse(fileIo.readTextSync(filePath)) as Record<string, Object>;
          if (!cfg) {
            cfg = {};
          }
        }
      } catch (e) {
        cfg = {};
      }
      cfg['systemMode'] = systemMode;
      if (cfg['override'] === undefined) {
        cfg['override'] = 'auto';
      }
      const file = fileIo.openSync(filePath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(cfg));
      } finally {
        fileIo.closeSync(file);
      }
      LogUtil.info(TAG, 'touch mode file updated: systemMode=' + systemMode +
        ', override=' + (cfg['override'] as string) +
        ', deviceType=' + deviceInfo.deviceType + ', pcMode=' + pcModeEnabled);
    } catch (err) {
      LogUtil.error(TAG, 'failed to write touch mode file: ' + JSON.stringify(err));
    }
  }
};
