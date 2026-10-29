import fs from 'node:fs';

const PROBE = /InkUI\s+probe:([a-zA-Z0-9_:-]+)\s*(\{.*\})?\s*$/;
const TRACE = /InkUI\s+([a-zA-Z0-9_:-]+)\s*(.*)$/;
const PFW = /^(.*?)\s*PdfInkWriter\s+(.*)$/;
const PDFINK = /^(.*?)\s*PdfInk\s+(.*)$/;

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

export function parseLogText(text) {
  const events = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    let m = PROBE.exec(line);
    if (m) {
      events.push({ kind: 'probe', event: m[1], data: safeJson(m[2]) || {}, line });
      continue;
    }
    m = TRACE.exec(line);
    if (m) {
      events.push({ kind: 'trace', event: m[1], detail: m[2] || '', line });
      continue;
    }
    m = PFW.exec(line);
    if (m) {
      events.push({ kind: 'pdfinkwriter', detail: m[2], line });
      continue;
    }
    m = PDFINK.exec(line);
    if (m) {
      events.push({ kind: 'pdfink', detail: m[2], line });
      continue;
    }
    if (/Setting up fake worker/i.test(line)) {
      events.push({ kind: 'fake-worker', line });
    }
  }
  return events;
}

export function readLogFile(file) {
  return parseLogText(fs.readFileSync(file, 'utf8'));
}

export function summarize(events) {
  const probes = events.filter((e) => e.kind === 'probe');
  const get = (name) => probes.filter((e) => e.event === name);
  const boot = get('boot')[0]?.data || null;
  const doc = get('pdfDocLoaded')[0]?.data || null;
  const pagesInit = get('pdfPagesInit')[0]?.data || null;
  const pageEvents = get('pdfPage');
  const pages = pageEvents.map((e) => e.data);
  const reloads = get('pdfReload');
  const viewerReplaced = get('pdfViewerReplaced');
  const writes = get('pdfWriteEnd');
  const payloads = get('pdfPayload');
  const white = pages.filter((p) => p && p.white === true);
  const fakeWorker = (boot && boot.fakeWorker) ||
    (doc && doc.fakeWorker) ||
    (pages[0] && pages[0].fakeWorker) || 0;
  return {
    boot,
    docLoaded: doc,
    pagesInit,
    pageCount: pages.length,
    pages,
    firstPageMs: pages.length ? pages[0].ms : null,
    maxPageMs: pages.reduce((a, p) => Math.max(a, p.ms || 0), 0),
    whitePages: white.length,
    whiteRate: pages.length ? white.length / pages.length : 0,
    reloads: reloads.length,
    reload: reloads[0]?.data || null,
    viewerReplaced: viewerReplaced.length,
    write: writes.length ? writes[writes.length - 1].data : null,
    writes: writes.map((e) => e.data),
    payload: payloads.length ? payloads[payloads.length - 1].data : null,
    fakeWorker,
  };
}

export function diagnose(summary, expect = {}) {
  const issues = [];
  const push = (severity, code, message, suggestion) =>
    issues.push({ severity, code, message, suggestion });

  if (summary.fakeWorker > 0) {
    push('P0', 'fake-worker',
      'pdf.js 退回了主线程 worker（fake worker）：解析/字体/图像解码全部阻塞 UI，直接对应“加载慢、白页”。',
      '检查 app:// 响应的 Content-Type（main.js 的 MIME map）以及 pdf.worker.min.mjs 是否可被 module worker 加载。');
  }
  if (!summary.docLoaded) {
    push('P1', 'no-docloaded',
      '没有收到 pdfDocLoaded 探针：PDF 可能未打开、surface 未创建，或日志未清空/未启用。',
      '确认当前在 PDF 视图；run 前会自动 hilog -r，打开 PDF 后再采集。');
  } else if (summary.docLoaded.ms > (expect.maxDocLoadedMs || 4000)) {
    push('P1', 'slow-docloaded',
      `PDF 首次解析 ${summary.docLoaded.ms}ms，超过阈值 ${expect.maxDocLoadedMs || 4000}ms。`,
      '先看 fakeWorker；再测文件大小/字体；必要时延后叠层挂载。');
  }
  if (summary.firstPageMs != null && summary.firstPageMs > (expect.maxFirstPageMs || 2500)) {
    push('P1', 'slow-first-page',
      `首页栅格 ${summary.firstPageMs}ms，超过阈值 ${expect.maxFirstPageMs || 2500}ms。`,
      '检查 dpr/页面像素数、worker、是否同时有 detail canvas。');
  }
  if (summary.whiteRate > (expect.maxWhiteRate ?? 0.15)) {
    push('P0', 'white-pages',
      `${summary.whitePages}/${summary.pageCount} 页采样为白（${(summary.whiteRate * 100).toFixed(0)}%）。`,
      '先排除 fake worker 与写回后重载；再看 PDF 文件是否被写坏（校验日志）。');
  }
  if (summary.reloads > 0 && summary.reload && summary.reload.afterWrite >= 0) {
    push('P1', 'reload-after-write',
      `写回后 ${summary.reload.afterWrite}ms 发生 PDF 重载（reloads=${summary.reloads}）。`,
      '把“写回时机”改为离开 PDF 时，避免替换正在打开的文件。');
  }
  if (summary.write && !summary.write.ok) {
    push('P0', 'write-failed', `PDF 写回失败：${summary.write.error || '未知'}。`,
      '查看 PdfInkWriter timing 日志；确认不是超时/文件锁/校验失败。');
  }
  if (summary.write && summary.write.ms > (expect.maxWriteMs || 15000)) {
    push('P1', 'slow-write',
      `PDF 写回 ${summary.write.ms}ms，超过阈值 ${expect.maxWriteMs || 15000}ms。`,
      '检查 parse/save/verify 各阶段耗时；大文件可减少单页笔画或延后写回。');
  }
  if (summary.payload && summary.payload.sample) {
    const s = summary.payload.sample;
    if (s.some((x) => !x.first || !x.last || x.n < 2)) {
      push('P2', 'short-strokes',
        '有笔画点数 <2 或首尾为空；可能产生点/短线异常。',
        '写入前过滤 n<2 的笔画。');
    }
  }
  return issues;
}
