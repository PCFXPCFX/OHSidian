import { Input } from './input.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSteps(hdc, input, steps, { screenshotDir, tag }) {
  const shots = [];
  let n = 0;
  for (const step of steps || []) {
    if (step.wait != null) {
      await sleep(Number(step.wait) || 0);
      continue;
    }
    if (step.click) {
      input.click(step.click);
    } else if (step.doubleClick) {
      input.doubleClick(step.doubleClick);
    } else if (step.longClick) {
      input.longClick(step.longClick, step.duration || 700);
    } else if (step.swipe) {
      const [x1, y1, x2, y2] = step.swipe;
      input.swipe([x1, y1], [x2, y2], step.duration || 400);
    } else if (step.fling) {
      const [x1, y1, x2, y2] = step.fling;
      input.fling([x1, y1], [x2, y2], step.speed || 1200);
    } else if (step.text) {
      input.text(step.text);
    } else if (step.key) {
      input.key(step.key);
    } else if (step.screenshot) {
      const file = `${screenshotDir}/${tag || 'shot'}-${String(++n).padStart(2, '0')}-${step.screenshot}.jpeg`;
      const r = hdc.screenshot(file);
      shots.push({ step: step.screenshot, file, ok: r.ok, error: r.error });
    } else if (step.shell) {
      hdc.shell(step.shell);
    }
    await sleep(Number(step.after) || 0);
  }
  return shots;
}

export function makeInput(hdc, profile) {
  return new Input(hdc, profile || {});
}
