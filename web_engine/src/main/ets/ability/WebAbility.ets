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
import { CommandType } from '../common/Constants';
import { PermissionManagerAdapter } from '../adapter/PermissionManagerAdapter';
import { RunningLockAdapter } from '../adapter/RunningLockAdapter';
import lazy { DragDropAdapter } from '../adapter/DragDropAdapter';
import { ConfigurationConstant, common } from '@kit.AbilityKit';
// NOTE: the wantConstant re-exported by @kit.AbilityKit (@ohos.app.ability.
// wantConstant) only knows ACTION_SEND_TO_DATA; the share actions live in
// the legacy @ohos.ability.wantConstant namespace.
import wantConstant from '@ohos.ability.wantConstant';
import { systemShare } from '@kit.ShareKit';

const TAG: string = 'WebAbility';

// Minimal shape of display.getAvailableArea()'s resolved Rect (round 92).
// Declared locally: this SDK's display namespace does not export the type
// directly, and ArkTS forbids the implicit any a missing type would cause.
interface AvailableAreaRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export class WebAbility extends WebBaseAbility {
  private static WINDOW_CLOSE: number = 1000;
  // Share / 碰一碰 cold-start handoff: the share want arrives in onCreate,
  // long before any window or the editor exists. It is stashed here and
  // dispatched exactly once from onWindowStageCreate (COLD_SHARE_DELAY_MS).
  private static pendingShareWant: Want | undefined = undefined;
  private static pendingShareDispatched: boolean = false;
  private static COLD_SHARE_DELAY_MS: number = 15000;
  // Round 106: process-wide registry of live ability instances. The settings
  // key observer is PROCESS-global (a second registerKeyObserver answers false
  // with "npai_settings_register_observer, already registered"), so the old
  // per-window registration bound the callback to whichever window registered
  // first: device log 07.442 res:false for the second window, 09.087 unregister
  // when the first was destroyed - the surviving window then never received a
  // PC-mode switch. Register once, broadcast to every live instance.
  private static liveInstances: Array<WebAbility> = [];
  private static pcmodeObserverRegistered: boolean = false;
  private static pcmodeObserverContext: Context | undefined = undefined;
  // Round 106: process-wide once guards for side effects that write the SHARED
  // mode file / register process-global listeners. Every new window used to redo
  // them (device log: window 813 and 819 each republished 277-280 font mappings
  // and registered another system-configuration listener that was never
  // removed).
  private static bootPublishesDone: boolean = false;
  private static configListenerRegistered: boolean = false;
  // Round 106: window events (size/rect/avoidArea/status) can all fire inside
  // the same frame at startup; five identical "re-pushed viewport bounds" were
  // logged within 3 ms, followed by ProcessJank. Suppress an IDENTICAL bound
  // pushed within this window; the 300 ms reconciliation still pushes, so the
  // same-value re-asserts that round 88 relies on are preserved.
  private static REPUSH_DEDUPE_MS: number = 150;
  private abilityManager: AbilityManager | undefined = undefined;
  private nativeThemeAdapter: NativeThemeAdapter | undefined = undefined;
  // PC-mode (floating windows) state on tablets; kept in sync with the
  // window_pcmode_switch_status system setting by the observer registered in
  // onWindowStageCreate. Drives the forced-maximize policy and the touch-mode
  // file.
  private pcModeEnabled: boolean = false;
  // IME height in CSS px, from keyboardHeightChange; published through the
  // mode file: Obsidian's mobile formatting toolbar positions itself with
  // top: calc(100vh - var(--keyboard-height) - toolbar-height) and nothing
  // in the engine sets that variable.
  private keyboardCss: number = 0;
  // One-shot post-status-change reconciliation timer (round 87 A2, revised
  // round 88: NO value-compare dedup on the engine push channel - the
  // engine consumes every windowSizeChange/windowRectChange event, including
  // same-value ones, e.g. the WINDOW_SHOWN re-assert; skipping them broke
  // maximize/restore and drag-resize on device). Round 106 adds exactly ONE
  // exception, on the repushViewportBounds path only: an IDENTICAL bound
  // inside a single startup burst (150 ms) is coalesced; the reconciliation
  // below is forced and never coalesced. -1 = idle.
  private viewportRecheckTimer: number = -1;
  // Round 153: single-shot retry for the touch fullscreen rect correction.
  // WMS answers 1300002 ("window state abnormal") when the resize lands while
  // the PC<->touch layout transition is still settling, so the synchronous
  // correction is not reliable: device log 07:39:58.844 shows the resize
  // rejected right after setWindowLayoutFullScreen(true) and the window only
  // filled because WMS maximised it on its own (reason:1). If WMS does not do
  // that, the window stays floating at the remembered PC size. One delayed
  // retry (never a ladder) plus the windowStatusChange re-assert covers it.
  private fullscreenRetryTimer: number = -1;
  private fullscreenRetryCount: number = 0;
  private static FULLSCREEN_RETRY_MS: number = 350;
  // Round 106: burst coalescing for the push (IDENTICAL bound within
  // REPUSH_DEDUPE_MS only; see the static comment).
  private lastPushedBoundKey: string = '';
  private lastPushedAtMs: number = 0;
  // Throttle for geometry-only mode-file writes (round 88): drag-resize
  // fires windowSizeChange per frame and the rect is part of the per-window
  // entry; without the throttle every tick rewrites the file on the UI
  // thread. Payload changes (insets/decor/keyboard) always write.
  private lastGeomWriteMs: number = 0;
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
  // This ability's OHOS window id, captured once when the window stage is
  // created (round 99). onWindowStageDestroy used to call
  // mainWindow.getWindowProperties() to delete its mode-file entry - by then
  // the window is already being torn down, that call throws 1300002 and the
  // cleanup was silently skipped, leaving windows[<id>] pointing at a dead
  // window. Device-proven consequence (vault switch): the closed window's
  // entry (keyboard:0) stayed in the file, stayed first in key order, and the
  // new window kept resolving to it, so the formatting toolbar never rose
  // again. Also used as the identity published on WINDOW_ACTIVE/INACTIVE.
  private ownerWindowId: number = -1;

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
  //    Floating windows get 0 insets; a MAXIMIZED free window overlaps the
  //    bars and gets the real ones, and (round 87, B1) the engine viewport
  //    NO LONGER subtracts the bars - the renderer CSS-avoids them via the
  //    desktop-safe-pad, exactly like the touch regime, so the maximized
  //    bottom edge blends into the UI instead of leaving a dead background
  //    strip.
  //  - phone                       -> same as touch.
  // There are NO timed settle/re-push compensations in this file: the engine
  // starts the browser only after the XComponent surface reports a stable
  // size (utils/SurfaceReady.ets), so every push below reacts to a real
  // window-geometry event. The single exception is the one-shot
  // reconciliation after a window-status transition (round 87 A2, kept
  // unconditional in round 88 and force-pushed in round 106 -
  // docs/window-state-machine.md §2/§3). Engine pushes are otherwise NEVER
  // deduped: the engine consumes each event, including same-value ones (the
  // WINDOW_SHOWN re-assert, reason-tagged rect events); value-compare skipping
  // broke maximize/restore and drag-resize on device. Round 106 coalesces only
  // an IDENTICAL bound fired inside one startup burst (see REPUSH_DEDUPE_MS).
  //  - state resolution order (round 102): pcModeEnabled is seeded
  //    synchronously at the TOP of onWindowStageCreate (resolvePcModeAtBoot)
  //    and the boot-time pcmode sync runs BEFORE loadContent, so no touch-only
  //    action can ever run against a window-mode window. The previous order
  //    (geometry block first, boot read last) force-fullscreened window-mode
  //    windows on every cold start; see docs/window-state-machine.md §2.

  // True when the window rect covers everything below the status bar or
  // the whole display (round 92). The old check compared against the full
  // display only - but THIS device maximizes free windows to the AVAILABLE
  // area, [0,87,2800,1753] against a 2800x1840 display (device log), so
  // "maximized" never registered: insets stayed 0/0, the stale caption
  // stayed visible and the nav-indicator strip kept covering content.
  // A window spanning the available area overlaps the bars just as much
  // as an edge-to-edge one (the status bar is ABOVE its top edge; the nav
  // strip is INSIDE it).
  private coversDisplayArea(rect: window.Rect): boolean {
    try {
      const displayClass = display.getDefaultDisplaySync();
      if (rect.width >= displayClass.width && rect.height >= displayClass.height) {
        return true;
      }
      const avail = this.availAreaCache;
      if (avail !== undefined && avail.height > 0) {
        return rect.width >= avail.width && rect.height >= avail.height;
      }
      // Cache not landed yet (H2): the first asynchronous getAvailableArea
      // is still in flight. Returning false published 0/0 insets for the
      // whole latency window - on an available-area maximize (cold start in
      // window mode, or maximize right after a mode switch) the nav
      // indicator then covered the content until the next convergence
      // event. Fall back to a conservative shape test instead: full width
      // plus >=85% display height covers every available-area maximize
      // (this device: 1753/1840 = 95%) while honest floating windows
      // (half/two-thirds height) stay out. A genuinely floating
      // near-maximize window receives bar insets for the residual latency
      // only; refreshAvailAreaCache re-publishes as soon as the real area
      // lands.
      return rect.width >= displayClass.width &&
        rect.height >= Math.round(displayClass.height * 0.85);
    } catch (exception) {
      return false;
    }
  }

  // Synthesizes the engine viewport from window properties. Two regimes:
  //  - Touch mode (full = true): the window IS the display; the real bar
  //    insets are published separately and the web content avoids them.
  //  - PC mode / free windows: the viewport is the drawable rect (window
  //    rect minus the caption strip; 0 when no caption).
  //    Round 87 (B1): maximized free windows NO LONGER subtract the
  //    system-bar avoid areas here. The old explicit deduction (rounds
  //    56/63) cropped the web Surface above the nav indicator, leaving a
  //    strip of dead window background that was neither web content nor a
  //    system bar - the reported "maximized bottom cannot blend into the
  //    UI". The viewport is now the full edge-to-edge rect and the renderer
  //    avoids the bars with CSS - one avoidance path for every form factor.
  private computeViewportBound(prop: window.WindowProperties): WindowBound {
    const full = !this.pcModeEnabled;
    if (full || !this.mainWindow) {
      return {
        left: prop.windowRect.left,
        top: prop.windowRect.top,
        width: prop.windowRect.width,
        height: prop.windowRect.height,
      };
    }
    // Round 102: the form factor is resolved at the very start now, so free
    // windows reach this branch from the FIRST geometry event - before the
    // caption strip has been composed, drawableRect can still be 0 (see
    // AppWindowAdapter's note on the same API). Pushing a 0x0 viewport would
    // make the engine latch an empty surface, so fall back to the window rect
    // until the drawable rect is real; the next geometry event corrects it.
    if (prop.drawableRect.width <= 0 || prop.drawableRect.height <= 0) {
      return {
        left: prop.windowRect.left,
        top: prop.windowRect.top,
        width: prop.windowRect.width,
        height: prop.windowRect.height,
      };
    }
    return {
      left: prop.windowRect.left + prop.drawableRect.left,
      top: prop.windowRect.top + prop.drawableRect.top,
      width: prop.drawableRect.width,
      height: prop.drawableRect.height,
    };
  }

  // True while this window has the system bars hidden (round 89). While
  // hidden, pushSafeAreaInsets publishes 0/0 and the web content fills the
  // window edge to edge; the renderer's CSS pad stays as the fallback for
  // the case where setWindowSystemBarEnable is rejected by the WMS.
  private barsHidden: boolean = false;
  // 1s watcher that re-evaluates bar visibility (round 89): the layout
  // override is written by the RENDERER (in-app command) with no window
  // geometry event attached, so event-driven evaluation alone would leave
  // the bars up until the next resize. The tick only reads the small mode
  // file; applySystemBarVisibility early-returns when nothing changed.
  private barWatchTimer: number = -1;
  // Last decor visibility this window pushed (round 91): true = free-window
  // caption shown, false = hidden (maximized/fullscreen). Transition-guard
  // for the per-geometry-event decor calls.
  private decorVisibleLast: boolean | undefined = undefined;
  // Round 154: true once the window-mode caption (decor + title buttons +
  // title drag) has been applied for the current caption state. The old code
  // re-issued setWindowTitleButtonVisible/setWindowTitleMoveEnabled on every
  // pushSafeAreaInsets() call (12x "SetWindowTitleMoveEnabled: enable:1" for
  // one PC entry in the 07:39 device log).
  private captionApplied: boolean = false;
  // Round 154: last value successfully applied by
  // setWindowLayoutFullScreen(); a repeated call for the same value is a pure
  // WMS round-trip (device log shows the same "true" twice per touch entry).
  private layoutFullscreenApplied: boolean | undefined = undefined;
  // Available-area cache (round 92): Display.getAvailableArea() is
  // ASYNCHRONOUS, but the coversDisplayArea checks run on synchronous
  // geometry-event paths. Refreshed fire-and-forget from the status-change
  // handler, the 1s bar watcher and startup; the sync checks use the last
  // known value. Until the first result lands the cache is undefined and
  // the check falls back to display-size only (false for this device's
  // available-area maximize) - the next status event / watcher tick /
  // A2 reconciliation converges within a second.
  private availAreaCache: AvailableAreaRect | undefined = undefined;
  private availAreaAtMs: number = 0;
  // First updateWindowPcmodeSwitchStatus call of this instance (H4): the
  // boot-time read must always apply the full side-effect set; later
  // observer fires with an UNCHANGED value skip them.
  private pcModeObserved: boolean = false;
  // True while a setWindowSystemBarEnable call is in flight (H8): the 1s
  // bar watcher re-runs applySystemBarVisibility and would otherwise issue
  // a duplicate WMS call because barsHidden still holds the previous value.
  private barsPending: boolean = false;
  // mtime+size-keyed cache for desktopLayoutWanted (H12/H16): the 1s
  // watcher and every geometry event re-read the mode file otherwise. The
  // size component covers second-resolution mtime platforms (OpenHarmony
  // Stat.mtime is seconds), where a same-second rewrite would otherwise
  // hit the cache - and the fields that matter (systemMode/override)
  // always change the file length, so mtime+size collisions are not
  // practically reachable. An insets-only same-length rewrite still
  // refreshes mtime and does not change the verdict it caches.
  private layoutWantCacheMtimeMs: number = -1;
  private layoutWantCacheSize: number = -1;
  private layoutWantCacheValue: boolean = false;

  // Atomic publish for the mode/protocol JSON files (H1): write a temp file
  // in the same directory, then rename over the target. The previous
  // openSync(TRUNC) + writeSync sequence left the target EMPTY between
  // truncate and write - a crash in that window zeroed ohsidian-mode.json,
  // and concurrent readers (renderer 200ms poll, sibling windows) saw the
  // torn content. rename() is atomic on the same filesystem, so every
  // reader observes either the complete old or the complete new file.
  private publishModeFileAtomic(filePath: string, cfg: Record<string, Object>): void {
    const tmpPath: string = filePath + '.tmp';
    const tmp = fileIo.openSync(tmpPath,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(tmp.fd, JSON.stringify(cfg));
    } finally {
      fileIo.closeSync(tmp);
    }
    try {
      fileIo.renameSync(tmpPath, filePath);
    } catch (renameException) {
      // Rename rejected (non-POSIX volume?): fall back to the direct
      // write - the old non-atomic behavior - and clean the temp file.
      const direct = fileIo.openSync(filePath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(direct.fd, JSON.stringify(cfg));
      } finally {
        fileIo.closeSync(direct);
      }
      try {
        fileIo.unlinkSync(tmpPath);
      } catch (unlinkException) {
        // temp file left behind - harmless, overwritten next publish
      }
    }
  }

  // Fire-and-forget available-area refresh, rate-limited to one request
  // per 500ms (the geometry handlers call this on every event).
  private refreshAvailAreaCache(): void {
    const nowMs: number = Date.now();
    // No rate limit while the cache has never landed (H2): an event burst
    // before the first result must not suppress the very fetch that would
    // end the empty-window period.
    if (this.availAreaCache !== undefined && nowMs - this.availAreaAtMs < 500) {
      return;
    }
    this.availAreaAtMs = nowMs;
    try {
      display.getDefaultDisplaySync().getAvailableArea()
        .then((area) => {
          const prev = this.availAreaCache;
          const next: AvailableAreaRect = {
            left: area.left,
            top: area.top,
            width: area.width,
            height: area.height,
          };
          this.availAreaCache = next;
          if (prev === undefined || prev.height !== next.height ||
            prev.width !== next.width) {
            // The cached area changed - judgments may flip; re-run the
            // inset publication (its unchanged check makes a no-op free).
            this.pushSafeAreaInsets();
          }
        })
        .catch(() => {
        });
    } catch (exception) {
      // cache stays stale; the display-size branch still applies
    }
  }

  // Mirrors the renderer's resolveWant: does the user want the DESKTOP
  // layout? cfg.override (written by the in-app command) wins; 'auto'
  // follows cfg.systemMode, which this process writes on every PC-mode
  // switch (touch form factor -> 'touch', PC mode / 2in1 -> 'desktop').
  private desktopLayoutWanted(): boolean {
    try {
      const filesDir: string = this.context.getApplicationContext().filesDir;
      const filePath: string = filesDir + '/ohsidian-mode.json';
      if (fileIo.accessSync(filePath)) {
        // H12/H16: the 1s watcher plus every geometry event used to pay a
        // full read+parse here. Cache the verdict keyed on mtime + size -
        // any writer (this process, sibling windows, the renderer command)
        // changes them (see the field comment for the precision analysis).
        let mtimeMs: number = 0;
        let sizeBytes: number = -1;
        try {
          const st = fileIo.statSync(filePath);
          mtimeMs = st.mtime < 100000000000 ? st.mtime * 1000 : st.mtime;
          sizeBytes = st.size;
        } catch (statException) {
          mtimeMs = 0;
        }
        if (mtimeMs >= 100000000000 && mtimeMs === this.layoutWantCacheMtimeMs &&
          sizeBytes === this.layoutWantCacheSize) {
          return this.layoutWantCacheValue;
        }
        const cfg = JSON.parse(fileIo.readTextSync(filePath)) as Record<string, Object>;
        let wanted: boolean = false;
        if (cfg) {
          const o = cfg['override'];
          if (o === 'desktop') {
            wanted = true;
          } else if (o === 'touch') {
            wanted = false;
          } else {
            wanted = cfg['systemMode'] === 'desktop';
          }
        }
        if (mtimeMs >= 100000000000) {
          this.layoutWantCacheMtimeMs = mtimeMs;
          this.layoutWantCacheSize = sizeBytes;
          this.layoutWantCacheValue = wanted;
        }
        return wanted;
      }
    } catch (e) {
      // fall through: conservative default keeps the bars visible
    }
    return false;
  }

  // Round 89: in the DESKTOP layout a fullscreen-like window hides the
  // system bars entirely. Round 88's body padding approach lost on device:
  // the status bar / three-key nav strip kept covering Obsidian's top and
  // bottom bars regardless of the CSS avoidance. The bars and the content
  // cannot both own that strip, so - authorized by the user - the bars
  // yield: hidden for touch-on-desktop-layout and maximized PC windows,
  // kept for the mobile layout (which consumes the inset vars fine) and
  // for floating windows (which never overlap the bars). Edge-swipe still
  // summons the bars temporarily (system behavior). If the WMS rejects the
  // call the flag stays false and the round-88 CSS pad remains the
  // fallback, so this degrades to round 88 behavior, not worse.
  private applySystemBarVisibility(): void {
    if (deviceInfo.deviceType !== 'tablet' && deviceInfo.deviceType !== 'phone') {
      return;
    }
    const winObj = this.mainWindow;
    if (!winObj) {
      return;
    }
    let fullscreenLike: boolean = false;
    try {
      // Round 92: available-area comparison included (maximized free
      // window on this device = available area, not the full display).
      fullscreenLike = this.coversDisplayArea(winObj.getWindowProperties().windowRect);
    } catch (exception) {
      return;
    }
    const wantHidden: boolean = fullscreenLike && this.desktopLayoutWanted();
    if (wantHidden === this.barsHidden || this.barsPending) {
      // barsPending (H8): a call is still in flight - the 1s watcher would
      // otherwise read the stale barsHidden and re-issue the same WMS call.
      // The .then/.catch below re-publishes insets on completion, which
      // re-runs this check with fresh state.
      return;
    }
    this.barsPending = true;
    try {
      const names: Array<'status' | 'navigation'> =
        wantHidden ? [] : ['status', 'navigation'];
      winObj.setWindowSystemBarEnable(names)
        .then(() => {
          this.barsPending = false;
          this.barsHidden = wantHidden;
          // Re-publish: insets collapse to 0 while hidden (the renderer
          // un-pads), real bar heights return when shown.
          this.pushSafeAreaInsets();
          LogUtil.info(TAG, 'system bars ' + (wantHidden ? 'hidden' : 'shown') +
            ' for desktop layout');
        })
        .catch((err: BusinessError) => {
          this.barsPending = false;
          LogUtil.warn(TAG, 'setWindowSystemBarEnable rejected: ' + JSON.stringify(err) +
            ' - CSS pad fallback stays active');
        });
    } catch (exception) {
      this.barsPending = false;
      LogUtil.warn(TAG, 'setWindowSystemBarEnable threw: ' + JSON.stringify(exception));
    }
  }

  // Publishes the real system-bar insets (CSS px) to the renderer through
  // ohsidian-mode.json. This is the officially recommended immersive
  // pattern: the background extends under the bars, while interactive
  // content avoids them using these values (Obsidian's mobile CSS consumes
  // --safe-area-inset-top/bottom, which otherwise fall back to a hardcoded
  // simulated iPhone notch). Zero whenever the window rect does not cover
  // the display (floating windows, 2in1/PC) - those never overlap the bars.
  // Round 89: in the DESKTOP layout a fullscreen-like window hides the
  // system bars entirely (round 88 proved CSS avoidance cannot win the
  // ownership fight for that strip on device); while hidden the published
  // insets are 0 and the content fills the window edge to edge.
  private pushSafeAreaInsets(): void {
    let topPx: number = 0;
    let bottomPx: number = 0;
    const winObj = this.mainWindow;
    this.applySystemBarVisibility();
    try {
      const handheld: boolean = deviceInfo.deviceType === 'tablet' ||
        deviceInfo.deviceType === 'phone';
      if (handheld && winObj) {
        // Bar overlap is a GEOMETRIC fact (does the window rect cover the
        // display?), not a mode fact (round 87, C2): a maximized free
        // window overlaps the bars, a floating window does not, and a
        // touch-mode window whose forced-fullscreen resize was rejected
        // sits as a floating rect too - the old unconditional
        // !pcModeEnabled handed it real bar insets it never overlaps.
        const rect = winObj.getWindowProperties().windowRect;
        // Round 92: coversDisplayArea accepts the available-area-sized
        // maximize this device produces (see the method comment).
        const overlapsBars: boolean = this.coversDisplayArea(rect);
        if (overlapsBars && this.barsHidden) {
          // Round 90: setWindowSystemBarEnable([]) hides the STATUS bar but
          // the tablet WMS keeps the gesture indicator (the little white
          // pill) floating over the bottom edge - device-verified. Avoid it
          // with a bottom-only inset: the renderer pads the content bottom
          // (body padding, background extends under the pill) while the
          // top stays flush.
          const navAvoid = winObj.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
          const sysAvoid = winObj.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
          topPx = 0;
          // Gesture indicator on gesture-nav devices; three-key nav reports
          // through TYPE_SYSTEM (and is likewise NOT hidden by the API on
          // some builds) - take whichever applies.
          bottomPx = Math.max(navAvoid.bottomRect.height, sysAvoid.bottomRect.height);
        } else if (overlapsBars) {
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
    // system caption there left the window with no bar whatsoever). Keep
    // it visible; decor='system' tells the renderer to hide Obsidian's own
    // .titlebar while the system strip is up.
    // Round 92 revision of round 91: this device maximizes free windows to
    // the AVAILABLE area (below the status bar), where the caption is
    // LEGITIMATE UI - it carries the restore button, and drawableRect.top
    // correctly carves the caption out of the viewport (that strip is
    // caption, not dead background). So fullscreen-like windows no longer
    // get the decor force-hidden; only truly edge-to-edge windows (touch
    // mode, where there is no caption anyway) run without it.
    // Round 154: decor is a FORM-FACTOR property, not a geometry one. Touch
    // mode is edge-to-edge by definition; while a pending rect correction
    // leaves the window floating for a moment, the old geometric check
    // decided "caption wanted" and called the caption APIs on a device that
    // cannot show a system caption at all (device log 07:39:58.828-58.866:
    // show system caption failed 801 x4, SetWindowTitleMoveEnabled not
    // supported x4). Worse, decor was still written as 'system', so the
    // renderer hid its own .titlebar and the window had NO title bar and no
    // drag surface until the rect landed. The caption APIs now run only in
    // window mode, once per caption state (see ensureSystemCaption).
    let decor: string = 'none';
    if (this.pcModeEnabled) {
      try {
        // Caption presence is a FULL-DISPLAY question (round 92): an
        // available-area-maximized free window still shows the caption with
        // its restore button; only a whole-display window is captionless.
        let captionless: boolean = false;
        if (winObj !== undefined) {
          const rect = winObj.getWindowProperties().windowRect;
          const displayClass = display.getDefaultDisplaySync();
          captionless = rect.width >= displayClass.width &&
            rect.height >= displayClass.height;
        }
        if (winObj !== undefined && !captionless) {
          if (this.ensureSystemCaption(winObj)) {
            decor = 'system';
          }
        } else {
          this.captionApplied = false;
        }
      } catch (exception) {
        decor = 'none';
        this.captionApplied = false;
      }
    } else if (this.captionApplied) {
      // Touch form factor: no caption at all. Reset the latch so the next
      // window-mode entry re-applies it once (the WMS shows the decor itself
      // on the mode change, but the latch must not claim "already applied").
      this.captionApplied = false;
      this.decorVisibleLast = undefined;
    }
    this.writeInsetsToFile(topCss, bottomCss, decor, this.keyboardCss);
  }

  // Round 154: apply the system caption (decor + title buttons + title drag)
  // ONCE per caption state. These are WMS round-trips that also push
  // title-button visibility to ArkUI; pushSafeAreaInsets() runs on every
  // geometry/inset/status event (ten times in the 27 s device log), so
  // re-issuing them per event is pure churn. Returns false when the device
  // rejects the caption (this tablet answers 801), so the caller can keep
  // decor='none' and let the renderer keep its own .titlebar as drag surface.
  private ensureSystemCaption(winObj: window.Window): boolean {
    if (this.captionApplied) {
      return true;
    }
    try {
      if (this.decorVisibleLast !== true) {
        winObj.setWindowDecorVisible(true);
        this.decorVisibleLast = true;
      }
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
      this.captionApplied = true;
      return true;
    } catch (captionException) {
      LogUtil.warn(TAG, 'show system caption failed: ' + JSON.stringify(captionException));
      this.captionApplied = false;
      return false;
    }
  }

  // Read-modify-write for ohsidian-mode.json. GLOBAL fields (systemMode,
  // override, fonts, documentsDir, ...) stay top-level; WINDOW geometry
  // goes under cfg.windows[<OHOS window id>] so concurrent Obsidian windows
  // cannot clobber each other's insets anymore (round 87, B2 - the file
  // used to be a single slot every EntryAbility overwrote within one 200ms
  // renderer poll). The MAIN window additionally mirrors its own geometry
  // into the legacy top-level fields: the main-process patch (default vault
  // / trash purge) and the pre-B2 renderer read those, and a single-window
  // session - the common case - is fully served by them.
  // cfg.viewportAvoidsBars is retired (round 87, B1): always false now,
  // kept only so a stale true written by an older build converges to false
  // instead of suppressing the renderer's CSS avoidance forever.
  private writeInsetsToFile(topCss: number, bottomCss: number, decor: string,
    keyboardCss: number): void {
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
      // Window rect in CSS px (Chromium maps 1 css px to one density pixel);
      // the renderer size-matches itself against it (no OHOS id there).
      let winId: number = -1;
      let rectLeft: number = 0;
      let rectTop: number = 0;
      let rectWidth: number = 0;
      let rectHeight: number = 0;
      if (this.mainWindow !== undefined) {
        try {
          winId = this.mainWindow.getWindowProperties().id;
          // Keep the cached id in sync (a window can be re-created with the
          // same ability instance across relaunches).
          this.ownerWindowId = winId;
          const rect = this.mainWindow.getWindowProperties().windowRect;
          let density: number = 1;
          try {
            density = display.getDefaultDisplaySync().densityPixels;
          } catch (exception) {
            density = 1;
          }
          if (!density || density <= 0) {
            density = 1;
          }
          rectLeft = Math.round(rect.left / density);
          rectTop = Math.round(rect.top / density);
          rectWidth = Math.round(rect.width / density);
          rectHeight = Math.round(rect.height / density);
        } catch (exception) {
          winId = -1;
        }
      }
      const isMain: boolean = this.isMainAppWindow;
      // windowSizeChange fires continuously during drag-resizes; skip the
      // file write when nothing actually changed (own entry + legacy mirror).
      let windows: Record<string, Object> = {};
      const existingWindows = cfg['windows'];
      if (existingWindows !== undefined && existingWindows !== null) {
        windows = existingWindows as Record<string, Object>;
      }
      let unchanged: boolean = true;
      // Round 88: geometry-only changes (rect moved, insets/decor/keyboard
      // identical) are throttled to one write per 500ms - drag-resize fires
      // per-frame and rewriting the file every tick on the UI thread wedged
      // window adjustment on device. Payload changes bypass the throttle.
      let geomOnly: boolean = true;
      if (winId >= 0) {
        const key: string = '' + winId;
        const prevObj = windows[key];
        if (prevObj !== undefined && prevObj !== null) {
          const prev = prevObj as Record<string, Object>;
          const sameGeom: boolean = prev['l'] === rectLeft && prev['t'] === rectTop &&
            prev['w'] === rectWidth && prev['h'] === rectHeight;
          const samePayload: boolean = prev['insetsTop'] === topCss &&
            prev['insetsBottom'] === bottomCss && prev['decor'] === decor &&
            prev['keyboard'] === keyboardCss;
          unchanged = sameGeom && samePayload;
          geomOnly = !sameGeom && samePayload;
        } else {
          unchanged = false;
          geomOnly = false;
        }
      }
      if (isMain) {
        const mirrorSame: boolean = cfg['windowDecor'] === decor &&
          cfg['keyboard'] === keyboardCss &&
          cfg['insets'] !== undefined &&
          (cfg['insets'] as Record<string, number>)['top'] === topCss &&
          (cfg['insets'] as Record<string, number>)['bottom'] === bottomCss &&
          cfg['viewportAvoidsBars'] === false;
        unchanged = unchanged && mirrorSame;
        geomOnly = geomOnly && mirrorSame;
      }
      if (unchanged) {
        return;
      }
      if (geomOnly) {
        const nowMs: number = Date.now();
        if (nowMs - this.lastGeomWriteMs < 500) {
          return;
        }
        this.lastGeomWriteMs = nowMs;
      } else {
        this.lastGeomWriteMs = 0;
      }
      if (winId >= 0) {
        const entry: Record<string, Object> = {
          'l': rectLeft,
          't': rectTop,
          'w': rectWidth,
          'h': rectHeight,
          'insetsTop': topCss,
          'insetsBottom': bottomCss,
          'decor': decor,
          'keyboard': keyboardCss,
        };
        windows['' + winId] = entry;
        cfg['windows'] = windows;
      }
      if (isMain) {
        cfg['insets'] = insets;
        cfg['windowDecor'] = decor;
        cfg['keyboard'] = keyboardCss;
        cfg['viewportAvoidsBars'] = false;
      }
      this.publishModeFileAtomic(filePath, cfg);
      LogUtil.info(TAG, 'safe-area insets updated: win=' + winId +
        ', top=' + topCss + ', bottom=' + bottomCss + ', decor=' + decor);
    } catch (err) {
      LogUtil.error(TAG, 'failed to write insets to mode file: ' + JSON.stringify(err));
    }
  }

  // Removes this window's geometry entry from ohsidian-mode.json (round 87,
  // B2). Without cleanup a closed window's entry lingers forever and the
  // renderer's size-match could pair a new window with dead geometry.
  private removeWindowGeometryEntry(): void {
    try {
      // Round 99: the live query used to run here and threw 1300002 because
      // the window is already being torn down at this point - the whole
      // cleanup was skipped and the entry lingered (device log:
      // "failed to remove window geometry entry: {\"code\":1300002}" right
      // after the WMS terminated persistentId 520). Use the id captured in
      // onWindowStageCreate; the live query stays only as a fallback for a
      // destroy that happens before the capture.
      let winId: number = this.ownerWindowId;
      if (winId < 0 && this.mainWindow !== undefined) {
        try {
          winId = this.mainWindow.getWindowProperties().id;
        } catch (exception) {
          winId = -1;
        }
      }
      if (winId < 0) {
        LogUtil.warn(TAG, 'remove window geometry entry: no window id');
        return;
      }
      const filesDir: string = this.context.getApplicationContext().filesDir;
      const filePath: string = filesDir + '/ohsidian-mode.json';
      let cfg: Record<string, Object> = {};
      try {
        if (fileIo.accessSync(filePath)) {
          cfg = JSON.parse(fileIo.readTextSync(filePath)) as Record<string, Object>;
          if (!cfg) {
            return;
          }
        } else {
          return;
        }
      } catch (e) {
        return;
      }
      const existingWindows = cfg['windows'];
      if (existingWindows === undefined || existingWindows === null) {
        return;
      }
      const windows = existingWindows as Record<string, Object>;
      const key: string = '' + winId;
      if (windows[key] === undefined) {
        return;
      }
      const next: Record<string, Object> = {};
      const keys: Array<string> = Object.keys(windows);
      for (const k of keys) {
        if (k !== key) {
          next[k] = windows[k];
        }
      }
      cfg['windows'] = next;
      // Drop the focus marker too when it points at this (dead) window. The
      // value is stringified defensively: a marker written as a number would
      // never compare equal to the string key.
      const focusedRaw: Object | undefined = cfg['focusedWindow'];
      const focused: string = (focusedRaw === undefined || focusedRaw === null) ? '' : ('' + focusedRaw);
      if (focused === key) {
        cfg['focusedWindow'] = '';
      }
      this.publishModeFileAtomic(filePath, cfg);
      LogUtil.info(TAG, 'window geometry entry removed: ' + key);
    } catch (err) {
      LogUtil.warn(TAG, 'failed to remove window geometry entry: ' + JSON.stringify(err));
    }
  }

  // Publishes which window currently owns the IME focus (round 99). The
  // renderer has no OHOS window identity (the engine exposes none), so it
  // matched its own mode-file entry by SIZE - and in touch mode every window
  // is the identical fullscreen rect at (0,0), so the match degenerated to the
  // lowest key, i.e. the OLDEST window. Device-proven: windows 520/522 both
  // 1244x818@0,0 while 522 held keyboard:344, so the freshly switched vault
  // read 520's keyboard:0 and the toolbar stayed down. Focus ownership is the
  // one identity signal the ArkTS side actually has, so publish it.
  private publishFocusedWindow(focused: boolean): void {
    try {
      const winId: number = this.ownerWindowId;
      if (winId < 0) {
        return;
      }
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
      const key: string = '' + winId;
      const prev: string = cfg['focusedWindow'] === undefined ? '' :
        (cfg['focusedWindow'] as string);
      // Losing focus must not steal the marker from a sibling that already
      // claimed it (INACTIVE of the old window can arrive after ACTIVE of the
      // new one).
      if (focused) {
        if (prev === key) {
          return;
        }
        cfg['focusedWindow'] = key;
      } else {
        if (prev !== key) {
          return;
        }
        cfg['focusedWindow'] = '';
      }
      this.publishModeFileAtomic(filePath, cfg);
      LogUtil.info(TAG, 'focused window: ' + (focused ? key : 'none'));
    } catch (err) {
      LogUtil.warn(TAG, 'failed to publish focused window: ' + JSON.stringify(err));
    }
  }

  // Drops every per-window geometry entry (main window, startup only -
  // round 88). Entries survive hard kills (no destroy callback) and OS
  // upgrades, and the renderer's size-match could then pair a fresh window
  // with stale insets. Runs before this session's windows write their own
  // entries again, so nothing live is lost.
  private clearStaleWindowEntries(): void {
    if (!this.isMainAppWindow) {
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
            return;
          }
        } else {
          return;
        }
      } catch (e) {
        return;
      }
      if (cfg['windows'] === undefined) {
        return;
      }
      const next: Record<string, Object> = {};
      const keys: Array<string> = Object.keys(cfg);
      for (const k of keys) {
        if (k !== 'windows') {
          next[k] = cfg[k];
        }
      }
      this.publishModeFileAtomic(filePath, next);
      LogUtil.info(TAG, 'stale window geometry entries cleared');
    } catch (err) {
      LogUtil.warn(TAG, 'failed to clear stale window entries: ' + JSON.stringify(err));
    }
  }

  // Window mode: the system restores the window in whatever rect it last
  // had, and converting a fullscreen window into a free window can push the
  // bottom (or right) edge beyond the display - the reported "bottom of the
  // window is not visible". Clamp such rects back into the display and
  // shrink them to a comfortable size (80%, centered). Main window only;
  // PC mode only.
  private clampWindowToWorkArea(): void {
    if (!this.isMainAppWindow) {
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

  // One-shot reconciliation after a window-status transition (round 87, A2;
  // round 88: the push is UNCONDITIONAL): windowStatusChange can arrive
  // BEFORE the maximize animation settles, and the trailing
  // windowSizeChange that would correct the viewport may never come (the
  // reason the handler re-pushes at all). Re-read the rect once and
  // re-assert it - identical to the immediate push, just settled. Single-
  // shot and rescheduled (never stacked) if another status change arrives
  // first; NOT a settle ladder (docs/window-state-machine.md §3 - those
  // pushed unconditionally on a TIMER and raced the WMS settle; this fires
  // once, 300ms after the last status transition).
  private scheduleViewportReconcile(): void {
    if (this.viewportRecheckTimer !== -1) {
      clearTimeout(this.viewportRecheckTimer);
    }
    this.viewportRecheckTimer = setTimeout(() => {
      this.viewportRecheckTimer = -1;
      // Forced: the reconciliation is the round-88 "same-value re-assert" and
      // must never be coalesced by the round-106 burst exception.
      this.repushViewportBounds(true);
    }, 300);
  }

  // Re-pushes the current window bounds to the engine. Called from real
  // geometry events (avoidAreaChange, windowStatusChange, the A2
  // reconciliation). UNCONDITIONAL (round 88) with the round-106 burst
  // exception: `force` bypasses the 150 ms identical-bound coalescing and is
  // used by the reconciliation timer.
  private repushViewportBounds(force: boolean = false): void {
    try {
      const win = this.mainWindow;
      if (!win) {
        return;
      }
      const bound = this.computeViewportBound(win.getWindowProperties());
      // Round 106: coalesce the startup burst. windowSizeChange /
      // windowRectChange / avoidAreaChange / windowStatusChange all fired
      // inside the first frames; five identical pushes went out within 3 ms
      // (device log 02.389..02.392) and were followed by ProcessJank. Only an
      // IDENTICAL bound inside REPUSH_DEDUPE_MS is suppressed, and the
      // reconciliation passes force=true so it is ALWAYS delivered.
      const key: string = bound.left + ',' + bound.top + ',' + bound.width + ',' + bound.height;
      const now: number = Date.now();
      if (!force && key === this.lastPushedBoundKey &&
        now - this.lastPushedAtMs < WebAbility.REPUSH_DEDUPE_MS) {
        LogUtil.info(TAG, 're-push skipped (identical bound within burst): ' + key);
        return;
      }
      this.nativeContext.OnWindowSizeChange(this.xcomponentId, bound);
      // Latch AFTER the native call: if it throws, the catch below must not
      // swallow the next identical event of the same burst (audit P2-2).
      this.lastPushedBoundKey = key;
      this.lastPushedAtMs = now;
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
  // FORM-FACTOR GUARD, NOT A MAIN-WINDOW PRIVILEGE (round 107): the touch
  // rect correction must run on EVERY window of the touch form factor.
  // `isMainAppWindow` means "the launch want carried no xcomponentId", i.e.
  // the app's FIRST window - not "the app's current/primary window". A vault
  // switch creates its window through the engine (createWindow always passes
  // xcomponentId), so that window is main=false, and the old main window is
  // destroyed right after: the new window stays main=false forever. With the
  // old main-only gate the touch correction never ran there, and the engine's
  // desktop bounds memory (<userData>/<vaultId>.json) resized the (floating)
  // window to the remembered PC-mode rect - the reported "vault switch in
  // touch mode leaves the window at the window-mode size".
  // The window form is excluded by the pcModeEnabled guard below (round 102);
  // 2in1 must stay untouched (its pcModeEnabled is false because the boot read
  // is skipped - H15 - but it is a desktop window, not a touch one).
  private forceFullscreenWindow(): void {
    if (this.pcModeEnabled) {
      // Window form factor: forcing the display rect is the TOUCH-only
      // correction (docs/window-state-machine.md §1/§2). On a window-mode
      // window it overrides the remembered floating rect and races the
      // engine's own startup setBounds (desktop bounds restore) - the
      // "flashes full-size, then returns" symptom (round 102).
      // INVARIANT GUARD: today no caller reaches this in window form
      // (updateWindowPcmodeSwitchStatus calls it only after setting the field
      // to false; the loadContent re-assert checks the flag first) - it is
      // kept so a future caller cannot silently reintroduce the bug.
      LogUtil.warn(TAG, 'force fullscreen ignored: window form factor');
      return;
    }
    // Touch form factors only: 2in1 keeps desktop window geometry even though
    // pcModeEnabled is false there (H15 skips the boot read, and the pcmode
    // observer may still fire), so forcing the display rect would destroy it.
    if (deviceInfo.deviceType !== 'tablet' && deviceInfo.deviceType !== 'phone') {
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
          // Correction landed: a later mode switch starts a fresh budget.
          this.fullscreenRetryCount = 0;
          // H5: publish the insets for the NEW rect even when the WMS
          // swallows the trailing windowSizeChange - the mode-switch caller
          // pushed insets for the PRE-resize rect.
          this.pushSafeAreaInsets();
        })
        .catch((err: BusinessError) => {
          LogUtil.warn(TAG, 'force fullscreen (rect) failed: ' + JSON.stringify(err));
          // Round 153: the mode switch is still settling - retry once, later.
          if (err.code === 1300002) {
            this.scheduleFullscreenRetry();
          }
        });
    } catch (exception) {
      LogUtil.warn(TAG, 'force fullscreen (rect) threw: ' + JSON.stringify(exception));
    }
  }

  // Round 153: one delayed retry after WMS rejected the touch rect correction
  // with 1300002 (mode/layout transition still settling). Single-shot by
  // design: the state machine only allows one delayed action per switch, and
  // a ladder would race the WMS settle again (docs/window-state-machine.md §3).
  private scheduleFullscreenRetry(): void {
    if (this.fullscreenRetryTimer !== -1 || this.fullscreenRetryCount >= 1) {
      return;
    }
    this.fullscreenRetryCount++;
    this.fullscreenRetryTimer = setTimeout(() => {
      this.fullscreenRetryTimer = -1;
      if (this.pcModeEnabled) {
        // The user is back in window mode - the display rect would be wrong.
        return;
      }
      LogUtil.info(TAG, 'retrying forced fullscreen rect after 1300002');
      this.forceFullscreenWindow();
    }, WebAbility.FULLSCREEN_RETRY_MS);
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
      this.publishModeFileAtomic(filePath, cfg);
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
  private publishDocumentsDir(grantedHint?: boolean): void {
    const permissionManager: PermissionManagerAdapter = Inject.get(PermissionManagerAdapter);
    const granted: boolean = grantedHint === undefined
      ? permissionManager.isPermissionGrantedSync('directory_document')
      : grantedHint;
    let documentsDir: string = '';
    if (granted) {
      try {
        documentsDir = environment.getUserDocumentDir();
      } catch (exception) {
        LogUtil.warn(TAG, 'getUserDocumentDir failed: ' + JSON.stringify(exception));
      }
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
      const changed: boolean = cfg['documentsDir'] !== documentsDir ||
        cfg['documentsDirGranted'] !== granted;
      if (!changed) {
        return;
      }
      // Empty (not stale) when the permission is missing/revoked: the
      // renderer used to treat any non-empty documentsDir as "granted" and
      // then pointed the default vault / trash / logs at an unusable path.
      cfg['documentsDir'] = documentsDir;
      cfg['documentsDirGranted'] = granted;
      this.publishModeFileAtomic(filePath, cfg);
      LogUtil.info(TAG, 'documents dir published: granted=' + granted +
        ', dir=' + documentsDir);
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

  // publishSystemFonts completed successfully in this PROCESS (round 106:
  // static - the mode file it writes is shared by every window, and the old
  // per-instance flag made each new window redo the whole 277-280 mapping pass).
  private static systemFontsPublished: boolean = false;
  // Family count at the successful publish (F-N3): onFontIdUpdated compares
  // the current system list against it and resets the one-shot lock when a
  // runtime font-package install changed the list size.
  private static publishedFontFamilyCount: number = -1;
  // publishSystemFonts run currently in flight (guards concurrent callers;
  // static for the same process-wide reason).
  private static systemFontsPublishing: boolean = false;
  // probeThemeManifestFont outcome: the active theme slot exists and its
  // manifest parsed, but NO listed font passed the size gate - i.e. the
  // DEFAULT style, whose font is an empty stub (even Ace cannot load it).
  private manifestFontIsStub: boolean = false;

  private async publishSystemFonts(): Promise<void> {
    if (WebAbility.systemFontsPublished) {
      // One successful publish per process: the system font list cannot
      // change while we run, and re-running the static + descriptor passes
      // re-loads every typeface (the engine logs 'not variable font!' for
      // each static font) to arrive at an identical mode file. The
      // onFontIdUpdated re-publish only exists to catch the early-startup
      // race; once published it is pure noise.
      LogUtil.info(TAG, 'publishSystemFonts: already published this launch, skipping');
      return;
    }
    if (WebAbility.systemFontsPublishing) {
      LogUtil.info(TAG, 'publishSystemFonts: run already in progress, skipping');
      return;
    }
    WebAbility.systemFontsPublishing = true;
    try {
      await this.publishSystemFontsInner();
    } finally {
      WebAbility.systemFontsPublishing = false;
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
        WebAbility.systemFontsPublished = true;
        WebAbility.publishedFontFamilyCount = families.length;
        return;
      }
      cfg['systemFonts'] = nextFontsJson;
      cfg['fontFiles'] = nextFilesJson;
      this.publishModeFileAtomic(filePath, cfg);
      WebAbility.systemFontsPublished = true;
      WebAbility.publishedFontFamilyCount = families.length;
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
        // theme download store (/data/themes/s/online/download/font/<fontId>/...);
        // try the entry as-is when the basename join did not resolve - but
        // ONLY under the theme tree (F-N5/S8): a manifest naming an
        // arbitrary absolute path outside /data/themes is never legitimate.
        if (entry !== candidate && entry.startsWith('/data/themes/')) {
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
      this.publishModeFileAtomic(filePath, cfg);
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
      this.publishModeFileAtomic(filePath, cfg);
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
              this.publishModeFileAtomic(filePath, cfg);
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
  //
  // Round 106: registration is PROCESS-wide (static guard) and the callbacks
  // dispatch to a LIVE window instance instead of closing over the window that
  // happened to register first. Previously every new window registered another
  // listener that was never removed: after a vault switch the callbacks ran
  // publishSystemFonts()/writeFontScaleToFile() on a destroyed ability (closure
  // leak, log noise, mode-file writes from a dead window).
  private registerSystemConfigListener(): void {
    if (WebAbility.configListenerRegistered) {
      LogUtil.info(TAG, 'system configuration listener already registered (process-wide), skipping');
      return;
    }
    try {
      const appContext = this.context.getApplicationContext();
      appContext.onSystemConfigurationUpdated({
        onFontIdUpdated: (fontId: string) => {
          WebAbility.dispatchFontIdUpdate(fontId);
        },
        onFontSizeScaleUpdated: (fontSizeScale: number) => {
          WebAbility.dispatchFontScaleUpdate(fontSizeScale);
        },
      });
      WebAbility.configListenerRegistered = true;
      LogUtil.info(TAG, 'system configuration listener registered');
    } catch (exception) {
      LogUtil.warn(TAG, 'onSystemConfigurationUpdated registration failed: ' + JSON.stringify(exception));
    }
  }

  // Picks the identifier the SHARED mode-file writes should be attributed to:
  // the main window when one is alive, else the oldest live one.
  private static primaryLiveInstance(): WebAbility | undefined {
    for (let i = 0; i < WebAbility.liveInstances.length; i++) {
      if (WebAbility.liveInstances[i].isMainAppWindow) {
        return WebAbility.liveInstances[i];
      }
    }
    if (WebAbility.liveInstances.length > 0) {
      return WebAbility.liveInstances[0];
    }
    return undefined;
  }

  private static dispatchFontIdUpdate(fontId: string): void {
    const inst = WebAbility.primaryLiveInstance();
    if (inst === undefined) {
      // No window to publish from: let the next window stage re-run the boot
      // publish block instead of dropping the event (R106-7). The publish
      // itself is cleared too - otherwise the next block would hit the
      // publish-once guard and silently skip the new font list (audit P2-3).
      WebAbility.bootPublishesDone = false;
      WebAbility.systemFontsPublished = false;
      LogUtil.warn(TAG, 'onFontIdUpdated: no live window to publish font data');
      return;
    }
    try {
      LogUtil.info(TAG, 'onFontIdUpdated: ' + fontId);
      // F-N3: a runtime font-package install changes the system font list but
      // fires no other callback - the publish-once lock would keep the picker
      // stale until the next cold start. Reset the lock when the list size
      // moved so the republish below refreshes it.
      try {
        const list = font.getSystemFontList();
        if (Array.isArray(list) && WebAbility.publishedFontFamilyCount >= 0 &&
          list.length !== WebAbility.publishedFontFamilyCount) {
          LogUtil.info(TAG, 'font list size changed (' + WebAbility.publishedFontFamilyCount +
            ' -> ' + list.length + '), republishing font picker data');
          WebAbility.systemFontsPublished = false;
        }
      } catch (e) {
        // list unavailable - keep the lock state as-is
      }
      // The font system is provably ready here - a safe moment to (re)publish
      // the picker data if the early-startup attempt raced.
      inst.publishSystemFonts();
      inst.publishFontId(fontId);
      inst.publishStyleFonts();
      inst.publishThemeFontPath();
    } catch (exception) {
      LogUtil.warn(TAG, 'onFontIdUpdated dispatch failed: ' + JSON.stringify(exception));
    }
  }

  private static dispatchFontScaleUpdate(fontSizeScale: number): void {
    if (!(fontSizeScale > 0)) {
      return;
    }
    const inst = WebAbility.primaryLiveInstance();
    if (inst === undefined) {
      return;
    }
    try {
      const next: number = Math.round(fontSizeScale * 100) / 100;
      // Audit P3: no instance-field compare here - onConfigurationUpdate and
      // this listener are independent channels, so the field can lag behind
      // the file and would swallow a real change. writeFontScaleToFile already
      // compares against the file value.
      inst.fontScale = next;
      inst.writeFontScaleToFile(next);
    } catch (exception) {
      LogUtil.warn(TAG, 'onFontSizeScaleUpdated dispatch failed: ' + JSON.stringify(exception));
    }
  }

  // Round 106: process-wide registry used by the pcmode broadcast and the
  // configuration-listener dispatch (see the static field comments).
  private static addLiveInstance(inst: WebAbility): void {
    if (WebAbility.liveInstances.indexOf(inst) === -1) {
      WebAbility.liveInstances.push(inst);
    }
  }

  private static removeLiveInstance(inst: WebAbility): void {
    const idx: number = WebAbility.liveInstances.indexOf(inst);
    if (idx >= 0) {
      WebAbility.liveInstances.splice(idx, 1);
    }
    // Audit P2-4: if the boot publisher died before the (async) font/theme
    // pass completed, let the next window stage redo it - the old per-window
    // behaviour self-healed here and the process-wide once must not lose that.
    if (!WebAbility.systemFontsPublished) {
      WebAbility.bootPublishesDone = false;
    }
    if (WebAbility.liveInstances.length > 0) {
      // The observer was registered with the context of whichever window came
      // first; if THAT window dies while others live, rebind the observer to a
      // live window so the final unregister still has a valid context.
      if (WebAbility.pcmodeObserverRegistered &&
        WebAbility.pcmodeObserverContext === inst.context) {
        const obsCtx = WebAbility.pcmodeObserverContext;
        try {
          if (obsCtx !== undefined) {
            settings.unregisterKeyObserver(obsCtx, 'window_pcmode_switch_status',
              settings.domainName.USER_PROPERTY);
          }
        } catch (exception) {
          LogUtil.warn(TAG, 'pcmode observer rebind unregister failed: ' +
            JSON.stringify(exception));
        }
        WebAbility.pcmodeObserverRegistered = false;
        WebAbility.pcmodeObserverContext = undefined;
        const nextOwner = WebAbility.liveInstances[0];
        if (!WebAbility.ensurePcmodeObserver(nextOwner.context)) {
          LogUtil.warn(TAG, 'pcmode observer rebind failed; runtime switches stop ' +
            'working until the next window stage is created');
        }
      }
      return;
    }
    if (!WebAbility.pcmodeObserverRegistered) {
      return;
    }
    // Last window of the process: hand the process-global observer back so a
    // later cold start does not see "already registered" from a dead context.
    const obsCtx = WebAbility.pcmodeObserverContext;
    try {
      if (obsCtx !== undefined) {
        settings.unregisterKeyObserver(obsCtx, 'window_pcmode_switch_status',
          settings.domainName.USER_PROPERTY);
        LogUtil.info(TAG, 'pcmode observer unregistered (last window closed)');
      }
    } catch (exception) {
      LogUtil.warn(TAG, 'unregister pcmode observer failed: ' + JSON.stringify(exception));
    }
    WebAbility.pcmodeObserverRegistered = false;
    WebAbility.pcmodeObserverContext = undefined;
  }

  // Registers the process-global setting observer exactly once and broadcasts
  // every change to all live windows. Returns whether the observer is (already)
  // registered.
  // Audit P2-7: prefer the APPLICATION context - it is process-scoped, so the
  // observer no longer depends on the lifetime of whichever window registered
  // first (a window-context registration can die with its window and leave the
  // rebind path as the only recovery). The ability context stays as a fallback
  // for builds where the application context cannot be used here.
  private static ensurePcmodeObserver(context: Context): boolean {
    if (WebAbility.pcmodeObserverRegistered) {
      return true;
    }
    const candidates: Array<Context> = [];
    let appCtx: Context | undefined = undefined;
    try {
      appCtx = context.getApplicationContext();
    } catch (exception) {
      appCtx = undefined;
    }
    if (appCtx !== undefined) {
      candidates.push(appCtx);
    }
    candidates.push(context);
    for (let i = 0; i < candidates.length; i++) {
      try {
        const res: boolean = settings.registerKeyObserver(candidates[i],
          'window_pcmode_switch_status', settings.domainName.USER_PROPERTY, () => {
          WebAbility.broadcastPcmodeChange();
        });
        if (res) {
          WebAbility.pcmodeObserverRegistered = true;
          WebAbility.pcmodeObserverContext = candidates[i];
          return true;
        }
      } catch (exception) {
        LogUtil.warn(TAG, 'register pcmode observer failed (candidate ' + i + '): ' +
          JSON.stringify(exception));
      }
    }
    return false;
  }

  private static broadcastPcmodeChange(): void {
    // Snapshot: updateWindowPcmodeSwitchStatus can synchronously destroy
    // nothing, but a live instance may still remove itself via a re-entrant
    // callback; iterating a copy keeps the broadcast deterministic.
    const list: Array<WebAbility> = WebAbility.liveInstances.slice();
    for (let i = 0; i < list.length; i++) {
      const inst = list[i];
      try {
        inst.updateWindowPcmodeSwitchStatus(inst.context);
      } catch (exception) {
        LogUtil.warn(TAG, 'pcmode broadcast to ' + inst.xcomponentId +
          ' failed: ' + JSON.stringify(exception));
      }
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

    // Round 102 (docs/window-state-machine.md §2): the FORM FACTOR must be
    // resolved before ANY geometry / layout action of this window. The field
    // default (false = touch) is not a valid answer: it used to be consumed
    // by the startup block inside the loadContent callback while the real
    // value was still unread, so a WINDOW-mode cold start ran the touch-only
    // corrections (layout fullscreen + display-rect resize) and the engine's
    // remembered-bounds setBounds had to undo them - the visible "window
    // flashes full-size, then returns to the remembered size".
    this.pcModeEnabled = this.resolvePcModeAtBoot();
    // Round 106: join the process-wide registry on EVERY form factor - it also
    // feeds the font/scale dispatch (a phone has no pcmode observer but still
    // needs the configuration-listener callbacks to reach a live window).
    WebAbility.addLiveInstance(this);
    // Audit fix: a rebuilt window stage must not inherit the previous stage's
    // coalescing latch, or the first identical push of the new stage could be
    // swallowed.
    this.lastPushedBoundKey = '';
    this.lastPushedAtMs = 0;
    // Round 153: a rebuilt window stage starts with a fresh fullscreen-retry
    // budget, and no retry may survive into it.
    this.fullscreenRetryCount = 0;
    if (this.fullscreenRetryTimer !== -1) {
      clearTimeout(this.fullscreenRetryTimer);
      this.fullscreenRetryTimer = -1;
    }
    // Round 154: a rebuilt stage has no caption/layout state applied yet.
    this.captionApplied = false;
    this.layoutFullscreenApplied = undefined;
    // Round 102: every window-stage setup start counts as a FIRST sync again
    // (onWindowStageDestroy -> onWindowStageCreate can happen on the same
    // ability instance: display/casting switches, window-stage rebuild). The
    // boot-time sync is now the ONLY place applying the rect/layout
    // corrections, so without this reset the second setup would early-return
    // as "unchanged" and apply nothing at all.
    this.pcModeObserved = false;
    // Round 88: purge per-window geometry left by previous sessions (hard-
    // killed windows never ran the destroy cleanup). Round 102: moved above
    // the boot-time mode sync, which now publishes this window's own entry
    // before loadContent - clearing afterwards would delete that fresh entry.
    this.clearStaleWindowEntries();

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
    // Round 99: capture the window id at the only moment it is guaranteed to
    // be readable (see ownerWindowId - the destroy-time query throws 1300002).
    try {
      this.ownerWindowId = this.mainWindow.getWindowProperties().id;
      LogUtil.info(TAG, 'window id captured: ' + this.ownerWindowId +
        ', main=' + this.isMainAppWindow);
    } catch (exception) {
      LogUtil.warn(TAG, 'capture window id failed: ' + JSON.stringify(exception));
    }
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
    // Round 106: these publishes write the SHARED mode file and walk every
    // installed font descriptor; one pass per PROCESS is enough. New windows
    // used to repeat the whole set (device log: 813 and 819 each republished
    // 277-280 mappings and re-ran the style/theme scans), and each of them
    // registered another process-global configuration listener.
    // Audit P2-5: the listener registration and the (idempotent, value-compared)
    // documents-dir publish stay OUTSIDE the once block - both have their own
    // guards, and if the first attempt throws, a later window must retry
    // instead of leaving the process without the listener until restart.
    this.publishDocumentsDir();
    this.registerSystemConfigListener();
    if (!WebAbility.bootPublishesDone) {
      WebAbility.bootPublishesDone = true;
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
    }
    if (this.isMainAppWindow) {
      // Startup-time user_grant permissions (main window only). 0 ==
      // REQUEST_PERMISSION_SUCCESS (module-private constant there).
      //  - directory_document: uninstall-safe vault root (Documents);
      //  - directory_download: downloads writes (engine save-as flows).
      // Everything else (pasteboard/bluetooth/camera/mic/location/screen
      // capture) stays on-demand: the engine requests it when the matching
      // web feature runs, so users are not greeted with a wall of dialogs.
      const dirRequests: Array<string> = ['directory_document', 'directory_download'];
      let dirPending: number = dirRequests.length;
      let documentsGranted: boolean | undefined = undefined;
      const republish = (): void => {
        dirPending--;
        if (dirPending === 0) {
          // Pass the REAL result so a first-launch denial clears documentsDir
          // in the same pass (instead of leaving the pre-request value).
          this.publishDocumentsDir(documentsGranted);
        }
      };
      dirRequests.forEach((permType: string) => {
        // The ability context directly: requestPermissions() resolves it via
        // ContextAdapter.getActiveContext(), which is only set once the
        // renderer calls setActiveWindow - too late for startup requests.
        Inject.get(PermissionManagerAdapter).requestPermissionsForContext(
          this.context, permType,
          (granted: number) => {
            if (granted === 0) {
              LogUtil.info(TAG, 'startup permission granted: ' + permType);
            } else {
              LogUtil.warn(TAG, 'startup permission NOT granted: ' + permType +
                ' code=' + granted);
            }
            if (permType === 'directory_document') {
              documentsGranted = granted === 0;
            }
            republish();
          });
      });
    }
    // Diagnostic: dump the device shape - the mode branches below gate on it.
    LogUtil.info(TAG, 'diagnostic: deviceType=' + deviceInfo.deviceType +
      ', sdkApiVersion=' + deviceInfo.sdkApiVersion);
    // Round 102 (docs/window-state-machine.md §2): APPLY the form factor
    // before the content is loaded. Everything form-dependent now happens
    // here, exactly once:
    //  - updateWindowPcmodeSwitchStatus owns the startup window-rect
    //    correction (touch: force the display rect; window: clamp only);
    //  - applyLayoutFullscreenForMode owns the layout-fullscreen flag
    //    (touch: true; window: explicit false), so the standalone
    //    setWindowLayoutFullScreen(true) call it replaces is gone - a
    //    window-mode window can no longer be switched into the touch regime
    //    even briefly (that transient is the round-50 "title bar cannot
    //    move" root cause, §3/§5);
    //  - the loadContent callback below only KEEPS a touch-only re-assert of
    //    the rect (idempotent safety net, see there), it does not re-decide
    //    the form factor or the layout flag.
    if (deviceInfo.deviceType === 'tablet' || deviceInfo.deviceType === '2in1') {
      // this.context instead of getContext(this): the destroy-time unregister
      // uses this.context, so register/unregister now share one context
      // object (round 102; getContext() also depends on a loaded UI).
      const context: Context = this.context;
      // Round 106: join the process-wide broadcast registry FIRST, then make
      // sure the process-global observer exists. A second window no longer
      // registers (settings answers false with "already registered") - it just
      // receives broadcasts. On destruction the window leaves the registry;
      // the observer is unregistered when the LAST window closes.
      const res: boolean = WebAbility.ensurePcmodeObserver(context);
      LogUtil.info(TAG, 'register window_pcmode_switch_status,res:' + res + ',xcomponentId:' + this.xcomponentId);
      // Whether or not the observer registered, the current value must be
      // read once: a tablet already in PC mode at launch needs the right
      // mode, and the first read applies layout-fullscreen + window-rect
      // corrections for the current form factor.
      // H15 (do NOT "fix" this by symmetry): only the TABLET runs the boot
      // read. On 2in1 the key is not guaranteed to exist, getValueSync would
      // answer the default 'false' and flip the historical desktop boot
      // default to touch; resolveWant treats a missing systemMode as desktop,
      // so skipping the write is the 2in1 no-op. Runtime switches arrive
      // through the observer for both form factors.
      if (deviceInfo.deviceType === 'tablet') {
        this.updateWindowPcmodeSwitchStatus(context);
      }
    } else {
      // phone: the tablet's touch regime without a pcmode setting to read.
      this.writeTouchModeFile(false);
      this.applyLayoutFullscreenForMode();
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
            // Round 92: maximize may land on the available area (not the
            // full display) - refresh the cache the sync checks consume.
            this.refreshAvailAreaCache();
            this.pushSafeAreaInsets();
            this.repushViewportBounds();
            // The status event can equally arrive BEFORE the animation
            // settles - reconcile once it has (round 87, A2).
            this.scheduleViewportReconcile();
          }
          // Round 153: in the touch form factor the window must BE the
          // display. A status event that reports a floating/maximized window
          // means the rect correction did not land (or a PC-mode layout was
          // restored): re-assert it. forceFullscreenWindow is idempotent and
          // returns immediately when the window is already display-sized, so
          // the FULL_SCREEN event of our own resize does not loop.
          if (!this.pcModeEnabled &&
            (status === window.WindowStatusType.FLOATING ||
              status === window.WindowStatusType.MAXIMIZE)) {
            this.forceFullscreenWindow();
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
          // Round 99: focus ownership is the only window identity the ArkTS
          // side can publish - the renderer cannot tell its own window apart
          // in touch mode (all fullscreen rects are identical). See
          // publishFocusedWindow.
          if (type == window.WindowEventType.WINDOW_ACTIVE) {
            this.publishFocusedWindow(true);
          } else if (type == window.WindowEventType.WINDOW_INACTIVE) {
            this.publishFocusedWindow(false);
          }
          if (type == window.WindowEventType.WINDOW_SHOWN) {
            // Round 87 (A1): WINDOW_SHOWN is in the state machine §2 list -
            // re-publish the insets alongside the viewport. Switching back
            // to the app can coincide with bar changes (gesture/nav-mode
            // flip, rotation) that fired no event while the window was
            // hidden; without this the renderer kept the stale inset and
            // padded the wrong height. Round 88: the viewport push is
            // UNCONDITIONAL - this same-value re-assert is an engine
            // re-sync anchor after the hidden period; skipping it broke
            // re-show geometry on device.
            this.pushSafeAreaInsets();
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
      // Round 102: the stale-entry cleanup (round 88) now runs at the TOP of
      // onWindowStageCreate, BEFORE the boot-time mode sync publishes this
      // window's own entry - clearing here would delete that fresh entry.
      // Round 92: seed the available-area cache the sync judgments consume.
      this.refreshAvailAreaCache();
      // Round 89: watch for layout-override changes (renderer writes them
      // without any window geometry event) and for fullscreen-likeness
      // transitions; hides/shows the system bars for the desktop layout.
      if (this.barWatchTimer === -1) {
        this.barWatchTimer = setInterval(() => {
          this.refreshAvailAreaCache();
          this.applySystemBarVisibility();
        }, 1000);
      }
      if (deviceInfo.deviceType === 'tablet') {
        // Publish the initial real insets once the window geometry exists;
        // avoidAreaChange keeps them fresh afterwards.
        this.pushSafeAreaInsets();
        // Round 102: touch-only RE-ASSERT, not a second decision. The form
        // factor and the rect correction are applied before loadContent now,
        // and forceFullscreenWindow() is idempotent (an already display-sized
        // rect is skipped, the window form factor is guarded out), so this is
        // only the safety net for a pre-show resize the WMS rejected
        // (1300002 / MoveToAsync layout timeout).
        if (!this.pcModeEnabled) {
          this.forceFullscreenWindow();
        }
      }
      // hide title bar
      // Round 102: in the WINDOW form factor the system caption is decided by
      // pushSafeAreaInsets() alone (it re-shows the caption for free windows
      // and publishes decor='system'). It used to run at the END of this
      // callback, so it was the last writer; the form-factor block now runs
      // before loadContent, and letting this call hide the caption afterwards
      // would leave a window-mode window with neither the system strip nor
      // Obsidian's own .titlebar. Touch mode has no caption anyway - keep it.
      if (!this.pcModeEnabled) {
        try {
          mainWin.setWindowDecorVisible(!this.hideTitleBar);
          this.decorVisibleLast = !this.hideTitleBar;
        } catch (exception) {
          LogUtil.warn(TAG, 'Failed to set window decor visible: ' + JSON.stringify(exception));
        }
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
        });
      } catch (exception) {
        LogUtil.error(TAG, 'Failed to register window title button change callback: ' + JSON.stringify(exception));
      }

      if (deviceInfo.sdkApiVersion >= 15) {
        this.nativeContext.RegisterWindowEventFilter(mainWin.getWindowProperties().id);
      }

      // Round 102: the pc-mode observer + boot-time sync moved OUT of this
      // callback - see the block right after the device diagnostic in
      // onWindowStageCreate. They must run BEFORE loadContent, otherwise a
      // startup action can execute against an unresolved form factor (the
      // window-mode force-fullscreen bug this round fixes). H15 (2in1 joins
      // the observer, only the tablet runs the boot read) is unchanged and
      // documented there.
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

  onDestroy(): void {
    // Round 106: safety net for terminations that never reach
    // onWindowStageDestroy (abnormal teardown, stateless windows). Removing
    // twice is a no-op; leaving a dead instance in the broadcast registry is
    // not.
    WebAbility.removeLiveInstance(this);
    // Keep the super chain intact (subclasses call super.onDestroy()).
    super.onDestroy();
  }

  onWindowStageDestroy() {
    // Round 106: the settings observer is PROCESS-global now (registered once,
    // broadcasts to every live window). A closing window only leaves the
    // registry; the observer itself is unregistered when the LAST window of
    // the process goes away. The old per-window unregister killed the observer
    // for the windows that were still alive (device log: window 811 destroyed
    // at 09.087 -> the surviving window stopped receiving PC-mode switches).
    WebAbility.removeLiveInstance(this);
    // A2: a pending reconciliation must not fire against a dead window.
    if (this.viewportRecheckTimer !== -1) {
      clearTimeout(this.viewportRecheckTimer);
      this.viewportRecheckTimer = -1;
    }
    // Round 153: same for the single-shot fullscreen retry.
    if (this.fullscreenRetryTimer !== -1) {
      clearTimeout(this.fullscreenRetryTimer);
      this.fullscreenRetryTimer = -1;
    }
    // Round 89: stop the bar watcher; if this window hid the system bars,
    // hand them back before the window dies.
    if (this.barWatchTimer !== -1) {
      clearInterval(this.barWatchTimer);
      this.barWatchTimer = -1;
    }
    if (this.barsHidden && this.mainWindow !== undefined) {
      try {
        this.mainWindow.setWindowSystemBarEnable(['status', 'navigation'])
          .catch((err: BusinessError) => {
            LogUtil.warn(TAG, 'restore system bars on destroy failed: ' + JSON.stringify(err));
          });
        this.barsHidden = false;
        this.barsPending = false;
      } catch (exception) {
        LogUtil.warn(TAG, 'restore system bars on destroy threw: ' + JSON.stringify(exception));
      }
    }
    // B2: drop this window's geometry entry so closed windows stop answering
    // the renderer's size-match with stale insets.
    this.removeWindowGeometryEntry();
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
      // S4: log parameter KEYS only - want.parameters carries the shared
      // content's locations (and sometimes query strings with tokens); a
      // full JSON.stringify put all of it into the hilog buffer.
      LogUtil.info(TAG, 'onNewWant begin, want: ' +
        'bundleName: ' + JSON.stringify(want.bundleName) +
        ', abilityName: ' + JSON.stringify(want.abilityName) +
        ', deviceId: ' + JSON.stringify(want.deviceId) +
        ', uri not null: ' + JSON.stringify(uriNotNull) +
        ', type: ' + JSON.stringify(want.type) +
        ', flags: ' + JSON.stringify(want.flags) +
        ', action: ' + JSON.stringify(want.action) +
        ', parameterKeys: ' + (want.parameters ? Object.keys(want.parameters).join(',') : 'undefined') +
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
  // parameter heuristics (STANDARD share keys only, file:// URIs only).
  private ingestSharedWant(want: Want, directUris: Array<string>): void {
    if (directUris.length > 0) {
      const sandboxBase: string = this.ownSandboxBase();
      let accepted: Array<string> = [];
      for (let i = 0; i < directUris.length; i++) {
        if (WebAbility.isAcceptableSharedUri(directUris[i], sandboxBase)) {
          accepted.push(directUris[i]);
        } else {
          LogUtil.warn(TAG, 'share uri rejected (own sandbox): index=' + i);
        }
      }
      if (accepted.length > 0) {
        let text = WebAbility.wantSharedText(want);
        Inject.getOrCreate(DragDropAdapter).ingestExternalContent('', accepted, text, '');
      }
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
    const sandboxBase: string = this.ownSandboxBase();
    let uris = WebAbility.wantSharedFileUris(want, sandboxBase);
    let text = WebAbility.wantSharedText(want);
    if (uris.length > 0 || text.length > 0) {
      Inject.getOrCreate(DragDropAdapter).ingestExternalContent('', uris, text, '');
    }
  }

  // The mount root of THIS app's own sandbox (filesDir minus its /files
  // leaf). Anything under it is our private data - readable by us no matter
  // who sends the want, so a sender-supplied URI pointing here can only be
  // a private-file exfil attempt, never legitimate share content.
  private ownSandboxBase(): string {
    try {
      const filesDir: string = this.context.getApplicationContext().filesDir;
      const idx: number = filesDir.lastIndexOf('/files');
      return idx > 0 ? filesDir.substring(0, idx) : filesDir;
    } catch (e) {
      return '';
    }
  }

  // S1: URI acceptance gate for SENDER-controlled values (want.uri and the
  // standard parameter keys). Rules:
  //  1. Only the file:// scheme - raw /data/... or /storage/... paths have
  //     no permission concept behind them, and every path OUR process can
  //     access includes our own sandbox (the exfil vector).
  //  2. Plain-path file URIs (file:///...) resolve inside OUR mount
  //     namespace; reject those under our own sandbox base (and the generic
  //     /data/storage/ sandbox mount). Cross-app grants arrive in the
  //     authority form (file://<bundle>/data/storage/...), which passes.
  // Share Kit getSharedData records are system-mediated and skip this gate.
  private static isAcceptableSharedUri(value: string, sandboxBase: string): boolean {
    if (!value) {
      return false;
    }
    const uri = value.trim();
    if (!uri.startsWith('file://')) {
      return false;
    }
    const path: string = uri.substring('file://'.length);
    if (uri.startsWith('file:///')) {
      if (path.startsWith('/data/storage/')) {
        return false;
      }
      if (sandboxBase && (path === sandboxBase || path.startsWith(sandboxBase + '/'))) {
        return false;
      }
    }
    return true;
  }

  private static isShareKitWant(want: Want): boolean {
    if (!want) {
      return false;
    }
    let action = want.action;
    return action === wantConstant.Action.ACTION_SEND_DATA
      || action === wantConstant.Action.ACTION_SEND_MULTIPLE_DATA;
  }

  // Standard share-parameter keys only (S1): the previous last-resort scan
  // over EVERY parameter accepted any path-shaped value a sender chose,
  // which - combined with the readability passthrough in DragParamManager -
  // turned an arbitrary parameter into a private-file exfil channel
  // (any app: "share" a want with our sandbox path hidden in a parameter;
  // the user picks OHSidian; the file lands in the vault and syncs out).
  private static wantSharedFileUris(want: Want, sandboxBase: string): Array<string> {
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
          if (typeof list[j] === 'string' &&
            WebAbility.isAcceptableSharedUri(list[j] as string, sandboxBase)) {
            uris.push(list[j] as string);
          }
        }
        if (uris.length > 0) {
          return uris;
        }
      } else if (typeof value === 'string' &&
        WebAbility.isAcceptableSharedUri(value as string, sandboxBase)) {
        uris.push(value as string);
        return uris;
      }
    }
    return uris;
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
    // S5: scheme whitelist. The entry skill matches ANY uri with the
    // viewData action, so a malicious app can hand us arbitrary uri shapes;
    // only web URLs are meaningful as a new browser window here. Everything
    // else (javascript:, data:, unknown schemes) is dropped instead of being
    // navigated to inside the app's web content.
    const colon: number = open_url.indexOf(':');
    const scheme: string = colon > 0 ? open_url.substring(0, colon).toLowerCase() : '';
    if (scheme !== 'http' && scheme !== 'https') {
      LogUtil.warn(TAG, 'openNewWindow rejected non-http(s) uri, scheme=' + scheme);
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
      this.publishModeFileAtomic(filePath, cfg);
      // Log without the query string: OAuth callbacks may carry tokens/codes.
      const queryIndex = uri.indexOf('?');
      const logSafe = queryIndex > 0 ? uri.substring(0, queryIndex) + '?…' : uri;
      LogUtil.info(TAG, 'protocol uri queued: ' + logSafe);
    } catch (err) {
      LogUtil.error(TAG, 'failed to write protocol uri file: ' + JSON.stringify(err));
    }
  }

  // Resolves the WINDOW FORM FACTOR from the system PC-mode switch WITHOUT any
  // side effect (round 102; docs/window-state-machine.md §2). It must run
  // before the first geometry / layout action of a window, because the field
  // default (false = touch) is not a valid answer: the boot-time read used to
  // sit at the END of the loadContent callback, so the startup geometry block
  // consumed the default and a WINDOW-mode cold start executed the touch-only
  // corrections (setWindowLayoutFullScreen(true) + forceFullscreenWindow()).
  // The engine's remembered-bounds setBounds then had to undo them - the
  // visible "window flashes full-size, then returns to the remembered size".
  // Phone has no window form (always touch); 2in1 deliberately skips the boot
  // read (H15) and keeps the historical desktop behavior.
  // A failed read keeps the WINDOW form: NOT touching the rect is the
  // non-destructive default. If the value really is "false", the later
  // boot-time sync sees modeChanged (true -> false) and applies the touch
  // correction there, so a transient settings failure self-heals.
  private resolvePcModeAtBoot(): boolean {
    if (deviceInfo.deviceType !== 'tablet') {
      return false;
    }
    try {
      const value: string = settings.getValueSync(this.context,
        'window_pcmode_switch_status', 'false', settings.domainName.USER_PROPERTY);
      return value === 'true';
    } catch (exception) {
      LogUtil.warn(TAG, 'boot pc-mode read failed, keep window form: ' + JSON.stringify(exception));
      return true;
    }
  }

  private updateWindowPcmodeSwitchStatus(context: Context) {
    try {
      // Round 102: a failed read must NOT skip the apply step (the startup
      // sync is the single application point for the rect/layout corrections,
      // so swallowing the error here would leave a touch-mode window
      // uncorrected). Fall back to the already-resolved form factor - the
      // observer path then degenerates to a cheap no-op re-assert.
      let value: string = this.pcModeEnabled ? 'true' : 'false';
      try {
        value = settings.getValueSync(context, 'window_pcmode_switch_status', 'false',
          settings.domainName.USER_PROPERTY);
      } catch (readException) {
        LogUtil.warn(TAG, 'pcmode read failed, keeping resolved form factor: ' +
          JSON.stringify(readException));
      }
      LogUtil.info(TAG, 'update window_pcmode_switch_status, ' +
        'new status:' + value + ',xcomponentId:' + this.xcomponentId);
      let newStatus: boolean = false;
      if (value === 'true') {
        newStatus = true;
      }
      const modeChanged: boolean = this.pcModeEnabled !== newStatus;
      const firstSync: boolean = !this.pcModeObserved;
      this.pcModeEnabled = newStatus;
      this.pcModeObserved = true;
      // Cheap, idempotent state re-assert: kept on EVERY fire (round-94
      // self-audit) - if the engine was not ready at the boot-time first
      // sync it still picks the mode up here; only the expensive IO and
      // window side effects below are skipped for unchanged values.
      this.nativeContext.UpdateWindowPcmodeSwitchStatusCB(newStatus);
      if (!modeChanged && !firstSync) {
        // H4/H21: an observer fire with an UNCHANGED value used to re-run
        // the whole side-effect set (mode-file write, layout fullscreen,
        // inset publish, clamp/force resize). Everything is already
        // consistent - skip and leave a device-log trace.
        LogUtil.info(TAG, 'pc mode unchanged (' + newStatus + '), side effects skipped');
        return;
      }
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
  // drag hot zone). Called on mode switches AND once during startup before
  // loadContent (round 102, docs/window-state-machine.md §2) - it is the
  // SINGLE entry point for this flag, so an unresolved form factor can never
  // switch a window-mode window into the touch regime.
  // 2in1 is deliberately NOT handled here (deviceType gate below, H15): the
  // system default flag is left untouched, exactly as before round 102.
  private applyLayoutFullscreenForMode(): void {
    if (!this.mainWindow) {
      return;
    }
    if (deviceInfo.deviceType !== 'tablet' && deviceInfo.deviceType !== 'phone') {
      return;
    }
    const want: boolean = !this.pcModeEnabled;
    // Round 154: dedupe. A cold start requests layout-fullscreen=true twice
    // (boot sync + the loadContent re-assert) - device log 07:39:32.063 and
    // .132 both land as SetLayoutFullScreenByApiVersion status 1. The value
    // is latched only after a successful apply.
    if (this.layoutFullscreenApplied === want) {
      return;
    }
    try {
      this.mainWindow.setWindowLayoutFullScreen(want)
        .then(() => {
          this.layoutFullscreenApplied = want;
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
    // systemMode follows the PC-mode switch on every touch-capable form
    // factor. H9: the phone previously hard-coded 'touch' even with PC mode
    // on (external keyboard/mouse); H15: 2in1 joins so an observer-driven
    // touch-mode switch reaches the renderer. Non-touch types keep 'desktop'.
    let systemMode: string = 'desktop';
    if (deviceInfo.deviceType === 'phone' || deviceInfo.deviceType === 'tablet' ||
      deviceInfo.deviceType === '2in1') {
      systemMode = pcModeEnabled ? 'desktop' : 'touch';
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
      if (cfg['override'] === undefined) {
        cfg['override'] = 'auto';
      }
      // Repeat fires (observer misfire, sibling window) skip the write when
      // nothing moved - one small read, no IO storm on the shared file.
      if (cfg['systemMode'] === systemMode) {
        return;
      }
      cfg['systemMode'] = systemMode;
      this.publishModeFileAtomic(filePath, cfg);
      LogUtil.info(TAG, 'touch mode file updated: systemMode=' + systemMode +
        ', override=' + (cfg['override'] as string) +
        ', deviceType=' + deviceInfo.deviceType + ', pcMode=' + pcModeEnabled);
    } catch (err) {
      LogUtil.error(TAG, 'failed to write touch mode file: ' + JSON.stringify(err));
    }
  }
};
