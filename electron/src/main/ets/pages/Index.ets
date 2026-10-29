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

import { WebWindow, BackPressBridge, NativeVideoOverlay, NativeVideoTheme } from 'web_engine';
import { StylusAdapter, StylusKind, PenSampleTap } from 'web_engine';
import { PdfInkWriter, PdfInkRequest, PdfInkResult, PdfInkStroke, PdfPreviewProbeResult, PdfPreviewResult } from 'web_engine';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { KeyCode } from '@kit.InputKit';
import { fileIo } from '@kit.CoreFileKit';
import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { taskpool } from '@kit.ArkTS';
import { media } from '@kit.MediaKit';
import { image } from '@kit.ImageKit';
import { window } from '@kit.ArkUI';
import { vibrator } from '@kit.SensorServiceKit';
import CustomChildProcess from '../process/CustomChildProcess';

// Round 105: how long the renderer gets to answer a back gesture with its
// verdict (it polls the mode file every 200ms) before we retry once and then
// give up. Giving up means "keep the app open": a missed verdict must never
// close the app, a stale one must never fire.
const BACK_EXIT_CHECK_MS: number = 350;
const BACK_EXIT_RETRIES: number = 1;
 
interface IStyleData {
  backgroundColor: string,
  opacity: number
};

interface NativeVideoRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface NativeVideoRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface NativeVideoRequest {
  seq: number;
  ts: number;
  action: string;
  windowId: string;
  xcomponentId: string;
  path: string;
  thumbFile: string;
  // Renderer -> ArkTS: where the native PDF page preview PNG should be written.
  out?: string;
  rect: NativeVideoRect | null;
  region: NativeVideoRegion | null;
  dpr: number;
  theme: NativeVideoTheme | null;
  // Close attribution written by the renderer tracker (keyboard / focus /
  // occluded / offscreen / detached / writefail / noack). Diagnostic only.
  reason?: string;
  // True when the renderer reports a fine pointer (mouse/trackpad). Drives the
  // compact 34vp transport instead of the 48vp touch one.
  pointer?: boolean;
  // 1 = desktop/window mode, 0 = touch fullscreen, -1/undefined = unknown.
  // Every rect carries it, so ArkTS can hide the surface the moment the mode
  // flips instead of waiting for a size change it may not observe.
  mode?: number;
  // Loopback handshake fields (not part of a media request).
  hello?: number;
  token?: string;
  event?: string;
  // Developer diagnostics from the renderer ink layer. One line per key UI
  // transition (toolbar, nib, surface mount, gesture) so a HiLog capture can
  // answer "did the click reach the patch?" without a remote debugger.
  detail?: string;
  // Renderer ink tool state: "pen" (pen/highlighter/eraser) or "pointer".
  // ArkTS uses it to block finger/palm hit-testing while a pen tool is active.
  tool?: string;
  // --- handwriting bridge (docs/STYLUS-PEN.md §6.4) ---
  // Renderer -> ArkTS: enable/disable the pressure side-channel.
  on?: boolean;
  // ArkTS -> renderer: batched pen samples, [x, y, pressure01, tiltX, tiltY, ageMs].
  pts?: Array<Array<number>>;
  phase?: string;
  w?: number;
  h?: number;
  // Renderer -> ArkTS: PDF ink write-back.
  rel?: string;
  vaultRoot?: string;
  page?: number;
  strokes?: Array<PdfInkStroke>;
  // "vector" (PDF points) or "normalized" (0..1 page coords, pdfdom).
  inkMode?: string;
  // "ink" (standard /Ink) or "polyline" (/PolyLine compatibility).
  inkStyle?: string;
  // Replace our previous annotations on that page (erase/delete/undo sync).
  replace?: boolean;
  removeIds?: Array<string>;
  // ArkTS -> renderer: write-back result.
  bytes?: number;
  error?: string;
  backup?: string;
}

// BUG-005 liveness budget. The renderer refreshes the overlay request on every
// geometry change and, while the geometry is stable, once per ~1.2s (theme
// heartbeat in touch-mode.js). 6s is therefore "several missed beats", which
// cannot happen while the page is alive, and is short enough that the user
// never sits with a swallowed tap for long.
const NATIVE_IDLE_CLOSE_MS: number = 6000;

const DEFAULT_NATIVE_VIDEO_THEME: NativeVideoTheme = {
  bg: '#1e1e1e',
  panel: '#252525',
  bar: '#eb1e1e1e',
  interactive: '#363636',
  accent: '#8b7cf6',
  onAccent: '#ffffff',
  text: '#e8e8e8',
  muted: '#b9b9b9',
  faint: '#8a8a8a',
  border: '#4a4168',
  error: '#ff6b6b',
  radiusS: 4,
  radiusM: 8,
  radiusL: 12
};

interface IUpdateStyle {
  registerUpdateStyleFunction: Function,
  removeUpdateStyleFunction: Function
};

CustomChildProcess.toString();
let storage = LocalStorage.getShared();
/**
 * PDFKit load/save is synchronous and can take hundreds of ms on a large PDF.
 * Running it on the UI thread froze the canvas after every auto-write; keep the
 * whole copy/annotate/save sequence in a taskpool worker instead.
 */
@Concurrent
function pdfInkWriteTask(req: PdfInkRequest): PdfInkResult {
  return PdfInkWriter.write(req);
}

interface PdfPreviewProbeArgs {
  path: string;
  page: number;
}

@Concurrent
function pdfPreviewProbeTask(args: PdfPreviewProbeArgs): PdfPreviewProbeResult {
  return PdfInkWriter.probePagePixelMap(args.path, args.page);
}

interface PdfPreviewArgs {
  path: string;
  page: number;
  width: number;
  height: number;
  out: string;
}

@Concurrent
async function pdfPreviewTask(args: PdfPreviewArgs): Promise<PdfPreviewResult> {
  return await PdfInkWriter.renderPreview(args.path, args.page, args.width, args.height, args.out);
}

interface PdfInkRestoreArgs {
  path: string;
  backup: string;
  cacheDir: string;
}

@Concurrent
function pdfInkRestoreTask(args: PdfInkRestoreArgs): PdfInkResult {
  return PdfInkWriter.restore(args.path, args.backup, args.cacheDir);
}

@Entry(storage)
@Component
struct Index {
  @LocalStorageLink('updateStyle') updateStyle: IUpdateStyle = {
    registerUpdateStyleFunction: (id: string, initStyle: IStyleData, func: (style: IStyleData) => void) => {},
    removeUpdateStyleFunction: (id: string) => {}
  };
  @LocalStorageLink('xcomponentId') xcomponentId: string = '';
  @LocalStorageLink('originWindowId') originWindowId: number = -1;
  // B route: one inline native overlay. The renderer writes
  // <userData>/ohsidian-native-video.json when the user chooses the native
  // player for a broken <video>; this page polls it and stacks an AVPlayer
  // surface on top of the existing WebWindow.
  @State private nativeRequest: NativeVideoRequest | null = null;
  // Density of the transport. Kept as its own state so a `rect` heartbeat that
  // carries a changed `pointer` (mouse appeared / left) re-renders the overlay;
  // mutating the stored request object would not.
  // Mode switches (touch <-> window) move the window before the page relayouts.
  // The player keeps running but the surface is hidden until a fresh rect from
  // the renderer proves the new layout; otherwise the old frame stays painted
  // at the old coordinates for a few frames.
  private nativeWin: window.Window | null = null;
  private nativeBarsHidden: boolean = false;
  private nativePc: number = -1;
  // CSS px are NOT vp on every window: Chromium derives CSS px from dpr while
  // ArkUI lays out in vp, and the window density can differ from dpr (measured
  // with the 100vp ruler). Every rect is converted with the CURRENT density at
  // request time, so an in-place mode switch cannot leave a stale factor.
  private nativeDpr: number = 2;
  // @State, not a plain field: it is passed to the overlay as @Prop unitScale,
  // and ArkUI only re-syncs a @Prop from an OBSERVED parent variable. As a plain
  // field the child could keep its initial 1 and render the whole transport at
  // 1vp = 1CSS - the "controls are still too small" report.
  @State private nativeCssToVp: number = 1;
  // The <video> rect width in CSS px, untransformed. The overlay divides its own
  // measured box (vp) by this to get the real CSS->vp factor, so the transport
  // can never be sized with a stale or missing multiplier again.
  @State private nativeCssW: number = 0;
  @State private nativeFullscreen: boolean = false;
  @State private nativeLeft: number = 0;
  @State private nativeTop: number = 0;
  @State private nativeW: number = 0;
  @State private nativeH: number = 0;
  @State private nativeRegionLeft: number = 0;
  @State private nativeRegionTop: number = 0;
  @State private nativeRegionW: number = 0;
  @State private nativeRegionH: number = 0;
  @State private nativeTheme: NativeVideoTheme = DEFAULT_NATIVE_VIDEO_THEME;
  private nativeTimer: number = -1;
  private lastNativeSeq: number = 0;
  // IPC replaces the 40ms mode-file poll while a renderer is connected. The
  // TCP server listens on loopback and the port is published per
  // xcomponentId; the renderer reads it once and keeps one socket open.
  private nativeServer: socket.TCPSocketServer | null = null;
  private nativeClient: socket.TCPSocketConnection | null = null;
  private nativeBuffer: string = '';
  private nativePort: number = 0;
  private nativeToken: string = '';
  private nativeAuthorized: boolean = false;
  private nativeIpcPrimed: boolean = false;
  private nativeThumbBusy: boolean = false;
  private nativeIpcWarned: boolean = false;
  private disposed: boolean = false;
  // BUG-005: the renderer owns the overlay's lifetime (it sends 'close' on IME,
  // modal, off-screen), but it cannot send ANYTHING once its page reloads,
  // crashes, or simply stops producing frames (rAF pauses while the document is
  // hidden). The overlay is a sibling of the web content with
  // HitTestMode.Default, so a stale one swallows every tap inside its frame -
  // the "mobile toolbar stopped responding" report. Two cheap liveness rules
  // close that hole:
  //   * no accepted request for NATIVE_IDLE_CLOSE_MS -> the renderer is gone;
  //   * the IME rises -> the toolbar owns that strip. The renderer's own
  //     "--keyboard-height > 0" check depends on a CSS variable fed by a push
  //     that is known to lag or miss (TODO.md #8), so the system callback is
  //     the reliable signal and must not be routed through the renderer.
  private nativeLastActivity: number = 0;
  private nativeWatchdog: number = -1;
  // --- handwriting bridge state (docs/STYLUS-PEN.md) ---------------------
  // Pressure samples are only produced while the renderer asks for them; the
  // renderer turns the channel on after it has proved that the engine drops
  // pressure (gate G2/G3 in the plan). Idle pages pay nothing.
  private penSamplesWanted: boolean = false;
  private penId: number = -1;
  private penPending: Array<Array<number>> = [];
  private penFlushTimer: number = -1;
  private penPhase: string = 'move';
  private penSampleSent: number = 0;
  private penProbeLogged: number = 0;
  private penOwnerXid: string = '';
  private stylusForwarded: number = 0;
  // While a pen is writing (and briefly after), finger hit-testing is blocked
  // before it reaches the XComponent. This keeps palm/finger swipes out of the
  // web content: Obsidian never sees them, so it cannot open side panels or
  // fire edge gestures. Pen events still pass through untouched.
  private penGuardUntil: number = 0;
  // True while the renderer has a pen/highlighter/eraser tool selected. In
  // this mode finger/palm contacts are blocked at hit-test time so they never
  // reach Obsidian's own swipe handlers.
  private inkPenMode: boolean = false;
  // PDF ink commands are sequenced independently from the video overlay.
  private lastPdfSeq: number = 0;
  private lastPdfRestoreSeq: number = 0;
  private pdfInkBusy: boolean = false;

  private initStyle: IStyleData = {
    backgroundColor: 'ffffffff',
    opacity: 1
  };

  @State private backgroundColor_: string = `#${this.initStyle.backgroundColor}`;
  @State private opacity_: number = this.initStyle.opacity;

  aboutToAppear() {
    this.disposed = false;
    // registerUpdateStyleFunction
    this.updateStyle.registerUpdateStyleFunction(this.xcomponentId, this.initStyle, (style: IStyleData) => {
      this.backgroundColor_ = `#${style.backgroundColor}`;
      this.opacity_ = style.opacity;
    });
    this.nativeTimer = setInterval(() => this.pollNativeRequest(), 200);
    this.nativeWatchdog = setInterval(() => this.sweepNativeOverlay(), 1000);
    this.attachNativeWindow();
    this.startNativeIpc();
    // @LocalStorageLink('xcomponentId') can still be empty when aboutToAppear
    // runs on a cold start (the Web child assigns it a moment later). The old
    // code returned early and never retried, which left the renderer without a
    // port file: no handwriting IPC, no ink logs, no write-back.
    if (this.nativeServer === null) {
      let ipcTries: number = 0;
      const ipcTimer: number = setInterval(() => {
        ipcTries++;
        if (this.nativeServer !== null || this.disposed || ipcTries > 40) {
          clearInterval(ipcTimer);
          return;
        }
        this.startNativeIpc();
      }, 500);
    }
    // Pen Kit's stylusInteraction service is process-wide; every page registers
    // a sender so the gesture lands in the window that has focus.
    try {
      StylusAdapter.register(this.xcomponentId, (kind: StylusKind, ts: number) => {
        this.onStylusGesture(kind, ts);
      });
      StylusAdapter.ensure();
    } catch (e) {
      console.warn('StylusIpc', 'register failed: ' + JSON.stringify(e));
    }
  }

  aboutToDisappear() {
    this.disposed = true;
    // Never leave the system status bar hidden if the page dies mid-fullscreen.
    this.applySystemBars(false);
    this.stopNativeIpc();
    try {
      StylusAdapter.unregister(this.xcomponentId);
    } catch (e) {
    }
    if (this.penFlushTimer >= 0) {
      clearTimeout(this.penFlushTimer);
      this.penFlushTimer = -1;
    }
    this.penPending = [];
    if (this.nativeTimer >= 0) {
      clearInterval(this.nativeTimer);
      this.nativeTimer = -1;
    }
    if (this.nativeWatchdog >= 0) {
      clearInterval(this.nativeWatchdog);
      this.nativeWatchdog = -1;
    }
    if (this.backTimer >= 0) {
      clearTimeout(this.backTimer);
      this.backTimer = -1;
    }
    // removeUpdateStyleFunction
    this.updateStyle.removeUpdateStyleFunction(this.xcomponentId);
  }

  private pollNativeRequest(): void {
    if (this.disposed) {
      return;
    }
    try {
      const dir: string = getContext(this).getApplicationContext().filesDir;
      const reqPath: string = dir + '/ohsidian-native-video.json';
      if (!fileIo.accessSync(reqPath)) {
        return;
      }
      const text: string = fileIo.readTextSync(reqPath);
      const req: NativeVideoRequest = JSON.parse(text) as NativeVideoRequest;
      this.acceptNativeRequest(req);
    } catch (e) {
      // The file may be mid-rename or absent; the next poll retries.
    }
  }

  private acceptNativeRequest(req: NativeVideoRequest): void {
    try {
      if (!req || typeof req.seq !== 'number' || !(req.seq > 0) ||
        req.seq <= this.lastNativeSeq || req.seq > Date.now() + 5000) {
        // Silent rejections used to be indistinguishable from "the renderer
        // never sent anything" - say which one it is.
        console.info('NativeVideoIpc', 'rejected seq=' + (req ? req.seq : 'null') +
          ' last=' + this.lastNativeSeq + ' action=' + (req ? req.action : '?'));
        return;
      }
      // The request file is shared by every Electron window. Accept only the
      // window that actually owns the <video>; otherwise the overlay would
      // "migrate" into whichever Index happens to poll first. xcomponentId is
      // the ArkUI identity; windowId is the OHOS id and is the fallback for
      // mode files written before the xcomponentId field existed.
      const reqXid: string = req.xcomponentId ? req.xcomponentId : '';
      if (!reqXid && !req.windowId) {
        // An identity-less request can only be attributed to "whichever page
        // polls first"; reject it instead of showing a black overlay in the
        // wrong window. The renderer keeps the HTML fallback because no ack
        // is written.
        return;
      }
      if (reqXid && this.xcomponentId) {
        if (reqXid !== this.xcomponentId) {
          console.info('NativeVideoIpc', 'rejected identity req=' + reqXid +
            ' mine=' + this.xcomponentId);
          return;
        }
      } else if (req.windowId && this.originWindowId > 0) {
        if (req.windowId !== ('' + this.originWindowId)) {
          return;
        }
      }
      this.lastNativeSeq = req.seq;
      // Stale request from a previous process must not resurrect the overlay
      // on boot.
      if (typeof req.ts === 'number' && req.ts > 0 && Date.now() - req.ts > 15000) {
        return;
      }
      // Liveness: any accepted request (open / rect / thumb) proves the renderer
      // is still alive and still driving this overlay.
      this.nativeLastActivity = Date.now();
      const action: string = req.action ? req.action : 'open';
      if (action === 'thumb') {
        if (req.path && req.thumbFile) {
          this.generateNativeThumb(req.path, req.thumbFile);
        }
        return;
      }
      if (action === 'close') {
        // The renderer closes the surface on IME rise / modal / off-screen.
        // Log the reason so a device log attributes a disappearance to the
        // exact guard instead of "the video closed by itself".
        this.nativeRequest = null;
        this.nativeFullscreen = false;
        this.nativePc = -1;
        this.applySystemBars(false);
        console.info('NativeVideoIpc', 'close accepted reason=' + (req.reason ? req.reason : 'none'));
        return;
      }
      if (action === 'rect') {
        // Rect-only update: keep the same NativeVideoOverlay instance/player.
        // Bounds update directly; if the XComponent area changes (fullscreen or
        // window resize), the overlay debounces 320ms and rebuilds the surface
        // while preserving currentTime/play state.
        // Mode changes are detected from the request itself: a touch<->window
        // switch may keep the same window size briefly, so windowSizeChange is
        // not enough. A flip CLOSES the player (see closeForModeSwitch): keeping
        // a surface alive across a density+viewport change never converged.
        const pcMode: number = typeof req.mode === 'number' ? req.mode : -1;
        if (pcMode === 0 || pcMode === 1) {
          const flipped: boolean = this.nativePc !== -1 && this.nativePc !== pcMode;
          this.nativePc = pcMode;
          if (flipped && this.nativeRequest !== null) {
            // Touch <-> window switches the window density AND the CSS viewport
            // at once. Keeping an AVPlayer surface alive across that produced a
            // chain of races (hide/reveal timing, surface rebuild, stale
            // geometry) that never converged. Closing is deterministic: the page
            // restores its own poster, and one tap re-opens with the geometry of
            // the mode the user is now in.
            this.closeForModeSwitch();
            return;
          }
        }
        // A mode switch hides the surface (keep decoding); the first rect
        // produced after the relayout settles is what reveals it again.
        if (this.nativeRequest !== null && !this.nativeFullscreen) {
          this.moveNativeRect(req);
        } else if (this.nativeRequest !== null) {
          // Fullscreen: the surface fills the window, but the INLINE geometry is
          // still recorded - otherwise leaving fullscreen painted the last
          // pre-fullscreen box until the next heartbeat.
          this.applyNativeTheme(req);
          this.moveNativeRect(req);
        }
        return;
      }
      if (action !== 'open') {
        return;
      }
      if (!req.path || !req.rect || !(req.rect.width > 0) || !(req.rect.height > 0)) {
        console.info('NativeVideoIpc', 'rejected open: path=' + (req.path ? 'ok' : 'empty') +
          ' rect=' + JSON.stringify(req.rect));
        return;
      }
      this.nativeRequest = req;
      // A fresh `open` carries a complete rect, so there is nothing left to wait
      // for: clear a hide left over from a mode switch instead of letting the
      // safety net be the only thing that brings the surface back (that was the
      // "opening a video sometimes starts black" report).
      if (typeof req.mode === 'number' && (req.mode === 0 || req.mode === 1)) {
        this.nativePc = req.mode;
      }
      this.applyNativeRect(req);
      this.writeNativeOpenedAck(req);
      this.writeNativeOpenedAckShared(req);
      if (req.thumbFile && req.thumbFile.length > 0) {
        if (this.nativeThumbBusy) {
          // A thumb request from the click path is still running; retry after
          // it settles so a transient AVImageGenerator failure does not leave
          // a permanently black preview.
          setTimeout(() => {
            this.generateNativeThumb(req.path, req.thumbFile);
          }, 600);
        } else {
          this.generateNativeThumb(req.path, req.thumbFile);
        }
      }
    } catch (e) {
      // A malformed IPC line or a torn file line must not kill the receiver.
    }
  }

  private async generateNativeThumb(srcPath: string, dstPath: string): Promise<void> {
    if (this.nativeThumbBusy) {
      return;
    }
    this.nativeThumbBusy = true;
    let f: fileIo.File | null = null;
    let generator: media.AVImageGenerator | null = null;
    let pixelMap: image.PixelMap | null = null;
    let packer: image.ImagePacker | null = null;
    try {
      const dir: string = getContext(this).getApplicationContext().filesDir;
      if (dstPath.indexOf(dir + '/') !== 0 ||
        dstPath.indexOf('/../') !== -1 || dstPath.endsWith('/..') ||
        !fileIo.accessSync(srcPath)) {
        return;
      }
      if (fileIo.accessSync(dstPath) && fileIo.statSync(dstPath).size > 0) {
        return;
      }
      f = fileIo.openSync(srcPath, fileIo.OpenMode.READ_ONLY);
      const size: number = fileIo.statSync(srcPath).size;
      generator = await media.createAVImageGenerator();
      generator.fdSrc = { fd: f.fd, offset: 0, length: size };
      // 1s in; HEVC keyframe is normally available and gives a representative
      // frame instead of a black 0s frame. Very short clips fall back to 0us.
      try {
        pixelMap = await generator.fetchFrameByTime(1000000,
          media.AVImageQueryOptions.AV_IMAGE_QUERY_CLOSEST, { width: 480, height: 270 });
      } catch (e1) {
        pixelMap = await generator.fetchFrameByTime(0,
          media.AVImageQueryOptions.AV_IMAGE_QUERY_CLOSEST, { width: 480, height: 270 });
      }
      packer = image.createImagePacker();
      let data: ArrayBuffer;
      try {
        data = await packer.packing(pixelMap, { format: 'image/jpeg', quality: 82 });
      } catch (eJpeg) {
        // PackingOption.quality is REQUIRED by the SDK (it is ignored for PNG,
        // which is lossless); without it the overload does not resolve.
        data = await packer.packing(pixelMap, { format: 'image/png', quality: 100 });
      }
      // Write a temp file and rename it: the renderer polls for this path and
      // must never read a half-written JPEG.
      const tmpPath: string = dstPath + '.tmp';
      const out: fileIo.File = fileIo.openSync(tmpPath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        // fileIo.writeSync expects an ArrayBuffer (or string), not a
        // Uint8Array: the latter fails with 13900020 "Illegal write buffer".
        fileIo.writeSync(out.fd, data);
      } finally {
        fileIo.closeSync(out);
      }
      try {
        fileIo.renameSync(tmpPath, dstPath);
      } catch (eRename) {
        if (fileIo.accessSync(dstPath)) {
          fileIo.unlinkSync(dstPath);
        }
        fileIo.renameSync(tmpPath, dstPath);
      }
      console.info('NativeVideoIpc', 'thumb written: ' + dstPath);
    } catch (e) {
      console.warn('NativeVideoIpc', 'thumb failed: ' + JSON.stringify(e));
    } finally {
      try {
        if (packer !== null) {
          packer.release();
        }
      } catch (e) {
      }
      try {
        if (pixelMap !== null) {
          pixelMap.release();
        }
      } catch (e) {
      }
      try {
        if (generator !== null) {
          generator.release();
        }
      } catch (e) {
      }
      try {
        if (f !== null) {
          fileIo.closeSync(f);
        }
      } catch (e) {
      }
      this.nativeThumbBusy = false;
    }
  }

  private startNativeIpc(): void {
    if (this.nativeServer !== null) {
      return;
    }
    if (!this.xcomponentId) {
      if (!this.nativeIpcWarned) {
        this.nativeIpcWarned = true;
        console.warn('NativeVideoIpc', 'waiting for xcomponentId');
      }
      return;
    }
    try {
      this.nativeToken = util.generateRandomUUID();
      const server: socket.TCPSocketServer = socket.constructTCPSocketServerInstance();
      server.on('connect', (conn: socket.TCPSocketConnection) => {
        this.nativeClient = conn;
        this.nativeBuffer = '';
        this.nativeAuthorized = false;
        this.nativeIpcPrimed = false;
        conn.on('message', (info: socket.SocketMessageInfo) => {
          try {
            const decoder: util.TextDecoder = util.TextDecoder.create('utf-8');
            const text: string = decoder.decodeWithStream(new Uint8Array(info.message));
            this.consumeNativeIpc(text);
          } catch (e) {
            console.warn('NativeVideoIpc', 'decode failed: ' + JSON.stringify(e));
          }
        });
        conn.on('close', () => {
          this.nativeClient = null;
          this.nativeBuffer = '';
          this.nativeAuthorized = false;
          this.nativeIpcPrimed = false;
          if (!this.disposed) {
            this.startFilePolling();
          }
        });
        conn.on('error', (err: Error) => {
          console.warn('NativeVideoIpc', 'client error: ' + JSON.stringify(err));
        });
      });
      server.on('error', (err: Error) => {
        console.warn('NativeVideoIpc', 'server error: ' + JSON.stringify(err));
      });
      server.listen({ address: '127.0.0.1', port: 0, family: 1 }).then(() => {
        return server.getLocalAddress();
      }).then((addr) => {
        const port: number = addr.port ? addr.port : 0;
        if (port <= 0) {
          throw new Error('empty local port');
        }
        this.nativePort = port;
        this.writeNativePortFile(port);
        console.info('NativeVideoIpc', 'listening on ' + port);
      }).catch((err: Error) => {
        console.warn('NativeVideoIpc', 'listen failed: ' + JSON.stringify(err));
        this.nativeServer = null;
      });
      this.nativeServer = server;
    } catch (e) {
      console.warn('NativeVideoIpc', 'construct failed: ' + JSON.stringify(e));
    }
  }

  private consumeNativeIpc(text: string): void {
    this.nativeBuffer += text;
    if (this.nativeBuffer.length > 1048576) {
      this.nativeBuffer = '';
      return;
    }
    let idx: number = this.nativeBuffer.indexOf('\n');
    while (idx >= 0) {
      const line: string = this.nativeBuffer.substring(0, idx).trim();
      this.nativeBuffer = this.nativeBuffer.substring(idx + 1);
      if (line.length > 0) {
        try {
          const msg: NativeVideoRequest = JSON.parse(line) as NativeVideoRequest;
          if (!this.nativeAuthorized) {
            // The port file is per-window and carries a random token; a local
            // process that only scans loopback ports cannot inject requests.
            if (msg.hello === 1 && msg.token === this.nativeToken) {
              this.nativeAuthorized = true;
              // A renderer restart starts in pointer/hand mode until it says
              // otherwise; do not inherit a stale pen lock.
              this.inkPenMode = false;
              // Tell the ink layer what the process can actually do; it shows
              // this in diagnostics instead of guessing. Repeated on request
              // because a fast boot can send this before the listener exists.
              this.sendStylusInfo();
              if (!this.nativeIpcPrimed) {
                // The renderer may have opened via the file fallback before
                // the socket connected; prime one read before stopping it.
                this.nativeIpcPrimed = true;
                this.pollNativeRequest();
              }
              this.stopFilePolling();
            }
          } else {
            // Control messages are not media requests: they carry no seq and
            // no rect, and must not disturb the overlay state machine.
            if (msg.action === 'penSamplesOn') {
              this.setPenSamplesWanted(msg.on === true);
            } else if (msg.action === 'stylusInfo') {
              this.sendStylusInfo();
            } else if (msg.action === 'inkLog') {
              const inkEvent: string = msg.event === undefined ? '' : msg.event;
              const inkDetail: string = msg.detail === undefined ? '' : msg.detail;
              console.info('InkUI', inkEvent + ' ' + inkDetail);
            } else if (msg.action === 'inkTool') {
              this.inkPenMode = msg.tool === 'pen';
              console.info('InkUI', 'nativeTool ' + (this.inkPenMode ? 'pen' : 'hand'));
            } else if (msg.action === 'pdfInk') {
              this.handlePdfInk(msg);
            } else if (msg.action === 'pdfPreviewProbe') {
              this.handlePdfPreviewProbe(msg);
            } else if (msg.action === 'pdfPreview') {
              this.handlePdfPreview(msg);
            } else if (msg.action === 'pdfInkRestore') {
              this.handlePdfRestore(msg);
            } else {
              this.acceptNativeRequest(msg);
            }
          }
        } catch (e) {
          // Ignore one malformed line; the next line is still valid.
        }
      }
      idx = this.nativeBuffer.indexOf('\n');
    }
  }

  // ===== handwriting bridge ==============================================
  // Everything below is transport: Pen Kit gestures become one IPC line, and
  // ArkUI pen samples become batched IPC lines for the renderer's pressure
  // merge. No ink is rendered here in P1; that lives in the renderer patch.

  /**
   * A double-tap / squeeze belongs to the focused window. The renderer checks
   * document.hasFocus() again, because window focus and DOM focus can disagree
   * for a moment during a mode switch.
   */
  private onStylusGesture(kind: StylusKind, ts: number): void {
    if (this.disposed) {
      return;
    }
    let focused: boolean = true;
    try {
      if (this.nativeWin !== null) {
        focused = this.nativeWin.isFocused();
      }
    } catch (e) {
      focused = true;
    }
    if (!focused) {
      console.info('StylusIpc', 'drop ' + kind + ' (window not focused)');
      return;
    }
    this.stylusForwarded++;
    this.vibrateTick();
    this.sendNativeLine(JSON.stringify({
      event: 'stylus',
      kind: kind,
      ts: ts,
      xcomponentId: this.xcomponentId
    }));
  }

  /** Short tick so a barrel double-tap is felt, not guessed. */
  private vibrateTick(): void {
    try {
      const effect: vibrator.VibrateTime = { type: 'time', duration: 12 };
      const attribute: vibrator.VibrateAttribute = { id: 0, usage: 'unknown' };
      vibrator.startVibration(effect, attribute).catch((err: BusinessError) => {
        // A tablet without a motor rejects this; never let it bubble.
        console.info('StylusIpc', 'vibrate skipped: ' + err.code);
      });
    } catch (e) {
    }
  }

  private sendNativeLine(json: string): void {
    const conn: socket.TCPSocketConnection | null = this.nativeClient;
    if (conn === null || !this.nativeAuthorized) {
      return;
    }
    try {
      conn.send({ data: json + '\n' }).catch((err: Error) => {
        console.warn('StylusIpc', 'send failed: ' + JSON.stringify(err));
      });
    } catch (e) {
      console.warn('StylusIpc', 'send threw: ' + JSON.stringify(e));
    }
  }

  /** Capability snapshot for the ink layer's diagnostics (also on demand). */
  private sendStylusInfo(): void {
    this.sendNativeLine(JSON.stringify({
      event: 'stylusInfo',
      supported: StylusAdapter.isSupported(),
      subscribed: StylusAdapter.isSubscribed(),
      error: StylusAdapter.errorText(),
      pdf: PdfInkWriter.available()
    }));
  }

  /**
   * ArkUI-level pen/finger arbitration. Hit testing happens before the event
   * reaches the XComponent; returning Block for finger contacts while the pen
   * guard is active is the only reliable way to keep palm swipes out of the
   * web content (DOM preventDefault runs too late).
   */
  private onPageTouchIntercept(event: TouchEvent): HitTestMode {
    if (this.disposed) {
      return HitTestMode.Default;
    }
    try {
      if (event.sourceTool === SourceTool.Pen ||
        event.sourceTool === SourceTool.MOUSE ||
        event.sourceTool === SourceTool.TOUCHPAD) {
        return HitTestMode.Default;
      }
      if (Date.now() < this.penGuardUntil) {
        // The pen is hovering or writing right now: all finger/palm contacts
        // are rejected so a resting hand cannot scroll or open panels.
        return HitTestMode.Block;
      }
      // Finger, palm, or an unknown contact: allow normal taps but reject a
      // palm-sized contact. Unknown is used by some devices for palms.
      const palmLimit: number = this.inkPenMode ? 34 : 44;
      const list = event.touches;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const tw: number | undefined = list[i].width;
          const th: number | undefined = list[i].height;
          if ((tw !== undefined && tw > palmLimit) ||
            (th !== undefined && th > palmLimit)) {
            return HitTestMode.Block;
          }
        }
      }
    } catch (e) {
    }
    return HitTestMode.Default;
  }

  /**
   * Stylus hover is the earliest signal that a pen is over the screen. Use it
   * to arm the guard before the pen touches down, so a palm already resting on
   * the glass cannot start a finger swipe first.
   */
  private onPageHover(isHover: boolean, event: HoverEvent): void {
    try {
      if (isHover && event.sourceTool === SourceTool.Pen) {
        this.penGuardUntil = Date.now() + 1200;
      }
    } catch (e) {
    }
  }

  /**
   * The page-level tap that feeds the renderer's pressure side-channel. It is
   * deliberately attached to the web content's parent: touch events bubble, so
   * this sees every pen sample without taking any input away from the engine.
   */
  private onPageTouch(event: TouchEvent): void {
    if (this.disposed || event.sourceTool !== SourceTool.Pen) {
      return;
    }
    // Extend the pen guard on down/move/up; finger contacts during this window
    // are blocked in onPageTouchIntercept before the web engine sees them.
    this.penGuardUntil = Date.now() + 1200;
    if (event.type === TouchType.Down) {
      this.penId = PenSampleTap.penIdOf(event);
      this.penPhase = 'down';
      // Tells the renderer "the input you are about to receive is a pen" even
      // when the engine reports it as mouse/touch (gate G3 in the plan).
      this.sendNativeLine(JSON.stringify({ event: 'penActive', active: true }));
    } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
      if (this.penId < 0) {
        this.penId = PenSampleTap.penIdOf(event);
      }
      this.penPhase = 'up';
      this.sendNativeLine(JSON.stringify({ event: 'penActive', active: false }));
    } else if (this.penPhase === 'down') {
      this.penPhase = 'move';
    }
    if (this.penId < 0) {
      return;
    }
    // Probe: five lines per stroke prove that the page sees pen events at all.
    // This is the ArkTS half of docs/STYLUS-PEN.md appendix A.
    this.penProbeLogged++;
    if (this.penProbeLogged <= 5 || this.penProbeLogged % 200 === 0) {
      console.info('PenProbe', JSON.stringify({
        t: event.type,
        src: event.sourceTool,
        p: event.pressure,
        touches: event.touches.length,
        penId: this.penId,
        samplesWanted: this.penSamplesWanted
      }));
    }
    if (this.penSamplesWanted) {
      const added: number = PenSampleTap.collect(event, this.penId, this.penPending);
      if (added > 0) {
        // Samples are already in this component's vp coordinates. On this
        // engine 1 CSS px == 1 vp (docs/STYLUS-PEN.md §7.2); the renderer
        // treats a zero w/h as "no scaling" and applies a calibrated offset.
        this.schedulePenFlush();
      }
    }
    if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
      // The flush clears penId; if sampling is off there is nothing to flush.
      if (!this.penSamplesWanted) {
        this.penId = -1;
      }
    }
  }

  private schedulePenFlush(): void {
    if (this.penFlushTimer >= 0) {
      return;
    }
    this.penFlushTimer = setTimeout(() => {
      this.penFlushTimer = -1;
      this.flushPenSamples();
    }, 8);
  }

  private flushPenSamples(): void {
    if (this.penPending.length === 0) {
      if (this.penPhase === 'up') {
        this.penPhase = 'move';
        this.penId = -1;
      }
      return;
    }
    const pts: Array<Array<number>> = this.penPending;
    const phase: string = this.penPhase;
    this.penPending = [];
    this.penSampleSent += pts.length;
    if (phase === 'up') {
      this.penPhase = 'move';
      this.penId = -1;
    }
    if (!this.nativeAuthorized) {
      return;
    }
    this.sendNativeLine(JSON.stringify({
      event: 'penSamples',
      phase: phase,
      n: this.penSampleSent,
      pts: pts
    }));
  }

  private setPenSamplesWanted(on: boolean): void {
    if (this.penSamplesWanted === on) {
      return;
    }
    this.penSamplesWanted = on;
    this.penPending = [];
    this.penId = -1;
    if (this.penFlushTimer >= 0) {
      clearTimeout(this.penFlushTimer);
      this.penFlushTimer = -1;
    }
    console.info('StylusIpc', 'pen samples ' + (on ? 'on' : 'off') + ' xid=' + this.xcomponentId);
  }

  /**
   * PDF ink write-back (P2). Implemented in PdfInkWriter; this method only
   * sequences the request and guarantees a response so the renderer's promise
   * cannot hang.
   */
  private handlePdfInk(req: NativeVideoRequest): void {
    const seq: number = typeof req.seq === 'number' ? req.seq : 0;
    if (!(seq > this.lastPdfSeq)) {
      return;
    }
    this.lastPdfSeq = seq;
    const reply = (result: PdfInkResult): void => {
      this.sendNativeLine(JSON.stringify({
        event: 'pdfInkResult',
        seq: seq,
        ok: result.ok,
        bytes: result.bytes,
        error: result.error,
        backup: result.backup
      }));
    };
    try {
      if (!PdfInkWriter.available()) {
        reply({ ok: false, bytes: 0, error: 'PDF Kit 不可用', backup: '' });
        return;
      }
      if (this.pdfInkBusy) {
        reply({ ok: false, bytes: 0, error: 'PDF 写入忙，请稍后', backup: '' });
        return;
      }
      const path: string = req.path ? req.path : '';
      const root: string = req.vaultRoot ? req.vaultRoot : '';
      const rel: string = req.rel ? req.rel : '';
      const strokes: Array<PdfInkStroke> = req.strokes ? req.strokes : [];
      const page: number = typeof req.page === 'number' ? req.page : -1;
      const replace: boolean = req.replace === true;
      if (!path || !root || !rel || page < 0 || (!replace && strokes.length === 0)) {
        reply({ ok: false, bytes: 0, error: '请求参数不完整', backup: '' });
        return;
      }
      // The renderer is trusted, but a wrong rel/path pair must not be able to
      // write outside the vault: reject traversal and mismatched roots.
      const rootPrefix: string = root.endsWith('/') ? root : (root + '/');
      if (rel.indexOf('..') >= 0 || rel.startsWith('/') ||
        (path !== root && path.indexOf(rootPrefix) !== 0)) {
        reply({ ok: false, bytes: 0, error: '路径不在仓库内', backup: '' });
        return;
      }
      const ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      const backupDir: string = root + '/.obsidian/ohsidian-ink/backups';
      const pdfReq: PdfInkRequest = {
        src: path,
        page: page,
        strokes: strokes,
        cacheDir: ctx.cacheDir,
        backupDir: backupDir,
        mode: req.inkMode ? req.inkMode : 'vector',
        inkStyle: req.inkStyle === 'polyline' ? 'polyline' : 'ink',
        replace: req.replace === true,
        removeIds: req.removeIds ? req.removeIds : []
      };
      this.pdfInkBusy = true;
      const writeT0: number = Date.now();
      taskpool.execute(pdfInkWriteTask, pdfReq).then((out: Object) => {
        this.pdfInkBusy = false;
        const result: PdfInkResult = out as PdfInkResult;
        console.info('PdfInk', 'page=' + page + ' strokes=' + strokes.length +
          ' style=' + (pdfReq.inkStyle ? pdfReq.inkStyle : 'ink') +
          ' ms=' + (Date.now() - writeT0) +
          ' ok=' + result.ok + (result.error ? ' err=' + result.error : ''));
        reply(result);
      }).catch((e: Error) => {
        this.pdfInkBusy = false;
        console.warn('PdfInk', 'taskpool failed, falling back to UI thread: ' + JSON.stringify(e));
        try {
          const result: PdfInkResult = PdfInkWriter.write(pdfReq);
          reply(result);
        } catch (e2) {
          reply({ ok: false, bytes: 0, error: '写入失败：' + e.message, backup: '' });
        }
      });
    } catch (e) {
      this.pdfInkBusy = false;
      console.warn('PdfInk', 'write failed: ' + JSON.stringify(e));
      reply({ ok: false, bytes: 0, error: '写入异常：' + JSON.stringify(e), backup: '' });
    }
  }

  private handlePdfPreviewProbe(req: NativeVideoRequest): void {
    const seq: number = typeof req.seq === 'number' ? req.seq : 0;
    const path: string = req.path ? req.path : '';
    const page: number = typeof req.page === 'number' ? req.page : 0;
    const reply = (result: PdfPreviewProbeResult): void => {
      this.sendNativeLine(JSON.stringify({
        event: 'pdfPreviewProbeResult',
        seq: seq,
        ok: result.ok,
        ms: result.ms,
        w: result.w,
        h: result.h,
        error: result.error
      }));
    };
    if (!path) {
      reply({ ok: false, ms: 0, w: 0, h: 0, error: 'no path' });
      return;
    }
    taskpool.execute(pdfPreviewProbeTask, { path: path, page: page }).then((out: Object) => {
      reply(out as PdfPreviewProbeResult);
    }).catch((e: Error) => {
      reply({ ok: false, ms: 0, w: 0, h: 0, error: 'task:' + e.message });
    });
  }

  private handlePdfPreview(req: NativeVideoRequest): void {
    const seq: number = typeof req.seq === 'number' ? req.seq : 0;
    const path: string = req.path ? req.path : '';
    const out: string = req.out ? req.out : '';
    const page: number = typeof req.page === 'number' ? req.page : 0;
    const w: number = typeof req.w === 'number' ? req.w : 0;
    const h: number = typeof req.h === 'number' ? req.h : 0;
    const reply = (result: PdfPreviewResult): void => {
      this.sendNativeLine(JSON.stringify({
        event: 'pdfPreviewResult',
        seq: seq,
        ok: result.ok,
        ms: result.ms,
        bytes: result.bytes,
        w: result.w,
        h: result.h,
        error: result.error
      }));
    };
    if (!path || !out || w <= 0 || h <= 0) {
      reply({ ok: false, ms: 0, bytes: 0, w: 0, h: 0, error: 'bad request' });
      return;
    }
    const args: PdfPreviewArgs = { path: path, page: page, width: w, height: h, out: out };
    taskpool.execute(pdfPreviewTask, args).then((o: Object) => {
      reply(o as PdfPreviewResult);
    }).catch((e: Error) => {
      reply({ ok: false, ms: 0, bytes: 0, w: 0, h: 0, error: 'task:' + e.message });
    });
  }

  private handlePdfRestore(req: NativeVideoRequest): void {
    const seq: number = typeof req.seq === 'number' ? req.seq : 0;
    if (!(seq > this.lastPdfRestoreSeq)) {
      return;
    }
    this.lastPdfRestoreSeq = seq;
    const reply = (result: PdfInkResult): void => {
      this.sendNativeLine(JSON.stringify({
        event: 'pdfInkResult',
        seq: seq,
        ok: result.ok,
        bytes: result.bytes,
        error: result.error,
        backup: result.backup
      }));
    };
    try {
      if (this.pdfInkBusy) {
        reply({ ok: false, bytes: 0, error: 'PDF 写入进行中，请稍后再恢复', backup: '' });
        return;
      }
      const path: string = req.path ? req.path : '';
      const root: string = req.vaultRoot ? req.vaultRoot : '';
      const rel: string = req.rel ? req.rel : '';
      const rootPrefix: string = root.endsWith('/') ? root : (root + '/');
      if (!path || !root || !rel || rel.indexOf('..') >= 0 || rel.startsWith('/') ||
        (path !== root && path.indexOf(rootPrefix) !== 0)) {
        reply({ ok: false, bytes: 0, error: '恢复路径无效', backup: '' });
        return;
      }
      const ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      const backupDir: string = root + '/.obsidian/ohsidian-ink/backups';
      const backup: string = PdfInkWriter.findBackup(path, backupDir);
      const args: PdfInkRestoreArgs = {
        path: path,
        backup: backup,
        cacheDir: ctx.cacheDir
      };
      this.pdfInkBusy = true;
      taskpool.execute(pdfInkRestoreTask, args).then((out: Object) => {
        this.pdfInkBusy = false;
        const result: PdfInkResult = out as PdfInkResult;
        console.info('PdfInk', 'restore ok=' + result.ok + (result.error ? ' err=' + result.error : ''));
        reply(result);
      }).catch((e: Error) => {
        // Worker unavailable: restore is only a copy, do it synchronously as a
        // last resort rather than leaving the user without a recovery path.
        console.warn('PdfInk', 'restore taskpool failed: ' + JSON.stringify(e));
        try {
          const result: PdfInkResult = PdfInkWriter.restore(path, backup, ctx.cacheDir);
          this.pdfInkBusy = false;
          reply(result);
        } catch (e2) {
          this.pdfInkBusy = false;
          reply({ ok: false, bytes: 0, error: '恢复异常：' + e.message, backup: '' });
        }
      });
    } catch (e) {
      this.pdfInkBusy = false;
      reply({ ok: false, bytes: 0, error: '恢复异常：' + JSON.stringify(e), backup: '' });
    }
  }

  private nativePortFile(): string {
    const dir: string = getContext(this).getApplicationContext().filesDir;
    const safe: string = this.xcomponentId.replace(/[^A-Za-z0-9_.-]/g, '_');
    return dir + '/ohsidian-native-port-' + safe + '.json';
  }

  private writeNativePortFile(port: number): void {
    try {
      const target: string = this.nativePortFile();
      const tmp: string = target + '.tmp';
      const f: fileIo.File = fileIo.openSync(tmp,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(f.fd, JSON.stringify({
          port: port,
          xcomponentId: this.xcomponentId,
          token: this.nativeToken
        }));
      } finally {
        fileIo.closeSync(f);
      }
      try {
        fileIo.renameSync(tmp, target);
      } catch (e) {
        fileIo.unlinkSync(target);
        fileIo.renameSync(tmp, target);
      }
    } catch (e) {
      console.warn('NativeVideoIpc', 'write port file failed: ' + JSON.stringify(e));
    }
  }

  private stopFilePolling(): void {
    if (this.nativeTimer >= 0) {
      clearInterval(this.nativeTimer);
      this.nativeTimer = -1;
    }
  }

  private startFilePolling(): void {
    if (this.disposed) {
      return;
    }
    if (this.nativeTimer < 0) {
      this.nativeTimer = setInterval(() => this.pollNativeRequest(), 200);
    }
  }

  private stopNativeIpc(): void {
    try {
      if (this.nativeClient !== null) {
        this.nativeClient.close();
      }
    } catch (e) {
    }
    this.nativeClient = null;
    try {
      if (this.nativeServer !== null) {
        this.nativeServer.close();
      }
    } catch (e) {
    }
    this.nativeServer = null;
    try {
      const target: string = this.nativePortFile();
      if (fileIo.accessSync(target)) {
        fileIo.unlinkSync(target);
      }
    } catch (e) {
    }
  }

  private nativeThemeEquals(a: NativeVideoTheme, b: NativeVideoTheme): boolean {
    return a.bg === b.bg && a.panel === b.panel && a.bar === b.bar &&
      a.interactive === b.interactive && a.accent === b.accent &&
      a.onAccent === b.onAccent && a.text === b.text && a.muted === b.muted &&
      a.faint === b.faint && a.border === b.border && a.error === b.error &&
      a.radiusS === b.radiusS && a.radiusM === b.radiusM && a.radiusL === b.radiusL;
  }

  private applyNativeTheme(req: NativeVideoRequest): void {
    const t: NativeVideoTheme | null = req.theme;
    if (t === null || t === undefined) {
      return;
    }
    // Older/partial renderers may omit fields. Merge instead of replacing the
    // whole object with undefined colors/radii.
    const merged: NativeVideoTheme = {
      bg: t.bg ? t.bg : this.nativeTheme.bg,
      panel: t.panel ? t.panel : this.nativeTheme.panel,
      bar: t.bar ? t.bar : this.nativeTheme.bar,
      interactive: t.interactive ? t.interactive : this.nativeTheme.interactive,
      accent: t.accent ? t.accent : this.nativeTheme.accent,
      onAccent: t.onAccent ? t.onAccent : this.nativeTheme.onAccent,
      text: t.text ? t.text : this.nativeTheme.text,
      muted: t.muted ? t.muted : this.nativeTheme.muted,
      faint: t.faint ? t.faint : this.nativeTheme.faint,
      border: t.border ? t.border : this.nativeTheme.border,
      error: t.error ? t.error : this.nativeTheme.error,
      radiusS: typeof t.radiusS === 'number' ? t.radiusS : this.nativeTheme.radiusS,
      radiusM: typeof t.radiusM === 'number' ? t.radiusM : this.nativeTheme.radiusM,
      radiusL: typeof t.radiusL === 'number' ? t.radiusL : this.nativeTheme.radiusL
    };
    if (!this.nativeThemeEquals(this.nativeTheme, merged)) {
      this.nativeTheme = merged;
    }
  }

  private cssToVp(): number {
    // px2vp(1) is "vp per px" for the current UI context, recomputed per call so
    // an in-place mode switch cannot leave a stale CSS->vp factor.
    let vpPerPx: number = 1;
    try {
      vpPerPx = px2vp(1);
    } catch (e) {
      vpPerPx = 1;
    }
    const dpr: number = this.nativeDpr > 0 ? this.nativeDpr : 1;
    return dpr * vpPerPx;
  }

  private applyNativeRect(req: NativeVideoRequest): void {
    if (req.rect === null) {
      return;
    }
    this.applyNativeTheme(req);
    // 1 CSS px in the renderer is exactly 1 vp here: Chromium derives CSS px
    // from the window density, which is the same ratio ArkUI calls vp. The
    // old `px2vp(cssPx * dpr)` round-trip only cancelled out while the
    // renderer's devicePixelRatio happened to equal the current window
    // density. After an in-place mode switch (window mode -> fullscreen touch
    // mode) one of the two updates first, the product is off by that ratio and
    // the surface lands at the wrong size and offset until the next layout.
    // Using the CSS rect directly is unit-correct in both windows.
    this.nativeDpr = req.dpr && req.dpr > 0 ? req.dpr : this.nativeDpr;
    const k: number = this.cssToVp();
    this.nativeCssToVp = k;
    this.nativeLeft = req.rect.left * k;
    this.nativeTop = req.rect.top * k;
    this.nativeCssW = req.rect.width;
    this.nativeW = req.rect.width * k;
    this.nativeH = req.rect.height * k;
    const region: NativeVideoRegion | null = req.region;
    if (region !== null && region !== undefined && region.width > 0 && region.height > 0) {
      this.nativeRegionLeft = region.left * k;
      this.nativeRegionTop = region.top * k;
      this.nativeRegionW = region.width * k;
      this.nativeRegionH = region.height * k;
    } else {
      this.nativeRegionLeft = this.nativeLeft;
      this.nativeRegionTop = this.nativeTop;
      this.nativeRegionW = this.nativeW;
      this.nativeRegionH = this.nativeH;
    }
  }

  // Second, identity-agnostic ack. The per-identity filename can disagree
  // between ArkTS (keys on xcomponentId) and the renderer (falls back to
  // win-<windowId> when it has none), which produced an endless
  // "close reason=noack" loop while the surface was actually playing.
  // This copy carries BOTH identities inside the JSON, so the renderer can
  // match on whichever field it has.
  private writeNativeOpenedAckShared(req: NativeVideoRequest): void {
    const target: string = getContext(this).getApplicationContext().filesDir +
      '/ohsidian-native-opened.json';
    const tmp: string = target + '.tmp-' + Date.now() + '-' + Math.random().toString(36).substring(2);
    try {
      const f: fileIo.File = fileIo.openSync(tmp,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(f.fd, JSON.stringify({
          seq: req.seq,
          ts: Date.now(),
          windowId: this.originWindowId,
          xcomponentId: this.xcomponentId
        }));
      } finally {
        fileIo.closeSync(f);
      }
      try {
        fileIo.renameSync(tmp, target);
      } catch (eRename) {
        if (fileIo.accessSync(target)) {
          fileIo.unlinkSync(target);
        }
        fileIo.renameSync(tmp, target);
      }
    } catch (eFile) {
      console.warn('NativeVideoIpc', 'shared ack write failed: ' + JSON.stringify(eFile));
    }
  }

  private writeNativeOpenedAck(req: NativeVideoRequest): void {
    const idKey: string = this.xcomponentId ? this.xcomponentId : ('win-' + this.originWindowId);
    const safe: string = idKey.replace(/[^A-Za-z0-9_.-]/g, '_');
    const target: string = getContext(this).getApplicationContext().filesDir +
      '/ohsidian-native-opened-' + safe + '.json';
    const tmp: string = target + '.tmp-' + Date.now() + '-' + Math.random().toString(36).substring(2);
    try {
      const f: fileIo.File = fileIo.openSync(tmp,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(f.fd, JSON.stringify({
          seq: req.seq,
          ts: Date.now(),
          windowId: this.originWindowId,
          xcomponentId: this.xcomponentId
        }));
      } finally {
        fileIo.closeSync(f);
      }
      try {
        fileIo.renameSync(tmp, target);
      } catch (eRename) {
        if (fileIo.accessSync(target)) {
          fileIo.unlinkSync(target);
        }
        fileIo.renameSync(tmp, target);
      }
    } catch (eFile) {
      console.warn('NativeVideoIpc', 'open ack write failed: ' + JSON.stringify(eFile));
    }
    const conn: socket.TCPSocketConnection | null = this.nativeClient;
    if (conn !== null && this.nativeAuthorized) {
      try {
        conn.send({
          data: JSON.stringify({
            event: 'opened',
            seq: req.seq,
            xcomponentId: this.xcomponentId
          }) + '\n'
        }).catch((err: Error) => {
          console.warn('NativeVideoIpc', 'open ack send failed: ' + JSON.stringify(err));
        });
      } catch (eSend) {
        console.warn('NativeVideoIpc', 'open ack send failed: ' + JSON.stringify(eSend));
      }
    }
  }

  private moveNativeRect(req: NativeVideoRequest): void {
    if (req.rect === null) {
      return;
    }
    this.applyNativeTheme(req);
    // Rect-only update: keep the same NativeVideoOverlay instance/player.
    // Bounds update directly; if the XComponent area changes (fullscreen or
    // window resize), the overlay debounces 320ms and rebuilds the surface
    // while preserving currentTime/play state. Units: see applyNativeRect —
    // CSS px already are vp, no dpr round-trip.
    this.nativeDpr = req.dpr && req.dpr > 0 ? req.dpr : this.nativeDpr;
    const k: number = this.cssToVp();
    this.nativeCssToVp = k;
    this.nativeLeft = req.rect.left * k;
    this.nativeTop = req.rect.top * k;
    this.nativeCssW = req.rect.width;
    this.nativeW = req.rect.width * k;
    this.nativeH = req.rect.height * k;
    const region: NativeVideoRegion | null = req.region;
    if (region !== null && region !== undefined && region.width > 0 && region.height > 0) {
      this.nativeRegionLeft = region.left * k;
      this.nativeRegionTop = region.top * k;
      this.nativeRegionW = region.width * k;
      this.nativeRegionH = region.height * k;
    } else {
      this.nativeRegionLeft = this.nativeLeft;
      this.nativeRegionTop = this.nativeTop;
      this.nativeRegionW = this.nativeW;
      this.nativeRegionH = this.nativeH;
    }
  }

  private nativeRegionX(): number {
    return this.nativeRegionLeft;
  }

  private nativeRegionY(): number {
    return this.nativeRegionTop;
  }

  private nativeRegionWidth(): number {
    return this.nativeRegionW;
  }

  private nativeRegionHeight(): number {
    return this.nativeRegionH;
  }

  private nativeX(): number {
    return this.nativeLeft;
  }

  private nativeY(): number {
    return this.nativeTop;
  }

  private nativeWidth(): number {
    return this.nativeW;
  }

  private nativeHeight(): number {
    return this.nativeH;
  }

  // Visible slice of the video: the intersection of the <video> rect and the
  // content region (top guard .. bottom chrome). The clipping frame is sized
  // to this intersection instead of the whole region, because the frame is a
  // sibling of the WebWindow and its hit-test mode decides whether the page
  // below also receives the touch. A region-sized frame would either block the
  // whole note (Default) or let taps pass through the video (Transparent).
  private nativeClipX(): number {
    return Math.max(this.nativeLeft, this.nativeRegionLeft);
  }

  private nativeClipY(): number {
    return Math.max(this.nativeTop, this.nativeRegionTop);
  }

  private nativeClipW(): number {
    const right: number = Math.min(this.nativeLeft + this.nativeW,
      this.nativeRegionLeft + this.nativeRegionW);
    return Math.max(0, right - this.nativeClipX());
  }

  private nativeClipH(): number {
    const bottom: number = Math.min(this.nativeTop + this.nativeH,
      this.nativeRegionTop + this.nativeRegionH);
    return Math.max(0, bottom - this.nativeClipY());
  }

  // Back gesture (round 96): consumed instead of the default Ability
  // teardown (removeMissionAfterTerminate made one side-swipe close the
  // window). Published to the renderer through the mode file; the 500ms
  // debounce absorbs the multi-fire of one gesture (device-verified in
  // the Vitreus project: one quick swipe never fires twice).
  private lastBackMs: number = 0;
  // Round 105: pending verdict timer for the gesture published last.
  private backTimer: number = -1;

  private notifyNativeClosed(): void {
    const conn: socket.TCPSocketConnection | null = this.nativeClient;
    if (conn !== null && this.nativeAuthorized) {
      try {
        conn.send({ data: JSON.stringify({ event: 'close' }) + '\n' }).catch((err: Error) => {
          console.warn('NativeVideoIpc', 'close event send failed: ' + JSON.stringify(err));
        });
      } catch (e) {
        console.warn('NativeVideoIpc', 'close event send failed: ' + JSON.stringify(e));
      }
    }
    // File fallback: the renderer polls this marker when IPC is unavailable so
    // the HTML <video>/preview/controls are restored after a native close.
    try {
      const dir: string = getContext(this).getApplicationContext().filesDir;
      const target: string = dir + '/ohsidian-native-closed.json';
      const tmp: string = target + '.tmp-' + Date.now() + '-' + Math.random().toString(36).substring(2);
      const f: fileIo.File = fileIo.openSync(tmp,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(f.fd, JSON.stringify({
          ts: Date.now(),
          windowId: this.originWindowId,
          xcomponentId: this.xcomponentId
        }));
      } finally {
        fileIo.closeSync(f);
      }
      try {
        fileIo.renameSync(tmp, target);
      } catch (eRename) {
        if (fileIo.accessSync(target)) {
          fileIo.unlinkSync(target);
        }
        fileIo.renameSync(tmp, target);
      }
    } catch (eFile) {
    }
  }

  onBackPress(): boolean {
    if (this.nativeRequest !== null) {
      if (this.nativeFullscreen) {
        this.nativeFullscreen = false;
        this.applySystemBars(false);
        return true;
      }
      this.nativeRequest = null;
      this.applySystemBars(false);
      this.notifyNativeClosed();
      return true;
    }
    const now: number = Date.now();
    if (now - this.lastBackMs < 500) {
      return true;
    }
    this.lastBackMs = now;
    let seq: number = 0;
    try {
      seq = BackPressBridge.notify(getContext(this).getApplicationContext().filesDir, this.xcomponentId);
    } catch (e) {
      // publish failure must not propagate - the gesture stays consumed
    }
    if (seq > 0) {
      this.armExitCheck(seq);
    }
    return true;
  }

  // Round 105: wait for the renderer's verdict on this gesture. Nothing
  // consumed while in touch mode means we are at the root (no overlay, no
  // drawer, no tab switcher, no leaf history) - the user expects back to
  // exit, which is the platform default we replaced in round 96 because it
  // fired too early (before the renderer processed the same gesture).
  private armExitCheck(seq: number): void {
    if (this.backTimer >= 0) {
      clearTimeout(this.backTimer);
    }
    this.backTimer = setTimeout(() => {
      this.backTimer = -1;
      this.checkBackExit(seq, 0);
    }, BACK_EXIT_CHECK_MS);
  }

  private checkBackExit(seq: number, attempt: number): void {
    let decision: number = -1;
    try {
      const filesDir: string = getContext(this).getApplicationContext().filesDir;
      // 1 = exit, 0 = stay (consumed, or desktop mode), -1 = no verdict yet.
      decision = BackPressBridge.shouldExit(filesDir, seq);
    } catch (e) {
      decision = -1;
    }
    if (decision < 0) {
      if (attempt < BACK_EXIT_RETRIES) {
        this.backTimer = setTimeout(() => {
          this.backTimer = -1;
          this.checkBackExit(seq, attempt + 1);
        }, BACK_EXIT_CHECK_MS);
      }
      return;
    }
    if (decision === 0) {
      // Consumed by the app, or desktop/PC mode where back never closes the
      // session from here.
      return;
    }
    try {
      const context = getContext(this) as common.UIAbilityContext;
      context.terminateSelf().catch((err: BusinessError) => {
        console.error('OHSidian back exit: terminateSelf failed: ' + JSON.stringify(err));
      });
    } catch (e) {
      console.error('OHSidian back exit failed: ' + JSON.stringify(e));
    }
  }

  // One window listener for the page's lifetime: a size change means a mode
  // switch / rotation, and the page's CSS layout follows a frame or two later.
  private async attachNativeWindow(): Promise<void> {
    try {
      const win: window.Window = await window.getLastWindow(getContext(this));
      this.nativeWin = win;
      // BUG-005: the reliable "the IME is up" signal. The renderer closes the
      // native surface when its own --keyboard-height says so, but that value is
      // a CSS variable fed by a push that is known to lag or miss (TODO.md #8).
      // When it misses, the overlay frame keeps the pre-keyboard geometry and
      // the raised formatting toolbar sits inside it - every tap on the toolbar
      // is then eaten by HitTestMode.Default. Close from the system callback
      // instead of trusting the variable.
      try {
        win.on('keyboardHeightChange', (height: number) => {
          if (this.disposed) {
            return;
          }
          if (height > 0 && this.nativeRequest !== null) {
            console.info('NativeVideoIpc', 'closed for IME rise: h=' + height);
            this.dropNativeOverlay();
          }
        });
      } catch (eKb) {
        console.warn('NativeVideoIpc', 'keyboard watch failed: ' + JSON.stringify(eKb));
      }
    } catch (e) {
      console.warn('NativeVideoIpc', 'window watch failed: ' + JSON.stringify(e));
    }
  }

  // BUG-005 watchdog: a renderer that stopped refreshing the request (page
  // reload, crash, or a hidden document where rAF is paused) never sends
  // 'close', so the overlay would stay on top of the web content forever.
  private sweepNativeOverlay(): void {
    if (this.disposed || this.nativeRequest === null) {
      return;
    }
    if (this.nativeLastActivity <= 0) {
      this.nativeLastActivity = Date.now();
      return;
    }
    const idle: number = Date.now() - this.nativeLastActivity;
    if (idle < NATIVE_IDLE_CLOSE_MS) {
      return;
    }
    console.warn('NativeVideoIpc', 'closed by watchdog: idle ' + idle + 'ms');
    this.dropNativeOverlay();
  }

  // Single teardown path for every "the overlay must go" decision.
  private dropNativeOverlay(): void {
    this.nativeRequest = null;
    this.nativeFullscreen = false;
    this.nativePc = -1;
    this.applySystemBars(false);
    this.notifyNativeClosed();
  }

  // Mode switches close the player on purpose - see the call site.
  private closeForModeSwitch(): void {
    if (this.nativeRequest === null) {
      return;
    }
    this.dropNativeOverlay();
    console.info('NativeVideoIpc', 'closed for mode switch (touch<->window)');
  }

  private async applySystemBars(hide: boolean): Promise<void> {
    if (this.nativeBarsHidden === hide) {
      return;
    }
    try {
      const win: window.Window = this.nativeWin !== null ? this.nativeWin :
        await window.getLastWindow(getContext(this));
      this.nativeWin = win;
      // Fullscreen video hides the status bar (clock / notifications) and
      // restores it on exit. The navigation bar stays so the system back
      // gesture keeps working.
      const names: Array<'status' | 'navigation'> = hide ? ['navigation'] : ['status', 'navigation'];
      await win.setWindowSystemBarEnable(names);
      this.nativeBarsHidden = hide;
    } catch (e) {
      console.warn('NativeVideoIpc', 'system bars failed: ' + JSON.stringify(e));
    }
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Row() {
        WebWindow()
      }.onKeyEvent((event?: KeyEvent) => {
        if (event) {
          if (event.type == KeyType.Down && event.keyCode == KeyCode.KEYCODE_ESCAPE) {
            event.stopPropagation();
          }
        }
      })
      // Stylus hover arms the guard before touchdown; finger/palm is blocked
      // during pen activity, while pen/mouse/touchpad pass through.
      .onHover((isHover: boolean, event: HoverEvent) => this.onPageHover(isHover, event))
      .onTouchIntercept((event: TouchEvent) => this.onPageTouchIntercept(event))
      // Bubbling pen samples for the pressure side-channel; the engine keeps
      // full ownership of the input itself (no hit-test change).
      .onTouch((event: TouchEvent) => {
        this.onPageTouch(event);
      })
      .backgroundColor(this.backgroundColor_)
      .opacity(this.opacity_)
      .width('100%')
      .height('100%')

      if (this.nativeRequest !== null) {
        Stack({ alignContent: Alignment.TopStart }) {
          NativeVideoOverlay({
            source: this.nativeRequest ? this.nativeRequest.path : '',
            fullscreen: this.nativeFullscreen,
            theme: this.nativeTheme,
            unitScale: this.nativeCssToVp,
            frameW: this.nativeFullscreen ? 0 : this.nativeWidth(),
            frameH: this.nativeFullscreen ? 0 : this.nativeHeight(),
            cssWidth: this.nativeCssW,
            controlsBottomClip: this.nativeFullscreen ? 0 : Math.max(0,
              this.nativeY() + this.nativeHeight() - (this.nativeRegionY() + this.nativeRegionHeight())),
            onFullscreenChange: (full: boolean) => {
              this.nativeFullscreen = full;
              // Immersive video: hide the status bar (clock/notifications) and
              // restore it on exit, so the system chrome never sits over the
              // player and comes back when the user returns to the note.
              this.applySystemBars(full);
            },
            onClose: () => {
              this.nativeFullscreen = false;
              this.nativeRequest = null;
              this.applySystemBars(false);
              this.notifyNativeClosed();
            }
          })
            .width(this.nativeFullscreen ? '100%' : this.nativeWidth())
            .height(this.nativeFullscreen ? '100%' : this.nativeHeight())
            // Horizontal: centre the overlay inside the CLIP frame, not at the
            // raw rect origin. The clip frame is the video rect intersected with
            // the content region; a scrollbar gutter on one side makes the
            // intersection a few vp narrower than the rect, and pinning to the
            // rect's left edge pushed the whole transport sideways (the "bar is
            // off centre" report). Vertical stays pinned to the rect so the
            // video keeps following the note while scrolling.
            .position({
              x: this.nativeFullscreen ? 0 : ((this.nativeClipW() - this.nativeWidth()) / 2),
              y: this.nativeFullscreen ? 0 : (this.nativeY() - this.nativeClipY())
            })
        }
        // Clip frame: exactly the visible part of the video rect (video ∩
        // content region). The player keeps its full size inside and is
        // cropped by this frame, so the header/toolbar still cut it instead of
        // being painted over.
        .width(this.nativeFullscreen ? '100%' : this.nativeClipW())
        .height(this.nativeFullscreen ? '100%' : this.nativeClipH())
        .position({ x: this.nativeFullscreen ? 0 : this.nativeClipX(), y: this.nativeFullscreen ? 0 : this.nativeClipY() })
        .clip(true)
        // Default (not Block: Block would cut the player's own children off
        // from hit-testing, and the controls live inside this frame). Default
        // means this frame and its children consume the touch and the covered
        // WebWindow sibling does not. With the old Transparent mode the same
        // tap also reached the WebEngine XComponent underneath, Chromium
        // placed the caret in the note behind the hidden <video> (focusin),
        // the renderer closed the native surface and the IME rose - "tap once
        // and the video closes". The frame now covers only the video slice, so
        // scrolling the rest of the note is untouched.
        .hitTestBehavior(HitTestMode.Default)
        .zIndex(10)
      }
    }
    .width('100%')
    .height('100%')
  }
}
