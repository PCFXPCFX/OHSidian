import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeReport(dir, { scenario, profile, summary, issues, logLines, screenshots, meta }) {
  ensureDir(dir);
  const jsonPath = path.join(dir, 'report.json');
  fs.writeFileSync(jsonPath, JSON.stringify({
    scenario, profile, summary, issues, screenshots, meta,
    generatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  const lines = [];
  lines.push(`# OHSidian 真机报告：${scenario?.name || '(unknown)'}`);
  lines.push('');
  lines.push(`- 时间：${new Date().toISOString()}`);
  lines.push(`- 设备：${profile?.name || '?'} · ${profile?.screen?.cssW || '?'}x${profile?.screen?.cssH || '?'} @${profile?.dpr || '?'}`);
  lines.push(`- HAP：${meta?.hap || '?'}`);
  lines.push('');
  lines.push('## 指标');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  const m = [
    ['fake worker', summary.fakeWorker],
    ['docLoaded', summary.docLoaded ? summary.docLoaded.ms + ' ms' : '-'],
    ['pagesInit', summary.pagesInit ? summary.pagesInit.ms + ' ms' : '-'],
    ['首页渲染', summary.firstPageMs != null ? summary.firstPageMs + ' ms' : '-'],
    ['最慢页', summary.maxPageMs + ' ms'],
    ['白页', `${summary.whitePages}/${summary.pageCount} (${(summary.whiteRate * 100).toFixed(0)}%)`],
    ['重载', summary.reloads],
    ['viewer 替换', summary.viewerReplaced],
    ['写回', summary.write ? `${summary.write.ms} ms / ok=${summary.write.ok}` : '-'],
  ];
  for (const [k, v] of m) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('## 诊断');
  lines.push('');
  if (!issues.length) {
    lines.push('未命中已知异常规则。');
  } else {
    for (const it of issues) {
      lines.push(`### [${it.severity}] ${it.code}`);
      lines.push('');
      lines.push(it.message);
      lines.push('');
      lines.push(`建议：${it.suggestion}`);
      lines.push('');
    }
  }
  if (summary.pages && summary.pages.length) {
    lines.push('## 每页');
    lines.push('');
    lines.push('| 页 | ms | CSS 尺寸 | dpr | white | afterWrite |');
    lines.push('|---:|---:|---|---:|---|---:|');
    for (const p of summary.pages) {
      lines.push(`| ${p.page} | ${p.ms} | ${p.w}x${p.h} | ${p.scale} | ${p.white} | ${p.afterWrite} |`);
    }
    lines.push('');
  }
  if (summary.payload) {
    lines.push('## 写入 payload（抽查）');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(summary.payload, null, 2));
    lines.push('```');
    lines.push('');
  }
  if (summary.write) {
    lines.push('## 写回结果');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(summary.write, null, 2));
    lines.push('```');
    lines.push('');
  }
  if (screenshots && screenshots.length) {
    lines.push('## 截图');
    lines.push('');
    for (const s of screenshots) lines.push(`- ${s}`);
    lines.push('');
  }
  lines.push('## 原始日志');
  lines.push('');
  lines.push('```text');
  lines.push((logLines || []).join('\n').slice(0, 60000));
  lines.push('```');
  fs.writeFileSync(path.join(dir, 'report.md'), lines.join('\n'), 'utf8');
  return { dir, jsonPath, mdPath: path.join(dir, 'report.md') };
}
