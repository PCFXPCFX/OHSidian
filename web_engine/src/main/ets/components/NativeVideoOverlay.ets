/*
 * B route: inline native video overlay.
 *
 * A SURFACE XComponent inside the existing page Stack, not a separate window
 * and not a full-screen player page. The renderer sends the <video> rect in
 * CSS px; Index.ets converts it to vp and positions this component. AVPlayer
 * uses the system HEVC decoder via fdSrc + surfaceId.
 *
 * Robustness rules:
 *  - never bind prepare/play to a surfaceId that is not ready;
 *  - one retry on init/prepare/play errors, then a visible retry button;
 *  - guard every player callback with this.player === p so a released
 *    player cannot paint an error into a new session;
 *  - fullscreen is a layout expansion of the same surface, not a new page.
 */

import { media } from '@kit.MediaKit';
import { fileIo } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import LogUtil from '../utils/LogUtil';

const TAG: string = 'NativeVideoOverlay';

// Media chrome, deliberately NOT theme tokens. The paused disc sits ON the
// picture and must match the DOM poster's disc (rgba(0,0,0,.42) + white
// triangle). Tokenising it to --background-secondary made it white-on-white in
// a light theme, and the letterbox around the picture must stay black rather
// than turn into a white band.
const MEDIA_SCRIM: string = '#6B000000';
const MEDIA_INK: string = '#EBFFFFFF';
const MEDIA_HAIRLINE: string = '#33FFFFFF';
const MEDIA_VOID: string = '#000000';

// One MP4 track's technical fields, filled by the container probe below.
interface SpeedSetting {
  rate: number;
}

interface TrackProbe {
  kind: string;
  entry: string;
  ts: number;
  dur: number;
  samples: number;
  delta: number;
  w: number;
  h: number;
  ch: number;
  rate: number;
  // HEVC hvcC profile_tier_level: profile_idc, level_idc, chroma_format,
  // bit_depth_luma/chroma_minus8. depth is the real bit depth (8/10/12).
  depth: number;
  chroma: number;
  profile: number;
  level: number;
  // colr/nclx: colour primaries + transfer characteristics (SDR vs PQ vs HLG).
  prim: number;
  xfer: number;
  // >1 stts entry means variable frame rate.
  sttsEntries: number;
  // stss box: number of sync samples (keyframes) -> GOP = samples/keyframes.
  keyframes: number;
  // btrt box: bufferSizeDB, maxBitrate, avgBitrate (video track bitrate).
  // Many encoders leave avgBitrate at 0, so the max is kept as a fallback.
  vbr: number;
  vbrMax: number;
}


export interface NativeVideoTheme {
  bg: string;
  panel: string;
  bar: string;
  interactive: string;
  accent: string;
  onAccent: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  error: string;
  radiusS: number;
  radiusM: number;
  radiusL: number;
}

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

// Icon geometry: Lucide-compatible 24-unit grid, stroked with round caps. The
// transport used to mix text glyphs (❚❚ ▶ ↻ ✕) with emoji (🔇 🔊) and box-
// drawing arrows (⤡ ⤢); every glyph had a different weight, baseline and
// optical size, which is what makes an overlay read as "foreign" inside
// Obsidian. One grid + one stroke width + one fill rule fixes that without
// shipping raster assets.
// Ink is centred on the 30-unit grid: a 30x30 box scaled about its own centre
// keeps (15,15) on the cell's centreline. The old play triangle (ink 10..27.5)
// had its ink centre at 18.75 - a 12.5% right shift that every scale amplified.
const ICON_PLAY: string = 'M6.25 3.5 23.75 15 6.25 26.5z';
const ICON_PAUSE: string = 'M7 2h6v26h-6zM17 2h6v26h-6z';
const ICON_REPLAY: string = 'M2 15a13 13 0 1 0 13-13 13.6 13.6 0 0 0-9.2 3.8L2 9M2 2v7h7';
const ICON_VOLUME: string = 'M16 2 8 9H2v12h6l8 7zM19 9a7 7 0 0 1 0 12M23 5a12 12 0 0 1 0 20';
const ICON_VOLUME_MUTE: string = 'M16 2 8 9H2v12h6l8 7zM19 10l8 8M27 10l-8 8';
const ICON_MAXIMIZE: string = 'M9 2H2v7M21 2h7v7M28 21v7h-7M2 21v7h7';
const ICON_MINIMIZE: string = 'M9 2v7H2M21 2v7h7M28 21h-7v7M2 21h7v7';
const ICON_CLOSE: string = 'M2 2l26 26M28 2 2 28';

// Disc glyphs: 40-unit grid, ink ~21x28 so the paused triangle lands on the
// poster's 19.8x23.2 instead of a fraction of the disc.
// 40-unit grid, ink 21x28 centred on (20,20) - the same optical ratio as the
// DOM poster's 19.8x23.2 border triangle in its 64px disc.
const ICON_PLAY_BIG: string = 'M9.5 6 30.5 20 9.5 34z';
const ICON_REPLAY_BIG: string = 'M5 20a15 15 0 1 0 15-15 15.7 15.7 0 0 0-10.6 4L5 13M5 5v8h8';

@Component
export struct NativeVideoOverlay {
  @Prop @Watch('onSourceChanged') source: string = '';
  onClose: () => void = () => {};
  @Prop fullscreen: boolean = false;
  @Prop theme: NativeVideoTheme = DEFAULT_NATIVE_VIDEO_THEME;
  // Inline video can extend below the clipped content region (e.g. under the
  // mobile toolbar). The transport must stay inside the visible region, not at
  // the bottom of the full video rect.
  @Prop controlsBottomClip: number = 0;
  /** vp per CSS px for this window (Index: dpr * px2vp(1)). 1 = they match. */
  @Prop unitScale: number = 1;
  /**
   * Box size in vp that Index is applying in the SAME build (.width/.height).
   * Sizes were previously derived from onAreaChange, which runs one frame
   * AFTER the box changed: on a mode switch the bar and disc followed the
   * previous widening and then snapped back (measured in HiLog: area=700 with
   * bar=52.18, a value that only matches area=790).
   */
  @Prop frameW: number = 0;
  @Prop frameH: number = 0;
  /**
   * The <video> rect width in CSS px, as the renderer measured it. The overlay
   * box below is exactly that rect converted to vp, so `lastAreaW / cssWidth`
   * is the true CSS->vp factor MEASURED from this window's own layout, with no
   * dpr / px2vp / @Prop-sync assumption. `unitScale` above is only a fallback.
   */
  @Prop @Watch('onCssWidthChanged') cssWidth: number = 0;
  onFullscreenChange: (full: boolean) => void = (full: boolean) => {};

  @State private playing: boolean = false;
  @State private completed: boolean = false;
  @State private durationMs: number = 0;
  @State private positionMs: number = 0;
  @State private errorText: string = '';
  @State private muted: boolean = false;
  @State private volume: number = 1;
  @State private dragging: boolean = false;
  @State private boosting: boolean = false;
  // Chosen playback rate (1 / 1.5 / 2 / 3). Long-press boost is temporary and
  // restores this value, so the menu and the gesture do not fight.
  @State private speed: number = 1;
  // Intrinsic width/height ratio from AVPlayer (videoSizeChange). 0 = unknown:
  // the surface then fills the frame as before.
  @State private videoAspect: number = 0;
  // Diagnostics readout (long-press the timecode). Shows the numbers this build
  // actually uses, so a screenshot distinguishes a stale install from a layout
  // that is still off.
  @State private showDebug: boolean = false;
  // Easter-egg media panel (long-press the timecode). Every value is read from
  // the real MP4 container by probeMedia(), not guessed.
  @State private metaOk: boolean = false;
  @State private metaW: number = 0;
  @State private metaH: number = 0;
  @State private metaFps: number = 0;
  @State private metaCodec: string = '';
  @State private metaDepth: number = 0;
  @State private metaChroma: number = -1;
  @State private metaProfile: number = 0;
  @State private metaPrim: number = 0;
  @State private metaXfer: number = 0;
  @State private metaVfr: boolean = false;
  @State private metaVideoBps: number = 0;
  @State private metaVideoMax: number = 0;
  @State private metaKeyframes: number = 0;
  @State private metaSamples: number = 0;
  @State private metaAudio: string = '';
  @State private controlsVisible: boolean = false;
  @State private hovering: boolean = false;
  @State private gestureHint: string = '';
  // Source switch: the SURFACE keeps the previous frame until the new decoder
  // presents its first one, so a bare re-init flashes the old video. An opaque
  // cover owns that gap and is removed on the first 'playing' of the new file.
  @State private switching: boolean = false;
  // Shown while a window-resize rebuild runs. The surface has no valid picture
  // between release() and the new decoder's first frame; without this the
  // overlay was revealed at 400ms while the rebuild was still going, i.e. the
  // user saw a black rectangle after every mode switch.
  @State private resizeCover: boolean = false;

  private controller: XComponentController = new XComponentController();
  private player: media.AVPlayer | null = null;
  private file: fileIo.File | null = null;
  private fileLength: number = 0;
  private surfaceId: string = '';
  private started: boolean = false;
  private released: boolean = false;
  private retryCount: number = 0;
  private lastRetryAt: number = 0;
  private retryScheduled: boolean = false;
  private initToken: number = 0;
  private replayPending: boolean = false;
  private playerState: string = '';
  private seekGuardUntil: number = 0;
  private pendingSeekMs: number = -1;
  private resumeMs: number = -1;
  private resumePlay: boolean = false;
  private resizeTimer: number = -1;
  private probeTimer: number = -1;
  private coverTimer: number = -1;
  private hideTimer: number = -1;
  private hintTimer: number = -1;
  private tapTimer: number = -1;
  private controlsShownAt: number = 0;
  private userRevealedControls: boolean = false;
  private revealPending: boolean = false;
  private gestureAxis: string = '';
  private gestureStartPos: number = 0;
  private gestureStartVolume: number = 1;
  private gestureMoved: boolean = false;
  // Measured by onAreaChange on the overlay root. @State, not plain fields:
  // the transport sizes and the letterbox frame are derived from this box, and
  // a resize must re-run build with the new numbers instead of keeping the
  // previous frame's geometry.
  @State private lastAreaW: number = 0;
  @State private lastAreaH: number = 0;
  // Measured CSS->vp factor. 0 = not measured yet, fall back to unitScale.
  @State private unitCache: number = 0;

  aboutToAppear(): void {
    this.released = false;
    this.scheduleMediaProbe();
    this.loadSpeed();
    LogUtil.info(TAG, 'transport=avplayer v158');
  }

  aboutToDisappear(): void {
    this.released = true;
    this.initToken++;
    this.clearHideTimer();
    this.clearHintTimer();
    this.clearTapTimer();
    if (this.probeTimer >= 0) {
      clearTimeout(this.probeTimer);
      this.probeTimer = -1;
    }
    if (this.coverTimer >= 0) {
      clearTimeout(this.coverTimer);
      this.coverTimer = -1;
    }
    if (this.resizeTimer >= 0) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = -1;
    }
    this.release();
  }

  // The inline overlay component is reused when the renderer opens another
  // video without first destroying the page. XComponent.onLoad will NOT fire
  // again in that case, so the old AVPlayer would keep the old source. Rebuild
  // explicitly on a source change.
  private async onSourceChanged(): Promise<void> {
    this.metaOk = false;
    this.metaW = 0;
    this.metaH = 0;
    this.metaFps = 0;
    this.metaAudio = '';
    this.metaDepth = 0;
    this.metaChroma = -1;
    this.metaProfile = 0;
    this.metaPrim = 0;
    this.metaXfer = 0;
    this.metaVfr = false;
    this.metaVideoBps = 0;
    this.metaVideoMax = 0;
    this.metaKeyframes = 0;
    this.metaSamples = 0;
    this.scheduleMediaProbe();
    if (!this.started || this.released) {
      return;
    }
    this.initToken++;
    this.switching = true;
    this.clearHideTimer();
    this.clearHintTimer();
    this.clearTapTimer();
    this.errorText = '';
    this.gestureHint = '';
    this.completed = false;
    this.playing = false;
    this.durationMs = 0;
    this.positionMs = 0;
    this.controlsVisible = false;
    this.userRevealedControls = false;
    this.revealPending = false;
    this.controlsShownAt = 0;
    this.gestureAxis = '';
    this.gestureMoved = false;
    this.resumeMs = -1;
    this.resumePlay = true;
    this.retryCount = 0;
    this.retryScheduled = false;
    this.started = false;
    await this.release();
    if (!this.released && this.surfaceId && this.source) {
      this.initPlayer();
    }
  }

  private async release(): Promise<void> {
    this.replayPending = false;
    const p: media.AVPlayer | null = this.player;
    this.player = null;
    const f: fileIo.File | null = this.file;
    this.file = null;
    if (p !== null) {
      try {
        await p.release();
      } catch (e) {
        LogUtil.warn(TAG, 'release failed: ' + JSON.stringify(e));
      }
    }
    if (f !== null) {
      try {
        fileIo.closeSync(f);
      } catch (e) {
        LogUtil.warn(TAG, 'close fd failed: ' + JSON.stringify(e));
      }
    }
    this.playing = false;
    this.completed = false;
    this.dragging = false;
    this.boosting = false;
    this.playerState = '';
    this.pendingSeekMs = -1;
    this.seekGuardUntil = 0;
  }

  private fail(message: string): void {
    this.errorText = message;
    this.playing = false;
    this.switching = false;
    this.resizeCover = false;
    this.clearHideTimer();
    this.controlsVisible = true;
    // An exhausted retry budget must not leave the decoder/fd/surface alive:
    // that is how a "failed" player keeps holding hardware or even keeps
    // playing audio under the error panel.
    this.release();
  }

  private captureResume(): void {
    // A surface change / decoder reset must not send the user back to 0:00.
    let ms: number = this.positionMs;
    if (this.player !== null) {
      try {
        const t: number = this.player.currentTime;
        if (t > 0) {
          ms = t;
        }
      } catch (e) {
      }
    }
    if (ms >= 0) {
      this.resumeMs = ms;
    }
    if (this.playing) {
      this.resumePlay = true;
    }
  }

  private retry(reason: string): void {
    if (this.released || this.retryScheduled) {
      return;
    }
    if (this.retryCount >= 2) {
      this.fail('播放器初始化失败: ' + reason);
      return;
    }
    this.captureResume();
    this.retryCount++;
    this.lastRetryAt = Date.now();
    this.retryScheduled = true;
    this.errorText = '';
    this.started = false;
    const token: number = ++this.initToken;
    this.release();
    setTimeout(() => {
      if (token === this.initToken) {
        this.retryScheduled = false;
        if (!this.released) {
          this.initPlayer();
        }
      }
    }, 280);
  }

  // Resize rebuilds are not decode errors and must not consume the error budget:
  // two mode switches used to push retryCount to 2, after which the NEXT resize
  // hit `retryCount >= 2` -> fail(), and the player died with an error panel.
  // They are also deduped: one switch fires BOTH XComponent.onLoad and the 320ms
  // area debounce, which tore the decoder down twice (two black frames).
  private retryResize(reason: string): void {
    if (this.released) {
      return;
    }
    if (this.lastRetryAt > 0 && Date.now() - this.lastRetryAt < 500) {
      return;
    }
    this.retryCount = 0;
    this.resizeCover = true;
    this.retry(reason);
  }

  private retryManual(): void {
    this.captureResume();
    this.retryCount = 0;
    this.retryScheduled = false;
    this.errorText = '';
    this.started = false;
    this.released = false;
    const token: number = ++this.initToken;
    this.release();
    setTimeout(() => {
      if (!this.released && token === this.initToken) {
        this.initPlayer();
      }
    }, 120);
  }

  private async initPlayer(): Promise<void> {
    if (this.player !== null || this.started || !this.source || this.released) {
      return;
    }
    this.retryScheduled = false;
    if (!this.surfaceId) {
      this.retry('surfaceId 为空');
      return;
    }
    this.started = true;
    const token: number = ++this.initToken;
    try {
      const f: fileIo.File = fileIo.openSync(this.source, fileIo.OpenMode.READ_ONLY);
      this.file = f;
      this.fileLength = fileIo.statSync(this.source).size;
      const p: media.AVPlayer = await media.createAVPlayer();
      if (this.released || token !== this.initToken) {
        try {
          await p.release();
        } catch (e) {
        }
        // A newer init may already own this.file; close the descriptor this
        // abandoned init opened, or every rapid retry leaks one fd.
        if (!this.released && this.file !== f) {
          try {
            fileIo.closeSync(f);
          } catch (e) {
          }
        }
        return;
      }
      this.player = p;

      // Intrinsic video size. The surface is scaled with its container, so a
      // fullscreen container of a different ratio would stretch the picture;
      // build() uses this aspect to letterbox the XComponent instead.
      try {
        p.on('videoSizeChange', (w: number, h: number) => {
          if (this.player !== p) {
            return;
          }
          LogUtil.info(TAG, 'videoSizeChange ' + w + 'x' + h);
          if (w > 0 && h > 0) {
            this.videoAspect = w / h;
          }
        });
      } catch (eSize) {
        LogUtil.warn(TAG, 'videoSizeChange hook failed: ' + JSON.stringify(eSize));
      }

      p.on('stateChange', (state: string) => {
        if (this.player !== p) {
          return;
        }
        LogUtil.info(TAG, 'state: ' + state);
        this.playerState = state;
        if (state === 'initialized') {
          // surfaceId is ONLY writable in the initialized state. Do not set it
          // right after fdSrc (that races the initialized transition and
          // produces "Operate Not Permit ... SurfaceID ... initialized state").
          try {
            p.surfaceId = this.surfaceId;
          } catch (e) {
            this.retry('surfaceId: ' + JSON.stringify(e));
            return;
          }
          p.prepare().catch((e: BusinessError) => {
            this.retry('prepare: ' + JSON.stringify(e));
          });
        } else if (state === 'prepared') {
          this.applyVolume();
          // Re-apply the global rate on every (re)prepare, including the
          // surface rebuild after a resize.
          this.applyPlaybackRate(this.speed);
          if (this.resumeMs >= 0) {
            const target: number = this.resumeMs;
            const shouldPlay: boolean = this.resumePlay;
            this.resumeMs = -1;
            this.resumePlay = false;
            this.pendingSeekMs = target;
            this.seekGuardUntil = Date.now() + 1200;
            // AVPlayer.seek() is declared `void` in this SDK (not a Promise),
            // so it cannot be chained; a seek failure surfaces through the
            // player's 'error' state and is retried there. Keep the resume
            // play eager: without it a paused resume would seek and stay
            // paused forever.
            p.seek(target, media.SeekMode.SEEK_CLOSEST);
            if (this.player === p && shouldPlay) {
              p.play().catch((e: BusinessError) => {
                this.retry('resume play: ' + JSON.stringify(e));
              });
            } else {
              // A paused resize still counts as a successful surface rebuild:
              // do not let repeated window resizes exhaust the retry budget.
              this.retryCount = 0;
            }
          } else {
            this.resumeMs = -1;
            this.resumePlay = false;
            p.play().catch((e: BusinessError) => {
              this.retry('play: ' + JSON.stringify(e));
            });
          }
        } else if (state === 'playing') {
          this.playing = true;
          this.completed = false;
          this.switching = false;
          this.resizeCover = false;
          if (this.coverTimer >= 0) {
            clearTimeout(this.coverTimer);
            this.coverTimer = -1;
          }
          // A retry normally clears the budget only after the session has
          // proven stable. Resetting on every 'playing' lets a decoder that
          // enters playing then fails immediately retry forever.
          if (this.lastRetryAt === 0 || Date.now() - this.lastRetryAt > 5000) {
            this.retryCount = 0;
          }
          this.scheduleHideControls();
        } else if (state === 'paused') {
          this.playing = false;
          // A paused resize finishes in `paused`, not `playing`: clear the cover
          // here too, otherwise it would sit over the video forever.
          this.resizeCover = false;
          this.showControls();
        } else if (state === 'completed') {
          this.playing = false;
          this.completed = true;
          this.showControls();
        }
      });
      p.on('timeUpdate', (time: number) => {
        if (this.player !== p) {
          return;
        }
        if (!this.dragging && Date.now() >= this.seekGuardUntil) {
          this.positionMs = time;
        }
      });
      p.on('durationUpdate', (duration: number) => {
        if (this.player !== p) {
          return;
        }
        this.durationMs = duration;
      });
      p.on('seekDone', (time: number) => {
        if (this.player !== p) {
          return;
        }
        this.seekGuardUntil = 0;
        if (this.pendingSeekMs >= 0) {
          try {
            this.positionMs = p.currentTime;
          } catch (e) {
            this.positionMs = this.pendingSeekMs;
          }
          this.pendingSeekMs = -1;
        }
        if (this.replayPending) {
          this.replayPending = false;
          p.play().catch((e: BusinessError) => {
            LogUtil.warn(TAG, 'replay after seek failed: ' + JSON.stringify(e));
          });
        }
      });
      p.on('error', (err: BusinessError) => {
        if (this.player !== p || this.released) {
          return;
        }
        LogUtil.warn(TAG, 'error: ' + JSON.stringify(err));
        this.retry('AVPlayer: ' + (err && err.message ? err.message : JSON.stringify(err)));
      });

      p.fdSrc = { fd: f.fd, offset: 0, length: this.fileLength };
    } catch (e) {
      if (token === this.initToken) {
        this.retry('open: ' + JSON.stringify(e));
      }
    }
  }

  private applyVolume(): void {
    const p: media.AVPlayer | null = this.player;
    if (p === null) {
      return;
    }
    try {
      const level: number = this.muted ? 0 : Math.max(0, Math.min(1, this.volume));
      p.setVolume(level);
    } catch (e) {
      LogUtil.warn(TAG, 'setVolume failed: ' + JSON.stringify(e));
    }
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    if (!this.muted && this.volume <= 0) {
      this.volume = 1;
    }
    this.applyVolume();
    this.showControls();
  }

  private toggleFullscreen(): void {
    // Fallback aspect: Obsidian sizes the <video> to the file's aspect, so the
    // inline frame IS the video ratio. If videoSizeChange has not fired (some
    // builds only emit the legacy event, or it races prepare), capture it here
    // before the frame becomes the whole window - otherwise fullscreen would
    // keep the surface at window ratio and stretch the picture.
    if (!this.fullscreen && !(this.videoAspect > 0) && this.lastAreaW > 1 && this.lastAreaH > 1) {
      this.videoAspect = this.lastAreaW / this.lastAreaH;
      LogUtil.info(TAG, 'aspect from inline frame=' + this.videoAspect);
    }
    this.onFullscreenChange(!this.fullscreen);
    this.showControls();
  }

  // The enum already carries 1.5x and 3x (SPEED_FORWARD_1_50_X / _3_00_X,
  // API 12+); the numeric overload returns Promise and resolves to the void
  // overload in ArkTS, so map the UI rate onto the enum instead.
  private playbackSpeedOf(rate: number): media.PlaybackSpeed {
    if (Math.abs(rate - 1.5) < 0.01) {
      return media.PlaybackSpeed.SPEED_FORWARD_1_50_X;
    }
    if (Math.abs(rate - 2) < 0.01) {
      return media.PlaybackSpeed.SPEED_FORWARD_2_00_X;
    }
    if (Math.abs(rate - 3) < 0.01) {
      return media.PlaybackSpeed.SPEED_FORWARD_3_00_X;
    }
    if (Math.abs(rate - 1.25) < 0.01) {
      return media.PlaybackSpeed.SPEED_FORWARD_1_25_X;
    }
    if (Math.abs(rate - 1.75) < 0.01) {
      return media.PlaybackSpeed.SPEED_FORWARD_1_75_X;
    }
    if (Math.abs(rate - 0.75) < 0.01) {
      return media.PlaybackSpeed.SPEED_FORWARD_0_75_X;
    }
    return media.PlaybackSpeed.SPEED_FORWARD_1_00_X;
  }

  private applyPlaybackRate(rate: number): void {
    const p: media.AVPlayer | null = this.player;
    if (p === null) {
      return;
    }
    try {
      p.setSpeed(this.playbackSpeedOf(rate));
      LogUtil.info(TAG, 'speed=' + rate);
    } catch (e) {
      LogUtil.warn(TAG, 'setSpeed failed: ' + JSON.stringify(e));
    }
  }

  private setPlaybackSpeed(rate: number): void {
    this.speed = rate;
    this.boosting = false;
    this.applyPlaybackRate(rate);
    // Global preference: remembered across videos, windows and restarts.
    this.saveSpeed();
    this.showControls();
  }

  private speedLabel(): string {
    if (this.boosting) {
      return '2×';
    }
    const s: number = this.speed;
    if (Math.abs(s - 1) < 0.01) {
      return '1×';
    }
    if (Math.abs(s - 1.5) < 0.01) {
      return '1.5×';
    }
    if (Math.abs(s - 2) < 0.01) {
      return '2×';
    }
    if (Math.abs(s - 3) < 0.01) {
      return '3×';
    }
    return s + '×';
  }

  private beginBoost(): void {
    if (!this.playing || this.boosting) {
      return;
    }
    this.clearHideTimer();
    this.controlsVisible = true;
    this.boosting = true;
    this.applyPlaybackRate(2);
  }

  private endBoost(): void {
    if (!this.boosting) {
      return;
    }
    this.boosting = false;
    // Restore the rate chosen in the menu, not a hard-coded 1x.
    this.applyPlaybackRate(this.speed);
    this.showControls();
  }

  // ---- global playback rate -------------------------------------------
  // The chosen rate is a user preference, not a per-video state: pick 1.5x once
  // and every note, every window and every restart keeps it. The temporary
  // long-press boost writes nothing here, so releasing it falls back to this
  // value instead of a hard-coded 1x.
  private speedFilePath(): string {
    try {
      return getContext(this).getApplicationContext().filesDir + '/ohsidian-native-speed.json';
    } catch (e) {
      return '';
    }
  }

  private loadSpeed(): void {
    const p: string = this.speedFilePath();
    if (!p) {
      return;
    }
    try {
      if (!fileIo.accessSync(p)) {
        return;
      }
      const s: SpeedSetting = JSON.parse(fileIo.readTextSync(p)) as SpeedSetting;
      const v: number = s && typeof s.rate === 'number' ? s.rate : 1;
      if (v >= 0.5 && v <= 3) {
        this.speed = v;
      }
    } catch (e) {
      LogUtil.warn(TAG, 'load speed failed: ' + JSON.stringify(e));
    }
  }

  private saveSpeed(): void {
    const p: string = this.speedFilePath();
    if (!p) {
      return;
    }
    try {
      const f: fileIo.File = fileIo.openSync(p,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(f.fd, JSON.stringify({ rate: this.speed } as SpeedSetting));
      } finally {
        fileIo.closeSync(f);
      }
    } catch (e) {
      LogUtil.warn(TAG, 'save speed failed: ' + JSON.stringify(e));
    }
  }

  private clearHideTimer(): void {
    if (this.hideTimer >= 0) {
      clearTimeout(this.hideTimer);
      this.hideTimer = -1;
    }
  }

  private scheduleHideControls(): void {
    this.clearHideTimer();
    if (!this.playing || this.dragging || this.boosting || this.errorText || this.hovering) {
      return;
    }
    // Obsidian's "quiet guest" rule: no persistent chrome over the content.
    // Keep it visible while paused/error/transport interaction, hide after 3s
    // only during uninterrupted playback.
    this.hideTimer = setTimeout(() => {
      this.hideTimer = -1;
      if (this.playing && !this.dragging && !this.boosting && !this.errorText && !this.hovering) {
        this.controlsVisible = false;
        this.userRevealedControls = false;
        this.revealPending = false;
      }
    }, 3000);
  }

  private showControls(): void {
    this.controlsVisible = true;
    this.controlsShownAt = Date.now();
    LogUtil.info(TAG, 'controls visible playing=' + this.playing);
    this.scheduleHideControls();
  }

  private onHoverChanged(isHover: boolean): void {
    this.hovering = isHover;
    if (isHover) {
      // A real mouse/trackpad produces hover; a finger never does. One hover is
      // enough to switch this player to the compact density for the session.
        this.showControls();
    } else {
      this.scheduleHideControls();
    }
  }

  private onSurfaceTap(): void {
    LogUtil.info(TAG, 'surface tap controls=' + this.controlsVisible +
      ' userRevealed=' + this.userRevealedControls +
      ' revealPending=' + this.revealPending + ' playing=' + this.playing);
    if (!this.controlsVisible || !this.userRevealedControls) {
      // Hover/state changes may have made the controls visible without the
      // user claiming them; this tap claims and is consumed. The next tap
      // toggles (touch-down already handles the normal hidden case).
      this.showControls();
      this.userRevealedControls = true;
      this.revealPending = false;
      return;
    }
    if (this.revealPending) {
      // The touch-down already revealed the controls; this is the confirming
      // tap. Do not reset the reveal anchor, or a quick second tap gets eaten.
      this.revealPending = false;
      return;
    }
    this.togglePlay();
    this.showControls();
  }

  private clearHintTimer(): void {
    if (this.hintTimer >= 0) {
      clearTimeout(this.hintTimer);
      this.hintTimer = -1;
    }
  }

  private showGestureHint(text: string, holdMs: number = 1100): void {
    this.gestureHint = text;
    if (this.hintTimer >= 0) {
      return;
    }
    this.hintTimer = setTimeout(() => {
      this.hintTimer = -1;
      this.gestureHint = '';
    }, holdMs);
  }

  private seekByGesture(dx: number): void {
    const width: number = Math.max(1, this.lastAreaW);
    const duration: number = Math.max(1, this.durationMs);
    const deltaMs: number = dx / width * duration;
    const target: number = Math.max(0, Math.min(duration, this.gestureStartPos + deltaMs));
    this.dragging = true;
    this.completed = false;
    this.positionMs = target;
    const seconds: number = Math.round(Math.abs(deltaMs) / 1000);
    const sign: string = deltaMs >= 0 ? '+' : '−';
    this.showGestureHint(sign + seconds + 's · ' + this.formatTime(target), 700);
  }

  private volumeByGesture(dy: number): void {
    // lastAreaH is the measured XComponent height. On the first frame it can
    // still be 0, and a 0 height makes every 1vp of travel jump the volume to
    // 0% or 100% (that is how "vertical swipe does nothing / mutes instantly"
    // looks). Fall back to a sane travel distance and ignore sub-pixel noise.
    const height: number = Math.max(160, this.lastAreaH > 0 ? this.lastAreaH : 0);
    const next: number = Math.max(0, Math.min(1, this.gestureStartVolume - dy / height));
    this.volume = next;
    this.muted = next <= 0.001;
    this.applyVolume();
    this.showGestureHint('音量 ' + Math.round(next * 100) + '%', 700);
  }

  private onGestureStart(axis: string = ''): void {
    this.clearHideTimer();
    this.clearHintTimer();
    this.gestureAxis = axis;
    this.gestureMoved = false;
    this.gestureStartPos = this.positionMs;
    this.gestureStartVolume = this.muted ? 0 : this.volume;
    LogUtil.info(TAG, 'gesture start axis=' + axis + ' pos=' + this.positionMs + ' controls=' + this.controlsVisible);
  }

  private onGestureUpdate(event: GestureEvent): void {
    const dx: number = event.offsetX;
    const dy: number = event.offsetY;
    if (this.gestureAxis === '') {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) {
        return;
      }
      this.gestureAxis = Math.abs(dx) >= Math.abs(dy) ? 'seek' : 'volume';
    }
    if (!this.gestureMoved) {
      this.gestureMoved = true;
      this.showControls();
      this.userRevealedControls = true;
      this.revealPending = false;
      this.clearHideTimer();
      LogUtil.info(TAG, 'gesture axis=' + this.gestureAxis + ' dx=' + dx + ' dy=' + dy);
    }
    if (this.gestureAxis === 'seek') {
      this.seekByGesture(dx);
    } else {
      this.volumeByGesture(dy);
    }
  }

  private onGestureEnd(): void {
    const moved: boolean = this.gestureMoved;
    const axis: string = this.gestureAxis;
    this.gestureMoved = false;
    this.gestureAxis = '';
    if (!moved) {
      // A tap also starts/ends a PanGesture on some ArkUI versions. It must not
      // reveal controls here, otherwise the delayed single-tap sees
      // controlsVisible=true and toggles play/pause instead of revealing.
      return;
    }
    if (axis === 'seek') {
      this.dragging = false;
      this.seekTo(this.positionMs);
    }
    // A drag is not the confirming tap: touch-down set revealPending, and if it
    // survived the gesture the NEXT single tap was swallowed as "confirm",
    // so pausing after a seek took two taps.
    this.revealPending = false;
    this.showControls();
    LogUtil.info(TAG, 'gesture end axis=' + axis + ' pos=' + this.positionMs);
  }

  private onGestureCancel(): void {
    const axis: string = this.gestureAxis;
    this.gestureMoved = false;
    this.gestureAxis = '';
    this.dragging = false;
    if (axis === 'seek') {
      // A cancelled gesture must not commit a seek; restore the slider preview.
      this.positionMs = this.gestureStartPos;
    }
    this.revealPending = false;
    this.showControls();
  }

  private clearTapTimer(): void {
    if (this.tapTimer >= 0) {
      clearTimeout(this.tapTimer);
      this.tapTimer = -1;
    }
  }

  private onSingleTap(): void {
    this.clearTapTimer();
    LogUtil.info(TAG, 'single tap scheduled');
    // Wait out the platform double-tap window so a double tap does not also
    // toggle play/pause on its first tap. Touch-down already revealed the
    // controls, so this delay is not user-visible.
    this.tapTimer = setTimeout(() => {
      this.tapTimer = -1;
      this.onSurfaceTap();
    }, 320);
  }

  private onDoubleTapAction(event: GestureEvent): void {
    this.clearTapTimer();
    this.revealPending = false;
    this.onDoubleTap(event);
  }

  private onDoubleTap(event: GestureEvent): void {
    let x: number = this.lastAreaW / 2;
    if (event.fingerList && event.fingerList.length > 0) {
      x = event.fingerList[0].localX;
    }
    const w: number = this.lastAreaW > 0 ? this.lastAreaW : 1;
    // Double-tap means ONE thing: seek. Left half -10s, right half +10s, the
    // convention every video app shares. Fullscreen used to live in the middle
    // third, which made "what does double-tap do" unanswerable - fullscreen has
    // its own button now.
    this.skipBy(x < w / 2 ? -10000 : 10000);
  }

  private skipBy(deltaMs: number): void {
    const duration: number = Math.max(1, this.durationMs);
    const target: number = Math.max(0, Math.min(duration, this.positionMs + deltaMs));
    this.completed = false;
    this.positionMs = target;
    this.seekTo(target);
    this.showGestureHint(deltaMs > 0 ? '+10s' : '−10s', 900);
    this.showControls();
    this.userRevealedControls = true;
  }

  private togglePlay(): void {
    const p: media.AVPlayer | null = this.player;
    if (p === null) {
      return;
    }
    LogUtil.info(TAG, 'togglePlay playing=' + this.playing + ' completed=' + this.completed);
    this.showControls();
    try {
      if (this.playing) {
        this.endBoost();
        p.pause();
      } else if (this.completed) {
        this.replayPending = true;
        this.pendingSeekMs = 0;
        this.seekGuardUntil = Date.now() + 800;
        this.positionMs = 0;
        p.seek(0, media.SeekMode.SEEK_CLOSEST);
        setTimeout(() => {
          if (this.replayPending && this.player === p) {
            this.replayPending = false;
            p.play().catch((e: BusinessError) => {
              LogUtil.warn(TAG, 'replay fallback failed: ' + JSON.stringify(e));
            });
          }
        }, 300);
      } else {
        p.play().catch((e: BusinessError) => {
          this.retry('play: ' + JSON.stringify(e));
        });
      }
    } catch (e) {
      LogUtil.warn(TAG, 'toggle failed: ' + JSON.stringify(e));
    }
  }

  private onSliderChange(value: number, mode: SliderChangeMode): void {
    if (mode === SliderChangeMode.Begin) {
      this.dragging = true;
      this.positionMs = value;
      this.showControls();
    } else if (mode === SliderChangeMode.Moving) {
      this.positionMs = value;
    } else {
      this.dragging = false;
      this.completed = false;
      this.positionMs = value;
      this.seekTo(value);
      this.showControls();
    }
  }

  private seekTo(value: number): void {
    const p: media.AVPlayer | null = this.player;
    if (p === null) {
      return;
    }
    try {
      this.pendingSeekMs = Math.max(0, Math.floor(value));
      this.seekGuardUntil = Date.now() + 700;
      this.positionMs = this.pendingSeekMs;
      // SEEK_PREV_SYNC is fast-forward-oriented. For a user drag (especially
      // backward), SEEK_CLOSEST lands on the requested frame; the old
      // timeUpdate then raced back and made backward seeks look ignored.
      p.seek(this.pendingSeekMs, media.SeekMode.SEEK_CLOSEST);
    } catch (e) {
      this.pendingSeekMs = -1;
      this.seekGuardUntil = 0;
      LogUtil.warn(TAG, 'seek failed: ' + JSON.stringify(e));
    }
  }

  private close(): void {
    this.clearHideTimer();
    this.clearHintTimer();
    this.clearTapTimer();
    this.endBoost();
    this.release();
    this.onClose();
  }

  private formatTime(ms: number): string {
    const total: number = Math.max(0, Math.floor(ms / 1000));
    const m: number = Math.floor(total / 60);
    const s: number = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  private scheduleSurfaceResize(w: number, h: number): void {
    if (!(w > 0) || !(h > 0)) {
      return;
    }
    const changed: boolean = this.lastAreaW > 0 && this.lastAreaH > 0 &&
      (Math.abs(w - this.lastAreaW) > 2 || Math.abs(h - this.lastAreaH) > 2);
    this.lastAreaW = w;
    this.lastAreaH = h;
    if (!changed || this.player === null) {
      return;
    }
    if (this.playerState !== 'prepared' && this.playerState !== 'playing' &&
      this.playerState !== 'paused' && this.playerState !== 'completed') {
      return;
    }
    if (this.resizeTimer >= 0) {
      clearTimeout(this.resizeTimer);
    }
    // Let the window drag settle; at the final size recreate the surface while
    // preserving currentTime/playing. No close, no restart from 0:00.
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = -1;
      if (!this.released && this.player !== null &&
        (this.playerState === 'prepared' || this.playerState === 'playing' ||
          this.playerState === 'paused' || this.playerState === 'completed')) {
        // A user resize is not a decode error; retryResize() also resets the
        // budget and dedupes against the onLoad trigger of the same switch.
        this.retryResize('surface area');
      }
    }, 320);
  }

  // Density is decided by the POINTER HARDWARE, not by the renderer: ArkUI's
  // onHover fires for a mouse/trackpad and never for a finger. The previous
  // `pointer` flag came from JS, where Chromium synthesises compatibility mouse
  // events after a touch - so a tablet tap flipped the whole transport to the
  // compact desktop density ("icons still small").

  private onCssWidthChanged(): void {
    this.syncUnit();
  }

  // The box (vp) divided by the <video> rect width (CSS px) IS this window's
  // CSS->vp factor. Deriving it from the layout that actually happened means a
  // stale/unset `unitScale` can no longer shrink the whole transport by that
  // ratio - the "controls are still too small no matter what number I raise"
  // report. Fullscreen has no CSS rect to divide by; the density of the same
  // window does not change, so the last measured value stays valid.
  private syncUnit(): void {
    if (this.fullscreen || !(this.cssWidth > 1) || !(this.lastAreaW > 1)) {
      return;
    }
    const k: number = this.lastAreaW / this.cssWidth;
    if (k > 0.4 && k < 4 && Math.abs(k - this.unitCache) > 0.005) {
      this.unitCache = k;
    }
  }

  private u(): number {
    // Fullscreen has no CSS rect to measure against, so syncUnit() bails and the
    // cache would freeze at the density of the windowed layout - wrong the
    // moment a window<->touch switch changes the density (1.9125 -> 2.25).
    // There, trust the freshly computed k from Index instead.
    if (this.fullscreen) {
      if (this.unitScale > 0) {
        return this.unitScale;
      }
      return this.unitCache > 0 ? this.unitCache : 1;
    }
    if (this.unitCache > 0) {
      return this.unitCache;
    }
    return this.unitScale > 0 ? this.unitScale : 1;
  }

  private compactControls(): boolean {
    // Single density on purpose. A "desktop" variant keyed off hover flipped
    // this transport to 40vp/18vp on a tablet with a keyboard cover, which is
    // the "icons are still small" report; the poster is always 64/19.8/23.2, and
    // the native layer now uses the same sizes everywhere.
    return false;
  }

  // TOUCH density is now a FRACTION OF THE PLAYER WIDTH, clamped to the
  // acceptance range in docs/B-NATIVE-OVERLAY.md #32 (56vp bar / 48vp target).
  //
  // R128 raised the fixed vp numbers to 74/64 and was rejected ("everything got
  // bigger, wrong"). R121..R127 kept them at 56..60 and were called "too small".
  // Both were guesses, because a fixed vp number cannot be right for a 360vp
  // phone video and a 700vp note video at the same time: the same 56vp is 15.6%
  // of a phone player and 8% of this one.
  //
  // The anchor is the ONE size already accepted on device: the DOM poster disc,
  // 64 CSS px on a 700 px wide player = 9.14%. Every other control is a ratio
  // against that, so the native disc lands exactly on the poster disc (no jump
  // when the surface opens) and the transport keeps the same density inline and
  // in fullscreen. The clamps are the spec's floor/ceiling, not taste.
  private ratioOf(r: number, floor: number, ceil: number): number {
    const box: number = this.frameW > 1 ? this.frameW : this.lastAreaW;
    const w: number = box > 1 ? box / this.u() : 700;
    return Math.min(ceil, Math.max(floor, w * r));
  }

  private barHeight(): number {
    return this.ratioOf(0.066, 42, 56) * this.u();
  }

  // Hit target: the spec floor (48vp material minimum) upward, but it can NEVER
  // exceed what the pill can hold. Five fixed-width cells plus the timecode are
  // a hard width budget; on a narrow embed the old fixed 52..64 made the Row
  // overflow its own pill and clip the right-hand buttons, which reads as
  // "the buttons are cut / not centred". The guard spends at most (content -
  // timecode - margins) / 5 per cell and always leaves the slider 40vp.
  private btnSize(): number {
    const u: number = this.u();
    const natural: number = this.ratioOf(0.068, 40, 56) * u;
    const w: number = this.lastAreaW > 1 ? this.lastAreaW : 700;
    const content: number = w * 0.96 - 20 * u;
    const budget: number = content - this.timeWidth() - 10 * u - 40 * u;
    const maxBtn: number = Math.max(32 * u, budget / 5);
    return Math.min(natural, maxBtn);
  }

  private glyphSize(): number {
    return this.ratioOf(0.027, 16, 24) * this.u();
  }

  // The right-hand group (volume / fullscreen / close) is secondary to the
  // transport: one notch smaller than play/pause so the bar reads as a hierarchy
  // instead of five equal buttons.
  private glyphSizeRight(): number {
    return this.ratioOf(0.020, 12, 18) * this.u();
  }

  // Maximise/minimise and close carry ink that spans nearly the whole 30-unit
  // grid (2..28), while play/volume sit around 24-26 units. At the same box
  // size they therefore read visibly heavier, so they get one notch smaller.
  private glyphSizeTiny(): number {
    return this.ratioOf(0.0172, 10, 15) * this.u();
  }

  private btnSizeRight(): number {
    return this.ratioOf(0.0515, 30, 44) * this.u();
  }

  private playGlyphSize(): number {
    return this.glyphSize();
  }

  private timeFontSize(): number {
    return this.ratioOf(0.014, 9, 12) * this.u();
  }

  private timeWidth(): number {
    return this.ratioOf(0.112, 72, 120) * this.u();
  }

  private trackThickness(): number {
    return this.ratioOf(0.003, 2, 3) * this.u();
  }

  private blockSizePx(): number {
    return this.ratioOf(0.012, 8, 12) * this.u();
  }

  // The centred paused control is the same disc the poster shows before the
  // surface opens (0.0914 x player width = the poster's 64/700), so tapping the
  // poster and pausing later land on the same pixel: no second visual language.
  private discSize(): number {
    return this.ratioOf(0.0914, 56, 72) * this.u();
  }

  // Optical size as a percentage of the player width. This is what the eye
  // actually judges ("too small" / "off"), so the readout reports it directly
  // instead of leaving it to be inferred from vp numbers.
  // One decimal, for the readout only: the ratio-derived sizes are floats and a
  // raw concat prints 65.80000000000001, which reads like a broken build.
  // clipW - boxW: 0 means the video box is fully visible (geometry provably
  // exact); a negative value is how much of the video the content region crops,
  // and the overlay is consequently shifted by half of it.
  // Window-space left edge of this overlay: the clip frame's left plus the half
  // crop shift Index applies. Comparing it with the poster's rect.left tells
  // whether the native picture sits exactly where the page painted the poster.
  // Bottom inset of the transport, in vp: the 10vp breathing room PLUS whatever
  // part of the video rect hangs below the visible content region. The clip
  // frame crops the overlay, so anchoring the bar to the RAW rect bottom put it
  // under the note's bottom chrome - i.e. the transport was cut in half, which
  // reads as "the buttons are small and off centre". Clamped to 40% of the
  // frame so a very tall video can never push the bar into the disc.
  private barBottomInset(): number {
    const base: number = this.compactControls() ? 0 : 10 * this.u();
    if (this.controlsBottomClip <= 0) {
      return base;
    }
    const limit: number = this.lastAreaH > 1 ? this.lastAreaH * 0.4 : 0;
    return base + Math.min(this.controlsBottomClip, limit);
  }

  // Contain-fit for the surface: with a known intrinsic aspect the XComponent
  // is sized to the largest box with that aspect inside the frame, and the
  // centred declaration leaves the remainder as theme.bg bars. 0 means "aspect
  // unknown yet" and the caller keeps 100% (no visual change for inline embeds,
  // which already have the video's aspect).
  private videoFrameW(): number {
    const w: number = this.frameW > 1 ? this.frameW : this.lastAreaW;
    const h: number = this.frameH > 1 ? this.frameH : this.lastAreaH;
    if (!(w > 1) || !(h > 1) || !(this.videoAspect > 0)) {
      return 0;
    }
    return Math.min(w, h * this.videoAspect);
  }

  private videoFrameH(): number {
    const w: number = this.frameW > 1 ? this.frameW : this.lastAreaW;
    const h: number = this.frameH > 1 ? this.frameH : this.lastAreaH;
    if (!(w > 1) || !(h > 1) || !(this.videoAspect > 0)) {
      return 0;
    }
    return Math.min(h, w / this.videoAspect);
  }

  // One glyph renderer for every icon in the transport: 24-unit viewport,
  // opaque stroke, rounded caps/joins. `filled` is used only for the play
  // triangle (a stroked triangle at 19vp reads as an outline, not a button).
  // Icon renderer. The Path is authored on the 24-unit grid and the whole
  // Shape is then SCALED - not resized. `Shape().viewPort(24).width(size)`
  // keeps the path's drawing scale at 24 units inside a larger node, so the
  // glyph sat top-left and read as "small and off-centre". Keeping the layout
  // box at 24 and scaling around the centre makes size and centring exact for
  // every glyph, and the stroke scales with it.
  // Icon renderer with ZERO transforms. The Path is authored on a 30-unit
  // grid and the Shape is exactly 30x30, so every path coordinate is a vp and
  // the Stack centres the box - there is no viewPort scaling and no .scale()
  // whose anchor could shift the glyph (the "icons sit high / too small"
  // reports). The disc uses the 40-unit variants below.
  // Numeric transform origins. `centerX: '50%'` is resolved against the parent
  // in some ArkUI builds, which put the origin at the CELL's centre (26,30) and
  // dragged every scaled glyph 1.9vp left / 2.5vp up - the "buttons are not
  // centred" report. 15 is the exact centre of the fixed 30-unit box.
  // ---- MP4 container probe (feeds the easter-egg panel) ------------------
  // Only the `moov` box is read: top-level boxes are walked with 16-byte
  // seeks, so a 4 GB clip costs a few hundred bytes of I/O. Fields:
  //   stsd -> sample entry fourcc, video width/height, mp4a channels + rate
  //   mdhd -> media timescale (for fps and duration)
  //   stts -> first sample delta (CFR interval; a VFR clip shows the average)
  private be32(b: Uint8Array, i: number): number {
    const x0: number = (b[i] & 0xff) << 24;
    const x1: number = (b[i + 1] & 0xff) << 16;
    const x2: number = (b[i + 2] & 0xff) << 8;
    const x3: number = b[i + 3] & 0xff;
    return (x0 | x1 | x2 | x3) >>> 0;
  }

  private be16(b: Uint8Array, i: number): number {
    return ((b[i] & 0xff) << 8) | (b[i + 1] & 0xff);
  }

  private fcc(b: Uint8Array, i: number): string {
    return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  }

  private probeTrack(b: Uint8Array, start: number, end: number, out: TrackProbe): void {
    let p: number = start;
    while (p + 8 <= end) {
      const size: number = this.be32(b, p);
      if (size < 8) {
        return;
      }
      const type: string = this.fcc(b, p + 4);
      const body: number = p + 8;
      const bEnd: number = Math.min(end, p + size);
      if (type === 'mdia' || type === 'minf' || type === 'stbl') {
        this.probeTrack(b, body, bEnd, out);
      } else if (type === 'hdlr') {
        out.kind = this.fcc(b, body + 8);
      } else if (type === 'mdhd') {
        if (b[body] === 1) {
          out.ts = this.be32(b, body + 20);
          out.dur = this.be32(b, body + 28);
        } else {
          out.ts = this.be32(b, body + 12);
          out.dur = this.be32(b, body + 16);
        }
      } else if (type === 'stsd') {
        const e: number = body + 8;
        out.entry = this.fcc(b, e + 4);
        if (out.entry === 'hvc1' || out.entry === 'hev1' || out.entry === 'avc1' ||
          out.entry === 'avc3') {
          out.w = this.be16(b, e + 32);
          out.h = this.be16(b, e + 34);
          // Walk the sample entry's child boxes for the codec config record.
          // hvcC payload: [1]=profile_idc(low 5 bits), [12]=level_idc,
          // [16]=chroma_format(low 2 bits), [17]=bit_depth_luma_minus8,
          // [18]=bit_depth_chroma_minus8.
          const entryEnd: number = Math.min(bEnd, e + this.be32(b, e));
          let q: number = e + 86;
          while (q + 8 <= entryEnd) {
            const cs: number = this.be32(b, q);
            if (cs < 8) {
              break;
            }
            const ct: string = this.fcc(b, q + 4);
            if (ct === 'hvcC' && q + 8 + 23 <= entryEnd) {
              const cfg: number = q + 8;
              out.profile = b[cfg + 1] & 0x1f;
              out.level = b[cfg + 12];
              out.chroma = b[cfg + 16] & 0x03;
              out.depth = (b[cfg + 17] & 0x07) + 8;
            } else if (ct === 'btrt' && q + 8 + 12 <= entryEnd) {
              out.vbrMax = this.be32(b, q + 8 + 4);
              out.vbr = this.be32(b, q + 8 + 8);
            } else if (ct === 'colr' && q + 8 + 10 <= entryEnd) {
              // nclx/nclc: primaries(2) transfer(2) matrix(2)
              const cp: number = q + 8;
              const kind: string = this.fcc(b, cp);
              if (kind === 'nclx' || kind === 'nclc') {
                out.prim = this.be16(b, cp + 4);
                out.xfer = this.be16(b, cp + 6);
              }
            }
            q += cs;
          }
        } else if (out.entry === 'mp4a' || out.entry === 'enca') {
          out.ch = this.be16(b, e + 24);
          out.rate = this.be32(b, e + 32) >>> 16;
        }
      } else if (type === 'stss') {
        const n: number = this.be32(b, body + 4);
        if (n > 0 && n < 100000000) {
          out.keyframes = n;
        }
      } else if (type === 'stts') {
        const n: number = this.be32(b, body + 4);
        out.sttsEntries = n;
        if (n > 0) {
          out.samples = this.be32(b, body + 8);
          out.delta = this.be32(b, body + 12);
        }
      }
      p = bEnd;
    }
  }

  // The probe opens the file and reads its moov box synchronously. Doing that
  // from aboutToAppear blocks the first frame ("opening a clip stalls for a
  // moment"), so give the player a beat before reading the container.
  private scheduleMediaProbe(): void {
    if (this.probeTimer >= 0) {
      clearTimeout(this.probeTimer);
    }
    this.probeTimer = setTimeout(() => {
      this.probeTimer = -1;
      if (!this.released) {
        this.scheduleMediaProbe();
      }
    }, 500);
  }

  private probeMedia(): void {
    const path: string = this.source ? this.source : '';
    if (!path) {
      return;
    }
    let f: fileIo.File | null = null;
    try {
      f = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
      const size: number = fileIo.statSync(path).size;
      this.fileLength = size;
      const hdr: ArrayBuffer = new ArrayBuffer(16);
      const hb: Uint8Array = new Uint8Array(hdr);
      let off: number = 0;
      let moovOff: number = -1;
      let moovLen: number = 0;
      while (off + 8 <= size) {
        const got: number = fileIo.readSync(f.fd, hdr, { offset: off, length: 16 });
        if (got < 8) {
          break;
        }
        let boxSize: number = this.be32(hb, 0);
        const type: string = this.fcc(hb, 4);
        let hdrLen: number = 8;
        if (boxSize === 1) {
          boxSize = this.be32(hb, 8) * 4294967296 + this.be32(hb, 12);
          hdrLen = 16;
        } else if (boxSize === 0) {
          boxSize = size - off;
        }
        if (boxSize < hdrLen) {
          break;
        }
        if (type === 'moov') {
          moovOff = off + hdrLen;
          moovLen = boxSize - hdrLen;
          break;
        }
        off += boxSize;
      }
      if (moovOff < 0 || !(moovLen > 0) || moovLen > 16777216) {
        return;
      }
      const mb: ArrayBuffer = new ArrayBuffer(moovLen);
      fileIo.readSync(f.fd, mb, { offset: moovOff, length: moovLen });
      const b: Uint8Array = new Uint8Array(mb);
      let p: number = 0;
      let hasAudio: boolean = false;
      while (p + 8 <= moovLen) {
        const bs: number = this.be32(b, p);
        if (bs < 8) {
          break;
        }
        const ty: string = this.fcc(b, p + 4);
        const be: number = Math.min(moovLen, p + bs);
        if (ty === 'trak') {
          const tp: TrackProbe = {
            kind: '', entry: '', ts: 0, dur: 0, samples: 0, delta: 0,
            w: 0, h: 0, ch: 0, rate: 0, depth: 0, chroma: -1, profile: 0, level: 0,
            prim: 0, xfer: 0, sttsEntries: 0, vbr: 0, vbrMax: 0, keyframes: 0
          };
          this.probeTrack(b, p + 8, be, tp);
          if (tp.kind === 'vide') {
            this.metaW = tp.w;
            this.metaH = tp.h;
            if (tp.entry === 'hvc1' || tp.entry === 'hev1') {
              this.metaCodec = 'HEVC';
            } else if (tp.entry === 'avc1' || tp.entry === 'avc3') {
              this.metaCodec = 'H.264';
            } else if (tp.entry) {
              this.metaCodec = tp.entry;
            }
            this.metaDepth = tp.depth;
            this.metaChroma = tp.chroma;
            this.metaProfile = tp.profile;
            this.metaPrim = tp.prim;
            this.metaXfer = tp.xfer;
            this.metaVfr = tp.sttsEntries > 1;
            this.metaVideoBps = tp.vbr;
            this.metaVideoMax = tp.vbrMax;
            this.metaKeyframes = tp.keyframes;
            this.metaSamples = tp.samples;
            if (tp.delta > 0) {
              this.metaFps = tp.ts / tp.delta;
            }
          } else if (tp.kind === 'soun') {
            hasAudio = true;
            const codec: string = tp.entry === 'mp4a' ? 'AAC' : (tp.entry ? tp.entry : '音频');
            const khz: string = tp.rate > 0 ? (tp.rate / 1000).toFixed(1) + ' kHz · ' : '';
            const chn: string = tp.ch >= 2 ? '立体声' : '单声道';
            this.metaAudio = codec + ' · ' + khz + chn;
          }
        }
        p = be;
      }
      if (!hasAudio) {
        this.metaAudio = '无音轨';
      }
      this.metaOk = true;
    } catch (e) {
      LogUtil.warn(TAG, 'probe failed: ' + JSON.stringify(e));
    } finally {
      if (f !== null) {
        try {
          fileIo.closeSync(f);
        } catch (e2) {
        }
      }
    }
  }

  private profileLabel(): string {
    if (this.metaProfile === 1) {
      return 'Main';
    }
    if (this.metaProfile === 2) {
      return 'Main10';
    }
    if (this.metaProfile === 3) {
      return 'Main Still';
    }
    if (this.metaProfile === 4) {
      return 'RExt';
    }
    return '';
  }

  // Colour depth + chroma subsampling, read from hvcC (not guessable from the
  // sample entry, whose depth field is 0x18 even for 10-bit streams).
  private depthLabel(): string {
    if (!(this.metaDepth > 0)) {
      return '';
    }
    let ch: string = '4:2:0';
    if (this.metaChroma === 0) {
      ch = '4:0:0';
    } else if (this.metaChroma === 2) {
      ch = '4:2:2';
    } else if (this.metaChroma === 3) {
      ch = '4:4:4';
    }
    return this.metaDepth + '-bit ' + ch;
  }

  // HDR is the transfer characteristic, not the bit depth: 10-bit HEVC can be
  // plain SDR, and an 8-bit stream can still be HLG. primaries 9 = BT.2020.
  private hdrLabel(): string {
    if (this.metaXfer === 16) {
      return 'HDR10';
    }
    if (this.metaXfer === 18) {
      return 'HLG';
    }
    if (this.metaPrim === 9) {
      return 'BT.2020';
    }
    if (this.metaPrim === 1 || this.metaXfer === 1) {
      return 'SDR';
    }
    return '';
  }

  private gopLabel(): string {
    if (!(this.metaKeyframes > 0) || !(this.metaSamples > 0)) {
      return '';
    }
    const gop: number = this.metaSamples / this.metaKeyframes;
    return this.metaKeyframes + ' 帧 / GOP ' + (Math.round(gop * 10) / 10);
  }

  private sizeLabel(): string {
    if (!(this.fileLength > 0)) {
      return '大小 n/a';
    }
    const mb: number = this.fileLength / 1048576;
    return mb >= 0.95 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(this.fileLength / 1024)) + ' KB';
  }

  private bitrateLabel(): string {
    const sec: number = this.durationMs / 1000;
    if (this.metaVideoBps > 0) {
      const v: number = this.metaVideoBps / 1000000;
      return v.toFixed(v >= 10 ? 0 : 2) + ' Mbps';
    }
    // Common case: the encoder writes avgBitrate=0. The peak is still real, so
    // label it as a peak instead of pretending it is an average.
    if (this.metaVideoMax > 0) {
      const m: number = this.metaVideoMax / 1000000;
      return '峰值 ' + m.toFixed(m >= 10 ? 0 : 2) + ' Mbps';
    }
    if (!(sec > 0) || !(this.fileLength > 0)) {
      return '码率 n/a';
    }
    const mbps: number = this.fileLength * 8 / sec / 1000000;
    return '平均 ' + mbps.toFixed(mbps >= 10 ? 0 : 1) + ' Mbps';
  }


  // MEASURED ROOT CAUSE (R137): a Path's commands coordinates are PIXELS, not
  // vp. This device is 2 px per vp, so a 30-unit grid painted 15vp of ink at the
  // box's top-left: every icon was half size and sat in the top-left quadrant
  // (screenshot audit: ink centre -8.2vp/-7.9vp from the box centre, ink 12vp
  // where 26 was authored - exactly the "too small / not centred" reports).
  //
  // The fix scales the PATH COORDINATES numerically instead of scaling the node:
  // a linear scale about the origin keeps the ink's centre at the box centre
  // (the grid is authored centred on 15,15), needs no transform, no scale
  // anchor and no extra container.
  private scalePath(cmds: string, k: number): string {
    const re: RegExp = new RegExp('([a-zA-Z])([^a-zA-Z]*)', 'g');
    let out: string = '';
    let m: RegExpExecArray | null = re.exec(cmds);
    while (m !== null) {
      const cmd: string = m[1];
      const body: string = m[2];
      const nums: string[] = body.match(/-?\d*\.?\d+/g) || [];
      const isArc: boolean = cmd === 'a' || cmd === 'A';
      const vals: string[] = [];
      for (let i = 0; i < nums.length; i++) {
        const v: number = parseFloat(nums[i]);
        let sv: number = v * k;
        if (isArc) {
          // rx ry rot large-arc sweep dx dy: rot/flags must not scale.
          const pos: number = i % 7;
          sv = (pos === 0 || pos === 1 || pos === 5 || pos === 6) ? v * k : v;
        }
        vals.push('' + (Math.round(sv * 100) / 100));
      }
      out += cmd + vals.join(' ');
      m = re.exec(cmds);
    }
    return out;
  }

  // px per grid unit for a glyph meant to be `size` vp across on a 30-unit grid.
  private pathScaleFor(size: number, grid: number): number {
    return vp2px(1) * size / grid;
  }

  @Builder
  private metaSection(title: string) {
    Text(title)
      .fontSize(9)
      .fontColor(this.theme.faint)
      .letterSpacing(1.2)
      .margin({ top: 9, bottom: 1 })
  }

  @Builder
  private metaRow(label: string, value: string) {
    Row() {
      Text(label)
        .fontSize(9)
        .fontColor(this.theme.faint)
        .width(50)
      Text(value)
        .fontSize(10)
        .fontColor(this.theme.text)
        .layoutWeight(1)
    }
    .width('100%')
    .margin({ top: 2 })
    .alignItems(VerticalAlign.Top)
  }

  @Builder
  private glyph(cmds: string, size: number, color: string, stroke: number, filled: boolean = false) {
    Column() {
      Shape() {
        Path()
          .commands(this.scalePath(cmds, this.pathScaleFor(size, 30)))
          .fill(filled ? color : Color.Transparent)
          .stroke(filled ? Color.Transparent : color)
          // UNITS, per sdk/.../component/path.d.ts and shape.d.ts:
          //   Path.commands      -> "Default unit: px"
          //   Shape.strokeWidth  -> "Default unit: vp"
          // `stroke` is authored in GRID UNITS, so converting it to vp is
          // stroke * size / 30. This builder was accidentally left on the
          // BIG glyph formula (stroke * 2 = 2vp = 4px on an 18.9vp icon,
          // i.e. 21% of the icon width - the "still too thick" report).
          .strokeWidth(filled ? 0 : stroke * size / 30)
          .strokeLineCap(LineCapStyle.Round)
          .strokeLineJoin(LineJoinStyle.Round)
      }
      .width(size)
      .height(size)
    }
    .width(size)
    .height(size)
    // Box audit (level 3): the glyph's own drawing box, now exactly `size` vp.
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  private glyphBig(cmds: string, color: string, stroke: number, filled: boolean = false) {
    Column() {
      Shape() {
        Path()
          .commands(this.scalePath(cmds, this.pathScaleFor(40 * this.u(), 40)))
          .fill(filled ? color : Color.Transparent)
          .stroke(filled ? Color.Transparent : color)
          // Same unit rule; this grid is 40 and the box is 40 * u, so one
          // grid unit is u vp.
          .strokeWidth(filled ? 0 : stroke * this.u())
          .strokeLineCap(LineCapStyle.Round)
          .strokeLineJoin(LineJoinStyle.Round)
      }
      .width(40 * this.u())
      .height(40 * this.u())
    }
    .width(40 * this.u())
    .height(40 * this.u())
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }


  build() {
    // Centre-aligned root: the paused disc and the error panel use the real
    // geometry centre. The previous Bottom alignment placed EVERY child at the
    // bottom edge (this ArkUI build does not let a child's .align() override
    // Stack.alignContent), which is why the play disc sat under the frame.
    Stack({ alignContent: Alignment.Center }) {
      // Letterbox container: the SURFACE is the video's own aspect (contain), so
      // fullscreen never stretches the picture - the extra area stays theme.bg.
      // The frame itself is measured on this container below, not on the
      // surface, so gestures keep normalising against the visible box.
      Column() {
      XComponent({
        id: 'ohsidian-native-video',
        type: XComponentType.SURFACE,
        controller: this.controller
      })
        .width(this.videoFrameW() > 0 ? this.videoFrameW() : '100%')
        .height(this.videoFrameH() > 0 ? this.videoFrameH() : '100%')
        // The SURFACE stays a pure painting target. The transparent media
        // gesture layer above owns video-internal horizontal seek, vertical
        // volume and taps; the page outside the video keeps WebView gestures.
        .hitTestBehavior(HitTestMode.None)
        .focusable(false)
        .focusOnTouch(false)
        .onLoad(() => {
          const id: string = this.controller.getXComponentSurfaceId();
          const changed: boolean = id !== this.surfaceId;
          this.surfaceId = id;
          if (this.player !== null) {
            if (changed && id && this.playerState === 'initialized') {
              try {
                this.player.surfaceId = id;
              } catch (e) {
                LogUtil.warn(TAG, 'rebind surface failed: ' + JSON.stringify(e));
              }
            } else if (changed && id && (this.playerState === 'prepared' ||
              this.playerState === 'playing' || this.playerState === 'paused')) {
              // Some engine builds hand out a new surface id after a window
              // resize. Recreate the player, but keep the current position and
              // playing state instead of closing the overlay.
              this.retryResize('surface resized');
            }
            return;
          }
          this.initPlayer();
        })
        .zIndex(0)
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .hitTestBehavior(HitTestMode.None)
      .zIndex(0)

      // Media gesture zone: only this clipped video rectangle gets the
      // horizontal-seek / vertical-volume / double-tap layer. The page around
      // the video keeps its own WebView gestures; the native overlay does not
      // install global listeners.
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#00000000')
        .hitTestBehavior(HitTestMode.Default)
        .focusable(false)
        .focusOnTouch(false)
        .onTouch((event: TouchEvent) => {
          if (event.type === TouchType.Down && !this.controlsVisible) {
            // Reveal on touch-down so the first tap feels immediate; the
            // delayed single-tap handler then only confirms the reveal.
            this.showControls();
            this.userRevealedControls = true;
            this.revealPending = true;
          }
        })
        .gesture(
          // Directional pans instead of PanDirection.All: the framework then
          // arbitrates by axis, so a vertical drag is never mistaken for a
          // seek and the gesture starts after 8vp. GestureMask.IgnoreInternal
          // keeps the enclosing web page's own gesture recognisers from
          // stealing the drag once it has started on the video.
          GestureGroup(GestureMode.Exclusive,
            PanGesture({ fingers: 1, direction: PanDirection.Vertical, distance: 8 })
              .onActionStart(() => this.onGestureStart('volume'))
              .onActionUpdate((event: GestureEvent) => this.onGestureUpdate(event))
              .onActionEnd(() => this.onGestureEnd())
              .onActionCancel(() => this.onGestureCancel()),
            PanGesture({ fingers: 1, direction: PanDirection.Horizontal, distance: 8 })
              .onActionStart(() => this.onGestureStart('seek'))
              .onActionUpdate((event: GestureEvent) => this.onGestureUpdate(event))
              .onActionEnd(() => this.onGestureEnd())
              .onActionCancel(() => this.onGestureCancel()),
            // Hold anywhere on the picture = temporary 2x, release restores the
            // rate picked in the menu. This used to live on the tiny speed cell,
            // where bindMenu competed for the same long press and it almost
            // never fired. 450ms is long enough not to fight a tap (<450ms) and
            // short enough to feel immediate; a drag moves past 8vp first, so the
            // pans above still win.
            LongPressGesture({ repeat: false, duration: 450 })
              .onAction(() => this.beginBoost())
              .onActionEnd(() => this.endBoost())
              .onActionCancel(() => this.endBoost()),
            TapGesture({ count: 2, fingers: 1 })
              .onAction((event: GestureEvent) => this.onDoubleTapAction(event)),
            TapGesture({ count: 1, fingers: 1 })
              .onAction(() => this.onSingleTap())
          ),
          GestureMask.IgnoreInternal
        )
        .onHover((isHover: boolean) => this.onHoverChanged(isHover))
        .zIndex(1)

      // Source switch cover. The XComponent surface still holds the PREVIOUS
      // video's last frame until the new decoder presents one, so re-init
      // without a cover reads as "old clip flashes, then the new one". Opaque
      // theme.bg + a muted caption, removed on the new file's first 'playing'.
      if (this.switching || this.resizeCover) {
        Column() {
          Text(this.switching ? '载入中…' : '正在适配…')
            .fontColor(MEDIA_INK)
            .fontSize(12)
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .backgroundColor(MEDIA_VOID)
        .hitTestBehavior(HitTestMode.Default)
        // Above the transport: the cover is opaque, and while it was zIndex 2
        // the play disc (3), bar (4), boost badge (5) and HUD (6) were painted
        // ON TOP of it - controls floating on a blank panel, and the disc even
        // accepted taps while the player was being rebuilt. Sitting on top also
        // means taps during a rebuild land on the cover instead of seek/play.
        .zIndex(8)
      }

      if (this.showDebug) {
        // EASTER EGG: long-press the timecode. Everything here is parsed from
        // the real MP4 container (probeMedia). Laid out as a diagnostics table -
        // section label + label/value rows - instead of five loose lines: the
        // numbers line up, the eye can scan, and it still fits in a narrow card
        // (maxWidth 280, never a full-width strip).
        Column() {
          Column() {
            Row() {
              Text((this.metaCodec ? this.metaCodec : '视频') +
                (this.profileLabel() ? ' ' + this.profileLabel() : ''))
                .fontSize(12)
                .fontColor(this.theme.text)
                .fontWeight(FontWeight.Medium)
              Blank()
              Text(this.metaW > 0 ? this.metaW + '×' + this.metaH : '')
                .fontSize(11)
                .fontColor(this.theme.muted)
            }
            .width('100%')

            this.metaSection('画面')
            this.metaRow('帧率', this.metaFps > 0 ?
              (this.metaFps.toFixed(2) + ' fps' + (this.metaVfr ? ' · VFR' : '')) : 'n/a')
            this.metaRow('色彩', (this.depthLabel() ? this.depthLabel() : 'n/a') +
              (this.hdrLabel() ? ' · ' + this.hdrLabel() : ''))
            this.metaRow('码率', this.bitrateLabel())
            if (this.gopLabel()) {
              this.metaRow('关键帧', this.gopLabel())
            }

            this.metaSection('音频')
            this.metaRow('音轨', this.metaAudio ? this.metaAudio : '无')

            this.metaSection('文件')
            this.metaRow('时长', this.formatTime(this.durationMs))
            this.metaRow('大小', this.sizeLabel())

            Text(Math.round(this.lastAreaW) + '×' + Math.round(this.lastAreaH) +
              ' · k=' + this.u().toFixed(3) + ' · v158')
              .fontSize(9)
              .fontColor(this.theme.faint)
              .margin({ top: 9 })
          }
          .alignItems(HorizontalAlign.Start)
          .constraintSize({ maxWidth: 280 })
          .padding({ left: 12, right: 14, top: 10, bottom: 10 })
          .backgroundColor(this.theme.panel)
          .borderRadius(this.theme.radiusM)
          .border({ width: 1, color: this.theme.border })
          .shadow({ radius: 16, color: '#33000000', offsetX: 0, offsetY: 6 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Start)
        .alignItems(HorizontalAlign.Start)
        .padding(12)
        .hitTestBehavior(HitTestMode.None)
        .zIndex(9)
      }

      if (this.gestureHint) {
        // Full-size wrapper (justifyContent) instead of a child .align(): the
        // HUD must sit in the top third, clear of the transport, and the
        // wrapper is hit-test transparent so it never eats a tap.
        Column() {
          Text(this.gestureHint)
            .fontColor(this.theme.onAccent)
            .fontSize(12)
            .padding({ left: 10, right: 10, top: 4, bottom: 4 })
            .backgroundColor(this.theme.accent)
            .borderRadius(this.theme.radiusS)
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Start)
        .alignItems(HorizontalAlign.Center)
        .padding({ top: 14 })
        .hitTestBehavior(HitTestMode.None)
        .zIndex(6)
      }

      if (this.errorText) {
        Column() {
          Text('原生播放器无法播放')
            .fontColor(this.theme.text)
            .fontSize(15)
          Text(this.errorText)
            .fontColor(this.theme.error)
            .fontSize(12)
            .margin({ top: 8 })
            .maxLines(3)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text('重试')
            .fontColor(this.theme.accent)
            .fontSize(13)
            .margin({ top: 10 })
            .padding({ left: 14, right: 14, top: 5, bottom: 5 })
            .border({ width: 1, color: this.theme.border })
            .borderRadius(this.theme.radiusS)
            .onClick(() => this.retryManual())
            .accessibilityText('重试播放')
        }
        .width('82%')
        .padding(14)
        .backgroundColor(this.theme.panel)
        .borderRadius(this.theme.radiusL)
        .alignItems(HorizontalAlign.Center)
        .hitTestBehavior(HitTestMode.Default)
        .zIndex(10)
      }

      if (this.boosting) {
        Column() {
          Text('2×')
            .fontColor(this.theme.onAccent)
            .fontSize(12)
            .padding({ left: 8, right: 8, top: 3, bottom: 3 })
            .backgroundColor(this.theme.accent)
            .borderRadius(this.theme.radiusS)
            .margin({ top: 10, right: 10 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Start)
        .alignItems(HorizontalAlign.End)
        .hitTestBehavior(HitTestMode.None)
        .zIndex(5)
      }

      // Paused state: one big centred disc, exactly where the poster's disc
      // sits (same centre, same triangle), so opening the surface never shifts
      // the "play" affordance. 64vp on touch, 44vp once a mouse has hovered.
      //
      // Placement uses a full-size Column and the CONTAINER's justifyContent /
      // alignItems - not a child .align() and not measured lastAreaW/H. That
      // combination is what makes it independent of Stack alignment (which the
      // device build ignored) and immediate on a fullscreen transition (no
      // wait for the next onAreaChange).
      if (!this.playing && !this.errorText && !this.switching && !this.resizeCover) {
        Column() {
          Column() {
            // 40-unit glyphs, zero transform: the paused triangle is ~20x26 in
            // the 64vp disc, matching the poster's 19.8x23.2 border triangle.
            if (this.completed) {
              this.glyphBig(ICON_REPLAY_BIG, MEDIA_INK, 1)
            } else {
              this.glyphBig(ICON_PLAY_BIG, MEDIA_INK, 0, true)
            }
          }
          .width(this.discSize())
          .height(this.discSize())
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .borderRadius(this.discSize() / 2)
          .backgroundColor(MEDIA_SCRIM)
          .border({ width: 1, color: MEDIA_HAIRLINE })
                .onClick(() => this.togglePlay())
          .accessibilityText(this.completed ? '重播' : '播放')
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        // No clip compensation here: the poster disc (DOM, CSS 50%/50%) is the
        // reference the user calls correct, and it centres on the VIDEO RECT.
        // This frame IS the video rect (the clip frame crops outside it), so any
        // extra bottom padding lifts the disc above the poster's centre - that
        // was the "disc sits high" report.
        .hitTestBehavior(HitTestMode.None)
        .zIndex(3)
      }

      // Transport: Obsidian's own player is a thin overlay with glyph icons, so
      // the controls here are stroked Lucide-shaped paths (same 24-unit grid,
      // 1.7vp stroke, rounded caps) instead of emoji/text characters - mixing
      // ❚❚ with 🔇 and ✕ was the "controls look foreign" complaint. The bar
      // only exists while the pointer/touch is on the video and fades out 3 s
      // after uninterrupted playback; a hairline top border separates it from
      // the frame without adding a second panel colour. Sizes come from
      if (this.controlsVisible || this.errorText || this.dragging || this.boosting) {
        // Full-size wrapper + container justifyContent: the bar hugs the bottom
        // edge without measuring the frame, so a fullscreen transition moves it
        // on the same frame instead of waiting for onAreaChange. The 96% pill is
        // centred by the wrapper - same axis as the disc.
        Column() {
          Row() {
          Column() {
            if (this.completed) {
              this.glyph(ICON_REPLAY, this.glyphSize(), this.theme.text, 1)
            } else if (this.playing) {
              this.glyph(ICON_PAUSE, this.glyphSize(), this.theme.text, 0, true)
            } else {
              this.glyph(ICON_PLAY, this.playGlyphSize(), this.theme.text, 0, true)
            }
          }
          .width(this.btnSize())
          .height(this.barHeight())
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .onClick(() => this.togglePlay())
          .accessibilityText(this.completed ? '重播' : (this.playing ? '暂停' : '播放'))

          Text(this.formatTime(this.positionMs) + ' / ' + this.formatTime(this.durationMs))
            .fontColor(this.theme.muted)
            .fontSize(this.timeFontSize())
            .width(this.timeWidth())
            // "00:00 / 00:00" at this font is wider than the old 0.098W box, so
            // the text ran to the edge and could clip. Widen the box and pin it
            // to one line so it can never wrap the pill's height.
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Clip })
            .textAlign(TextAlign.Center)
            // Long-press the timecode to toggle a diagnostics readout. It is the
            // only way to tell "the new build is not installed" apart from "the
            // layout numbers are still wrong" without hdc.
            .gesture(LongPressGesture({ repeat: false, duration: 600 })
              .onAction(() => {
                this.showDebug = !this.showDebug;
              }))
          Slider({
            value: this.positionMs,
            min: 0,
            max: Math.max(1, this.durationMs)
          })
            .layoutWeight(1)
            .trackThickness(this.trackThickness())
            .trackColor(this.theme.interactive)
            .selectedColor(this.theme.accent)
            .blockColor(this.theme.accent)
            .blockSize({ width: this.blockSizePx(), height: this.blockSizePx() })
            .margin({ left: 2, right: 8 })
            .onChange((value: number, mode: SliderChangeMode) => this.onSliderChange(value, mode))
            .accessibilityText('播放进度')
          Column() {
            Text(this.speedLabel())
              .fontSize(this.timeFontSize())
              .fontColor(this.boosting ? this.theme.accent : this.theme.muted)
          }
          // Tap = open the rate menu. The temporary 2x boost moved to a long
          // press on the picture: bindMenu and a LongPressGesture on the same
          // node fought each other, so the boost almost never fired here.
          .width(this.btnSize())
          .height(this.barHeight())
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .bindMenu([
            { value: '1×', action: () => this.setPlaybackSpeed(1) },
            { value: '1.5×', action: () => this.setPlaybackSpeed(1.5) },
            { value: '2×', action: () => this.setPlaybackSpeed(2) },
            { value: '3×', action: () => this.setPlaybackSpeed(3) }
          ])
          .accessibilityText('播放速度（点按选择；画面长按可临时加速）')
          Column() {
            if (this.muted) {
              this.glyph(ICON_VOLUME_MUTE, this.glyphSizeRight(), this.theme.muted, 1)
            } else {
              this.glyph(ICON_VOLUME, this.glyphSizeRight(), this.theme.text, 1)
            }
          }
          .width(this.btnSizeRight())
          .height(this.barHeight())
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .onClick(() => this.toggleMute())
          .accessibilityText(this.muted ? '取消静音' : '静音')
          Column() {
            if (this.fullscreen) {
              this.glyph(ICON_MINIMIZE, this.glyphSizeTiny(), this.theme.text, 1)
            } else {
              this.glyph(ICON_MAXIMIZE, this.glyphSizeTiny(), this.theme.text, 1)
            }
          }
          .width(this.btnSizeRight())
          .height(this.barHeight())
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .onClick(() => this.toggleFullscreen())
          .accessibilityText(this.fullscreen ? '退出全屏' : '全屏')
          Column() {
            this.glyph(ICON_CLOSE, this.glyphSizeTiny(), this.theme.muted, 1)
          }
          .width(this.btnSizeRight())
          .height(this.barHeight())
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .onClick(() => this.close())
          .accessibilityText('关闭播放器')
        }
          // Compact frosted pill: 86% instead of 96% so it reads as one object
          // floating over the picture, glass instead of a flat slab, soft
          // shadow and a 1px highlight edge. Same proven Column centring.
          .width('86%')
          .constraintSize({ maxWidth: 620 })
          .height(this.barHeight())
          .padding({ left: 6, right: 6 })
          .backgroundColor(this.theme.bar)
          // Small rounded rectangle, as requested. Visible white outline while
          // the box audit is on: the bar's own extent is the outer reference.
          .borderRadius(this.theme.radiusM)
          .alignItems(VerticalAlign.Center)
          .hitTestBehavior(HitTestMode.Default)
          .onHover((isHover: boolean) => this.onHoverChanged(isHover))
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.End)
        .alignItems(HorizontalAlign.Center)
        .padding({ bottom: this.barBottomInset() })
        .hitTestBehavior(HitTestMode.None)
        .zIndex(4)
      }
    }
    .width('100%')
    .height('100%')
    // The FRAME is measured here (the whole overlay box), not on the surface:
    // the surface is letterboxed to the video aspect and would otherwise feed
    // the gesture/volume normalisation a smaller size than the user sees.
    .onAreaChange((oldValue: Area, newValue: Area) => {
      const w: number = Number(newValue.width);
      const h: number = Number(newValue.height);
      LogUtil.info(TAG, 'layout area=' + w + 'x' + h + ' pointer=' + this.compactControls() +
        ' bar=' + this.barHeight() + ' disc=' + this.discSize() + ' aspect=' + this.videoAspect);
      if (w > 1 && h > 1) {
        // Only adopt a new measurement when the box really moved. Sub-vp jitter
        // (the rect is computed from a scaled CSS box) fired this at ~60Hz and
        // every write rebuilt the whole overlay subtree.
        const moved: boolean = Math.abs(w - this.lastAreaW) > 1 ||
          Math.abs(h - this.lastAreaH) > 1;
        this.lastAreaW = w;
        this.lastAreaH = h;
        this.syncUnit();
        if (!moved) {
          return;
        }
        // The surface still holds a frame rendered for the OLD box, so between
        // this event and the rebuilt surface the picture is stretched. Cover
        // that interval instead of showing a distorted frame.
        const rebuilding: boolean = this.player !== null &&
          (this.playerState === 'prepared' || this.playerState === 'playing' ||
            this.playerState === 'paused');
        if (rebuilding) {
          this.resizeCover = true;
          // The cover must never outlive a failed rebuild: prepare can stall
          // without ever reaching playing/paused, and a stuck opaque cover reads
          // as "the video disappeared".
          if (this.coverTimer >= 0) {
            clearTimeout(this.coverTimer);
          }
          this.coverTimer = setTimeout(() => {
            this.coverTimer = -1;
            this.resizeCover = false;
          }, 2500);
        }
      }
      // Surface size follows the aspect, so a window/fullscreen change still
      // triggers the debounced rebuild path.
      this.scheduleSurfaceResize(this.videoFrameW() > 0 ? this.videoFrameW() : w,
        this.videoFrameH() > 0 ? this.videoFrameH() : h);
    })
    .backgroundColor(this.theme.bg)
    .focusable(false)
    .focusOnTouch(false)
    // Default: the media layer inside consumes the touch. Transparent here
    // used to let the same tap travel to any sibling of this frame (the page
    // behind it), which is exactly the "tap once and the video closes" path.
    .hitTestBehavior(HitTestMode.Default)
  }
}
