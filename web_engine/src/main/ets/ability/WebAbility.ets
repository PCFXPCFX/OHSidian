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
import environment from '@ohos.file.environment';
import font from '@ohos.font';
import text from '@ohos.graphics.text';
import { NativeThemeAdapter } from '../adapter/NativeThemeAdapter';
import { AbilityManager } from '../common/AbilityManager';
import { Configuration } from '@ohos.app.ability.Configuration';
import Inject from '../common/InjectModule';
import { CaptionButtonRect, WindowBound } from '../interface/CommonInterface';
import CheckEmptyUtils from '../utils/CheckEmptyUtils';
import { WebBaseAbility } from './WebBaseAbility';
import lazy { GlobalThisHelper } from '../utils/GlobalThisHelper';
import { WindowStyle, IStyleData, IUpdateStyle } from '../common/WindowStyle';
import { CommandType, ConfigData } from '../common/Constants';
import { PermissionManagerAdapter } from '../adapter/PermissionManagerAdapter';
import { RunningLockAdapter } from '../adapter/RunningLockAdapter';
import lazy { DragDropAdapter } from '../adapter/DragDropAdapter';
import { ConfigurationConstant } from '@kit.AbilityKit';
// NOTE: the wantConstant re-exported by @kit.AbilityKit (@ohos.app.ability.
// wantConstant) only knows ACTION_SEND_TO_DATA; the share actions live in
// the legacy @ohos.ability.wantConstant namespace.
import wantConstant from '@ohos.ability.wantConstant';
import { systemShare } from '@kit.ShareKit';

const TAG: string = 'WebAbility';

export class WebAbility extends WebBaseAbility {
  private static WINDOW_CLOSE: number = 1000;
  // Share / 碰一碰 cold-start handoff: the share want arrives in onCreate,
  // long before any window or the editor exists. It is stashed here and
  // dispatched exactly once from onWindowStageCreate (COLD_SHARE_DELAY_MS).
  private static pendingShareWant: Want | undefined = undefined;
  private static pendingShareDispatched: boolean = false;
  private static COLD_SHARE_DELAY_MS: number = 15000;
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
  // IME height in CSS px, from keyboardHeightChange; published through the
  // mode file: Obsidian's mobile formatting toolbar positions itself with
  // top: calc(100vh - var(--keyboard-height) - toolbar-height) and nothing
  // in the engine sets that variable.
  private keyboardCss: number = 0;
  // System font-size scale (settings.fontSizeScale, followSystem). The
  // engine applies it to native fp text but the WEB content never sees it
  // (no engine binding queries it), so publish it through the mode file and
  // let the renderer scale --font-text-size. 1.0 = default.
  private fontScale: number = 1.0;
  // Sandbox font copies performed in this ability instance (launch); bounds
  // publishSystemFonts' copy fan-out (see sandboxFontCopy).
  private sandboxCopyCount: number = 0;
  // publishSystemFonts retry counter for the early-startup empty-list race.
  private systemFontRetries: number = 0;
  private mainWindow: window.Window | undefined = undefined;

  // Display-mode state machine (docs/window-state-machine.md is the spec;
  // keep this comment and that document in sync):
  //  - tablet, PC mode off (touch) -> the window IS the whole display and
  //    layout fullscreen is requested (API 24 tablets reject it with
  //    "device not support" - harmless, the forced display rect below is
  //    the real mechanism); the real bar insets are published through
  //    ohsidian-mode.json (see pushSafeAreaInsets) for the web content.
  //  - tablet, PC mode on / free windows / 2in1 -> plain window semantics.
  //    Layout fullscreen is explicitly RESET to false: leaving it enabled
  //    makes the web surface extend under the WMS caption strip and eat its
  //    drag hot zone - the "system title bar cannot move the window" bug.
  //    Insets are 0 (floating windows never overlap the bars).
  //  - phone                       -> same as touch.
  // There are NO timed settle/re-push compensations in this file: the engine
  // starts the browser only after the XComponent surface reports a stable
  // size (utils/SurfaceReady.ets), so every push below reacts to a real
  // window-geometry event.

  // Synthesizes the engine viewport from window properties. Two regimes:
  //  - Touch mode (full = true): the window IS the display; the real bar
  //    insets are published separately and the web content avoids them.
  //  - PC mode / free windows: the viewport is the window rect minus the
  //    REAL avoid areas (status bar / nav indicator) and the caption strip.
  //    Using drawableRect here is NOT enough: when a freeform window is
  //    maximized on a tablet the system reports drawableRect covering the
  //    nav-indicator strip (the window extends edge-to-edge while the
  //    indicator floats on top) - the stale viewport left the bottom strip
  //    of content hidden behind the navigation bar. Subtract the avoid
  //    areas explicitly so maximized and restored states both converge.
  private computeViewportBound(prop: window.WindowProperties): WindowBound {
    const winObj = this.mainWindow;
    const full = !this.pcModeEnabled;
    if (full || !winObj) {
      return {
        left: prop.windowRect.left,
        top: prop.windowRect.top,
        width: prop.windowRect.width,
        height: prop.windowRect.height,
      };
    }
    // PC mode / free window: start from the window rect, subtract the
    // caption (decor) area reported by drawableRect.top (0 when no caption)
    // and any system-bar avoid areas that overlap the window.
    let leftPx: number = prop.drawableRect.left;
    let topPx: number = prop.drawableRect.top;
    let widthPx: number = prop.drawableRect.width;
    let heightPx: number = prop.drawableRect.height;
    try {
      const displayClass = display.getDefaultDisplaySync();
      const rect = prop.windowRect;
      const fullscreenLike: boolean = rect.width >= displayClass.width &&
        rect.height >= displayClass.height;
      if (fullscreenLike) {
        // Maximized free window: drawableRect ignores the bars that float
        // on top of the edge-to-edge window - subtract them explicitly.
        const sysAvoid = winObj.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
        const navAvoid = winObj.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
        const bottomPx: number = Math.max(navAvoid.bottomRect.height, sysAvoid.bottomRect.height);
        heightPx = Math.max(0, heightPx - bottomPx);
        widthPx = Math.max(0, widthPx - Math.max(0,
          Math.max(sysAvoid.leftRect.width, sysAvoid.rightRect.width)));
      }
    } catch (exception) {
      LogUtil.warn(TAG, 'viewport avoid-area adjust failed: ' + JSON.stringify(exception));
    }
    return {
      left: prop.windowRect.left + leftPx,
      top: prop.windowRect.top + topPx,
      width: widthPx,
      height: heightPx,
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
      if (handheld && winObj) {
        // Touch-mode windows ALWAYS overlap the bars. PC-mode free windows
        // don't - EXCEPT when maximized: a maximized freeform window covers
        // the whole display edge-to-edge with the nav indicator floating on
        // top, so its avoid areas are real and must be published (the
        // renderer pads the content bottom; round 61 fix for the missing
        // bottom avoidance in maximized PC windows).
        let overlapsBars: boolean = !this.pcModeEnabled;
        if (!overlapsBars) {
          const displayClass = display.getDefaultDisplaySync();
          const rect = winObj.getWindowProperties().windowRect;
          overlapsBars = rect.width >= displayClass.width &&
            rect.height >= displayClass.height;
        }
        if (overlapsBars) {
          const sysAvoid = winObj.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
          const navAvoid = winObj.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
          topPx = sysAvoid.topRect.height;
          // Gesture indicator on tablets/phones; the system nav bar (three-key
          // mode) reports through TYPE_SYSTEM instead - take whichever applies.
          bottomPx = Math.max(navAvoid.bottomRect.height, sysAvoid.bottomRect.height);
        }
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
          // Re-enable WMS title-bar dragging: the startup path called
          // setWindowTitleMoveEnabled(!hideTitleBar) with hideTitleBar=true
          // (frameless BrowserWindow), which DISABLES the drag capability.
          // Showing the decor buttons alone does not restore it - dragging
          // stayed dead ("title bar cannot move the window"). The engine
          // has no -webkit-app-region implementation either (verified in
          // libelectron.so: no DraggableRegions interface), so the WMS
          // caption is the only drag surface and it must always be movable.
          winObj.setWindowTitleMoveEnabled(true);
        } catch (captionException) {
          LogUtil.warn(TAG, 'show system caption failed: ' + JSON.stringify(captionException));
        }
        decor = 'system';
      }
    } catch (exception) {
      decor = 'none';
    }
    this.writeInsetsToFile(topCss, bottomCss, decor, this.captionCss, this.keyboardCss,
      this.viewportAvoidsBars());
  }

  // True when the ENGINE viewport bound is already reduced by the avoid
  // areas (computeViewportBound subtracts them for fullscreen-like PC
  // windows). The renderer uses this to skip its CSS-side bar padding:
  // padding on top of the reduced surface would avoid the bars twice and
  // leave a blank strip between the bar and the content.
  private viewportAvoidsBars(): boolean {
    if (!this.pcModeEnabled) {
      return false;
    }
    const winObj = this.mainWindow;
    if (!winObj) {
      return false;
    }
    try {
      const displayClass = display.getDefaultDisplaySync();
      const rect = winObj.getWindowProperties().windowRect;
      return rect.width >= displayClass.width && rect.height >= displayClass.height;
    } catch (exception) {
      return false;
    }
  }

  // Read-modify-write for ohsidian-mode.json, preserving systemMode/override.
  private writeInsetsToFile(topCss: number, bottomCss: number, decor: string,
    captionCss: number, keyboardCss: number, viewportAvoidsBars: boolean): void {
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
        cfg['keyboard'] === keyboardCss &&
        cfg['viewportAvoidsBars'] === viewportAvoidsBars &&
        cfg['insets'] !== undefined &&
        (cfg['insets'] as Record<string, number>)['top'] === topCss &&
        (cfg['insets'] as Record<string, number>)['bottom'] === bottomCss;
      if (unchanged) {
        return;
      }
      cfg['insets'] = insets;
      cfg['windowDecor'] = decor;
      cfg['caption'] = captionCss;
      cfg['keyboard'] = keyboardCss;
      cfg['viewportAvoidsBars'] = viewportAvoidsBars;
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

  // Window mode: the system restores the window in whatever rect it last
  // had, and converting a fullscreen window into a free window can push the
  // bottom (or right) edge beyond the display - the reported "bottom of the
  // window is not visible". Clamp such rects back into the display and
  // shrink them to a comfortable size (80%, centered). Main window only;
  // PC mode only.
  private clampWindowToWorkArea(): void {
    if (this.xcomponentId !== ConfigData.DEFAULT_WINDOW_ID) {
      return;
    }
    const winObj = this.mainWindow;
    if (!winObj || !this.pcModeEnabled) {
      return;
    }
    try {
      const displayClass = display.getDefaultDisplaySync();
      const rect = winObj.getWindowProperties().windowRect;
      const fits: boolean = rect.left >= 0 && rect.top >= 0 &&
        rect.left + rect.width <= displayClass.width &&
        rect.top + rect.height <= displayClass.height;
      if (fits) {
        return;
      }
      const width: number = Math.min(rect.width, Math.round(displayClass.width * 0.8));
      const height: number = Math.min(rect.height, Math.round(displayClass.height * 0.8));
      const left: number = Math.max(0, Math.round((displayClass.width - width) / 2));
      const top: number = Math.max(0, Math.round((displayClass.height - height) / 2));
      winObj.resize(width, height)
        .then(() => {
          return winObj.moveWindowTo(left, top);
        })
        .then(() => {
          LogUtil.info(TAG, 'clamped window into display: ' + width + 'x' +
            height + ' @ (' + left + ',' + top + ')');
          this.pushSafeAreaInsets();
        })
        .catch((err: BusinessError) => {
          LogUtil.warn(TAG, 'clamp window failed: ' + JSON.stringify(err));
        });
    } catch (exception) {
      LogUtil.warn(TAG, 'clamp window threw: ' + JSON.stringify(exception));
    }
  }

  // Re-pushes the current window bounds to the engine. Called from real
  // geometry events (avoidAreaChange, windowStatusChange); there are no
  // timed re-pushes (docs/window-state-machine.md §3).
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

  // Forces the window back to fullscreen. Used ONLY for the touch-mode
  // form factor (tablet without PC mode, phone): the system restores the
  // app window in its previous state - including a floating free-window
  // from a PC-mode session - and the touch experience needs a fullscreen
  // window. maximize() does not reliably fill the screen for a restored
  // floating window (WMS may time out or leave a clamped rect, observed as
  // 2385x1711 against a 2800x1753 work area), so set the rect explicitly.
  //
  // Official immersive pattern (API 24): the rect is the WHOLE display at
  // (0,0) - no avoid-area subtraction. With the window covering the display
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
    // System font size change (settings → 显示和字体 → 字体大小). With
    // fontSizeScale=followSystem the framework recomputes native fp text;
    // this callback is the app-visible notification. The web content scale
    // is published through the mode file (see this.fontScale).
    if (config.fontSizeScale !== undefined && config.fontSizeScale > 0) {
      const next: number = Math.round(config.fontSizeScale * 100) / 100;
      if (next !== this.fontScale) {
        this.fontScale = next;
        this.writeFontScaleToFile(next);
      }
    }
  }

  // Publishes the system font scale into ohsidian-mode.json (cfg.fontScale).
  // Same read-modify-write channel as writeInsetsToFile but keyed separately
  // so the renderer can react to font changes without a geometry event.
  private writeFontScaleToFile(scale: number): void {
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
      const unchanged: boolean = cfg['fontScale'] === scale;
      if (unchanged) {
        return;
      }
      cfg['fontScale'] = scale;
      const file = fileIo.openSync(filePath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(cfg));
      } finally {
        fileIo.closeSync(file);
      }
      LogUtil.info(TAG, 'font scale updated: ' + scale);
    } catch (err) {
      LogUtil.error(TAG, 'failed to write font scale to mode file: ' + JSON.stringify(err));
    }
  }

  // Publishes the user-visible Documents directory (sandbox-mapped real
  // path from file.environment.getUserDocumentDir, granted by the already
  // declared READ_WRITE_DOCUMENTS_DIRECTORY permission) into the mode file
  // as cfg.documentsDir. The renderer's default-vault override puts new
  // vaults there so they are visible in 文件管理 and SURVIVE UNINSTALL -
  // the app sandbox (userData) is wiped when the app is removed. A vault
  // inside Documents and its .trash are user-manageable files.
  private publishDocumentsDir(): void {
    let documentsDir: string = '';
    try {
      documentsDir = environment.getUserDocumentDir();
    } catch (exception) {
      LogUtil.warn(TAG, 'getUserDocumentDir failed: ' + JSON.stringify(exception));
    }
    if (!documentsDir) {
      return;
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
      if (cfg['documentsDir'] === documentsDir) {
        return;
      }
      cfg['documentsDir'] = documentsDir;
      const file = fileIo.openSync(filePath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(cfg));
      } finally {
        fileIo.closeSync(file);
      }
      LogUtil.info(TAG, 'documents dir published: ' + documentsDir);
    } catch (err) {
      LogUtil.error(TAG, 'failed to write documentsDir to mode file: ' + JSON.stringify(err));
    }
  }

  // Publishes the installed system font family names (font.getSystemFontList)
  // into the mode file as cfg.systemFonts. The renderer's font picker
  // (OHSidian: 界面字体命令) offers these so the user can apply the font
  // they configured in 系统设置 → 显示与字体 → 字体样式 (or any installed
  // font) to Obsidian's interface/text. The list can be long; cap it and
  // only refresh when it actually changes.
  // Fonts outside /system/fonts (style fonts under /sys_prod, runtime theme
  // fonts) are invisible to the web engine's static font config AND their
  // raw directories are not guaranteed readable from the web renderer's
  // Node fs - the sandbox copy is the mechanism that DOES work end to end
  // (the theme font renders through exactly this path, round 76). /system
  // fonts resolve natively, so they pass through untouched. Skips the copy
  // when a same-size copy already exists (startup runs this every launch).
  private sandboxFontCopy(family: string, sourcePath: string): string {
    if (sourcePath.startsWith('/system/fonts')) {
      return sourcePath;
    }
    // Only copy the KNOWN Skia-invisible locations (style fonts, theme
    // store); anything else passes through raw - mass-copying unknown dirs
    // would be unbounded.
    const copyable: boolean = sourcePath.startsWith('/sys_prod') || sourcePath.startsWith('/data/');
    if (!copyable) {
      return sourcePath;
    }
    try {
      const filesDir: string = this.context.getApplicationContext().filesDir;
      const destDir: string = filesDir + '/fonts';
      if (!fileIo.accessSync(destDir)) {
        fileIo.mkdirSync(destDir);
      }
      const safe: string = family.replace(/[^0-9A-Za-z.\-\u4e00-\u9fa5]/g, '_');
      const dest: string = destDir + '/font-' + safe + '.ttf';
      try {
        if (fileIo.accessSync(dest) &&
          fileIo.statSync(sourcePath).size === fileIo.statSync(dest).size) {
          return dest;
        }
      } catch (e) {
        // stat failed - fall through to copy
      }
      if (this.sandboxCopyCount >= 24) {
        LogUtil.warn(TAG, 'sandbox font copy cap reached, passing raw path: ' + family);
        return sourcePath;
      }
      fileIo.copyFileSync(sourcePath, dest);
      this.sandboxCopyCount++;
      LogUtil.info(TAG, 'font copied to sandbox: ' + family + ': ' + sourcePath + ' -> ' + dest);
      return dest;
    } catch (e) {
      LogUtil.warn(TAG, 'sandbox font copy failed (' + family + '): ' + JSON.stringify(e));
      return sourcePath;
    }
  }

  // publishSystemFonts completed successfully in this ability instance.
  private systemFontsPublished: boolean = false;
  // publishSystemFonts run currently in flight (guards concurrent callers).
  private systemFontsPublishing: boolean = false;
  // probeThemeManifestFont outcome: the active theme slot exists and its
  // manifest parsed, but NO listed font passed the size gate - i.e. the
  // DEFAULT style, whose font is an empty stub (even Ace cannot load it).
  private manifestFontIsStub: boolean = false;

  private async publishSystemFonts(): Promise<void> {
    if (this.systemFontsPublished) {
      // One successful publish per process: the system font list cannot
      // change while we run, and re-running the static + descriptor passes
      // re-loads every typeface (the engine logs 'not variable font!' for
      // each static font) to arrive at an identical mode file. The
      // onFontIdUpdated re-publish only exists to catch the early-startup
      // race; once published it is pure noise.
      LogUtil.info(TAG, 'publishSystemFonts: already published this launch, skipping');
      return;
    }
    if (this.systemFontsPublishing) {
      LogUtil.info(TAG, 'publishSystemFonts: run already in progress, skipping');
      return;
    }
    this.systemFontsPublishing = true;
    try {
      await this.publishSystemFontsInner();
    } finally {
      this.systemFontsPublishing = false;
    }
  }

  private async publishSystemFontsInner(): Promise<void> {
    let families: Array<string> = [];
    try {
      const list = font.getSystemFontList();
      if (Array.isArray(list)) {
        families = list;
      }
    } catch (exception) {
      LogUtil.warn(TAG, 'getSystemFontList failed: ' + JSON.stringify(exception));
    }
    if (families.length === 0) {
      // Early-startup race: the font service may not be ready when the
      // window stage is created - getSystemFontList then returns [] and the
      // whole publish silently never happened (the round 75/76 picker data
      // stayed stale for exactly this reason: no log, no write). Fall back
      // to the text engine's ALL enumeration (proven on device: 154 names)
      // and schedule retries on top.
      try {
        const all = await this.withTimeout<Array<string>>(
          text.getSystemFontFullNamesByType(text.SystemFontType.ALL), 5000, []);
        if (Array.isArray(all)) {
          families = all;
          LogUtil.info(TAG, 'getSystemFontList empty, text engine fallback: ' +
            families.length + ' names');
        }
      } catch (e) {
        LogUtil.warn(TAG, 'text engine fallback failed: ' + JSON.stringify(e));
      }
    }
    if (families.length === 0) {
      LogUtil.warn(TAG, 'publishSystemFonts: no font names available (attempt ' +
        (this.systemFontRetries + 1) + ')');
      if (this.systemFontRetries < 5) {
        this.systemFontRetries++;
        setTimeout(() => {
          this.publishSystemFonts();
        }, 2000);
      } else {
        LogUtil.error(TAG, 'publishSystemFonts: giving up after retries');
      }
      return;
    }
    this.systemFontRetries = 0;
    LogUtil.info(TAG, 'publishSystemFonts: begin, families=' + families.length);
    // Family-name -> file-path map so the renderer can FontFace-load the
    // families the web engine's Skia manager cannot resolve (the names come
    // from the ArkTS/TexGine side; /sys_prod and custom fonts are invisible
    // to Skia's static config). font.getFontByName resolves the static
    // /system fonts only - the style fonts (e.g. 正方小标宋-简 under
    // /sys_prod) and runtime theme fonts are invisible to it too (same
    // reason round 69's getFontByName('OhosThemeFont') failed), so fill the
    // gaps with text-engine descriptor lookups.
    const fontFiles: Array<Record<string, string>> = [];
    const seen = new Set<string>();
    for (const family of families) {
      try {
        const info = font.getFontByName(family);
        if (info && info.path && info.path.length > 0) {
          fontFiles.push({ 'f': family, 'p': this.sandboxFontCopy(family, info.path) });
          seen.add(family);
        }
      } catch (e) {
        // family without a resolvable file - the descriptor pass retries it
      }
    }
    LogUtil.info(TAG, 'publishSystemFonts: static pass done, mappings=' + fontFiles.length);
    await this.appendDescriptorFontFiles(fontFiles, seen, text.SystemFontType.STYLISH);
    await this.appendDescriptorFontFiles(fontFiles, seen, text.SystemFontType.ALL);
    LogUtil.info(TAG, 'publishSystemFonts: descriptor passes done');
    // The picker must only offer names the renderer can actually bridge: a
    // name without a file mapping can never render (Obsidian probes every
    // entry with the same canvas-width technique as the bridge and warns
    // 系统中不存在此字体 when it fails). Keep list order for names that
    // resolved; descriptor-only names (style fonts) append after.
    const withPath = new Set<string>();
    for (const f of fontFiles) {
      withPath.add(f['f']);
    }
    const pickable: Array<string> = [];
    for (const fam of families) {
      if (withPath.has(fam)) {
        pickable.push(fam);
      }
    }
    for (const f of fontFiles) {
      if (pickable.indexOf(f['f']) < 0) {
        pickable.push(f['f']);
      }
    }
    families = pickable;
    LogUtil.info(TAG, 'font mappings: ' + fontFiles.length + ' entries, pickable names: ' +
      families.length);
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
      const prevFonts = cfg['systemFonts'] as string | undefined;
      const prevFiles = cfg['fontFiles'] as string | undefined;
      const nextFontsJson: string = JSON.stringify(families);
      const nextFilesJson: string = JSON.stringify(fontFiles);
      // Compare BOTH keys: the list is static while the path map improves
      // (first run of a build with a better resolver must still publish).
      if (prevFonts !== undefined && prevFonts === nextFontsJson &&
        prevFiles !== undefined && prevFiles === nextFilesJson) {
        this.systemFontsPublished = true;
        return;
      }
      cfg['systemFonts'] = nextFontsJson;
      cfg['fontFiles'] = nextFilesJson;
      const file = fileIo.openSync(filePath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(cfg));
      } finally {
        fileIo.closeSync(file);
      }
      this.systemFontsPublished = true;
      LogUtil.info(TAG, 'system fonts published: ' + families.length + ' families, ' +
        fontFiles.length + ' file mappings');
    } catch (err) {
      LogUtil.error(TAG, 'failed to write systemFonts to mode file: ' + JSON.stringify(err));
    }
  }

  // Bounds a native font-API promise so a hung call cannot stall the whole
  // publish chain (getSystemFontFullNamesByType(STYLISH) is unproven on
  // device - if it never settles, the mode file would never be written and
  // every later stage would silently not happen).
  private async withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race<T>([
      promise,
      new Promise<T>((resolve: (v: T) => void) => {
        setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  }

  // Resolves family-name -> file-path entries the static font.getFontByName
  // query cannot see, via the text engine's descriptor API (the same source
  // that DID return the /sys_prod style font paths in round 70). Maps both
  // fontFamily and fullName so either form used by the picker matches.
  private async appendDescriptorFontFiles(fontFiles: Array<Record<string, string>>,
    seen: Set<string>, fontType: text.SystemFontType): Promise<void> {
    let names: Array<string> = [];
    try {
      const resolved = await this.withTimeout<Array<string>>(
        text.getSystemFontFullNamesByType(fontType), 5000, []);
      if (Array.isArray(resolved)) {
        names = resolved;
      }
    } catch (e) {
      LogUtil.warn(TAG, 'descriptor names failed (' + fontType + '): ' + JSON.stringify(e));
      return;
    }
    if (names.length === 0) {
      LogUtil.warn(TAG, 'descriptor names empty or timed out (' + fontType + ')');
      return;
    }
    const lookups: Array<Promise<text.FontDescriptor | null>> = [];
    for (const nm of names) {
      lookups.push(text.getFontDescriptorByFullName(nm, fontType)
        .then((d: text.FontDescriptor): text.FontDescriptor | null => d)
        .catch((err: BusinessError): text.FontDescriptor | null => null));
    }
    let descs: Array<text.FontDescriptor | null> = [];
    try {
      descs = await this.withTimeout<Array<text.FontDescriptor | null>>(
        Promise.all(lookups), 8000, []);
    } catch (e) {
      LogUtil.warn(TAG, 'descriptor batch failed (' + fontType + '): ' + JSON.stringify(e));
      return;
    }
    let added: number = 0;
    for (const d of descs) {
      if (!d || !d.path || d.path.length === 0) {
        continue;
      }
      const lower: string = d.path.toLowerCase();
      if (!lower.endsWith('.ttf') && !lower.endsWith('.otf')) {
        continue;
      }
      const resolvedPath: string = this.sandboxFontCopy(d.fontFamily ?? '', d.path);
      const keys: Array<string> = [d.fontFamily ?? '', d.fullName ?? ''];
      for (const key of keys) {
        if (key && key.length > 0 && !seen.has(key)) {
          seen.add(key);
          fontFiles.push({ 'f': key, 'p': resolvedPath });
          added++;
        }
      }
      if (fontType === text.SystemFontType.STYLISH) {
        LogUtil.info(TAG, 'stylish mapping: "' + (d.fontFamily ?? '') + '" / "' + (d.fullName ?? '') +
          '" -> ' + resolvedPath);
      }
    }
    LogUtil.info(TAG, 'descriptor font files (' + fontType + '): +' + added +
      ' (total ' + fontFiles.length + ')');
  }

  // Mirrors ArkUI's AceContainer::CheckAndSetFontFamily (ace_engine
  // adapter/ohos/entrance/ace_container.cpp): the theme service publishes
  // the ACTIVE system theme under /data/themes/a/app or /data/themes/b/app
  // (A/B slots) - each holds a "flag" marker, a "fonts/" dir and
  // fonts/manifest.json listing "ttfFileSrc" plus "ttfFileSrcExt". ArkUI
  // reads them with plain POSIX IO from the app uid (the device run for the
  // font switch shows exactly this: "font path exist" then
  // "LoadThemeFont:<file>" in OUR process) and registers the ttf as family
  // "OhosThemeFont". The public enumeration APIs do NOT expose this file
  // (device logs: CUSTOMIZED=[], STYLISH=six built-ins, ALL=154 static
  // families), so read the same manifest ArkUI itself renders with.
  private probeThemeManifestFont(): string {
    this.manifestFontIsStub = false;
    let slot: string = '';
    try {
      if (fileIo.accessSync('/data/themes/a/app/flag') && fileIo.accessSync('/data/themes/a/app/fonts')) {
        slot = '/data/themes/a/app';
      }
    } catch (e) {
      slot = '';
    }
    if (!slot) {
      try {
        if (fileIo.accessSync('/data/themes/b/app/flag') && fileIo.accessSync('/data/themes/b/app/fonts')) {
          slot = '/data/themes/b/app';
        }
      } catch (e) {
        slot = '';
      }
    }
    if (!slot) {
      LogUtil.info(TAG, 'no active theme slot in /data/themes (a/b both absent)');
      return '';
    }
    const fontsDir: string = slot + '/fonts';
    try {
      const manifestPath: string = fontsDir + '/manifest.json';
      if (!fileIo.accessSync(manifestPath)) {
        LogUtil.warn(TAG, 'active theme slot has no manifest: ' + manifestPath);
        return '';
      }
      const manifest = JSON.parse(fileIo.readTextSync(manifestPath)) as Record<string, Object>;
      const entries: Array<string> = [];
      const mainSrc = manifest['ttfFileSrc'];
      if (typeof mainSrc === 'string' && (mainSrc as string).length > 0) {
        entries.push(mainSrc as string);
      }
      const extSrcs = manifest['ttfFileSrcExt'];
      if (Array.isArray(extSrcs)) {
        for (const item of extSrcs as Array<Object>) {
          if (typeof item === 'string' && (item as string).length > 0) {
            entries.push(item as string);
          }
        }
      }
      LogUtil.info(TAG, 'theme manifest fonts (' + slot + '): ' + JSON.stringify(entries));
      for (const entry of entries) {
        // ArkUI joins the manifest entry's BASENAME with the fonts dir.
        const sep: number = Math.max(entry.lastIndexOf('/'), entry.lastIndexOf('\\'));
        const name: string = sep >= 0 ? entry.substring(sep + 1) : entry;
        const lower: string = name.toLowerCase();
        if (!lower.endsWith('.ttf') && !lower.endsWith('.otf')) {
          continue;
        }
        const candidate: string = fontsDir + '/' + name;
        try {
          if (fileIo.accessSync(candidate) && fileIo.statSync(candidate).size >= 8192) {
            return candidate;
          }
        } catch (e) {
          // not resolvable under the slot (or a stub) - fall through
        }
        // Device logs show manifest entries may be ABSOLUTE paths into the
        // download store (/data/themes/s/online/download/font/<fontId>/...);
        // try the entry as-is when the basename join did not resolve.
        if (entry !== candidate) {
          try {
            if (fileIo.accessSync(entry) && fileIo.statSync(entry).size >= 8192) {
              return entry;
            }
          } catch (e) {
            // try the next entry
          }
        }
      }
      // Every listed font failed the size gate: the active style is the
      // DEFAULT one, whose font is an empty stub (device-verified: even
      // Ace's own LoadThemeFont fails on it with ashmem EINVAL).
      this.manifestFontIsStub = true;
      LogUtil.info(TAG, 'theme manifest fonts all fail the size gate (default-style stub)');
    } catch (e) {
      LogUtil.warn(TAG, 'theme manifest read failed (' + slot + '): ' + JSON.stringify(e));
    }
    return '';
  }

  // The style font selected in 系统设置 is registered by ArkUI's TexGine
  // under the family name "OhosThemeFont" and is invisible to the web
  // engine's Skia font manager. The renderer loads the file we publish
  // here as a FontFace with that exact family name, so the CSS stack
  // ("OhosThemeFont" first) resolves. The renderer reads app-sandbox files
  // (it already reads ohsidian-mode.json from filesDir), while readability
  // of /data/themes from the web process is not guaranteed - so publish a
  // COPY of the font, falling back to the source path if the copy fails.
  // The copy name is DERIVED FROM THE FONT: the renderer only reloads when
  // the published PATH STRING changes, so a second font copied over one
  // fixed name would keep rendering as the previous font (the round-73
  // device log showed writeThemeFontPath early-returning on the constant
  // theme-font.ttf name). Stale copies of other fonts are cleaned up.
  private publishThemeFont(sourcePath: string): void {
    try {
      const st = fileIo.statSync(sourcePath);
      if (!st || st.size < 8192) {
        // The DEFAULT style "font" (font_01/default.ttf) is a STUB: the
        // device log shows even Ace fails to load it (ashmem mmap EINVAL on
        // empty data). Publishing it would leave the renderer retrying a
        // dead file forever - treat as "no theme font" so the mode file
        // resets and the UI falls back to HarmonyOS Sans (what the system
        // itself shows for the default style).
        LogUtil.warn(TAG, 'theme font is a stub (' + (st ? st.size : -1) +
          ' bytes), resetting: ' + sourcePath);
        this.writeThemeFontPath('');
        return;
      }
    } catch (e) {
      LogUtil.warn(TAG, 'theme font stat failed, publishing anyway: ' + JSON.stringify(e));
    }
    let published: string = sourcePath;
    try {
      const filesDir: string = this.context.getApplicationContext().filesDir;
      const destDir: string = filesDir + '/fonts';
      if (!fileIo.accessSync(destDir)) {
        fileIo.mkdirSync(destDir);
      }
      const sep: number = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
      const base: string = sep >= 0 ? sourcePath.substring(sep + 1) : sourcePath;
      const dot: number = base.lastIndexOf('.');
      const stem: string = dot > 0 ? base.substring(0, dot) : base;
      const dest: string = destDir + '/theme-font-' + stem + (dot > 0 ? base.substring(dot) : '.ttf');
      fileIo.copyFileSync(sourcePath, dest);
      published = dest;
      LogUtil.info(TAG, 'theme font copied: ' + sourcePath + ' -> ' + dest);
      try {
        const names: Array<string> = fileIo.listFileSync(destDir);
        for (const nm of names) {
          if (nm.startsWith('theme-font') && destDir + '/' + nm !== dest) {
            try {
              fileIo.unlinkSync(destDir + '/' + nm);
            } catch (e) {
              // stale copy busy or gone - harmless, skip it
            }
          }
        }
      } catch (e) {
        // listing unavailable - keep the stale copies
      }
    } catch (err) {
      LogUtil.warn(TAG, 'theme font copy failed, publishing source path: ' + JSON.stringify(err));
    }
    this.writeThemeFontPath(published);
  }

  private publishThemeFontPath(): void {
    // Priority: 1) /data/themes manifest (what ArkUI itself reads);
    // 2) CUSTOMIZED paths; 3) ALL descriptors minus the static system dirs.
    const manifestFont: string = this.probeThemeManifestFont();
    if (manifestFont) {
      this.publishThemeFont(manifestFont);
      return;
    }
    if (this.manifestFontIsStub) {
      // DEFAULT style: no theme font exists at all. The enumeration APIs
      // provably return nothing for theme fonts on this device (CUSTOMIZED
      // is [], ALL is static-only), so reset straight to HarmonyOS Sans
      // instead of burning a 154-descriptor sweep (and its 'not variable
      // font!' log spam) on every launch. The manifest is what ArkUI
      // itself renders with, so trusting it here is MORE correct than
      // letting a stale user-installed font win.
      LogUtil.info(TAG, 'theme style is default (stub font), resetting theme font path');
      this.writeThemeFontPath('');
      return;
    }
    LogUtil.info(TAG, 'no font from /data/themes manifest, trying font APIs');
    let fontPath: string = '';
    try {
      const custom = text.getFontPathsByType(text.SystemFontType.CUSTOMIZED);
      LogUtil.info(TAG, 'CUSTOMIZED font paths: ' + JSON.stringify(custom));
      if (Array.isArray(custom)) {
        for (const p of custom) {
          if (p && (p.endsWith('.ttf') || p.endsWith('.otf'))) {
            fontPath = p;
            break;
          }
        }
      }
    } catch (exception) {
      LogUtil.warn(TAG, 'getFontPathsByType(CUSTOMIZED) failed: ' + JSON.stringify(exception));
    }
    if (fontPath) {
      this.publishThemeFont(fontPath);
      return;
    }
    try {
      text.getSystemFontFullNamesByType(text.SystemFontType.ALL)
        .then((names: Array<string>) => {
          LogUtil.info(TAG, 'ALL font names: ' + names.length);
          const isStatic = (pth: string): boolean =>
            pth.startsWith('/system/fonts') || pth.startsWith('/sys_prod');
          const pick = (idx: number): void => {
            if (fontPath) {
              this.publishThemeFont(fontPath);
              return;
            }
            if (idx >= names.length) {
              LogUtil.warn(TAG, 'no non-static font path found via ALL descriptors');
              // A fontId update fired but no font was found anywhere: reset
              // the published path so the renderer drops a stale FontFace
              // and falls back to HarmonyOS Sans (style restored to default).
              this.writeThemeFontPath('');
              return;
            }
            text.getFontDescriptorByFullName(names[idx], text.SystemFontType.ALL)
              .then((desc: text.FontDescriptor) => {
                if (desc && desc.path && desc.path.length > 0 && !isStatic(desc.path) &&
                  (desc.path.endsWith('.ttf') || desc.path.endsWith('.otf'))) {
                  fontPath = desc.path;
                  LogUtil.info(TAG, 'candidate font path: ' + desc.path + ' (' + names[idx] + ')');
                }
              })
              .catch(() => {})
              .then(() => pick(idx + 1));
          };
          pick(0);
        })
        .catch((err: BusinessError) => {
          LogUtil.warn(TAG, 'ALL name enumeration failed: ' + JSON.stringify(err));
        });
    } catch (exception) {
      LogUtil.warn(TAG, 'ALL descriptor fallback threw: ' + JSON.stringify(exception));
    }
  }

  private writeThemeFontPath(fontPath: string): void {
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
      if (cfg['themeFontPath'] === fontPath) {
        return;
      }
      cfg['themeFontPath'] = fontPath;
      const file = fileIo.openSync(filePath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(cfg));
      } finally {
        fileIo.closeSync(file);
      }
      LogUtil.info(TAG, 'theme font path published: ' + fontPath);
    } catch (err) {
      LogUtil.error(TAG, 'failed to write themeFontPath: ' + JSON.stringify(err));
    }
  }

  // Publishes the SYSTEM STYLE font (设置 → 显示与字体 → 字体样式) so the
  // web content can follow it — the piece round 60 was missing. Two parts:
  //  1. cfg.fontId: the opaque id of the currently selected style font
  //     (Configuration.fontId). Changes push through
  //     onSystemConfigurationUpdated/onFontIdUpdated (API 24) and are
  //     republished here.
  //  2. cfg.styleFonts: [{id, family}] mapping built from the
  //     SystemFontType.STYLISH list via getFontDescriptorByFullName —
  //     the renderer resolves fontId to a CSS family name with it.
  // The renderer applies the resolved family to --font-default (user picks
  // in Obsidian settings still win; HarmonyOS Sans remains the fallback).
  private publishFontId(fontId: string): void {
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
      if (cfg['fontId'] === fontId) {
        return;
      }
      cfg['fontId'] = fontId;
      const file = fileIo.openSync(filePath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(cfg));
      } finally {
        fileIo.closeSync(file);
      }
      LogUtil.info(TAG, 'font id published: ' + fontId);
    } catch (err) {
      LogUtil.error(TAG, 'failed to write fontId to mode file: ' + JSON.stringify(err));
    }
  }

  private publishStyleFonts(): void {
    text.getSystemFontFullNamesByType(text.SystemFontType.STYLISH)
      .then((names: Array<string>) => {
        const resolveOne = (name: string): Promise<Record<string, string> | null> => {
          return new Promise((resolve) => {
            try {
              text.getFontDescriptorByFullName(name, text.SystemFontType.STYLISH)
                .then((desc: text.FontDescriptor) => {
                  resolve({
                    'id': name,
                    'family': desc.fontFamily || desc.fullName || name,
                  });
                })
                .catch(() => resolve({ 'id': name, 'family': name }));
            } catch (e) {
              resolve({ 'id': name, 'family': name });
            }
          });
        };
        Promise.all(names.slice(0, 40).map(resolveOne))
          .then((mapping: Array<Record<string, string> | null>) => {
            // resolveOne never resolves null today, but the declared type
            // allows it - collect the non-null entries explicitly (ArkTS
            // has no type-guard narrowing on filter predicates).
            const entries: Array<Record<string, string>> = [];
            mapping.forEach((m: Record<string, string> | null) => {
              if (m !== null) {
                entries.push(m);
              }
            });
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
              const nextJson: string = JSON.stringify(entries);
              if (cfg['styleFonts'] === nextJson) {
                return;
              }
              cfg['styleFonts'] = nextJson;
              const file = fileIo.openSync(filePath,
                fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
              try {
                fileIo.writeSync(file.fd, JSON.stringify(cfg));
              } finally {
                fileIo.closeSync(file);
              }
              LogUtil.info(TAG, 'style fonts published: ' + entries.length + ' entries');
            } catch (err) {
              LogUtil.error(TAG, 'failed to write styleFonts: ' + JSON.stringify(err));
            }
          })
          .catch((err: BusinessError) => {
            LogUtil.warn(TAG, 'style font resolve failed: ' + JSON.stringify(err));
          });
      })
      .catch((err: BusinessError) => {
        LogUtil.warn(TAG, 'getSystemFontFullNamesByType(STYLISH) failed: ' + JSON.stringify(err));
      });
  }

  // Registers the API-24 system-configuration listener (font style/size/
  // weight pushes) and republishes the font pieces of the mode file.
  private registerSystemConfigListener(): void {
    try {
      const appContext = this.context.getApplicationContext();
      appContext.onSystemConfigurationUpdated({
        onFontIdUpdated: (fontId: string) => {
          LogUtil.info(TAG, 'onFontIdUpdated: ' + fontId);
          // The font system is provably ready here - a safe moment to
          // (re)publish the picker data if the early-startup attempt raced.
          this.publishSystemFonts();
          this.publishFontId(fontId);
          this.publishStyleFonts();
          this.publishThemeFontPath();
        },
        onFontSizeScaleUpdated: (fontSizeScale: number) => {
          if (fontSizeScale > 0) {
            const next: number = Math.round(fontSizeScale * 100) / 100;
            if (next !== this.fontScale) {
              this.fontScale = next;
              this.writeFontScaleToFile(next);
            }
          }
        },
      });
      LogUtil.info(TAG, 'system configuration listener registered');
    } catch (exception) {
      LogUtil.warn(TAG, 'onSystemConfigurationUpdated registration failed: ' + JSON.stringify(exception));
    }
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam) {
    super.onCreate(want, launchParam);

    // Cold-start share: remember it, dispatch after the window stage is up
    // (see the pendingShareWant block in onWindowStageCreate).
    if (WebAbility.isShareKitWant(want)) {
      WebAbility.pendingShareWant = want;
    }

    this.abilityManager = Inject.get(AbilityManager);
    this.nativeThemeAdapter = Inject.get(NativeThemeAdapter);

    Inject.get(PermissionManagerAdapter).initPermissions();

    // Huawei cloud sync was REMOVED in this fork (attack surface, dead
    // upstream feature - see docs/CHANGES-2026-09.md round 65). The
    // CloudSyncAdapter/Bind files stay as inert code for reference; they
    // are no longer constructed, injected, or notified from here.
  }

  // Foreground/background hooks shared by every window ability (Entry,
  // Browser, Stateless all extend WebAbility). They gate the battery-sensitive
  // pieces on actual app visibility:
  //  - RunningLock guard: a leaked engine keep-screen-on request must not
  //    hold the screen awake after the last window is backgrounded.
  onForeground(): void {
    try {
      Inject.getOrCreate(RunningLockAdapter).notifyAppForeground();
    } catch (e) {
      LogUtil.warn(TAG, 'onForeground runningLock notify failed: ' + e);
    }
  }

  onBackground(): void {
    try {
      Inject.getOrCreate(RunningLockAdapter).notifyAppBackground();
    } catch (e) {
      LogUtil.warn(TAG, 'onBackground runningLock notify failed: ' + e);
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage) {
    super.onWindowStageCreate(windowStage);

    // Repeat-launch protection lives in the specified launch mode: a second
    // launch routes to the existing instance's onNewWant (keyed by
    // onAcceptWant). The old checkSingleInstance compared an xcomponentId
    // that onCreate always allocates first, so it could never fire - removed.

    this.abilityManager?.addProxy(this);
    // A window registering means the engine is serving windows again - clear
    // a stale terminating flag (set by the previous last-window shutdown) so
    // future onAcceptWant calls resume the last-active lookup.
    GlobalThisHelper.markAlive();

    if (WebAbility.pendingShareWant && !WebAbility.pendingShareDispatched) {
      WebAbility.pendingShareDispatched = true;
      const pending: Want = WebAbility.pendingShareWant;
      WebAbility.pendingShareWant = undefined;
      // Best effort: the engine and Obsidian's editor still need a few
      // seconds after the window stage exists, so dispatch exactly once,
      // late. If the editor is not mounted yet the drop is lost (logged) -
      // warm shares via onNewWant have no such gap.
      setTimeout(() => {
        LogUtil.info(TAG, 'dispatching cold-start share want');
        this.ingestSharedWant(pending, []);
      }, WebAbility.COLD_SHARE_DELAY_MS);
    }

    this.mainWindow = windowStage.getMainWindowSync();
    // Publish the current system font scale once at startup (onConfigur-
    // ationUpdate only fires on CHANGES); the renderer picks cfg.fontScale
    // up from the mode file on boot. Two independent sources, first wins:
    //  1. the ability Configuration.fontSizeScale - the framework injects
    //     the effective factor here when configuration.json declares
    //     fontSizeScale=followSystem (authoritative);
    //  2. settingsdata FONT_SCALE key (may be absent on some builds).
    try {
      let scale: number = 0;
      try {
        const cfgScale = this.context.config.fontSizeScale;
        if (typeof cfgScale === 'number' && cfgScale > 0) {
          scale = cfgScale;
        }
      } catch (e) {
        // config not ready yet - fall through to settingsdata
      }
      if (!(scale > 0)) {
        const raw: string = settings.getValueSync(this.context,
          settings.display.FONT_SCALE, '1.0');
        const parsed: number = parseFloat(raw);
        if (!isNaN(parsed) && parsed > 0) {
          scale = parsed;
        }
      }
      if (scale > 0) {
        this.fontScale = Math.round(scale * 100) / 100;
        this.writeFontScaleToFile(this.fontScale);
        LogUtil.info(TAG, 'startup font scale: ' + this.fontScale);
      }
    } catch (exception) {
      LogUtil.warn(TAG, 'read system font scale failed: ' + JSON.stringify(exception));
    }
    // Publish the user-visible Documents dir (uninstall-safe vault root);
    // the renderer's default-vault override consumes cfg.documentsDir.
    // READ_WRITE_DOCUMENTS_DIRECTORY is a user_grant permission: request it
    // once here (main window only) and republish the dir when granted. The
    // request is a no-op dialog after the first approval.
    this.publishDocumentsDir();
    this.publishSystemFonts();
    // System style font: publish the initial fontId (Configuration.fontId)
    // and the STYLISH family mapping, then keep both fresh via the API-24
    // system-configuration listener (onFontIdUpdated etc.).
    try {
      const initialFontId = this.context.config.fontId;
      if (typeof initialFontId === 'string' && initialFontId.length > 0) {
        this.publishFontId(initialFontId);
      }
    } catch (exception) {
      LogUtil.warn(TAG, 'read initial fontId failed: ' + JSON.stringify(exception));
    }
    this.publishStyleFonts();
    this.publishThemeFontPath();
    this.registerSystemConfigListener();
    if (this.xcomponentId === ConfigData.DEFAULT_WINDOW_ID) {
      // Startup-time user_grant permissions (main window only). 0 ==
      // REQUEST_PERMISSION_SUCCESS (module-private constant there).
      //  - directory_document: uninstall-safe vault root (Documents);
      //  - directory_download: downloads writes (engine save-as flows).
      // Everything else (pasteboard/bluetooth/camera/mic/location/screen
      // capture) stays on-demand: the engine requests it when the matching
      // web feature runs, so users are not greeted with a wall of dialogs.
      const dirRequests: Array<string> = ['directory_document', 'directory_download'];
      let dirPending: number = dirRequests.length;
      const republish = (): void => {
        dirPending--;
        if (dirPending === 0) {
          this.publishDocumentsDir();
        }
      };
      dirRequests.forEach((permType: string) => {
        Inject.get(PermissionManagerAdapter).requestPermissions(permType,
          (granted: number) => {
            if (granted === 0) {
              LogUtil.info(TAG, 'startup permission granted: ' + permType);
            } else {
              LogUtil.warn(TAG, 'startup permission NOT granted: ' + permType +
                ' code=' + granted);
            }
            republish();
          });
      });
    }
    // Diagnostic: dump the device shape - the mode branches below gate on it.
    LogUtil.error(TAG, 'diagnostic: deviceType=' + deviceInfo.deviceType +
      ', sdkApiVersion=' + deviceInfo.sdkApiVersion);
    // Layout fullscreen BEFORE loadContent (official immersive step 1), for
    // the TOUCH form factor only. API 24 tablets reject the call ("device
    // not support" - logged, harmless; the forced display rect in
    // forceFullscreenWindow is the real mechanism). It must NOT stay on for
    // free windows / PC mode: the web surface would extend under the WMS
    // caption strip and swallow its drag hot zone ("title bar cannot move
    // the window" - docs/window-state-machine.md §5). updateWindowPcmode-
    // SwitchStatus resets it to false when PC mode is on.
    if (deviceInfo.deviceType === 'tablet' || deviceInfo.deviceType === 'phone') {
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
    }

    windowStage.getMainWindow((err, data) => {
      if (err.code) {
        LogUtil.error(TAG, 'Failed to obtain the main window: ' + JSON.stringify(err));
        return;
      }
      
      try {
        data.on('windowStatusChange', (status) => {
          this.nativeContext.OnWindowStatusChange(this.xcomponentId, status);
          // MAXIMIZE/RECOVER transitions change the window rect but on free
          // windows the maximize animation can complete WITHOUT firing a
          // trailing windowSizeChange (observed on API 24 tablets: after
          // maximizing a PC-mode window the bottom strip stayed stale -
          // engine viewport kept the pre-maximize height). Re-push the
          // viewport and the insets so the content follows the new rect.
          if (status === window.WindowStatusType.MAXIMIZE ||
            status === window.WindowStatusType.FULL_SCREEN ||
            status === window.WindowStatusType.FLOATING) {
            this.pushSafeAreaInsets();
            this.repushViewportBounds();
          }
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
          // MAXIMIZE/RECOVER land here too (RectChangeReason.MAXIMIZE=1);
          // the caption/avoid-area state follows the new rect, so refresh
          // the mode file alongside the viewport push.
          this.pushSafeAreaInsets();
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

      try {
        // IME height -> web content. Obsidian's mobile formatting toolbar
        // positions itself with top: calc(100vh - var(--keyboard-height) -
        // toolbar-height); the engine never sets that variable, so publish
        // it through the mode-file channel (physical px -> css px).
        data.on('keyboardHeightChange', (kbHeight: number) => {
          const density: number = display.getDefaultDisplaySync().densityPixels || 1;
          const keyboard: number = Math.round(kbHeight / density);
          if (keyboard !== this.keyboardCss) {
            this.keyboardCss = keyboard;
            this.pushSafeAreaInsets();
          }
        });
      } catch (exception) {
        LogUtil.error(TAG, 'Failed to register keyboard height listener: ' + JSON.stringify(exception));
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
        // Touch form factor: the system may restore a smaller (PC-mode
        // session) rect - force the FULL display rect once, synchronously.
        // The engine starts the browser only after the surface is stable
        // (SurfaceReady), so this lands before the viewport latches. No
        // timed settle loops (docs/window-state-machine.md §3).
        if (!this.pcModeEnabled) {
          this.forceFullscreenWindow();
        }
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
        // Title-drag lives on the SYSTEM caption (the engine has no
        // -webkit-app-region support), and pushSafeAreaInsets re-shows the
        // caption for free windows - so the move capability must follow the
        // caption, not hideTitleBar. Enabling it unconditionally is safe:
        // fullscreen windows have no caption strip to drag.
        mainWin.setWindowTitleMoveEnabled(true);
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
        // mode, and the first read applies layout-fullscreen + window-rect
        // corrections for the current form factor.
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
    // Unregister the PC-mode settings observer regardless of how far setup
    // got: it was registered on this ability's context in onWindowStage-
    // Create and keeps a `this` closure alive. Without unregistering, every
    // system setting change after destruction still ran
    // updateWindowPcmodeSwitchStatus against a dead window (log flooding,
    // memory leak, occasional NPE).
    try {
      settings.unregisterKeyObserver(this.context, 'window_pcmode_switch_status',
        settings.domainName.USER_PROPERTY);
    } catch (exception) {
      LogUtil.warn(TAG, 'unregister pcmode observer failed: ' + JSON.stringify(exception));
    }
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
      if (uri.startsWith('file://')) {
        // A file:// want.uri is a shared file (华为分享 / 碰一碰 / "其他应用
        // 打开"), not a web location - opening a new window on it never
        // produced anything useful. Push it into the focused editor instead.
        this.ingestSharedWant(want, [uri]);
        return;
      }
      this.openNewWindow(uri);
      return;
    }
    this.ingestSharedWant(want, []);
  }

  // ===== Share / 碰一碰 ingestion =====
  // Routes one want's shared content (files and/or text) into the focused
  // editor through DragDropAdapter.ingestExternalContent - the same
  // sanitized pipeline system drags use. See docs/DRAG-DROP-INBOUND.md.
  // Priority: bare file:// want.uri (directUris) > Share Kit parse
  // (getSharedData, the official receiver API - no key names involved) >
  // parameter heuristics (known keys + generic file:// scan).
  private ingestSharedWant(want: Want, directUris: Array<string>): void {
    if (directUris.length > 0) {
      let text = WebAbility.wantSharedText(want);
      Inject.getOrCreate(DragDropAdapter).ingestExternalContent('', directUris, text, '');
      return;
    }
    if (WebAbility.isShareKitWant(want)) {
      try {
        systemShare.getSharedData(want).then((data: systemShare.SharedData) => {
          let uris: Array<string> = [];
          let text: string = '';
          let records = data.getRecords();
          for (let i = 0; i < records.length; i++) {
            let record = records[i];
            if (record.uri && record.uri.length > 0) {
              uris.push(record.uri);
            } else if (!text && record.content && record.content.length > 0) {
              text = record.content;
            }
          }
          LogUtil.info(TAG, 'getSharedData parsed, uris:' + uris.length + ' text length:' + text.length);
          if (uris.length > 0 || text.length > 0) {
            Inject.getOrCreate(DragDropAdapter).ingestExternalContent('', uris, text, '');
          } else {
            this.ingestSharedWantHeuristics(want);
          }
        }).catch((err: BusinessError) => {
          // Not a Share Kit payload (or parse failed): older senders put the
          // data straight into want.parameters.
          LogUtil.info(TAG, 'getSharedData failed, fall back to heuristics: ' + JSON.stringify(err));
          this.ingestSharedWantHeuristics(want);
        });
        return;
      } catch (err) {
        LogUtil.info(TAG, 'getSharedData threw, fall back to heuristics: ' + JSON.stringify(err));
      }
    }
    this.ingestSharedWantHeuristics(want);
  }

  private ingestSharedWantHeuristics(want: Want): void {
    let uris = WebAbility.wantSharedFileUris(want);
    let text = WebAbility.wantSharedText(want);
    if (uris.length > 0 || text.length > 0) {
      Inject.getOrCreate(DragDropAdapter).ingestExternalContent('', uris, text, '');
    }
  }

  private static isShareKitWant(want: Want): boolean {
    if (!want) {
      return false;
    }
    let action = want.action;
    return action === wantConstant.Action.ACTION_SEND_DATA
      || action === wantConstant.Action.ACTION_SEND_MULTIPLE_DATA;
  }

  private static wantSharedFileUris(want: Want): Array<string> {
    let uris: Array<string> = [];
    if (!want || !want.parameters) {
      return uris;
    }
    const keys: Array<string> = ['uris', 'uriList', 'ability.want.params.uris', 'ability.want.params.uriList', 'fileUris'];
    for (let i = 0; i < keys.length; i++) {
      let value: Object | undefined = want.parameters[keys[i]];
      if (Array.isArray(value)) {
        let list = value as Array<Object>;
        for (let j = 0; j < list.length; j++) {
          if (typeof list[j] === 'string' && (list[j] as string).length > 0) {
            uris.push(list[j] as string);
          }
        }
        if (uris.length > 0) {
          return uris;
        }
      } else if (typeof value === 'string' && (value as string).length > 0) {
        uris.push(value as string);
        return uris;
      }
    }
    // Last resort: scan every parameter for path-shaped values, so an
    // unknown sender (碰一碰 variants, future share sources) still works
    // without hard-coding its key name. The path filter keeps unrelated
    // parameters (instance keys, urls, ...) out.
    const scanKeys: Array<string> = Object.keys(want.parameters);
    for (let k = 0; k < scanKeys.length; k++) {
      let scan: Object | undefined = want.parameters[scanKeys[k]];
      if (typeof scan === 'string' && WebAbility.isPathLikeUri(scan as string)) {
        uris.push(scan as string);
        return uris;
      }
      if (Array.isArray(scan)) {
        let list = scan as Array<Object>;
        for (let j = 0; j < list.length; j++) {
          if (typeof list[j] === 'string' && WebAbility.isPathLikeUri(list[j] as string)) {
            uris.push(list[j] as string);
          }
        }
        if (uris.length > 0) {
          return uris;
        }
      }
    }
    return uris;
  }

  private static isPathLikeUri(value: string): boolean {
    return !!value && (value.startsWith('file://')
      || value.startsWith('/storage/')
      || value.startsWith('/data/'));
  }

  private static wantSharedText(want: Want): string {
    if (!want || !want.parameters) {
      return '';
    }
    const keys: Array<string> = ['text', 'content', 'ability.want.params.text'];
    for (let i = 0; i < keys.length; i++) {
      let value: Object | undefined = want.parameters[keys[i]];
      if (typeof value === 'string') {
        return value as string;
      }
    }
    return '';
  }

  onPrepareToTerminate(): boolean {
    // This window's ability is about to terminate. When it is the LAST
    // window, the engine browser exits right after - mark it so a relaunch
    // racing this teardown takes onAcceptWant's fast path instead of
    // blocking the main thread 3s on a dead engine (observed as an XCollie
    // "MainThread:AcceptWant 3007ms" block followed by an engine-side
    // DisplayManagerAgent CHECK crash while ~Display ran).
    if ((this.abilityManager?.getProxyCount() ?? 0) <= 1) {
      GlobalThisHelper.markTerminating();
    }
    this.nativeContext.OnWindowEvent(this.xcomponentId, WebAbility.WINDOW_CLOSE);
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
      // Layout fullscreen belongs to the TOUCH form factor only. Leaving it
      // on in PC mode lets the web surface extend under the WMS caption and
      // blocks its drag hot zone (docs/window-state-machine.md §5); leaving
      // it off in touch mode lets the system inset the window. Reset it on
      // every mode change so the flag always matches the form factor.
      this.applyLayoutFullscreenForMode();
      // Floating PC-mode windows never overlap the bars -> publish zero
      // insets; back in tablet mode the real avoid areas apply again.
      this.pushSafeAreaInsets();
      if (newStatus) {
        // Entering window mode: the system may restore a rect taller/wider
        // than the display (e.g. the full-display rect of the previous
        // touch-mode session), which hides the window bottom behind the
        // navigation area. Clamp it into the display.
        this.clampWindowToWorkArea();
      } else if (this.mainWindow) {
        // Back to touch mode: force the FULL display rect once (maximize is
        // unreliable for restored floating windows on API 24 - round 11).
        this.forceFullscreenWindow();
      }
      LogUtil.info(TAG, 'pc mode handled: enabled=' + newStatus +
        ', changed=' + modeChanged);
    } catch (err) {
      LogUtil.error(TAG, 'update window_pcmode_switch_status fail, err:' + JSON.stringify(err));
    }
  }

  // Layout fullscreen is a TOUCH-form-factor property: on for phone/tablet
  // touch (where the content avoids the visible bars via published insets),
  // off for free windows / PC mode (where the WMS caption must keep its
  // drag hot zone). Called on mode switches; startup handles the initial
  // value in onWindowStageCreate.
  private applyLayoutFullscreenForMode(): void {
    if (!this.mainWindow) {
      return;
    }
    if (deviceInfo.deviceType !== 'tablet' && deviceInfo.deviceType !== 'phone') {
      return;
    }
    const want: boolean = !this.pcModeEnabled;
    try {
      this.mainWindow.setWindowLayoutFullScreen(want)
        .then(() => {
          LogUtil.info(TAG, 'layout fullscreen ' + want + ' applied for pcMode=' + this.pcModeEnabled);
        })
        .catch((err: BusinessError) => {
          LogUtil.warn(TAG, 'layout fullscreen ' + want + ' rejected: ' + JSON.stringify(err));
        });
    } catch (exception) {
      LogUtil.warn(TAG, 'layout fullscreen call threw: ' + JSON.stringify(exception));
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
