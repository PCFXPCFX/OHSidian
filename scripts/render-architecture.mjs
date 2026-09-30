#!/usr/bin/env node
/**
 * 重新生成 docs/images/ 下的两张架构图（SVG + PNG）：
 *   architecture.png     中文版（README.md 引用）
 *   architecture.en.png  英文版（README_EN.md 引用）
 *
 * 用法：node scripts/render-architecture.mjs
 *   或：cd scripts && npm run render-architecture
 *
 * 升级 Obsidian 内核版本时，只需改下方 I18N 表中两个 locale 的 obTitle
 * （如 'Obsidian 1.14.0'）；增删层级、改子项或示例芯片时，改 buildLayers
 * 返回的层级定义。改完运行本脚本，四张图（两语言 × SVG/PNG）同步再生。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs', 'images');

/** 图表文案：按 locale 维护，改版本号/措辞在这里。 */
const I18N = {
  zh: {
    fileBase: 'architecture',
    obTitle: 'Obsidian 1.13.7',
    obSub: 'obsidian.asar · 官方签名产物 + 可复现运行时补丁',
    electronLabel: 'Electron API 兼容层',
    electronItems: ['@electron/remote', 'Node.js 运行时', 'main.js 包装器'],
    jsbind: 'JSBind 桥接层',
    libadapter: 'C++ 原生库 libadapter.so · 核心系统级 API 对接',
    arktsLabel: 'ArkTS 适配层 · 约 50 个适配器',
    arktsChips: ['FileSys', 'IME', 'Notify', 'Theme', 'Window', 'Device', 'Dialog'],
    osTitle: 'HarmonyOS 原生运行时',
    osSub: 'Ability · ArkUI · 系统服务 Kit',
  },
  en: {
    fileBase: 'architecture.en',
    obTitle: 'Obsidian 1.13.7',
    obSub: 'obsidian.asar · official signed artifact + reproducible runtime patches',
    electronLabel: 'Electron API Compatibility Layer',
    electronItems: ['@electron/remote', 'Node.js Runtime', 'main.js Wrapper'],
    jsbind: 'JSBind Bridge Layer',
    libadapter: 'C++ Native Library libadapter.so · Core system-level API bindings',
    arktsLabel: 'ArkTS Adapter Layer · ~50 adapters',
    arktsChips: ['FileSys', 'IME', 'Notify', 'Theme', 'Window', 'Device', 'Dialog'],
    osTitle: 'HarmonyOS Native Runtime',
    osSub: 'Ability · ArkUI · System Service Kits',
  },
};

const LAYOUT = { width: 920, marginX: 60, startY: 20, gap: 24, bottomMargin: 54 };

/** 层级结构：kind = solid（标题+副标题实心层）| band（窄条）| card（带子项卡片）。 */
function buildLayers(t) {
  return [
    { kind: 'solid', fill: '#6D28D9', title: t.obTitle, sub: t.obSub },
    { kind: 'card', label: t.electronLabel, items: t.electronItems },
    { kind: 'band', fill: '#8B5CF6', text: t.jsbind, bridge: true },
    { kind: 'band', fill: '#4C1D95', text: t.libadapter, tall: true },
    { kind: 'card', label: t.arktsLabel, chips: t.arktsChips },
    { kind: 'solid', fill: '#334155', title: t.osTitle, sub: t.osSub },
  ];
}

const FONT = "'Segoe UI','Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif";
const ARROW = '#94A3B8';
const HEIGHTS = { solid: 76, band: 44 }; // card 高度按子项计算

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function layerHeight(layer) {
  if (layer.kind === 'solid') return HEIGHTS.solid;
  if (layer.kind === 'band') return layer.tall ? 48 : HEIGHTS.band;
  if (layer.items) return 40 + 48 + 18;
  if (layer.chips) return 40 + 30 + 26;
  throw new Error(`card layer needs items or chips: ${layer.label}`);
}

function svgFor(layers) {
  const { width, marginX, startY, gap, bottomMargin } = LAYOUT;
  const totalHeight = startY + layers.map(layerHeight).reduce((a, b) => a + b, 0) + gap * (layers.length - 1) + bottomMargin;
  const cx = width / 2;
  const out = [];

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">`);
  out.push(`<defs><style>text { font-family:${FONT}; }`
    + `.title{font-size:21px;font-weight:700;fill:#FFFFFF;text-anchor:middle;}`
    + `.sub{font-size:14px;fill:#FFFFFF;opacity:.78;text-anchor:middle;}`
    + `.label{font-size:17px;font-weight:700;fill:#5B21B6;}`
    + `.chip{font-size:13px;fill:#5B21B6;text-anchor:middle;font-weight:600;}`
    + `.box{font-size:14px;fill:#4C1D95;text-anchor:middle;font-weight:600;}`
    + `.mid{font-size:17px;font-weight:700;fill:#FFFFFF;text-anchor:middle;}</style></defs>`);
  out.push(`<rect width="${width}" height="${totalHeight}" fill="#FFFFFF"/>`);

  let y = startY;
  layers.forEach((layer, i) => {
    const h = layerHeight(layer);
    drawLayer(out, layer, marginX, y, width, h);
    const next = layers[i + 1];
    if (next) {
      drawArrow(out, cx, y + h, gap, Boolean(layer.bridge || next.bridge));
      y += h + gap;
    }
  });

  out.push('</svg>');
  return { svg: out.join('\n'), height: totalHeight };
}

function drawLayer(out, layer, marginX, y, width, h) {
  const cardW = width - marginX * 2;
  if (layer.kind === 'solid') {
    out.push(`<rect x="${marginX}" y="${y}" width="${cardW}" height="${h}" rx="12" fill="${layer.fill}"/>`);
    out.push(`<text x="${width / 2}" y="${y + 34}" class="title">${esc(layer.title)}</text>`);
    out.push(`<text x="${width / 2}" y="${y + 58}" class="sub">${esc(layer.sub)}</text>`);
    return;
  }
  if (layer.kind === 'band') {
    out.push(`<rect x="${marginX}" y="${y}" width="${cardW}" height="${h}" rx="10" fill="${layer.fill}"/>`);
    out.push(`<text x="${width / 2}" y="${y + h / 2 + 6}" class="mid">${esc(layer.text)}</text>`);
    return;
  }
  // card
  out.push(`<rect x="${marginX}" y="${y}" width="${cardW}" height="${h}" rx="12" fill="#F5F3FF" stroke="#DDD6FE"/>`);
  const labelX = marginX + 24;
  out.push(`<text x="${labelX}" y="${y + 28}" class="label">${esc(layer.label)}</text>`);
  const rowY = y + 40;
  if (layer.items) {
    const innerW = cardW - 48;
    const n = layer.items.length;
    const boxGap = 12;
    const boxW = Math.floor((innerW - boxGap * (n - 1)) / n);
    layer.items.forEach((text, i) => {
      const x = labelX + i * (boxW + boxGap);
      out.push(`<rect x="${x}" y="${rowY}" width="${boxW}" height="48" rx="8" fill="#FFFFFF" stroke="#A78BFA"/>`);
      out.push(`<text x="${x + boxW / 2}" y="${rowY + 29}" class="box">${esc(text)}</text>`);
    });
  }
  if (layer.chips) {
    const chipW = 100;
    const chipGap = 8;
    layer.chips.forEach((text, i) => {
      const x = labelX + i * (chipW + chipGap);
      out.push(`<rect x="${x}" y="${rowY}" width="${chipW}" height="30" rx="15" fill="#EDE9FE" stroke="#C4B5FD"/>`);
      out.push(`<text x="${x + chipW / 2}" y="${rowY + 20}" class="chip">${esc(text)}</text>`);
    });
  }
}

function drawArrow(out, cx, y, gap, doubleHeaded) {
  const downTip = y + gap - 2;
  const lineTop = y + (doubleHeaded ? 8 : 2);
  const lineBottom = y + gap - 8;
  out.push(`<g stroke="${ARROW}" stroke-width="2" fill="${ARROW}">`);
  out.push(`<line x1="${cx}" y1="${lineTop}" x2="${cx}" y2="${lineBottom}"/>`);
  out.push(`<polygon points="${cx - 6},${downTip - 8} ${cx + 6},${downTip - 8} ${cx},${downTip}"/>`);
  if (doubleHeaded) {
    out.push(`<polygon points="${cx - 6},${y + 10} ${cx + 6},${y + 10} ${cx},${y + 2}"/>`);
  }
  out.push('</g>');
}

function findBrowser() {
  const env = process.env;
  const candidates = process.platform === 'win32'
    ? [
        path.join(env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
        path.join(env['ProgramFiles'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
        path.join(env['ProgramFiles'] ?? '', 'Google/Chrome/Application/chrome.exe'),
        path.join(env['LOCALAPPDATA'] ?? '', 'Google/Chrome/Application/chrome.exe'),
      ].filter(existsSync)
    : process.platform === 'darwin'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
         '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
         '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(existsSync)
      : ['chromium', 'chromium-browser', 'google-chrome', 'microsoft-edge'];
  return candidates[0] ?? null;
}

function renderPng(browser, svgPath, pngPath, width, height) {
  const baseArgs = ['--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    `--window-size=${width},${height}`, `--screenshot=${pngPath}`, pathToFileURL(svgPath).href];
  for (const mode of ['--headless=new', '--headless']) {
    const result = spawnSync(browser, [mode, ...baseArgs], { stdio: 'pipe' });
    if (existsSync(pngPath)) {
      if (result.status !== 0) console.warn(result.stderr?.toString().trim());
      return true;
    }
  }
  return false;
}

const browser = findBrowser();
if (!browser) {
  console.warn('未找到 Edge / Chrome，跳过 PNG 渲染。SVG 已生成，可手工用浏览器截图。');
}

let failed = false;
for (const [locale, t] of Object.entries(I18N)) {
  const layers = buildLayers(t);
  const { svg, height } = svgFor(layers);
  const svgPath = path.join(OUT_DIR, `${t.fileBase}.svg`);
  const pngPath = path.join(OUT_DIR, `${t.fileBase}.png`);
  writeFileSync(svgPath, svg + '\n');
  console.log(`[${locale}] SVG written: ${path.relative(ROOT, svgPath)} (${LAYOUT.width}x${height})`);
  if (browser) {
    if (renderPng(browser, svgPath, pngPath, LAYOUT.width, height)) {
      console.log(`[${locale}] PNG written: ${path.relative(ROOT, pngPath)} (${LAYOUT.width * 2}x${height * 2} @2x)`);
    } else {
      console.error(`[${locale}] PNG 渲染失败: ${pngPath}`);
      failed = true;
    }
  }
}
if (failed || !browser) process.exitCode = 1;
