#!/usr/bin/env node
// Regenerates the evaluation fixtures under fixtures/vault/ink-eval/.
// The PDF is hand-built (no dependency) so `02-pdf.pdf` stays reproducible:
// black printed text in the top half, blank paper below for handwriting.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "vault", "ink-eval");

const LINES = [
  ["F2", 22, 780, "OHSidian stylus evaluation"],
  ["F1", 11, 752, "This page is printed text. A highlighter must not fade it."],
  ["F1", 11, 736, "Draw here with the pen, then check the annotation in another reader."],
  ["F1", 11, 712, "The quick brown fox jumps over the lazy dog. 0123456789."],
  ["F1", 11, 696, "The quick brown fox jumps over the lazy dog. 0123456789."],
  ["F1", 11, 680, "The quick brown fox jumps over the lazy dog. 0123456789."],
  ["F2", 14, 640, "Section 1. Printed black text"],
  ["F1", 11, 618, "Highlighting this paragraph should tint the paper, not the letters."],
  ["F1", 11, 602, "Highlighting this paragraph should tint the paper, not the letters."],
  ["F1", 11, 586, "Highlighting this paragraph should tint the paper, not the letters."],
  ["F2", 14, 546, "Section 2. Annotation space"],
  ["F1", 11, 524, "Keep this area free: write a line and a circle on the blank paper."],
];

function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function contentStream() {
  const parts = [];
  for (const [font, size, y, text] of LINES) {
    parts.push(`BT /${font} ${size} Tf 56 ${y} Td (${esc(text)}) Tj ET`);
  }
  // two light rules to make alignment obvious
  parts.push("0.75 w 0.6 0.6 0.6 RG 56 508 m 539 508 l S");
  parts.push("0.5 w 0.75 0.75 0.75 RG 56 120 m 539 120 l S");
  return parts.join("\n");
}

function buildPdf() {
  const stream = contentStream();
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const README = `# 手写评测仓库（自动生成）

这是 \`scripts/stylus-eval\` 的测试素材，不需要手动维护。

- \`01-pen.md\`：空白练习页，用于压感、长按拉直、橡皮、一笔成形、套索。
- \`02-pdf.pdf\`：上半页是印刷黑字，下半页留白，用于荧光笔与 PDF 标注写回。

跑评测时按 PC 终端的提示操作；跑完可以在 \`artifacts/stylus-eval/\` 看报告和片段。
`;

const PEN = `# 手写评测页

用笔在下面的空白处书写。评测过程中请不要滚动页面。

---

---

---

---

---

---

---

---

---

---

---
`;

const EMBED = `# 内嵌 PDF 手写

下面内嵌了 \`02-pdf.pdf\`，用笔直接在上半页的印刷文字上写/划。

![[02-pdf.pdf]]
`;

const CANVAS = JSON.stringify({
  nodes: [
    {
      id: "eval-note",
      type: "text",
      text: "Canvas 手写评测\\n用笔在空白处画线，然后拖动画布确认墨迹跟随。",
      x: -260,
      y: -120,
      width: 420,
      height: 180,
    },
  ],
  edges: [],
}, null, 2) + "\n";

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "00-README.md"), README, "utf8");
fs.writeFileSync(path.join(OUT, "01-pen.md"), PEN, "utf8");
fs.writeFileSync(path.join(OUT, "02-pdf.pdf"), buildPdf());
fs.writeFileSync(path.join(OUT, "03-embed.md"), EMBED, "utf8");
fs.writeFileSync(path.join(OUT, "04-canvas.canvas"), CANVAS, "utf8");
console.log("fixtures written to " + OUT);
