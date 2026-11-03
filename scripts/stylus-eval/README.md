# stylus-eval

手写特性回归评测 + 宣传素材生成。完整说明见 [`docs/STYLUS.md`](../../docs/STYLUS.md) 第 9–10 节。

```powershell
# 列场景
node scripts/stylus-eval/run.mjs --mode list

# 首次联机：检查 hdc / hilog / 录屏 / 探针是否可用
node scripts/stylus-eval/run.mjs --mode doctor

# 不联机验证流水线（合成画面 + 伪造探针）
node scripts/stylus-eval/run.mjs --selftest

# 真机：录制每个功能（按终端提示用笔操作）
node scripts/stylus-eval/run.mjs --mode capture --version v2.0.0

# 发版前：只跑断言
node scripts/stylus-eval/run.mjs --mode gate
```

需要：

- `ffmpeg` / `ffprobe` 在 PATH（或 `OHSIDIAN_FFMPEG` / `OHSIDIAN_FFPROBE`）；
- `hdc`（DevEco Studio 自带，或 `OHSIDIAN_HDC`）；
- 设备上装的是**独立 agent 包**（`node scripts/build-agent.mjs` 生成到
  `artifacts/agent/`），否则没有探针，gate 会直接失败。agent 包只用于
  演示/评测，不能发布；脚本结束会自动把 asar 恢复成 release。

产物在 `artifacts/stylus-eval/`：每个场景 `clip.mp4` + `clip.gif`，外加
`REPORT.md`（技术报告）和 `PROMO.md`（酷安/B 站文案）。
