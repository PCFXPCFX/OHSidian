/* ==========================================================================
 * OHSidian ink layer — P1/P2 of docs/STYLUS-PEN.md
 *
 * This block is prepended to Obsidian's app.js by scripts/update-obsidian.mjs.
 * It owns everything the web layer can do for the pen: capture, pressure
 * merge, note/PDF overlay canvases, the ink document + sidecar store, undo,
 * the toolbar and the write-back request to ArkTS.
 *
 * Coordinates:
 *   markdown  "md:abs"        CSS px inside .markdown-preview-sizer (top-left origin)
 *   pdf       "pdf:<page>"    PDF user space points (bottom-left origin)
 *
 * The renderer never assumes that the engine forwards pressure: if the DOM
 * pressure is constant it asks ArkTS for the device-rate sample stream
 * (action penSamplesOn) and matches samples by time and position.
 * ========================================================================== */
window.__ohsidianInkPatch = "39";
var OHSIDIAN_INK_REV = "59";
(function () {
  "use strict";

  var ROOT = ".obsidian/ohsidian-ink";
  var DOCS = ROOT + "/docs";
  var BACKUPS = ROOT + "/backups";
  var EXPORTS = ROOT + "/exports";
  var CSS_ID = "ohsidian-ink-css";
  var TOOLBAR_ID = "ohsidian-ink-toolbar";
  var MENU_ID = "ohsidian-ink-menu";
  var CLEAR_ID = "ohsidian-ink-clear";
  var LASSO_ID = "ohsidian-ink-lasso";
  var SEL_ID = "ohsidian-ink-sel";
  var SELBAR_ID = "ohsidian-ink-selbar";
  var GUARD_ID = "ohsidian-palm-guard";

  var state = {
    app: null,
    installed: false,
    enabled: true,
    barMode: "compact",
    barPos: "br",
    barExpanded: false,
    barTimer: 0,
    lastBarSig: "",
    traceCount: 0,
    probeCount: 0,
    quiet: true,
    blockEdge: true,
    tool: "pointer",
    lastPenTool: "pen",
    color: "#1f1f1f",
    hlColor: "#ffd54a",
    colorAuto: true,
    palette: ["#1f1f1f", "#d32f2f", "#1565c0"],
    hlPalette: ["#ffd54a", "#a5d6a7", "#90caf9"],
    barItems: ["pen", "highlighter", "eraser", "color"],
    width: 2.4,
    hlWidth: 16,
    hlStraight: true,
    holdStraight: true,
    shapeMode: false,
    shapeSupported: false,
    shapeEvents: 0,
    shapeApplied: 0,
    predictWanted: false,
    predictSupported: false,
    predictEvents: 0,
    penPredict: null,
    predictClearTimer: 0,
    pressureEraser: true,
    pressureEraserSens: 60,
    eraserMode: "partial",
    eraserOnlyHl: false,
    curve: "linear",
    palm: true,
    fingerDraw: false,
    pressureTapPref: "auto",
    pressureMin: 0,
    pressureGamma: 1,
    pressureMode: "unknown", // unknown | real | fake
    pressureTapOn: false,
    domPressureValues: {},
    domPressureCount: 0,
    pointerTypes: {},
    coalescedMax: 0,
    penNativeActive: false,
    penNativeAt: 0,
    penNativeTimer: 0,
    lastPenActivity: 0,
    latencyT0: 0,
    lastLatency: 0,
    latencyCaptured: false,
    probeCapture: false,
    lastPenAt: 0,
    lastPenType: "",
    lastPenDetail: null,
    lastGesture: "",
    lastGestureAt: 0,
    gestureCount: 0,
    surfaces: [],
    activeLeaf: null,
    activeSurface: null,
    ambientSurfaceTimer: 0,
    surfaceWaitTimer: 0,
    pdfRetryTimer: 0,
    pdfRetryTries: 0,
    surfaceWaitTries: 0,
    awaitGesture: null,
    blockedPointerId: null,
    penUiSwipe: null,
    penClickSuppressUntil: 0,
    lastPenSeen: 0,
    lastPenBlockLog: 0,
    lastToolMode: null,
    pdfProbeDone: false,
    active: null,
    selection: null,
    lassoPts: null,
    toolbarBuilt: false,
    menuOpen: false,
    ipcReady: false,
    ipcTriedAt: 0,
    ipcSent: 0,
    ipcRecv: 0,
    // Time-based so a renderer reload (which resets local counters) can never
    // fall below the ArkTS page's lastPdfSeq: the page outlives the document.
    seq: Date.now(),
    stylusInfo: null,
    pdfPending: {},
    pdfPreviewPending: {},
    pdfInFlight: false,
    pdfAutoTimer: 0,
    pdfAutoSurface: null,
    pdfAutoDirty: false,
    pdfAutoFail: 0,
    pdfBackup: "",
    pdfWriteWhen: "leave",
    pdfStyle: "ink",
    lastPdfWriteAt: 0,
    pdfWriteCount: 0,
    pdfDirty: {},
    pdfFlushRunning: false,
    offsetX: 0,
    offsetY: 0,
    simPressure: true,
    driftNotified: {},
    noSurfaceNotified: false,
    pendingTool: null,
    probeInstalled: false
  };

  function log() {
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift("[OHSidian ink]");
      console.log.apply(console, a);
    } catch (e) {}
  }

  function warn() {
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift("[OHSidian ink]");
      console.warn.apply(console, a);
    } catch (e) {}
  }

  function notice(msg, ms) {
    // app.js has a top-level `Notice` binding; the window copy is a fallback
    // for the (unlikely) case that the renderer is reloaded with a different
    // module scope.
    try {
      new Notice(msg, ms || 4000);
      return;
    } catch (e) {}
    try {
      if (window.Notice) {
        new window.Notice(msg, ms || 4000);
        return;
      }
    } catch (e2) {}
    try {
      console.log("[OHSidian ink notice]", msg);
    } catch (e3) {}
  }

  function clamp(v, a, b) {
    return v < a ? a : (v > b ? b : v);
  }

  /**
   * Quiet status: Obsidian's own feedback language is a local, low-noise hint,
   * not a modal or a Notice per action. Routine results go to the tiny toast
   * above the nib; only errors still use Notice.
   */
  var inkStatusTimer = 0;
  function inkStatus(msg, ms) {
    if (!state.quiet) {
      notice(msg, ms || 2200);
      return;
    }
    try {
      var el = document.getElementById("ohsidian-ink-toast");
      if (!el) {
        console.log("[OHSidian ink]", msg);
        return;
      }
      el.textContent = msg;
      el.classList.add("is-visible");
      if (inkStatusTimer) clearTimeout(inkStatusTimer);
      inkStatusTimer = setTimeout(function () {
        try { el.classList.remove("is-visible"); } catch (e) {}
      }, ms || 1800);
    } catch (e) {
      console.log("[OHSidian ink]", msg);
    }
  }

  function noticeError(msg, ms) {
    notice(msg, ms || 7000);
  }

  /**
   * Renderer -> ArkTS diagnostic line. HiLog does not capture `console.*` from
   * the web renderer, so key UI transitions are forwarded over the existing
   * loopback IPC and printed under the `InkUI` tag.
   */
  /**
   * Tell ArkTS whether the current tool is a pen tool. ArkTS then blocks
   * finger/palm hit-testing entirely while a pen tool is selected, so palm
   * swipes cannot reach Obsidian at all. Selecting pointer sends hand mode.
   */
  function inkToolMode(tool) {
    var isPen = tool === "pen" || tool === "highlighter" || tool === "eraser";
    if (state.lastToolMode === isPen) return;
    state.lastToolMode = isPen;
    try {
      if (typeof window.__ohsidianNativeSend === "function") {
        var okMode = window.__ohsidianNativeSend({
          action: "inkTool",
          tool: isPen ? "pen" : "pointer",
          ts: Date.now()
        });
        if (okMode === false) state.lastToolMode = null;
      }
    } catch (e) {
      state.lastToolMode = null;
    }
  }

  function inkTrace(event, detail) {    if (state.traceCount > 400) return;
    state.traceCount++;
    try {
      if (typeof window.__ohsidianNativeSend !== "function") return;
      window.__ohsidianNativeSend({
        action: "inkLog",
        event: String(event || ""),
        detail: detail ? JSON.stringify(detail) : "",
        ts: Date.now()
      });
    } catch (e) {}
  }

  function clamp01(v) {
    if (typeof v !== "number" || v !== v) return 0;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function nowMs() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  /* OHSIDIAN_DEV_PROBE_START */
  /**
   * Optional dev-agent hook. Release builds do not inject
   * scripts/patches/ohsidian-probe.js, so this is a no-op and no probe data is
   * produced. Agent builds install window.__ohsidianProbeHooks.emit.
   */
  function probeHook(event, data) {
    try {
      var h = window.__ohsidianProbeHooks;
      if (h && typeof h.emit === "function") {
        // The renderer clock travels with the payload: native hilog prefixes
        // carry device time but seconds-level `date` is all hdc gives us, and
        // the harness needs per-event ordering across scene windows.
        if (data && typeof data === "object") data._ts = Date.now();
        h.emit(event, data || {});
      }
    } catch (e) {}
  }
  /* OHSIDIAN_DEV_PROBE_END */

  function uid() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function fnv(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function inkKey(rel) {
    return fnv(rel) + "-" + rel.length.toString(36);
  }

  function hexToInt(hex) {
    try {
      var s = String(hex || "").replace("#", "");
      if (s.length === 3) {
        s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
      }
      if (s.length !== 6) return 0x1f1f1f;
      return parseInt(s, 16) & 0xffffff;
    } catch (e) {
      return 0x1f1f1f;
    }
  }

  /**
   * PDF Kit annotation colors are documented as 0xBBGGRR (0xFF0000 = blue),
   * i.e. the opposite byte order of CSS. Convert instead of reusing the CSS
   * integer, otherwise red pen turns blue and a yellow highlighter bakes as a
   * saturated blue marker.
   */
  function hexToPdfColor(hex) {
    var c = hexToInt(hex);
    var r = (c >> 16) & 0xff;
    var g = (c >> 8) & 0xff;
    var b = c & 0xff;
    return ((b << 16) | (g << 8) | r) & 0xffffff;
  }

  function safeName(rel) {
    var base = String(rel || "drawing").split("/").pop() || "drawing";
    return base.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_");
  }

  // ---------------------------------------------------------------------
  // Theme-aware ink colour
  // ---------------------------------------------------------------------
  function inkParseColor(s) {
    try {
      var m = /rgba?\(([^)]+)\)/.exec(String(s || ""));
      if (!m) return null;
      var p = m[1].split(",");
      return {
        r: Number(p[0]) || 0,
        g: Number(p[1]) || 0,
        b: Number(p[2]) || 0,
        a: p.length > 3 ? Number(p[3]) : 1
      };
    } catch (e) {
      return null;
    }
  }

  function inkLinear(c) {
    var v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function inkBgRgb(el) {
    var node = el;
    var guard = 0;
    while (node && guard < 10) {
      try {
        var c = inkParseColor(getComputedStyle(node).backgroundColor);
        if (c && c.a > 0.12) return c;
      } catch (e) {}
      node = node.parentElement;
      guard++;
    }
    try {
      return inkParseColor(getComputedStyle(document.body).backgroundColor);
    } catch (e2) {
      return null;
    }
  }

  /**
   * Dark note/PDF background -> light ink; light background -> dark ink. The
   * old fixed #1f1f1f was invisible on the dark theme, which is exactly what
   * the first device test reported.
   */
  function inkAutoColor(surface) {
    var el = null;
    var rgb = null;
    try {
      if (surface && surface.kind === "pdf") {
        var idx = parseInt(String(surface.currentSpace || "pdf:0").slice(4), 10) || 0;
        var entry = surface.pages ? surface.pages[idx] : null;
        el = entry && entry.pageEl ? entry.pageEl : surface.container;
        if (el) {
          var cs = getComputedStyle(el);
          var varColor = inkParseColor((cs.getPropertyValue("--pdf-page-background") || "").trim());
          rgb = varColor && varColor.a > 0.1 ? varColor : inkParseColor(cs.backgroundColor);
          if (!rgb || rgb.a <= 0.1) {
            // A PDF page is white unless the viewer explicitly themes it.
            rgb = { r: 255, g: 255, b: 255, a: 1 };
          }
        }
      } else if (surface && surface.kind === "pdfembed") {
        el = surface.pageEl;
        if (el) {
          var ecs = getComputedStyle(el);
          var evc = inkParseColor((ecs.getPropertyValue("--pdf-page-background") || "").trim());
          rgb = evc && evc.a > 0.1 ? evc : inkParseColor(ecs.backgroundColor);
          if (!rgb || rgb.a <= 0.1) rgb = { r: 255, g: 255, b: 255, a: 1 };
        }
      } else if (surface && surface.kind === "canvas") {
        el = surface.wrapper || surface.canvas;
        rgb = inkBgRgb(el);
      } else if (surface) {
        el = surface.sizer || surface.rootEl;
        rgb = inkBgRgb(el);
      }
    } catch (e) {}
    if (!rgb) rgb = inkBgRgb(el);
    if (!rgb) return "#1f1f1f";
    var lum = 0.2126 * inkLinear(rgb.r) + 0.7152 * inkLinear(rgb.g) + 0.0722 * inkLinear(rgb.b);
    return lum < 0.42 ? "#e8e8e8" : "#1f1f1f";
  }

  /** Repaint strokes that were written with automatic colour (theme switch). */
  function inkRefreshAutoColors(surface) {
    var s = surface;
    if (!s) return;
    var doc = docFor(s);
    if (!doc) return;
    var color = inkAutoColor(s);
    var changed = 0;
    for (var i = 0; i < doc.strokes.length; i++) {
      var st = doc.strokes[i];
      if (!st.auto || st.tool === "highlighter" || st.baked) continue;
      if (st.color !== color) {
        st.color = color;
        changed++;
      }
    }
    if (changed) {
      saveSoon(doc);
      s.redraw();
    }
  }

  function inkRecolorSpace(surface) {
    var s = surface || state.activeSurface || activeSurfaceNow();
    if (!s) return;
    var doc = docFor(s);
    if (!doc) return;
    var space = inkSpaceOf(s, null);
    if (!space) return;
    var before = snapshotSpace(doc, space);
    var color = inkAutoColor(s);
    var changed = 0;
    for (var i = 0; i < doc.strokes.length; i++) {
      var st = doc.strokes[i];
      if (st.space !== space || st.tool === "highlighter") continue;
      if (st.color !== color) {
        st.color = color;
        st.auto = true;
        changed++;
      }
    }
    if (!changed) {
      inkStatus("当前页墨色已与主题一致");
      return;
    }
    doc.strokes = doc.strokes;
    pushHistory(doc, space, before);
    saveSoon(doc);
    scheduleRedraw();
    inkStatus("已按主题重新着色 " + changed + " 笔（可撤销）");  }

  // ---------------------------------------------------------------------
  // UI preferences: reuse the shared file touch-mode.js owns.
  // ---------------------------------------------------------------------
  function readPrefs() {
    try {
      if (typeof window.ohsidianReadUiPrefs === "function") return window.ohsidianReadUiPrefs() || {};
    } catch (e) {}
    return {};
  }

  function writePrefs(obj) {
    try {
      if (typeof window.ohsidianWriteUiPrefs === "function") return window.ohsidianWriteUiPrefs(obj);
    } catch (e) {}
    return false;
  }

  function pref(key, dflt) {
    var p = readPrefs();
    return p[key] === undefined ? dflt : p[key];
  }

  function setPref(key, value) {
    var p = readPrefs();
    p[key] = value;
    probeHook("inkPref", { key: key, value: value });
    return writePrefs(p);
  }

  function loadPrefs() {
    // v20: handwriting mode is opt-in. Migrate existing installs once so the
    // default is off, then respect the user's choice.
    if (pref("inkDefaultOffMigrated", false) !== true) {
      setPref("inkEnabled", false);
      setPref("inkDefaultOffMigrated", true);
    }
    if (pref("inkPdfKeepMigrated", false) !== true) {
      // Obsidian's pdf.js renders /Ink polylines with stroke="transparent"
      // and ships no .inkAnnotation CSS, so hiding the overlay after a write
      // makes the ink look lost. Keep the overlay as the visible layer and
      // treat the PDF annotation as the portable copy.
      if (pref("inkPdfAfterBake", "hide") === "hide") {
        setPref("inkPdfAfterBake", "keep");
      }
      setPref("inkPdfKeepMigrated", true);
    }
    if (pref("inkDoubleTapMigrated", false) !== true) {
      // The old default toggled eraser. Wake the toolbar instead, which is
      // what a double-tap on the barrel is for in day-to-day writing.
      if (pref("inkDoubleTap", "pen-eraser") === "pen-eraser") {
        setPref("inkDoubleTap", "wake");
      }
      setPref("inkDoubleTapMigrated", true);
    }
    if (pref("inkDoubleTapRestore", false) !== true) {
      // v24: users asked for the original quick pen↔eraser toggle back. The
      // "wake" default made a double-tap look like a no-op whenever the
      // toolbar was already open. Restore it once; the setting stays live.
      if (pref("inkDoubleTap", "wake") === "wake") {
        setPref("inkDoubleTap", "pen-eraser");
      }
      setPref("inkDoubleTapRestore", true);
    }
    state.enabled = pref("inkEnabled", false) === true;
    state.eraserPx = Number(pref("inkEraserPx", 12)) || 12;
    if (state.eraserPx < 6) state.eraserPx = 6;
    if (state.eraserPx > 32) state.eraserPx = 32;
    state.barMode = pref("inkBarMode", "compact");
    if (state.barMode !== "auto" && state.barMode !== "compact" && state.barMode !== "always") {
      state.barMode = "compact";
    }
    state.barPos = pref("inkBarPos", "br") === "bl" ? "bl" : "br";
    state.quiet = pref("inkQuiet", true) !== false;
    state.cursorEnabled = pref("inkCursor", true) !== false;
    state.blockEdge = pref("inkBlockEdge", true) !== false;
    state.curve = pref("inkCurve", "linear");
    // Pressure curve: a dead zone at the start plus a gamma exponent. Older
    // builds only stored the preset name; migrate those once.
    var pm = pref("inkPressureMin", null);
    var pg = pref("inkPressureGamma", null);
    if (pm === null || pm === undefined) {
      if (state.curve === "soft") { state.pressureMin = 0; state.pressureGamma = 0.72; }
      else if (state.curve === "hard") { state.pressureMin = 0.06; state.pressureGamma = 1.4; }
      else { state.pressureMin = 0; state.pressureGamma = 1; }
    } else {
      state.pressureMin = clamp(Number(pm) || 0, 0, 0.6);
      state.pressureGamma = clamp(Number(pg) || 1, 0.4, 2.6);
    }
    state.palm = pref("inkPalm", true) !== false;
    state.fingerDraw = pref("inkFingerDraw", false) === true;
    // The device agent has no pen injection (uitest exposes touch only), so
    // the agent build lets a slow touch swipe exercise the real capture ->
    // overlay -> write-back path. Release builds are unchanged.
    if (window.__ohsidianAgentBuild) {
      // Gesture-test mode: hand tool, no finger ink, so horizontal swipes reach
      // Obsidian instead of drawing. Set __ohsidianAgentPen=true to restore the
      // pen/finger-draw test override.
      if (window.__ohsidianAgentPen === true) {
        state.fingerDraw = true;
        if (state.tool === "pointer") state.tool = "pen";
      } else {
        state.fingerDraw = false;
        state.tool = "pointer";
      }
    }
    state.pressureTapPref = pref("inkPressureTap", "auto");
    state.width = Number(pref("inkWidth", 2.4)) || 2.4;
    state.hlWidth = Number(pref("inkHlWidth", 16)) || 16;
    state.hlStraight = pref("inkHlStraight", true) !== false;
    state.holdStraight = pref("inkHoldStraight", true) !== false;
    state.shapeMode = pref("inkShapeMode", false) === true;
    state.predictWanted = pref("inkPredict", false) === true;
    state.pressureEraser = pref("inkPressureEraser", true) !== false;
    state.pressureEraserSens = clamp(Number(pref("inkPressureEraserSens", 60)) || 0, 0, 100);
    state.eraserMode = pref("inkEraserMode", "partial") === "stroke" ? "stroke" : "partial";
    state.eraserOnlyHl = pref("inkEraserOnlyHl", false) === true;
    state.color = pref("inkColor", "#1f1f1f");
    state.hlColor = pref("inkHlColor", "#ffd54a");
    state.colorAuto = pref("inkColorAuto", true) !== false;
    var paletteDefault = ["#1f1f1f", "#d32f2f", "#1565c0"];
    var paletteSaved = pref("inkPalette", null);
    var palette = [];
    if (Array.isArray(paletteSaved)) {
      for (var pi = 0; pi < paletteSaved.length && palette.length < 3; pi++) {
        var pc = String(paletteSaved[pi] || "");
        if (/^#[0-9a-f]{6}$/i.test(pc)) palette.push(pc);
      }
    }
    while (palette.length < 3) palette.push(paletteDefault[palette.length]);
    state.palette = palette;
    var barAllowed = ["pointer", "pen", "highlighter", "eraser", "shape", "lasso",
      "undo", "redo", "color", "width"];
    var barSaved = pref("inkBarItems", null);
    var barItems = [];
    if (Array.isArray(barSaved)) {
      for (var bi2 = 0; bi2 < barSaved.length; bi2++) {
        var bid = String(barSaved[bi2] || "");
        if (barAllowed.indexOf(bid) >= 0 && barItems.indexOf(bid) < 0) barItems.push(bid);
      }
    }
    if (!barItems.length) barItems = ["pen", "highlighter", "eraser", "color"];
    // A toolbar without any drawing tool is a dead end; keep the pen recoverable.
    if (barItems.indexOf("pen") < 0 && barItems.indexOf("highlighter") < 0 &&
      barItems.indexOf("eraser") < 0) {
      barItems.push("pen");
    }
    state.barItems = barItems;
    state.glass = pref("inkGlass", false) === true;
    state.reduceMotion = pref("inkReduceMotion", true) !== false;
    state.lastPenTool = pref("inkLastPenTool", "pen") === "highlighter" ? "highlighter" : "pen";
    state.offsetX = Number(pref("inkOffsetX", 0)) || 0;
    state.offsetY = Number(pref("inkOffsetY", 0)) || 0;
    // "leave" is the default because replacing the file while Obsidian has it
    // open forces a full PDF reload (white frame + re-parse) under the reader.
    state.pdfWriteWhen = pref("inkPdfWriteWhen", "leave");
    if (["leave", "idle", "manual"].indexOf(state.pdfWriteWhen) < 0) {
      state.pdfWriteWhen = "leave";
    }
    state.pdfStyle = pref("inkPdfStyle", "polyline");
    if (["ink", "polyline"].indexOf(state.pdfStyle) < 0) {
      state.pdfStyle = "polyline";
    }
  }

  // ---------------------------------------------------------------------
  // Ink document + sidecar store
  // ---------------------------------------------------------------------
  var store = {
    cache: {},
    loading: {},
    timers: {},
    saving: {},
    pending: {},
    undo: {},
    redo: {}
  };

  function newDoc(target, type) {
    return {
      v: 1,
      target: target,
      type: type,
      created: Date.now(),
      updated: Date.now(),
      layout: null,
      strokes: [],
      orphans: []
    };
  }

  function adapter() {
    return state.app && state.app.vault ? state.app.vault.adapter : null;
  }

  function pathFor(key) {
    return DOCS + "/" + key + ".json";
  }

  async function ensureDirs() {
    var ad = adapter();
    if (!ad) return;
    var dirs = [ROOT, DOCS, BACKUPS, EXPORTS];
    for (var i = 0; i < dirs.length; i++) {
      try {
        if (!(await ad.exists(dirs[i]))) await ad.mkdir(dirs[i]);
      } catch (e) {
        // Exists / racing creator is fine.
      }
    }
  }

  function docFor(surface) {
    if (!surface || !surface.leaf || !surface.leaf.view || !surface.leaf.view.file) return null;
    var target = surface.leaf.view.file.path;
    var key = inkKey(target);
    if (store.cache[key]) return store.cache[key];
    var doc = newDoc(target, surface.kind === "pdf" ? "pdf" :
      (surface.kind === "canvas" ? "canvas" : "markdown"));
    doc._loading = true;
    store.cache[key] = doc;
    loadDoc(key, doc);
    return doc;
  }

  /** The stroke-space key for a surface: markdown page, PDF page, or board. */
  function inkSpaceOf(surface, entry) {
    if (!surface) return "md:abs";
    if (surface.kind === "pdf") {
      return (entry && entry.space) || surface.currentSpace || "pdf:0";
    }
    if (surface.kind === "canvas") return surface.space || "canvas";
    if (surface.kind === "pdfembed") return surface.space || "pdfembed";
    return "md:abs";
  }

  async function loadDoc(key, doc) {
    if (store.loading[key]) return;
    store.loading[key] = true;
    var ad = adapter();
    if (!ad) {
      store.loading[key] = false;
      doc._loading = false;
      return;
    }
    try {
      if (await ad.exists(pathFor(key))) {
        var txt = await ad.read(pathFor(key));
        var parsed = JSON.parse(txt);
        if (parsed && parsed.v === 1 && Array.isArray(parsed.strokes)) {
          doc.v = 1;
          // Keep the current path. Trusting a copied/renamed sidecar's target
          // would make the next save write into a different note's sidecar.
          if (parsed.target && parsed.target !== doc.target) {
            warn("ink sidecar target mismatch", key, parsed.target);
            // A copied sidecar or a hash collision must not leak another
            // note's strokes into this one.
            parsed.strokes = [];
            parsed.orphans = [];
          }
          doc.type = doc.type || parsed.type;
          doc.created = parsed.created || doc.created;
          doc.updated = parsed.updated || doc.updated;
          doc.layout = parsed.layout || null;
          if (doc.strokes && doc.strokes.length > 0) {
            // A stroke was captured while this file was still loading. Keep
            // the loaded strokes BELOW the fresh ones (drawing order), merge
            // by id, and discard the now-invalid undo/redo stacks: they were
            // captured before the old ink existed and would drop it on undo.
            var fresh = doc.strokes.slice();
            var merged = parsed.strokes.slice();
            var seen = {};
            for (var a = 0; a < merged.length; a++) seen[merged[a].id] = true;
            for (var b = 0; b < fresh.length; b++) {
              if (!seen[fresh[b].id]) merged.push(fresh[b]);
            }
            doc.strokes = merged;
            store.undo[key] = [];
            store.redo[key] = [];
          } else {
            doc.strokes = parsed.strokes;
          }
          // Migrate sidecars written before the "baked" flag existed: a stroke
          // that was already written to the PDF is in the annotation layer.
          // Highlighter uses the flag to avoid drawing a second translucent
          // copy over the /Highlight annotation.
          for (var bi = 0; bi < doc.strokes.length; bi++) {
            if (doc.strokes[bi] && doc.strokes[bi].written === true) {
              doc.strokes[bi].baked = true;
            }
          }
          // Older highlighter annotations were written as /PolyLine and their
          // width did not match the overlay. Mark them for one rewrite; that
          // rewrite emits /Highlight quads with the exact width.
          var hlMigrate = false;
          if (doc.type === "pdf") {
            for (var hi = 0; hi < doc.strokes.length; hi++) {
              var hs = doc.strokes[hi];
              if (hs && hs.tool === "highlighter" && hs.written === true &&
                hs.pdfHl !== true) {
                hs.written = false;
                hs.baked = false;
                hlMigrate = true;
              }
            }
            if (hlMigrate) saveSoon(doc);
          }
          doc.orphans = parsed.orphans || [];
        } else if (parsed) {
          warn("unsupported ink doc version", parsed.v);
        }
      }
    } catch (e) {
      warn("ink doc load failed", key, e && e.message);
    }
    store.loading[key] = false;
    doc._loading = false;
    if (doc._dirty) {
      doc._dirty = false;
      saveSoon(doc);
    }
    inkAfterDocChange(doc);
  }

  function saveSoon(doc) {
    if (!doc) return;
    // Never schedule the write half of a load-before-save race: an empty or
    // partially-loaded doc must not be written over the existing sidecar.
    if (doc._loading) {
      doc._dirty = true;
      return;
    }
    var key = inkKey(doc.target);
    if (store.timers[key]) clearTimeout(store.timers[key]);
    store.timers[key] = setTimeout(function () {
      store.timers[key] = 0;
      saveDoc(doc);
    }, 900);
  }

  async function saveDoc(doc) {
    if (doc && doc._loading) {
      doc._dirty = true;
      return false;
    }
    var ad = adapter();
    if (!ad || !doc) return false;
    var key = inkKey(doc.target);
    if (store.saving[key]) {
      // A previous write is still in flight. Mark a second pass instead of
      // racing the same tmp path (which could leave a truncated sidecar).
      store.pending[key] = true;
      return false;
    }
    store.saving[key] = true;
    try {
      await ensureDirs();
      doc.updated = Date.now();
      var dest = pathFor(key);
      var tmp = dest + ".tmp";
      var payload = JSON.stringify({
        v: 1,
        target: doc.target,
        type: doc.type,
        created: doc.created,
        updated: doc.updated,
        layout: doc.layout,
        strokes: doc.strokes,
        orphans: doc.orphans
      });
      try {
        await ad.write(tmp, payload);
        try {
          await ad.rename(tmp, dest);
        } catch (eR) {
          await ad.write(dest, payload);
          try { await ad.remove(tmp); } catch (eRm) {}
        }
        return true;
      } catch (e) {
        warn("ink doc save failed", key, e && e.message);
        return false;
      }
    } finally {
      store.saving[key] = false;
      if (store.pending[key]) {
        store.pending[key] = false;
        if (doc._loading) doc._dirty = true;
        else saveDoc(doc);
      }
    }
  }

  function snapshotSpace(doc, space) {
    // References, not deep clones. A PDF page can hold hundreds of strokes;
    // JSON-cloning every stroke twice per pen lift was O(total points) per
    // stroke and grew quadratically on long pages. Stroke objects are treated
    // as immutable after commit (erase creates new ids), so references are
    // enough for undo/redo.
    var out = [];
    for (var i = 0; i < doc.strokes.length; i++) {
      if (doc.strokes[i].space === space) out.push(doc.strokes[i]);
    }
    return out;
  }

  function pushHistory(doc, space, before) {
    var key = inkKey(doc.target);
    if (!store.undo[key]) store.undo[key] = [];
    store.undo[key].push({ space: space, before: before, after: snapshotSpace(doc, space) });
    if (store.undo[key].length > 50) store.undo[key].shift();
    store.redo[key] = [];
  }

  function restoreSpace(doc, space, strokes) {
    var kept = [];
    for (var i = 0; i < doc.strokes.length; i++) {
      if (doc.strokes[i].space !== space) kept.push(doc.strokes[i]);
    }
    doc.strokes = kept.concat(strokes);
    saveSoon(doc);
    inkAfterDocChange(doc);
  }

  function inkUndo(surface) {
    clearSelection();
    var s = surface || state.activeSurface || activeSurfaceNow();
    var doc = s ? docFor(s) : null;
    if (!doc) return false;
    var key = inkKey(doc.target);
    var stack = store.undo[key] || [];
    if (!stack.length) {
      inkStatus("没有可撤销的墨迹");
      return false;
    }
    var entry = stack.pop();
    store.redo[key] = store.redo[key] || [];
    store.redo[key].push(entry);
    restoreSpace(doc, entry.space, entry.before);
    markPdfPageDirty(s, entry.space);
    schedulePdfWrite(s);
    probeHook("inkHistory", {
      op: "undo",
      space: entry.space,
      n: entry.before ? entry.before.length : 0,
      left: stack.length
    });
    return true;
  }

  function inkRedo(surface) {
    clearSelection();
    var s = surface || state.activeSurface || activeSurfaceNow();
    var doc = s ? docFor(s) : null;
    if (!doc) return false;
    var key = inkKey(doc.target);
    var stack = store.redo[key] || [];
    if (!stack.length) {
      inkStatus("没有可重做的墨迹");
      return false;
    }
    var entry = stack.pop();
    store.undo[key] = store.undo[key] || [];
    store.undo[key].push(entry);
    restoreSpace(doc, entry.space, entry.after);
    markPdfPageDirty(s, entry.space);
    schedulePdfWrite(s);
    probeHook("inkHistory", {
      op: "redo",
      space: entry.space,
      n: entry.after ? entry.after.length : 0,
      left: stack.length
    });
    return true;
  }

  function inkClearSpace(surface) {
    clearSelection();
    var s = surface || state.activeSurface || activeSurfaceNow();
    var doc = s ? docFor(s) : null;
    if (!doc || !s) return false;
    var space = inkSpaceOf(s, null);
    if (!space && s.kind === "pdf") {
      try {
        var pn = s.viewer.currentPageNumber;
        if (pn > 0) space = "pdf:" + (pn - 1);
      } catch (e) {}
    }
    if (!space) return false;
    var before = snapshotSpace(doc, space);
    if (!before.length) {
      inkStatus("本页没有墨迹");
      return false;
    }
    pushHistory(doc, space, before);
    restoreSpace(doc, space, []);
    markPdfPageDirty(s, space);
    schedulePdfWrite(s);
    inkStatus("已清除本页墨迹（可撤销）");
    probeHook("inkClear", { space: space, removed: before.length });
    return true;
  }

  function inkAddStroke(surface, stroke) {
    var doc = docFor(surface);
    if (!doc) return false;
    var space = stroke.space;
    var before = snapshotSpace(doc, space);
    doc.strokes.push(stroke);
    if (doc._loading) doc._freshSinceLoad = (doc._freshSinceLoad || 0) + 1;
    pushHistory(doc, space, before);
    saveSoon(doc);
    var appended = false;
    try {
      appended = !!(surface && typeof surface.appendStroke === "function" &&
        surface.appendStroke(stroke));
    } catch (eApp) {
      appended = false;
    }
    inkAfterDocChange(doc, appended ? surface : null);
    return true;
  }

  // ---------------------------------------------------------------------
  // Geometry / rendering
  // ---------------------------------------------------------------------
  function pressureCurve(p) {
    var v = clamp01(p);
    var min = clamp01(state.pressureMin || 0);
    if (v <= min) v = 0;
    else v = clamp01((v - min) / Math.max(0.0001, 1 - min));
    var gamma = Number(state.pressureGamma) || 1;
    if (gamma < 0.4) gamma = 0.4;
    if (gamma > 2.6) gamma = 2.6;
    return Math.pow(v, gamma);
  }

  function widthFor(stroke, p) {
    // A highlighter is a marker, not a brush: Huawei Notes keeps its width
    // constant no matter how hard the pen presses, otherwise a line of text
    // gets darker/thicker bands wherever the hand happens to press harder.
    if (stroke.tool === "highlighter") return Math.max(0.35, stroke.width);
    // Recognized shapes (一笔成形) use one uniform width like a stencil.
    if (stroke.shape) return Math.max(0.35, stroke.width);
    var w = stroke.width * (0.35 + 1.65 * pressureCurve(p));
    return Math.max(0.35, w);
  }

  /**
   * Huawei Notes turns a stroke into a straight line when the pen rests at the
   * end of it. Only strokes that are already almost straight are eligible, so
   * pausing inside a character never replaces it with a diagonal line.
   */
  function strokeCanStraighten(stroke) {
    if (!stroke || stroke.tool === "highlighter" || stroke.straight) return false;
    var pts = stroke.pts;
    if (!pts || pts.length < 3) return false;
    var a = pts[0];
    var b = pts[pts.length - 1];
    var dx = b[0] - a[0];
    var dy = b[1] - a[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 24) return false;
    var maxDev = 0;
    for (var i = 1; i < pts.length - 1; i++) {
      var px = pts[i][0] - a[0];
      var py = pts[i][1] - a[1];
      var dev = Math.abs(px * dy - py * dx) / len;
      if (dev > maxDev) maxDev = dev;
    }
    return maxDev <= Math.max(8, len * 0.18);
  }

  function straightenStroke(stroke) {
    var pts = stroke.pts;
    if (!pts || pts.length < 2) return;
    var a = pts[0];
    var b = pts[pts.length - 1];
    var sum = 0;
    for (var i = 0; i < pts.length; i++) sum += Number(pts[i][2]) || 0;
    var p = sum / pts.length;
    stroke.pts = [
      [a[0], a[1], p, a[3] || 0, a[4] || 0, a[5] || 0],
      [b[0], b[1], p, b[3] || 0, b[4] || 0, b[5] || 0]
    ];
    stroke.straight = true;
    stroke.bbox = null;
  }

  function armStraightenTimer(a) {
    if (!a || a.kind !== "stroke" || !a.stroke || a.stroke.tool === "highlighter") return;
    if (state.holdStraight === false) return;
    // In shape mode the native InstantShapeGenerator owns the pause; letting
    // the straightening timer also fire would race it and flatten curves. If
    // the device has no shape engine, keep the straightening fallback.
    if (state.shapeMode && state.shapeSupported) return;
    if (a.holdTimer) clearTimeout(a.holdTimer);
    a.holdTimer = setTimeout(function () {
      a.holdTimer = 0;
      if (state.active !== a || a.kind !== "stroke") return;
      // 380 ms is the dwell Huawei Notes uses before it snaps the line; the
      // 50 ms slack keeps a slightly early frame from cancelling the snap.
      if (nowMs() - (a.lastMoveAt || 0) < 380) return;
      if (!strokeCanStraighten(a.stroke)) return;
      straightenStroke(a.stroke);
      requestLiveFrame();
    }, 430);
  }

  // ---------------------------------------------------------------------
  // Instant shape (Huawei Notes "一笔成形")
  // ---------------------------------------------------------------------
  // Classification comes from Pen Kit's InstantShapeGenerator; the geometry
  // is rebuilt here in surface space so the result stays a normal stroke that
  // can be undone and written back as a PDF polyline.
  function shapeP(x, y) {
    return [x, y, 0.55, 0, 0, 0];
  }

  function principalAxes(pts) {
    var n = pts.length;
    var cx = 0, cy = 0;
    for (var i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    if (n > 0) { cx /= n; cy /= n; }
    var sxx = 0, syy = 0, sxy = 0;
    for (var j = 0; j < n; j++) {
      var dx = pts[j][0] - cx;
      var dy = pts[j][1] - cy;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    var theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    var c = Math.cos(theta);
    var s = Math.sin(theta);
    var minU = 1e9, maxU = -1e9, minV = 1e9, maxV = -1e9;
    for (var k = 0; k < n; k++) {
      var u = (pts[k][0] - cx) * c + (pts[k][1] - cy) * s;
      var v = -(pts[k][0] - cx) * s + (pts[k][1] - cy) * c;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    return {
      cx: cx, cy: cy, c: c, s: s,
      minU: minU, maxU: maxU, minV: minV, maxV: maxV
    };
  }

  function hullCross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  function convexHull(pts) {
    var p = [];
    for (var i = 0; i < pts.length; i++) p.push({ x: pts[i][0], y: pts[i][1] });
    p.sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    if (p.length < 3) return p;
    var lower = [];
    for (var l = 0; l < p.length; l++) {
      while (lower.length >= 2 &&
        hullCross(lower[lower.length - 2], lower[lower.length - 1], p[l]) <= 0) {
        lower.pop();
      }
      lower.push(p[l]);
    }
    var upper = [];
    for (var u = p.length - 1; u >= 0; u--) {
      while (upper.length >= 2 &&
        hullCross(upper[upper.length - 2], upper[upper.length - 1], p[u]) <= 0) {
        upper.pop();
      }
      upper.push(p[u]);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  /**
   * Minimum-area rectangle over the stroke's hull. PCA is degenerate for a
   * square (equal eigenvalues -> arbitrary rotation), which made a hand-drawn
   * square come out rotated or diamond-shaped. Rotating calipers over the hull
   * locks onto the actual edges instead.
   */
  function minAreaRect(pts) {
    var hull = convexHull(pts);
    if (hull.length < 3) return null;
    var best = null;
    var bestArea = Infinity;
    for (var i = 0; i < hull.length; i++) {
      var a = hull[i];
      var b = hull[(i + 1) % hull.length];
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.01) continue;
      var ux = dx / len;
      var uy = dy / len;
      var vx = -uy;
      var vy = ux;
      var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (var j = 0; j < hull.length; j++) {
        var pu = hull[j].x * ux + hull[j].y * uy;
        var pv = hull[j].x * vx + hull[j].y * vy;
        if (pu < minU) minU = pu;
        if (pu > maxU) maxU = pu;
        if (pv < minV) minV = pv;
        if (pv > maxV) maxV = pv;
      }
      var area = (maxU - minU) * (maxV - minV);
      if (area < bestArea) {
        bestArea = area;
        best = {
          cx: 0, cy: 0, c: ux, s: uy,
          minU: minU, maxU: maxU, minV: minV, maxV: maxV
        };
      }
    }
    return best;
  }

  function axesPoint(ax, u, v) {
    return shapeP(ax.cx + u * ax.c - v * ax.s, ax.cy + u * ax.s + v * ax.c);
  }

  function ellipseShape(ax) {
    var rx = (ax.maxU - ax.minU) / 2;
    var ry = (ax.maxV - ax.minV) / 2;
    if (rx < 2 || ry < 2) return null;
    var cu = (ax.maxU + ax.minU) / 2;
    var cv = (ax.maxV + ax.minV) / 2;
    var out = [];
    for (var i = 0; i <= 64; i++) {
      var t = (i / 64) * Math.PI * 2;
      out.push(axesPoint(ax, cu + Math.cos(t) * rx, cv + Math.sin(t) * ry));
    }
    return out;
  }

  function closedShape(points) {
    if (!points || points.length < 2) return null;
    var out = points.slice();
    out.push(shapeP(points[0][0], points[0][1]));
    return out;
  }

  function arrowLineShape(s, e, startArrow, endArrow, stroke) {
    var dx = e[0] - s[0], dy = e[1] - s[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 2) return null;
    var ux = dx / len, uy = dy / len;
    var px = -uy, py = ux;
    var hl = Math.min(len * 0.28, Math.max(7, (Number(stroke.width) || 2.4) * 5));
    var out = [shapeP(s[0], s[1]), shapeP(e[0], e[1])];
    if (endArrow) {
      out.push(shapeP(e[0] - ux * hl + px * hl * 0.55, e[1] - uy * hl + py * hl * 0.55));
      out.push(shapeP(e[0], e[1]));
      out.push(shapeP(e[0] - ux * hl - px * hl * 0.55, e[1] - uy * hl - py * hl * 0.55));
    }
    if (startArrow) {
      out.push(shapeP(s[0], s[1]));
      out.push(shapeP(s[0] + ux * hl + px * hl * 0.55, s[1] + uy * hl + py * hl * 0.55));
      out.push(shapeP(s[0], s[1]));
      out.push(shapeP(s[0] + ux * hl - px * hl * 0.55, s[1] + uy * hl - py * hl * 0.55));
    }
    return out;
  }

  function parabolaShape(s, e, pts, startArrow, endArrow, stroke) {
    var dx = e[0] - s[0], dy = e[1] - s[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 4) return null;
    var ux = dx / len, uy = dy / len;
    var px = -uy, py = ux;
    // Signed maximum deviation from the chord decides which way the arc bows.
    var dev = 0;
    for (var i = 1; i < pts.length - 1; i++) {
      var vx = pts[i][0] - s[0];
      var vy = pts[i][1] - s[1];
      var d = vx * px + vy * py;
      if (Math.abs(d) > Math.abs(dev)) dev = d;
    }
    if (Math.abs(dev) < 2) dev = len * 0.18;
    var ctrlX = (s[0] + e[0]) / 2 + px * dev * 2;
    var ctrlY = (s[1] + e[1]) / 2 + py * dev * 2;
    var out = [];
    for (var k = 0; k <= 32; k++) {
      var t = k / 32;
      var a = (1 - t) * (1 - t);
      var b = 2 * (1 - t) * t;
      var c = t * t;
      out.push(shapeP(a * s[0] + b * ctrlX + c * e[0],
        a * s[1] + b * ctrlY + c * e[1]));
    }
    var headLen = Math.min(len * 0.22, Math.max(7, (Number(stroke.width) || 2.4) * 5));
    if (endArrow) {
      var tx = e[0] - ctrlX, ty = e[1] - ctrlY;
      var tl = Math.sqrt(tx * tx + ty * ty) || 1;
      var eux = tx / tl, euy = ty / tl;
      out.push(shapeP(e[0] - eux * headLen - euy * headLen * 0.55,
        e[1] - euy * headLen + eux * headLen * 0.55));
      out.push(shapeP(e[0], e[1]));
      out.push(shapeP(e[0] - eux * headLen + euy * headLen * 0.55,
        e[1] - euy * headLen - eux * headLen * 0.55));
    }
    if (startArrow) {
      var sx = ctrlX - s[0], sy = ctrlY - s[1];
      var sl = Math.sqrt(sx * sx + sy * sy) || 1;
      var sux = sx / sl, suy = sy / sl;
      out.push(shapeP(s[0], s[1]));
      out.push(shapeP(s[0] + sux * headLen - suy * headLen * 0.55,
        s[1] + suy * headLen + sux * headLen * 0.55));
      out.push(shapeP(s[0], s[1]));
      out.push(shapeP(s[0] + sux * headLen + suy * headLen * 0.55,
        s[1] + suy * headLen - sux * headLen * 0.55));
    }
    return out;
  }

  function buildShapePoints(type, pts, stroke) {
    if (!pts || pts.length < 3) return null;
    var bb = bboxOf(pts);
    var w = bb[2] - bb[0];
    var h = bb[3] - bb[1];
    if (w < 5 && h < 5) return null;
    var s = pts[0];
    var e = pts[pts.length - 1];
    var ax = principalAxes(pts);
    var rax = minAreaRect(pts) || ax;
    var cx = (bb[0] + bb[2]) / 2;
    var cy = (bb[1] + bb[3]) / 2;
    var i;
    switch (type) {
      case 1: // straight line
        return [shapeP(s[0], s[1]), shapeP(e[0], e[1])];
      case 2: // circle / ellipse
        return ellipseShape(ax);
      case 6: { // rectangle / square (minimum-area box over the hull)
        var cu = (rax.maxU + rax.minU) / 2;
        var cv = (rax.maxV + rax.minV) / 2;
        var hu = (rax.maxU - rax.minU) / 2;
        var hv = (rax.maxV - rax.minV) / 2;
        if (hu < 2 || hv < 2) return null;
        return closedShape([
          axesPoint(rax, cu - hu, cv - hv),
          axesPoint(rax, cu + hu, cv - hv),
          axesPoint(rax, cu + hu, cv + hv),
          axesPoint(rax, cu - hu, cv + hv)
        ]);
      }
      case 7: { // parallelogram
        var cu7 = (rax.maxU + rax.minU) / 2;
        var cv7 = (rax.maxV + rax.minV) / 2;
        var hu7 = (rax.maxU - rax.minU) / 2;
        var hv7 = (rax.maxV - rax.minV) / 2;
        if (hu7 < 2 || hv7 < 2) return null;
        var skew = hu7 * 0.24;
        return closedShape([
          axesPoint(rax, cu7 - hu7 + skew, cv7 - hv7),
          axesPoint(rax, cu7 + hu7 + skew, cv7 - hv7),
          axesPoint(rax, cu7 + hu7 - skew, cv7 + hv7),
          axesPoint(rax, cu7 - hu7 - skew, cv7 + hv7)
        ]);
      }
      case 9: { // rhombus
        var cu9 = (rax.maxU + rax.minU) / 2;
        var cv9 = (rax.maxV + rax.minV) / 2;
        var hu9 = (rax.maxU - rax.minU) / 2;
        var hv9 = (rax.maxV - rax.minV) / 2;
        if (hu9 < 2 || hv9 < 2) return null;
        return closedShape([
          axesPoint(rax, cu9, cv9 - hv9),
          axesPoint(rax, cu9 + hu9, cv9),
          axesPoint(rax, cu9, cv9 + hv9),
          axesPoint(rax, cu9 - hu9, cv9)
        ]);
      }
      case 10: // isosceles triangle
      case 11: // equilateral triangle
        return closedShape([
          shapeP(cx, bb[1]), shapeP(bb[2], bb[3]), shapeP(bb[0], bb[3])
        ]);
      case 12: { // pentagram
        var rOut = Math.min(w, h) * 0.5;
        var rIn = rOut * 0.42;
        var star = [];
        for (i = 0; i < 10; i++) {
          var ra = -Math.PI / 2 + i * Math.PI / 5;
          var rr = (i & 1) ? rIn : rOut;
          star.push(shapeP(cx + Math.cos(ra) * rr, cy + Math.sin(ra) * rr));
        }
        return closedShape(star);
      }
      case 13: { // pentagon
        var rp = Math.min(w, h) * 0.5;
        var pent = [];
        for (i = 0; i < 5; i++) {
          var pa = -Math.PI / 2 + i * Math.PI * 2 / 5;
          pent.push(shapeP(cx + Math.cos(pa) * rp, cy + Math.sin(pa) * rp));
        }
        return closedShape(pent);
      }
      case 14: // parabola
        return parabolaShape(s, e, pts, false, false, stroke);
      case 15:
        return arrowLineShape(s, e, true, false, stroke);
      case 16:
        return arrowLineShape(s, e, false, true, stroke);
      case 17:
        return arrowLineShape(s, e, true, true, stroke);
      case 18:
        return parabolaShape(s, e, pts, true, false, stroke);
      case 19:
        return parabolaShape(s, e, pts, false, true, stroke);
      case 20:
        return parabolaShape(s, e, pts, true, true, stroke);
      default:
        return null;
    }
  }

  function isClosedStroke(pts) {
    if (!pts || pts.length < 4) return false;
    var bb = bboxOf(pts);
    var diag = Math.sqrt((bb[2] - bb[0]) * (bb[2] - bb[0]) +
      (bb[3] - bb[1]) * (bb[3] - bb[1]));
    var dx = pts[pts.length - 1][0] - pts[0][0];
    var dy = pts[pts.length - 1][1] - pts[0][1];
    return Math.sqrt(dx * dx + dy * dy) <= Math.max(8, diag * 0.3);
  }

  function localShapeGuess(pts) {
    if (!isClosedStroke(pts)) return 0;
    var rax = minAreaRect(pts);
    if (!rax) return 0;
    var cu = (rax.maxU + rax.minU) / 2;
    var cv = (rax.maxV + rax.minV) / 2;
    var hu = (rax.maxU - rax.minU) / 2;
    var hv = (rax.maxV - rax.minV) / 2;
    if (hu < 3 || hv < 3) return 0;
    var corners = [
      [cu - hu, cv - hv], [cu + hu, cv - hv],
      [cu + hu, cv + hv], [cu - hu, cv + hv]
    ];
    var cornerTol = Math.min(hu, hv) * 0.35;
    var hitCorners = 0;
    for (var c = 0; c < 4; c++) {
      var hit = false;
      for (var i = 0; i < pts.length; i++) {
        var u = pts[i][0] * rax.c + pts[i][1] * rax.s;
        var v = -pts[i][0] * rax.s + pts[i][1] * rax.c;
        var ddx = u - corners[c][0];
        var ddy = v - corners[c][1];
        if (ddx * ddx + ddy * ddy <= cornerTol * cornerTol) { hit = true; break; }
      }
      if (hit) hitCorners++;
    }
    // Four clustered corners is a square/rectangle; a triangle only hits three.
    if (hitCorners >= 4) return 6;
    // Closed and radially even -> circle/ellipse.
    var sum = 0, sum2 = 0;
    for (var j = 0; j < pts.length; j++) {
      var pu = pts[j][0] * rax.c + pts[j][1] * rax.s;
      var pv = -pts[j][0] * rax.s + pts[j][1] * rax.c;
      var ru = (pu - cu) / hu;
      var rv = (pv - cv) / hv;
      var rr = Math.sqrt(ru * ru + rv * rv);
      sum += rr;
      sum2 += rr * rr;
    }
    var n = pts.length;
    var mean = sum / n;
    var variance = Math.max(0, sum2 / n - mean * mean);
    if (mean > 0.7 && mean < 1.3 && Math.sqrt(variance) < 0.16) return 2;
    return 0;
  }

  function applyNativeShape(type) {
    if (!state.shapeMode) return false;
    if (typeof type !== "number") type = 0;
    var a = state.active;
    if (!a || a.kind !== "stroke" || a.shapeApplied) return false;
    var stroke = a.stroke;
    if (!stroke || stroke.tool !== "pen") return false;
    // Pen Kit sometimes labels a closed hand-drawn square as a polyline.
    // A closed stroke is much more useful as the minimum-area rectangle than
    // as an untouched freehand polygon — unless the local radial test says it
    // is a circle, in which case forcing a rectangle was visibly wrong.
    if ((type === 3 || type === 0) && isClosedStroke(stroke.pts)) {
      type = localShapeGuess(stroke.pts) === 2 ? 2 : 6;
    }
    var out = buildShapePoints(type, stroke.pts, stroke);
    if (!out || out.length < 2) {
      inkTrace("shapeReject", { type: type, points: stroke.pts.length });
      return false;
    }
    stopPressureEraserWatch(a);
    if (a.holdTimer) {
      clearTimeout(a.holdTimer);
      a.holdTimer = 0;
    }
    stroke.shape = type;
    stroke.straight = false;
    stroke.pts = out;
    stroke.bbox = bboxOf(out);
    a.shapeApplied = true;
    a.liveDrawn = out.length;
    clearPenPredict();
    try {
      if (a.surface.kind === "markdown" || a.surface.kind === "canvas" ||
        a.surface.kind === "pdfembed") {
        a.surface.drawLive(stroke);
      } else {
        a.surface.drawLive(a.entry, stroke);
      }
    } catch (e) {}
    state.shapeApplied++;
    inkStatus("已成形", 600);
    inkTrace("shape", { type: type, points: out.length });
    probeHook("inkShape", {
      source: "native",
      type: type,
      points: out.length,
      closed: isClosedStroke(out)
    });
    return true;
  }

  // ---------------------------------------------------------------------
  // Pressure eraser (Huawei Notes "压感橡皮擦")
  // ---------------------------------------------------------------------
  // Huawei Notes: press the nib down and hold still for a moment, and the pen
  // temporarily becomes an eraser; move to erase; lift to resume writing.
  // It deliberately does NOT trigger after a normal stroke moved away from its
  // start (the troubleshooting page says a moved pen is "writing"), so a pause
  // at the end of a line can never eat the line.
  function stopPressureEraserWatch(a) {
    if (a && a.pressureTimer) {
      clearInterval(a.pressureTimer);
      a.pressureTimer = 0;
    }
  }

  function pressureEraserArmed(a, pr) {
    if (state.pressureEraser === false) return false;
    // Shape mode owns the pause gesture; triggering both at ~500 ms would
    // randomly erase instead of drawing a shape. Without a native shape engine
    // there is no such conflict, so keep pressure erase available.
    if (state.shapeMode && state.shapeSupported) return false;
    if (!a || a.kind !== "stroke" || !a.stroke) return false;
    if (a.stroke.device !== "pen") return false;
    if (a.stroke.tool !== "pen" && a.stroke.tool !== "highlighter") return false;
    // Without a real pressure sensor the simulated curve rises to ~0.9 when
    // the pen stops, which would turn every held dot into an eraser.
    return state.pressureMode === "real" || (pr && pr.real === true);
  }

  function startPressureEraserWatch(a, pr) {
    if (!pressureEraserArmed(a, pr)) return;
    stopPressureEraserWatch(a);
    var sens = clamp(Number(state.pressureEraserSens) || 0, 0, 100);
    var threshold = 0.82 - 0.0055 * sens;
    var dwell = 700 - 3.2 * sens;
    a.pressureTimer = setInterval(function () {
      if (state.active !== a || a.kind !== "stroke") {
        stopPressureEraserWatch(a);
        return;
      }
      if (nowMs() - (a.downAt || a.t0) < dwell) return;
      // A real stroke has travelled: this is writing, not the erase gesture.
      if ((a.maxTravel || 0) > 9) {
        stopPressureEraserWatch(a);
        return;
      }
      if ((a.lastPressure || 0) < threshold) return;
      triggerPressureEraser(a);
    }, 70);
  }

  function triggerPressureEraser(a) {
    if (state.active !== a || a.kind !== "stroke") return;
    stopPressureEraserWatch(a);
    if (a.holdTimer) {
      clearTimeout(a.holdTimer);
      a.holdTimer = 0;
    }
    var surface = a.surface;
    var entry = a.entry;
    // The dot/line drawn while waiting is not committed yet; drop its live
    // pixels so the pause does not leave a stray mark before erasing.
    try {
      if (surface.kind === "markdown" || surface.kind === "canvas" ||
        surface.kind === "pdfembed") surface.clearLive();
      else surface.clearLive(entry);
    } catch (eCL) {}
    var doc = docFor(surface);
    var space = inkSpaceOf(surface, entry);
    var cx = a.lastClientX;
    var cy = a.lastClientY;
    var sp = surface.kind === "pdf"
      ? surface.toSpaceOn(entry, cx, cy)
      : surface.toSpace(cx, cy);
    var st = {
      kind: "erase",
      surface: surface,
      entry: entry,
      space: space,
      doc: doc,
      before: doc ? snapshotSpace(doc, space) : null,
      changed: false,
      erasePts: [[sp[0], sp[1]]],
      visualErased: false,
      immediate: state.eraserMode === "stroke" || state.eraserOnlyHl === true,
      pointerId: a.pointerId,
      t0: nowMs(),
      lastSampleAt: nowMs(),
      pressureTriggered: true
    };
    state.active = st;
    drawCursor(cx, cy, surface, true);
    if (st.immediate) {
      eraseAt(surface, entry, sp[0], sp[1], st);
      if (st.changed) redrawEraseSurface(surface, entry);
    } else if (typeof surface.erasePreview === "function") {
      surface.erasePreview(cx, cy, Number(state.eraserPx) || 12, entry);
      st.visualErased = true;
    } else {
      eraseAt(surface, entry, sp[0], sp[1], st);
    }
    inkStatus("压感橡皮", 700);
    inkTrace("pressureEraser", {
      space: space,
      p: Number(a.lastPressure || 0).toFixed(3),
      travel: Math.round(a.maxTravel || 0)
    });
  }

  function smoothPoints(pts) {
    if (pts.length < 3) return pts.slice();
    var out = [pts[0]];
    for (var i = 1; i < pts.length - 1; i++) {
      var a = pts[i - 1], b = pts[i], c = pts[i + 1];
      out.push({
        x: (a.x + 2 * b.x + c.x) / 4,
        y: (a.y + 2 * b.y + c.y) / 4,
        p: (a.p + 2 * b.p + c.p) / 4
      });
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /**
   * Variable-width stroke as ONE simple polygon: left offsets forward, a round
   * end cap, right offsets backward, a round start cap. A single subpath avoids
   * the winding cancellation that produced white dots where the old per-segment
   * quads overlapped the per-sample discs.
   */
  function buildStrokePath(stroke, pts, scale) {
    var path = new Path2D();
    var sm = smoothPoints(pts);
    var n = sm.length;
    if (!n) return path;
    var hw = [];
    for (var w = 0; w < n; w++) {
      hw.push(Math.max(0.35, widthFor(stroke, sm[w].p) * scale) / 2);
    }
    if (n === 1) {
      path.arc(sm[0].x, sm[0].y, hw[0], 0, Math.PI * 2);
      return path;
    }
    var totalLen = 0;
    for (var q = 1; q < n; q++) {
      totalLen += Math.hypot(sm[q].x - sm[q - 1].x, sm[q].y - sm[q - 1].y);
    }
    if (totalLen < 0.5) {
      path.arc(sm[0].x, sm[0].y, hw[0], 0, Math.PI * 2);
      return path;
    }
    var left = [];
    var right = [];
    for (var i = 0; i < n; i++) {
      var prev = sm[i > 0 ? i - 1 : 0];
      var next = sm[i < n - 1 ? i + 1 : n - 1];
      var dx = next.x - prev.x;
      var dy = next.y - prev.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len;
      var ny = dx / len;
      left.push([sm[i].x + nx * hw[i], sm[i].y + ny * hw[i]]);
      right.push([sm[i].x - nx * hw[i], sm[i].y - ny * hw[i]]);
    }
    var t0 = Math.atan2(sm[1].y - sm[0].y, sm[1].x - sm[0].x);
    var t1 = Math.atan2(sm[n - 1].y - sm[n - 2].y, sm[n - 1].x - sm[n - 2].x);
    path.moveTo(left[0][0], left[0][1]);
    for (var a = 1; a < n; a++) path.lineTo(left[a][0], left[a][1]);
    // End cap: left -> right around the front (decreasing angle through t1).
    arcSample(path, sm[n - 1].x, sm[n - 1].y, hw[n - 1],
      t1 + Math.PI / 2, t1 - Math.PI / 2);
    for (var b = n - 1; b >= 0; b--) path.lineTo(right[b][0], right[b][1]);
    // Start cap: right -> left around the back (decreasing through t0-pi).
    arcSample(path, sm[0].x, sm[0].y, hw[0],
      t0 - Math.PI / 2, t0 - 3 * Math.PI / 2);
    path.closePath();
    return path;
  }

  function arcSample(path, cx, cy, r, a0, a1) {
    var span = Math.abs(a1 - a0);
    var steps = Math.max(4, Math.ceil(span / (Math.PI / 12)));
    for (var k = 1; k <= steps; k++) {
      var a = a0 + (a1 - a0) * (k / steps);
      path.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  }

  function drawStrokeOnCtx(ctx, stroke, surface) {
    var pts = [];
    var src = stroke.pts;
    // Live preview decimation: a 2-second stroke can be 500+ points; redrawing
    // all of them every frame is wasted work. Committed strokes are always
    // drawn from the full sample list.
    if (surface && surface.live && src.length > 260) {
      var step = Math.ceil(src.length / 260);
      var reduced = [];
      for (var r = 0; r < src.length; r += step) reduced.push(src[r]);
      if (reduced[reduced.length - 1] !== src[src.length - 1]) reduced.push(src[src.length - 1]);
      src = reduced;
    }
    var raw = [];
    for (var i = 0; i < src.length; i++) {
      var p = src[i];
      var xy = surface.toCanvasPoint(p[0], p[1]);
      if (!xy) continue;
      raw.push({ x: xy[0], y: xy[1], p: p[2] });
    }
    // Remove near-duplicate samples first: at a pause the pen emits many
    // points at the same place, and their averaged normals used to fold the
    // outline into a loop (the white square/hole artifact).
    var pts = [];
    for (var ri = 0; ri < raw.length; ri++) {
      var rp = raw[ri];
      if (!pts.length) {
        pts.push(rp);
        continue;
      }
      var lp = pts[pts.length - 1];
      var ddx = rp.x - lp.x;
      var ddy = rp.y - lp.y;
      if (ddx * ddx + ddy * ddy >= 0.36) pts.push(rp);
    }
    if (raw.length && pts[pts.length - 1] !== raw[raw.length - 1]) {
      pts.push(raw[raw.length - 1]);
    }
    if (!pts.length) return;
    if (stroke.straight === true && pts.length > 2) {
      var sa = pts[0];
      var sb = pts[pts.length - 1];
      pts = [sa, sb];
    }
    var scale = surface.widthScale ? surface.widthScale() : 1;
    var pxMode = stroke.px === true;
    var lineScale = pxMode ? 1 : scale;
    // Legacy pdfembed strokes stored width in the wrong unit could draw
    // hundreds of px wide; clamp only that fallback to a sane screen width.
    if (!pxMode && surface.kind === "pdfembed" && stroke.width * lineScale > 64) {
      lineScale = 64 / Math.max(0.01, stroke.width);
    }
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.globalAlpha = stroke.tool === "highlighter" ? clamp01(stroke.opacity) : 1;
    if (pts.length === 1) {
      var r0 = Math.max(0.35, widthFor(stroke, pts[0].p) * lineScale) / 2;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, r0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    if (stroke.tool === "highlighter") {
      // Alpha ink must be filled once; per-segment strokes would multiply the
      // translucent colour at every joint. The cleaned points keep the outline
      // from folding into holes at pause points.
      var hp = buildStrokePath(stroke, pts, lineScale);
      ctx.fill(hp);
    } else {
      // Continuous width per segment (no quantisation), with the same 3-point
      // position smoothing the old outline used. Round caps make the joins
      // seamless, and because pen ink is opaque, overlaps are invisible.
      pts = smoothPoints(pts);
      for (var si = 1; si < pts.length; si++) {
        var a = pts[si - 1];
        var b = pts[si];
        var w = (widthFor(stroke, a.p) + widthFor(stroke, b.p)) * 0.5 * lineScale;
        w = Math.max(0.35, w);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineWidth = w;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function sizeCanvas(cv, w, h, dpr, opts) {
    var W = Math.max(1, Math.round(w * dpr));
    var H = Math.max(1, Math.round(h * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    cv.style.width = w + "px";
    cv.style.height = h + "px";
    // `desynchronized` lets Chromium bypass one compositor round-trip for the
    // live ink layer; tiles keep the default (they are static).
    var ctx = opts ? cv.getContext("2d", opts) : cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function ensureCanvas(parent, cls, z) {
    var cv = parent.querySelector("canvas." + cls);
    if (!cv) {
      cv = document.createElement("canvas");
      cv.className = cls;
      cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:" + (z || 5);
      parent.appendChild(cv);
    }
    return cv;
  }

  function removeCanvas(parent, cls) {
    try {
      var cv = parent.querySelector("canvas." + cls);
      if (cv && cv.parentNode) cv.parentNode.removeChild(cv);
    } catch (e) {}
  }

  function inkAfterDocChange(doc, skipSurface) {
    for (var i = 0; i < state.surfaces.length; i++) {
      var s = state.surfaces[i];
      if (s.doc !== doc) continue;
      if (skipSurface && s === skipSurface) continue;
      try {
        s.redraw();
      } catch (e) {
        warn("surface redraw failed", s.kind, e && e.message);
        inkTrace("redrawFail", { kind: s.kind, error: e && e.message });
      }
    }
    updateToolbarState();
  }

  // ---------------------------------------------------------------------
  // Surfaces: markdown reading view
  // ---------------------------------------------------------------------
  function layoutHash(sizer) {
    var kids = sizer.children || [];
    var parts = [];
    var n = Math.min(kids.length, 400);
    for (var i = 0; i < n; i++) {
      var k = kids[i];
      // Never read textContent from a PDF/markdown embed: a loading or huge
      // PDF text layer can be many megabytes and this runs on the main thread
      // while the note is opening.
      if (k.classList && (k.classList.contains("pdf-embed") ||
        k.classList.contains("markdown-embed"))) {
        parts.push("embed:" + i);
        continue;
      }
      try {
        if (k.querySelector && k.querySelector(".pdf-embed, .markdown-embed, .internal-embed")) {
          parts.push("embed-child:" + i);
          continue;
        }
      } catch (eQ) {}
      var raw = k.textContent || "";
      var txt = raw.slice(0, 120).replace(/\s+/g, " ");
      parts.push((k.tagName || "?") + ":" + txt + ":" + (k.offsetTop || 0));
    }
    return fnv(parts.join("|")) + "-" + kids.length;
  }

  var MARKDOWN_TILE_H = 700;

  /**
   * Reading-view ink surface.
   *
   * Committed ink lives in content-space TILE canvases inside the sizer, so it
   * scrolls natively with the text (no main-thread reprojection, no lag). Only
   * tiles that actually contain ink are allocated; the current stroke uses a
   * separate viewport-sized live canvas and is moved into the tiles on commit.
   */
  function createMarkdownSurface(leaf) {
    var view = leaf.view;
    if (!view || view.getViewType() !== "markdown") return null;
    if (typeof view.getMode === "function" && view.getMode() !== "preview") return null;
    var rootEl = view.containerEl ? view.containerEl.querySelector(".markdown-reading-view") : null;
    if (!rootEl) return null;
    var sizer = rootEl.querySelector(".markdown-preview-sizer");
    if (!sizer) return null;
    var rect = sizer.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    if (getComputedStyle(sizer).display === "none") return null;
    if (getComputedStyle(rootEl).position === "static") rootEl.style.position = "relative";
    if (getComputedStyle(sizer).position === "static") sizer.style.position = "relative";
    removeCanvas(rootEl, "ohsidian-ink-base");
    removeCanvas(sizer, "ohsidian-ink-base");
    // A clipped host keeps tile overflow from adding phantom scroll height.
    try {
      var oldHost = sizer.querySelector(".ohsidian-ink-tiles");
      if (oldHost && oldHost.parentNode) oldHost.parentNode.removeChild(oldHost);
    } catch (eOld) {}
    var tileHost = document.createElement("div");
    tileHost.className = "ohsidian-ink-tiles";
    tileHost.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;" +
      "overflow:visible;pointer-events:none;z-index:5";
    sizer.appendChild(tileHost);
    var live = ensureCanvas(rootEl, "ohsidian-ink-live", 6);
    var surface = {
      kind: "markdown",
      leaf: leaf,
      rootEl: rootEl,
      sizer: sizer,
      tileHost: tileHost,
      live: live,
      dpr: Math.min(window.devicePixelRatio || 1, 2),
      w: 0,
      h: 0,
      tw: 0,
      space: "md:abs",
      doc: null,
      rects: null,
      tiles: {},
      raf: 0,
      refreshRects: function () {
        this.ensureAttached();
        this.rects = {
          root: rootEl.getBoundingClientRect(),
          sizer: sizer.getBoundingClientRect()
        };
        return this.rects;
      },
      toSpace: function (clientX, clientY) {
        var r = this._spaceRect || sizer.getBoundingClientRect();
        return [clientX - r.left, clientY - r.top];
      },
      beginStroke: function () {
        this._spaceRect = sizer.getBoundingClientRect();
        this.rects = null;
      },
      erasePreview: function (clientX, clientY, radius) {
        // Clear the already-painted tile pixels for an instant visual eraser;
        // the document is updated once at pen-up. This keeps erasing at display
        // rate instead of rebuilding the entire page on every pointermove.
        var p = this.toSpace(clientX, clientY);
        var r = Math.max(1, radius);
        var i0 = Math.floor((p[1] - r) / MARKDOWN_TILE_H);
        var i1 = Math.floor((p[1] + r) / MARKDOWN_TILE_H);
        for (var i = i0; i <= i1; i++) {
          var t = this.tiles[i];
          if (!t || !t.cv) continue;
          var ctx = t.cv.getContext("2d");
          ctx.save();
          ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
          ctx.globalCompositeOperation = "destination-out";
          ctx.beginPath();
          ctx.arc(p[0], p[1] - i * MARKDOWN_TILE_H, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      },
      toCanvasPoint: function (x, y) {
        var r = this.rects || this.refreshRects();
        return [
          x + r.sizer.left - r.root.left,
          y + r.sizer.top - r.root.top
        ];
      },
      widthScale: function () {
        return 1;
      },
      contains: function (el) {
        return !!(el && sizer.contains(el));
      },
      ensureAttached: function () {
        // Obsidian can clear/replace the sizer's children while leaving the
        // sizer itself connected. Absolute hosts are removed silently; every
        // subsequent commit then has hostH=0 and the ink is invisible. Reattach
        // the existing host (its tile canvases are still its children).
        try {
          if (this.tileHost && this.tileHost.parentNode !== sizer) sizer.appendChild(this.tileHost);
        } catch (e1) {}
        try {
          if (this.live && this.live.parentNode !== rootEl) rootEl.appendChild(this.live);
        } catch (e2) {}
      },
      ensureTile: function (i) {
        this.ensureAttached();
        var t = this.tiles[i];
        if (t) return t;
        var cv = document.createElement("canvas");
        cv.className = "ohsidian-ink-tile";
        cv.setAttribute("data-tile", String(i));
        cv.style.cssText = "position:absolute;left:0;top:" + (i * MARKDOWN_TILE_H) +
          "px;pointer-events:none";
        (this.tileHost || sizer).appendChild(cv);
        t = { i: i, cv: cv };
        this.tiles[i] = t;
        return t;
      },
      removeTile: function (i) {
        var t = this.tiles[i];
        if (!t) return;
        try {
          if (t.cv && t.cv.parentNode) t.cv.parentNode.removeChild(t.cv);
        } catch (e) {}
        delete this.tiles[i];
      },
      resize: function () {
        this.ensureAttached();
        var vw = window.innerWidth || 1024;
        var vh = window.innerHeight || 768;
        var w = Math.max(1, Math.min(rootEl.clientWidth || vw, vw));
        var h = Math.max(1, Math.min(rootEl.clientHeight || vh, vh));
        if (!isFinite(w) || !isFinite(h)) return;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (w !== this.w || h !== this.h || dpr !== this.dpr || this.live.width <= 1) {
          this.w = w;
          this.h = h;
          this.dpr = dpr;
          sizeCanvas(this.live, w, h, dpr, { desynchronized: true, alpha: true });
        }
        this.rects = null;
        var tw = Math.max(1, sizer.clientWidth || w);
        this.tw = tw;
        // Percentage height would collapse to 0 for an absolutely positioned
        // host whose children are all absolute; pin it to the content height.
        try {
          // Measure the normal-flow content, never the tile host itself:
          // scrollHeight includes the absolute host and can get stuck; a
          // clientHeight of 0 (common for some sizer layouts) used to clip
          // every committed stroke right after the live layer was cleared.
          var sr = sizer.getBoundingClientRect();
          var contentH = Math.max(1, sizer.clientHeight || 0);
          var kids = sizer.children || [];
          for (var ki = 0; ki < kids.length; ki++) {
            var kid = kids[ki];
            if (!kid || (kid.classList && kid.classList.contains("ohsidian-ink-tiles"))) continue;
            try {
              var kr = kid.getBoundingClientRect();
              if (kr && kr.height > 0) {
                var bottom = kr.bottom - sr.top;
                if (bottom > contentH) contentH = bottom;
              }
            } catch (eKid) {}
          }
          if (contentH < 2) {
            // Last resort: subtract the host from scrollHeight so a wrong
            // clientHeight cannot hide all ink.
            var hostH = this.tileHost ? (this.tileHost.offsetHeight || 0) : 0;
            contentH = Math.max(1, (sizer.scrollHeight || 0) - hostH);
          }
          if (this.tileHost) this.tileHost.style.height = contentH + "px";
        } catch (eH) {}
        for (var key in this.tiles) {
          if (!Object.prototype.hasOwnProperty.call(this.tiles, key)) continue;
          var t = this.tiles[key];
          if (t && t.cv) sizeCanvas(t.cv, tw, MARKDOWN_TILE_H, dpr);
        }
        this.redraw();
      },
      redraw: function () {
        this.ensureAttached();
        var doc = this.doc;
        if (!doc) return;
        var w = Math.max(1, sizer.clientWidth || this.w || (window.innerWidth || 1024));
        var dpr = this.dpr;
        var needed = {};
        var i;
        for (i = 0; i < doc.strokes.length; i++) {
          var st = doc.strokes[i];
          if (st.space !== this.space || st.baked) continue;
          var b = st.bbox || bboxOf(st.pts);
          if (!b) continue;
          var t0 = Math.floor((b[1] - 12) / MARKDOWN_TILE_H);
          var t1 = Math.floor((b[3] + 12) / MARKDOWN_TILE_H);
          if (t0 < 0) t0 = 0;
          for (var t = t0; t <= t1; t++) needed[t] = true;
        }
        var key;
        for (key in this.tiles) {
          if (!Object.prototype.hasOwnProperty.call(this.tiles, key)) continue;
          if (!needed[key]) this.removeTile(key);
        }
        for (key in needed) {
          if (!Object.prototype.hasOwnProperty.call(needed, key)) continue;
          var idx = parseInt(key, 10);
          var tile = this.ensureTile(idx);
          var ctx = sizeCanvas(tile.cv, w, MARKDOWN_TILE_H, dpr);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, tile.cv.width, tile.cv.height);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          var tileSurface = {
            toCanvasPoint: (function (offsetY) {
              return function (x, y) { return [x, y - offsetY]; };
            })(idx * MARKDOWN_TILE_H),
            widthScale: function () { return 1; }
          };
          for (var pass = 0; pass < 2; pass++) {
            for (i = 0; i < doc.strokes.length; i++) {
              var s2 = doc.strokes[i];
              if (s2.space !== this.space || s2.baked) continue;
              if (pass === 0 && s2.tool !== "highlighter") continue;
              if (pass === 1 && s2.tool === "highlighter") continue;
              var bb = s2.bbox || bboxOf(s2.pts);
              if (!bb) continue;
              if (bb[3] < idx * MARKDOWN_TILE_H || bb[1] > (idx + 1) * MARKDOWN_TILE_H) continue;
              drawStrokeOnCtx(ctx, s2, tileSurface);
            }
          }
        }
      },
      scheduleRedraw: function () {
        if (this.raf) return;
        var self = this;
        this.raf = requestAnimationFrame(function () {
          self.raf = 0;
          self.redraw();
          var a = state.active;
          if (a && a.kind === "stroke" && a.surface === self) self.drawLive(a.stroke);
        });
      },
      drawLive: function (stroke) {
        if (!this.rects) this.refreshRects();
        var ctx = this.live.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.live.width, this.live.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        if (stroke) drawStrokeOnCtx(ctx, stroke, this);
      },
      clearLive: function () {
        var ctx = this.live.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.live.width, this.live.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      },
      rebind: function () {
        // Obsidian can replace .markdown-reading-view / .markdown-preview-sizer
        // without replacing the leaf (PDF embeds, theme/layout re-render).
        // Reattach the same document/history instead of churning a new surface.
        try {
          var v = this.leaf && this.leaf.view;
          if (!v || !v.containerEl) return false;
          var nr = v.containerEl.querySelector(".markdown-reading-view");
          if (!nr) return false;
          var ns = nr.querySelector(".markdown-preview-sizer");
          if (!ns || !ns.isConnected) return false;
          if (getComputedStyle(nr).position === "static") nr.style.position = "relative";
          if (getComputedStyle(ns).position === "static") ns.style.position = "relative";
          try {
            if (this.tileHost && this.tileHost.parentNode) this.tileHost.parentNode.removeChild(this.tileHost);
          } catch (eOld) {}
          removeCanvas(rootEl, "ohsidian-ink-live");
          rootEl = nr;
          sizer = ns;
          live = ensureCanvas(rootEl, "ohsidian-ink-live", 6);
          tileHost = document.createElement("div");
          tileHost.className = "ohsidian-ink-tiles";
          tileHost.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;" +
            "overflow:visible;pointer-events:none;z-index:5";
          sizer.appendChild(tileHost);
          this.rootEl = rootEl;
          this.sizer = sizer;
          this.live = live;
          this.tileHost = tileHost;
          this.tiles = {};
          this.rects = null;
          this.w = 0;
          this.h = 0;
          try {
            if (this.resizeObserver) this.resizeObserver.disconnect();
            var self = this;
            this.resizeObserver = new ResizeObserver(function () {
              if (self.resizeTimer) return;
              self.resizeTimer = setTimeout(function () {
                self.resizeTimer = 0;
                try { self.resize(); } catch (e) {}
              }, 90);
            });
            this.resizeObserver.observe(sizer);
            this.resizeObserver.observe(rootEl);
          } catch (eRO) {}
          this.resize();
          var a = state.active;
          if (a && a.kind === "stroke" && a.surface === this) this.drawLive(a.stroke);
          return true;
        } catch (e) {
          return false;
        }
      },
      unmount: function () {
        try {
          if (this.resizeObserver) this.resizeObserver.disconnect();
        } catch (eRO) {}
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        removeCanvas(rootEl, "ohsidian-ink-live");
        var k;
        for (k in this.tiles) {
          if (Object.prototype.hasOwnProperty.call(this.tiles, k)) this.removeTile(k);
        }
        this.tiles = {};
        try {
          if (this.tileHost && this.tileHost.parentNode) {
            this.tileHost.parentNode.removeChild(this.tileHost);
          }
        } catch (e) {}
      }
    };
    surface.doc = docFor(surface);
    try {
      surface.resizeObserver = new ResizeObserver(function () {
        if (surface.resizeTimer) return;
        surface.resizeTimer = setTimeout(function () {
          surface.resizeTimer = 0;
          try { surface.resize(); } catch (e) {}
        }, 90);
      });
      surface.resizeObserver.observe(sizer);
      surface.resizeObserver.observe(rootEl);
    } catch (eRO) {}
    surface.resize();
    var layoutNow = {
      width: Math.round(sizer.getBoundingClientRect().width) || 0,
      blocks: sizer.children ? sizer.children.length : 0,
      hash: layoutHash(sizer)
    };
    setTimeout(function () {
      var doc = surface.doc;
      if (!doc) return;
      if (!doc.layout) {
        doc.layout = layoutNow;
        saveSoon(doc);
        return;
      }
      if (doc.layout.hash && doc.layout.hash !== layoutNow.hash &&
        !state.driftNotified[doc.target]) {
        state.driftNotified[doc.target] = 1;
        inkStatus("版面已变化：手写墨迹仍按写入时的位置显示，可能与文字错位。", 6000);
      }
      if (!doc.layout.hash || doc.layout.hash !== layoutNow.hash) {
        doc.layout = layoutNow;
        saveSoon(doc);
      }
    }, 1200);
    return surface;
  }

  /* Legacy viewport-reprojection implementation: kept only as a short-lived
     reference while the tiled surface is device-tested; never called. */
  function createMarkdownSurfaceLegacy(leaf) {
    var view = leaf.view;
    if (!view || view.getViewType() !== "markdown") return null;
    if (typeof view.getMode === "function" && view.getMode() !== "preview") return null;
    var rootEl = view.containerEl ? view.containerEl.querySelector(".markdown-reading-view") : null;
    if (!rootEl) return null;
    var sizer = rootEl.querySelector(".markdown-preview-sizer");
    if (!sizer) return null;
    var rect = sizer.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    if (getComputedStyle(sizer).display === "none") return null;
    if (getComputedStyle(rootEl).position === "static") rootEl.style.position = "relative";
    // Earlier builds put the canvas inside the sizer, which for a long note
    // allocates a canvas as tall as the whole document. Migrate to a
    // viewport-sized canvas anchored to the reading view; the scroll listener
    // re-projects strokes on every scroll frame.
    removeCanvas(sizer, "ohsidian-ink-base");
    removeCanvas(sizer, "ohsidian-ink-live");
    var base = ensureCanvas(rootEl, "ohsidian-ink-base", 5);
    var live = ensureCanvas(rootEl, "ohsidian-ink-live", 6);
    var scroller = rootEl.querySelector(".markdown-preview-view") || sizer.parentElement || rootEl;
    var surface = {
      kind: "markdown",
      leaf: leaf,
      rootEl: rootEl,
      sizer: sizer,
      scroller: scroller,
      base: base,
      live: live,
      dpr: window.devicePixelRatio || 1,
      w: 0,
      h: 0,
      space: "md:abs",
      doc: null,
      rects: null,
      scrollHandler: null,
      raf: 0,
      refreshRects: function () {
        this.rects = {
          root: rootEl.getBoundingClientRect(),
          sizer: sizer.getBoundingClientRect()
        };
        return this.rects;
      },
      toSpace: function (clientX, clientY) {
        var r = sizer.getBoundingClientRect();
        return [clientX - r.left, clientY - r.top];
      },
      toCanvasPoint: function (x, y) {
        var r = this.rects || this.refreshRects();
        return [
          x + r.sizer.left - r.root.left,
          y + r.sizer.top - r.root.top
        ];
      },
      widthScale: function () {
        return 1;
      },
      contains: function (el) {
        return !!(el && sizer.contains(el));
      },
      resize: function () {
        var w = Math.max(1, rootEl.clientWidth || 0);
        var h = Math.max(1, rootEl.clientHeight || 0);
        if (w <= 1 || h <= 1) return;
        var dpr = window.devicePixelRatio || 1;
        if (w === this.w && h === this.h && dpr === this.dpr && this.base.width > 0) {
          this.redraw();
          return;
        }
        this.w = w;
        this.h = h;
        this.dpr = dpr;
        sizeCanvas(this.base, w, h, dpr);
        sizeCanvas(this.live, w, h, dpr);
        this.redraw();
      },
      redraw: function () {
        this.refreshRects();
        var ctx = this.base.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.base.width, this.base.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        var doc = this.doc;
        if (!doc) return;
        for (var pass = 0; pass < 2; pass++) {
          for (var i = 0; i < doc.strokes.length; i++) {
            var st = doc.strokes[i];
            if (st.space !== this.space || st.baked) continue;
            if (pass === 0 && st.tool !== "highlighter") continue;
            if (pass === 1 && st.tool === "highlighter") continue;
            drawStrokeOnCtx(ctx, st, this);
          }
        }
      },
      scheduleRedraw: function () {
        if (this.raf) return;
        var self = this;
        this.raf = requestAnimationFrame(function () {
          self.raf = 0;
          self.redraw();
          var a = state.active;
          if (a && a.kind === "stroke" && a.surface === self) self.drawLive(a.stroke);
        });
      },
      bindScroll: function () {
        if (this.scrollHandler) return;
        var self = this;
        this.scrollHandler = function () { self.scheduleRedraw(); };
        try {
          scroller.addEventListener("scroll", this.scrollHandler, { passive: true });
        } catch (e) {
          scroller.addEventListener("scroll", this.scrollHandler);
        }
      },
      drawLive: function (stroke) {
        this.refreshRects();
        var ctx = this.live.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.live.width, this.live.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        if (stroke) drawStrokeOnCtx(ctx, stroke, this);
      },
      clearLive: function () {
        var ctx = this.live.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.live.width, this.live.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      },
      unmount: function () {
        try {
          if (this.scrollHandler) scroller.removeEventListener("scroll", this.scrollHandler);
        } catch (e) {}
        removeCanvas(rootEl, "ohsidian-ink-base");
        removeCanvas(rootEl, "ohsidian-ink-live");
      }
    };
    surface.doc = docFor(surface);
    surface.bindScroll();
    surface.resize();
    // Layout drift: the note is rendered at absolute coordinates, so a reflow
    // (font size, window width, theme) moves the text under the ink. Tell the
    // user once per session instead of silently drifting.
    var layoutNow = {
      width: Math.round(sizer.getBoundingClientRect().width) || 0,
      blocks: sizer.children ? sizer.children.length : 0,
      hash: layoutHash(sizer)
    };
    setTimeout(function () {
      var doc = surface.doc;
      if (!doc) return;
      if (!doc.layout) {
        doc.layout = layoutNow;
        saveSoon(doc);
        return;
      }
      if (doc.layout.hash && doc.layout.hash !== layoutNow.hash &&
        !state.driftNotified[doc.target]) {
        state.driftNotified[doc.target] = 1;
        inkStatus("版面已变化：手写墨迹仍按写入时的位置显示，可能与文字错位。", 6000);
      }
      if (!doc.layout.hash || doc.layout.hash !== layoutNow.hash) {
        doc.layout = layoutNow;
        saveSoon(doc);
      }
    }, 1200);
    return surface;
  }

  // ---------------------------------------------------------------------
  // Surfaces: PDF pages
  // ---------------------------------------------------------------------
  // Obsidian 1.13.7 nests the PDF viewer three deep:
  //   leaf.view.viewer        -> T1, the async host component
  //   T1.child                -> x1, the component that owns the viewer
  //   x1.pdfViewer            -> Obsidian's pdf.js wrapper
  //   x1.pdfViewer.pdfViewer  -> the pdf.js PDFViewer (getPageView)
  // T1 has a `child` field, not `pdfViewer`; following only `.pdfViewer`
  // never reaches the viewer, which is what left the surface unmounted.
  function pdfViewerChain(view) {
    var chain = [];
    var seen = [];
    function walk(obj, depth) {
      if (!obj || typeof obj !== "object" || depth > 5 || seen.indexOf(obj) >= 0) return;
      seen.push(obj);
      chain.push(obj);
      var next = [];
      try {
        if (obj.pdfViewer && obj.pdfViewer !== obj) next.push(obj.pdfViewer);
        if (obj.viewer && obj.viewer !== obj) next.push(obj.viewer);
        if (obj.child && obj.child !== obj) next.push(obj.child);
      } catch (e) {}
      for (var i = 0; i < next.length; i++) walk(next[i], depth + 1);
    }
    try {
      walk(view.pdfViewer, 0);
      walk(view.viewer, 0);
      walk(view.pdfViewerComponent, 0);
    } catch (eW) {}
    return chain;
  }

  function pdfJsViewerOf(view) {
    var chain = pdfViewerChain(view);
    for (var i = 0; i < chain.length; i++) {
      if (chain[i] && typeof chain[i].getPageView === "function") return chain[i];
    }
    return null;
  }

  // pdf.js keeps `pdfjs.history` in localStorage as
  // {files:[{fingerprint,page,zoom,scrollTop,...}]}. Reading the entry for the
  // document that is loading lets us restore the page before the render queue
  // starts on page 1.
  function pdfHistoryPage(viewer) {
    try {
      var doc = viewer && viewer.pdfDocument;
      if (!doc) return 0;
      var fp = (doc.fingerprints && doc.fingerprints[0]) || doc.fingerprint || "";
      if (!fp) return 0;
      var raw = "";
      try { raw = localStorage.getItem("pdfjs.history") || ""; } catch (eR) { return 0; }
      if (!raw) return 0;
      var hist = JSON.parse(raw);
      var files = (hist && hist.files) || [];
      for (var i = 0; i < files.length; i++) {
        if (files[i] && files[i].fingerprint === fp) {
          var p = Number(files[i].page);
          return p > 0 ? Math.floor(p) : 0;
        }
      }
    } catch (e) {}
    return 0;
  }

  function pdfContainerOf(view, chain) {
    var i;
    // Prefer the live view DOM: during load Obsidian builds the pdf.js DOM in
    // a detached `loadingEl` first, and canvas mounted there is invisible.
    // A connected .pdf-container exists before the first page is created, so
    // the surface can attach (and hook documentloaded) earlier.
    var root = view.containerEl;
    if (root && root.querySelector) {
      var names = [".pdf-container", ".pdf-viewer-container", ".pdfViewer"];
      for (i = 0; i < names.length; i++) {
        var el = null;
        try { el = root.querySelector(names[i]); } catch (eQ) {}
        if (el && el.isConnected) return el;
      }
    }
    for (i = 0; i < chain.length; i++) {
      var o = chain[i];
      if (!o) continue;
      var cand = o.containerEl || o.pdfContainerEl || o.viewerContainerEl ||
        o.container || o.viewer;
      if (cand && cand.isConnected && cand.querySelector &&
        (cand.classList && cand.classList.contains("pdf-container") ||
          cand.querySelector(".page[data-page-number]"))) return cand;
    }
    if (root && root.isConnected) return root;
    return null;
  }

  function pdfEntryDark(pageEl) {
    try {
      var cs = getComputedStyle(pageEl);
      var c = inkParseColor((cs.getPropertyValue("--pdf-page-background") || "").trim());
      if (!c || c.a <= 0.1) c = inkParseColor(cs.backgroundColor);
      // An unset/transparent page background is the normal white PDF page.
      if (!c || c.a <= 0.1) return false;
      var lum = 0.2126 * inkLinear(c.r) + 0.7152 * inkLinear(c.g) +
        0.0722 * inkLinear(c.b);
      return lum < 0.42;
    } catch (e) {
      return false;
    }
  }

  function createPdfSurface(leaf) {
    var view = leaf.view;
    if (!view || view.getViewType() !== "pdf") return null;
    var chain = pdfViewerChain(view);
    var viewer = null;
    for (var vi = 0; vi < chain.length; vi++) {
      if (chain[vi] && typeof chain[vi].getPageView === "function") {
        viewer = chain[vi];
        break;
      }
    }
    var container = pdfContainerOf(view, chain);
    var pageCount = container && container.querySelectorAll
      ? container.querySelectorAll(".page[data-page-number]").length : 0;
    if (!viewer || !container) {
      // The PDF component assigns .pdfViewer asynchronously; a refresh a few
      // hundred ms later will find it. Never fall back to a whole-container
      // DOM surface here: it writes normalized coordinates from the wrong
      // origin and turns handwriting into abstract art.
      inkTrace("pdfSurfaceWait", {
        hasViewer: !!viewer,
        hasContainer: !!container,
        pages: pageCount,
        component: !!(view && view.viewer),
        chain: chain.length
      });
      return null;
    }
    inkTrace("pdfSurfaceEnter", {
      depth: chain.indexOf(viewer),
      pages: pageCount,
      containerClass: container.className ? String(container.className).slice(0, 48) : ""
    });
    state.pdfRetryTries = 0;
    var surface = {
      kind: "pdf",
      leaf: leaf,
      viewer: viewer,
      // The Obsidian component instance that owns `viewer`. On a document
      // reload pdf.js swaps the inner viewer; comparing this is how the mount
      // loop notices and rebuilds the surface.
      pdfOwner: view.viewer || view,
      container: container,
      pages: {},
      renderedPages: {},
      previewTimer: 0,
      previewPage: -1,
      previewTries: 0,
      previewRetry: 0,
      previewHold: false,
      previewHoldTimer: 0,
      previewCover: null,
      fixedPreview: null,
      // Probe state (device agent reads probe:* lines from hilog).
      openedAt: nowMs(),
      docLoadedAt: 0,
      reloads: 0,
      annoProbed: false,
      rendered: 0,
      // True while pdf.js' annotation layer corresponds to the current PDF
      // bytes. It flips false after we replace the file; the overlay then keeps
      // showing baked strokes until the document reloads.
      annotationFresh: true,
      pageStarts: {},
      // The overlay never needs more than 2x; 2.249 costs 26% more pixels
      // per page with no visible gain on handwriting at reading distance.
      dpr: Math.min(window.devicePixelRatio || 1, 2),
      io: null,
      scaleTimer: 0,
      disposed: false,
      doc: null,
      currentSpace: "",
      hooks: false,
      containsPage: function (pageEl) {
        return !!(pageEl && container.contains(pageEl));
      },
      pageOf: function (el) {
        try {
          return el && el.closest ? el.closest(".page[data-page-number]") : null;
        } catch (e) {
          return null;
        }
      },
      pageHasInk: function (index) {
        var doc = this.doc;
        if (!doc || !doc.strokes) return false;
        var space = "pdf:" + index;
        for (var i = 0; i < doc.strokes.length; i++) {
          var st = doc.strokes[i];
          if (st && st.space === space) return true;
        }
        return false;
      },
      ensurePage: function (pageEl, force) {
        if (!pageEl || this.disposed) return null;
        var idx = parseInt(pageEl.dataset.pageNumber, 10);
        if (!(idx > 0)) return null;
        var index = idx - 1;
        // Most pages carry no ink. Allocating a base+live canvas for them is
        // pure compositing cost: on the tablet a scroll over such pages drops
        // to ~39 fps, while the same scroll with no overlay canvases is a
        // locked 60 fps. Only mount canvases for pages that actually have
        // strokes, or when a stroke is about to start (force=true).
        var activeHere = !!(state.active && state.active.surface === this);
        if (!force && !activeHere && !this.pageHasInk(index)) {
          var dead = this.pages[index];
          if (dead && (dead.cv || dead.live)) {
            try { removeCanvas(pageEl, "ohsidian-ink-pdf"); } catch (eRm) {}
            try { removeCanvas(pageEl, "ohsidian-ink-pdf-live"); } catch (eRl) {}
            delete this.pages[index];
          }
          return null;
        }
        var pageView = null;
        try { pageView = this.viewer.getPageView(index); } catch (e) {}
        if (!pageView || !pageView.viewport) return null;
        var vp = pageView.viewport;
        // getComputedStyle forces a style flush. Probe each page once: pdf.js
        // keeps the page div for the lifetime of the viewer.
        if (pageEl.dataset.ohsidianInkPos !== "1") {
          try {
            if (getComputedStyle(pageEl).position === "static") pageEl.style.position = "relative";
          } catch (ePos) {}
          pageEl.dataset.ohsidianInkPos = "1";
        }
        var cv = ensureCanvas(pageEl, "ohsidian-ink-pdf", 4);
        // Separate live layer: writing must not clear the committed ink on this
        // page, and the commit must not be wiped when the live layer clears.
        // (One shared canvas made the committed stroke vanish two frames after
        // pen-up: clearLiveAfterPaint cleared the only canvas.)
        var live = ensureCanvas(pageEl, "ohsidian-ink-pdf-live", 5);
        var entry = this.pages[index];
        // pdf.js hands out a new viewport object on every render even when the
        // geometry is identical. Recreating the entry (and its two canvases)
        // for that would leave the old canvas in the DOM under the active
        // stroke, drawing ghost trails next to the committed ink.
        var sameGeom = !!(entry && entry.viewport &&
          Math.abs((entry.viewport.width || 0) - (vp.width || 0)) < 0.5 &&
          Math.abs((entry.viewport.height || 0) - (vp.height || 0)) < 0.5 &&
          Math.abs((entry.viewport.scale || 0) - (vp.scale || 0)) < 0.0001);
        if (entry && entry.pageEl === pageEl && entry.cv === cv &&
          entry.live === live && sameGeom) {
          entry.viewport = vp;
          return entry;
        }
        if (entry && (entry.cv !== cv || entry.live !== live)) {
          // Geometry changed (zoom) or pdf.js replaced the page: drop the old
          // canvases even when a stroke is active. The new entry is repainted
          // from the document below.
          try {
            if (entry.cv && entry.cv.parentNode) entry.cv.parentNode.removeChild(entry.cv);
          } catch (eOC) {}
          try {
            if (entry.live && entry.live.parentNode) entry.live.parentNode.removeChild(entry.live);
          } catch (eOL) {}
        }
        if (!entry || entry.pageEl !== pageEl || entry.viewport !== vp ||
          entry.cv !== cv || entry.live !== live || !sameGeom) {
          var w = Math.max(1, vp.width);
          var h = Math.max(1, vp.height);
          sizeCanvas(cv, w, h, this.dpr);
          sizeCanvas(live, w, h, this.dpr, { alpha: true, desynchronized: true });
          entry = {
            index: index,
            pageEl: pageEl,
            cv: cv,
            live: live,
            viewport: vp,
            space: "pdf:" + index,
            w: w,
            h: h
          };
          this.pages[index] = entry;
          // Populate a newly mounted page immediately; pagerendered may have
          // already fired before the observer/pen-down created this canvas.
          this.redrawPage(entry);
        }
        return entry;
      },
      dropPage: function (entry) {
        if (!entry) return;
        // Never tear down the page the pen is writing on. The next refresh
        // collects it after the stroke is committed.
        if (state.active && state.active.surface === this &&
          (!state.active.entry || state.active.entry === entry)) return;
        dropPdfPreview(this, entry.index);
        try {
          if (entry.cv && entry.cv.parentNode) entry.cv.parentNode.removeChild(entry.cv);
        } catch (e) {}
        try {
          if (entry.live && entry.live.parentNode) entry.live.parentNode.removeChild(entry.live);
        } catch (eL) {}
        if (this.pages[entry.index] === entry) delete this.pages[entry.index];
      },
      dropPageEl: function (pageEl) {
        for (var key in this.pages) {
          if (!Object.prototype.hasOwnProperty.call(this.pages, key)) continue;
          if (this.pages[key] && this.pages[key].pageEl === pageEl) {
            this.dropPage(this.pages[key]);
            return;
          }
        }
      },
      prunePages: function () {
        var dead = [];
        for (var key in this.pages) {
          if (!Object.prototype.hasOwnProperty.call(this.pages, key)) continue;
          var entry = this.pages[key];
          if (!entry || !entry.pageEl || !entry.pageEl.isConnected ||
            !entry.cv || !entry.cv.isConnected) {
            dead.push(entry);
          }
        }
        for (var i = 0; i < dead.length; i++) this.dropPage(dead[i]);
      },
      surfaceAt: function (el) {
        var pageEl = this.pageOf(el);
        if (!pageEl) return null;
        // A pen-down must always get an entry, even on a blank page: this is
        // where the base+live canvases are created for the first stroke.
        return this.ensurePage(pageEl, true);
      },
      toSpaceOn: function (entry, clientX, clientY) {
        // Use the ink canvas' box, not the page div: the page can carry a
        // border/padding or a CSS transform, and the old page-rect math then
        // shifted every written annotation by a pixel or two.
        var r = entry._spaceRect ||
          (entry.cv ? entry.cv.getBoundingClientRect() : entry.pageEl.getBoundingClientRect());
        var sx = entry.w / Math.max(1, r.width);
        var sy = entry.h / Math.max(1, r.height);
        var cssX = (clientX - r.left) * sx;
        var cssY = (clientY - r.top) * sy;
        try {
          var pt = entry.viewport.convertToPdfPoint(cssX, cssY);
          return [pt[0], pt[1]];
        } catch (e) {
          return [cssX, cssY];
        }
      },
      toCanvasPointOn: function (entry, x, y) {
        try {
          var p = entry.viewport.convertToViewportPoint(x, y);
          return [p[0], p[1]];
        } catch (e) {
          return [x, y];
        }
      },
      widthScaleOn: function (entry) {
        return entry && entry.viewport ? entry.viewport.scale : 1;
      },
      erasePreview: function (clientX, clientY, radius, entry) {
        if (!entry || !entry.cv) return;
        var r = entry.cv.getBoundingClientRect();
        var sx = entry.w / Math.max(1, r.width);
        var sy = entry.h / Math.max(1, r.height);
        var x = (clientX - r.left) * sx;
        var y = (clientY - r.top) * sy;
        var rr = Math.max(1, radius * ((sx + sy) / 2));
        var ctx = entry.cv.getContext("2d");
        ctx.save();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      },
      redrawPage: function (entry) {
        if (!entry || !entry.cv || !entry.cv.isConnected) return;
        // Highlighter must multiply with the PDF page content, not paint a
        // translucent yellow veil over it. On a white page multiply keeps
        // black text black and only tints the paper. Dark pages keep the
        // normal source-over path because their automatic ink is light.
        try {
          var bm = pdfEntryDark(entry.pageEl) ? "normal" : "multiply";
          if (entry.cv.style.mixBlendMode !== bm) entry.cv.style.mixBlendMode = bm;
          if (entry.live && entry.live.style.mixBlendMode !== bm) {
            entry.live.style.mixBlendMode = bm;
          }
          if (entry._blendProbe !== bm || !entry._blendProbeAt ||
            nowMs() - entry._blendProbeAt > 500) {
            entry._blendProbe = bm;
            entry._blendProbeAt = nowMs();
            probeHook("pdfBlend", { page: entry.index, mode: bm });
          }
        } catch (eBlend) {}
        var ctx = entry.cv.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, entry.cv.width, entry.cv.height);
        var doc = this.doc;
        if (!doc) return;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        // Read the preference once per page, not once per stroke.
        var showBaked = pref("inkPdfAfterBake", "keep") === "keep";
        // While erasing/moving/selecting, baked highlighter must be visible so
        // the preview and selection have something to act on. In normal pen
        // mode it is hidden: the /Highlight annotation is the only copy, and
        // drawing the overlay too would double the 0.38 alpha (darker bands).
        var editingBaked = state.tool === "eraser" || state.tool === "lasso" ||
          !!(state.active && (state.active.kind === "erase" || state.active.kind === "move"));
        var hideBakedHl = this.annotationFresh !== false;
        // Highlighter is a background wash: draw every highlighter first, then
        // pen/other strokes, so a later highlight can never fade black ink.
        for (var pass = 0; pass < 2; pass++) {
          for (var i = 0; i < doc.strokes.length; i++) {
            var st = doc.strokes[i];
            if (st.space !== entry.space) continue;
            if (pass === 0 && st.tool !== "highlighter") continue;
            if (pass === 1 && st.tool === "highlighter") continue;
            if (st.baked) {
              if (st.tool === "highlighter") {
                if (st.pdfHl === true && hideBakedHl && !editingBaked) continue;
              } else if (!showBaked) {
                continue;
              }
            }
            drawStrokeOnCtx(ctx, st, {
              toCanvasPoint: (function (e) {
                return function (x, y) { return surface.toCanvasPointOn(e, x, y); };
              })(entry),
              widthScale: (function (e) {
                return function () { return surface.widthScaleOn(e); };
              })(entry)
            });
          }
        }
      },
      redraw: function () {
        for (var key in this.pages) {
          if (!Object.prototype.hasOwnProperty.call(this.pages, key)) continue;
          this.redrawPage(this.pages[key]);
        }
      },
      drawLive: function (entry, stroke) {
        if (!entry) return;
        var layer = entry.live || entry.cv;
        if (!layer) return;
        var ctx = layer.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, layer.width, layer.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        if (stroke) {
          drawStrokeOnCtx(ctx, stroke, {
            toCanvasPoint: function (x, y) { return surface.toCanvasPointOn(entry, x, y); },
            widthScale: function () { return surface.widthScaleOn(entry); }
          });
        }
      },
      clearLive: function (entry) {
        if (!entry) return;
        var layer = entry.live;
        if (!layer) return;
        var ctx = layer.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, layer.width, layer.height);
      },
      observePages: function () {
        var self = this;
        var els = this.container.querySelectorAll(".page[data-page-number]");
        if (typeof IntersectionObserver !== "function") return false;
        if (!this.io) {
          // Keep the overlay within ±1.2 screens of the viewport. pdf.js can
          // render pages ahead of the visible area; without this bound an
          // overlay canvas is allocated for every page ever visited.
          this.io = new IntersectionObserver(function (entries) {
            if (self.disposed || !state.enabled) return;
            for (var i = 0; i < entries.length; i++) {
              var en = entries[i];
              var pageEl = en.target;
              if (en.isIntersecting) {
                // ensurePage redraws only when it actually mounted/resized the
                // page, so re-observing on every layout change stays cheap.
                try { self.ensurePage(pageEl); } catch (e) {}
              } else {
                self.dropPageEl(pageEl);
              }
            }
          }, { root: null, rootMargin: "120% 0px" });
        }
        // Rebuild the observation set: page divs can be replaced when pdf.js
        // loads another document in the same leaf.
        try { this.io.disconnect(); } catch (e2) {}
        for (var j = 0; j < els.length; j++) {
          try { this.io.observe(els[j]); } catch (e3) {}
        }
        return true;
      },
      refreshPages: function () {
        this.prunePages();
        var els = this.container.querySelectorAll(".page[data-page-number]");
        if (this.observePages()) return;
        // No IntersectionObserver (very old engine): preserve the old
        // behaviour rather than losing ink on non-visible pages entirely.
        for (var i = 0; i < els.length; i++) this.ensurePage(els[i]);
        this.redraw();
      },
      attach: function () {
        if (this.hooks) return;
        this.hooks = true;
        var self = this;
        var onDocLoaded = function (e) {
          if (!window.__ohsidianProbeHooks) return;
          try {
            var ms = Math.round(nowMs() - self.openedAt);
            if (self.docLoadedAt) {
              self.reloads++;
              self.annoProbed = false;
              probeHook("pdfReload", {
                reloads: self.reloads,
                ms: ms,
                pages: e && e.pagesCount,
                afterWrite: state.lastPdfWriteAt ? Date.now() - state.lastPdfWriteAt : -1,
                fakeWorker: window.__ohsidianFakeWorker || 0
              });
            } else {
              self.docLoadedAt = nowMs();
              probeHook("pdfDocLoaded", {
                pages: e && e.pagesCount,
                ms: ms,
                fakeWorker: window.__ohsidianFakeWorker || 0
              });
            }
          } catch (eD) {}
        };
        var onPagesInit = function (e) {
          try {
            // A new document was parsed from the current file; its annotation
            // layer now matches the sidecar's baked flags again.
            self.docGeneration = (self.docGeneration || 0) + 1;
            self.annotationFresh = true;
            probeHook("pdfPagesInit", {
              pages: e && e.pagesCount,
              ms: Math.round(nowMs() - self.openedAt)
            });
            if (window.__ohsidianAgentBuild) {
              pdfScanFilters(self.viewer);
              setTimeout(function () {
                try {
                  if (!self.viewer.pagesCount) return;
                  var pv0 = self.viewer.getPageView(0);
                  var pp0 = pv0 && pv0.pdfPage;
                  if (!pp0 || !pp0.getOperatorList) return;
                  var t0 = nowMs();
                  pp0.getOperatorList().then(function (ol) {
                    probeHook("pdfOpList", {
                      page: 1,
                      ms: Math.round(nowMs() - t0),
                      ops: ol && ol.fnArray ? ol.fnArray.length : -1
                    });
                  }).catch(function () {});
                } catch (e0) {}
              }, 200);
            }
            // pdf.js persists {fingerprint,page,scrollTop} in localStorage.
            // Restoring the page only after pagesinit means pdf.js has already
            // queued a render of page 1; a heavy cover page then blocks the
            // serialized render queue for 10+ seconds (the white first page).
            // Jump to the stored page while the document is still initializing.
            var jumpPage = pdfHistoryPage(self.viewer);
            if (jumpPage > 2 && self.viewer.currentPageNumber === 1) {
              var sc = null;
              try { sc = self.viewer.container || null; } catch (eSC) {}
              if (sc && sc.querySelector) {
                var pe = sc.querySelector('.page[data-page-number="' + jumpPage + '"]');
                if (pe && pe.offsetTop > 0) {
                  try { sc.scrollTop = pe.offsetTop; } catch (ePJ) {}
                }
              }
              try { self.viewer.currentPageNumber = jumpPage; } catch (eCJ) {}
              probeHook("pdfPreJump", { page: jumpPage });
            }
            // Page divs exist now; mount the overlay canvases even if the
            // surface attached before the document finished loading.
            self.refreshPages();
          } catch (eP) {}
        };
        var onPageStart = function (e) {
          try {
            var pn = e && e.pageNumber;
            var vp = e && e.source && e.source.viewport;
            if (pn > 0) {
              self.pageStarts[pn] = {
                t: nowMs(),
                w: vp ? Math.round(vp.width) : 0,
                h: vp ? Math.round(vp.height) : 0
              };
            }
          } catch (eS0) {}
        };
        var onRendered = function (e) {
          try {
            var pageEl = e && e.source && e.source.div;
            var pn = e && e.pageNumber;
            if (!(pn > 0) && pageEl) pn = parseInt(pageEl.dataset.pageNumber, 10) || 0;
            var st = pn ? self.pageStarts[pn] : null;
            var vp = e && e.source && e.source.viewport;
            var cv = e && e.source && e.source.canvas;
            if (pn > 0) {
              self.renderedPages[pn] = true;
              dropPdfPreview(self, pn - 1);
            }
            self.rendered++;
            probeHook("pdfPage", {
              page: pn,
              ms: st ? Math.round(nowMs() - st.t) : -1,
              w: vp ? Math.round(vp.width) : (cv ? cv.width : 0),
              h: vp ? Math.round(vp.height) : (cv ? cv.height : 0),
              scale: vp ? Number(vp.scale.toFixed(3)) : 0,
              rendered: self.rendered,
              afterWrite: state.lastPdfWriteAt ? Date.now() - state.lastPdfWriteAt : -1,
              canvas: cv
            });
            if (!pageEl) return;
            var entry = self.ensurePage(pageEl);
            if (!entry) return;
            self.drawLive(entry, null);
            // Only this page changed. The old code cleared and repainted
            // every mounted page here, i.e. N clears for each of N renders.
            self.redrawPage(entry);
            if (window.__ohsidianAgentBuild && pn === 1 && !self.opProbed) {
              self.opProbed = true;
              try {
                var pp1 = e && e.source && e.source.pdfPage;
                if (pp1 && pp1.getOperatorList) {
                  pp1.getOperatorList().then(function (ol) {
                    var hist = {};
                    for (var oi = 0; oi < ol.fnArray.length; oi++) {
                      var f = ol.fnArray[oi];
                      hist[f] = (hist[f] || 0) + 1;
                    }
                    var top = Object.keys(hist).map(function (k) {
                      return [Number(k), hist[k]];
                    }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);
                    var detail = [];
                    for (var di = 0; di < ol.fnArray.length; di++) {
                      var args = (ol.argsArray && ol.argsArray[di]) || [];
                      var compact = [];
                      for (var ai = 0; ai < args.length && ai < 3; ai++) {
                        var v = args[ai];
                        if (typeof v === "number") compact.push(v);
                        else if (typeof v === "string") compact.push(v.slice(0, 24));
                        else if (v && typeof v === "object") {
                          compact.push(v.width ? ("obj:" + v.width + "x" + v.height) : "[obj]");
                        } else compact.push(String(v));
                      }
                      detail.push([ol.fnArray[di], compact]);
                    }
                    probeHook("pdfOps", {
                      page: 1,
                      total: ol.fnArray.length,
                      top: top,
                      detail: detail
                    });
                  }).catch(function () {});
                }
              } catch (eOp) {}
            }
            /* OHSIDIAN_DEV_PROBE_START */
            if (state.lastPdfWriteAt &&
              !self.annoProbed && pn === self.viewer.currentPageNumber) {
              self.annoProbed = true;
              try {
                var pp = e && e.source && e.source.pdfPage;
                if (pp && pp.getAnnotations) {
                  pp.getAnnotations().then(function (list) {
                    var counts = {};
                    for (var ai = 0; ai < list.length; ai++) {
                      var st = list[ai].subtype || "?";
                      counts[st] = (counts[st] || 0) + 1;
                    }
                    var layer = pageEl.querySelector(".annotationLayer");
                    probeHook("pdfAnnoInfo", {
                      page: pn,
                      total: list.length,
                      counts: counts,
                      layerChildren: layer ? layer.children.length : -1,
                      sample: list.slice(0, 3).map(function (a) {
                        return { subtype: a.subtype || "", rect: a.rect || null };
                      })
                    });
                  }).catch(function () {});
                }
              } catch (eAn) {}
            }
            /* OHSIDIAN_DEV_PROBE_END */
          } catch (e2) {}
        };
        var onPageChanging = function (e) {
          try {
            var to = e && e.pageNumber;
            // Do NOT scroll here. pdf.js fires pagechanging for ordinary
            // finger scrolling too; snapping scrollTop to pageEl.offsetTop on
            // every crossing made a slow swipe through the gap between page a
            // and a+1 jump back to the top of page a. The stored-page restore
            // already sets the scroll position before pagesinit.
            probeHook("pdfPageChange", {
              from: e && e.previous,
              to: to,
              ms: Math.round(nowMs() - self.openedAt)
            });
          } catch (eC) {}
        };
        var onScale = function () {
          if (self.scaleTimer) clearTimeout(self.scaleTimer);
          self.scaleTimer = setTimeout(function () {
            self.scaleTimer = 0;
            try {
              probeHook("pdfScale", {
                scale: self.viewer && self.viewer.currentScaleValue,
                ms: Math.round(nowMs() - self.openedAt)
              });
              self.refreshPages();
            } catch (eS) {}
          }, 120);
        };
        this.handlers = {
          rendered: onRendered,
          scale: onScale,
          doc: onDocLoaded,
          pages: onPagesInit,
          pageStart: onPageStart,
          pageChange: onPageChanging
        };
        try {
          this.viewer.eventBus.on("pagerendered", onRendered);
          this.viewer.eventBus.on("pagerender", onPageStart);
          this.viewer.eventBus.on("documentloaded", onDocLoaded);
          this.viewer.eventBus.on("pagesinit", onPagesInit);
          this.viewer.eventBus.on("pagechanging", onPageChanging);
          this.viewer.eventBus.on("scalechanging", onScale);
          this.viewer.eventBus.on("scalechanged", onScale);
        } catch (e) {
          warn("pdf eventBus unavailable", e && e.message);
        }
        setTimeout(function () { self.refreshPages(); }, 0);
      },
      unmount: function () {
        this.disposed = true;
        try {
          if (this.handlers) {
            this.viewer.eventBus.off("pagerendered", this.handlers.rendered);
            this.viewer.eventBus.off("pagerender", this.handlers.pageStart);
            this.viewer.eventBus.off("documentloaded", this.handlers.doc);
            this.viewer.eventBus.off("pagesinit", this.handlers.pages);
            this.viewer.eventBus.off("pagechanging", this.handlers.pageChange);
            this.viewer.eventBus.off("scalechanging", this.handlers.scale);
            this.viewer.eventBus.off("scalechanged", this.handlers.scale);
          }
        } catch (eOff) {}
        try {
          if (this.io) {
            this.io.disconnect();
            this.io = null;
          }
        } catch (eIO) {}
        if (this.scaleTimer) {
          clearTimeout(this.scaleTimer);
          this.scaleTimer = 0;
        }
        for (var key in this.pages) {
          if (!Object.prototype.hasOwnProperty.call(this.pages, key)) continue;
          var entry = this.pages[key];
          try {
            if (entry && entry.cv && entry.cv.parentNode) entry.cv.parentNode.removeChild(entry.cv);
          } catch (e) {}
        }
        this.pages = {};
      }
    };
    surface.doc = docFor(surface);
    // Migration: old /PolyLine highlighter strokes are marked written=false on
    // load. Without asking for a write they would never be converted, because
    // nothing else marks the page dirty. "leave" only registers the surface;
    // the actual rewrite happens when the PDF leaf is left.
    try {
      var pendingHl = false;
      if (surface.doc && surface.doc.strokes) {
        for (var ph = 0; ph < surface.doc.strokes.length; ph++) {
          var pst = surface.doc.strokes[ph];
          if (pst && pst.tool === "highlighter" && pst.written === false) {
            pendingHl = true;
            break;
          }
        }
      }
      if (pendingHl) schedulePdfWrite(surface);
    } catch (ePh) {}
    surface.attach();
    surface.refreshPages();
    probeHook("pdfSurface", {
      target: (leaf.view.file && leaf.view.file.path) || "",
      pages: surface.viewer.pagesCount || 0,
      scale: surface.viewer.currentScaleValue || "",
      overlayPages: Object.keys(surface.pages || {}).length,
      fakeWorker: window.__ohsidianFakeWorker || 0,
      dpr: surface.dpr,
      overlay: [surface.container && surface.container.clientWidth,
        surface.container && surface.container.clientHeight]
    });
    inkTrace("surface", {
      kind: "pdf",
      target: (leaf.view.file && leaf.view.file.path) || "",
      pages: Object.keys(surface.pages || {}).length
    });
    return surface;
  }

  // ---------------------------------------------------------------------
  // Surface registry
  // ---------------------------------------------------------------------
  function surfaceForLeaf(leaf) {
    for (var i = 0; i < state.surfaces.length; i++) {
      if (state.surfaces[i].leaf === leaf) return state.surfaces[i];
    }
    return null;
  }

  function removeSurface(surface) {
    if (state.selection && state.selection.surface === surface) clearSelection();
    if (state.active && state.active.surface === surface) {
      // Never leave a live stroke pointing at a detached surface; commit it to
      // its doc first, then tear the DOM down.
      try { forceReleaseActive(true); } catch (eR) {}
    }
    try { surface.unmount(); } catch (e) {}
    var i = state.surfaces.indexOf(surface);
    if (i >= 0) state.surfaces.splice(i, 1);
    if (state.activeSurface === surface) {
      state.activeSurface = null;
      state.active = null;
    }
    if (!state.active) {
      palmHide();
      clearCursor();
      inkWritingChrome(false);
    }
  }

  // ---------------------------------------------------------------------
  // Surfaces: Obsidian Canvas
  // ---------------------------------------------------------------------
  var CANVAS_TILE = 512;

  function canvasScaleOf(el) {
    try {
      var t = getComputedStyle(el).transform;
      if (!t || t === "none") return 1;
      var m = /matrix\(([^)]+)\)/.exec(t);
      if (m) {
        var p = m[1].split(",");
        var s = Math.sqrt((parseFloat(p[0]) || 1) * (parseFloat(p[0]) || 1) +
          (parseFloat(p[1]) || 0) * (parseFloat(p[1]) || 0));
        return s > 0.01 ? s : 1;
      }
      var m3 = /matrix3d\(([^)]+)\)/.exec(t);
      if (m3) {
        var q = m3[1].split(",");
        var s3 = Math.sqrt((parseFloat(q[0]) || 1) * (parseFloat(q[0]) || 1) +
          (parseFloat(q[1]) || 0) * (parseFloat(q[1]) || 0));
        return s3 > 0.01 ? s3 : 1;
      }
    } catch (e) {}
    return 1;
  }

  function createCanvasSurface(leaf) {
    var view = leaf.view;
    if (!view || view.getViewType() !== "canvas") return null;
    var wrapper = view.containerEl ? view.containerEl.querySelector(".canvas-wrapper") : null;
    if (!wrapper) return null;
    var transformed = wrapper.querySelector(".canvas");
    if (!transformed) return null;
    var width = Math.max(1, wrapper.clientWidth || 0);
    var height = Math.max(1, wrapper.clientHeight || 0);
    if (width <= 1 || height <= 1) return null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var live = document.createElement("canvas");
    live.className = "ohsidian-ink-canvas-live";
    live.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:7";
    wrapper.appendChild(live);
    sizeCanvas(live, width, height, dpr, { desynchronized: true, alpha: true });
    var host = document.createElement("div");
    host.className = "ohsidian-ink-canvas-tiles";
    host.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;" +
      "overflow:visible;pointer-events:none;z-index:9999";
    transformed.appendChild(host);

    var surface = {
      kind: "canvas",
      leaf: leaf,
      view: view,
      wrapper: wrapper,
      canvas: transformed,
      host: host,
      live: live,
      dpr: dpr,
      scale: 1,
      renderScale: 1,
      w: width,
      h: height,
      space: "canvas",
      doc: null,
      tiles: {},
      rects: null,
      raf: 0,
      resizeTimer: 0,
      zoomTimer: 0,
      zoomPoll: 0,
      currentScale: function () {
        var s = canvasScaleOf(this.canvas);
        if (Math.abs(s - 1) < 0.001) {
          var sw = canvasScaleOf(this.wrapper);
          if (sw > 0.01) return sw;
        }
        return s;
      },
      refreshScale: function () {
        this.scale = this.currentScale() || 1;
        this.refreshRects();
        return this.scale;
      },
      refreshRects: function () {
        this.rects = {
          wrapper: this.wrapper.getBoundingClientRect(),
          canvas: this.canvas.getBoundingClientRect()
        };
        return this.rects;
      },
      toSpace: function (clientX, clientY) {
        var r = this._spaceRect || this.canvas.getBoundingClientRect();
        var s = this.scale || 1;
        return [(clientX - r.left) / s, (clientY - r.top) / s];
      },
      beginStroke: function () {
        this._spaceRect = this.canvas.getBoundingClientRect();
        this.rects = null;
      },
      toCanvasPoint: function (x, y) {
        var r = this.rects || this.refreshRects();
        var s = this.scale || 1;
        return [
          x * s + r.canvas.left - r.wrapper.left,
          y * s + r.canvas.top - r.wrapper.top
        ];
      },
      widthScale: function () {
        return this.scale || 1;
      },
      widthScaleOn: function () {
        return this.scale || 1;
      },
      contains: function (el) {
        return !!(el && this.wrapper.contains(el));
      },
      ensureTile: function (tx, ty) {
        var key = tx + "," + ty;
        var t = this.tiles[key];
        if (t) return t;
        var cv = document.createElement("canvas");
        cv.className = "ohsidian-ink-canvas-tile";
        cv.style.cssText = "position:absolute;left:" + (tx * CANVAS_TILE) + "px;top:" +
          (ty * CANVAS_TILE) + "px;pointer-events:none";
        this.host.appendChild(cv);
        t = { tx: tx, ty: ty, key: key, cv: cv };
        this.tiles[key] = t;
        sizeCanvas(cv, CANVAS_TILE, CANVAS_TILE, this.renderScale);
        return t;
      },
      removeTile: function (key) {
        var t = this.tiles[key];
        if (!t) return;
        try { if (t.cv && t.cv.parentNode) t.cv.parentNode.removeChild(t.cv); } catch (e) {}
        delete this.tiles[key];
      },
      erasePreview: function (clientX, clientY, radius) {
        var p = this.toSpace(clientX, clientY);
        var r = Math.max(1, radius / (this.scale || 1));
        var tx0 = Math.floor((p[0] - r) / CANVAS_TILE);
        var tx1 = Math.floor((p[0] + r) / CANVAS_TILE);
        var ty0 = Math.floor((p[1] - r) / CANVAS_TILE);
        var ty1 = Math.floor((p[1] + r) / CANVAS_TILE);
        var R = this.renderScale || 1;
        for (var tx = tx0; tx <= tx1; tx++) {
          for (var ty = ty0; ty <= ty1; ty++) {
            var t = this.tiles[tx + "," + ty];
            if (!t || !t.cv) continue;
            var ctx = t.cv.getContext("2d");
            ctx.save();
            ctx.setTransform(R, 0, 0, R, 0, 0);
            ctx.globalCompositeOperation = "destination-out";
            ctx.beginPath();
            ctx.arc(p[0] - tx * CANVAS_TILE, p[1] - ty * CANVAS_TILE, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      },
      resize: function () {
        var w = Math.max(1, this.wrapper.clientWidth || 0);
        var h = Math.max(1, this.wrapper.clientHeight || 0);
        if (w <= 1 || h <= 1) return;
        var s = this.currentScale() || 1;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var R = Math.max(1, Math.min(4, s * dpr));
        var changed = w !== this.w || h !== this.h || dpr !== this.dpr ||
          Math.abs(s - this.scale) > 0.001 || Math.abs(R - this.renderScale) > 0.001;
        this.w = w;
        this.h = h;
        this.dpr = dpr;
        this.scale = s;
        this.renderScale = R;
        if (changed) {
          sizeCanvas(this.live, w, h, dpr, { desynchronized: true, alpha: true });
        }
        var key;
        for (key in this.tiles) {
          if (!Object.prototype.hasOwnProperty.call(this.tiles, key)) continue;
          var t = this.tiles[key];
          if (t && t.cv) sizeCanvas(t.cv, CANVAS_TILE, CANVAS_TILE, R);
        }
        this.redraw();
      },
      redraw: function () {
        var doc = this.doc;
        if (!doc) return;
        var R = this.renderScale || 1;
        var needed = {};
        var i;
        for (i = 0; i < doc.strokes.length; i++) {
          var st = doc.strokes[i];
          if (st.space !== this.space || st.baked) continue;
          var b = st.bbox || bboxOf(st.pts);
          if (!b) continue;
          var tx0 = Math.floor((b[0] - 12) / CANVAS_TILE);
          var tx1 = Math.floor((b[2] + 12) / CANVAS_TILE);
          var ty0 = Math.floor((b[1] - 12) / CANVAS_TILE);
          var ty1 = Math.floor((b[3] + 12) / CANVAS_TILE);
          for (var tx = tx0; tx <= tx1; tx++) {
            for (var ty = ty0; ty <= ty1; ty++) needed[tx + "," + ty] = true;
          }
        }
        var key;
        for (key in this.tiles) {
          if (!Object.prototype.hasOwnProperty.call(this.tiles, key)) continue;
          if (!needed[key]) this.removeTile(key);
        }
        for (key in needed) {
          if (!Object.prototype.hasOwnProperty.call(needed, key)) continue;
          var parts = key.split(",");
          var t = this.ensureTile(parseInt(parts[0], 10), parseInt(parts[1], 10));
          var ctx = sizeCanvas(t.cv, CANVAS_TILE, CANVAS_TILE, R);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, t.cv.width, t.cv.height);
          ctx.setTransform(R, 0, 0, R, 0, 0);
          var tileSurface = {
            toCanvasPoint: (function (ox, oy) {
              return function (x, y) { return [x - ox, y - oy]; };
            })(t.tx * CANVAS_TILE, t.ty * CANVAS_TILE),
            widthScale: function () { return 1; }
          };
          for (var pass = 0; pass < 2; pass++) {
            for (i = 0; i < doc.strokes.length; i++) {
              var s2 = doc.strokes[i];
              if (s2.space !== this.space || s2.baked) continue;
              if (pass === 0 && s2.tool !== "highlighter") continue;
              if (pass === 1 && s2.tool === "highlighter") continue;
              var bb = s2.bbox || bboxOf(s2.pts);
              if (!bb) continue;
              if (bb[2] < t.tx * CANVAS_TILE || bb[0] > (t.tx + 1) * CANVAS_TILE) continue;
              if (bb[3] < t.ty * CANVAS_TILE || bb[1] > (t.ty + 1) * CANVAS_TILE) continue;
              drawStrokeOnCtx(ctx, s2, tileSurface);
            }
          }
        }
      },
      scheduleRedraw: function () {
        if (this.raf) return;
        var self = this;
        this.raf = requestAnimationFrame(function () {
          self.raf = 0;
          self.redraw();
          var a = state.active;
          if (a && a.kind === "stroke" && a.surface === self) self.drawLive(a.stroke);
        });
      },
      drawLive: function (stroke) {
        this.refreshRects();
        var ctx = this.live.getContext("2d", { desynchronized: true, alpha: true });
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.live.width, this.live.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        if (stroke) drawStrokeOnCtx(ctx, stroke, this);
      },
      clearLive: function () {
        var ctx = this.live.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.live.width, this.live.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      },
      bindZoom: function () {
        var self = this;
        try {
          this.onWheel = function () {
            if (self.zoomTimer) clearTimeout(self.zoomTimer);
            self.zoomTimer = setTimeout(function () {
              self.zoomTimer = 0;
              self.resize();
            }, 140);
          };
          this.wrapper.addEventListener("wheel", this.onWheel, { passive: true });
        } catch (eW) {}
        this.zoomPoll = setInterval(function () {
          try {
            if (!self.wrapper.isConnected) return;
            var s = self.currentScale() || 1;
            if (Math.abs(s - self.scale) > 0.002 ||
              self.wrapper.clientWidth !== self.w || self.wrapper.clientHeight !== self.h) {
              self.resize();
            }
          } catch (eP) {}
        }, 700);
      },
      resizeObserver: null,
      unmount: function () {
        try { if (this.onWheel) this.wrapper.removeEventListener("wheel", this.onWheel); } catch (e) {}
        if (this.zoomPoll) clearInterval(this.zoomPoll);
        if (this.zoomTimer) clearTimeout(this.zoomTimer);
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        try { if (this.resizeObserver) this.resizeObserver.disconnect(); } catch (e2) {}
        var k;
        for (k in this.tiles) {
          if (Object.prototype.hasOwnProperty.call(this.tiles, k)) this.removeTile(k);
        }
        this.tiles = {};
        try { if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host); } catch (e3) {}
        try { if (this.live && this.live.parentNode) this.live.parentNode.removeChild(this.live); } catch (e4) {}
      }
    };
    surface.doc = docFor(surface);
    surface.scale = surface.currentScale() || 1;
    surface.renderScale = Math.max(1, Math.min(4, surface.scale * dpr));
    surface.resize();
    surface.bindZoom();
    try {
      surface.resizeObserver = new ResizeObserver(function () {
        if (surface.resizeTimer) return;
        surface.resizeTimer = setTimeout(function () {
          surface.resizeTimer = 0;
          try { surface.resize(); } catch (e) {}
        }, 90);
      });
      surface.resizeObserver.observe(wrapper);
    } catch (eRO) {}
    inkTrace("surface", {
      kind: "canvas",
      target: (view.file && view.file.path) || "",
      scale: surface.scale
    });
    return surface;
  }

  // ---------------------------------------------------------------------
  // Surfaces: PDF embedded inside a markdown note
  // ---------------------------------------------------------------------
  // An embedded PDF cannot be reached through the leaf's pdfViewer, so it is
  // treated as a page-local ink surface with normalized coordinates. The note
  // sidecar owns the strokes, so zooming/resizing the embed keeps the ink on
  // the same page position; it is deliberately not written into the PDF.
  function createPdfEmbedSurface(leaf, pageEl, pdfDom) {
    if (!leaf || !pageEl || !pageEl.isConnected) return null;
    var embedEl = null;
    try { embedEl = pageEl.closest(".pdf-embed"); } catch (e0) {}
    var rect = pageEl.getBoundingClientRect();
    if (!(rect.width > 10) || !(rect.height > 10)) return null;
    if (getComputedStyle(pageEl).position === "static") pageEl.style.position = "relative";
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pageNo = parseInt(pageEl.dataset.pageNumber || "1", 10) || 1;
    var src = "";
    try {
      if (embedEl) {
        src = embedEl.getAttribute("data-src") || embedEl.getAttribute("src") || "";
        if (!src) {
          var link = embedEl.querySelector("a.internal-link, .internal-embed");
          if (link) src = link.getAttribute("src") || link.getAttribute("data-href") || "";
        }
      }
    } catch (e1) {}
    if (!src) {
      try {
        var all = leaf.view.containerEl.querySelectorAll(".pdf-embed");
        src = "embed" + Array.prototype.indexOf.call(all, embedEl);
      } catch (e2) {
        src = "embed0";
      }
    }
    var overlay = null;
    var scrollEl = null;
    var base = null;
    var live = null;
    if (pdfDom) {
      // Standalone PDF fallback: page-local canvases can end up behind the
      // pdf.js canvas/stacking context. Use one viewport-sized overlay in the
      // non-scrolling .pdf-container and project the page rect into it.
      try {
        // Put the canvas in the PDF's *scrolling content* (the page's parent,
        // normally .pdfViewer), not in the non-scrolling .pdf-container.
        // Then the compositor scrolls it with the page: no JS reposition per
        // scroll frame, no one-frame lag behind the PDF.
        overlay = pageEl.parentElement || pageEl.closest(".pdfViewer") ||
          (pageEl.closest(".pdf-viewer-container") &&
            pageEl.closest(".pdf-viewer-container").parentElement) ||
          leaf.view.containerEl;
        scrollEl = pageEl.closest(".pdf-viewer-container") || null;
      } catch (eOv) {}
      if (!overlay) return null;
      try {
        if (getComputedStyle(overlay).position === "static") overlay.style.position = "relative";
      } catch (ePos2) {}
      base = document.createElement("canvas");
      base.className = "ohsidian-ink-pdfdom-base";
      base.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:2147483000;";
      overlay.appendChild(base);
      live = document.createElement("canvas");
      live.className = "ohsidian-ink-pdfdom-live";
      live.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:2147483010;";
      overlay.appendChild(live);
    } else {
      base = ensureCanvas(pageEl, "ohsidian-ink-pdfembed", 5);
      live = ensureCanvas(pageEl, "ohsidian-ink-pdfembed-live", 6);
    }
    var surface = {
      kind: "pdfembed",
      pdfDom: !!pdfDom,
      leaf: leaf,
      pageEl: pageEl,
      embedEl: embedEl,
      overlay: overlay,
      scrollEl: scrollEl,
      onScroll: null,
      space: pdfDom
        ? ("pdfdom:" + ((leaf.view && leaf.view.file && leaf.view.file.path) || "pdf") + ":" + pageNo)
        : ("embed:" + src + ":" + pageNo),
      doc: null,
      width: rect.width,
      height: rect.height,
      dpr: dpr,
      sized: false,
      base: base,
      live: live,
      baseReady: false,
      origin: null,
      refreshOrigin: function () {
        var pr = this.pageEl.getBoundingClientRect();
        var or = this.overlay ? this.overlay.getBoundingClientRect() : pr;
        this.origin = {
          prLeft: pr.left,
          prTop: pr.top,
          prW: Math.max(1, pr.width),
          prH: Math.max(1, pr.height),
          orLeft: or.left,
          orTop: or.top
        };
      },
      raf: 0,
      resizeTimer: 0,
      resizeObserver: null,
      contains: function (el) {
        return !!(el && (el === this.pageEl || this.pageEl.contains(el)));
      },
      toSpace: function (clientX, clientY) {
        var r = this._spaceRect || this.pageEl.getBoundingClientRect();
        return [(clientX - r.left) / Math.max(1, r.width), (clientY - r.top) / Math.max(1, r.height)];
      },
      beginStroke: function () {
        this._spaceRect = this.pageEl.getBoundingClientRect();
      },
      erasePreview: function (clientX, clientY, radius) {
        var p = this.toSpace(clientX, clientY);
        var s = 1;
        try {
          var pr = this.pageEl.getBoundingClientRect();
          s = pr.width / Math.max(1, this.width);
        } catch (eS) {}
        var r = Math.max(1, radius / (s > 0.01 ? s : 1));
        var ctx = this.base.getContext("2d");
        ctx.save();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(p[0] * this.width, p[1] * this.height, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      },
      toCanvasPoint: function (x, y) {
        return [x * this.width, y * this.height];
      },
      widthScale: function () {
        return this.width;
      },
      syncPosition: function () {
        if (!this.pdfDom || !this.overlay) return;
        try {
          var l = 0;
          var t = 0;
          var cur = this.pageEl;
          while (cur && cur !== this.overlay) {
            l += cur.offsetLeft || 0;
            t += cur.offsetTop || 0;
            cur = cur.offsetParent;
          }
          if (cur !== this.overlay) {
            // Different offset chain: fall back to visual rects.
            var pr = this.pageEl.getBoundingClientRect();
            var or = this.overlay.getBoundingClientRect();
            l = Math.round(pr.left - or.left + (this.overlay.scrollLeft || 0));
            t = Math.round(pr.top - or.top + (this.overlay.scrollTop || 0));
          }
          if (this.base) { this.base.style.left = l + "px"; this.base.style.top = t + "px"; }
          if (this.live) { this.live.style.left = l + "px"; this.live.style.top = t + "px"; }
        } catch (e) {}
      },
      redraw: function () {
        var doc = this.doc;
        try {
          var bm = pdfEntryDark(this.pageEl) ? "normal" : "multiply";
          if (this.base && this.base.style.mixBlendMode !== bm) this.base.style.mixBlendMode = bm;
          if (this.live && this.live.style.mixBlendMode !== bm) this.live.style.mixBlendMode = bm;
          if (this._blendProbe !== bm || !this._blendProbeAt ||
            nowMs() - this._blendProbeAt > 500) {
            this._blendProbe = bm;
            this._blendProbeAt = nowMs();
            probeHook("pdfEmbedBlend", { mode: bm });
          }
        } catch (eBm) {}
        var ctx = this.base.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.base.width, this.base.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.baseReady = true;
        if (!doc) return;
        for (var pass = 0; pass < 2; pass++) {
          for (var i = 0; i < doc.strokes.length; i++) {
            var st = doc.strokes[i];
            if (st.space !== this.space || st.baked) continue;
            if (pass === 0 && st.tool !== "highlighter") continue;
            if (pass === 1 && st.tool === "highlighter") continue;
            drawStrokeOnCtx(ctx, st, this);
          }
        }
      },
      appendStroke: function (stroke) {
        if (!this.baseReady || !stroke || stroke.space !== this.space) return false;
        // A highlighter must go below existing pen ink; appending it on top
        // would tint the black strokes. Fall back to a full ordered redraw.
        if (stroke.tool === "highlighter") return false;
        var ctx = this.base.getContext("2d");
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        drawStrokeOnCtx(ctx, stroke, this);
        return true;
      },
      scheduleRedraw: function () {
        if (this.raf) return;
        var self = this;
        this.raf = requestAnimationFrame(function () {
          self.raf = 0;
          self.redraw();
          var a = state.active;
          if (a && a.kind === "stroke" && a.surface === self) self.drawLive(a.stroke);
        });
      },
      drawLive: function (stroke) {
        var ctx = this.live.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.live.width, this.live.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        if (stroke) drawStrokeOnCtx(ctx, stroke, this);
      },
      drawLiveIncremental: function (stroke, from) {
        if (!stroke || !stroke.pts || stroke.pts.length < 2) return;
        if (stroke.tool === "highlighter") {
          this.drawLive(stroke);
          return;
        }
        var ctx = this.live.getContext("2d");
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = stroke.color;
        var scale = this.widthScale ? this.widthScale() : 1;
        var lineScale = stroke.px ? 1 : scale;
        var start = Math.max(1, Number(from) || 1);
        var pts = stroke.pts;
        for (var i = start; i < pts.length; i++) {
          var a = pts[i - 1];
          var b = pts[i];
          var p0 = this.toCanvasPoint(a[0], a[1]);
          var p1 = this.toCanvasPoint(b[0], b[1]);
          var w = (widthFor(stroke, a[2]) + widthFor(stroke, b[2])) * 0.5 * lineScale;
          w = Math.max(0.35, w);
          ctx.beginPath();
          ctx.moveTo(p0[0], p0[1]);
          ctx.lineTo(p1[0], p1[1]);
          ctx.lineWidth = w;
          ctx.stroke();
        }
      },
      clearLive: function () {
        var ctx = this.live.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.live.width, this.live.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      },
      resize: function () {
        var r = this.pageEl.getBoundingClientRect();
        var w = Math.max(1, r.width);
        var h = Math.max(1, r.height);
        if (this.pdfDom) {
          // offsetWidth is the unscaled layout size. If pdf.js implements zoom
          // with a CSS transform on the viewer, the canvas inherits that
          // transform; storing getBoundingClientRect() here would scale twice.
          w = Math.max(1, this.pageEl.offsetWidth || r.width);
          h = Math.max(1, this.pageEl.offsetHeight || r.height);
        }
        if (w < 10 || h < 10) return;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (!this.sized || w !== this.width || h !== this.height ||
          dpr !== this.dpr || this.base.width <= 1) {
          this.sized = true;
          this.width = w;
          this.height = h;
          this.dpr = dpr;
          sizeCanvas(this.base, w, h, dpr);
          sizeCanvas(this.live, w, h, dpr, { desynchronized: true, alpha: true });
          this.redraw();
        }
        this.syncPosition();
        var a = state.active;
        if (a && a.kind === "stroke" && a.surface === this) {
          this.drawLive(a.stroke);
          a.liveDrawn = a.stroke.pts ? a.stroke.pts.length : 0;
        }
      },
      unmount: function () {
        try { if (this.resizeObserver) this.resizeObserver.disconnect(); } catch (e) {}
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
        try {
          if (this.onScroll && this.scrollEl) this.scrollEl.removeEventListener("scroll", this.onScroll);
        } catch (eS0) {}
        try {
          if (this.onScroll) window.removeEventListener("scroll", this.onScroll, true);
        } catch (eS1) {}
        try { if (this.base.parentNode) this.base.parentNode.removeChild(this.base); } catch (e2) {}
        try { if (this.live.parentNode) this.live.parentNode.removeChild(this.live); } catch (e3) {}
      }
    };
    surface.doc = docFor(surface);
    if (pdfDom && scrollEl) {
      surface.onScroll = function () {
        if (surface.scrollRaf) return;
        surface.scrollRaf = requestAnimationFrame(function () {
          surface.scrollRaf = 0;
          // The canvas itself scrolls natively with the page; only the active
          // page detection needs JS here.
          try {
            var hit = document.elementFromPoint((window.innerWidth || 1024) / 2,
              (window.innerHeight || 820) / 2);
            var pe = hit && hit.closest ? hit.closest(".page[data-page-number]") : null;
            if (pe) {
              var ps = pdfEmbedSurfaceFor(surface.leaf, pe, true);
              if (ps && state.activeSurface !== ps) {
                state.activeSurface = ps;
                updateToolbarState();
              }
            }
          } catch (eVis) {}
        });
      };
      try { scrollEl.addEventListener("scroll", surface.onScroll, { passive: true }); } catch (eSc) {}
      try { window.addEventListener("scroll", surface.onScroll, true); } catch (eSc2) {}
    }
    surface.resize();
    if (pdfDom) {
      setTimeout(function () {
        try {
          inkTrace("pdfdomOverlay", {
            page: pageNo,
            pageW: Math.round(surface.pageEl.getBoundingClientRect().width),
            pageH: Math.round(surface.pageEl.getBoundingClientRect().height),
            overlayW: overlay ? overlay.clientWidth : 0,
            overlayH: overlay ? overlay.clientHeight : 0,
            baseW: base.width,
            baseH: base.height,
            liveW: live.width,
            connected: !!(base.isConnected && live.isConnected)
          });
        } catch (eT) {}
      }, 0);
    }
    try {
      surface.resizeObserver = new ResizeObserver(function () {
        if (surface.resizeTimer) return;
        surface.resizeTimer = setTimeout(function () {
          surface.resizeTimer = 0;
          try { surface.resize(); } catch (e) {}
        }, 70);
      });
      surface.resizeObserver.observe(pageEl);
      if (overlay) surface.resizeObserver.observe(overlay);
    } catch (eRO) {}
    inkTrace("surface", { kind: "pdfembed", target: src, page: pageNo, pdfDom: !!pdfDom });
    return surface;
  }

  function pdfEmbedSurfaceFor(leaf, pageEl, pdfDom) {
    for (var i = 0; i < state.surfaces.length; i++) {
      var s = state.surfaces[i];
      if (s.kind === "pdfembed" && s.pageEl === pageEl) return s;
    }
    var created = null;
    try { created = createPdfEmbedSurface(leaf, pageEl, pdfDom); } catch (e) {
      warn("pdf embed mount failed", e && e.message);
      inkTrace("surfaceFail", { type: "pdfembed", error: e && e.message });
    }
    if (created) state.surfaces.push(created);
    return created;
  }

  function inkRefreshSurfaces() {
    var app = state.app;
    if (!app || !app.workspace) return;
    if (!state.enabled) {
      // Handwriting mode is off. The settings page promises "plain Obsidian",
      // so do not mount a single overlay canvas (PDF pages included).
      for (var off = state.surfaces.length - 1; off >= 0; off--) {
        try { removeSurface(state.surfaces[off]); } catch (eOff) {}
      }
      updateToolbarVisibility();
      return;
    }
    var leaves = [];
    try {
      var mdL = app.workspace.getLeavesOfType("markdown") || [];
      var pdfL = app.workspace.getLeavesOfType("pdf") || [];
      var cvL = app.workspace.getLeavesOfType("canvas") || [];
      leaves = leaves.concat(mdL, pdfL, cvL);
    } catch (eL) {
      return;
    }
    // Drop surfaces whose leaf vanished or whose DOM is disconnected.
    for (var i = state.surfaces.length - 1; i >= 0; i--) {
      var s = state.surfaces[i];
      var alive = false;
      for (var j = 0; j < leaves.length; j++) {
        if (leaves[j] === s.leaf) { alive = true; break; }
      }
      if (!alive || !s.leaf.view || !s.leaf.view.containerEl || !s.leaf.view.containerEl.isConnected) {
        removeSurface(s);
      }
    }
    for (var k = 0; k < leaves.length; k++) {
      var leaf = leaves[k];
      var existing = surfaceForLeaf(leaf);
      if (existing) {
        var nowType = leaf.view ? leaf.view.getViewType() : "";
        var nowFile = leaf.view && leaf.view.file ? leaf.view.file.path : "";
        var stale = false;
        if ((existing.kind === "markdown" && nowType !== "markdown") ||
          (existing.kind === "pdf" && nowType !== "pdf") ||
          (existing.kind === "canvas" && nowType !== "canvas")) {
          stale = true;
        } else if (existing.doc && existing.doc.target !== nowFile) {
          // The leaf switched to another note/PDF in the same view.
          stale = true;
        } else if (existing.kind === "markdown" && leaf.view &&
          typeof leaf.view.getMode === "function" && leaf.view.getMode() !== "preview") {
          // Switched to editing / live preview: the overlay must not stay on.
          stale = true;
        } else if (existing.kind === "markdown" &&
          (!existing.rootEl || !existing.rootEl.isConnected ||
            !existing.sizer || !existing.sizer.isConnected)) {
          // The reading view was re-rendered (PDF embed/layout). Reattach the
          // same surface instead of deleting its doc/history every 500ms.
          if (!existing.rebind || !existing.rebind()) stale = true;
        } else if (existing.kind === "pdfembed" && existing.pdfDom && nowType === "pdf") {
          // A `pdfdom` fallback created before Obsidian's async PDF component
          // exposed the real viewer. It maps every page through the first
          // page's rect and writes normalized coordinates from that origin,
          // which is what turned handwriting into abstract art. Rebuild as
          // soon as the real pdf.js viewer exists.
          if (pdfJsViewerOf(leaf.view)) stale = true;
        } else if (existing.kind === "pdf" && (function () {
            if (!existing.container || !existing.container.isConnected) return true;
            if (leaf.view && existing.pdfOwner &&
              existing.pdfOwner !== (leaf.view.viewer || leaf.view)) return true;
            var nowViewer = leaf.view ? pdfJsViewerOf(leaf.view) : null;
            return !!(nowViewer && existing.viewer !== nowViewer);
          })()) {
          // pdf.js replaces the viewer on a document reload (our own PDF write
          // triggers one); the old event bus and page canvases are dead.
          var freshViewer = leaf.view ? pdfJsViewerOf(leaf.view) : null;
          if (freshViewer && existing.viewer !== freshViewer) {
            probeHook("pdfViewerReplaced", {
              afterWrite: state.lastPdfWriteAt ? Date.now() - state.lastPdfWriteAt : -1,
              page: existing.currentSpace || ""
            });
          }
          stale = true;
        } else if (existing.kind === "canvas" &&
          (!existing.wrapper || !existing.wrapper.isConnected ||
            !existing.canvas || !existing.canvas.isConnected ||
            (leaf.view && leaf.view.containerEl && existing.wrapper !==
              leaf.view.containerEl.querySelector(".canvas-wrapper")))) {
          stale = true;
        }
        if (stale) {
          removeSurface(existing);
          existing = null;
        }
      }
      if (existing) {
        if (existing.kind === "markdown" || existing.kind === "canvas") existing.resize();
        else if (existing.kind === "pdfembed") existing.resize();
        else if (existing.kind === "pdf") {
          // pdf.js may have replaced page elements during a zoom.
          existing.refreshPages();
        }
        continue;
      }
      var created = null;
      try {
        var type = leaf.view ? leaf.view.getViewType() : "";
        if (type === "markdown") created = createMarkdownSurface(leaf);
        else if (type === "pdf") created = createPdfSurface(leaf);
        else if (type === "canvas") created = createCanvasSurface(leaf);
      } catch (e) {
        warn("surface mount failed", e && e.message);
        inkTrace("surfaceFail", { type: leaf.view ? leaf.view.getViewType() : "?", error: e && e.message });
      }
      // Do NOT build a whole-container pdfdom fallback for a PDF leaf here.
      // Obsidian assigns the pdf.js viewer asynchronously; the retry timer
      // picks it up a few hundred ms later. A fallback created at this point
      // uses the first page's rect for every page, so write-back stores
      // normalized coordinates against the wrong origin (the "art" bug).
      if (created) {
        if (state.surfaces.indexOf(created) < 0) state.surfaces.push(created);
        inkTrace("surface", {
          kind: created.kind,
          target: created.doc ? created.doc.target : "",
          tiles: created.tiles ? Object.keys(created.tiles).length : 0,
          pages: created.pages ? Object.keys(created.pages).length : 0,
          pdfDom: !!created.pdfDom
        });
      }
    }
    // Embedded-PDF page elements are recreated by Obsidian when the embed
    // finishes loading or re-renders; drop surfaces whose page is gone.
    for (var pe = state.surfaces.length - 1; pe >= 0; pe--) {
      var ps = state.surfaces[pe];
      if (ps.kind !== "pdfembed") continue;
      if (!ps.pageEl || !ps.pageEl.isConnected) removeSurface(ps);
    }
    // Obsidian assigns the pdf.js viewer asynchronously after the leaf is
    // created. If a PDF leaf is still surface-less, poll briefly instead of
    // waiting for a layout event that may never come (the first paint of the
    // PDF does not dispatch layout-change).
    if (state.pdfRetryTries < 40 && !state.pdfRetryTimer) {
      var needPdf = false;
      for (var pr = 0; pr < leaves.length; pr++) {
        var pl = leaves[pr];
        if (pl.view && pl.view.getViewType && pl.view.getViewType() === "pdf" &&
          !surfaceForLeaf(pl)) {
          needPdf = true;
          break;
        }
      }
      if (needPdf) {
        state.pdfRetryTries++;
        state.pdfRetryTimer = setTimeout(function () {
          state.pdfRetryTimer = 0;
          try { inkRefreshSurfaces(); } catch (ePR) {}
        }, 350);
      }
    }
    updateToolbarVisibility();
  }

  function surfaceAtEvent(target) {
    // Embedded PDF pages inside a note take priority over the note surface.
    for (var e = 0; e < state.surfaces.length; e++) {
      var se = state.surfaces[e];
      if (se.kind === "pdfembed" && se.contains(target)) return { surface: se, entry: null };
    }
    for (var i = 0; i < state.surfaces.length; i++) {
      var s = state.surfaces[i];
      if (s.kind === "markdown") {
        if (!s.contains(target)) continue;
        var pageEl = null;
        try {
          pageEl = target.closest ? target.closest(".pdf-embed .page[data-page-number], .pdf-embed .page") : null;
        } catch (eP) {}
        if (pageEl) {
          var pageSurface = pdfEmbedSurfaceFor(s.leaf, pageEl);
          if (pageSurface) return { surface: pageSurface, entry: null };
          return null;
        }
        return { surface: s, entry: null };
      } else if (s.kind === "canvas") {
        if (s.contains(target)) return { surface: s, entry: null };
      } else if (s.kind === "pdf") {
        var entry = s.surfaceAt(target);
        if (entry) return { surface: s, entry: entry };
        // Do NOT fall back to a pdfdom surface for a page that is still
        // loading. pdfdom uses a different space; when the real page later
        // renders, those strokes live in another doc space and appear lost
        // (or are written to a different page). Wait until pageView.viewport
        // exists instead.
        return null;
      }
    }
    try {
      var al = state.app && state.app.workspace ? state.app.workspace.activeLeaf : null;
      if (al && al.view && al.view.getViewType && al.view.getViewType() === "pdf") {
        // If the real pdf.js surface exists, a pdfdom fallback would split
        // the page into two spaces; refuse instead.
        if (surfaceForLeaf(al)) return null;
        var dpe = target.closest ? target.closest(".page[data-page-number]") : null;
        if (dpe) {
          var dps = pdfEmbedSurfaceFor(al, dpe, true);
          if (dps) return { surface: dps, entry: null };
        }
      }
    } catch (eD) {}
    return null;
  }

  // ---------------------------------------------------------------------
  // Pressure side-channel
  // ---------------------------------------------------------------------
  var pl = {
    buf: [],
    pending: [],
    push: function (msg) {
      var pts = msg && msg.pts ? msg.pts : [];
      if (!pts.length) return;
      var t = nowMs();
      var w = Number(msg.w) > 0 ? Number(msg.w) : (window.innerWidth || 1);
      var h = Number(msg.h) > 0 ? Number(msg.h) : (window.innerHeight || 1);
      var kx = (window.innerWidth || w) / w;
      var ky = (window.innerHeight || h) / h;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (!p || p.length < 3) continue;
        var age = Number(p[5]) || 0;
        this.buf.push({
          x: p[0] * kx + state.offsetX,
          y: p[1] * ky + state.offsetY,
          p: clamp01(p[2]),
          tx: Number(p[3]) || 0,
          ty: Number(p[4]) || 0,
          t: t - age - 1.5
        });
      }
      if (this.buf.length > 900) this.buf.splice(0, this.buf.length - 600);
      this.flushPending();
    },
    /**
     * DOM samples that arrived before their ArkTS counterpart are queued and
     * back-filled when the next IPC batch lands (the two runtimes have
     * different scheduling order relative to Chromium's input pipeline).
     */
    flushPending: function () {
      if (!this.pending.length) return;
      var keep = [];
      var now = nowMs();
      var filled = false;
      for (var i = 0; i < this.pending.length; i++) {
        var e = this.pending[i];
        var m = this.match(e.x, e.y, e.t);
        if (m) {
          var pt = e.pt;
          if (pt) {
            pt[2] = m.p;
            pt[3] = m.tx;
            pt[4] = m.ty;
            filled = true;
          }
        } else if (now - e.t < 160) {
          keep.push(e);
        }
      }
      this.pending = keep;
      if (filled) {
        var a = state.active;
        if (a && a.kind === "stroke") {
          requestLiveFrame();
        } else {
          scheduleRedraw();
          var s = activeSurfaceNow();
          var d = s ? docFor(s) : null;
          if (d) saveSoon(d);
        }
      }
    },
    queue: function (x, y, t, pt) {
      this.pending.push({ x: x, y: y, t: t, pt: pt });
      if (this.pending.length > 120) this.pending.splice(0, this.pending.length - 90);
    },
    match: function (x, y, t) {
      var best = null;
      var bestScore = 1e9;
      for (var i = this.buf.length - 1; i >= 0; i--) {
        var s = this.buf[i];
        if (s.t < t - 80) break; // buffer is chronological
        var dt = Math.abs(s.t - t);
        if (dt > 60) continue;
        var dx = s.x - x;
        var dy = s.y - y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d > 10) continue;
        var score = dt * 0.3 + d * 2.0;
        if (score < bestScore) {
          bestScore = score;
          best = s;
        }
      }
      return best;
    }
  };

  function negotiatePressure() {
    var want = false;
    // Handwriting mode off = plain Obsidian: stop the native ArkUI sample
    // stream too, otherwise the pen keeps waking the app for nothing.
    if (state.enabled) {
      if (state.pressureTapPref === "on") {
        want = true;
      } else if (state.pressureTapPref === "auto") {
        want = state.pressureMode === "fake" ||
          (state.pressureMode === "unknown" && state.domPressureCount > 30 &&
            Object.keys(state.domPressureValues).length <= 2);
      }
    }
    if (want !== state.pressureTapOn) {
      var sent = sendAction({ action: "penSamplesOn", on: want });
      if (sent) {
        state.pressureTapOn = want;
        log("pressure tap", want ? "enabled" : "disabled", "mode=" + state.pressureMode);
      }
    }
  }

  function sendShapeMode() {
    if (!state.ipcReady) return;
    sendAction({ action: "shapeMode", on: state.shapeMode === true });
  }

  function sendPredictMode() {
    if (!state.ipcReady) return;
    sendAction({ action: "predictMode", on: state.predictWanted === true });
  }

  /**
   * Only DOM pressure feeds the real/fake classification. ArkTS samples are
   * the fallback, not evidence about the engine: counting them would make
   * simulated values look like a pressure-capable device.
   */
  function observeDomPressure(p) {
    if (typeof p !== "number" || p < 0) return;
    var q = Math.round(clamp01(p) * 1000) / 1000;
    state.domPressureValues[q] = (state.domPressureValues[q] || 0) + 1;
    state.domPressureCount++;
    // A pressure-sensitive pen produces hundreds of distinct values; keep the
    // histogram bounded if the device reports wild floats.
    if (state.domPressureCount > 4000) {
      state.domPressureValues = {};
      state.domPressureCount = 0;
      if (state.pressureMode !== "real") state.pressureMode = "unknown";
    }
    if ((state.domPressureCount & 3) !== 0 && state.pressureMode !== "unknown") {
      negotiatePressure();
      return;
    }
    var keys = Object.keys(state.domPressureValues);
    if (state.pressureMode === "unknown" && keys.length >= 4) state.pressureMode = "real";
    if (state.pressureMode === "unknown" && state.domPressureCount >= 40 && keys.length <= 2) state.pressureMode = "fake";
    if (state.pressureMode === "fake" && keys.length >= 6) state.pressureMode = "real";
    negotiatePressure();
  }

  function pressureFor(surface, ev, x, y) {
    var t = nowMs();
    var domP = typeof ev.pressure === "number" ? ev.pressure : 0.5;
    var forceTap = state.pressureTapPref === "on";
    if (state.pressureMode === "real" && !forceTap) {
      return { p: clamp01(domP), tiltX: ev.tiltX || 0, tiltY: ev.tiltY || 0, real: true };
    }
    // Samples are stored in viewport CSS px, so match against the event's
    // client coordinates, not the surface-local x/y.
    var m = pl.match(ev.clientX + state.offsetX, ev.clientY + state.offsetY, t);
    if (m) {
      return { p: m.p, tiltX: m.tx, tiltY: m.ty, real: true };
    }
    if (state.pressureMode === "real") {
      return { p: clamp01(domP), tiltX: ev.tiltX || 0, tiltY: ev.tiltY || 0, real: true };
    }
    if (state.pressureMode !== "fake" && domP > 0.001 && domP !== 0.5) {
      return { p: clamp01(domP), tiltX: ev.tiltX || 0, tiltY: ev.tiltY || 0, real: true };
    }
    // Simulated pressure: fast strokes get thinner.
    var dt = Math.max(4, t - (state.lastPenAt || t));
    var dx = x - (state.lastPenX === undefined ? x : state.lastPenX);
    var dy = y - (state.lastPenY === undefined ? y : state.lastPenY);
    var d = Math.sqrt(dx * dx + dy * dy);
    var speed = d / dt;
    var sim = clamp(1 - speed / 3.2, 0.12, 0.92);
    return { p: sim, tiltX: 0, tiltY: 0, real: false };
  }

  // ---------------------------------------------------------------------
  // Input capture
  // ---------------------------------------------------------------------
  function isExcluded(el) {
    if (!el) return true;
    try {
      if (el.closest("#" + TOOLBAR_ID) || el.closest("#" + MENU_ID) ||
        el.closest("#" + CLEAR_ID) || el.closest("#" + SELBAR_ID)) return true;
      if (el.closest(".modal-container") || el.closest(".modal-bg") || el.closest(".prompt") ||
        el.closest(".menu") || el.closest(".suggestion-container")) return true;
      if (el.closest(".workspace-drawer") || el.closest(".pdf-sidebar-container") ||
        el.closest(".pdf-thumbnail-view") || el.closest(".pdf-outline-view") ||
        el.closest(".pdf-toolbar") || el.closest(".pdf-findbar")) return true;
      if (el.closest(".status-bar") || el.closest(".view-header") ||
        el.closest(".titlebar") || el.closest(".mobile-toolbar") ||
        el.closest(".mobile-navbar")) return true;
      if (el.closest(".canvas-controls") || el.closest(".canvas-card-menu") ||
        el.closest(".canvas-menu") || el.closest(".canvas-node-menu")) return true;
      if (el.closest("input,textarea,select")) return true;
      return false;
    } catch (e) {
      return true;
    }
  }

  function isInkChrome(el) {
    try {
      return !!(el && (el.closest("#" + TOOLBAR_ID) || el.closest("#" + MENU_ID) ||
        el.closest("#" + CLEAR_ID) || el.closest("#" + SELBAR_ID)));
    } catch (e) {
      return false;
    }
  }

  function isPenEvent(ev) {
    if (!ev) return false;
    if (ev.pointerType === "pen") return true;
    if (ev.pointerType === "mouse" && state.penNativeActive) return true;
    return false;
  }

  function pointFromEvent(ev, x, y) {
    var pr = pressureFor(null, ev, x, y);
    return [x, y, pr.p, pr.tiltX, pr.tiltY, Math.round(nowMs() - (state.strokeT0 || nowMs()))];
  }

  function onPointerDownCapture(ev) {
    if (!state.installed || !ev || !state.enabled) return;
    if (window.__ohsidianAgentBuild && ev.pointerType === "touch" && !state.perfTouchStarted) {
      state.perfTouchStarted = true;
      probeHook("perfInput", {
        lag: Math.round(nowMs() - ev.timeStamp),
        pointerType: ev.pointerType
      });
      perfRafSample("touch", 2500);
    }
    if (isPenEvent(ev)) state.lastPenSeen = nowMs();
    // A palm/finger landing during an active pen stroke must not scroll,
    // select text or click anything. This replaces the old full-screen guard.
    if (state.active && ev.pointerType === "touch") {
      try { ev.preventDefault(); } catch (e1) {}
      try { ev.stopPropagation(); } catch (e2) {}
      return;
    }
    if (ev.button !== undefined && ev.button !== 0 && ev.button !== 5) return;
    var fingerLasso = state.tool === "lasso" && ev.pointerType === "touch";
    if (!isPenEvent(ev) && !(state.fingerDraw && ev.pointerType === "touch") && !fingerLasso) return;
    if (state.tool === "pointer") return;
    if (isExcluded(ev.target)) {
      if (isPenEvent(ev) && state.tool !== "pointer") {
        if (!isInkChrome(ev.target)) {
          // Pen mode owns drawing only. A pen contact on Obsidian chrome
          // (tabs/header/nav/sidebar/PDF toolbar/modal) is swallowed at the
          // down event, so Obsidian never starts a pen swipe on it. Hand
          // input remains the way to operate Obsidian UI.
          state.blockedPointerId = ev.pointerId;
          try { ev.preventDefault(); } catch (eX1) {}
          try { ev.stopPropagation(); } catch (eX2) {}
          try { ev.stopImmediatePropagation(); } catch (eX3) {}
          return;
        }
        // Our own ink toolbar/clear slider still accepts the pen. Inputs must
        // receive the full pointer stream (no 5px swipe cutoff), so return
        // before arming penUiSwipe for them.
        if (ev.target && ev.target.closest &&
          (ev.target.closest("#" + CLEAR_ID) ||
            ev.target.closest("input,textarea,select"))) return;
        state.penUiSwipe = {
          id: ev.pointerId,
          x: ev.clientX,
          y: ev.clientY,
          blocked: false
        };
      }
      return;
    }
    if (isPenEvent(ev)) inkToolMode(state.tool);
    var hit = surfaceAtEvent(ev.target);
    if (!hit) {
      if (isPenEvent(ev) && state.tool !== "pointer") {
        // A pen stroke that starts outside every ink surface must not fall
        // through to Obsidian. Otherwise a left/right pen swipe over a margin,
        // a loading embed or the outer gutter reaches Obsidian's own swipe
        // handlers and opens panels/toolbars.
        state.blockedPointerId = ev.pointerId;
        try { ev.preventDefault(); } catch (eB1) {}
        try { ev.stopPropagation(); } catch (eB2) {}
        try { ev.stopImmediatePropagation(); } catch (eB3) {}
        var v = state.app && state.app.workspace ? state.app.workspace.activeLeaf : null;
        var vt = v && v.view && v.view.getViewType ? v.view.getViewType() : "";
        var vm = v && v.view && v.view.getMode ? v.view.getMode() : "";
        if (vt === "markdown" && vm !== "preview") {
          // A pen still in its drawing tool must not be trapped in Live
          // Preview; switch now instead of waiting for a toolbar tap.
          if (inkRequestReadingMode(state.tool)) return;
        }
        if (!state.noSurfaceNotified) {
          state.noSurfaceNotified = true;
          inkStatus(vt === "markdown"
            ? (vm === "preview"
              ? "手写层准备中…请稍候再落笔"
              : "正在切换到阅读视图，手写层准备中…")
            : "当前视图没有手写层。", 3000);
        }
        if (vt === "markdown" || vt === "pdf" || vt === "canvas") inkAwaitSurface("stroke");
      }
      return;
    }
    var surface = hit.surface;
    var entry = hit.entry || null;
    state.blockedPointerId = null;
    state.activeSurface = surface;
    if (surface.kind === "pdf" && entry) surface.currentSpace = entry.space;
    if (surface.kind === "markdown" && document.activeElement &&
      surface.sizer && !surface.sizer.contains(document.activeElement) &&
      document.activeElement.isContentEditable) {
      // Editing somewhere else: do not steal the stroke.
      return;
    }
    var tool = state.tool === "eraser" ? "eraser" : state.tool;
    // The pen's tail/barrel button arrives as button 5 (or the eraser bit in
    // `buttons`); treat it as a temporary eraser even when the pen tool is
    // selected. On HarmonyOS the tip can also report that bit while writing,
    // which used to carve small eraser holes into fresh ink and then "turn back
    // into a pen" on pen-up. A real hardware eraser has no pressure, so a
    // pressed tip (pressure > 0.01) is never reclassified.
    var eraseButton = ev.button === 5 || ((ev.buttons || 0) & 32) !== 0;
    if (ev.pointerType === "pen") {
      // Only the hardware eraser tip qualifies: button 5 AND the eraser bit in
      // `buttons`, with no pressure. Requiring both matters because some
      // engines report button 5 alone on the first sample of a normal tip
      // contact (pressure is still 0 there), which would erase instead of
      // drawing. A real eraser sets both signals.
      eraseButton = ev.button === 5 && ((ev.buttons || 0) & 32) !== 0 &&
        (typeof ev.pressure !== "number" || ev.pressure <= 0.01);
    }
    if (eraseButton) {
      tool = "eraser";
    }
    if (surface.kind === "canvas") surface.refreshScale();
    if (surface.kind === "pdf" && entry) {
      entry._spaceRect = entry.cv ? entry.cv.getBoundingClientRect() :
        entry.pageEl.getBoundingClientRect();
    }
    if (typeof surface.beginStroke === "function") surface.beginStroke(entry);
    var sp = surface.kind === "pdf"
      ? surface.toSpaceOn(entry, ev.clientX, ev.clientY)
      : surface.toSpace(ev.clientX, ev.clientY);
    ev.preventDefault();
    ev.stopPropagation();
    state.strokeT0 = nowMs();
    state.lastPenAt = state.strokeT0;
    state.lastPenActivity = state.strokeT0;
    state.lastPenX = sp[0];
    state.lastPenY = sp[1];
    state.lastPenType = ev.pointerType || "?";
    if (tool === "eraser") {
      var eraseDoc = docFor(surface);
      var eraseSpace = inkSpaceOf(surface, entry);
      state.active = {
        kind: "erase",
        surface: surface,
        entry: entry,
        space: eraseSpace,
        doc: eraseDoc,
        before: eraseDoc ? snapshotSpace(eraseDoc, eraseSpace) : null,
        changed: false,
        erasePts: [[sp[0], sp[1]]],
        visualErased: false,
        immediate: state.eraserMode === "stroke" || state.eraserOnlyHl === true,
        pointerId: ev.pointerId,
        t0: state.strokeT0,
        lastSampleAt: state.strokeT0
      };
      palmOn();
      inkWritingChrome(true);
      inkTrace("eraseDown", { space: eraseSpace, mode: state.eraserMode });
      drawCursor(ev.clientX, ev.clientY, surface, true);
      if (state.active.immediate) {
        // Whole-stroke and highlighter-only modes must remove the affected
        // strokes immediately; destination-out would hide all ink under the
        // circle (including pen strokes that must survive), then repaint.
        eraseAt(surface, entry, sp[0], sp[1], state.active);
        if (state.active.changed) redrawEraseSurface(surface, entry);
      } else if (typeof surface.erasePreview === "function") {
        surface.erasePreview(ev.clientX, ev.clientY, Number(state.eraserPx) || 12, entry);
        state.active.visualErased = true;
      } else {
        eraseAt(surface, entry, sp[0], sp[1], state.active);
      }
      return;
    }
    if (tool === "lasso") {
      var ldoc = docFor(surface);
      var lspace = inkSpaceOf(surface, entry);
      var sel = state.selection;
      var canMove = !!(sel && ldoc && sel.doc === ldoc && sel.space === lspace &&
        sel.clientRect &&
        ev.clientX >= sel.clientRect.left - 6 && ev.clientX <= sel.clientRect.right + 6 &&
        ev.clientY >= sel.clientRect.top - 6 && ev.clientY <= sel.clientRect.bottom + 6);
      state.activeSurface = surface;
      try {
        if (ev.target && ev.target.setPointerCapture) ev.target.setPointerCapture(ev.pointerId);
      } catch (eCap) {}
      if (canMove) {
        state.active = {
          kind: "move",
          surface: surface,
          entry: entry,
          space: lspace,
          doc: ldoc,
          ids: sel.ids.slice(),
          origIds: sel.ids.slice(),
          cloned: false,
          before: snapshotSpace(ldoc, lspace),
          last: sp,
          changed: false,
          pointerId: ev.pointerId,
          t0: state.strokeT0,
          lastSampleAt: state.strokeT0
        };
      } else {
        clearSelection();
        state.active = {
          kind: "lasso",
          surface: surface,
          entry: entry,
          space: lspace,
          lassoPts: [[ev.clientX, ev.clientY]],
          pointerId: ev.pointerId,
          t0: state.strokeT0,
          lastSampleAt: state.strokeT0
        };
        drawLasso(state.active.lassoPts);
      }
      palmOn();
      inkWritingChrome(true);
      inkTrace("lassoDown", { move: canMove, space: lspace });
      return;
    }
    var autoColor = state.colorAuto && tool !== "highlighter";
    var baseWidth = tool === "highlighter" ? state.hlWidth : state.width;
    var widthScale = surface.kind === "pdf"
      ? (surface.widthScaleOn(entry) || 1)
      : ((surface.kind === "canvas" || surface.kind === "pdfembed")
        ? (surface.widthScale() || 1) : 1);
    var pxWidth = surface.kind === "pdfembed";
    var stroke = {
      id: uid(),
      space: inkSpaceOf(surface, entry),
      tool: tool,
      color: tool === "highlighter" ? state.hlColor : (autoColor ? inkAutoColor(surface) : state.color),
      auto: autoColor,
      width: pxWidth ? baseWidth : baseWidth / (widthScale || 1),
      px: pxWidth,
      screenWidth: pxWidth ? baseWidth : 0,
      opacity: tool === "highlighter" ? 0.38 : 1,
      straight: tool === "highlighter" && state.hlStraight !== false,
      shape: 0,
      device: ev.pointerType === "pen" ? "pen" : (ev.pointerType || "?"),
      pts: [],
      bbox: null,
      baked: false,
      written: false
    };
    var pr = pressureFor(surface, ev, sp[0], sp[1]);
    stroke.pts.push([sp[0], sp[1], pr.p, pr.tiltX, pr.tiltY, 0]);
    if (!pr.real && state.pressureMode !== "real") {
      pl.queue(ev.clientX + state.offsetX, ev.clientY + state.offsetY, nowMs(),
        stroke.pts[stroke.pts.length - 1]);
    }
    state.active = {
      kind: "stroke",
      surface: surface,
      entry: entry,
      stroke: stroke,
      pointerId: ev.pointerId,
      t0: state.strokeT0,
      lastSampleAt: state.strokeT0,
      lastMoveAt: state.strokeT0,
      holdTimer: 0,
      downAt: state.strokeT0,
      downClientX: ev.clientX,
      downClientY: ev.clientY,
      lastClientX: ev.clientX,
      lastClientY: ev.clientY,
      maxTravel: 0,
      lastPressure: pr.p,
      pressureTimer: 0,
      dirty: true
    };
    state.latencyT0 = nowMs();
    state.latencyCaptured = false;
    state.penSamplesThisStroke = 0;
    try {
      if (ev.target && ev.target.setPointerCapture) ev.target.setPointerCapture(ev.pointerId);
    } catch (e) {}
    palmOn();
    inkWritingChrome(true);
    inkTrace("strokeDown", { tool: tool, space: stroke.space, device: stroke.device });
    if (surface.kind === "markdown" || surface.kind === "canvas" || surface.kind === "pdfembed") surface.drawLive(stroke);
    else surface.drawLive(entry, stroke);
    state.active.liveDrawn = stroke.pts.length;
    clearPenPredict();
    requestLiveFrame();
    startPressureEraserWatch(state.active, pr);
  }

  function onPointerMoveCapture(ev) {
    if (!state.enabled) {
      if (state.active) forceReleaseActive(true);
      return;
    }
    if (ev.pointerType === "pen") state.lastPenSeen = nowMs();
    var ps = state.penUiSwipe;
    if (ps && ev.pointerId === ps.id && !state.active) {
      var pdx = ev.clientX - ps.x;
      var pdy = ev.clientY - ps.y;
      if (!ps.blocked && pdx * pdx + pdy * pdy > 25) {
        ps.blocked = true;
        state.blockedPointerId = ev.pointerId;
      }
      if (ps.blocked) {
        try { ev.preventDefault(); } catch (eS1) {}
        try { ev.stopPropagation(); } catch (eS2) {}
        try { ev.stopImmediatePropagation(); } catch (eS3) {}
      }
      return;
    }
    if (state.blockedPointerId !== null && ev.pointerId === state.blockedPointerId) {
      try { ev.preventDefault(); } catch (eB1) {}
      try { ev.stopPropagation(); } catch (eB2) {}
      try { ev.stopImmediatePropagation(); } catch (eB3) {}
      return;
    }
    var a = state.active;
    if (!a) return;
    if (ev.pointerId !== a.pointerId) return;
    state.lastPenActivity = nowMs();
    a.lastSampleAt = state.lastPenActivity;
    if (ev.preventDefault) ev.preventDefault();
    if (ev.stopPropagation) ev.stopPropagation();
    if (a.kind === "erase") {
      var sp = a.surface.kind === "pdf"
        ? a.surface.toSpaceOn(a.entry, ev.clientX, ev.clientY)
        : a.surface.toSpace(ev.clientX, ev.clientY);
      drawCursor(ev.clientX, ev.clientY, a.surface, true);
      if (a.immediate) {
        if (a.erasePts) a.erasePts.push([sp[0], sp[1]]);
        var removedNow = eraseAt(a.surface, a.entry, sp[0], sp[1], a);
        if (removedNow) redrawEraseSurface(a.surface, a.entry);
      } else if (a.erasePts && typeof a.surface.erasePreview === "function") {
        a.erasePts.push([sp[0], sp[1]]);
        a.surface.erasePreview(ev.clientX, ev.clientY, Number(state.eraserPx) || 12, a.entry);
        a.visualErased = true;
      } else {
        eraseAt(a.surface, a.entry, sp[0], sp[1], a);
      }
      return;
    }
    if (a.kind === "lasso") {
      a.lassoPts.push([ev.clientX, ev.clientY]);
      drawLasso(a.lassoPts);
      return;
    }
    if (a.kind === "move") {
      var msp = a.surface.kind === "pdf"
        ? a.surface.toSpaceOn(a.entry, ev.clientX, ev.clientY)
        : a.surface.toSpace(ev.clientX, ev.clientY);
      var mdx = msp[0] - a.last[0];
      var mdy = msp[1] - a.last[1];
      if (Math.abs(mdx) + Math.abs(mdy) > 0.01) {
        if (!a.cloned) {
          // History snapshots keep references, so a move must not mutate the
          // committed stroke objects. Replace each selected stroke with a fresh
          // clone once per gesture; the before snapshot still points at the
          // originals and undo can restore them.
          var orig = {};
          for (var oi = 0; oi < a.origIds.length; oi++) orig[a.origIds[oi]] = true;
          var movedIds = [];
          for (var ri = 0; ri < a.doc.strokes.length; ri++) {
            var rst = a.doc.strokes[ri];
            if (!rst || !orig[rst.id]) continue;
            var rclone = cloneStrokeObject(rst);
            rclone.id = uid();
            rclone.written = false;
            a.doc.strokes[ri] = rclone;
            movedIds.push(rclone.id);
          }
          a.ids = movedIds;
          a.cloned = true;
          if (state.selection) state.selection.ids = movedIds.slice();
        }
        for (var si = 0; si < a.doc.strokes.length; si++) {
          var mst = a.doc.strokes[si];
          if (!mst || a.ids.indexOf(mst.id) < 0) continue;
          for (var mi = 0; mi < mst.pts.length; mi++) {
            mst.pts[mi][0] += mdx;
            mst.pts[mi][1] += mdy;
          }
          mst.bbox = null;
        }
        a.last = msp;
        a.changed = true;
        var mt = nowMs();
        if (!a.lastRedraw || mt - a.lastRedraw > 16) {
          a.lastRedraw = mt;
          redrawEraseSurface(a.surface, a.entry);
          updateSelectionBox();
        }
      }
      return;
    }
    if (a.shapeApplied) {
      // The native recognizer has already replaced this stroke with the ideal
      // shape; further pen movement must not append freehand points to it.
      a.lastSampleAt = nowMs();
      return;
    }
    var list = [ev];
    try {
      if (typeof ev.getCoalescedEvents === "function") {
        var co = ev.getCoalescedEvents();
        if (co && co.length) list = co;
      }
    } catch (e) {}
    for (var i = 0; i < list.length; i++) {
      var e2 = list[i];
      var sp2 = a.surface.kind === "pdf"
        ? a.surface.toSpaceOn(a.entry, e2.clientX, e2.clientY)
        : a.surface.toSpace(e2.clientX, e2.clientY);
      var pr = pressureFor(a.surface, e2, sp2[0], sp2[1]);
      a.lastPressure = pr.p;
      a.lastClientX = e2.clientX;
      a.lastClientY = e2.clientY;
      var tdx = e2.clientX - a.downClientX;
      var tdy = e2.clientY - a.downClientY;
      var travel = Math.sqrt(tdx * tdx + tdy * tdy);
      if (travel > a.maxTravel) a.maxTravel = travel;
      a.stroke.pts.push([sp2[0], sp2[1], pr.p, pr.tiltX, pr.tiltY,
        Math.round(nowMs() - a.t0)]);
      if (!pr.real && state.pressureMode !== "real") {
        pl.queue(e2.clientX + state.offsetX, e2.clientY + state.offsetY, nowMs(),
          a.stroke.pts[a.stroke.pts.length - 1]);
      }
      state.lastPenX = sp2[0];
      state.lastPenY = sp2[1];
      state.lastPenAt = nowMs();
      a.dirty = true;
    }
    // A pen resting on the glass still emits jitter. Only real travel resets
    // the dwell timer, otherwise the hold-to-straighten gesture could never
    // complete while the nib is perfectly still.
    var sl = a.stroke.pts;
    if (sl.length >= 2) {
      var lx = sl[sl.length - 1][0] - sl[sl.length - 2][0];
      var ly = sl[sl.length - 1][1] - sl[sl.length - 2][1];
      if (lx * lx + ly * ly > 0.36) {
        a.lastMoveAt = nowMs();
        armStraightenTimer(a);
      }
    }
    requestLiveFrame();
  }

  function onPointerUpCapture(ev) {
    if (!state.enabled) {
      if (state.active) forceReleaseActive(true);
      return;
    }
    if (ev.pointerType === "pen") state.lastPenSeen = nowMs();
    var ps = state.penUiSwipe;
    if (ps && ev.pointerId === ps.id) {
      if (ps.blocked) {
        state.penClickSuppressUntil = Date.now() + 450;
        try { ev.preventDefault(); } catch (eS1) {}
        try { ev.stopPropagation(); } catch (eS2) {}
        try { ev.stopImmediatePropagation(); } catch (eS3) {}
      }
      state.penUiSwipe = null;
      if (state.blockedPointerId === ev.pointerId) state.blockedPointerId = null;
      return;
    }
    if (state.blockedPointerId !== null && ev.pointerId === state.blockedPointerId) {
      state.penClickSuppressUntil = Date.now() + 450;
      try { ev.preventDefault(); } catch (eB1) {}
      try { ev.stopPropagation(); } catch (eB2) {}
      try { ev.stopImmediatePropagation(); } catch (eB3) {}
      state.blockedPointerId = null;
      return;
    }
    var a = state.active;
    if (!a) return;
    // A pen-up can arrive with a different pointerId than the down (the
    // engine occasionally reports the tail end as a mouse event). Never leave
    // the guard/stroke armed because of that.
    if (ev.pointerId !== a.pointerId && ev.pointerType !== "pen" && !state.penNativeActive) return;
    state.lastPenActivity = nowMs();
    if (ev.preventDefault) ev.preventDefault();
    if (ev.stopPropagation) ev.stopPropagation();
    state.active = null;
    clearPenPredict();
    if (a.holdTimer) {
      clearTimeout(a.holdTimer);
      a.holdTimer = 0;
    }
    stopPressureEraserWatch(a);
    if (a.kind === "erase") clearCursor(true);
    palmOffSoon();
    inkWritingChrome(false);
    inkTrace("strokeUp", {
      kind: a.kind,
      tool: a.stroke ? a.stroke.tool : "erase",
      points: a.stroke && a.stroke.pts ? a.stroke.pts.length : 0
    });
    if (a.kind === "lasso") {
      finishLasso(a);
      return;
    }
    if (a.kind === "move") {
      if (a.changed && a.doc && a.before) {
        pushHistory(a.doc, a.space, a.before);
        saveSoon(a.doc);
        if (a.space.indexOf("pdf:") === 0) markPdfPageDirty(a.surface, a.space);
        if (a.surface.kind === "pdf" || a.surface.kind === "pdfembed") {
          schedulePdfWrite(a.surface);
        }
        inkStatus("已移动选中墨迹", 900);
        probeHook("inkLassoAction", { action: "move", n: a.ids ? a.ids.length : 0 });
      }
      redrawEraseSurface(a.surface, a.entry);
      updateSelectionBox();
      return;
    }
    if (a.kind === "erase") {
      // Partial mode clears pixels on the base canvas while the pen moves and
      // applies the path to the document once, at pen-up. Whole-stroke mode
      // already removed each touched stroke in the move handler, so it must
      // not replay the points here (the strokes are gone).
      if (!a.immediate && a.erasePts && a.erasePts.length &&
        typeof a.surface.erasePreview === "function") {
        for (var ei = 0; ei < a.erasePts.length; ei++) {
          eraseAt(a.surface, a.entry, a.erasePts[ei][0], a.erasePts[ei][1], a);
        }
      }
      if (a.changed && a.doc && a.before) {
        pushHistory(a.doc, a.space, a.before);
        saveSoon(a.doc);
      }
      if (a.changed || a.visualErased) {
        redrawEraseSurface(a.surface, a.entry);
        updateToolbarState();
      }
      if (a.changed && a.space && (a.space.indexOf("pdf:") === 0 ||
        a.space.indexOf("pdfdom:") === 0)) {
        markPdfPageDirty(a.surface, a.space);
        schedulePdfWrite(a.surface);
      }
      probeHook("inkErase", {
        mode: a.immediate ? (state.eraserOnlyHl ? "hl" : "stroke") : "partial",
        changed: a.changed === true,
        removed: a.removed || 0,
        points: a.erasePts ? a.erasePts.length : 0,
        visual: a.visualErased === true,
        ms: Math.round(nowMs() - (a.t0 || nowMs()))
      });
      return;
    }
    var stroke = a.stroke;
    if (!stroke.pts.length) return;
    // If Pen Kit did not call back before the lift, still make a closed square
    // or circle into a clean shape. This is a local fallback, not a second
    // recognizer for arbitrary doodles.
    if (state.shapeMode && !a.shapeApplied && stroke.tool === "pen") {
      var guess = localShapeGuess(stroke.pts);
      probeHook("inkShapeGuess", { type: guess, points: stroke.pts.length });
      if (guess) {
        var gpts = buildShapePoints(guess, stroke.pts, stroke);
        if (gpts) {
          stroke.shape = guess;
          stroke.pts = gpts;
          stroke.bbox = bboxOf(gpts);
          inkTrace("shapeLocal", { type: guess, points: gpts.length });
          probeHook("inkShape", {
            source: "local",
            type: guess,
            points: gpts.length,
            closed: true
          });
        }
      }
    }
    // Persist the snapped geometry, not the wobbly samples: the sidecar and
    // the PDF annotation must both show the straight line the user saw.
    if (stroke.straight === true && stroke.pts.length > 2) straightenStroke(stroke);
    stroke.bbox = bboxOf(stroke.pts);
    stroke.predict = a.predictCount || 0;
    finishStroke(a.surface, a.entry, stroke);
  }

  /* OHSIDIAN_DEV_PROBE_START */
  /**
   * Compact metrics for the device-agent probe. scripts/stylus-eval turns
   * these into pass/fail checks; keep the payload small enough for one hilog
   * line (the probe drops events after 6000 per session).
   */
  function inkStrokeStats(stroke, surface, entry) {
    var pts = stroke.pts || [];
    var step = Math.max(1, Math.floor(pts.length / 48));
    var pmin = 1, pmax = 0, wmin = 1e9, wmax = 0;
    for (var i = 0; i < pts.length; i += step) {
      var p = pts[i][2];
      if (typeof p !== "number" || !isFinite(p)) p = 1;
      var w = widthFor(stroke, p);
      if (p < pmin) pmin = p;
      if (p > pmax) pmax = p;
      if (w < wmin) wmin = w;
      if (w > wmax) wmax = w;
    }
    var blend = "";
    try {
      if (surface && surface.kind === "pdf" && entry && entry.cv) {
        blend = entry.cv.style.mixBlendMode || "";
      }
    } catch (eBlendStats) {}
    return {
      tool: stroke.tool || "pen",
      space: stroke.space || "",
      device: stroke.device || "",
      points: pts.length,
      pressureMin: Math.round(pmin * 1000) / 1000,
      pressureMax: Math.round(pmax * 1000) / 1000,
      widthMin: Math.round(wmin * 100) / 100,
      widthMax: Math.round(wmax * 100) / 100,
      width: Math.round((stroke.width || 0) * 100) / 100,
      color: stroke.color || "",
      ms: Math.round(nowMs() - (state.strokeT0 || nowMs())),
      straight: stroke.straight === true,
      shape: stroke.shape || 0,
      predict: stroke.predict || 0,
      blend: blend
    };
  }
  /* OHSIDIAN_DEV_PROBE_END */

  function finishStroke(surface, entry, stroke) {
    // Do NOT clear the live canvas first: it is a desynchronized layer and its
    // clear can be presented one frame before the tile canvas update, which
    // reads as a flash. Draw the committed stroke into the tiles first, then
    // clear the live layer after one painted frame.
    negotiatePressure();
    if (inkAddStroke(surface, stroke)) {
      clearLiveAfterPaint(surface, entry);
      probeHook("inkStroke", inkStrokeStats(stroke, surface, entry));
      inkTrace("commit", {
        kind: surface.kind,
        space: stroke.space,
        points: stroke.pts ? stroke.pts.length : 0,
        color: stroke.color,
        width: stroke.width,
        tiles: surface.tiles ? Object.keys(surface.tiles).length : 0,
        hostH: surface.tileHost ? (surface.tileHost.offsetHeight || 0) : 0
      });
      if (stroke.space && (stroke.space.indexOf("pdf:") === 0 ||
        stroke.space.indexOf("pdfdom:") === 0)) {
        markPdfPageDirty(surface, stroke.space);
        schedulePdfWrite(surface);
      }
    } else if (surface.kind === "markdown" || surface.kind === "canvas" || surface.kind === "pdfembed") {
      surface.clearLive();
    } else {
      surface.clearLive(entry);
    }
  }

  function clearLiveAfterPaint(surface, entry) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (state.active && state.active.surface === surface) return;
        try {
          if (surface.kind === "markdown" || surface.kind === "canvas" || surface.kind === "pdfembed") surface.clearLive();
          else surface.clearLive(entry);
        } catch (e) {}
      });
    });
  }

  function bboxOf(pts) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (var i = 0; i < pts.length; i++) {
      x0 = Math.min(x0, pts[i][0]);
      y0 = Math.min(y0, pts[i][1]);
      x1 = Math.max(x1, pts[i][0]);
      y1 = Math.max(y1, pts[i][1]);
    }
    return [x0, y0, x1, y1];
  }

  function clearPenPredict() {
    if (state.predictClearTimer) {
      clearTimeout(state.predictClearTimer);
      state.predictClearTimer = 0;
    }
    state.penPredict = null;
  }

  function handlePenPredict(msg) {
    if (!state.predictWanted) return;
    var a = state.active;
    if (!a || a.kind !== "stroke" || a.shapeApplied) return;
    var x = Number(msg.x) + (Number(state.offsetX) || 0);
    var y = Number(msg.y) + (Number(state.offsetY) || 0);
    if (!isFinite(x) || !isFinite(y)) return;
    state.penPredict = { x: x, y: y, t: nowMs(), id: a.pointerId };
    state.predictEvents++;
    if (!a.predictCount) {
      a.predictCount = 1;
      probeHook("inkPredict", {
        firstMs: Math.round(nowMs() - (a.t0 || nowMs()))
      });
    } else {
      a.predictCount++;
    }
    if (state.predictClearTimer) clearTimeout(state.predictClearTimer);
    state.predictClearTimer = setTimeout(function () {
      state.predictClearTimer = 0;
      state.penPredict = null;
      requestLiveFrame();
    }, 80);
    requestLiveFrame();
  }

  var liveFrame = 0;
  function requestLiveFrame() {
    if (liveFrame) return;
    liveFrame = requestAnimationFrame(function () {
      liveFrame = 0;
      var a = state.active;
      if (!a || a.kind !== "stroke") return;
      if (state.latencyT0 && !state.latencyCaptured) {
        state.lastLatency = nowMs() - state.latencyT0;
        state.latencyCaptured = true;
      }
      // Point prediction only extends the live layer; the committed stroke and
      // its sidecar never see the predicted point.
      var drawStroke = a.stroke;
      var pred = state.penPredict;
      if (pred && !a.shapeApplied && a.surface.kind !== "pdfembed" &&
        nowMs() - pred.t < 80) {
        try {
          var xy = a.surface.kind === "pdf"
            ? a.surface.toSpaceOn(a.entry, pred.x, pred.y)
            : a.surface.toSpace(pred.x, pred.y);
          if (xy) {
            var pts = a.stroke.pts;
            var last = pts[pts.length - 1];
            var pdx = xy[0] - last[0];
            var pdy = xy[1] - last[1];
            var pd = Math.sqrt(pdx * pdx + pdy * pdy);
            if (pd > 0.6 && pts.length >= 2) {
              var prev = pts[pts.length - 2];
              var fdx = last[0] - prev[0];
              var fdy = last[1] - prev[1];
              // A predictor sometimes overshoots backwards at a sharp turn;
              // drawing that tail looks like a rubber band, so drop it.
              if (pdx * fdx + pdy * fdy < 0) pd = 0;
            }
            if (pd > 0.6) {
              var maxTail = 18;
              if (pd > maxTail) {
                var k = maxTail / pd;
                xy = [last[0] + pdx * k, last[1] + pdy * k];
              }
              var clone = {};
              for (var ck in a.stroke) {
                if (Object.prototype.hasOwnProperty.call(a.stroke, ck)) clone[ck] = a.stroke[ck];
              }
              clone.pts = pts.concat([[xy[0], xy[1], last[2], last[3], last[4], last[5]]]);
              drawStroke = clone;
            }
          }
        } catch (ePred) {}
      }
      if (drawStroke === a.stroke && a.surface.drawLiveIncremental && a.liveDrawn) {
        a.surface.drawLiveIncremental(a.stroke, a.liveDrawn);
        a.liveDrawn = a.stroke.pts ? a.stroke.pts.length : 0;
      } else if (a.surface.kind === "markdown" || a.surface.kind === "canvas" || a.surface.kind === "pdfembed") {
        a.surface.drawLive(drawStroke);
        a.liveDrawn = a.stroke.pts ? a.stroke.pts.length : 0;
      } else {
        a.surface.drawLive(a.entry, drawStroke);
        a.liveDrawn = a.stroke.pts ? a.stroke.pts.length : 0;
      }
    });
  }

  function scheduleRedraw() {
    for (var i = 0; i < state.surfaces.length; i++) {
      try { state.surfaces[i].redraw(); } catch (e) {}
    }
    updateToolbarState();
  }

  // Eraser: remove touched parts of strokes on one space, split into runs.
  // "stroke" mode removes the whole stroke that the eraser touches; "partial"
  // splits it. History is recorded by the caller once per eraser stroke.
  function eraseAt(surface, entry, x, y, active) {
    var doc = docFor(surface);
    if (!doc) return 0;
    var space = inkSpaceOf(surface, entry);
    var eraserScale = surface.kind === "pdf"
      ? (surface.widthScaleOn(entry) || 1)
      : ((surface.kind === "canvas" || surface.kind === "pdfembed")
        ? (surface.widthScale() || 1) : 1);
    var eraserPx = Number(state.eraserPx) || 12;
    var r = eraserPx / (eraserScale || 1);
    var r2 = r * r;
    var whole = state.eraserMode === "stroke";
    var onlyHl = state.eraserOnlyHl === true;
    var changed = false;
    var removed = 0;
    var out = [];
    for (var i = 0; i < doc.strokes.length; i++) {
      var st = doc.strokes[i];
      if (st.space !== space) {
        out.push(st);
        continue;
      }
      if (onlyHl && st.tool !== "highlighter") {
        out.push(st);
        continue;
      }
      var bb = st.bbox;
      if (bb && (x < bb[0] - r || x > bb[2] + r ||
        y < bb[1] - r || y > bb[3] + r)) {
        out.push(st);
        continue;
      }
      if (whole) {
        var hitWhole = false;
        for (var wj = 0; wj < st.pts.length; wj++) {
          var wp = st.pts[wj];
          var wdx = wp[0] - x, wdy = wp[1] - y;
          if (wdx * wdx + wdy * wdy <= r2) { hitWhole = true; break; }
        }
        if (!hitWhole) {
          out.push(st);
          continue;
        }
        // Drop the whole stroke; write-back replaces the page's annotations
        // from the remaining sidecar strokes.
        changed = true;
        removed++;
        continue;
      }
      var runs = [];
      var run = [];
      for (var j = 0; j < st.pts.length; j++) {
        var p = st.pts[j];
        var dx = p[0] - x, dy = p[1] - y;
        var hit = (dx * dx + dy * dy) <= r2;
        if (hit) {
          if (run.length >= 2) runs.push(run);
          run = [];
        } else {
          run.push(p);
        }
      }
      if (run.length >= 2) runs.push(run);
      if (runs.length === 1 && runs[0].length === st.pts.length) {
        out.push(st);
        continue;
      }
      changed = true;
      removed++;
      for (var k = 0; k < runs.length; k++) {
        var ns = {};
        for (var sk in st) {
          if (Object.prototype.hasOwnProperty.call(st, sk)) ns[sk] = st[sk];
        }
        ns.id = uid();
        ns.pts = runs[k];
        ns.bbox = bboxOf(ns.pts);
        out.push(ns);
      }
    }
    if (!changed) return 0;
    doc.strokes = out;
    if (active) {
      active.changed = true;
      active.removed = (active.removed || 0) + removed;
    }
    return 1;
  }

  function redrawEraseSurface(surface, entry) {
    try {
      if (surface.kind === "pdf" && entry && typeof surface.redrawPage === "function") {
        surface.redrawPage(entry);
      } else if (typeof surface.scheduleRedraw === "function") {
        surface.scheduleRedraw();
      } else if (typeof surface.redraw === "function") {
        surface.redraw();
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // Lasso selection
  // ---------------------------------------------------------------------
  function lassoCanvas() {
    var cv = document.getElementById(LASSO_ID);
    if (!cv) {
      cv = document.createElement("canvas");
      cv.id = LASSO_ID;
      document.body.appendChild(cv);
    }
    var dpr = 1; // outline only: CSS-resolution is enough and 4x cheaper
    var w = Math.max(1, window.innerWidth || 1);
    var h = Math.max(1, window.innerHeight || 1);
    var pw = Math.round(w * dpr);
    var ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw;
      cv.height = ph;
    }
    return cv;
  }

  function clearLasso() {
    state.lassoPts = null;
    var cv = document.getElementById(LASSO_ID);
    if (!cv) return;
    try {
      var ctx = cv.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
    } catch (e) {}
  }

  function drawLasso(pts) {
    if (!pts || pts.length < 2) return;
    var cv = lassoCanvas();
    var dpr = 1;
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cv.width / dpr, cv.height / dpr);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = "rgba(74,144,226,.08)";
    ctx.fill();
    ctx.strokeStyle = "rgba(74,144,226,.95)";
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function pointInPoly(poly, x, y) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1];
      var xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function surfaceRootRect(surface) {
    if (surface.kind === "pdf") return null;
    if (surface.kind === "canvas") return surface.wrapper.getBoundingClientRect();
    if (surface.kind === "pdfembed") return surface.pageEl.getBoundingClientRect();
    return surface.rootEl.getBoundingClientRect();
  }

  function spaceToClient(surface, entry, x, y) {
    try {
      if (surface.kind === "pdf") {
        var vp = entry.viewport.convertToViewportPoint(x, y);
        var pr = entry.cv ? entry.cv.getBoundingClientRect() :
          entry.pageEl.getBoundingClientRect();
        var psx = pr.width / Math.max(1, entry.w);
        var psy = pr.height / Math.max(1, entry.h);
        return [pr.left + vp[0] * psx, pr.top + vp[1] * psy];
      }
      var cp = surface.toCanvasPoint(x, y);
      var rr = surfaceRootRect(surface);
      return [rr.left + cp[0], rr.top + cp[1]];
    } catch (e) {
      return null;
    }
  }

  function clientToSpace(surface, entry, x, y) {
    if (surface.kind === "pdf") return surface.toSpaceOn(entry, x, y);
    return surface.toSpace(x, y);
  }

  function cloneStrokeObject(st) {
    var clone = {};
    for (var key in st) {
      if (Object.prototype.hasOwnProperty.call(st, key)) clone[key] = st[key];
    }
    clone.pts = [];
    for (var i = 0; i < st.pts.length; i++) clone.pts.push(st.pts[i].slice());
    clone.bbox = null;
    return clone;
  }

  function selectedStrokes(sel) {
    if (!sel) return [];
    var out = [];
    for (var i = 0; i < sel.doc.strokes.length; i++) {
      var st = sel.doc.strokes[i];
      if (st && sel.ids.indexOf(st.id) >= 0) out.push(st);
    }
    return out;
  }

  function selectionBBox(sel) {
    if (!sel) return null;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    var list = selectedStrokes(sel);
    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      var b = st.bbox || bboxOf(st.pts);
      if (!b) continue;
      if (b[0] < x0) x0 = b[0];
      if (b[1] < y0) y0 = b[1];
      if (b[2] > x1) x1 = b[2];
      if (b[3] > y1) y1 = b[3];
    }
    if (x0 > x1) return null;
    return [x0, y0, x1, y1];
  }

  function selectionEl() {
    var el = document.getElementById(SEL_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = SEL_ID;
      document.body.appendChild(el);
    }
    return el;
  }

  function selectionBarEl() {
    var el = document.getElementById(SELBAR_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = SELBAR_ID;
      var mk = function (label, cls, fn) {
        var b = document.createElement("button");
        b.textContent = label;
        if (cls) b.className = cls;
        b.addEventListener("pointerdown", function (e) {
          try { e.preventDefault(); e.stopPropagation(); } catch (e1) {}
          fn();
        });
        el.appendChild(b);
        return b;
      };
      mk("副本", "", function () { duplicateSelection(); });
      mk("删除", "is-danger", function () { deleteSelection(); });
      mk("取消", "", function () { clearSelection(); });
      document.body.appendChild(el);
    }
    return el;
  }

  function updateSelectionBox() {
    var sel = state.selection;
    var el = document.getElementById(SEL_ID);
    var bar = document.getElementById(SELBAR_ID);
    if (!sel) {
      if (el) el.style.display = "none";
      if (bar) bar.style.display = "none";
      return;
    }
    var bb = selectionBBox(sel);
    if (!bb) {
      clearSelection();
      return;
    }
    var a = spaceToClient(sel.surface, sel.entry, bb[0], bb[1]);
    var b = spaceToClient(sel.surface, sel.entry, bb[2], bb[3]);
    if (!a || !b) {
      clearSelection();
      return;
    }
    var left = Math.min(a[0], b[0]) - 8;
    var top = Math.min(a[1], b[1]) - 8;
    var w = Math.abs(b[0] - a[0]) + 16;
    var h = Math.abs(b[1] - a[1]) + 16;
    var box = selectionEl();
    box.style.display = "block";
    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(top) + "px";
    box.style.width = Math.max(18, Math.round(w)) + "px";
    box.style.height = Math.max(18, Math.round(h)) + "px";
    var sb = selectionBarEl();
    sb.style.display = "flex";
    var bw = 180;
    var bx = Math.max(8, Math.min(window.innerWidth - bw - 8, left + w - bw));
    var by = top - 42;
    if (by < 8) by = top + h + 8;
    sb.style.left = Math.round(bx) + "px";
    sb.style.top = Math.round(by) + "px";
    sel.clientRect = { left: left, top: top, right: left + w, bottom: top + h };
  }

  function clearSelection() {
    state.selection = null;
    var el = document.getElementById(SEL_ID);
    if (el) el.style.display = "none";
    var bar = document.getElementById(SELBAR_ID);
    if (bar) bar.style.display = "none";
    clearLasso();
  }

  function selectStrokes(surface, entry, clientPoly) {
    var doc = docFor(surface);
    if (!doc || !clientPoly || clientPoly.length < 3) {
      clearSelection();
      return;
    }
    var space = inkSpaceOf(surface, entry);
    var poly = [];
    for (var i = 0; i < clientPoly.length; i++) {
      var sp = clientToSpace(surface, entry, clientPoly[i][0], clientPoly[i][1]);
      poly.push(sp);
    }
    var ids = [];
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (var j = 0; j < doc.strokes.length; j++) {
      var st = doc.strokes[j];
      if (!st || st.space !== space || !st.pts || !st.pts.length) continue;
      var inside = 0;
      var sx = 0, sy = 0;
      for (var k = 0; k < st.pts.length; k++) {
        if (pointInPoly(poly, st.pts[k][0], st.pts[k][1])) inside++;
        sx += st.pts[k][0];
        sy += st.pts[k][1];
      }
      var centerIn = pointInPoly(poly, sx / st.pts.length, sy / st.pts.length);
      if (inside < Math.max(1, Math.ceil(st.pts.length * 0.5)) && !centerIn) continue;
      if (!st.id) st.id = uid();
      ids.push(st.id);
      var b = st.bbox || bboxOf(st.pts);
      if (!b) continue;
      if (b[0] < x0) x0 = b[0];
      if (b[1] < y0) y0 = b[1];
      if (b[2] > x1) x1 = b[2];
      if (b[3] > y1) y1 = b[3];
    }
    if (!ids.length) {
      clearSelection();
      inkStatus("套索没有选中墨迹", 900);
      return;
    }
    state.selection = {
      doc: doc,
      space: space,
      surface: surface,
      entry: entry,
      ids: ids,
      clientRect: null
    };
    updateSelectionBox();
    inkStatus("已选中 " + ids.length + " 笔", 1100);
    inkTrace("lassoSelect", { strokes: ids.length, space: space });
  }

  function duplicateSelection() {
    var sel = state.selection;
    if (!sel) return;
    var before = snapshotSpace(sel.doc, sel.space);
    var dx = 18, dy = 18;
    try {
      if (sel.surface.kind === "pdf") {
        dx = 14 / (sel.surface.widthScaleOn(sel.entry) || 1);
      } else if (sel.surface.kind === "pdfembed") {
        // pdfdom coordinates are normalised to 0..1 of the page. The pdf branch
        // above only overrides dx, so the default dy = 18 (canvas pixels)
        // stayed in place for pdfembed too: every copy jumped 18 page-heights
        // down, landed outside the page and was then written into the PDF as a
        // garbage annotation (audit NF-011). Both axes use page fractions.
        dx = 0.02;
        dy = 0.02;
      }
    } catch (e) {}
    var newIds = [];
    var total = sel.doc.strokes.length;
    for (var i = 0; i < total; i++) {
      var st = sel.doc.strokes[i];
      if (!st || sel.ids.indexOf(st.id) < 0) continue;
      var clone = cloneStrokeObject(st);
      clone.id = uid();
      clone.baked = false;
      clone.written = false;
      for (var p = 0; p < clone.pts.length; p++) {
        clone.pts[p][0] += dx;
        clone.pts[p][1] += dy;
      }
      clone.bbox = bboxOf(clone.pts);
      sel.doc.strokes.push(clone);
      newIds.push(clone.id);
    }
    if (!newIds.length) return;
    sel.ids = newIds;
    pushHistory(sel.doc, sel.space, before);
    saveSoon(sel.doc);
    redrawEraseSurface(sel.surface, sel.entry);
    updateSelectionBox();
    if (sel.space.indexOf("pdf:") === 0) markPdfPageDirty(sel.surface, sel.space);
    if (sel.surface.kind === "pdf" || sel.surface.kind === "pdfembed") schedulePdfWrite(sel.surface);
    inkStatus("已复制 " + newIds.length + " 笔", 1100);
    probeHook("inkLassoAction", { action: "duplicate", n: newIds.length });
  }

  function deleteSelection() {
    var sel = state.selection;
    if (!sel) return;
    var before = snapshotSpace(sel.doc, sel.space);
    var out = [];
    var removed = 0;
    for (var i = 0; i < sel.doc.strokes.length; i++) {
      var st = sel.doc.strokes[i];
      if (st && sel.ids.indexOf(st.id) >= 0) {
        removed++;
        continue;
      }
      out.push(st);
    }
    if (!removed) {
      clearSelection();
      return;
    }
    sel.doc.strokes = out;
    pushHistory(sel.doc, sel.space, before);
    saveSoon(sel.doc);
    redrawEraseSurface(sel.surface, sel.entry);
    if (sel.space.indexOf("pdf:") === 0) markPdfPageDirty(sel.surface, sel.space);
    if (sel.surface.kind === "pdf" || sel.surface.kind === "pdfembed") schedulePdfWrite(sel.surface);
    probeHook("inkLassoAction", { action: "delete", n: removed });
    clearSelection();
    inkStatus("已删除 " + removed + " 笔", 1100);
  }

  function finishLasso(a) {
    var pts = (a.lassoPts || []).slice();
    clearLasso();
    if (pts.length < 4) {
      clearSelection();
      return;
    }
    selectStrokes(a.surface, a.entry, pts);
    probeHook("inkLasso", {
      points: pts.length,
      selected: state.selection && state.selection.ids ? state.selection.ids.length : 0
    });
  }

  // Palm rejection: a full-screen guard exists only while the pen is down.
  var palmTimer = 0;
  var palmWatchdog = 0;

  function palmHide() {
    if (palmTimer) {
      clearTimeout(palmTimer);
      palmTimer = 0;
    }
    if (palmWatchdog) {
      clearInterval(palmWatchdog);
      palmWatchdog = 0;
    }
    try {
      // Older builds used a full-screen guard div; remove any left behind so
      // an upgrade can never keep the touchscreen covered.
      var el = document.getElementById(GUARD_ID);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    } catch (e) {}
  }

  /**
   * Last-resort recovery: a lost pointerup/cancel (id mismatch, pen lifted
   * outside the window, engine reporting mouse-up) must never leave the guard
   * on screen - that looks like "the touchscreen stopped working".
   */
  function forceReleaseActive(quiet) {
    var a = state.active;
    state.active = null;
    state.penNativeActive = false;
    clearPenPredict();
    try {
      if (a) {
        if (a.holdTimer) {
          clearTimeout(a.holdTimer);
          a.holdTimer = 0;
        }
        stopPressureEraserWatch(a);
        if (a.kind === "lasso") {
          clearLasso();
        } else if (a.kind === "move" && a.changed && a.doc && a.before) {
          pushHistory(a.doc, a.space, a.before);
          saveSoon(a.doc);
          if (a.space.indexOf("pdf:") === 0) markPdfPageDirty(a.surface, a.space);
          if (a.surface.kind === "pdf" || a.surface.kind === "pdfembed") schedulePdfWrite(a.surface);
          updateSelectionBox();
        } else if (a.kind === "stroke" && a.stroke) {
          if (a.stroke.straight === true && a.stroke.pts.length > 2) straightenStroke(a.stroke);
          a.stroke.bbox = bboxOf(a.stroke.pts);
          finishStroke(a.surface, a.entry, a.stroke);
        } else if (a.kind === "erase" && a.changed && a.doc && a.before) {
          pushHistory(a.doc, a.space, a.before);
          saveSoon(a.doc);
        } else if (!a.immediate && a.kind === "erase" && a.erasePts && a.surface &&
          typeof a.surface.erasePreview === "function") {
          for (var efi = 0; efi < a.erasePts.length; efi++) {
            eraseAt(a.surface, a.entry, a.erasePts[efi][0], a.erasePts[efi][1], a);
          }
          if (a.changed && a.doc && a.before) {
            pushHistory(a.doc, a.space, a.before);
            saveSoon(a.doc);
          }
        }
        if (a.surface) {
          if (a.surface.kind === "markdown" || a.surface.kind === "canvas" || a.surface.kind === "pdfembed") a.surface.clearLive();
          else a.surface.clearLive(a.entry);
        }
      }
    } catch (e) {
      warn("force release failed", e && e.message);
    }
    palmHide();
    inkWritingChrome(false);
    scheduleRedraw();
    if (!quiet) inkStatus("手写笔状态已自动复位");
  }

  function palmWatchdogTick() {
    if (!state.active) {
      palmHide();
      return;
    }
    // A pen resting on the glass sends no move events. The old 2.6 s timeout
    // committed the stroke under a still-pressed nib, so everything written
    // after the pause vanished (and looked like the pen had turned into an
    // eraser); the next pen-down "turned it back". Native penActive only goes
    // false on a real pen-up, so while it is true the nib is still down.
    if (state.penNativeActive) return;
    var last = state.active.lastSampleAt || state.lastPenActivity || 0;
    if (nowMs() - last > 4500) {
      forceReleaseActive(false);
    }
  }

  function palmOn() {
    if (!state.palm) return;
    state.lastPenActivity = nowMs();
    // Palm rejection is done from the window capture listeners (touchstart /
    // pointerdown are stopped while a pen stroke is active). Do NOT create a
    // full-screen guard div: a lost pen-up used to leave it covering the UI,
    // which looked like a dead touchscreen.
    try {
      var old = document.getElementById(GUARD_ID);
      if (old && old.parentNode) old.parentNode.removeChild(old);
    } catch (e) {}
    if (palmTimer) clearTimeout(palmTimer);
    if (palmWatchdog) clearInterval(palmWatchdog);
    palmWatchdog = setInterval(palmWatchdogTick, 600);
  }

  function palmOffSoon() {
    if (palmTimer) clearTimeout(palmTimer);
    palmTimer = setTimeout(function () {
      palmTimer = 0;
      palmHide();
    }, 140);
  }

  // ---------------------------------------------------------------------
  // Pen hover cursor (a quiet ring, not a permanent overlay)
  // ---------------------------------------------------------------------
  var cursorEl = null;

  function cursorCanvas() {
    if (cursorEl) return cursorEl;
    cursorEl = document.createElement("canvas");
    cursorEl.id = "ohsidian-ink-cursor";
    cursorEl.style.cssText = "position:fixed;left:0;top:0;width:64px;height:64px;" +
      "pointer-events:none;z-index:25;opacity:0;transition:opacity .08s linear";
    document.body.appendChild(cursorEl);
    return cursorEl;
  }

  function clearCursor(force) {
    if (!cursorEl) return;
    if (!force && state.active && state.active.kind === "erase") return;
    try {
      var ctx = cursorEl.getContext("2d");
      ctx.clearRect(0, 0, cursorEl.width, cursorEl.height);
      cursorEl.style.opacity = "0";
    } catch (e) {}
  }

  function drawCursor(x, y, surface, forceEraser) {
    var isErase = forceEraser === true || state.tool === "eraser";
    if (!state.enabled || !state.cursorEnabled || state.tool === "pointer" ||
      (state.active && state.active.kind !== "erase" && !forceEraser)) {
      clearCursor();
      return;
    }
    try {
      var cv = cursorCanvas();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var size = 72;
      var px = Math.round(size * dpr);
      if (cv.width !== px || cv.height !== px) {
        cv.width = px;
        cv.height = px;
      }
      var ctx = cv.getContext("2d", { desynchronized: true });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      var color = isErase ? "#888" : (state.tool === "highlighter"
        ? state.hlColor
        : (state.colorAuto ? inkAutoColor(surface) : state.color));
      var r = isErase ? (Number(state.eraserPx) || 12) :
        (state.tool === "highlighter" ? Math.min(16, Math.max(6, state.hlWidth / 2)) :
          Math.min(12, Math.max(4, state.width)));
      var c = size / 2;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      if (isErase) {
        ctx.fillStyle = "rgba(128,128,128,.14)";
        ctx.fill();
      }
      ctx.lineWidth = isErase ? 1.4 : 1.3;
      ctx.strokeStyle = isErase ? "rgba(120,120,120,.95)" : color;
      ctx.globalAlpha = isErase ? 0.9 : 0.8;
      ctx.stroke();
      if (!isErase) {
        ctx.beginPath();
        ctx.arc(c, c, 1, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      cv.style.left = Math.round(x - size / 2) + "px";
      cv.style.top = Math.round(y - size / 2) + "px";
      cv.style.opacity = "0.9";
    } catch (e) {
      clearCursor();
    }
  }

  // ---------------------------------------------------------------------
  // Edge-swipe guard
  // ---------------------------------------------------------------------
  var edgeTouch = null;

  function penInputGuardActive() {
    return !!(state.enabled && state.tool !== "pointer" &&
      (state.active || state.penNativeActive || nowMs() - state.lastPenSeen < 1200));
  }

  /**
   * A pen can arrive as compatibility touch/mouse events in addition to
   * pointer events. Obsidian's mobile swipe handlers listen on those channels,
   * so blocking only pointerdown still allowed a pen swipe to open panels.
   * During pen activity both channels are swallowed; after 1.2s of no pen they
   * are left alone for the hand.
   */
  function onPenCompatibilityBlock(ev) {
    if (!penInputGuardActive()) return;
    if (isInkChrome(ev.target)) return;
    try { ev.preventDefault(); } catch (e1) {}
    try { ev.stopPropagation(); } catch (e2) {}
    try { ev.stopImmediatePropagation(); } catch (e3) {}
    if (Date.now() - state.lastPenBlockLog > 900) {
      state.lastPenBlockLog = Date.now();
      try {
        var t = ev.target || {};
        inkTrace("penCompatBlocked", {
          type: ev.type,
          tag: t.tagName || "",
          cls: t.className ? String(t.className).slice(0, 48) : ""
        });
      } catch (e4) {}
    }
  }

  function onEdgeTouchStart(ev) {
    if (!state.enabled || !state.blockEdge) return;
    if (state.tool === "pointer" && !state.active && !state.penNativeActive) return;
    if (isExcluded(ev.target)) return;
    try {
      var t = ev.touches && ev.touches[0];
      if (!t) return;
      var w = window.innerWidth || 0;
      var edge = 48;
      if (t.clientX > edge && t.clientX < w - edge) return;
      edgeTouch = { x: t.clientX, y: t.clientY, id: t.identifier, blocked: false };
    } catch (e) {}
  }

  function onEdgeTouchMove(ev) {
    if (!edgeTouch) return;
    if (!state.enabled || !state.blockEdge) {
      edgeTouch = null;
      return;
    }
    try {
      var t = null;
      var list = ev.touches || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].identifier === edgeTouch.id) { t = list[i]; break; }
      }
      if (!t) t = list[0];
      if (!t) return;
      var dx = t.clientX - edgeTouch.x;
      var dy = t.clientY - edgeTouch.y;
      if (!edgeTouch.blocked) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dx) > Math.abs(dy)) edgeTouch.blocked = true;
        else { edgeTouch = null; return; }
      }
      // Horizontal edge swipe while a pen tool is active: Obsidian's mobile
      // sidebar gestures listen on document/body; our window capture runs
      // first, so this keeps the stroke from waking the side panels.
      try { ev.preventDefault(); } catch (e1) {}
      try { ev.stopPropagation(); } catch (e2) {}
      try { ev.stopImmediatePropagation(); } catch (e3) {}
    } catch (e) {}
  }

  /**
   * Pen events are not touch events, so the touch guard above cannot stop a
   * pointer-driven sidebar gesture. Block pen starts/moves in the edge strip
   * while a drawing tool is active; once a stroke is active the normal ink
   * capture owns the event.
   */
  function onPenEdgePointer(ev) {
    if (!state.enabled || !state.blockEdge || !ev) return;
    if (ev.pointerType !== "pen" && ev.pointerType !== "touch") return;
    if (state.active) return;
    if (state.tool === "pointer" && !state.penNativeActive) return;
    if (isExcluded(ev.target)) return;
    var w = window.innerWidth || 0;
    if (ev.clientX > 48 && ev.clientX < w - 48) return;
    try { ev.preventDefault(); } catch (e1) {}
    try { ev.stopPropagation(); } catch (e2) {}
    try { ev.stopImmediatePropagation(); } catch (e3) {}
  }

  function onEdgeTouchEnd(ev) {    if (edgeTouch && edgeTouch.blocked) {
      try { ev.preventDefault(); } catch (e1) {}
      try { ev.stopPropagation(); } catch (e2) {}
      try { ev.stopImmediatePropagation(); } catch (e3) {}
    }
    edgeTouch = null;
  }

  function onCursorMove(ev) {
    if (!state.enabled || !ev) {
      clearCursor();
      return;
    }
    if (ev.pointerType !== "pen" || ev.buttons !== 0 || state.active) {
      if (state.active && state.active.kind === "erase") return;
      clearCursor();
      return;
    }
    if (isExcluded(ev.target)) {
      clearCursor();
      return;
    }
    if (state.tool === "pointer") {
      clearCursor();
      return;
    }
    // Hover can arrive at 120Hz; the ring only needs ~60fps. This also avoids
    // running surfaceAtEvent for every hover sample (power/CPU on tablets).
    var cursorNow = Date.now();
    if (cursorNow - (state.lastCursorMoveAt || 0) < 16) return;
    state.lastCursorMoveAt = cursorNow;
    var hit = surfaceAtEvent(ev.target);
    if (!hit) {
      clearCursor();
      return;
    }
    drawCursor(ev.clientX, ev.clientY, hit.surface);
  }

  // ---------------------------------------------------------------------
  // IPC with ArkTS (loopback socket owned by touch-mode.js)
  // ---------------------------------------------------------------------
  function sendAction(obj) {
    try {
      if (typeof window.__ohsidianNativeSend === "function") {
        var ok = window.__ohsidianNativeSend(obj);
        if (ok) {
          state.ipcSent++;
          state.ipcReady = true;
        }
        return ok;
      }
    } catch (e) {}
    return false;
  }

  function ensureIpc() {
    if (window.__ohsidianNativeIpcReady === false) {
      state.ipcReady = false;
    }
    if (state.ipcReady) return true;
    if (window.__ohsidianNativeIpcReady) {
      state.ipcReady = true;
      return true;
    }
    var t = Date.now();
    if (t - state.ipcTriedAt < 2000) return false;
    state.ipcTriedAt = t;
    try {
      if (typeof window.__ohsidianNativeEnsure === "function") {
        window.__ohsidianNativeEnsure();
      }
    } catch (e) {}
    return false;
  }

  function onNativeMessage(msg) {
    if (!msg) return;
    state.ipcRecv++;
    // Any line proves the socket is alive; do not wait for stylusInfo (which
    // can be sent before this listener is attached on a fast boot).
    state.ipcReady = true;
    if (msg.event === "stylus") {
      state.gestureCount++;
      state.lastGesture = msg.kind;
      state.lastGestureAt = Date.now();
      handleGesture(msg.kind);
      return;
    }
    if (msg.event === "stylusInfo") {
      state.stylusInfo = {
        supported: !!msg.supported,
        subscribed: !!msg.subscribed,
        error: msg.error || "",
        pdf: !!msg.pdf,
        shape: !!msg.shape,
        predict: !!msg.predict
      };
      state.shapeSupported = !!msg.shape;
      state.predictSupported = !!msg.predict;
      state.ipcReady = true;
      negotiatePressure();
      sendShapeMode();
      sendPredictMode();
      return;
    }
    if (msg.event === "shape") {
      state.shapeEvents++;
      if (state.shapeMode) applyNativeShape(Number(msg.shapeType) || 0);
      return;
    }
    if (msg.event === "penPredict") {
      handlePenPredict(msg);
      return;
    }
    if (msg.event === "penSamples") {
      pl.push(msg);
      return;
    }
    if (msg.event === "penActive") {
      state.penNativeActive = !!msg.active;
      state.penNativeAt = Date.now();
      state.lastPenActivity = nowMs();
      if (state.penNativeTimer) clearTimeout(state.penNativeTimer);
      if (msg.active) {
        // ArkTS sends 'up' as well, but a lost line must not leave the pen
        // marked active forever: decay after one second of silence.
        state.penNativeTimer = setTimeout(function () {
          state.penNativeActive = false;
          state.penNativeTimer = 0;
        }, 1000);
      }
      return;
    }
    if (msg.event === "pdfInkResult") {
      resolvePdfResult(msg);
      return;
    }
    if (msg.event === "pdfPreviewProbeResult") {
      probeHook("pdfPreviewProbe", {
        ok: !!msg.ok,
        ms: msg.ms,
        w: msg.w,
        h: msg.h,
        error: msg.error || ""
      });
      return;
    }
    if (msg.event === "pdfPreviewShown") {
      probeHook("pdfPreviewShown", {
        ok: !!msg.ok,
        ms: msg.ms,
        error: msg.error || ""
      });
      return;
    }
    if (msg.event === "pdfPreviewResult") {
      var pp = state.pdfPreviewPending[msg.seq];
      if (!pp) return;
      delete state.pdfPreviewPending[msg.seq];
      if (!msg.ok) {
        probeHook("pdfPreview", { ok: false, ms: msg.ms, error: msg.error || "" });
        return;
      }
      var ppUrl = pdfPreviewUrl(pp.out);
      if (ppUrl) showPdfPreview(pp.surface, pp.page, ppUrl);
      probeHook("pdfPreview", { ok: true, ms: msg.ms, bytes: msg.bytes, page: pp.page });
      return;
    }
  }

  function handleGesture(kind) {
    try {
      if (document.hasFocus && !document.hasFocus()) return;
    } catch (e) {}
    if (!state.enabled) return;
    inkTrace("gesture", { kind: kind, tool: state.tool });
    // Never let a barrel gesture land in the middle of a stroke: switching to
    // the eraser while the tip is still down is what made handwriting grow
    // round holes and then "become a pen again" after the lift.
    if (state.active) {
      inkTrace("gestureIgnored", { kind: kind, reason: "stroke" });
      return;
    }
    if (nowMs() - (state.lastPenActivity || 0) < 220) {
      inkTrace("gestureIgnored", { kind: kind, reason: "pen-recent" });
      return;
    }
    // No overlay (typically Live Preview): a pen gesture is an explicit request
    // to write, so switch to reading view and enter pen mode.
    if (!activeSurfaceNow()) {
      if (inkEnterReadingMode()) {
        inkStatus(kind === "squeeze" ? "已切换到阅读视图：打开手写工具条" : "已切换到阅读视图：可以开始手写", 3200);
        inkAfterEnterReadingMode(kind);
        return;
      }
    }
    var dbl = pref("inkDoubleTap", "pen-eraser");
    var sq = pref("inkSqueeze", "palette");
    if (kind === "doubleTap") {
      if (dbl === "none") return;
      if (!ensureInkTarget()) return;
      var wasHidden = !barActuallyVisible();
      var wasPointer = state.tool === "pointer";
      if (wasHidden) expandToolbar();
      if (dbl === "wake") {
        if (!wasHidden) expandToolbar();
        inkStatus("手写工具条已唤醒");
        return;
      }
      if (dbl === "undo") { inkUndo(); return; }
      if (dbl === "palette") { togglePalette(); return; }
      // Coming from the hand tool, the first double-tap means "write again",
      // not "erase": toggling straight to the eraser here felt like a bug.
      if (wasPointer) {
        setTool(state.lastPenTool || "pen");
        inkStatus("笔");
        return;
      }
      // Pen ↔ eraser. The highlighter is a pen tool in this context: a
      // double-tap from it switches to the eraser, and back to the last pen.
      if (state.tool === "eraser") {
        setTool(state.lastPenTool || "pen");
        inkStatus("笔");
      } else {
        setTool("eraser");
        inkStatus("橡皮");
      }
      return;
    }
    if (kind === "squeeze") {
      if (sq === "none") return;
      if (sq === "undo") { if (ensureInkTarget()) inkUndo(); return; }
      if (sq === "pen-eraser") {
        if (state.tool === "eraser") { setTool(state.lastPenTool || "pen"); inkStatus("笔"); }
        else { setTool("eraser"); inkStatus("橡皮"); }
        return;
      }
      if (ensureInkTarget()) togglePalette();
    }
  }

  function inkAwaitSurface(source) {
    if (state.surfaceWaitTimer) return;
    state.surfaceWaitTries = 0;
    state.surfaceWaitTimer = setInterval(function () {
      if (!state.enabled) {
        clearInterval(state.surfaceWaitTimer);
        state.surfaceWaitTimer = 0;
        return;
      }
      state.surfaceWaitTries++;
      try { inkRefreshSurfaces(); } catch (e) {}
      var surface = activeSurfaceNow();
      if (surface) {
        clearInterval(state.surfaceWaitTimer);
        state.surfaceWaitTimer = 0;
        try { buildToolbar(); } catch (eB) {}
        // Only an explicit wake gesture opens the bar. A stray pen stroke on
        // an area with no surface must not make controls pop up later.
        if (source === "gesture" || source === "reading") expandToolbar();
        var gesture = state.awaitGesture;
        state.awaitGesture = null;
        var tool = state.pendingTool || state.lastPenTool || "pen";
        state.pendingTool = null;
        if (gesture === "squeeze") togglePalette();
        else setTool(tool);
        return;
      }
      if (state.surfaceWaitTries >= 12) {
        clearInterval(state.surfaceWaitTimer);
        state.surfaceWaitTimer = 0;
        inkStatus("手写层仍不可用：请确认笔记在阅读视图后重试", 4000);
        inkTrace("surfaceWaitTimeout", { source: source || "" });
      }
    }, 250);
  }

  function ensureInkTarget() {
    var surface = activeSurfaceNow();
    if (!surface) {
      inkStatus("手写层准备中…", 1500);
      inkAwaitSurface("gesture");
      return false;
    }
    if (!state.toolbarBuilt) buildToolbar();
    return true;
  }

  /**
   * A barrel gesture in Live Preview/editing means "I want to write": switch
   * the current markdown leaf to reading view instead of only complaining.
   * The plan deliberately does not overlay the CodeMirror source view.
   */
  function inkEnterReadingMode() {
    try {
      var app = state.app;
      var leaf = app && app.workspace ? app.workspace.activeLeaf : null;
      var view = leaf && leaf.view;
      if (!view || view.getViewType() !== "markdown") return false;
      if (typeof view.getMode === "function" && view.getMode() === "preview") return true;
      if (typeof view.setState === "function") {
        var st = typeof view.getState === "function" ? view.getState() : {};
        st.mode = "preview";
        view.setState(st, { history: false });
        return true;
      }
      if (app.commands && app.commands.executeCommandById) {
        return !!app.commands.executeCommandById("markdown:toggle-preview");
      }
    } catch (e) {
      warn("enter reading mode failed", e && e.message);
    }
    return false;
  }

  function inkAfterEnterReadingMode(gestureKind) {
    setTimeout(function () {
      try {
        inkRefreshSurfaces();
        buildToolbar();
      } catch (e) {}
      state.awaitGesture = gestureKind || null;
      // Do not give up after one 380ms shot: the reading view can mount later
      // (large note, first layout, split view). Poll until it is ready.
      inkAwaitSurface(gestureKind || "reading");
    }, 160);
  }

  /** Switch to reading view, then apply the tool the user asked for. */
  function inkRequestReadingMode(tool) {
    state.pendingTool = tool || "pen";
    if (!inkEnterReadingMode()) {
      state.pendingTool = null;
      inkStatus("当前笔记无法切换到阅读视图；请手动切换后重试。");      return false;
    }
    inkStatus("已切换到阅读视图，手写层准备中…", 3000);
    inkAfterEnterReadingMode("pen");
    return true;
  }

  function activeSurfaceForLeaf(leaf) {
    for (var i = 0; i < state.surfaces.length; i++) {
      if (state.surfaces[i].leaf === leaf) return state.surfaces[i];
    }
    return null;
  }

  function activeSurfaceNow() {
    var app = state.app;
    var leaf = app && app.workspace ? app.workspace.activeLeaf : null;
    if (leaf) {
      var s = activeSurfaceForLeaf(leaf);
      return s || null;
    }
    // Only when there is no active leaf at all (boot, popout teardown) fall
    // back to the first mounted surface.
    return state.surfaces.length ? state.surfaces[0] : null;
  }

  /** The active leaf is a markdown note (reading or editing). */
  function activeMarkdownLeaf() {
    var app = state.app;
    var leaf = app && app.workspace ? app.workspace.activeLeaf : null;
    if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function") return null;
    return leaf.view.getViewType() === "markdown" ? leaf : null;
  }

  /** Any view that can host ink, including Canvas/PDF before a surface exists. */
  function activeInkLeaf() {
    var app = state.app;
    var leaf = app && app.workspace ? app.workspace.activeLeaf : null;
    if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function") return null;
    var t = leaf.view.getViewType();
    return (t === "markdown" || t === "pdf" || t === "canvas") ? leaf : null;
  }

  // ---------------------------------------------------------------------
  // PDF native first-paint preview
  // ---------------------------------------------------------------------
  function pdfPreviewPath(file, page) {
    try {
      var ad = adapter();
      if (!ad || typeof ad.getBasePath !== "function") return "";
      var base = ad.getBasePath();
      if (!base) return "";
      return base + "/.obsidian/ohsidian-ink/cache/preview-" +
        inkKey(file.path) + "-" + page + ".png";
    } catch (e) { return ""; }
  }

  function pdfPreviewCached(path) {
    try {
      var fsMod = require("fs");
      return !!(path && fsMod.existsSync(path));
    } catch (e) { return false; }
  }

  function pdfPreviewUrl(path) {
    try {
      var fsMod = require("fs");
      if (!fsMod.existsSync(path)) return "";
      var buf = fsMod.readFileSync(path);
      if (!buf || !buf.length) return "";
      return URL.createObjectURL(new Blob([buf], { type: "image/png" }));
    } catch (e) { return ""; }
  }

  function showPdfPreview(surface, pageIndex, url) {
    try {
      if (!surface || !surface.container) return;
      if (surface.renderedPages && surface.renderedPages[pageIndex + 1]) return;
      var pageEl = surface.container.querySelector(
        '.page[data-page-number="' + (pageIndex + 1) + '"]');
      if (!pageEl) return;
      var img = pageEl.querySelector("img.ohsidian-pdf-preview");
      if (!img) {
        img = document.createElement("img");
        img.className = "ohsidian-pdf-preview";
        img.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;" +
          "object-fit:fill;pointer-events:none;z-index:3;background:#fff;";
        pageEl.appendChild(img);
      }
      img.src = url;
    } catch (e) {}
  }

  function dropPdfPreview(surface, pageIndex) {
    try {
      if (!surface || !surface.container) return;
      var pageEl = surface.container.querySelector(
        '.page[data-page-number="' + (pageIndex + 1) + '"]');
      if (!pageEl) return;
      var img = pageEl.querySelector("img.ohsidian-pdf-preview");
      if (!img) return;
      try {
        if (img.src.indexOf("blob:") === 0) URL.revokeObjectURL(img.src);
      } catch (eR) {}
      if (img.parentNode) img.parentNode.removeChild(img);
    } catch (e) {}
  }

  function pdfPreviewCover(surface) {
    try {
      dropPdfPreviewCover(surface);
      var r = surface.container.getBoundingClientRect();
      var d = document.createElement("div");
      d.className = "ohsidian-pdf-preview-cover";
      d.style.cssText = "position:fixed;left:" + r.left + "px;top:" + r.top +
        "px;width:" + r.width + "px;height:" + r.height +
        "px;background:var(--background-primary,#fff);z-index:99998;pointer-events:none;";
      document.body.appendChild(d);
      surface.previewCover = d;
    } catch (e) {}
  }

  function dropPdfPreviewCover(surface) {
    try {
      if (surface && surface.previewCover && surface.previewCover.parentNode) {
        surface.previewCover.parentNode.removeChild(surface.previewCover);
      }
    } catch (e) {}
    if (surface) surface.previewCover = null;
  }

  function dropFixedPreview(surface) {
    try {
      if (surface && surface.fixedPreview && surface.fixedPreview.parentNode) {
        if (surface.fixedPreview.src.indexOf("blob:") === 0) {
          URL.revokeObjectURL(surface.fixedPreview.src);
        }
        surface.fixedPreview.parentNode.removeChild(surface.fixedPreview);
      }
    } catch (e) {}
    if (surface) surface.fixedPreview = null;
  }

  function showFixedPreview(surface, pageIndex, url) {
    try {
      if (!surface || !surface.container) return;
      dropFixedPreview(surface);
      var pageEl = surface.container.querySelector(
        '.page[data-page-number="' + (pageIndex + 1) + '"]');
      if (!pageEl) return;
      var scrollEl = surface.viewer && surface.viewer.container;
      if (scrollEl) scrollEl.scrollTop = pageEl.offsetTop;
      var r = pageEl.getBoundingClientRect();
      var img = document.createElement("img");
      img.className = "ohsidian-pdf-preview-fixed";
      img.src = url;
      img.style.cssText = "position:fixed;left:" + r.left + "px;top:" + r.top +
        "px;width:" + r.width + "px;height:" + r.height +
        "px;background:#fff;z-index:99999;pointer-events:none;";
      document.body.appendChild(img);
      surface.fixedPreview = img;
      dropPdfPreviewCover(surface);
    } catch (e) {}
  }

  function releasePreviewHold(surface, url) {
    if (!surface || !surface.previewHold) return;
    surface.previewHold = false;
    if (surface.previewHoldTimer) {
      clearTimeout(surface.previewHoldTimer);
      surface.previewHoldTimer = 0;
    }
    try {
      surface.viewer.currentPageNumber = 1;
      var pageEl = surface.container.querySelector('.page[data-page-number="1"]');
      if (pageEl && surface.viewer.container) {
        surface.viewer.container.scrollTop = pageEl.offsetTop;
      }
    } catch (eS) {}
    if (url) showFixedPreview(surface, 0, url);
    else dropPdfPreviewCover(surface);
  }

  function requestPdfPreview(surface, pageOverride) {
    if (!surface || surface.kind !== "pdf" || !surface.leaf) return;
    var file = surface.leaf.view && surface.leaf.view.file;
    if (!file) return;
    var page = 0;
    if (typeof pageOverride === "number" && pageOverride >= 0) page = pageOverride;
    else {
      try { page = Math.max(0, (surface.viewer.currentPageNumber || 1) - 1); } catch (eP) {}
    }
    try {
      var pageEl = surface.container.querySelector(
        '.page[data-page-number="' + (page + 1) + '"]');
      if (!pageEl) return;
      var r = pageEl.getBoundingClientRect();
      if (!(r.width > 10) || !(r.height > 10)) return;
      // At pagesinit the page div can still carry its unscaled layout width
      // (e.g. 2559 px before page-width is applied); previewing that would
      // cover half the window. Wait for the real page-width rect.
      var maxW = (surface.container.clientWidth || window.innerWidth || 1247) * 1.15;
      if (r.width > maxW) {
        var tries = surface.previewTries || 0;
        if (tries < 20 && !surface.previewRetry) {
          surface.previewTries = tries + 1;
          surface.previewRetry = setTimeout(function () {
            surface.previewRetry = 0;
            try { requestPdfPreview(surface, page); } catch (eR2) {}
          }, 200);
        }
        return;
      }
      // Only preview a page that is actually on screen.
      if (r.bottom < 0 || r.top > (window.innerHeight || 1)) return;
      var ad = adapter();
      var abs = ad.getFullPath(file.path);
      var seq = state.seq++;
      state.pdfPreviewPending[seq] = { surface: surface, page: page };
      surface.previewPage = page;
      var sent = sendAction({
        action: "pdfPreview",
        seq: seq,
        path: abs,
        page: page,
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        dpr: window.devicePixelRatio || 1
      });
      inkTrace("previewReq", {
        page: page, sent: !!sent,
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height)
      });
    } catch (e) {
      inkTrace("previewReq", { page: page, error: String(e && e.message || e) });
    }
  }

  function schedulePdfPreview(surface) {
    if (!surface || surface.previewTimer) return;
    surface.previewTimer = setTimeout(function () {
      surface.previewTimer = 0;
      try { requestPdfPreview(surface); } catch (e) {}
    }, 300);
  }

  // ---------------------------------------------------------------------
  // PDF write-back
  // ---------------------------------------------------------------------
  function resolvePdfResult(msg) {
    if (msg && msg.seq === 0) {
      // Transport-level failure not tied to a request: the ArkTS side dropped a
      // line that exceeded its IPC cap (audit NF-007). No promise is waiting on
      // seq 0, so report it and let the pipeline recover instead of leaving the
      // caller to time out after 90 s.
      notice("PDF 写回被拒绝：" + (msg.error || "IPC 错误"), 8000);
      state.pdfInFlight = false;
      return;
    }
    var pending = state.pdfPending[msg.seq];
    if (!pending) return;
    delete state.pdfPending[msg.seq];
    if (pending.timer) clearTimeout(pending.timer);
    try {
      pending.resolve(msg);
    } catch (e) {}
  }

  function pdfWritePage(rel, abs, vaultRoot, page, strokes, mode, replace, removeIds, style) {
    return new Promise(function (resolve) {
      if (!ensureIpc()) {
        resolve({ ok: false, error: "IPC 未连接" });
        return;
      }
      var seq = state.seq++;
      state.pdfPending[seq] = {
        resolve: resolve,
        timer: setTimeout(function () {
          if (state.pdfPending[seq]) {
            delete state.pdfPending[seq];
            // Large PDFs can take far longer than 20 s in PDF Kit (parse +
            // save + swap). Timing out early used to fire a second write while
            // the first was still running, which stacked annotations.
            resolve({ ok: false, error: "写入超时（90s，后台可能仍在写，请勿重复触发）" });
          }
        }, 90000)
      };
      var ok = sendAction({
        action: "pdfInk",
        seq: seq,
        rel: rel,
        vaultRoot: vaultRoot,
        path: abs,
        page: page,
        inkMode: mode || "vector",
        inkStyle: style || state.pdfStyle,
        replace: replace === true,
        removeIds: removeIds || [],
        strokes: strokes
      });
      if (!ok) {
        delete state.pdfPending[seq];
        resolve({ ok: false, error: "IPC 发送失败" });
      }
    });
  }

  function markPdfPageDirty(surface, space) {
    if (!surface || surface.kind !== "pdf") return;
    var m = /^pdf:(\d+)$/.exec(String(space || ""));
    if (!m) return;
    var doc = docFor(surface);
    var key = (doc ? doc.target : "?") + "|pdf:" + m[1];
    state.pdfDirty[key] = { surface: surface, page: parseInt(m[1], 10) };
  }

  function pdfDirtyPages(surface) {
    var doc = docFor(surface);
    var target = doc ? doc.target : "?";
    var set = {};
    for (var key in state.pdfDirty) {
      if (!Object.prototype.hasOwnProperty.call(state.pdfDirty, key)) continue;
      var ent = state.pdfDirty[key];
      if (!ent) continue;
      if (key.indexOf(target + "|") !== 0) continue;
      if (ent.surface && ent.surface.doc !== doc) continue;
      set[ent.page] = 1;
    }
    if (doc && doc.strokes) {
      for (var i = 0; i < doc.strokes.length; i++) {
        var st = doc.strokes[i];
        if (st.written === false && /^pdf:\d+$/.test(String(st.space || ""))) {
          set[parseInt(String(st.space).slice(4), 10)] = 1;
        }
      }
    }
    var pages = [];
    for (var p in set) if (Object.prototype.hasOwnProperty.call(set, p)) pages.push(parseInt(p, 10));
    pages.sort(function (a, b) { return a - b; });
    return pages;
  }

  async function inkWritePdfAll(surface) {
    if (state.pdfFlushRunning) return;
    var pages = pdfDirtyPages(surface);
    if (!pages.length) return;
    state.pdfFlushRunning = true;
    try {
      for (var i = 0; i < pages.length; i++) {
        var ok = await inkWritePdf(surface, true, pages[i]);
        if (ok === false) break;
      }
    } finally {
      state.pdfFlushRunning = false;
    }
  }

  async function inkWritePdf(surface, auto, pageOverride) {
    var s = surface || state.activeSurface || activeSurfaceNow();
    var isPdf = s && s.kind === "pdf";
    var isDom = s && s.kind === "pdfembed" && s.pdfDom;
    if (!s || (!isPdf && !isDom)) {
      if (!auto) inkStatus("请先打开一个 PDF");
      return false;
    }
    if (state.pdfInFlight) {
      state.pdfAutoDirty = true;
      return false;
    }
    var file = s.leaf && s.leaf.view ? s.leaf.view.file : null;
    if (!file) return false;
    var ad = adapter();
    if (!ad || typeof ad.getFullPath !== "function") return false;
    var abs = "";
    var vaultRoot = "";
    try { abs = ad.getFullPath(file.path); } catch (e) { abs = ""; }
    try {
      if (typeof ad.getBasePath === "function") vaultRoot = ad.getBasePath();
      else vaultRoot = ad.getFullPath("");
    } catch (e2) { vaultRoot = ""; }
    if (!abs || !vaultRoot) return false;
    var page = -1;
    var space = "";
    if (isPdf) {
      if (typeof pageOverride === "number" && pageOverride >= 0) {
        page = Math.floor(pageOverride);
      } else {
        var cur = -1;
        try {
          if (s.currentSpace && s.currentSpace.indexOf("pdf:") === 0) {
            cur = parseInt(s.currentSpace.slice(4), 10);
          }
        } catch (eCur) {}
        if (!(cur >= 0) && s.viewer && s.viewer.currentPageNumber > 0) {
          cur = s.viewer.currentPageNumber - 1;
        }
        page = cur;
      }
      space = "pdf:" + page;
    } else {
      page = parseInt(s.pageEl.dataset.pageNumber || "1", 10) - 1;
      space = s.space;
    }
    if (!(page >= 0)) return false;
    var doc = docFor(s);
    if (!doc || doc._loading) return false;
    var list = [];
    var removeIds = [];
    var totalPts = 0;
    for (var i = 0; i < doc.strokes.length; i++) {
      var st = doc.strokes[i];
      if (st.space !== space) continue;
      if (st.id) removeIds.push(st.id);
      // Include baked strokes too: replace mode removes the old annotations,
      // so skipping them here would delete ink that is still in the sidecar.
      list.push(st);
      totalPts += st.pts ? st.pts.length : 0;
    }
    if (totalPts > 12000 || list.length > 400) {
      if (!auto) inkStatus("本页墨迹过多，直接写入会超出单条 IPC 限制；请分页或清除后再试", 5000);
      return false;
    }
    var payload = [];
    // PDF.js stores absolute page coordinates (CropBox origin included), and
    // PDF Kit's PdfPoint is also measured in the page's user space (docs say
    // "distance to the left/bottom edge of the page"). Subtracting viewBox[0..1]
    // was wrong for cropped book PDFs: their CropBox is e.g. [84,116,511,726]
    // inside a 595x842 MediaBox, so writing x-84/y-116 shifted every annotation
    // 84 pt left and 116 pt down - the reported "both pen and highlighter jump
    // left-bottom". Keep the values for the probe, but do not subtract them.
    var originX = 0, originY = 0;
    if (isPdf) {
      try {
        var pv0 = s.viewer.getPageView(page);
        var vb0 = pv0 && pv0.viewport && pv0.viewport.viewBox;
        if (vb0) {
          originX = Number(vb0[0]) || 0;
          originY = Number(vb0[1]) || 0;
        }
      } catch (eOrig) {}
    }
    // Annotations are painted in insertion order by most viewers; write the
    // translucent highlighters first so they sit under pen ink there too.
    var ordered = list.slice();
    ordered.sort(function (a, b) {
      return (a.tool === "highlighter" ? 0 : 1) - (b.tool === "highlighter" ? 0 : 1);
    });
    for (var j = 0; j < ordered.length; j++) {
      var st2 = ordered[j];
      var pts = [];
      for (var k = 0; k < st2.pts.length; k++) {
        pts.push([st2.pts[k][0], st2.pts[k][1]]);
      }
      payload.push({
        id: st2.id,
        pts: pts,
        // PDF Kit documents lineColor as 0xBBGGRR (0xFF0000 is blue), while
        // the sidecar stores CSS #RRGGBB. Sending RGB directly made a yellow
        // highlighter come back as a blue stroke after write-back.
        color: hexToPdfColor(st2.color),
        width: st2.width,
        opacity: st2.opacity,
        // Highlighter goes to PDF as a /Highlight quad strip, not a thin
        // polyline: the quad width is the same PDF-space width the overlay
        // uses, so the two agree exactly.
        tool: st2.tool || "pen"
      });
    }
    var sample = [];
    for (var si = 0; si < list.length && si < 3; si++) {
      var ss = list[si];
      sample.push({
        id: ss.id,
        n: ss.pts ? ss.pts.length : 0,
        first: ss.pts && ss.pts[0] ? [ss.pts[0][0], ss.pts[0][1]] : null,
        last: ss.pts && ss.pts.length ? [ss.pts[ss.pts.length - 1][0], ss.pts[ss.pts.length - 1][1]] : null,
        bbox: ss.bbox || null,
        width: ss.width,
        color: ss.color
      });
    }
    var toolCount = {};
    for (var tj = 0; tj < list.length; tj++) {
      var tName = list[tj].tool || "pen";
      toolCount[tName] = (toolCount[tName] || 0) + 1;
    }
    probeHook("pdfPayload", {
      page: page,
      mode: isDom ? "normalized" : "vector",
      style: state.pdfStyle,
      strokes: list.length,
      hl: toolCount.highlighter || 0,
      tools: toolCount,
      originX: Math.round(originX * 100) / 100,
      originY: Math.round(originY * 100) / 100,
      pts: totalPts,
      sample: sample
    });
    var writeT0 = nowMs();
    probeHook("pdfWriteStart", {
      page: page,
      strokes: list.length,
      pts: totalPts,
      style: state.pdfStyle,
      mode: isDom ? "normalized" : "vector",
      when: state.pdfWriteWhen,
      auto: !!auto
    });
    state.pdfInFlight = true;
    state.pdfAutoDirty = false;
    var docGen = isPdf && s ? (s.docGeneration || 0) : -1;
    try {
      var res = await pdfWritePage(file.path, abs, vaultRoot, page,
        payload, isDom ? "normalized" : "vector", true, removeIds, state.pdfStyle);
      probeHook("pdfWriteEnd", {
        page: page,
        ms: Math.round(nowMs() - writeT0),
        ok: !!(res && res.ok),
        error: res && res.error ? String(res.error).slice(0, 200) : "",
        bytes: res && res.bytes ? res.bytes : 0,
        backup: res && res.backup ? res.backup : "",
        style: state.pdfStyle
      });
      if (res && res.ok) {
        state.lastPdfWriteAt = Date.now();
        state.pdfWriteCount++;
      }
      if (!res || !res.ok) {
        if (!auto) notice("写入 PDF 失败：" + ((res && res.error) || "未知错误"), 7000);
        else {
          state.pdfAutoFail = (state.pdfAutoFail || 0) + 1;
          if (state.pdfAutoFail <= 2) inkStatus("PDF 自动写入失败：" + ((res && res.error) || "未知错误"), 4500);
        }
        return false;
      }
      state.pdfAutoFail = 0;
      if (res.backup) state.pdfBackup = res.backup;
      for (var q = 0; q < list.length; q++) {
        list[q].written = true;
        // The stroke now exists in the PDF annotation layer. The overlay can
        // stop drawing it (highlighter does, to avoid a double translucent
        // coat); pdfembed keeps the overlay because its annotation layer is
        // not guaranteed to be rendered by the host viewer.
        if (isPdf) {
          list[q].baked = true;
          if (list[q].tool === "highlighter") list[q].pdfHl = true;
        }
      }
      try { delete state.pdfDirty[doc.target + "|pdf:" + page]; } catch (eD) {}
      await saveDoc(doc);
      if (isPdf && s && (s.docGeneration || 0) === docGen) {
        // The file on disk changed but pdf.js still holds the old annotation
        // layer. Keep the overlay copy visible until the document reloads;
        // hiding it now would make a freshly written highlighter disappear.
        s.annotationFresh = false;
      }
      if (!auto) inkStatus("已写入 PDF 第 " + (page + 1) + " 页；原始文件已备份", 4500);
      else inkStatus("已直接写入 PDF 第 " + (page + 1) + " 页（原文件已备份）", 1800);
      return true;
    } catch (eW) {
      if (!auto) notice("写入 PDF 异常：" + ((eW && eW.message) || eW), 6000);
      return false;
    } finally {
      state.pdfInFlight = false;
      if (state.pdfAutoDirty) {
        state.pdfAutoDirty = false;
        schedulePdfWrite(s);
      }
    }
  }

  function schedulePdfWrite(surface) {
    var autoOn = pref("inkPdfAuto", true);
    if (autoOn === false || autoOn === "0" || autoOn === "false") return;
    if (state.pdfWriteWhen === "manual") return;
    if (!surface) return;
    var isPdf = surface.kind === "pdf";
    var isDom = surface.kind === "pdfembed" && surface.pdfDom;
    if (!isPdf && !isDom) return;
    if (state.pdfWriteWhen === "leave") {
      // Replacing the file while Obsidian has the PDF open triggers a full
      // reload (white frame, re-parse). Remember the surface and write it only
      // when the leaf is left or the app goes to the background.
      state.pdfAutoSurface = surface;
      if (state.pdfAutoTimer) {
        clearTimeout(state.pdfAutoTimer);
        state.pdfAutoTimer = 0;
      }
      return;
    }
    var prevSurface = state.pdfAutoSurface;
    if (prevSurface && prevSurface !== surface && state.pdfAutoTimer) {
      clearTimeout(state.pdfAutoTimer);
      state.pdfAutoTimer = 0;
      var prevOk = prevSurface.kind === "pdfembed"
        ? !!(prevSurface.pageEl && prevSurface.pageEl.isConnected)
        : !!(prevSurface.leaf && prevSurface.leaf.view);
      if (prevOk) inkWritePdf(prevSurface, true);
    }
    state.pdfAutoSurface = surface;
    if (state.pdfAutoTimer) clearTimeout(state.pdfAutoTimer);
    state.pdfAutoTimer = setTimeout(function () {
      state.pdfAutoTimer = 0;
      var s2 = state.pdfAutoSurface;
      if (!s2) return;
      if (s2.kind === "pdfembed" && (!s2.pageEl || !s2.pageEl.isConnected)) return;
      if (s2.kind === "pdf" && (!s2.leaf || !s2.leaf.view || !s2.leaf.view.containerEl.isConnected)) return;
      if (state.active) {
        schedulePdfWrite(s2);
        return;
      }
      inkWritePdf(s2, true);
    }, 3000);
  }

  function flushPdfWrite() {
    var autoOn = pref("inkPdfAuto", true);
    if (autoOn === false || autoOn === "0" || autoOn === "false") return;
    if (state.pdfWriteWhen === "manual") return;
    if (state.pdfAutoTimer) {
      clearTimeout(state.pdfAutoTimer);
      state.pdfAutoTimer = 0;
    }
    var s = state.pdfAutoSurface;
    if (!s) return;
    if (s.kind === "pdfembed" && (!s.pageEl || !s.pageEl.isConnected)) return;
    if (s.kind === "pdf" && (!s.leaf || !s.leaf.view)) return;
    if (s.kind === "pdf") {
      // Flush every dirty page, not just the page the user happened to leave
      // on. Otherwise ink written on page 3 and paged away from is never
      // persisted until the user returns to page 3.
      try { inkWritePdfAll(s); } catch (eAll) {}
      return;
    }
    inkWritePdf(s, true);
  }

  /**
   * Clear every "this stroke lives in the PDF" flag of a document. Called after
   * "restore original PDF": written/baked/pdfHl describe the annotation layer
   * of the file that was just replaced, and pdfDirtyPages() derives the pages
   * that need a rewrite from written === false, so clearing them both brings
   * the ink back on screen and lets the next write rebuild the annotations.
   */
  function resetPdfWrittenFlags(surface) {
    var doc = docFor(surface);
    if (!doc || !doc.strokes) return 0;
    var n = 0;
    for (var i = 0; i < doc.strokes.length; i++) {
      var st = doc.strokes[i];
      if (!st) continue;
      if (st.written !== true && st.baked !== true && st.pdfHl !== true) continue;
      st.written = false;
      st.baked = false;
      st.pdfHl = false;
      n++;
    }
    if (n) {
      try { saveSoon(doc); } catch (eS) {}
    }
    return n;
  }

  function inkRestorePdf(surface) {
    var s = surface || state.activeSurface || activeSurfaceNow();
    if (!s || (s.kind !== "pdf" && !(s.kind === "pdfembed" && s.pdfDom))) {
      inkStatus("请先打开一个 PDF");
      return;
    }
    if (state.pdfInFlight) {
      inkStatus("正在写入 PDF，请稍后再恢复");
      return;
    }
    if (state.pdfAutoTimer) {
      clearTimeout(state.pdfAutoTimer);
      state.pdfAutoTimer = 0;
    }
    state.pdfAutoDirty = false;
    state.pdfAutoSurface = null;
    var file = s.leaf && s.leaf.view ? s.leaf.view.file : null;
    var ad = adapter();
    if (!file || !ad) return;
    var abs = "";
    var root = "";
    try { abs = ad.getFullPath(file.path); } catch (e) {}
    try { root = typeof ad.getBasePath === "function" ? ad.getBasePath() : ad.getFullPath(""); } catch (e2) {}
    if (!abs || !root) return;
    var seq = state.seq++;
    state.pdfPending[seq] = {
      resolve: function (msg) {
        if (msg.ok) {
          // The file is back to the untouched original, so none of this page's
          // ink is inside the PDF any more. The flags used to survive the
          // restore: baked strokes are skipped by the overlay redraw (the
          // highlighter simply vanished) and annotationFresh stayed true with
          // no dirty page, so the write-back never rebuilt the annotations
          // ("restore" also silently destroyed the portable copy) - NF-012.
          var cleared = resetPdfWrittenFlags(s);
          inkStatus("已恢复 PDF 原始备份（PDF 内注释已清除，再次书写会按需重建）", 5000);
          try {
            if (s.leaf.view && typeof s.leaf.view.loadFile === "function") {
              var r = s.leaf.view.loadFile(s.leaf.view.file);
              if (r && typeof r.catch === "function") r.catch(function () {});
            }
          } catch (eR) {}
          setTimeout(function () {
            try { inkRefreshSurfaces(); } catch (eRd) {}
          }, 80);
          probeHook("inkPdfRestore", { cleared: cleared });
        } else {
          notice("恢复失败：" + (msg.error || "未知错误"), 6000);
        }
      },
      timer: setTimeout(function () {
        if (state.pdfPending[seq]) {
          delete state.pdfPending[seq];
          notice("恢复超时", 5000);
        }
      }, 20000)
    };
    var ok = sendAction({
      action: "pdfInkRestore",
      seq: seq,
      rel: file.path,
      vaultRoot: root,
      path: abs
    });
    if (!ok) {
      delete state.pdfPending[seq];
      notice("恢复 IPC 发送失败", 5000);
    }
  }

  // ---------------------------------------------------------------------
  // SVG export
  // ---------------------------------------------------------------------
  function svgPathFor(stroke, surfaceInfo) {
    var pts = [];
    for (var i = 0; i < stroke.pts.length; i++) {
      var p = stroke.pts[i];
      var xy = surfaceInfo.toCanvas(p[0], p[1]);
      if (xy) pts.push({ x: xy[0], y: xy[1], p: p[2] });
    }
    if (!pts.length) return "";
    var sm = smoothPoints(pts);
    var d = "";
    var scale = surfaceInfo.scale || 1;
    if (sm.length === 1) {
      var r = Math.max(0.35, widthFor(stroke, sm[0].p) * scale) / 2;
      return "M" + (sm[0].x - r) + " " + sm[0].y + "a" + r + " " + r + " 0 1 0 " + (2 * r) + " 0a" + r + " " + r + " 0 1 0 " + (-2 * r) + " 0";
    }
    for (var j = 0; j < sm.length - 1; j++) {
      var p0 = sm[j], p1 = sm[j + 1];
      var dx = p1.x - p0.x, dy = p1.y - p0.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.0001) continue;
      var nx = -dy / len, ny = dx / len;
      var w0 = Math.max(0.35, widthFor(stroke, p0.p) * scale) / 2;
      var w1 = Math.max(0.35, widthFor(stroke, p1.p) * scale) / 2;
      d += "M" + (p0.x + nx * w0) + " " + (p0.y + ny * w0) +
        "L" + (p1.x + nx * w1) + " " + (p1.y + ny * w1) +
        "L" + (p1.x - nx * w1) + " " + (p1.y - ny * w1) +
        "L" + (p0.x - nx * w0) + " " + (p0.y - ny * w0) + "Z";
    }
    for (var k = 0; k < sm.length; k++) {
      var rr = Math.max(0.35, widthFor(stroke, sm[k].p) * scale) / 2;
      d += "M" + (sm[k].x - rr) + " " + sm[k].y +
        "a" + rr + " " + rr + " 0 1 0 " + (2 * rr) + " 0a" + rr + " " + rr + " 0 1 0 " + (-2 * rr) + " 0";
    }
    return d;
  }

  async function inkExportSvg(surface) {
    var s = surface || activeSurfaceNow();
    if (!s) {
      inkStatus("当前视图没有手写层");
      return;
    }
    var doc = docFor(s);
    if (!doc) return;
    var ad = adapter();
    if (!ad) return;
    await ensureDirs();
    var file = s.leaf.view.file;
    var base = safeName(file.path);
    var parts = [];
    var width = 0, height = 0;
    if (s.kind === "markdown") {
      var r = s.sizer.getBoundingClientRect();
      width = s.sizer.scrollWidth || r.width;
      height = s.sizer.scrollHeight || r.height;
      for (var i = 0; i < doc.strokes.length; i++) {
        var st = doc.strokes[i];
        if (st.space !== "md:abs") continue;
        var d = svgPathFor(st, { toCanvas: function (x, y) { return [x, y]; }, scale: 1 });
        if (d) parts.push('<path d="' + d + '" fill="' + st.color + '" fill-opacity="' + (st.tool === "highlighter" ? st.opacity : 1) + '"/>');
      }
    } else if (s.kind === "canvas") {
      inkStatus("Canvas 墨迹随 .canvas 侧车保存；暂不支持导出 SVG");
      return;
    } else if (s.kind === "pdfembed") {
      inkStatus("内嵌 PDF 墨迹随笔记侧车保存；暂不支持导出 SVG");
      return;
    } else {
      var pageIdx = parseInt((s.currentSpace || "pdf:0").slice(4), 10) || 0;
      var entry = s.pages[pageIdx];
      if (!entry) {
        inkStatus("请先翻到要导出的页");
        return;
      }
      width = entry.w;
      height = entry.h;
      for (var j = 0; j < doc.strokes.length; j++) {
        var st2 = doc.strokes[j];
        if (st2.space !== entry.space) continue;
        var d2 = svgPathFor(st2, {
          toCanvas: function (e, vp) {
            return function (x, y) {
              try {
                var p = vp.convertToViewportPoint(x, y);
                return [p[0], p[1]];
              } catch (err) {
                return [x, y];
              }
            };
          }(entry, entry.viewport),
          scale: entry.viewport.scale || 1
        });
        if (d2) parts.push('<path d="' + d2 + '" fill="' + st2.color + '" fill-opacity="' + (st2.tool === "highlighter" ? st2.opacity : 1) + '"/>');
      }
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(width) + '" height="' +
      Math.round(height) + '" viewBox="0 0 ' + width + " " + height + '">' + parts.join("") + "</svg>";
    var dest = EXPORTS + "/" + base + "-" + Date.now().toString(36) + ".svg";
    try {
      await ad.write(dest + ".tmp", svg);
      await ad.rename(dest + ".tmp", dest);
      inkStatus("已导出 " + dest, 5000);
    } catch (e) {
      notice("导出失败：" + (e && e.message));
    }
  }

  // ---------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var css = [
      // Quiet by default: a single muted nib at the page edge; the tool bar
      // only exists while the user asked for it.
      "#" + TOOLBAR_ID + "{position:fixed;right:14px;bottom:calc(var(--keyboard-height,0px) + var(--safe-area-inset-bottom,0px) + 64px);" +
        "z-index:60;display:flex;align-items:flex-end;flex-direction:row-reverse;gap:8px;pointer-events:none;" +
        "font-size:14px;user-select:none;touch-action:none;transition:opacity .12s ease}",
      "#" + TOOLBAR_ID + "[data-pos=bl]{left:14px;right:auto;flex-direction:row}",
      "#" + TOOLBAR_ID + ".is-hidden{display:none}",
      "#" + TOOLBAR_ID + ".is-writing{opacity:0;pointer-events:none}",
      "#" + TOOLBAR_ID + ".ohsidian-ink-mobile{bottom:calc(var(--keyboard-height,0px) + var(--safe-area-inset-bottom,0px) + 68px)}",
      "#" + TOOLBAR_ID + " .ohsidian-ink-nib{pointer-events:auto;width:44px;height:44px;padding:0;border-radius:50%;" +
        "border:1px solid var(--background-modifier-border);background:var(--background-secondary);" +
        "color:var(--text-muted);opacity:.72;font-size:20px;line-height:42px;cursor:pointer;box-shadow:var(--shadow-s,0 1px 3px rgba(0,0,0,.12));" +
        "display:flex;align-items:center;justify-content:center;transition:opacity .15s ease,color .15s ease}",
      "#" + TOOLBAR_ID + " .ohsidian-ink-nib:hover{opacity:1;color:var(--text-normal)}",
      "#" + TOOLBAR_ID + " .ohsidian-ink-nib svg{width:22px;height:22px}",
      "#" + TOOLBAR_ID + " .ohsidian-ink-bar{pointer-events:auto;display:flex;align-items:center;gap:3px;" +
        "padding:5px 7px;border-radius:999px;background:var(--background-secondary);" +
        "border:1px solid var(--background-modifier-border);box-shadow:var(--shadow-s,0 1px 3px rgba(0,0,0,.12));opacity:.97;" +
        "max-width:calc(100vw - 76px);overflow-x:auto;touch-action:pan-x;scrollbar-width:none}",
      "#" + TOOLBAR_ID + ".is-collapsed .ohsidian-ink-bar{display:none}",
      "#" + TOOLBAR_ID + " button{min-width:40px;height:40px;padding:0;border:0;border-radius:20px;" +
        "background:transparent;color:var(--text-muted);cursor:pointer;font-size:19px;line-height:40px;" +
        "display:inline-flex;align-items:center;justify-content:center}",
      "#" + TOOLBAR_ID + " button svg{width:21px;height:21px}",
      "#" + TOOLBAR_ID + " button:hover{color:var(--text-normal);background:var(--background-modifier-hover)}",
      "#" + TOOLBAR_ID + " button.is-active{color:var(--interactive-accent);box-shadow:inset 0 0 0 1.5px var(--interactive-accent)}",
      "#" + TOOLBAR_ID + " .ink-sep{width:1px;height:22px;background:var(--background-modifier-border);margin:0 3px;flex:none}",
      "#" + TOOLBAR_ID + " .ink-swatch{width:24px;height:24px;border-radius:12px;border:1px solid var(--background-modifier-border);cursor:pointer;flex:none}",
      "#" + TOOLBAR_ID + " .ink-swatch.is-active{box-shadow:0 0 0 2.5px var(--interactive-accent)}",
      "#" + TOOLBAR_ID + " .ink-color-btn{position:relative;width:34px;height:34px;flex:none;border-radius:50%;" +
        "display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:none}",
      "#" + TOOLBAR_ID + " .ink-color-btn:hover{background:var(--background-modifier-hover)}",
      "#" + TOOLBAR_ID + " .ink-color-dot{width:22px;height:22px;border-radius:50%;" +
        "border:1px solid color-mix(in srgb,var(--text-normal) 22%,transparent);box-sizing:border-box}",
      "#" + TOOLBAR_ID + " .ink-color-badge{position:absolute;right:1px;bottom:1px;font-size:8px;line-height:11px;" +
        "padding:0 2px;border-radius:5px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);" +
        "color:var(--text-muted);pointer-events:none}",
      "#" + TOOLBAR_ID + " input[type=range]{width:84px;height:26px;flex:none}",
      "#" + TOOLBAR_ID + " .ink-badge{font-size:11px;color:var(--text-faint);padding:0 5px;max-width:84px;" +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}",
      "#ohsidian-ink-toast{position:absolute;right:0;bottom:52px;max-width:280px;padding:5px 10px;border-radius:7px;" +
        "background:var(--background-secondary);border:1px solid var(--background-modifier-border);" +
        "color:var(--text-muted);font-size:12px;line-height:18px;opacity:0;transform:translateY(2px);" +
        "transition:opacity .12s ease,transform .12s ease;pointer-events:none;white-space:nowrap;" +
        "overflow:hidden;text-overflow:ellipsis}",
      "#" + TOOLBAR_ID + "[data-pos=bl] #ohsidian-ink-toast{right:auto;left:0}",
      "#ohsidian-ink-toast.is-visible{opacity:.96;transform:none}",
      "#" + CLEAR_ID + "{position:fixed;right:14px;bottom:calc(var(--keyboard-height,0px) + var(--safe-area-inset-bottom,0px) + 124px);" +
        "z-index:70;display:none;width:168px;padding:9px 10px 8px;border-radius:11px;" +
        "background:var(--background-secondary);border:1px solid var(--background-modifier-border);" +
        "box-shadow:var(--shadow-s,0 2px 10px rgba(0,0,0,.16));color:var(--text-normal)}",
      "#" + CLEAR_ID + "[data-pos=bl]{left:14px;right:auto}",
      "#" + CLEAR_ID + " .ink-clear-title{font-size:12px;line-height:17px;color:var(--text-muted);margin-bottom:5px}",
      "#" + CLEAR_ID + " .ink-clear-track{position:relative;width:100%;height:26px;margin:2px 0 0;border-radius:13px;" +
        "background:var(--background-modifier-border);overflow:hidden;touch-action:none}",
      "#" + CLEAR_ID + " .ink-clear-fill{position:absolute;left:0;top:0;bottom:0;width:0%;" +
        "background:var(--interactive-accent);opacity:.35;pointer-events:none}",
      "#" + CLEAR_ID + " .ink-clear-thumb{position:absolute;left:0;top:2px;width:22px;height:22px;margin-left:-11px;" +
        "border-radius:50%;background:var(--interactive-accent);box-shadow:0 1px 3px rgba(0,0,0,.2);pointer-events:none}",
      "#" + CLEAR_ID + " .ink-clear-hint{font-size:11px;line-height:16px;color:var(--text-faint);margin-top:3px}",
      "#" + MENU_ID + "{position:fixed;right:14px;bottom:calc(var(--keyboard-height,0px) + 124px);z-index:65;" +
        "display:none;flex-direction:column;min-width:210px;padding:6px;border-radius:11px;" +
        "background:var(--background-secondary);border:1px solid var(--background-modifier-border);" +
        "box-shadow:var(--shadow-s,0 2px 10px rgba(0,0,0,.16))}",
      "#" + MENU_ID + "[data-pos=bl]{left:14px;right:auto}",
      "#" + MENU_ID + ".ohsidian-ink-mobile{bottom:calc(var(--keyboard-height,0px) + 124px)}",
      "#" + MENU_ID + ".is-open{display:flex}",
      "#" + MENU_ID + " button{min-height:42px;text-align:left;padding:9px 11px;border:0;border-radius:8px;background:transparent;" +
        "color:var(--text-normal);cursor:pointer;font-size:14px;line-height:22px}",
      "#" + MENU_ID + " button:hover{background:var(--background-modifier-hover)}",
      "canvas.ohsidian-ink-base,canvas.ohsidian-ink-live{position:absolute;left:0;top:0;pointer-events:none}",
      "canvas.ohsidian-ink-base{z-index:5}canvas.ohsidian-ink-live{z-index:6}",
      "canvas.ohsidian-ink-pdf{position:absolute;left:0;top:0;pointer-events:none;z-index:4}",
      "#" + TOOLBAR_ID + " .ohsidian-ink-nib,#" + TOOLBAR_ID + " .ohsidian-ink-bar," +
        "#" + TOOLBAR_ID + " button,#" + TOOLBAR_ID + " .ink-swatch{touch-action:none}",
      "body.ohsidian-ink-pen{cursor:crosshair}",
      "#" + TOOLBAR_ID + ".is-glass .ohsidian-ink-bar,#" + TOOLBAR_ID + ".is-glass .ohsidian-ink-nib," +
        "#" + MENU_ID + ".is-glass,#" + CLEAR_ID + ".is-glass{" +
        "background:color-mix(in srgb,var(--background-secondary) 72%,transparent);" +
        "backdrop-filter:blur(18px) saturate(1.25);-webkit-backdrop-filter:blur(18px) saturate(1.25)}",
      "body.ohsidian-ink-reduce-motion #" + TOOLBAR_ID + " *,body.ohsidian-ink-reduce-motion #" + MENU_ID + " *," +
        "body.ohsidian-ink-reduce-motion #" + CLEAR_ID + " *{transition:none!important;animation:none!important}",
      "#" + LASSO_ID + "{position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:58}",
      "#" + SEL_ID + "{position:fixed;border:1.5px dashed #4a90e2;background:rgba(74,144,226,.08);" +
        "border-radius:3px;z-index:59;pointer-events:none;display:none}",
      "#" + SELBAR_ID + "{position:fixed;z-index:61;display:none;gap:5px;padding:4px;" +
        "border-radius:9px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);" +
        "box-shadow:var(--shadow-s,0 1px 3px rgba(0,0,0,.14))}",
      "#" + SELBAR_ID + " button{pointer-events:auto;border:0;border-radius:6px;background:var(--background-modifier-hover);" +
        "color:var(--text-normal);font-size:12px;padding:5px 9px;min-width:38px;touch-action:manipulation}",
      "#" + SELBAR_ID + " button.is-danger{color:var(--text-error,#d33)}"
    ].join("\n");
    var el = document.createElement("style");
    el.id = CSS_ID;
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  function toolbarEl() {
    return document.getElementById(TOOLBAR_ID);
  }

  function inkIcon(name) {
    var paths = {
      pointer: '<path d="M4 3l7.5 17 2.2-6.3L20 11.5 4 3z"/>',
      pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/>',
      highlighter: '<path d="M9 11l-5 5v4h4l5-5"/><path d="M14 4l6 6-4 4-6-6 4-4z"/>',
      eraser: '<path d="M7 21h13"/><path d="M5 15l6-6 5 5-6 6H6l-1-5z"/>',
      shape: '<path d="M12 4l8 15H4L12 4z"/><path d="M8.5 14h7"/>',
      lasso: '<path d="M4 15c0-6 4-9 8-9s8 3 8 7-3 6-7 6c-2 0-4-.6-5.2-1.4"/><path d="M8 19.5c-2-.6-3-2-3-3.5"/>',
      undo: '<path d="M9 14l-4-4 4-4"/><path d="M5 10h9a5 5 0 010 10h-3"/>',
      redo: '<path d="M15 14l4-4-4-4"/><path d="M19 10h-9a5 5 0 000 10h3"/>',
      more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
      collapse: '<path d="M9 18l6-6-6-6"/>',
      nib: '<path d="M12 2l5 9-5 11-5-11 5-9z"/><path d="M12 9v6"/>'
    };
    var body = paths[name] || paths.pen;
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  /**
   * Long-press without breaking the normal click. The element's click handler
   * must check `el._inkLongPress` and skip the action after a long press.
   */
  function inkBindLongPress(el, fn, delay) {
    var timer = 0;
    var sx = 0;
    var sy = 0;
    var stop = function () {
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
    };
    el.addEventListener("pointerdown", function (e) {
      el._inkLongPress = false;
      sx = e.clientX;
      sy = e.clientY;
      stop();
      timer = setTimeout(function () {
        timer = 0;
        el._inkLongPress = true;
        try { fn(e); } catch (e1) {}
      }, delay || 560);
    }, true);
    el.addEventListener("pointermove", function (e) {
      if (!timer) return;
      var dx = e.clientX - sx;
      var dy = e.clientY - sy;
      if (dx * dx + dy * dy > 100) stop();
    }, true);
    var cancel = function () { stop(); };
    el.addEventListener("pointerup", cancel, true);
    el.addEventListener("pointercancel", cancel, true);
    el.addEventListener("pointerleave", cancel, true);
  }

  function inkBindTap(el, fn) {
    var last = 0;
    el.addEventListener("pointerdown", function (e) {
      el._inkDown = true;
      el._inkMoved = false;
      el._inkX = e.clientX;
      el._inkY = e.clientY;
      try { e.stopPropagation(); } catch (e1) {}
    }, true);
    el.addEventListener("pointermove", function (e) {
      if (!el._inkDown) return;
      var dx = e.clientX - (el._inkX || 0);
      var dy = e.clientY - (el._inkY || 0);
      if (dx * dx + dy * dy > 64) {
        el._inkMoved = true;
        // Suppress the synthetic click that follows a drag that started on a
        // control. Without this, a horizontal pen stroke starting on the nib
        // or toolbar toggled the control instead of doing nothing.
        last = Date.now();
      }
    }, true);
    el.addEventListener("pointerup", function (e) {
      if (!el._inkDown) return;
      el._inkDown = false;
      if (el._inkMoved) {
        el._inkMoved = false;
        last = Date.now();
        return;
      }
      el._inkMoved = false;
      if (e.pointerType === "mouse") return;
      // Pen/touch: do not wait for the synthetic click. On the HarmonyOS
      // web engine a pen tap can occasionally lose the click when the DOM
      // changes between down and up; firing on pointerup makes the control
      // deterministic, and the click below is suppressed.
      last = Date.now();
      try { e.preventDefault(); } catch (e1) {}
      try { fn(e); } catch (e2) {}
    }, true);
    el.addEventListener("pointercancel", function () {
      el._inkDown = false;
      el._inkMoved = false;
    }, true);
    el.addEventListener("click", function (e) {
      if (Date.now() - last < 600) return;
      try { e.preventDefault(); e.stopPropagation(); } catch (e1) {}
      try { fn(e); } catch (e2) {}
    });
  }

  function clearPanelEl() {
    var el = document.getElementById(CLEAR_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = CLEAR_ID;
    el.innerHTML =
      '<div class="ink-clear-title">滑动清除本页墨迹</div>' +
      '<div class="ink-clear-track" role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="滑动清除本页">' +
      '<div class="ink-clear-fill"></div><div class="ink-clear-thumb"></div></div>' +
      '<div class="ink-clear-hint">向右滑到底并松手</div>';
    document.body.appendChild(el);
    var track = el.querySelector(".ink-clear-track");
    var fill = el.querySelector(".ink-clear-fill");
    var thumb = el.querySelector(".ink-clear-thumb");
    var dragging = false;
    var raf = 0;
    var pendingX = 0;
    var apply = function () {
      raf = 0;
      var r = track.getBoundingClientRect();
      var pct = Math.max(0, Math.min(1, (pendingX - r.left) / Math.max(1, r.width)));
      el._pct = pct;
      if (fill) fill.style.width = (pct * 100) + "%";
      if (thumb) thumb.style.left = (pct * 100) + "%";
      track.setAttribute("aria-valuenow", String(Math.round(pct * 100)));
      if (el._cleared) return;
      var hint = el.querySelector(".ink-clear-hint");
      if (pct >= 0.9) {
        el._cleared = true;
        if (hint) hint.textContent = "已清除本页";
        var s = state.activeSurface || activeSurfaceNow();
        if (s && inkClearSpace(s)) inkStatus("已清除本页墨迹");
        else if (hint) hint.textContent = "当前没有可清除的墨迹";
        setTimeout(hideClearPanel, 520);
      } else if (hint) {
        hint.textContent = pct > 0 ? "继续向右滑到底" : "向右滑到底并松手";
      }
    };
    var schedule = function (x) {
      pendingX = x;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    track.addEventListener("pointerdown", function (e) {
      if (el._cleared) return;
      dragging = true;
      try { track.setPointerCapture(e.pointerId); } catch (e1) {}
      schedule(e.clientX);
      try { e.preventDefault(); e.stopPropagation(); } catch (e2) {}
    }, true);
    track.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      schedule(e.clientX);
      try { e.preventDefault(); e.stopPropagation(); } catch (e1) {}
    }, true);
    var endDrag = function (e) {
      if (!dragging) return;
      dragging = false;
      try { track.releasePointerCapture(e.pointerId); } catch (e1) {}
      schedule(e.clientX);
    };
    track.addEventListener("pointerup", endDrag, true);
    track.addEventListener("pointercancel", function (e) {
      dragging = false;
      try { track.releasePointerCapture(e.pointerId); } catch (e1) {}
    }, true);
    window.addEventListener("pointerdown", function (e) {
      var p = document.getElementById(CLEAR_ID);
      if (!p || p.style.display === "none") return;
      if (Date.now() - (p._openedAt || 0) < 150) return;
      if (e.target && (e.target.closest("#" + CLEAR_ID) ||
        e.target.closest("#" + TOOLBAR_ID))) return;
      hideClearPanel();
    }, true);
    return el;
  }

  function showClearPanel() {
    var el = clearPanelEl();
    var hint = el.querySelector(".ink-clear-hint");
    var fill = el.querySelector(".ink-clear-fill");
    var thumb = el.querySelector(".ink-clear-thumb");
    var track = el.querySelector(".ink-clear-track");
    el._cleared = false;
    el._pct = 0;
    el._openedAt = Date.now();
    el.style.display = "block";
    applyUiEffects();
    // Anchor the popover to the eraser button instead of the far corner.
    try {
      var btn = document.querySelector("#" + TOOLBAR_ID + " button[data-act=eraser]");
      if (btn) {
        var br = btn.getBoundingClientRect();
        var pw = el.offsetWidth || 168;
        var ph = el.offsetHeight || 92;
        var left = Math.max(8, Math.min(br.left + br.width / 2 - pw / 2,
          (window.innerWidth || 1024) - pw - 8));
        var top = br.top - ph - 10;
        if (top < 8) top = br.bottom + 10;
        el.style.left = Math.round(left) + "px";
        el.style.top = Math.round(top) + "px";
        el.style.right = "auto";
        el.style.bottom = "auto";
      }
    } catch (ePos) {}
    if (fill) fill.style.width = "0%";
    if (thumb) thumb.style.left = "0%";
    if (track) track.setAttribute("aria-valuenow", "0");
    if (hint) hint.textContent = "向右滑到底并松手";
    inkStatus("长按/双击橡皮：滑到底清除本页", 2200);
  }

  function hideClearPanel() {
    var el = document.getElementById(CLEAR_ID);
    if (el) el.style.display = "none";
  }

  function hasBarItem(id) {
    return !!(state.barItems && state.barItems.indexOf(id) >= 0);
  }

  function buildToolbar() {
    if (state.toolbarBuilt) return;
    state.toolbarBuilt = true;
    injectCss();
    var root = document.createElement("div");
    root.id = TOOLBAR_ID;
    root.setAttribute("data-pos", state.barPos);
    root.classList.add("is-collapsed");
    root.classList.add("is-hidden");
    var mobileChrome = false;
    try {
      mobileChrome = document.body.classList.contains("is-mobile") ||
        document.body.classList.contains("is-tablet");
    } catch (eMobile) {}
    if (mobileChrome) root.classList.add("ohsidian-ink-mobile");
    // Nib: the only permanent visual event. Quiet, muted, at the page edge.
    var nib = document.createElement("button");
    nib.type = "button";
    nib.className = "ohsidian-ink-nib";
    nib.setAttribute("data-act", "nib");
    nib.setAttribute("aria-label", "手写工具");
    nib.setAttribute("aria-expanded", "false");
    nib.title = "手写";
    nib.innerHTML = inkIcon("nib");
    inkBindTap(nib, function () { onToolbarAction("nib"); });
    var bar = document.createElement("div");
    bar.className = "ohsidian-ink-bar";
    var mkBtn = function (act, label, title, cls) {
      var b = document.createElement("button");
      var lastEraserClick = 0;
      b.setAttribute("data-act", act);
      b.innerHTML = inkIcon(act);
      b.title = title || label;
      b.setAttribute("aria-label", title || label);
      if (cls) b.className = cls;
      b.addEventListener("pointerdown", function (e) {
        // Do NOT preventDefault: on some touch stacks that suppresses the
        // following click and the toolbar goes dead. The window capture
        // already ignores toolbar targets, so stopping propagation is enough.
        try { e.stopPropagation(); } catch (e1) {}
      }, true);
      b.addEventListener("click", function (e) {
        try { e.preventDefault(); e.stopPropagation(); } catch (e1) {}
        if (b._inkLongPress) {
          b._inkLongPress = false;
          return;
        }
        if (act === "eraser") {
          var nowClick = Date.now();
          if (nowClick - lastEraserClick < 340 && nowClick - lastEraserClick > 0) {
            lastEraserClick = 0;
            showClearPanel();
            return;
          }
          lastEraserClick = nowClick;
        }
        onToolbarAction(act);
      });
      if (act === "eraser") inkBindLongPress(b, showClearPanel);
      return b;
    };
    if (hasBarItem("pointer")) bar.appendChild(mkBtn("pointer", "↖", "指针（选择文字/PDF 高亮）"));
    if (hasBarItem("pen")) bar.appendChild(mkBtn("pen", "✎", "笔"));
    if (hasBarItem("highlighter")) bar.appendChild(mkBtn("highlighter", "▤", "高亮笔"));
    if (hasBarItem("shape")) bar.appendChild(mkBtn("shape", "△", "一笔成形（鸿蒙识别）"));
    if (hasBarItem("lasso")) bar.appendChild(mkBtn("lasso", "◌", "套索选择墨迹"));
    if (hasBarItem("eraser")) bar.appendChild(mkBtn("eraser", "⌫", "橡皮（整笔/局部）"));
    if (hasBarItem("undo")) bar.appendChild(mkBtn("undo", "↶", "撤销墨迹"));
    if (hasBarItem("redo")) bar.appendChild(mkBtn("redo", "↷", "重做墨迹"));
    var sep = document.createElement("div");
    sep.className = "ink-sep";
    if (hasBarItem("color") || hasBarItem("width")) bar.appendChild(sep);
    // One colour control instead of a row of swatches: the dot shows the
    // current pen/highlighter colour, a small "A" badge means automatic
    // (theme-following). Tap cycles the three presets; long-press opens the
    // platform colour picker.
    if (hasBarItem("color")) {
      var colorBtn = document.createElement("div");
      colorBtn.className = "ink-color-btn";
      colorBtn.setAttribute("role", "button");
      colorBtn.setAttribute("aria-label", "颜色");
      var colorDot = document.createElement("span");
      colorDot.className = "ink-color-dot";
      var colorBadge = document.createElement("span");
      colorBadge.className = "ink-color-badge";
      colorBadge.textContent = "A";
      colorBtn.appendChild(colorDot);
      colorBtn.appendChild(colorBadge);
      var customInput = document.getElementById("ohsidian-ink-color-input");
      if (!customInput) {
        customInput = document.createElement("input");
        customInput.id = "ohsidian-ink-color-input";
        customInput.type = "color";
        customInput.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0";
        var applyCustom = function () {
          var c = customInput.value;
          if (!c) return;
          if (state.tool === "highlighter") {
            state.hlColor = c;
            setPref("inkHlColor", c);
          } else {
            state.color = c;
            state.colorAuto = false;
            setPref("inkColor", c);
            setPref("inkColorAuto", false);
          }
          updateToolbarState();
        };
        customInput.addEventListener("input", applyCustom);
        customInput.addEventListener("change", applyCustom);
        document.body.appendChild(customInput);
      }
      var openCustom = function () {
        customInput.value = state.tool === "highlighter" ? state.hlColor : state.color;
        try { customInput.click(); } catch (e2) {
          notice("当前系统不支持颜色选择器，请在设置中填写颜色");
        }
      };
      var cycleColor = function () {
        if (colorBtn._inkLongPress) {
          colorBtn._inkLongPress = false;
          return;
        }
        if (state.tool === "highlighter") {
          var hlist = state.hlPalette || ["#ffd54a", "#a5d6a7", "#90caf9"];
          var hi = hlist.indexOf(state.hlColor);
          state.hlColor = hlist[(hi + 1) % hlist.length];
          setPref("inkHlColor", state.hlColor);
        } else if (state.colorAuto) {
          state.colorAuto = false;
          state.color = state.palette[0];
          setPref("inkColor", state.color);
          setPref("inkColorAuto", false);
        } else {
          var ci = state.palette.indexOf(state.color);
          ci++;
          if (ci >= state.palette.length) {
            state.colorAuto = true;
            setPref("inkColorAuto", true);
          } else {
            state.color = state.palette[ci];
            setPref("inkColor", state.color);
            setPref("inkColorAuto", false);
          }
        }
        updateToolbarState();
      };
      inkBindTap(colorBtn, cycleColor);
      inkBindLongPress(colorBtn, openCustom);
      bar.appendChild(colorBtn);
    }
    var widthInput = null;
    if (hasBarItem("width")) {
      widthInput = document.createElement("input");
      widthInput.type = "range";
      widthInput.min = "1";
      widthInput.max = "12";
      widthInput.step = "0.2";
      widthInput.title = "笔宽";
      widthInput.addEventListener("pointerdown", function (e) { e.stopPropagation(); }, true);
      widthInput.addEventListener("input", function () {
        var v = Number(widthInput.value) || 2.4;
        if (state.tool === "highlighter") {
          state.hlWidth = v;
          setPref("inkHlWidth", v);
        } else {
          state.width = v;
          setPref("inkWidth", v);
        }
      });
      bar.appendChild(widthInput);
    }
    bar.appendChild(mkBtn("more", "⋯", "更多：写入 PDF / 导出 / 清空"));
    bar.appendChild(mkBtn("collapse", "»", "收起"));
    var toast = document.createElement("span");
    toast.id = "ohsidian-ink-toast";
    root.appendChild(nib);
    root.appendChild(bar);
    root.appendChild(toast);
    document.body.appendChild(root);
    inkTrace("toolbarBuilt", { pos: state.barPos, mode: state.barMode });

    var menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.setAttribute("data-pos", state.barPos);
    if (mobileChrome) menu.classList.add("ohsidian-ink-mobile");
    var menuItems = [
      ["pdf-write", "写入 PDF（真实注释）"],
      ["export", "导出本页 SVG"],
      ["recolor", "按主题重新着色本页"],
      ["clear", "清空本页墨迹"],
      ["diag", "手写笔诊断"],
      ["settings", "OHSidian 设置 → 手写笔"]
    ];
    // Tools hidden from the bar must stay reachable from this menu.
    var hiddenTools = [];
    if (!hasBarItem("pointer")) hiddenTools.push(["pointer", "指针（手）"]);
    if (!hasBarItem("pen")) hiddenTools.push(["pen", "笔"]);
    if (!hasBarItem("highlighter")) hiddenTools.push(["highlighter", "高亮笔"]);
    if (!hasBarItem("eraser")) hiddenTools.push(["eraser", "橡皮"]);
    if (!hasBarItem("shape")) hiddenTools.push(["shape", "一笔成形 开/关"]);
    if (!hasBarItem("lasso")) hiddenTools.push(["lasso", "套索"]);
    if (!hasBarItem("undo")) hiddenTools.push(["undo", "撤销"]);
    if (!hasBarItem("redo")) hiddenTools.push(["redo", "重做"]);
    menuItems = hiddenTools.concat(menuItems);
    for (var m = 0; m < menuItems.length; m++) {
      (function (it) {
        var b = document.createElement("button");
        b.setAttribute("data-act", it[0]);
        b.textContent = it[1];
        inkBindTap(b, function () {
          closeMenu();
          onToolbarAction(it[0]);
        });
        menu.appendChild(b);
      })(menuItems[m]);
    }
    document.body.appendChild(menu);
    applyUiEffects();
  }

  function applyUiEffects() {
    try {
      var root = toolbarEl();
      var menu = document.getElementById(MENU_ID);
      var clear = document.getElementById(CLEAR_ID);
      if (root) root.classList.toggle("is-glass", !!state.glass);
      if (menu) menu.classList.toggle("is-glass", !!state.glass);
      if (clear) clear.classList.toggle("is-glass", !!state.glass);
      document.body.classList.toggle("ohsidian-ink-reduce-motion", !!state.reduceMotion);
    } catch (e) {}
  }

  function rebuildToolbar() {
    try {
      state.menuOpen = false;
      var old = toolbarEl();
      if (old && old.parentNode) old.parentNode.removeChild(old);
      var oldMenu = document.getElementById(MENU_ID);
      if (oldMenu && oldMenu.parentNode) oldMenu.parentNode.removeChild(oldMenu);
      state.toolbarBuilt = false;
      buildToolbar();
      if (state.barExpanded) expandToolbar();
      updateToolbarState();
      updateToolbarVisibility();
      applyUiEffects();
    } catch (e) {
      warn("toolbar rebuild failed", e && e.message);
    }
  }

  function barActuallyVisible() {
    var root = toolbarEl();
    if (!root) return false;
    if (root.classList.contains("is-hidden") || root.classList.contains("is-writing")) return false;
    if (root.classList.contains("is-collapsed")) return false;
    var bar = root.querySelector(".ohsidian-ink-bar");
    if (!bar) return false;
    try {
      var cs = getComputedStyle(bar);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      var r = bar.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    } catch (e) {
      return false;
    }
  }

  function onToolbarAction(act) {
    if (act === "nib") {
      if (barActuallyVisible()) {
        collapseToolbar();
        inkTrace("nib", { expanded: false, tool: state.tool });
        return;
      }
      // Trust actual visibility, not the barExpanded flag: after a lost
      // pointerup or a z-index change the flag can be stale, and the old code
      // made the first nib tap collapse an already-invisible bar.
      expandToolbar();
      // A nib tap means "write": pick the last pen tool. In Live Preview this
      // also switches to reading view through setTool().
      setTool(state.lastPenTool || "pen");
      inkTrace("nib", { expanded: true, tool: state.tool, surface: !!activeSurfaceNow() });
      return;
    }
    if (act === "shape") {
      state.shapeMode = !state.shapeMode;
      setPref("inkShapeMode", state.shapeMode);
      sendShapeMode();
      if (state.shapeMode && state.tool !== "pen") setTool("pen");
      inkStatus(state.shapeMode
        ? (state.shapeSupported ? "一笔成形：画完停顿约半秒" : "一笔成形：本机笔服务不支持")
        : "一笔成形已关闭", 1800);
      updateToolbarState();
      return;
    }
    if (act === "pointer" || act === "pen" || act === "highlighter" || act === "eraser" ||
      act === "lasso") {
      setTool(act);
      if (state.barExpanded) scheduleBarHide();
      return;
    }
    if (act === "undo") { inkUndo(); scheduleBarHide(); return; }
    if (act === "redo") { inkRedo(); scheduleBarHide(); return; }
    if (act === "more") { toggleMenu(); return; }
    if (act === "collapse") { collapseToolbar(); return; }
    if (act === "pdf-write") { inkWritePdf(); return; }
    if (act === "export") { inkExportSvg(); return; }
    if (act === "recolor") { inkRecolorSpace(); return; }
    if (act === "clear") { inkClearSpace(); return; }
    if (act === "diag") { showDiagnostics(); return; }
    if (act === "settings") {
      try {
        state.app.setting.open();
        state.app.setting.openTabById("ohsidian");
      } catch (e) {}
    }
  }

  function setTool(tool) {
    if (!state.enabled) {
      inkStatus("手写笔功能已在设置中关闭");
      return;
    }
    if (state.active && tool !== state.tool) {
      // A tool switch while the nib is down would change nothing for the
      // current stroke but silently turn the next one into an eraser.
      inkTrace("setToolIgnored", { tool: tool, reason: "stroke" });
      return;
    }
    if (tool !== "lasso" && state.selection) clearSelection();
    if (tool !== "pointer" && !activeSurfaceNow()) {
      // Canvas/PDF can mount slightly after the leaf becomes active; retry
      // before falling through to the "no layer" path.
      try { inkRefreshSurfaces(); } catch (eRefresh) {}
    }
    // In Live Preview/editing there is no overlay to draw on. Selecting a pen
    // tool is an explicit "I want to write", so switch to reading view first.
    if (tool !== "pointer" && !activeSurfaceNow()) {
      var leaf = state.app && state.app.workspace ? state.app.workspace.activeLeaf : null;
      var v = leaf && leaf.view;
      var editing = v && v.getViewType && v.getViewType() === "markdown" &&
        v.getMode && v.getMode() !== "preview";
      if (editing && inkRequestReadingMode(tool)) {
        inkTrace("setToolPending", { tool: tool, view: "editing" });
        return;
      }
    }
    state.tool = tool;
    inkToolMode(tool);
    probeHook("inkTool", {
      tool: tool,
      width: Math.round((state.width || 0) * 100) / 100,
      hlWidth: state.hlWidth || 0,
      shape: state.shapeMode === true,
      shapeSupported: state.shapeSupported === true,
      predict: state.predictWanted === true,
      eraserMode: state.eraserMode,
      onlyHl: state.eraserOnlyHl === true
    });
    if (tool !== "pointer" && !activeSurfaceNow()) {
      state.pendingTool = tool;
      inkStatus("手写层准备中…", 1800);
      inkAwaitSurface("setTool");
    }
    if (tool === "pen" || tool === "highlighter") {
      state.lastPenTool = tool;
      setPref("inkLastPenTool", tool);
    }
    if (tool === "pointer") {
      if (state.active) forceReleaseActive(true);
      palmHide();
      clearCursor();
      document.body.classList.remove("ohsidian-ink-pen");
    } else {
      document.body.classList.add("ohsidian-ink-pen");
    }
    updateToolbarState();
    inkTrace("setTool", { tool: tool, surface: !!activeSurfaceNow() });
  }

  function updateToolbarState() {
    var bar = toolbarEl();
    if (!bar) return;
    var btns = bar.querySelectorAll("button[data-act]");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var act = b.getAttribute("data-act");
      var on = (act === state.tool) || (act === "more" && state.menuOpen) ||
        (act === "shape" && state.shapeMode === true);
      if (on) b.classList.add("is-active");
      else b.classList.remove("is-active");
    }
    var colorBtn = bar.querySelector(".ink-color-btn");
    if (colorBtn) {
      var activeColor = state.tool === "highlighter" ? state.hlColor : state.color;
      var activeAuto = state.tool !== "highlighter" && state.colorAuto;
      var dot = colorBtn.querySelector(".ink-color-dot");
      var badge = colorBtn.querySelector(".ink-color-badge");
      if (dot) {
        if (activeAuto) {
          dot.style.background = "linear-gradient(135deg,#1f1f1f 0 48%,#e8e8e8 52% 100%)";
        } else {
          dot.style.background = activeColor;
        }
      }
      if (badge) badge.style.display = activeAuto ? "block" : "none";
      if (activeAuto) colorBtn.classList.add("is-auto");
      else colorBtn.classList.remove("is-auto");
      colorBtn.title = activeAuto
        ? "自动颜色（点按切换，长按自定义）"
        : "颜色 " + activeColor + "（点按切换，长按自定义）";
      colorBtn.setAttribute("aria-label", colorBtn.title);
    }
    var range = bar.querySelector("input[type=range]");
    if (range) {
      if (state.tool === "highlighter") {
        range.max = "32";
        if (document.activeElement !== range) range.value = String(state.hlWidth);
      } else {
        range.max = "12";
        if (document.activeElement !== range) range.value = String(state.width);
      }
    }
    var surface = state.activeSurface;
    if (!surface || (state.activeLeaf && surface.leaf !== state.activeLeaf)) {
      surface = activeSurfaceNow();
    }
    var badge = bar.querySelector(".ink-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "ink-badge";
      var barBox = bar.querySelector(".ohsidian-ink-bar") || bar;
      barBox.appendChild(badge);
    }
    if (surface && surface.kind === "pdf") {
      var pg = null;
      try {
        if (surface.viewer && surface.viewer.currentPageNumber) pg = surface.viewer.currentPageNumber - 1;
      } catch (e) {}
      if (pg === null) {
        if (surface.currentSpace) pg = parseInt(surface.currentSpace.slice(4), 10);
        else {
          var keys = Object.keys(surface.pages);
          pg = keys.length ? parseInt(keys[0], 10) : 0;
        }
      }
      if (pg === null || isNaN(pg)) pg = 0;
      badge.textContent = "PDF p." + (pg + 1);
    } else if (surface && surface.kind === "canvas") {
      badge.textContent = "Canvas";
    } else if (surface && surface.kind === "pdfembed") {
      var pno = 1;
      try { pno = parseInt(surface.pageEl.dataset.pageNumber || "1", 10) || 1; } catch (eP) {}
      badge.textContent = (surface.pdfDom ? "PDF p." : "内嵌 PDF p.") + pno;
    } else if (surface) {
      badge.textContent = "笔记";
    } else if (activeMarkdownLeaf()) {
      // Visible affordance in Live Preview; tapping pen switches to reading.
      badge.textContent = "阅读视图";
    } else {
      badge.textContent = "";
    }
    updateToolbarVisibility();
  }

  function updateToolbarVisibility() {
    var root = toolbarEl();
    if (!root) return;
    root.setAttribute("data-pos", state.barPos);
    try {
      if (document.body.classList.contains("is-mobile") ||
        document.body.classList.contains("is-tablet")) {
        root.classList.add("ohsidian-ink-mobile");
      }
    } catch (eMob) {}
    if (!state.enabled) {
      root.classList.add("is-hidden");
      root.classList.add("is-collapsed");
      return;
    }
    var surface = activeSurfaceNow();
    var show = !!surface || !!activeInkLeaf();
    root.classList.toggle("is-hidden", !show);
    var sig = (show ? "1" : "0") + (state.barExpanded ? "1" : "0") + state.barMode;
    if (sig !== state.lastBarSig) {
      state.lastBarSig = sig;
      inkTrace("toolbar", {
        show: show, expanded: state.barExpanded, mode: state.barMode,
        surface: !!surface, editing: !!activeMarkdownLeaf()      });
    }
    if (!show) {
      collapseToolbar();
      return;
    }
    if (state.barMode === "always") {
      expandToolbar(true);
    } else if (!state.barExpanded) {
      root.classList.add("is-collapsed");
    }
  }

  function clearBarTimer() {
    if (state.barTimer) {
      clearTimeout(state.barTimer);
      state.barTimer = 0;
    }
  }

  function scheduleBarHide() {
    clearBarTimer();
    if (state.barMode !== "auto") return;
    state.barTimer = setTimeout(function () {
      state.barTimer = 0;
      collapseToolbar();
    }, 8000);
  }

  function collapseToolbar() {
    var root = toolbarEl();
    if (!root) return;
    state.barExpanded = false;
    root.classList.add("is-collapsed");
    var nib = root.querySelector(".ohsidian-ink-nib");
    if (nib) nib.setAttribute("aria-expanded", "false");
    clearBarTimer();
    // Close the menu without calling updateToolbarState(): that path leads
    // back into updateToolbarVisibility() and would recurse when the current
    // view has no ink surface.
    var menu = document.getElementById(MENU_ID);
    if (menu) menu.classList.remove("is-open");
    state.menuOpen = false;
  }

  function expandToolbar(noTimer) {
    var root = toolbarEl();
    if (!root) return;
    state.barExpanded = true;
    root.classList.remove("is-collapsed");
    root.classList.remove("is-hidden");
    var nib = root.querySelector(".ohsidian-ink-nib");
    if (nib) nib.setAttribute("aria-expanded", "true");
    if (noTimer || state.barMode === "always") clearBarTimer();
    else scheduleBarHide();
  }

  function toggleMenu() {
    var menu = document.getElementById(MENU_ID);
    if (!menu) return;
    state.menuOpen = !state.menuOpen;
    menu.classList.toggle("is-open", state.menuOpen);
    if (state.menuOpen) scheduleBarHide();
    updateToolbarState();
  }

  function closeMenu() {
    var menu = document.getElementById(MENU_ID);
    if (menu) menu.classList.remove("is-open");
    state.menuOpen = false;
    updateToolbarState();
  }

  function togglePalette() {
    buildToolbar();
    var root = toolbarEl();
    if (!root) return;
    root.classList.remove("is-hidden");
    expandToolbar();
    inkStatus("手写工具");
  }

  /** Hide the chrome while the pen is on the page; restore it on lift. */
  function inkWritingChrome(on) {
    var root = toolbarEl();
    if (!root) return;
    if (state.barMode === "always") {
      root.classList.remove("is-writing");
      return;
    }
    if (on) {
      clearBarTimer();
      root.classList.add("is-writing");
    } else {
      root.classList.remove("is-writing");
      // Compact mode used to keep the bar open after a stroke, so any swipe
      // that produced a quick stroke made the controls pop back. After writing
      // (or a swipe mistaken for one) everything returns to the quiet nib.
      if (state.barMode !== "always") collapseToolbar();
    }
  }

  function showDiagnostics() {
    var lines = diagnosticLines();
    try {
      if (typeof window.ohsidianShowReportModal === "function") {
        window.ohsidianShowReportModal("OHSidian 诊断: 手写笔", lines);
        return;
      }
    } catch (e) {}
    notice(lines.join("\n"), 9000);
    try { console.log(lines.join("\n")); } catch (e2) {}
  }

  function pdfOverlayStats() {
    var out = { canvases: 0, bytes: 0, mounted: 0, dpr: 0 };
    try {
      var list = document.querySelectorAll("canvas.ohsidian-ink-pdf");
      out.canvases = list.length;
      for (var i = 0; i < list.length; i++) {
        var cv = list[i];
        out.bytes += (cv.width || 0) * (cv.height || 0) * 4;
      }
      for (var s = 0; s < state.surfaces.length; s++) {
        var sf = state.surfaces[s];
        if (sf.kind === "pdf") {
          out.mounted += Object.keys(sf.pages || {}).length;
          out.dpr = sf.dpr || out.dpr;
        }
      }
    } catch (e) {}
    return out;
  }

  function diagnosticLines() {
    var pdfStat = pdfOverlayStats();
    var pt = Object.keys(state.pointerTypes || {}).map(function (k) {
      return k + "×" + state.pointerTypes[k];
    }).join(" ");
    var pvals = Object.keys(state.domPressureValues).length;
    var age = state.lastPenAt ? Math.round(nowMs() - state.lastPenAt) + "ms" : "-";
    var gAge = state.lastGestureAt ? Math.round(Date.now() - state.lastGestureAt) + "ms" : "-";
    var surface = activeSurfaceNow();
    var doc = surface ? docFor(surface) : null;
    var pending = 0;
    if (doc && surface.kind === "pdf") {
      for (var i = 0; i < doc.strokes.length; i++) {
        if (!doc.strokes[i].baked && String(doc.strokes[i].space).indexOf("pdf:") === 0) pending++;
      }
    }
    var info = state.stylusInfo;
    var svc = info ? (info.subscribed ? "已订阅" : (info.supported ? "支持未订阅" : "不支持")) : "未知";
    if (info && info.error) svc += "(" + String(info.error).slice(0, 40) + ")";
    var pdfKit = info ? (info.pdf ? "可用" : "不可用") : "未知";
    var d = state.lastPenDetail;
    var detail = d
      ? "type=" + d.type + " p=" + Number(d.p).toFixed(3) + " tilt=" + Math.round(d.tx) + "," + Math.round(d.ty) +
        " button=" + d.button + "/" + d.buttons + " wh=" + Number(d.w).toFixed(1) + "," + Number(d.h).toFixed(1)
      : "未捕获";
    var leafNow = state.app && state.app.workspace ? state.app.workspace.activeLeaf : null;
    var viewNow = leafNow && leafNow.view;
    var viewInfo = (viewNow && viewNow.getViewType ? viewNow.getViewType() : "?") +
      ":" + (viewNow && viewNow.getMode ? viewNow.getMode() : "");
    var barNow = toolbarEl();
    var barInfo = !barNow ? "未建" :
      (barNow.classList && barNow.classList.contains("is-hidden") ? "隐藏" : "显示");
    return [
      "  " + "手写笔".padEnd(8) + "v" + OHSIDIAN_INK_REV + " 点=" + (pt || "?") + " · 压力档=" + pvals +
        " · 模式=" + state.pressureMode + " · 旁路=" + (state.pressureTapOn ? "开" : "关") +
        " · 压感橡皮=" + (state.pressureEraser ? Math.round(state.pressureEraserSens) : "关") +
        " · 一笔成形=" + (state.shapeMode ? "开" : "关") + "/" + (state.shapeEvents) +
        " · 首帧=" + Math.round(state.lastLatency) + "ms · 合帧=" + state.coalescedMax,
      "  " + "橡皮".padEnd(9) + "方式=" + (state.eraserMode === "stroke" ? "整笔" : "局部") +
        " · 仅荧光笔=" + (state.eraserOnlyHl ? "是" : "否") +
        " · 半径=" + Math.round(Number(state.eraserPx) || 12) + "px",
      "  " + "视图".padEnd(9) + viewInfo + " · 工具条=" + barInfo + " · 手写层=" +
        (surface ? surface.kind : "无"),
      "  " + "最近笔".padEnd(9) + detail,
      "  " + "系统".padEnd(10) + "笔服务=" + svc + " · PDFKit=" + pdfKit +
        " · 一笔成形=" + (info && info.shape ? "支持" : "不支持") +
        " · 预测=" + (info && info.predict ? "支持" : "不支持"),
      "  " + "预测".padEnd(9) + (state.predictWanted ? "开" : "关") +
        " · 事件=" + state.predictEvents,
      "  " + "手势".padEnd(10) + "最近=" + (state.lastGesture || "无") + "(" + gAge + ") · 共 " +
        state.gestureCount + " 次",
      "  " + "墨迹".padEnd(10) + "层=" + (surface ? surface.kind : "无") +
        " · 笔数=" + (doc ? doc.strokes.length : 0) + " · 未写回=" + pending,
      "  " + "PDF叠层".padEnd(9) + (state.enabled
        ? pdfStat.canvases + " 张/" + pdfStat.mounted + " 页 · " +
          (pdfStat.bytes / 1048576).toFixed(1) + " MB · dpr " +
          Number(pdfStat.dpr || 0).toFixed(2)
        : "手写笔模式关闭（0 张）"),
      "  " + "PDF写回".padEnd(9) + "时机=" + state.pdfWriteWhen +
        " · 样式=" + state.pdfStyle + " · 次数=" + state.pdfWriteCount +
        " · 上次=" + (state.lastPdfWriteAt
          ? Math.round((Date.now() - state.lastPdfWriteAt) / 1000) + "s前" : "-"),
      "  " + "IPC".padEnd(11) + (state.ipcReady ? "已连接" : "未连接") +
        " · 收 " + state.ipcRecv + " / 发 " + state.ipcSent +
        " · 最近笔事件 " + age
    ];
  }

  // ---------------------------------------------------------------------
  // Settings hook (consumed by touch-mode.js' settings page)
  // ---------------------------------------------------------------------
  function selectEl(ctl, options, value, onChange) {
    var sel = document.createElement("select");
    sel.style.cssText = "min-width:140px;background:var(--background-modifier-form-field);" +
      "color:var(--text-normal);border:1px solid var(--background-modifier-border);border-radius:6px;padding:3px 6px";
    for (var i = 0; i < options.length; i++) {
      var o = document.createElement("option");
      o.value = options[i][0];
      o.textContent = options[i][1];
      if (options[i][0] === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", function () { onChange(sel.value); });
    ctl.appendChild(sel);
  }

  window.__ohsidianInkHooks = {
    buildSettings: function (ctx) {
      try {
        var g = ctx.newGroup("功能");
        ctx.toggleEl(ctx.itemEl(g, "手写笔模式",
          "默认关闭。打开后才显示笔尖/工具条并拦截笔输入；关闭后 OHSidian 完全回到普通 Obsidian。", true),
          pref("inkEnabled", false) === true,
          function (on) {
            state.enabled = !!on;
            setPref("inkEnabled", !!on);
            if (!on) {
              state.tool = "pointer";
              state.barExpanded = false;
              state.lastPenSeen = 0;
              state.penUiSwipe = null;
              state.blockedPointerId = null;
              state.lastToolMode = null;
              if (state.pdfAutoTimer) { clearTimeout(state.pdfAutoTimer); state.pdfAutoTimer = 0; }
              inkToolMode("pointer");
              forceReleaseActive(true);
              palmHide();
              clearCursor();
              try { document.body.classList.remove("ohsidian-ink-pen"); } catch (e) {}
            }
            updateToolbarState();
            updateToolbarVisibility();
            inkRefreshSurfaces();
            try { negotiatePressure(); } catch (eNP) {}
          });
        var barCtl = ctx.itemEl(g, "工具条显示",
          "紧凑：点开后保持，直到再点笔尖；自动：点开后 8 秒收起；常驻：始终展开。");
        selectEl(barCtl, [
          ["compact", "紧凑（默认：点开保持）"],
          ["auto", "自动（点开后 8 秒收起）"],
          ["always", "常驻展开"]
        ], pref("inkBarMode", "compact"), function (v) {
          state.barMode = v;
          setPref("inkBarMode", v);
          if (v === "always") expandToolbar(true);
          else if (!state.barExpanded) collapseToolbar();
          updateToolbarState();
        });
        var posCtl = ctx.itemEl(g, "工具条位置",
          "右下或左下。左手书写建议左下，避免手腕遮挡笔尖落点。");
        selectEl(posCtl, [
          ["br", "右下（默认）"],
          ["bl", "左下"]
        ], pref("inkBarPos", "br"), function (v) {
          state.barPos = v;
          setPref("inkBarPos", v);
          var root = toolbarEl();
          if (root) root.setAttribute("data-pos", v);
          var menu = document.getElementById(MENU_ID);
          if (menu) menu.setAttribute("data-pos", v);
        });
        ctx.toggleEl(ctx.itemEl(g, "安静反馈",
          "常规操作只在笔尖上方显示一行很淡的提示，不弹 Notice；关闭后恢复系统通知。", true),
          pref("inkQuiet", true) !== false,
          function (on) { state.quiet = !!on; setPref("inkQuiet", !!on); });
        var effects = ctx.newGroup("界面效果");
        ctx.toggleEl(ctx.itemEl(effects, "毛玻璃工具条",
          "半透明 + backdrop-filter 模糊。视觉更好，但会增加 GPU/耗电；平板建议关闭。", true),
          pref("inkGlass", false) === true,
          function (on) {
            state.glass = !!on;
            setPref("inkGlass", !!on);
            applyUiEffects();
          });
        ctx.toggleEl(ctx.itemEl(effects, "减少动画",
          "关闭工具条淡入/位移动画，降低持续重绘和功耗（默认开启）。", true),
          pref("inkReduceMotion", true) !== false,
          function (on) {
            state.reduceMotion = !!on;
            setPref("inkReduceMotion", !!on);
            applyUiEffects();
          });
        ctx.toggleEl(ctx.itemEl(g, "笔尖光标",
          "笔悬停时显示一个细圆环（橡皮为擦除半径），落笔后自动消失。", true),
          pref("inkCursor", true) !== false,
          function (on) {
            state.cursorEnabled = !!on;
            setPref("inkCursor", !!on);
            if (!on) clearCursor();
          });
        ctx.toggleEl(ctx.itemEl(g, "书写时屏蔽边缘手势",
          "选中笔/高亮/橡皮时，拦截从左右边缘开始的横向滑动，避免唤出 Obsidian 侧边栏；指针模式不受影响。", true),
          pref("inkBlockEdge", true) !== false,
          function (on) {
            state.blockEdge = !!on;
            setPref("inkBlockEdge", !!on);
            if (!on) edgeTouch = null;
          });

        var barGroup = ctx.newGroup("工具条");
        var barDefs = [
          ["pen", "笔"],
          ["highlighter", "高亮笔"],
          ["eraser", "橡皮"],
          ["color", "颜色按钮"],
          ["pointer", "指针"],
          ["shape", "一笔成形"],
          ["lasso", "套索"],
          ["undo", "撤销"],
          ["redo", "重做"],
          ["width", "笔宽滑杆"]
        ];
        var setBarItem = function (id, on) {
          var items = state.barItems.slice();
          var at = items.indexOf(id);
          if (on && at < 0) items.push(id);
          if (!on && at >= 0) items.splice(at, 1);
          state.barItems = items;
          setPref("inkBarItems", items);
          rebuildToolbar();
        };
        for (var bd = 0; bd < barDefs.length; bd++) {
          (function (id, label) {
            ctx.toggleEl(ctx.itemEl(barGroup, label,
              "显示在工具条上；隐藏后仍可从工具条的 ⋯ 菜单打开。", true),
              state.barItems.indexOf(id) >= 0,
              function (on) { setBarItem(id, !!on); });
          })(barDefs[bd][0], barDefs[bd][1]);
        }

        var input = ctx.newGroup("输入与手势");
        ctx.toggleEl(ctx.itemEl(input, "掌托过滤",
          "笔按下时拦截手掌与手指的触摸，避免书写时滚动或选中文字。", true),
          pref("inkPalm", true) !== false,
          function (on) { state.palm = !!on; setPref("inkPalm", !!on); });
        ctx.toggleEl(ctx.itemEl(input, "允许手指绘制",
          "关闭时手指只用于滚动/缩放；打开后手指也会留下墨迹（不推荐）。", true),
          pref("inkFingerDraw", false) === true,
          function (on) { state.fingerDraw = !!on; setPref("inkFingerDraw", !!on); });
        var ersCtl = ctx.itemEl(input, "橡皮半径",
          "屏幕上的擦除范围（圆环）。长按工具条橡皮按钮会出现“滑到底清除本页”的滑块。");
        var ersInput = document.createElement("input");
        ersInput.type = "range";
        ersInput.min = "6";
        ersInput.max = "32";
        ersInput.step = "1";
        ersInput.value = String(Number(pref("inkEraserPx", 12)) || 12);
        ersInput.style.cssText = "width:120px;height:24px;vertical-align:middle";
        ersInput.addEventListener("input", function () {
          var v = Number(ersInput.value) || 12;
          state.eraserPx = v;
          setPref("inkEraserPx", v);
          if (state.tool === "eraser") clearCursor();
        });
        ersCtl.appendChild(ersInput);
        var erModeCtl = ctx.itemEl(input, "擦除方式",
          "局部擦除按橡皮半径切掉笔迹；整笔擦除碰到哪一笔就删掉整笔（华为笔记的“擦除整个笔划”）。");
        selectEl(erModeCtl, [
          ["partial", "局部擦除（默认）"],
          ["stroke", "整笔擦除"]
        ], state.eraserMode, function (v) {
          state.eraserMode = v === "stroke" ? "stroke" : "partial";
          setPref("inkEraserMode", state.eraserMode);
        });
        ctx.toggleEl(ctx.itemEl(input, "仅擦荧光笔",
          "打开后橡皮只擦高亮笔迹，普通笔迹不受影响。", true),
          state.eraserOnlyHl === true,
          function (on) { state.eraserOnlyHl = !!on; setPref("inkEraserOnlyHl", !!on); });
        var penWidthCtl = ctx.itemEl(input, "笔宽",
          "普通笔的屏幕宽度（CSS px）；不显示工具条滑杆时也可以在这里调。");
        var penWidthInput = document.createElement("input");
        penWidthInput.type = "range";
        penWidthInput.min = "1";
        penWidthInput.max = "12";
        penWidthInput.step = "0.2";
        penWidthInput.value = String(state.width);
        penWidthInput.style.cssText = "width:140px;height:24px;vertical-align:middle";
        penWidthInput.addEventListener("input", function () {
          state.width = Number(penWidthInput.value) || 2.4;
          setPref("inkWidth", state.width);
        });
        penWidthCtl.appendChild(penWidthInput);
        var hlWidthCtl = ctx.itemEl(input, "高亮笔宽度",
          "高亮笔的屏幕宽度（CSS px），不受压力影响。");
        var hlWidthInput = document.createElement("input");
        hlWidthInput.type = "range";
        hlWidthInput.min = "4";
        hlWidthInput.max = "32";
        hlWidthInput.step = "1";
        hlWidthInput.value = String(state.hlWidth);
        hlWidthInput.style.cssText = "width:140px;height:24px;vertical-align:middle";
        hlWidthInput.addEventListener("input", function () {
          state.hlWidth = Number(hlWidthInput.value) || 16;
          setPref("inkHlWidth", state.hlWidth);
        });
        hlWidthCtl.appendChild(hlWidthInput);
        ctx.toggleEl(ctx.itemEl(input, "压感橡皮擦",
          "与华为笔记一致：笔尖用力按住并停顿约半秒，暂时变成橡皮；移动擦除，抬笔继续书写。笔画一旦移动过就不会触发，避免把写完的线条擦掉。", true),
          pref("inkPressureEraser", true) !== false,
          function (on) { state.pressureEraser = !!on; setPref("inkPressureEraser", !!on); });
        var pesCtl = ctx.itemEl(input, "压感橡皮灵敏度",
          "0–100，越高越容易触发（压力门槛更低、等待更短）；越低需要更用力、停得更久。");
        var pesInput = document.createElement("input");
        pesInput.type = "range";
        pesInput.min = "0";
        pesInput.max = "100";
        pesInput.step = "5";
        pesInput.value = String(Number(pref("inkPressureEraserSens", 60)) || 0);
        pesInput.style.cssText = "width:140px;height:24px;vertical-align:middle";
        var pesVal = document.createElement("span");
        pesVal.style.cssText = "margin-left:8px;color:var(--text-muted);font-variant-numeric:tabular-nums";
        pesVal.textContent = pesInput.value;
        pesInput.addEventListener("input", function () {
          var v = clamp(Number(pesInput.value) || 0, 0, 100);
          state.pressureEraserSens = v;
          pesVal.textContent = String(Math.round(v));
          setPref("inkPressureEraserSens", v);
        });
        pesCtl.appendChild(pesInput);
        pesCtl.appendChild(pesVal);
        var dblCtl = ctx.itemEl(input, "笔杆双击",
          "M-Pencil 双击的行为。默认笔 ↔ 橡皮；书写过程中收到的双击会被忽略，避免写到一半突然变成橡皮。如果系统设置里也开了「双击切换」，建议设为「无/应用内」，否则可能双触发。");
        selectEl(dblCtl, [
          ["pen-eraser", "笔 ↔ 橡皮（默认）"],
          ["wake", "唤醒工具条"],
          ["undo", "撤销上一笔"],
          ["palette", "打开工具条/调色盘"],
          ["none", "不响应"]
        ], pref("inkDoubleTap", "pen-eraser"), function (v) { setPref("inkDoubleTap", v); });
        var sqCtl = ctx.itemEl(input, "笔杆轻捏",
          "仅支持轻捏的笔（如 M-Pencil 3）；不支持时不会触发。");
        selectEl(sqCtl, [
          ["palette", "打开工具条/调色盘（默认）"],
          ["pen-eraser", "笔 ↔ 橡皮"],
          ["undo", "撤销上一笔"],
          ["none", "不响应"]
        ], pref("inkSqueeze", "palette"), function (v) { setPref("inkSqueeze", v); });

        var press = ctx.newGroup("压力");
        var prCtl = ctx.itemEl(press, "压力来源",
          "自动：先用引擎给的压力，若发现恒定再向 ArkTS 请求设备采样；强制：总是使用 ArkTS 旁路。");
        selectEl(prCtl, [
          ["auto", "自动（默认）"],
          ["on", "总是使用 ArkTS 采样"],
          ["off", "只用网页事件"]
        ], pref("inkPressureTap", "auto"), function (v) {
          state.pressureTapPref = v;
          setPref("inkPressureTap", v);
          negotiatePressure();
        });

        var presetCtl = ctx.itemEl(press, "曲线预设",
          "线性/柔和/硬朗会同时设置起笔力度与曲线强度；手动调整后变为自定义。");
        var presetSel = document.createElement("select");
        presetSel.style.cssText = "min-width:160px;background:var(--background-modifier-form-field);" +
          "color:var(--text-normal);border:1px solid var(--background-modifier-border);border-radius:6px;padding:4px 7px";
        var presetOpts = [["linear", "线性"], ["soft", "柔和（轻写更粗）"],
          ["hard", "硬朗（需要更大力气）"], ["custom", "自定义"]];
        for (var pi = 0; pi < presetOpts.length; pi++) {
          var po = document.createElement("option");
          po.value = presetOpts[pi][0];
          po.textContent = presetOpts[pi][1];
          presetSel.appendChild(po);
        }
        presetSel.value = (state.curve === "soft" || state.curve === "hard" ||
          state.curve === "custom") ? state.curve : "linear";
        presetCtl.appendChild(presetSel);

        var minCtl = ctx.itemEl(press, "起笔力度",
          "低于此值的压力视为 0，用来消除笔尖刚接触屏幕时的抖动和“毛边”。");
        var minInput = document.createElement("input");
        minInput.type = "range";
        minInput.min = "0";
        minInput.max = "0.5";
        minInput.step = "0.01";
        minInput.value = String(state.pressureMin || 0);
        minInput.style.width = "180px";
        var minVal = document.createElement("span");
        minVal.style.cssText = "margin-left:8px;color:var(--text-muted);font-variant-numeric:tabular-nums";
        minVal.textContent = Math.round((state.pressureMin || 0) * 100) + "%";
        minCtl.appendChild(minInput);
        minCtl.appendChild(minVal);

        var gamCtl = ctx.itemEl(press, "曲线强度",
          "小于 1 更“软”，轻写也会变粗；大于 1 更“硬”，需要更大力气才变粗。");
        var gamInput = document.createElement("input");
        gamInput.type = "range";
        gamInput.min = "0.4";
        gamInput.max = "2.6";
        gamInput.step = "0.02";
        gamInput.value = String(state.pressureGamma || 1);
        gamInput.style.width = "180px";
        var gamVal = document.createElement("span");
        gamVal.style.cssText = "margin-left:8px;color:var(--text-muted);font-variant-numeric:tabular-nums";
        gamVal.textContent = Number(state.pressureGamma || 1).toFixed(2);
        gamCtl.appendChild(gamInput);
        gamCtl.appendChild(gamVal);

        var graphCtl = ctx.itemEl(press, "曲线预览",
          "横轴是笔压力，纵轴是墨迹宽度系数；拖动上面的滑杆会立即更新。");
        var graph = document.createElement("canvas");
        var graphW = 280;
        var graphH = 104;
        var graphDpr = Math.min(window.devicePixelRatio || 1, 2);
        graph.width = Math.round(graphW * graphDpr);
        graph.height = Math.round(graphH * graphDpr);
        graph.style.cssText = "width:" + graphW + "px;height:" + graphH + "px;" +
          "display:block;border:1px solid var(--background-modifier-border);border-radius:8px;" +
          "background:var(--background-primary);margin-top:4px";
        graphCtl.appendChild(graph);

        function drawPressureGraph() {
          try {
            var gx = graph.getContext("2d");
            gx.setTransform(graphDpr, 0, 0, graphDpr, 0, 0);
            gx.clearRect(0, 0, graphW, graphH);
            var cs = getComputedStyle(document.body);
            var faint = (cs.getPropertyValue("--text-faint") || "#888").trim() || "#888";
            var accent = (cs.getPropertyValue("--interactive-accent") || "#7c6cf0").trim() || "#7c6cf0";
            var left = 10, top = 10, right = graphW - 10, bottom = graphH - 12;
            gx.strokeStyle = faint;
            gx.globalAlpha = 0.35;
            gx.lineWidth = 1;
            for (var k = 0; k <= 4; k++) {
              var yy = top + (bottom - top) * k / 4;
              gx.beginPath();
              gx.moveTo(left, yy);
              gx.lineTo(right, yy);
              gx.stroke();
            }
            for (var m = 0; m <= 4; m++) {
              var xx = left + (right - left) * m / 4;
              gx.beginPath();
              gx.moveTo(xx, top);
              gx.lineTo(xx, bottom);
              gx.stroke();
            }
            gx.globalAlpha = 1;
            gx.strokeStyle = accent;
            gx.lineWidth = 2.2;
            gx.beginPath();
            for (var s = 0; s <= 60; s++) {
              var pv = s / 60;
              var out = pressureCurve(pv);
              var px = left + (right - left) * pv;
              var py = bottom - (bottom - top) * out;
              if (s === 0) gx.moveTo(px, py);
              else gx.lineTo(px, py);
            }
            gx.stroke();
            gx.fillStyle = faint;
            gx.globalAlpha = 0.8;
            gx.font = "10px sans-serif";
            gx.fillText("压力 →", right - 42, bottom + 9);
            gx.save();
            gx.translate(left - 2, top + 4);
            gx.rotate(-Math.PI / 2);
            gx.fillText("宽度", -34, 0);
            gx.restore();
            gx.globalAlpha = 1;
          } catch (eG) {}
        }

        function markCustom() {
          state.curve = "custom";
          setPref("inkCurve", "custom");
          presetSel.value = "custom";
        }

        minInput.addEventListener("input", function () {
          state.pressureMin = clamp(Number(minInput.value) || 0, 0, 0.6);
          minVal.textContent = Math.round(state.pressureMin * 100) + "%";
          setPref("inkPressureMin", state.pressureMin);
          markCustom();
          drawPressureGraph();
        });
        gamInput.addEventListener("input", function () {
          state.pressureGamma = clamp(Number(gamInput.value) || 1, 0.4, 2.6);
          gamVal.textContent = state.pressureGamma.toFixed(2);
          setPref("inkPressureGamma", state.pressureGamma);
          markCustom();
          drawPressureGraph();
        });
        presetSel.addEventListener("change", function () {
          var v = presetSel.value;
          if (v === "linear") { state.pressureMin = 0; state.pressureGamma = 1; }
          else if (v === "soft") { state.pressureMin = 0; state.pressureGamma = 0.68; }
          else if (v === "hard") { state.pressureMin = 0.06; state.pressureGamma = 1.45; }
          else { markCustom(); return; }
          state.curve = v;
          setPref("inkCurve", v);
          setPref("inkPressureMin", state.pressureMin);
          setPref("inkPressureGamma", state.pressureGamma);
          minInput.value = String(state.pressureMin);
          gamInput.value = String(state.pressureGamma);
          minVal.textContent = Math.round(state.pressureMin * 100) + "%";
          gamVal.textContent = state.pressureGamma.toFixed(2);
          drawPressureGraph();
        });
        drawPressureGraph();

        var color = ctx.newGroup("颜色");
        ctx.toggleEl(ctx.itemEl(color, "墨水颜色跟随主题",
          "开启时深色主题用浅色墨、浅色主题用深色墨（默认）；关闭后使用下面的自选颜色。", true),
          pref("inkColorAuto", true) !== false,
          function (on) {
            state.colorAuto = !!on;
            setPref("inkColorAuto", !!on);
            updateToolbarState();
          });
        var paletteCtl = ctx.itemEl(color, "工具条调色盘",
          "设置颜色按钮轮换的 3 个常用颜色；长按颜色按钮可打开系统取色器。");
        var paletteWrap = document.createElement("div");
        paletteWrap.style.cssText = "display:flex;gap:6px;align-items:center";
        for (var palIdx = 0; palIdx < 3; palIdx++) {
          (function (idx) {
            var pin = document.createElement("input");
            pin.type = "color";
            pin.value = state.palette[idx] || "#1f1f1f";
            pin.title = "调色盘 " + (idx + 1);
            pin.style.cssText = "width:30px;height:26px;padding:0;border:0;background:transparent";
            pin.addEventListener("change", function () {
              state.palette[idx] = pin.value;
              setPref("inkPalette", state.palette.slice());
              rebuildToolbar();
            });
            paletteWrap.appendChild(pin);
          })(palIdx);
        }
        paletteCtl.appendChild(paletteWrap);
        var colorCtl = ctx.itemEl(color, "自选墨色",
          "选择后会自动关闭“跟随主题”，只影响之后新写的笔画；已有笔画可用“按主题重新着色”或撤销。");
        var colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.value = state.color || "#1f1f1f";
        colorInput.addEventListener("change", function () {
          state.color = colorInput.value;
          state.colorAuto = false;
          setPref("inkColor", state.color);
          setPref("inkColorAuto", false);
          updateToolbarState();
        });
        colorCtl.appendChild(colorInput);
        var hlCtl = ctx.itemEl(color, "高亮笔颜色",
          "高亮笔默认黄色；也可以直接在工具栏选中高亮笔后点色块或自定义颜色。");
        var hlInput = document.createElement("input");
        hlInput.type = "color";
        hlInput.value = state.hlColor || "#ffd54a";
        hlInput.addEventListener("change", function () {
          state.hlColor = hlInput.value;
          setPref("inkHlColor", state.hlColor);
          updateToolbarState();
        });
        hlCtl.appendChild(hlInput);
        ctx.toggleEl(ctx.itemEl(color, "荧光笔直线",
          "与华为笔记一致：荧光笔在起笔和抬笔之间画一条等宽直线，不随压力变粗。关闭后可自由手绘。", true),
          pref("inkHlStraight", true) !== false,
          function (on) { state.hlStraight = !!on; setPref("inkHlStraight", !!on); });
        ctx.toggleEl(ctx.itemEl(color, "停留变直",
          "笔尖在笔画末端停住约 0.4 秒，接近直线的笔画会自动拉直；写字时停顿不会触发。", true),
          pref("inkHoldStraight", true) !== false,
          function (on) { state.holdStraight = !!on; setPref("inkHoldStraight", !!on); });
        ctx.toggleEl(ctx.itemEl(color, "一笔成形（鸿蒙识别）",
          "打开后画完一笔停顿约半秒，由鸿蒙笔服务识别并替换为直线/圆/矩形/三角/箭头等标准图形；也可点工具条上的 △ 快速开关。", true),
          pref("inkShapeMode", false) === true,
          function (on) {
            state.shapeMode = !!on;
            setPref("inkShapeMode", !!on);
            sendShapeMode();
            if (state.shapeMode && state.tool !== "pen") setTool("pen");
            updateToolbarState();
          });
        ctx.toggleEl(ctx.itemEl(color, "笔迹预测（实验）",
          "用鸿蒙 Pen Kit 的 PointPredictor 只在 live 层多画一个“预测点”，实点到达即替换，用来降低跟手延迟；关闭后完全走真实事件。", true),
          pref("inkPredict", false) === true,
          function (on) {
            state.predictWanted = !!on;
            setPref("inkPredict", !!on);
            sendPredictMode();
          });

        var pdf = ctx.newGroup("PDF 与诊断");
        var pdfCtl = ctx.itemEl(pdf, "写入 PDF 后",
          "高亮笔写入后只显示 PDF 的 /Highlight 注释（等宽、单层，不再和叠加层叠色）。普通笔迹按此选项保留或隐藏叠加层；改为“隐藏”时只看 PDF 注释。");
        selectEl(pdfCtl, [
          ["keep", "普通笔迹保留叠加层（默认）"],
          ["hide", "全部只显示 PDF 注释"]
        ], pref("inkPdfAfterBake", "keep"), function (v) { setPref("inkPdfAfterBake", v); });
        ctx.toggleEl(ctx.itemEl(pdf, "直接写入 PDF（自动备份）",
          "开启后按下面的时机把当前页墨迹写回 PDF；首次写入前保留原文件备份。擦除/撤销/清除会重写本页注释。", true),
          pref("inkPdfAuto", true) !== false,
          function (on) { setPref("inkPdfAuto", !!on); if (!on && state.pdfAutoTimer) { clearTimeout(state.pdfAutoTimer); state.pdfAutoTimer = 0; } });
        var whenCtl = ctx.itemEl(pdf, "写回时机",
          "离开 PDF 时写回不会打断阅读；停笔 3 秒会替换正在打开的文件，Obsidian 会整页重载（白屏）。");
        selectEl(whenCtl, [
          ["leave", "离开 PDF 时（推荐）"],
          ["idle", "停笔 3 秒（会重载）"],
          ["manual", "仅手动命令"]
        ], state.pdfWriteWhen, function (v) {
          state.pdfWriteWhen = v;
          setPref("inkPdfWriteWhen", v);
          if (v !== "idle" && state.pdfAutoTimer) {
            clearTimeout(state.pdfAutoTimer);
            state.pdfAutoTimer = 0;
          }
        });
        var styleCtl = ctx.itemEl(pdf, "注释样式",
          "折线（/PolyLine）默认用于避免部分 PDF Kit 把 /Ink 画成填充状；墨迹（/Ink）是标准格式。");
        selectEl(styleCtl, [
          ["polyline", "折线（兼容，默认）"],
          ["ink", "墨迹（标准 /Ink）"]
        ], state.pdfStyle, function (v) {
          state.pdfStyle = v;
          setPref("inkPdfStyle", v);
          inkStatus(v === "polyline" ? "PDF 注释改为折线，下次写回生效" : "PDF 注释恢复标准墨迹", 2500);
        });
        var rewriteCtl = ctx.itemEl(pdf, "重写本页标注",
          "旧版本把颜色按 RGB 写进 PDF Kit（它要 BGR），黄色荧光笔会变成蓝色。此按钮用修正后的颜色重写当前页注释，同时清掉旧的蓝色副本。");
        var rewriteBtn = document.createElement("button");
        rewriteBtn.textContent = "重写";
        rewriteBtn.addEventListener("click", function () { inkWritePdf(null, false); });
        rewriteCtl.appendChild(rewriteBtn);
        var restoreCtl = ctx.itemEl(pdf, "恢复原始 PDF",
          "从 .obsidian/ohsidian-ink/backups 的原始备份恢复当前 PDF；会丢弃之后写入的注释。");
        var restoreBtn = document.createElement("button");
        restoreBtn.textContent = "恢复";
        restoreBtn.addEventListener("click", function () { inkRestorePdf(); });
        restoreCtl.appendChild(restoreBtn);
        var diagCtl = ctx.itemEl(pdf, "诊断", "查看当前笔类型、压力档位、旁路状态与未写回笔数。");
        var btn = document.createElement("button");
        btn.textContent = "查看";
        btn.addEventListener("click", function () { showDiagnostics(); });
        diagCtl.appendChild(btn);
      } catch (e) {
        warn("settings hook failed", e && e.message);
      }
    },
    diagnosticLines: function () {
      try { return diagnosticLines(); } catch (e) { return ["  ink hooks error"]; }
    }
  };

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------
  function addCommands(app) {
    var add = function (id, name, cb) {
      try { app.commands.addCommand({ id: id, name: name, callback: cb }); } catch (e) {}
    };
    add("ohsidian-ink-mode", "OHSidian: 手写模式 开/关（指针 ↔ 笔）", function () {
      setTool(state.tool === "pointer" ? state.lastPenTool : "pointer");
      inkStatus("手写工具：" + state.tool);
    });
    add("ohsidian-ink-toggle-feature", "OHSidian 手写: 启用/关闭手写模式", function () {
      var on = !state.enabled;
      state.enabled = on;
      setPref("inkEnabled", on);
      if (!on) {
        state.tool = "pointer";
        state.barExpanded = false;
        state.lastPenSeen = 0;
        state.lastToolMode = null;
        if (state.pdfAutoTimer) { clearTimeout(state.pdfAutoTimer); state.pdfAutoTimer = 0; }
        inkToolMode("pointer");
        forceReleaseActive(true);
        palmHide();
        clearCursor();
        try { document.body.classList.remove("ohsidian-ink-pen"); } catch (e) {}
      } else {
        state.lastToolMode = null;
        buildToolbar();
        setTool(state.lastPenTool || "pen");
      }
      updateToolbarState();
      updateToolbarVisibility();
      inkRefreshSurfaces();
      inkStatus("手写功能 " + (on ? "已开启" : "已关闭"));
    });
    add("ohsidian-ink-enable", "OHSidian: 开启手写（切到阅读视图并选笔）", function () {
      if (!activeSurfaceNow() && inkEnterReadingMode()) {
        inkStatus("已切换到阅读视图", 3000);
        inkAfterEnterReadingMode("pen");
        return;
      }
      buildToolbar();
      setTool(state.lastPenTool || "pen");
      updateToolbarState();
    });
    add("ohsidian-ink-pen", "OHSidian 手写: 笔", function () { setTool("pen"); });
    add("ohsidian-ink-highlighter", "OHSidian 手写: 高亮笔", function () { setTool("highlighter"); });
    add("ohsidian-ink-eraser", "OHSidian 手写: 橡皮", function () { setTool("eraser"); });
    add("ohsidian-ink-pointer", "OHSidian 手写: 指针/选择", function () { setTool("pointer"); });
    add("ohsidian-ink-undo", "OHSidian 手写: 撤销墨迹", function () { inkUndo(); });
    add("ohsidian-ink-redo", "OHSidian 手写: 重做墨迹", function () { inkRedo(); });
    add("ohsidian-ink-clear", "OHSidian 手写: 清空本页墨迹", function () { inkClearSpace(); });
    add("ohsidian-ink-pdf-write", "OHSidian 手写: 写入 PDF（真实注释）", function () { inkWritePdf(); });
    add("ohsidian-ink-pdf-restore", "OHSidian 手写: 恢复 PDF 原始备份", function () { inkRestorePdf(); });
    add("ohsidian-ink-export", "OHSidian 手写: 导出本页 SVG", function () { inkExportSvg(); });
    add("ohsidian-ink-recolor", "OHSidian 手写: 按主题重新着色本页", function () { inkRecolorSpace(); });
    add("ohsidian-ink-toolbar", "OHSidian 手写: 显示/隐藏工具条", function () {
      buildToolbar();
      var bar = toolbarEl();
      if (!bar) return;
      bar.classList.toggle("is-hidden");
    });
    add("ohsidian-ink-diag", "OHSidian 诊断: 手写笔", function () {
      showDiagnostics();
    });
    add("ohsidian-ink-probe-capture", "OHSidian 诊断: 手写笔事件捕获 开/关", function () {
      state.probeCapture = !state.probeCapture;
      inkStatus("手写笔事件捕获 → " + (state.probeCapture ? "开" : "关") + "（控制台 [OHSidian ink pen]）");
    });
  }

  // ---------------------------------------------------------------------
  // Diagnostics probe (opt-in; cheap when off)
  // ---------------------------------------------------------------------
  function onProbeEvent(ev) {
    if (!state.probeCapture) return;
    if (!isPenEvent(ev)) return;
    try {
      var press = typeof ev.pressure === "number" ? ev.pressure : -1;
      var co = 0;
      try { co = ev.getCoalescedEvents ? ev.getCoalescedEvents().length : 0; } catch (e) {}
      if (co > state.coalescedMax) state.coalescedMax = co;
      console.log("[OHSidian ink pen]", ev.type, "type=" + ev.pointerType,
        "p=" + press.toFixed(3), "tilt=" + Math.round(ev.tiltX || 0) + "," + Math.round(ev.tiltY || 0),
        "btn=" + ev.button + " buttons=" + ev.buttons, "co=" + co,
        "w=" + (ev.width || 0).toFixed(1), "h=" + (ev.height || 0).toFixed(1));
    } catch (e) {}
  }

  function installPenObservers() {
    var record = function (ev) {
      if (!state.enabled) return;
      state.pointerTypes = state.pointerTypes || {};
      var t = ev.pointerType || "?";
      state.pointerTypes[t] = (state.pointerTypes[t] || 0) + 1;
      if (isPenEvent(ev)) {
        state.lastPenAt = nowMs();
        state.lastPenType = ev.pointerType || "?";
        state.lastPenDetail = {
          type: ev.pointerType || "?",
          p: typeof ev.pressure === "number" ? ev.pressure : -1,
          tx: ev.tiltX || 0,
          ty: ev.tiltY || 0,
          button: ev.button,
          buttons: ev.buttons,
          w: ev.width || 0,
          h: ev.height || 0
        };
        // Observe pressure even in pointer mode: this is how G1/G2 is decided
        // (the device log showed pen pressure reaching the DOM).
        if (ev.pressure !== undefined) observeDomPressure(ev.pressure);
      }
      onProbeEvent(ev);
    };
    window.addEventListener("pointerdown", record, true);
    window.addEventListener("pointermove", record, true);
    window.addEventListener("pointerdown", onPointerDownCapture, true);
    window.addEventListener("pointermove", onPointerMoveCapture, true);
    window.addEventListener("pointerup", onPointerUpCapture, true);
    window.addEventListener("pointercancel", onPointerUpCapture, true);
    window.addEventListener("pointermove", onCursorMove, true);
    window.addEventListener("pointerdown", clearCursor, true);
    window.addEventListener("pointerup", clearCursor, true);
    window.addEventListener("pointercancel", clearCursor, true);
    window.addEventListener("scroll", clearCursor, true);
    window.addEventListener("scroll", function () {
      for (var si = 0; si < state.surfaces.length; si++) {
        var ss = state.surfaces[si];
        if (ss.kind === "markdown" || ss.kind === "canvas") ss.rects = null;
      }
      if (state.barMode !== "always" && state.barExpanded) collapseToolbar();
      if (state.selection) clearSelection();
    }, { capture: true, passive: true });
    window.addEventListener("resize", function () {
      if (state.selection) clearSelection();
    }, { passive: true });
    try { document.addEventListener("pointerleave", clearCursor, true); } catch (eL) {}
    // A lost pen-up must not leave the translucent "writing" state covering
    // the nib, or the controls look dead until the 2.6s watchdog fires.
    var clearWritingChrome = function () {
      state.penUiSwipe = null;
      if (state.active) return;
      state.blockedPointerId = null;
      var root = toolbarEl();
      if (root) root.classList.remove("is-writing");
    };
    window.addEventListener("pointerup", clearWritingChrome, true);
    window.addEventListener("pointercancel", clearWritingChrome, true);
    // A pen swipe that started on chrome must not activate that chrome on
    // pointerup/click; suppress the synthetic click for a short window.
    window.addEventListener("click", function (ev) {
      if (Date.now() < state.penClickSuppressUntil) {
        try { ev.preventDefault(); } catch (eC1) {}
        try { ev.stopPropagation(); } catch (eC2) {}
        try { ev.stopImmediatePropagation(); } catch (eC3) {}
      }
    }, true);
    window.addEventListener("touchstart", onPenCompatibilityBlock, { capture: true, passive: false });
    window.addEventListener("touchmove", onPenCompatibilityBlock, { capture: true, passive: false });
    window.addEventListener("touchend", onPenCompatibilityBlock, { capture: true, passive: false });
    window.addEventListener("touchcancel", onPenCompatibilityBlock, { capture: true, passive: false });
    window.addEventListener("mousedown", onPenCompatibilityBlock, true);
    window.addEventListener("mousemove", onPenCompatibilityBlock, true);
    window.addEventListener("mouseup", onPenCompatibilityBlock, true);
    window.addEventListener("touchstart", onEdgeTouchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", onEdgeTouchMove, { capture: true, passive: false });
    window.addEventListener("touchend", onEdgeTouchEnd, { capture: true, passive: false });
    window.addEventListener("touchcancel", onEdgeTouchEnd, { capture: true, passive: false });
    window.addEventListener("pointerdown", onPenEdgePointer, true);
    window.addEventListener("pointermove", onPenEdgePointer, true);
    window.addEventListener("touchstart", function (ev) {
      if (state.active ||
        (state.penNativeActive && nowMs() - (state.lastPenActivity || 0) < 900)) {
        try { ev.preventDefault(); } catch (e) {}
      }
    }, { capture: true, passive: false });
    window.addEventListener("touchmove", function (ev) {
      if (state.active ||
        (state.penNativeActive && nowMs() - (state.lastPenActivity || 0) < 900)) {
        try { ev.preventDefault(); } catch (e) {}
      }
    }, { capture: true, passive: false });
    // Any of these can interrupt a pen stroke before its pointerup arrives.
    window.addEventListener("blur", function () {
      clearCursor();
      forceReleaseActive(true);
      flushPdfWrite();
    });
    document.addEventListener("visibilitychange", function () {
      try {
        if (document.hidden) {
          forceReleaseActive(true);
          flushPdfWrite();
        }
      } catch (e) {}
    });
    window.addEventListener("keydown", function (ev) {
      if (ev && (ev.key === "Escape" || ev.keyCode === 27)) forceReleaseActive(true);
    }, true);
  }

  function onNativeMessageEvent(ev) {
    try { onNativeMessage(ev.detail); } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // Workspace integration
  // ---------------------------------------------------------------------
  function onLayoutChange() {
    setTimeout(function () {
      try { inkRefreshSurfaces(); } catch (e) {}
    }, 60);
  }

  function onActiveLeafChange() {
    clearSelection();
    flushPdfWrite();
    var app = state.app;
    var leaf = app && app.workspace ? app.workspace.activeLeaf : null;
    state.activeLeaf = leaf;
    state.activeSurface = leaf ? activeSurfaceForLeaf(leaf) : null;
    if (state.activeSurface && state.activeSurface.kind === "pdf") {
      // Keep currentSpace in sync for the badge and eraser.
      try {
        var pn = state.activeSurface.viewer.currentPageNumber;
        if (pn > 0) state.activeSurface.currentSpace = "pdf:" + (pn - 1);
      } catch (e) {}
      if (!state.activeSurface.currentSpace) {
        var keys = Object.keys(state.activeSurface.pages);
        if (keys.length) state.activeSurface.currentSpace = state.activeSurface.pages[keys[0]].space;
      }
    }
    setTimeout(function () {
      try { inkRefreshSurfaces(); } catch (e) {}
    }, 30);
    updateToolbarState();
  }

  function onRename(file, oldPath) {
    if (!file || !oldPath || file.path === oldPath) return;
    var oldKey = inkKey(oldPath);
    var newKey = inkKey(file.path);
    var doc = store.cache[oldKey];
    var ad = adapter();
    if (!ad) return;
    // Kill the 900 ms debounce that was armed for the OLD key before touching
    // anything: it writes the old path, so it either fires after the sidecar
    // was moved (orphan entry holding the tail strokes) or races the migration
    // (the moved file keeps the pre-rename content and the tail is lost). The
    // ink layer has no beforeunload flush, so those strokes were gone for good
    // (audit NF-008).
    var timer = store.timers[oldKey];
    if (timer) {
      clearTimeout(timer);
      store.timers[oldKey] = 0;
    }
    // A saveDoc for the old key may already be in flight; migrating underneath
    // it would recreate the old sidecar right after we remove it.
    var waitIdle = function (fn) {
      var tries = 0;
      var go = function () {
        if (store.saving[oldKey] && tries++ < 40) {
          setTimeout(go, 50);
          return;
        }
        fn();
      };
      go();
    };
    if (doc) {
      // The open document is the freshest state (the sidecar can lag by up to
      // 900 ms), so publish IT under the new key instead of re-reading disk.
      store.cache[oldKey] = null;
      store.cache[newKey] = doc;
      doc.target = file.path;
      doc._dirty = false;
      waitIdle(function () {
        saveDoc(doc).then(function (ok) {
          if (!ok) {
            // Keep the old sidecar: it is the only copy if this failed.
            warn("ink doc rename: save under the new path failed", newKey);
            return;
          }
          ad.remove(pathFor(oldKey)).catch(function () {});
        }, function () {});
      });
      return;
    }
    waitIdle(function () {
      ad.exists(pathFor(oldKey)).then(function (exists) {
        if (!exists) return;
        return ad.read(pathFor(oldKey)).then(function (txt) {
          var parsed = JSON.parse(txt);
          parsed.target = file.path;
          parsed.updated = Date.now();
          var dest = pathFor(newKey);
          var body = JSON.stringify(parsed);
          var tmp = dest + ".tmp";
          // tmp + rename like saveDoc: this was the only ink write that wrote
          // in place, and a crash mid-write left a truncated sidecar that
          // parses as "no strokes" and is then overwritten by the next save.
          return ensureDirs().then(function () {
            return ad.write(tmp, body).then(function () {
              return ad.rename(tmp, dest).then(function () {}, function () {
                return ad.write(dest, body).then(function () {
                  try { ad.remove(tmp); } catch (eRm) {}
                });
              });
            });
          }).then(function () {
            store.cache[oldKey] = null;
            store.cache[newKey] = parsed;
            return ad.remove(pathFor(oldKey)).catch(function () {});
          });
        });
      }).catch(function (e) {
        // Was a bare .catch(function(){}) - a failed migration just looked like
        // "the ink disappeared".
        warn("ink doc rename migrate failed", oldKey, e && e.message);
        try {
          notice("墨迹随文件改名迁移失败：" + ((e && e.message) || "未知错误"), 6000);
        } catch (eN) {}
      });
    });
  }

  /* ---- device-agent perf sampling (local builds only) ------------------ */
  function pdfCountBytes(bytes, needle) {
    var pat = [];
    for (var i = 0; i < needle.length; i++) pat.push(needle.charCodeAt(i));
    var n = 0;
    var limit = bytes.length - pat.length;
    for (var j = 0; j <= limit; j++) {
      var ok = true;
      for (var k = 0; k < pat.length; k++) {
        if (bytes[j + k] !== pat[k]) { ok = false; break; }
      }
      if (ok) { n++; j += pat.length - 1; }
    }
    return n;
  }

  function pdfFindBytes(bytes, needle, from) {
    var pat = [];
    for (var i = 0; i < needle.length; i++) pat.push(needle.charCodeAt(i));
    var limit = bytes.length - pat.length;
    for (var j = Math.max(0, from || 0); j <= limit; j++) {
      var ok = true;
      for (var k = 0; k < pat.length; k++) {
        if (bytes[j + k] !== pat[k]) { ok = false; break; }
      }
      if (ok) return j;
    }
    return -1;
  }

  function pdfAsciiAround(bytes, at, before, after) {
    var s = "";
    var from = Math.max(0, at - before);
    var to = Math.min(bytes.length, at + after);
    for (var i = from; i < to; i++) {
      var c = bytes[i];
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : ".";
    }
    return s;
  }

  function pdfScanFilters(viewer) {
    try {
      if (!viewer || !viewer.pdfDocument || !viewer.pdfDocument.getData) return;
      viewer.pdfDocument.getData().then(function (bytes) {
        var counts = {
          jpx: pdfCountBytes(bytes, "/JPXDecode"),
          dct: pdfCountBytes(bytes, "/DCTDecode"),
          flate: pdfCountBytes(bytes, "/FlateDecode"),
          jbig2: pdfCountBytes(bytes, "/JBIG2Decode"),
          ccitt: pdfCountBytes(bytes, "/CCITTFaxDecode")
        };
        var at = pdfFindBytes(bytes, "/Width 5816", 0);
        probeHook("pdfFilters", {
          bytes: bytes.length,
          counts: counts,
          at5816: at,
          ctx5816: at >= 0 ? pdfAsciiAround(bytes, at, 260, 260) : ""
        });
      }).catch(function (eF) {
        probeHook("pdfFilters", { error: String(eF && eF.message || eF) });
      });
    } catch (e) {}
  }

  function perfOverlayStats() {
    var canvases = 0;
    var pixels = 0;
    try {
      for (var i = 0; i < state.surfaces.length; i++) {
        var s = state.surfaces[i];
        if (s.kind !== "pdf" || !s.pages) continue;
        for (var k in s.pages) {
          if (!Object.prototype.hasOwnProperty.call(s.pages, k)) continue;
          var e = s.pages[k];
          if (e && e.cv) { canvases++; pixels += e.cv.width * e.cv.height; }
          if (e && e.live) { canvases++; pixels += e.live.width * e.live.height; }
        }
      }
    } catch (eO) {}
    return { canvases: canvases, mp: Math.round(pixels / 1e6) };
  }

  /**
   * Samples requestAnimationFrame deltas for `ms`. A frame interval above
   * ~24ms is counted as jank (60Hz budget is 16.7ms). `extra` is merged into
   * the probe payload so a caller can attach input-latency numbers.
   */
  function perfRafSample(label, ms, extra) {
    var deltas = [];
    var last = 0;
    var start = nowMs();
    var stopped = false;
    function finish() {
      if (stopped) return;
      stopped = true;
      deltas.sort(function (a, b) { return a - b; });
      var n = deltas.length;
      var sum = 0;
      var jank = 0;
      for (var i = 0; i < n; i++) {
        sum += deltas[i];
        if (deltas[i] > 24) jank++;
      }
      probeHook("perf", {
        label: label,
        frames: n,
        avg: n ? Number((sum / n).toFixed(1)) : 0,
        p50: n ? Number(deltas[Math.floor(n * 0.5)].toFixed(1)) : 0,
        p95: n ? Number(deltas[Math.min(n - 1, Math.floor(n * 0.95))].toFixed(1)) : 0,
        max: n ? Number(deltas[n - 1].toFixed(1)) : 0,
        jank: jank,
        overlays: perfOverlayStats(),
        extra: extra || null
      });
    }
    function tick(t) {
      if (stopped) return;
      if (last) deltas.push(t - last);
      last = t;
      if (nowMs() - start < ms) requestAnimationFrame(tick);
      else finish();
    }
    requestAnimationFrame(tick);
  }

  function mdScrollSample(label, el, ms) {
    return new Promise(function (resolve) {
      var t0 = nowMs(), last = 0, frames = 0, deltas = [], max = 0, jank = 0;
      var origin = el.scrollTop;
      function tick(ts) {
        if (last) {
          var d = ts - last;
          deltas.push(d);
          if (d > max) max = d;
          if (d > 50) jank++;
        }
        last = ts;
        frames++;
        el.scrollTop += 40;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) el.scrollTop = 0;
        if (nowMs() - t0 < ms) {
          requestAnimationFrame(tick);
        } else {
          try { el.scrollTop = origin; } catch (eR) {}
          deltas.sort(function (a, b) { return a - b; });
          var sum = 0;
          for (var i = 0; i < deltas.length; i++) sum += deltas[i];
          probeHook("mdscroll", {
            label: label,
            frames: frames,
            avg: deltas.length ? Number((sum / deltas.length).toFixed(1)) : 0,
            p50: deltas.length ? Number(deltas[Math.floor(deltas.length * 0.5)].toFixed(1)) : 0,
            p95: deltas.length ? Number(deltas[Math.floor(deltas.length * 0.95)].toFixed(1)) : 0,
            max: Number(max.toFixed(1)),
            jank: jank,
            contentH: el.scrollHeight,
            viewH: el.clientHeight
          });
          resolve();
        }
      }
      requestAnimationFrame(tick);
    });
  }

  function mdScroller() {
    var sels = [".markdown-preview-view", ".cm-scroller", ".markdown-reading-view"];
    for (var s = 0; s < sels.length; s++) {
      var list = document.querySelectorAll(sels[s]);
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!el || el.clientHeight < 80) continue;
        if (el.scrollHeight < el.clientHeight + 40) continue;
        return el;
      }
    }
    return null;
  }

  function mdScrollTest() {
    try {
      var app = state.app || window.app;
      if (!app || !app.workspace || !app.vault) return;
      var prev = app.workspace.getActiveFile ? app.workspace.getActiveFile() : null;
      var files = app.vault.getMarkdownFiles ? app.vault.getMarkdownFiles() : [];
      var best = null;
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (!f || !f.stat || !(f.stat.size > 0)) continue;
        if (!best || f.stat.size > best.stat.size) best = f;
      }
      if (!best) { probeHook("mdscroll", { label: "none", files: files.length }); return; }
      var leaf = app.workspace.getLeaf(true);
      Promise.resolve(leaf.openFile(best)).then(function () {
        setTimeout(function () {
          var el = mdScroller();
          if (!el) { probeHook("mdscroll", { label: "missing" }); return; }
          var isEdit = el.classList.contains("cm-scroller");
          var label = isEdit ? "mdedit" : "mdread";
          mdScrollSample(label, el, 3000).then(function () {
            try { state.enabled = false; inkRefreshSurfaces(); } catch (eOff) {}
            setTimeout(function () {
              var el2 = mdScroller();
              if (!el2) return;
              mdScrollSample(label + "_noink", el2, 3000).then(function () {
                try { state.enabled = true; inkRefreshSurfaces(); } catch (eOn) {}
                var view = leaf.view;
                try {
                  if (leaf.setViewState) {
                    leaf.setViewState({
                      type: "markdown",
                      state: { file: best.path, mode: "preview" }
                    });
                  } else if (view && view.setState && view.getState) {
                    var st = view.getState();
                    st.mode = "preview";
                    view.setState(st);
                  }
                } catch (eMode) {}
                setTimeout(function () {
                  var el3 = mdScroller();
                  function finish() {
                    if (prev && prev.path !== best.path) {
                      try { app.workspace.getLeaf(false).openFile(prev); } catch (eBack) {}
                    }
                  }
                  if (!el3) { finish(); return; }
                  mdScrollSample("mdpreview", el3, 3000).then(finish);
                }, 1500);
              });
            }, 500);
          });
        }, 1500);
      }).catch(function (eOpen) {
        probeHook("mdscroll", { label: "openFail", error: String(eOpen && eOpen.message || eOpen) });
      });
    } catch (eMd) {
      probeHook("mdscroll", { label: "error", error: String(eMd && eMd.message || eMd) });
    }
  }

  function mdPlainTest() {
    try {
      var app = state.app || window.app;
      if (!app || !app.vault || !app.workspace) return;
      var prev = app.workspace.getActiveFile ? app.workspace.getActiveFile() : null;
      var lines = [];
      for (var i = 0; i < 1200; i++) {
        lines.push("line " + i + " - the quick brown fox jumps over the lazy dog 0123456789");
      }
      var name = "_ohsidian_perf_plain_" + Date.now().toString(36) + ".md";
      var file = null;
      function cleanup() {
        try { if (file) app.vault.delete(file); } catch (eD) {}
        if (prev) { try { app.workspace.getLeaf(false).openFile(prev); } catch (eR) {} }
      }
      Promise.resolve(app.vault.create(name, lines.join("\n"))).then(function (f) {
        file = f;
        var leaf = app.workspace.getLeaf(true);
        return Promise.resolve(leaf.openFile(f)).then(function () {
          setTimeout(function () {
            var el = mdScroller();
            if (!el) { probeHook("mdplain", { label: "missing" }); cleanup(); return; }
            mdScrollSample("mdplain_edit", el, 2500).then(cleanup);
          }, 700);
        });
      }).catch(function (eC) {
        probeHook("mdplain", { label: "error", error: String(eC && eC.message || eC) });
      });
    } catch (e) {
      probeHook("mdplain", { label: "error", error: String(e && e.message || e) });
    }
  }

  function installPerfProbes() {
    if (!window.__ohsidianAgentBuild) return;
    try {
      var hasID = typeof ImageDecoder !== "undefined";
      var hasCIB = typeof createImageBitmap === "function";
      var p = hasID && ImageDecoder.isTypeSupported
        ? ImageDecoder.isTypeSupported("image/jpeg") : Promise.resolve(false);
      Promise.resolve(p).then(function (ok) {
        probeHook("imgSupport", { imageDecoder: hasID, jpeg: !!ok, createImageBitmap: hasCIB });
      }).catch(function () {
        probeHook("imgSupport", { imageDecoder: hasID, jpeg: false, createImageBitmap: hasCIB });
      });
    } catch (eIS) {}
    setTimeout(function () { perfRafSample("idle", 3000); }, 6000);
    // Scroll the PDF container while sampling: first with the ink overlays,
    // then with the layer temporarily disabled, so the overlay's compositing
    // cost is measurable instead of guessed. OPT-IN only: this physically
    // scrolls the reader for 6 s and must never run during a normal writing
    // session (it was the reported "PDF 自己往下滑"). Enable with
    // `window.__ohsidianPerfScroll = true` in an agent build.
    if (window.__ohsidianPerfScroll === true) setTimeout(function () {
      try {
        var s = activeSurfaceNow();
        var el = s && s.kind === "pdf" && s.viewer && s.viewer.container;
        if (!el) return;
        var origin = el.scrollTop;
        var t0 = nowMs();
        var timer = setInterval(function () {
          el.scrollTop += 240;
          if (nowMs() - t0 > 3000) clearInterval(timer);
        }, 50);
        perfRafSample("pdfscroll", 3000);
        setTimeout(function () {
          try { state.enabled = false; inkRefreshSurfaces(); } catch (eOff) {}
          setTimeout(function () {
            var t1 = nowMs();
            var tm = setInterval(function () {
              el.scrollTop += 240;
              if (nowMs() - t1 > 3000) clearInterval(tm);
            }, 50);
            perfRafSample("pdfscroll_noink", 3000);
            setTimeout(function () {
              try { state.enabled = true; inkRefreshSurfaces(); } catch (eOn) {}
              try { el.scrollTop = origin; } catch (eR) {}
            }, 3500);
          }, 800);
        }, 3500);
      } catch (eS) {}
    }, 12000);
    // Opt-in markdown audit: it opens a temporary plain note and the largest
    // real note, so it must never run during a normal session.
    if (window.__ohsidianMdPerf === true) {
      setTimeout(function () { mdPlainTest(); }, 5000);
      setTimeout(function () { mdScrollTest(); }, 14000);
    }
    // One-shot gesture sample: starts once a horizontal swipe actually travels,
    // so a tap that closes a drawer does not consume it.
    try {
      var gStart = null;
      var gDone = false;
      var onDown = function (e) {
        if (gDone) return;
        gStart = { x: e.clientX, y: e.clientY };
      };
      var onMove = function (e) {
        if (gDone || !gStart) return;
        if (Math.abs(e.clientX - gStart.x) < 120) return;
        gDone = true;
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("pointermove", onMove, true);
        perfRafSample("gesture", 2500);
      };
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("pointermove", onMove, true);
    } catch (eG) {}
    try {
      if (typeof PerformanceObserver === "function") {
        var seen = {};
        var po = new PerformanceObserver(function (list) {
          try {
            var entries = list.getEntries();
            for (var i = 0; i < entries.length; i++) {
              var e = entries[i];
              var bucket = Math.round(e.duration / 50) * 50;
              seen[bucket] = (seen[bucket] || 0) + 1;
            }
          } catch (eL) {}
        });
        po.observe({ entryTypes: ["longtask"] });
        setTimeout(function () {
          try { po.disconnect(); } catch (eD) {}
          probeHook("longtask", { buckets: seen });
        }, 20000);
      }
    } catch (eP) {}
  }

  function install(app) {
    if (state.installed) return true;
    state.installed = true;
    state.app = app;
    loadPrefs();
    injectCss();
    installPenObservers();
    window.addEventListener("ohsidian-native-message", onNativeMessageEvent);
    addCommands(app);
    installPerfProbes();
    var readyDone = false;
    function onWorkspaceReady() {
      if (readyDone) return;
      readyDone = true;
      if (state.enabled) { try { inkRefreshSurfaces(); } catch (e) {} }
      // The active reading view often mounts after onLayoutReady; refresh a
      // few times so the first nib tap does not hit "not ready".
      var mountDelays = [150, 400, 900, 1600];
      for (var md = 0; md < mountDelays.length; md++) {
        (function (delay) {
          setTimeout(function () {
            if (!state.enabled) return;
            try { inkRefreshSurfaces(); } catch (e2) {}
          }, delay);
        })(mountDelays[md]);
      }
      try { buildToolbar(); } catch (eBar) { warn("toolbar build failed", eBar && eBar.message); }
      try { updateToolbarState(); } catch (eUT) {
        inkTrace("hooksFail", { stage: "toolbar", error: String(eUT && eUT.message || eUT) });
      }
      try { ensureIpc(); } catch (eIpc) {
        inkTrace("hooksFail", { stage: "ipc", error: String(eIpc && eIpc.message || eIpc) });
      }
      var t = setInterval(function () {
        try {
          if (!state.ipcReady && window.__ohsidianNativeIpcReady) {
            state.ipcReady = true;
          }
          ensureIpc();
          // stylusInfo is one-shot right after the handshake; on a fast boot
          // it can arrive before this layer's listener exists.
          if (!state.stylusInfo) sendAction({ action: "stylusInfo" });
          // Retries the penSamplesOn handshake if the socket was not ready
          // when the pressure detector first asked for samples.
          negotiatePressure();
        } catch (e) {}
      }, 3000);
      state.ipcTimer = t;
    }
    // Start the mount loop before touching workspace APIs. onLayoutReady runs
    // its callback synchronously when the layout is already ready, so one
    // exception inside that callback used to abort the whole try block: no
    // event hooks, no warm loop, and an invisible ink layer for the session.
    (function warmSurfaces() {
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        if (!state.enabled) { clearInterval(timer); return; }
        try { onWorkspaceReady(); } catch (eR0) {}
        try { inkRefreshSurfaces(); } catch (eW) {}
        var missing = false;
        try {
          var pdfLeaves = app.workspace.getLeavesOfType("pdf") || [];
          for (var w = 0; w < pdfLeaves.length; w++) {
            var lf = pdfLeaves[w];
            if (lf.view && lf.view.getViewType && lf.view.getViewType() === "pdf" &&
              !surfaceForLeaf(lf)) missing = true;
          }
        } catch (eL0) {}
        if (!missing && tries > 3) clearInterval(timer);
        else if (tries >= 30) clearInterval(timer);
      }, 700);
    })();
    try {
      app.workspace.onLayoutReady(onWorkspaceReady);
    } catch (eReady) {
      inkTrace("hooksFail", {
        stage: "ready",
        error: String(eReady && eReady.message || eReady)
      });
    }
    setTimeout(onWorkspaceReady, 1200);
    try {
      app.workspace.on("layout-change", onLayoutChange);
      app.workspace.on("active-leaf-change", onActiveLeafChange);
      app.workspace.on("file-open", onLayoutChange);
      app.workspace.on("css-change", function () {
        try {
          for (var i = 0; i < state.surfaces.length; i++) inkRefreshAutoColors(state.surfaces[i]);
        } catch (e) {}
        scheduleRedraw();
      });
      if (app.vault && app.vault.on) {
        app.vault.on("rename", onRename);
      }
      window.addEventListener("resize", function () {
        setTimeout(function () { inkRefreshSurfaces(); }, 80);
      });
      document.addEventListener("pointerdown", function (ev) {
        if (!ev.target || !ev.target.closest) return;
        if (!ev.target.closest("#" + TOOLBAR_ID) && !ev.target.closest("#" + MENU_ID)) closeMenu();
      }, true);
    } catch (eHooks) {
      inkTrace("hooksFail", {
        stage: "events",
        error: String(eHooks && eHooks.message || eHooks)
      });
    }
    log("installed rev " + OHSIDIAN_INK_REV);
    probeHook("boot", {
      rev: OHSIDIAN_INK_REV,
      dpr: window.devicePixelRatio || 1,
      inner: [window.innerWidth || 0, window.innerHeight || 0],
      screen: [window.screen ? screen.availWidth : 0, window.screen ? screen.availHeight : 0],
      touch: navigator.maxTouchPoints || 0,
      coarse: !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches),
      fakeWorker: window.__ohsidianFakeWorker || 0,
      enabled: state.enabled
    });
    inkTrace("boot", {
      rev: OHSIDIAN_INK_REV,
      enabled: state.enabled,
      mode: state.barMode,
      pos: state.barPos,
      viewport: [window.innerWidth || 0, window.innerHeight || 0],
      dpr: window.devicePixelRatio || 1
    });
    return true;
  }

  function boot() {
    if (state.installed) return true;
    try {
      // window.app appears a tick before app.workspace is constructed. The old
      // check installed too early: onLayoutReady/on threw ("undefined"), the
      // whole hook block was skipped, and the ink layer stayed invisible for
      // the session. Wait for the workspace object itself.
      if (window.app && window.app.workspace) {
        var ok = install(window.app);
        if (ok) window.__ohsidianInkInstalled = true;
        return ok;
      }
    } catch (e) {
      warn("install failed", e && e.message);
    }
    return false;
  }

  // Expose a tiny surface for debugging/tests and let touch-mode.js reach us.
  window.__ohsidianInk = {
    state: state,
    setTool: setTool,
    undo: inkUndo,
    redo: inkRedo,
    clear: inkClearSpace,
    writePdf: inkWritePdf,
    exportSvg: inkExportSvg,
    diagnostics: diagnosticLines,
    pdfStats: pdfOverlayStats,
    refresh: inkRefreshSurfaces,
    _down: onPointerDownCapture,
    _up: onPointerUpCapture,
    _surfaceAt: surfaceAtEvent,
    _excluded: isExcluded
  };

  if (!boot()) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (boot() || tries > 240) clearInterval(timer);
    }, 250);
  }
})();
