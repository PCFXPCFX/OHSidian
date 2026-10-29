/**
 * Input primitives. `uitest uiInput` expects physical pixels on HarmonyOS;
 * profiles can override `inputScale` if a build uses vp/CSS coordinates.
 */

export class Input {
  constructor(hdc, profile = {}) {
    this.hdc = hdc;
    this.profile = profile;
    this.inputScale = Number(profile.inputScale) || 1;
  }

  toPhysical(point) {
    if (Array.isArray(point)) {
      return [Math.round(point[0] * this.inputScale), Math.round(point[1] * this.inputScale)];
    }
    if (point && Array.isArray(point.css)) {
      const dpr = Number(this.profile.dpr) || 1;
      return [Math.round(point.css[0] * dpr * this.inputScale),
        Math.round(point.css[1] * dpr * this.inputScale)];
    }
    if (point && Array.isArray(point.physical)) return point.physical;
    return [0, 0];
  }

  click(point) {
    const [x, y] = this.toPhysical(point);
    return this.hdc.shell(`uitest uiInput click ${x} ${y}`, { timeout: 20000 });
  }

  doubleClick(point) {
    const [x, y] = this.toPhysical(point);
    return this.hdc.shell(`uitest uiInput doubleClick ${x} ${y}`, { timeout: 20000 });
  }

  longClick(point, duration = 700) {
    const [x, y] = this.toPhysical(point);
    return this.hdc.shell(`uitest uiInput longClick ${x} ${y} ${duration}`, { timeout: 20000 });
  }

  swipe(from, to, duration = 400) {
    const [x1, y1] = this.toPhysical(from);
    const [x2, y2] = this.toPhysical(to);
    return this.hdc.shell(`uitest uiInput swipe ${x1} ${y1} ${x2} ${y2} ${duration}`,
      { timeout: 30000 });
  }

  fling(from, to, speed = 1200) {
    const [x1, y1] = this.toPhysical(from);
    const [x2, y2] = this.toPhysical(to);
    return this.hdc.shell(`uitest uiInput fling ${x1} ${y1} ${x2} ${y2} ${speed}`,
      { timeout: 30000 });
  }

  text(value) {
    return this.hdc.shell(`uitest uiInput inputText ${JSON.stringify(String(value))}`,
      { timeout: 20000 });
  }

  key(code) {
    return this.hdc.shell(`uitest uiInput keyEvent ${code}`, { timeout: 20000 });
  }
}
