/* pandoc-on-WebAssembly utility-process host (rev208).
 *
 * The HarmonyOS engine starts V8 "jitless" (V8 flag --jitless), which makes
 * `WebAssembly` undefined in the renderer AND in the main process even though
 * the engine binary is built with v8_enable_webassembly=1. Re-enabling JS JIT
 * in the UI processes is risky on this platform, so pandoc runs in a separate
 * utility process started with --no-jitless: only that process gets executable
 * memory, and a crash there cannot take down the app.
 *
 * Runs inside Electron's utilityProcess: messages arrive via process.parentPort
 * as {id, kind, ...}, replies are posted back as {id, ok, result|error}.
 */
const path = require('path');
const api = require(path.join(__dirname, 'pandoc-service.cjs'));

let service = null;
let lastError = '';

function ensure(req) {
  if (service) return service;
  service = api.createService(api.createPandocInstance, {
    wasmGzPath: path.join(__dirname, 'pandoc.wasm.gz'),
    version: (req && req.version) || require(path.join(__dirname, 'pandoc-version.txt')).toString().trim(),
    // utility processes start with cwd=/ (not writable); self-test/output temp
    // files must go to the app temp dir published by the main process.
    tmpDir: (req && req.tmpDir) || process.env.TMPDIR || process.env.TEMP || '',
  });
  return service;
}

const parentPort = process.parentPort || null;
function post(msg) {
  try {
    if (parentPort) parentPort.postMessage(msg);
    else if (process.send) process.send(msg);
  } catch (e) {
    /* parent gone */
  }
}
function reply(id, ok, payload) {
  post({ id: id, ok: ok, result: payload });
}
function onMessage(handler) {
  if (parentPort) parentPort.on('message', function (event) { handler(event && event.data ? event.data : event); });
  else process.on('message', handler);
}

onMessage(function (msg) {
  if (!msg || typeof msg !== 'object') return;
  const id = msg.id;
  try {
    const svc = ensure(msg);
    const job = msg.kind === 'selfTest'
      ? svc.selfTest()
      : msg.kind === 'query'
        ? svc.query(msg.query)
        : msg.kind === 'info'
          ? Promise.resolve(svc.info())
          : svc.runCli({ argv: msg.argv, stdin: msg.stdin, cwd: msg.cwd });
    Promise.resolve(job).then(function (result) {
      reply(id, true, result);
    }, function (e) {
      lastError = String((e && e.message) || e);
      reply(id, false, lastError);
    });
  } catch (e) {
    lastError = String((e && e.message) || e);
    reply(id, false, lastError);
  }
});

try {
  post({
    boot: true,
    wasm: typeof WebAssembly,
    execArgv: process.execArgv,
    node: process.versions && process.versions.node,
    lastError: lastError,
  });
} catch (e) {
  /* parent gone */
}
