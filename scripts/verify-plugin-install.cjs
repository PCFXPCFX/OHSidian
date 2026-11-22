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

/* ---- NF-015: the prefetch helper as shipped ------------------------------ */
const HELPER_START = 't.prototype.__ohsidianFetchPluginBundle=function(manifestUrl,mainUrl){';
const helperStart = app.indexOf(HELPER_START);
const helperEnd = helperStart >= 0 ? app.indexOf(',t.prototype.installPlugin=function', helperStart) : -1;
const helperSrc = helperStart >= 0 && helperEnd > helperStart ? app.slice(helperStart, helperEnd) : null;
check('install prefetch helper present in app.js', !!helperSrc);
check('install prefetch ends at its statement boundary (comma-joined, no ;)',
  !!helperSrc && helperSrc.trimEnd().endsWith('}') && !helperSrc.trimEnd().endsWith(';'));
check('install prefetch validates with new Function (loadPlugin parity)',
  !!helperSrc && helperSrc.includes('new Function(String(resp.text).replace(f4,"")+v4)'));
check('install prefetch retries through the release proxy',
  !!helperSrc && helperSrc.includes('releases.obsidian.md/proxy?url='));
check('install prefetch marks the rejection as incomplete',
  !!helperSrc && helperSrc.includes('__ohsidianPluginDownloadIncomplete=true'));
/* ---- Structural + runtime: the helper is one element of the minified class
   body's `return v(t,e),method=...,t` comma expression. A semicolon there ends
   the return early, the factory yields the helper function instead of the
   PluginManager class, `new Plugins(app)` produces the helper's Promise and
   Obsidian fails at boot with "i.app.plugins.on is not a function" (device
   report 2026-11-22). Marker checks cannot see this, so evaluate the shipped
   factory and assert that it really is the class. ---- */
check('install helper joins the class method list with a comma',
  app.includes('},t.prototype.installPlugin=function(e,t,n){'));
check('install helper does not terminate the class return early',
  !/};\s*t\.prototype\.installPlugin=/.test(app));
(function verifyShippedPluginManagerClass() {
  const ctorAnchor = 'i.manifests={},i.plugins={}';
  const ctor = app.indexOf(ctorAnchor);
  check('PluginManager constructor found in app.js', ctor >= 0);
  if (ctor < 0) return;
  const before = app.slice(Math.max(0, ctor - 160), ctor);
  const m = before.match(/var ([A-Za-z_$][\w$]*)=function\(e\)\{function t\(t\)\{var n,i=e\.call\(this\)\|\|this;return\s*$/);
  check('PluginManager factory start locatable', !!m);
  if (!m) return;
  const name = m[1];
  const start = app.lastIndexOf('var ' + name + '=function(e){', ctor);
  const endMarker = ',t}(FD)';
  const end = app.indexOf(endMarker, ctor);
  check('PluginManager factory end locatable', start >= 0 && end > start);
  if (start < 0 || end <= start) return;
  /* include the comma-returned class and the `(FD)` invocation, otherwise this
     would only evaluate the outer wrapper function, not its result */
  const factorySrc = app.slice(start, end + endMarker.length);
  const stub = new Proxy(function () {}, {
    get: (t, p) => (p === Symbol.toPrimitive ? () => 'stub' : stub),
    apply: () => stub,
    construct: () => stub,
  });
  const envBase = {
    v: function (t, e) {
      t.prototype = e && e.prototype ? Object.create(e.prototype) : {};
      t.prototype.constructor = t;
    },
  };
  /* With-scope proxy: every unresolved identifier is a stub. Symbol.unscopables
     MUST stay undefined, otherwise the with-lookup treats every name as
     unscopable and falls through to the real global scope ("FD is not defined"). */
  const env = new Proxy(envBase, {
    has: () => true,
    get: (t, p) => (p === Symbol.unscopables ? undefined : (p in t ? t[p] : stub)),
  });
  let T = null;
  try {
    T = new Function('__env', 'with(__env){' + factorySrc + '\nreturn ' + name + ';}')(env);
  } catch (e) {
    check('PluginManager factory evaluates', false);
    return;
  }
  check('PluginManager factory yields the class (not the helper)',
    typeof T === 'function' && !!T.prototype &&
    typeof T.prototype.installPlugin === 'function' &&
    typeof T.prototype.enablePlugin === 'function' &&
    typeof T.prototype.checkForUpdates === 'function' &&
    typeof T.prototype.__ohsidianFetchPluginBundle === 'function');
})();
check('installPlugin wires the validating prefetch into case 1',
  app.includes('case 1:return m.trys.push([1,3,,4]),[4,this.__ohsidianFetchPluginBundle(Py(e,t,eL),Py(e,t,tL))];'));
check('installPlugin unpacks the pair (a=manifest, d=main)',
  app.includes('case 2:return l=m.sent(),a=l[0],d=l[1],(s=JSON.parse(a)).id&&s.id===i?[3,4]:'));
check('installPlugin still writes the MANIFEST text (a) as manifest.json',
  app.includes('case 10:return[4,(p=c.adapter).write(h+"/"+eL,a)]'));
check('installPlugin writes the PREFETCHED main.js text (d) as main.js',
  app.includes('case 12:return m.trys.push([12,15,,16]),[4,(d&&d.length?d:zy(Py(e,t,tL)).then(function(resp){return resp.text}))];') &&
  app.includes('f=d.replace(f4,"")+v4,[4,p.write(h+"/"+tL,f)]'));
check('install failure surface names the truncation',
  app.includes('插件文件下载不完整（疑似网络截断）'));
check('load failure names a truncated main.js',
  app.includes('插件文件下载不完整') && app.includes('plugin file unparsable'));

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
if (helperSrc) {
  /* Use the KERNEL's real f4/v4 values, extracted from the shipped app.js.
     Feeding our own copies would let a kernel-symbol rename turn every market
     install into "download incomplete" while this gate stayed green
     (audit 2026-11-22, P2-1). */
  const fvDef = app.match(/f4=(\/\^[\s\S]*?\/gm),v4=("(?:[^"\\]|\\.)*")/);
  check('kernel f4/v4 transform constants extractable', !!fvDef);
  let f4 = null;
  let v4 = null;
  if (fvDef) {
    try {
      f4 = eval(fvDef[1]);
      v4 = eval(fvDef[2]);
    } catch (e) {
      f4 = null;
      v4 = null;
    }
  }
  check('kernel transform: f4 is the sourcemap regex, v4 the marker comment',
    f4 instanceof RegExp && typeof v4 === 'string' && /nosourcemap/.test(v4));
  const body = Array.from({ length: 4000 }, (_, i) => 'var v' + i + '=' + i + ';').join('\n') +
    '\n;(function(){return 1;})();';
  /* Deterministic truncation: the final construct is left unclosed, exactly the
     shape a mid-body connection reset leaves behind. A cut at an arbitrary
     array index can land on a statement boundary and still parse, which would
     make this gate pass for the wrong reason. */
  const truncated = body.slice(0, body.length - 8);
  const manifest = JSON.stringify({ id: 'fixture-plugin', name: 'Fixture', version: '1.0.0' });
  const MURL = 'https://github.com/fixture/repo/releases/download/1.0.0/manifest.json';
  const JURL = 'https://github.com/fixture/repo/releases/download/1.0.0/main.js';
  const PROXY = 'https://releases.obsidian.md/proxy?url=' + encodeURIComponent(JURL);

  function makeHelper(routes, calls) {
    const fakeZy = function (url) {
      calls.push(url);
      const r = routes[url];
      if (!r) return Promise.reject(new Error('HTTP 404 ' + url));
      if (r.err) return Promise.reject(r.err);
      return Promise.resolve({ text: r.body, headers: {}, arrayBuffer: Buffer.from(r.body) });
    };
    const quiet = { warn: () => {}, error: () => {}, log: () => {} };
    const T = new Function('t', 'f4', 'v4', 'zy', 'console', helperSrc + '\nreturn t;')(
      function t() {}, f4, v4, fakeZy, quiet);
    return new T();
  }

  function run(inst, mu, ju) {
    return inst.__ohsidianFetchPluginBundle(mu, ju).then(
      (v) => ({ ok: true, v }),
      (e) => ({ ok: false, e }));
  }

  Promise.resolve()
    .then(() => {
      const calls = [];
      const inst = makeHelper({ [MURL]: { body: manifest }, [JURL]: { body } }, calls);
      return run(inst, MURL, JURL).then((r) => {
        check('behaviour: complete download accepted', r.ok && r.v[0] === manifest && r.v[1] === body);
        check('behaviour: complete download is not re-fetched', calls.indexOf(PROXY) === -1);
      });
    })
    .then(() => {
      const calls = [];
      const inst = makeHelper({
        [MURL]: { body: manifest },
        [JURL]: { body: truncated },
        [PROXY]: { body },
      }, calls);
      return run(inst, MURL, JURL).then((r) => {
        check('behaviour: truncated body is retried through the proxy', r.ok && r.v[1] === body);
        check('behaviour: proxy retried exactly once', calls.filter((u) => u === PROXY).length === 1);
      });
    })
    .then(() => {
      const inst = makeHelper({
        [MURL]: { body: manifest },
        [JURL]: { body: truncated },
        [PROXY]: { body: truncated },
      }, []);
      return run(inst, MURL, JURL).then((r) => {
        check('behaviour: doubly truncated download is rejected',
          !r.ok && r.e && r.e.__ohsidianPluginDownloadIncomplete === true);
      });
    })
    .then(() => {
      const calls = [];
      const inst = makeHelper({ [MURL]: { body: manifest }, [JURL]: { err: new Error('connection reset') } }, calls);
      return run(inst, MURL, JURL).then((r) => {
        check('behaviour: plain network error propagates untouched',
          !r.ok && /connection reset/.test(r.e && r.e.message) &&
          r.e.__ohsidianPluginDownloadIncomplete !== true && calls.indexOf(PROXY) === -1);
      });
    })
    .then(() => {
      const inst = makeHelper({ [MURL]: { body: manifest }, [JURL]: { body: '' } }, []);
      return run(inst, MURL, JURL).then((r) => {
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
      const k6Start = app.indexOf('n.safeStorage=(function(){');
      const k6End = app.indexOf('})(),n}', k6Start);
      const iife = k6Start >= 0 && k6End > k6Start
        ? app.slice(k6Start + 'n.safeStorage='.length, k6End + '})()'.length) : '';
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
