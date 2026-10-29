/* ==========================================================================
 * OHSIDIAN DEVICE AGENT PROBE — NOT PART OF RELEASE BUILDS.
 *
 * Injected only by `node scripts/update-obsidian.mjs --repatch --agent`.
 * The release app.js has no `__ohsidianProbeHooks` implementation; the ink
 * layer's `probeHook()` calls become no-ops.
 * ========================================================================== */
(function () {
  "use strict";

  window.__ohsidianAgentBuild = true;
  window.__ohsidianFakeWorker = 0;

  // pdf.js falls back to a fake worker on the UI thread when module-worker
  // loading fails. It only logs one warning, so keep a counter.
  try {
    var origWarn = console.warn;
    console.warn = function () {
      try {
        var msg = Array.prototype.join.call(arguments, " ");
        if (msg && msg.toLowerCase().indexOf("fake worker") >= 0) {
          window.__ohsidianFakeWorker++;
          try {
            console.info("InkProbe fakeWorker " + window.__ohsidianFakeWorker + " " +
              String(msg).slice(0, 160));
          } catch (e0) {}
        }
      } catch (e1) {}
      try { return origWarn.apply(console, arguments); } catch (e2) {}
    };
  } catch (eW) {}

  function canvasWhiteSample(cv) {
    try {
      if (!cv || !(cv.width > 0) || !(cv.height > 0)) return null;
      var tmp = canvasWhiteSample._cv;
      if (!tmp) {
        tmp = document.createElement("canvas");
        tmp.width = 32;
        tmp.height = 32;
        canvasWhiteSample._cv = tmp;
      }
      var ctx = tmp.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.clearRect(0, 0, 32, 32);
      ctx.drawImage(cv, 0, 0, 32, 32);
      var d = ctx.getImageData(0, 0, 32, 32).data;
      var dark = 0;
      var opaque = 0;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 16) {
          opaque++;
          if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) dark++;
        }
      }
      return { white: opaque === 0 || dark < 3, dark: dark, opaque: opaque };
    } catch (e) {
      return null;
    }
  }

  var emitted = 0;
  window.__ohsidianProbeHooks = {
    emit: function (event, data) {
      try {
        if (emitted > 6000) return;
        emitted++;
        var d = data || {};
        // The canvas is passed raw so it never needs to be serialized.
        if (d.canvas) {
          var w = canvasWhiteSample(d.canvas);
          delete d.canvas;
          if (w) {
            d.white = w.white;
            d.dark = w.dark;
            d.opaque = w.opaque;
          }
        }
        if (d.fakeWorker === undefined) d.fakeWorker = window.__ohsidianFakeWorker || 0;
        if (typeof window.__ohsidianNativeSend !== "function") return;
        window.__ohsidianNativeSend({
          action: "inkLog",
          event: "probe:" + String(event || ""),
          detail: JSON.stringify(d),
          ts: Date.now()
        });
      } catch (e) {}
    }
  };

  try { console.info("InkProbe enabled"); } catch (e) {}
})();
