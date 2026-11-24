#!/usr/bin/env node
/**
 * Behavioural gate for the plugin-install / secretStorage patches
 * (report 2026-11-22: NF-015 truncation defence, NF-018 plaintext
 * secretStorage fallback).
 *
 * verify-asar.cjs only asserts that marker strings are present. This script
 * loads the SHIPPED helper code out of the asar and runs it against synthetic
 * downloads, so a patch that is present but broken (wrong scope, wrong error
 * shape, a retry that never fires) fails the gate instead of shipping.
 *
 * Fixtures are generated in memory: no network, no plugin files.
 *
 * Usage: node scripts/verify-plugin-install.cjs
 *        OHSIDIAN_ASAR_PATH=<staged asar> node scripts/verify-plugin-install.cjs
 */
const fs = require('fs');
const path = require('path');
const { extractFile } = require('@electron/asar');

const ASAR = process.env.OHSIDIAN_ASAR_PATH
  ? path.resolve(process.env.OHSIDIAN_ASAR_PATH)
  : path.join(__dirname, '..', 'web_engine/src/main/resources/resfile/resources/app/obsidian.asar');

let failures = 0;
function check(label, cond) {
  console.log((cond ? '  OK  ' : '  FAIL') + ' ' + label);
  if (!cond) failures++;
}

let app;
try {
  app = extractFile(ASAR, 'app.js').toString('utf8');
} catch (e) {
  console.error('  FAIL cannot read app.js from ' + ASAR + ': ' + e.message);
  process.exit(1);
}

/* ---- NF-015: the 1.15.1 download helper as shipped -----------------------
   Obsidian 1.15.1 collapsed plugin download into one helper (`UEe()`) that
   fetches manifest + main.js + styles. Our patch replaces that whole function,
   so the gate slices it out between sentinels and drives it with a synthetic
   `sr()` / `Xm()` pair: a truncated body must be re-fetched through the
   release proxy, a doubly-truncated body must reject with the marked
   "incomplete" error, and a plain network error must propagate untouched. */
const FETCH_START = '/*OHSIDIAN-PLUGIN-FETCH*/';
const FETCH_END = '/*OHSIDIAN-PLUGIN-FETCH-END*/';
const fetchStart = app.indexOf(FETCH_START);
const fetchEnd = fetchStart >= 0 ? app.indexOf(FETCH_END, fetchStart) : -1;
const fetchSrc = fetchStart >= 0 && fetchEnd > fetchStart
  ? app.slice(fetchStart + FETCH_START.length, fetchEnd) : null;
check('plugin download helper patch present in app.js', !!fetchSrc);
check('patched helper parses the body exactly like loadPlugin',
  !!fetchSrc && fetchSrc.includes('new Function(String(v).replace(TV,"")+IV)'));
check('patched helper retries through the release proxy',
  !!fetchSrc && fetchSrc.includes('releases.obsidian.md/proxy?url='));
check('patched helper marks the rejection as incomplete',
  !!fetchSrc && fetchSrc.includes('__ohsidianPluginDownloadIncomplete=true'));
check('patched helper is a standalone function (no class-body injection)',
  app.includes('async function UEe(o,t){') && !app.includes('},t.prototype.__ohsidianFetchPluginBundle='));
check('install failure surface names the truncation',
  app.includes('插件文件下载不完整（疑似网络截断）'));
check('load failure names a truncated main.js',
  app.includes('插件文件下载不完整') && app.includes('plugin file unparsable'));
check('installPlugin is still a class method (patch did not unbalance the class)',
  app.includes('async installPlugin(e,i,r){') && app.includes('async writePluginFiles(e,i){'));

/* ---- NF-016 / NF-018 / diagnostics markers ------------------------------ */
check('console bridge defaults to errors-only',
  app.includes('return v==="1"?"all":(v==="0"?"off":"error")') &&
  app.includes('consoleCaptureMode==="all"||m==="error"'));
/* The bridge only works if it obtains a REAL ipcRenderer: @electron/remote has
   no ipcRenderer export, so the round-96b expression was always undefined and
   not a single line ever reached the main process (audit 2026-11-22 P1). */
check('console bridge uses a real ipcRenderer handle',
  app.includes('function ohsidianIpcRenderer(){') &&
  app.includes('var __ohIpc=ohsidianIpcRenderer();') &&
  app.includes('require("electron")') &&
  !app.includes('var __ohIpc=require("@electron/remote").ipcRenderer;'));
check('vault-open migration uses the same IPC handle',
  app.includes('var vaultIpc=ohsidianIpcRenderer();'));
check('log capture cycle exposed in logs section',
  app.includes('ohsidianLogCaptureOn') && app.includes('日志捕获'));
check('renderer safeStorage fallback block present',
  app.includes('window.__ohsidianSafeStorageFallback=') &&
  app.includes('getSelectedStorageBackend:function(){return "basic_text"}'));
check('secretStorage desktop adapter falls back to plaintext',
  app.includes('secretStorage uses plaintext passthrough (NF-018)'));
check('on-device plugin integrity diagnostic present',
  app.includes('ohsidianRunPluginIntegrityProbe') && app.includes('插件诊断'));

/* rev198 (BRAT settings tab still missing on device): the diagnostic must be
   able to surface the real error - Error.stack through the console bridge,
   plugin load state, registered plugin setting tabs, and the console.log tail. */
check('console bridge keeps Error.stack (JSON.stringify would lose it)',
  app.includes('typeof a.stack==="string"'));
check('diagnostic reports plugin load state + plugin setting tabs',
  app.includes('已注册插件设置页') && app.includes('loadingPluginId='));
check('diagnostic appends the console.log tail',
  app.includes('appendLogTail') && app.includes('本会话日志'));
check('plugin setting-tab repair shim present (BRAT onLayoutReady throw)',
  app.includes('function ohsidianRepairPluginSettingTabs(') &&
  app.includes('plugin setting tab registered late') &&
  app.includes('设置页自愈: '));
check('BRAT bundle fingerprint + failure source locator present',
  app.includes('BRAT main.js 指纹') &&
  app.includes('__ohsidianPluginTabError') &&
  app.includes('失败位置（'));
check('BRAT fingerprint normalizes the install transform (no false positive)',
  app.includes('归一化(去掉内核追加的 nosourcemap 标记)') &&
  app.includes('安装时追加的 +18 B 标记属正常'));
check('diagnostic detects a plugin file replaced after boot',
  app.includes('BRAT 文件时效') && app.includes('stale(文件晚于本会话启动)'));

/* ---- Behaviour: synthetic downloads ------------------------------------- */
if (fetchSrc) {
  /* Rebuild the kernel's REAL transform constants from the shipped app.js:
     TV strips sourceMappingURL data URLs, IV appends the nosourcemap marker
     that loadPlugin expects. Feeding our own copies would let a future kernel
     rename make every market install "download incomplete" while this gate
     stayed green (audit 2026-11-22, P2-1). */
  let TV = null;
  let IV = null;
  const tvIdx = app.indexOf('TV=/^');
  if (tvIdx >= 0) {
    const tvEnd = app.indexOf('/gm', tvIdx);
    if (tvEnd > tvIdx) {
      try { TV = eval(app.slice(tvIdx + 3, tvEnd + 3)); } catch (e) { TV = null; }
    }
  }
  const ivIdx = app.indexOf('IV=`');
  if (ivIdx >= 0) {
    const ivEnd = app.indexOf('`', ivIdx + 4);
    if (ivEnd > ivIdx) {
      try { IV = eval(app.slice(ivIdx + 3, ivEnd + 1)); } catch (e) { IV = null; }
    }
  }
  check('kernel TV/IV transform constants extractable', TV instanceof RegExp && typeof IV === 'string');
  check('kernel transform: TV is the sourcemap regex, IV the nosourcemap marker',
    TV instanceof RegExp && /nosourcemap/.test(IV));
  const body = Array.from({ length: 4000 }, (_, i) => 'var v' + i + '=' + i + ';').join('\n') +
    '\n;(function(){return 1;})();';
  /* Deterministic truncation: the final construct is left unclosed, exactly the
     shape a mid-body connection reset leaves behind. A cut at an arbitrary
     array index can land on a statement boundary and still parse, which would
     make this gate pass for the wrong reason. */
  const truncated = body.slice(0, body.length - 8);
  const manifest = JSON.stringify({ id: 'fixture-plugin', name: 'Fixture', version: '1.0.0' });
  const REPO = 'fixture/repo';
  const VER = '1.0.0';
  const Xm = (repo, ver, file) =>
    'https://github.com/' + repo + '/releases/download/' + ver + '/' + file;
  const MURL = Xm(REPO, VER, 'manifest.json');
  const JURL = Xm(REPO, VER, 'main.js');
  const SURL = Xm(REPO, VER, 'styles.css');
  const PROXY = 'https://releases.obsidian.md/proxy?url=' + encodeURIComponent(JURL);
  class Kp extends Error { }
  function baseRoutes() {
    return { [MURL]: { body: manifest }, [JURL]: { body }, [SURL]: { body: 'body{color:red}' } };
  }
  /* The shipped helper is evaluated with the SAME kernel constants and the
     same `sr`/`Xm` contract (sr returns an object whose .text is a promise). */
  function makeUEe(routes, calls) {
    const sr = (url) => {
      calls.push(url);
      const r = routes[url];
      const p = !r ? Promise.reject(new Kp('Request failed, status 404', 404))
        : r.err ? Promise.reject(r.err) : Promise.resolve(r.body);
      return { text: p };
    };
    const quiet = { warn() { }, error() { }, log() { } };
    return new Function('sr', 'Xm', '$h', 'UT', 'qT', 'TV', 'IV', 'kp', 'console',
      fetchSrc + '\nreturn UEe;')(sr, Xm, 'manifest.json', 'main.js', 'styles.css', TV, IV, Kp, quiet);
  }
  const run = (UEe) => UEe(REPO, VER).then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, e }));

  Promise.resolve()
    .then(() => {
      const calls = [];
      const UEe = makeUEe(baseRoutes(), calls);
      return run(UEe).then((r) => {
        check('behaviour: complete download accepted',
          r.ok && r.v.manifest === manifest && r.v.main === body.replace(TV, '') + IV &&
          r.v.styles === 'body{color:red}');
        check('behaviour: complete download is not re-fetched', calls.indexOf(PROXY) === -1);
      });
    })
    .then(() => {
      const calls = [];
      const routes = baseRoutes();
      routes[JURL] = { body: truncated };
      routes[PROXY] = { body };
      const UEe = makeUEe(routes, calls);
      return run(UEe).then((r) => {
        check('behaviour: truncated body is retried through the proxy',
          r.ok && r.v.main === body.replace(TV, '') + IV);
        check('behaviour: proxy retried exactly once',
          calls.filter((u) => u === PROXY).length === 1);
      });
    })
    .then(() => {
      const routes = baseRoutes();
      routes[JURL] = { body: truncated };
      routes[PROXY] = { body: truncated };
      return run(makeUEe(routes, [])).then((r) => {
        check('behaviour: doubly truncated download is rejected',
          !r.ok && r.e && r.e.__ohsidianPluginDownloadIncomplete === true);
      });
    })
    .then(() => {
      const calls = [];
      const routes = baseRoutes();
      routes[JURL] = { err: new Error('connection reset') };
      return run(makeUEe(routes, calls)).then((r) => {
        check('behaviour: plain network error propagates untouched',
          !r.ok && /connection reset/.test(r.e && r.e.message) &&
          r.e.__ohsidianPluginDownloadIncomplete !== true && calls.indexOf(PROXY) === -1);
      });
    })
    .then(() => {
      const routes = baseRoutes();
      routes[JURL] = { body: '' };
      return run(makeUEe(routes, [])).then((r) => {
        check('behaviour: empty body is rejected as incomplete',
          !r.ok && r.e && r.e.__ohsidianPluginDownloadIncomplete === true);
      });
    })
    .catch((e) => {
      console.error('  FAIL behavioural check crashed: ' + (e && e.message));
      failures++;
    })
    .then(() => {
      /* ---- NF-018: shipped k6 fallback expression ---------------------- */
      const k6Start = app.indexOf('this.safeStorage=(function(){');
      const k6End = app.indexOf('})()}', k6Start);
      const iife = k6Start >= 0 && k6End > k6Start
        ? app.slice(k6Start + 'this.safeStorage='.length, k6End + '})()'.length) : '';
      check('safeStorage adapter fallback expression extractable', iife.startsWith('(function(){'));
      if (!iife.startsWith('(function(){')) return;
      const make = new Function('window', 'return ' + iife);
      const real = {
        isEncryptionAvailable: () => false,
        getSelectedStorageBackend: () => 'basic_text',
        encryptString: (s) => s,
        decryptString: (s) => s,
      };
      const threeOnly = { isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s };
      const fallback = { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text', encryptString: (s) => String(s), decryptString: (s) => String(s) };
      /* The adapter deliberately logs one console.warn per fallback; keep the
         gate output clean. */
      const savedWarn = console.warn;
      console.warn = () => {};
      try {
        check('behaviour: engine safeStorage preferred when complete',
          make({ electron: { remote: { safeStorage: real } } }) === real);
        check('behaviour: missing engine safeStorage -> plaintext fallback',
          make({ __ohsidianSafeStorageFallback: fallback }) === fallback);
        check('behaviour: 3-method engine object is not trusted (falls back)',
          make({ electron: { remote: { safeStorage: threeOnly } }, __ohsidianSafeStorageFallback: fallback }) === fallback);
        const bare = make({});
        check('behaviour: no remote at all -> usable plaintext adapter',
          !!bare && bare.isEncryptionAvailable() === false &&
          bare.encryptString('t') === 't' && bare.decryptString('t') === 't' &&
          bare.getSelectedStorageBackend() === 'basic_text');
      } finally {
        console.warn = savedWarn;
      }
    })
    .then(async () => {
      /* ---- on-device integrity diagnostic (shipped function) ----------- */
      const diagStart = app.indexOf('function ohsidianRunPluginIntegrityProbe(');
      const diagEnd = diagStart >= 0 ? app.indexOf('/* One-glance answer', diagStart) : -1;
      check('integrity diagnostic present in app.js', diagStart >= 0 && diagEnd > diagStart);
      if (diagStart < 0 || diagEnd <= diagStart) return;
      const diagSrc = app.slice(diagStart, diagEnd).replace(/\s+$/, '');
      const truncBody = 'var a=1;\n;(function(){';
      const goodBody = 'var a=1;\nmodule.exports={onload:function(){}};';
      const sizes = {
        '.obsidian/plugins/good/main.js': goodBody.length,
        '.obsidian/plugins/bad/main.js': truncBody.length,
        '.obsidian/plugins/huge/main.js': 7 * 1024 * 1024,
      };
      const bodies = {
        '.obsidian/plugins/good/main.js': goodBody,
        '.obsidian/plugins/bad/main.js': truncBody,
        '.obsidian/plugins/huge/main.js': goodBody,
      };
      const manifests = {
        good: { dir: '.obsidian/plugins/good', id: 'good' },
        bad: { dir: '.obsidian/plugins/bad', id: 'bad' },
        huge: { dir: '.obsidian/plugins/huge', id: 'huge' },
        gone: { dir: '.obsidian/plugins/gone', id: 'gone' },
      };
      const adapter = {
        stat(p) { return (p in sizes) ? Promise.resolve({ size: sizes[p] }) : Promise.reject(new Error("ENOENT " + p)); },
        read(p) { return (p in bodies) ? Promise.resolve(bodies[p]) : Promise.reject(new Error("ENOENT " + p)); },
        exists() { return Promise.resolve(false); },
      };
      const captured = {};
      const fakeWindow = {
        app: {
          secretStorage: { isEncryptionAvailable: () => false, adapter: {}, listSecrets: () => [] },
          vault: { adapter },
          plugins: { manifests },
        },
        electron: { remote: {} },
      };
      const factory = new Function("window", "ohsidianShowReportModal", "OHSIDIAN_PATCH_REV", "Date",
        diagSrc + "\nreturn ohsidianRunPluginIntegrityProbe;");
      const runDiag = factory(fakeWindow, (title, lines) => { captured.title = title; captured.lines = lines; }, "196", Date);
      runDiag();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const text = (captured.lines || []).join("\n");
      check("diagnostic: opens the report modal", !!captured.title && Array.isArray(captured.lines));
      check("diagnostic: plaintext secretStorage reported as usable", /WARN/.test(text) && /isEncryptionAvailable=false/.test(text));
      check("diagnostic: truncated plugin flagged BAD", /BAD bad/.test(text));
      check("diagnostic: unreadable plugin flagged BAD", /BAD gone/.test(text));
      check("diagnostic: huge plugin size-only (no synchronous parse)", /只报大小/.test(text));
      check("diagnostic: verdict counts both failures", /失败: 2/.test(text));
    })
    .then(async () => {
      /* ---- rev201: plugin error recorder (attribution + persistence) ---- */
      const recStart = app.indexOf('var OHSIDIAN_PLUGIN_ERR_MAX=');
      const recEnd = recStart >= 0 ? app.indexOf('/* NF-015 / NF-018 on-device adjudication', recStart) : -1;
      check('plugin error recorder present in app.js', recStart >= 0 && recEnd > recStart);
      if (recStart < 0 || recEnd <= recStart) return;
      const recSrc = app.slice(recStart, recEnd);
      const os = require("os");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ohsidian-recerr-"));
      const Notice = function () {};
      const api = new Function("require", "readMode", "dataDir", "Notice", "console", "setTimeout", "clearTimeout",
        recSrc + "\nreturn {rec:ohsidianRecordConsoleError, ensure:ohsidianEnsurePluginErrors, clear:ohsidianClearPluginErrors, path:ohsidianPluginErrorsPath, file:ohsidianPluginErrorsPath};")(
        require,
        () => ({}),
        () => tmpDir,
        Notice,
        { error: () => {}, log: () => {}, warn: () => {} },
        setTimeout,
        clearTimeout);
      const stackErr = new Error("Cannot read properties of undefined");
      stackErr.stack = "TypeError: Cannot read properties of undefined\n    at je.getSettingDefinitions (plugin:obsidian42-brat:85:6305)";
      api.rec([stackErr]);
      api.rec([stackErr]); // consecutive duplicate must be collapsed
      api.rec(["Plugin failure: nutstore-sync", new Error("SyntaxError: Unexpected token")]);
      api.rec(["OHSidian diagnostic without attribution", { message: "x" }]);
      const recList = api.ensure();
      const bratEntry = recList.find((e) => e.plugin === 'obsidian42-brat');
      check('recorder attributes plugin errors from the sourceURL stack',
        !!bratEntry && bratEntry.source && bratEntry.source.line === 85 && bratEntry.source.col === 6305);
      check('recorder attributes kernel "Plugin failure:" lines',
        recList.some((e) => e.plugin === 'nutstore-sync'));
      check('recorder ignores errors without plugin attribution',
        !recList.some((e) => (e.line || '').indexOf('diagnostic without attribution') >= 0));
      check('recorder dedupes consecutive identical errors',
        !!bratEntry && bratEntry.count >= 2);
      await new Promise((r) => setTimeout(r, 900));
      check('recorder persists plugin-errors.json', fs.existsSync(api.path()) &&
        JSON.parse(fs.readFileSync(api.path(), "utf8")).length >= 2);
      api.clear();
      check('clear command removes the records file', !fs.existsSync(api.path()) && api.ensure().length === 0);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    })
    .then(() => {
      /* ---- rev204: log tail keeps only the current session ---- */
      const ltStart = app.indexOf('function ohsidianLogTailLines(max){');
      const ltEnd = ltStart >= 0 ? app.indexOf('function ohsidianConsoleCaptureLabel(){', ltStart) : -1;
      check('session log filter present in app.js', ltStart >= 0 && ltEnd > ltStart);
      if (ltStart < 0 || ltEnd <= ltStart) return;
      const ltSrc = app.slice(ltStart, ltEnd);
      const os = require("os");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ohsidian-logtail-"));
      const logFile = path.join(dir, "console.log");
      fs.writeFileSync(logFile, [
        "[2026-11-22T03:00:00.000Z] [OHSidian:web][error] old failure",
        "    at oldStack (plugin:old:1:2)",
        "[2026-11-22T04:05:00.000Z] [OHSidian:web][error] new failure",
        "    at newStack (plugin:new:3:4)",
        "",
      ].join("\n"), "utf8");
      const getTail = new Function('require', 'window', 'ohsidianConsoleLogPath',
        ltSrc + '\nreturn ohsidianLogTailLines;')(require,
        { __ohsidianBootAt: Date.parse("2026-11-22T04:00:00Z") },
        () => logFile);
      const linesOut = getTail(40).join("\n");
      check('session log filter drops earlier boots',
        linesOut.includes("new failure") && linesOut.includes("newStack") &&
        !linesOut.includes("old failure") && !linesOut.includes("oldStack"));
      check('session log filter reports how many historical lines were folded',
        linesOut.includes("已折叠更早会话"));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    })
    .then(() => {
      console.log(failures ? 'PLUGIN-INSTALL VERIFY: FAILURES' : 'PLUGIN-INSTALL VERIFY: OK');
      process.exit(failures ? 1 : 0);
    });
} else {
  console.log('PLUGIN-INSTALL VERIFY: FAILURES');
  process.exit(1);
}
