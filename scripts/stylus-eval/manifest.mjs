// Scene manifest for the stylus regression harness.
//
// Each scene is one feature: what the stock app does, what OHsidian promises,
// how the operator should drive it, which probe events prove it happened, and
// which invariants must hold. `window` is how long the recorder stays open
// after the "开始" prompt (a manual stroke needs 3-10 s).
//
// Checks are deliberately about invariants, not exact values: a human draws a
// different line every run, but pressure must still reach the renderer, the
// width must still vary, the whole stroke must disappear, and so on.

export const PROMO = {
  product: "OHSidian",
  tagline: "让 Obsidian 在华为平板上真正能用笔写字",
  repo: "https://github.com/PCFXPCFX/OHSidian",
  coolapk: {
    title: "在华为平板上用 M-Pencil 写 Obsidian：压感、荧光笔写回 PDF、一笔成形",
    body: [
      "鸿蒙版 Obsidian（OHSidian）把 M-Pencil 真正接进了笔记里：",
      "· 压感笔迹：线宽随笔尖压力变化，压力丢失时自动回退到设备采样流",
      "· 荧光笔：正片叠底，PDF 印刷黑字不会被黄膜冲淡；还能写回成 PDF 高亮注释",
      "· 整笔橡皮 / 压感橡皮：按住笔尖停一下就能擦，抬笔继续写",
      "· 一笔成形：手动画的方、圆、三角、箭头自动拉直",
      "· 套索：圈选、移动、复制、删除手写墨迹",
      "· 点预测（实验）：抬笔前的最后一段不再“追笔”",
      "所有手写都存进仓库的 .obsidian/ohsidian-ink 边车文件，PDF 标注直接写回原文件。",
    ].join("\n"),
    tags: ["Obsidian", "鸿蒙", "HarmonyOS", "手写笔", "M-Pencil", "平板", "效率工具"],
  },
  bilibili: {
    title: "华为平板 + Obsidian：M-Pencil 压感手写 / PDF 荧光笔 / 一笔成形",
    desc: [
      "这个视频演示 OHSidian（鸿蒙上的 Obsidian）针对 M-Pencil 做的增强：",
      "00:00 压感笔迹",
      "00:12 长按拉直",
      "00:22 PDF 荧光笔（黑字不被冲淡）+ 标注写回",
      "00:40 整笔橡皮 / 压感橡皮",
      "00:58 一笔成形（方形/圆形）",
      "01:12 套索移动、复制、删除",
      "01:30 点预测",
      "项目地址见简介与置顶评论。",
    ].join("\n"),
    tags: ["Obsidian", "HarmonyOS", "华为平板", "手写笔", "数码", "效率", "教程"],
  },
};

const PDF_SETUP = [
  "打开仓库里的 ink-eval/02-pdf.pdf（用 Obsidian 内置 PDF 阅读器，不要用外部应用）",
  "设置 → OHSidian → PDF 写回 → 时机改成「空闲」（默认「离开页面」不会在录制窗口内写回）",
  "把工具条切到「荧光笔」，颜色选黄色",
];

export const SCENES = [
  {
    id: "pen-pressure",
    title: "压感笔迹",
    group: "笔",
    tool: "pen",
    stock: "指针压力在鸿蒙上经常是常数，原版线宽不随力度变化，压力丢失时也没有补救。",
    ours: "线宽按 0.35–2.0 倍随压力变化；DOM 压力恒定时自动切到设备采样流（penSamplesOn）。",
    setup: ["打开 ink-eval/01-pen.md（阅读视图）", "工具条切到「笔」，颜色默认黑"],
    action: "先慢慢画一条 10cm 的横线（故意由轻到重），再快速画一条短斜线。",
    window: 12,
    probes: ["inkStroke"],
    checks: [
      { kind: "count", event: "inkStroke", where: { tool: "pen" }, min: 1, label: "至少 1 条笔迹" },
      { kind: "value", event: "inkStroke", path: "points", agg: "max", op: ">=", value: 25, label: "采样点 ≥ 25" },
      { kind: "value", event: "inkStroke", path: "pressureMax", agg: "max", op: ">=", value: 0.35, label: "压力到达渲染层" },
      { kind: "ratio", event: "inkStroke", a: "widthMax", b: "widthMin", agg: "max", op: ">=", value: 1.35, label: "线宽随压力变化 ≥1.35×" },
      { kind: "value", event: "inkStroke", path: "ms", agg: "max", op: ">=", value: 400, label: "笔画时长 ≥0.4s" },
    ],
    promo: {
      title: "压感笔迹",
      hook: "同一支笔，轻画是细线，重按是粗线。",
      caption: "压力 → 线宽 0.35–2.0 倍；压力丢失时自动回退设备采样流。",
    },
  },
  {
    id: "hold-straight",
    title: "长按拉直",
    group: "笔",
    tool: "pen",
    stock: "原版没有“停一下就把线拉直”的手势。",
    ours: "画完一条近似直线后按住笔尖不动，笔迹吸附成直线；弯曲的笔画不会触发。",
    setup: ["仍是 ink-eval/01-pen.md", "工具条「笔」"],
    action: "画一条略微抖的横线，笔尖在终点停住约 1 秒再抬起。",
    window: 10,
    probes: ["inkStroke"],
    checks: [
      { kind: "count", event: "inkStroke", min: 1, label: "至少 1 条笔迹" },
      { kind: "value", event: "inkStroke", path: "straight", agg: "max", op: "==", value: true, label: "straight=true" },
      { kind: "value", event: "inkStroke", path: "points", agg: "max", op: "<=", value: 6, label: "吸附为直线（≤6 点）" },
    ],
    promo: {
      title: "长按拉直",
      hook: "画歪了不用重画：停一下，线自己直。",
      caption: "只对本来就接近直线的笔画生效，写字时不会误伤。",
    },
  },
  {
    id: "highlighter-pdf",
    title: "PDF 荧光笔不冲淡黑字",
    group: "PDF",
    tool: "highlighter",
    stock: "半透明色块直接盖在 PDF 上，印刷黑字被黄膜冲淡；而且不能写回 PDF。",
    ours: "PDF 墨迹画布在浅色页用 mix-blend-mode:multiply，黑字保持黑；高亮写入 PDF 时用 /Highlight 四边形注释。",
    setup: PDF_SETUP,
    action: "横着划过高亮一段印刷文字（覆盖 2–3 行），停 4 秒等写回完成。",
    window: 14,
    probes: ["inkStroke", "pdfPayload", "pdfBlend", "pdfWriteEnd"],
    checks: [
      { kind: "count", event: "inkStroke", where: { tool: "highlighter" }, min: 1, label: "荧光笔笔迹" },
      { kind: "value", event: "pdfBlend", path: "mode", agg: "last", op: "==", value: "multiply", label: "浅色页使用 multiply" },
      { kind: "value", event: "pdfPayload", path: "hl", agg: "max", op: ">=", value: 1, label: "写回载荷含荧光笔" },
      { kind: "value", event: "pdfWriteEnd", path: "ok", agg: "max", op: "==", value: true, label: "PDF 写回成功" },
      { kind: "absent", event: "consoleError", label: "无渲染层错误" },
    ],
    promo: {
      title: "PDF 荧光笔",
      hook: "划重点时黑字还是黑的，不是蒙了一层黄膜。",
      caption: "multiply 混合 + PDF /Highlight 注释写回，其它阅读器里也能看到。",
    },
  },
  {
    id: "pdf-writeback",
    title: "PDF 标注写回与坐标",
    group: "PDF",
    tool: "pen",
    stock: "原版只能在 PDF 上“看”，手写内容不会进入 PDF 文件。",
    ours: "笔画按 PDF 用户坐标写入注释，补偿 CropBox 原点；重新打开或换阅读器位置一致。",
    setup: ["打开 ink-eval/02-pdf.pdf", "设置 → OHSidian → PDF 写回 → 时机「空闲」", "工具条「笔」，在页面中间画"],
    action: "在 PDF 空白处画一个短横 + 一个圈，停 4 秒等写回；然后双指缩放一次，观察注释是否跟着页面走。",
    window: 16,
    probes: ["inkStroke", "pdfPayload", "pdfWriteEnd"],
    checks: [
      { kind: "count", event: "inkStroke", min: 1, label: "至少 1 条笔迹" },
      { kind: "value", event: "pdfPayload", path: "strokes", agg: "max", op: ">=", value: 1, label: "载荷含笔画" },
      { kind: "exists", event: "pdfPayload", path: "originX", label: "载荷带 CropBox originX" },
      { kind: "exists", event: "pdfPayload", path: "originY", label: "载荷带 CropBox originY" },
      { kind: "value", event: "pdfWriteEnd", path: "ok", agg: "max", op: "==", value: true, label: "写回成功" },
    ],
    promo: {
      title: "PDF 标注写回",
      hook: "在 PDF 上写的字，真的存进了 PDF。",
      caption: "PDF 用户坐标 + CropBox 原点补偿，缩放后不跑位。",
    },
  },
  {
    id: "eraser-partial",
    title: "局部橡皮",
    group: "橡皮",
    tool: "eraser",
    stock: "原版没有针对手写墨迹的橡皮。",
    ours: "橡皮按像素擦除，只断开被碰到的笔画段，其余部分保留。",
    setup: ["回到 ink-eval/01-pen.md", "先用笔写一个长一点的“一”字或画一条长线", "工具条切到「橡皮」，模式切回“局部”"],
    action: "用橡皮从长线中间划过去，只擦中间一小段。",
    window: 10,
    probes: ["inkErase"],
    checks: [
      { kind: "count", event: "inkErase", min: 1, label: "橡皮事件" },
      { kind: "value", event: "inkErase", path: "mode", agg: "last", op: "==", value: "partial", label: "局部模式" },
      { kind: "value", event: "inkErase", path: "changed", agg: "max", op: "==", value: true, label: "确实擦掉了内容" },
    ],
    promo: {
      title: "局部橡皮",
      hook: "擦中间，两头还在。",
      caption: "按像素断开笔画，历史记录可整体撤销。",
    },
  },
  {
    id: "eraser-stroke",
    title: "整笔橡皮",
    group: "橡皮",
    tool: "eraser",
    stock: "原版没有“碰一下删一整笔”的橡皮。",
    ours: "整笔模式下，橡皮碰到哪一笔就删掉整笔，适合快速清理草稿。",
    setup: ["ink-eval/01-pen.md", "先画 2–3 条分开的短线", "设置 → OHSidian → 橡皮 → 整笔（或在橡皮菜单里切换）"],
    action: "用橡皮点/划其中一条线，确认整条消失，其它线保留。",
    window: 12,
    probes: ["inkErase"],
    checks: [
      { kind: "count", event: "inkErase", min: 1, label: "橡皮事件" },
      { kind: "value", event: "inkErase", path: "mode", agg: "last", op: "==", value: "stroke", label: "整笔模式" },
      { kind: "value", event: "inkErase", path: "removed", agg: "max", op: ">=", value: 1, label: "删除了整笔" },
      { kind: "value", event: "inkErase", path: "changed", agg: "max", op: "==", value: true, label: "文档已变更" },
    ],
    promo: {
      title: "整笔橡皮",
      hook: "碰一下，整笔消失，不用来回蹭。",
      caption: "整笔 / 局部两种模式，PDF 页面同样适用。",
    },
  },
  {
    id: "pressure-eraser",
    title: "压感橡皮",
    group: "橡皮",
    tool: "pen",
    stock: "原版没有“按住笔尖停一下变橡皮”的手势。",
    ours: "笔尖按住不动约 0.5s，临时变橡皮；移动擦除，抬笔恢复书写。",
    setup: ["ink-eval/01-pen.md", "先画一条线", "工具条切回「笔」，设置里“压感橡皮”保持开启"],
    action: "把笔尖按在线条上停住约 1 秒（不要移动），然后拖动擦掉一段，抬笔。",
    window: 14,
    probes: ["inkErase"],
    checks: [
      { kind: "count", event: "inkErase", min: 1, label: "橡皮事件" },
      { kind: "value", event: "inkErase", path: "ms", agg: "max", op: ">=", value: 450, label: "按住时间 ≥0.45s" },
      { kind: "value", event: "inkErase", path: "removed", agg: "max", op: ">=", value: 1, label: "擦掉了墨迹" },
      { kind: "manual", label: "目视：按住期间没有画出墨点" },
    ],
    promo: {
      title: "压感橡皮",
      hook: "按住笔尖停一下，笔就变成橡皮。",
      caption: "只在真实压力传感器下启用，抬笔立刻恢复书写。",
    },
  },
  {
    id: "shape-square",
    title: "一笔成形：方形",
    group: "一笔成形",
    tool: "pen",
    stock: "原版没有形状识别。",
    ours: "Pen Kit 识别 + 本地凸包/最小外接矩形兜底；闭合四边形吸附成方正的矩形。",
    setup: ["ink-eval/01-pen.md", "工具条打开「一笔成形」（⋯ 菜单或设置里开启）"],
    action: "手画一个大致闭合的正方形（四条边，别太歪），抬笔等 1 秒看是否吸附。",
    window: 10,
    probes: ["inkShape"],
    checks: [
      { kind: "count", event: "inkShape", min: 1, label: "形状识别事件" },
      { kind: "value", event: "inkShape", path: "type", agg: "last", op: "between", value: [6, 7, 9], label: "矩形/平行四边形/菱形" },
      { kind: "value", event: "inkShape", path: "points", agg: "last", op: "<=", value: 6, label: "吸附为 4–6 个角点" },
      { kind: "value", event: "inkShape", path: "closed", agg: "last", op: "==", value: true, label: "闭合" },
    ],
    promo: {
      title: "一笔成形 · 方形",
      hook: "手画一个歪方块，抬笔变成真正的矩形。",
      caption: "最小外接矩形拟合，长宽比按画布真实比例计算。",
    },
  },
  {
    id: "shape-circle",
    title: "一笔成形：圆形",
    group: "一笔成形",
    tool: "pen",
    stock: "原版没有形状识别。",
    ours: "闭合且径向方差小 → 椭圆；否则交给 Pen Kit 的类型判断。",
    setup: ["仍在一笔成形模式"],
    action: "手画一个大致闭合的圆，抬笔等 1 秒。",
    window: 10,
    probes: ["inkShape"],
    checks: [
      { kind: "count", event: "inkShape", min: 1, label: "形状识别事件" },
      { kind: "value", event: "inkShape", path: "type", agg: "last", op: "==", value: 2, label: "识别为椭圆" },
      { kind: "value", event: "inkShape", path: "closed", agg: "last", op: "==", value: true, label: "闭合" },
    ],
    promo: {
      title: "一笔成形 · 圆形",
      hook: "手画的圆，抬笔就圆了。",
      caption: "径向方差判断闭合圆，避免把方框认成圆。",
    },
  },
  {
    id: "lasso-move",
    title: "套索选择与移动",
    group: "套索",
    tool: "lasso",
    stock: "原版没有手写墨迹的套索。",
    ours: "套索圈选墨迹，拖动选框整体移动；滚动/缩放/换工具时自动清空选择。",
    setup: ["ink-eval/01-pen.md", "先画 2 条分开的短线", "工具条切到「套索」"],
    action: "圈住两条线（闭合），按住选框拖到旁边，松手。",
    window: 14,
    probes: ["inkLasso", "inkLassoAction"],
    checks: [
      { kind: "count", event: "inkLasso", min: 1, label: "套索事件" },
      { kind: "value", event: "inkLasso", path: "selected", agg: "max", op: ">=", value: 1, label: "选中 ≥1 笔" },
      { kind: "count", event: "inkLassoAction", where: { action: "move" }, min: 1, label: "移动动作" },
      { kind: "value", event: "inkLassoAction", path: "n", agg: "max", op: ">=", value: 1, label: "移动了 ≥1 笔" },
    ],
    promo: {
      title: "套索移动",
      hook: "圈住，拖走，位置不对再拖回来。",
      caption: "选择框随内容缩放，滚轮/手势滚动会自动取消选择。",
    },
  },
  {
    id: "lasso-copy-delete",
    title: "套索复制与删除",
    group: "套索",
    tool: "lasso",
    stock: "原版没有手写墨迹的套索。",
    ours: "选中后可复制（偏移 18px 并保持选中）或删除；删除进撤销栈。",
    setup: ["ink-eval/01-pen.md", "先画 2 条短线", "工具条「套索」"],
    action: "圈住一条线 → 点浮条「副本」；再圈住副本 → 点「删除」。",
    window: 22,
    probes: ["inkLasso", "inkLassoAction"],
    checks: [
      { kind: "count", event: "inkLassoAction", where: { action: "duplicate" }, min: 1, label: "复制动作" },
      { kind: "value", event: "inkLassoAction", path: "n", agg: "max", op: ">=", value: 1, label: "复制 ≥1 笔" },
      { kind: "count", event: "inkLassoAction", where: { action: "delete" }, min: 1, label: "删除动作" },
    ],
    promo: {
      title: "套索复制 / 删除",
      hook: "同一段手写，复制一份再改，原稿不动。",
      caption: "复制偏移 18px，删除可撤销。",
    },
  },
  {
    id: "predict",
    title: "点预测（实验）",
    group: "实验",
    tool: "pen",
    stock: "原版没有笔尖预测。",
    ours: "HarmonyOS PointPredictor 预测下一个点，只画在实时层，不写进文档；默认关闭。",
    setup: ["ink-eval/01-pen.md", "设置 → OHSidian → 输入与手势 → 打开「点预测」", "工具条「笔」"],
    action: "快速画 2–3 条长弧线（快速移动才能触发预测）。",
    window: 12,
    probes: ["inkPredict", "inkStroke"],
    checks: [
      { kind: "count", event: "inkPredict", min: 1, label: "预测事件" },
      { kind: "value", event: "inkStroke", path: "predict", agg: "max", op: ">=", value: 1, label: "预测点被用于实时层" },
      { kind: "manual", label: "目视：抬笔瞬间没有“回弹/追笔”" },
    ],
    promo: {
      title: "点预测",
      hook: "抬笔前的最后几毫米，线条不再追着笔尖跑。",
      caption: "预测点只存在于实时层，提交的笔迹仍然是真实采样。",
    },
  },
];

export function scenesFor(opts = {}) {
  let list = SCENES.slice();
  if (opts.only && opts.only.length) {
    const set = new Set(opts.only);
    list = list.filter((s) => set.has(s.id));
  }
  if (opts.skip && opts.skip.length) {
    const set = new Set(opts.skip);
    list = list.filter((s) => !set.has(s.id));
  }
  return list;
}
