/*
 * Copyright (c) 2023-2025 Haitai FangYuan Co., Ltd.
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this list of
 * conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list
 * of conditions and the following disclaimer in the documentation and/or other materials
 * provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used
 * to endorse or promote products derived from this software without specific prior written
 * permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
 * OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
 * OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
 * ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * Turns one ArkUI TouchEvent into the compact sample tuples the ink layer
 * consumes. The renderer cannot see device-rate samples when the engine
 * coalesces them, so this is the pressure side-channel described in
 * docs/STYLUS-PEN.md §7.2.
 *
 * Tuple layout: [x, y, pressure01, tiltX, tiltY, ageMs]
 *  - x/y are vp in the receiving component's coordinate system;
 *  - pressure01 is normalised to [0,1] regardless of the ArkUI source unit;
 *  - ageMs is "how long ago this sample was produced", which lets the renderer
 *    match it against DOM events without sharing a clock.
 */
export class PenSampleTap {
  /**
   * Appends every sample of this event that belongs to `penId`.
   *
   * Both `touches` (device rate) and `getHistoricalPoints()` (samples the
   * screen-rate callback dropped) are read. `changedTouches` is deliberately
   * not used: ArkUI documents it as screen-rate resampled data.
   */
  static collect(event: TouchEvent, penId: number, out: Array<Array<number>>): number {
    const before: number = out.length;
    try {
      const nowNs: number = event.timestamp;
      const hist: Array<HistoricalPoint> = event.getHistoricalPoints();
      for (let i = 0; i < hist.length; i++) {
        const hp: HistoricalPoint = hist[i];
        if (hp.touchObject.id !== penId) {
          continue;
        }
        let ageMs: number = 0;
        if (hp.timestamp > 0 && nowNs >= hp.timestamp) {
          ageMs = (nowNs - hp.timestamp) / 1000000;
        }
        out.push([
          hp.touchObject.x,
          hp.touchObject.y,
          PenSampleTap.normalizeForce(hp.force),
          event.tiltX,
          event.tiltY,
          ageMs
        ]);
      }
      const current: Array<TouchObject> = event.touches.length > 0 ? event.touches : event.changedTouches;
      for (let i = 0; i < current.length; i++) {
        const t: TouchObject = current[i];
        if (t.id !== penId) {
          continue;
        }
        out.push([
          t.x,
          t.y,
          PenSampleTap.pressureOf(t, event),
          event.tiltX,
          event.tiltY,
          0
        ]);
      }
    } catch (e) {
      // A malformed event must never take the page down, but complete silence
      // makes a persistent API failure impossible to diagnose.
      console.warn('PenSampleTap', 'collect failed: ' + JSON.stringify(e));
    }
    return out.length - before;
  }

  /**
   * Picks the pen pointer id out of the down event. ArkUI offsets pen ids
   * internally, so we never assume 0.
   */
  static penIdOf(event: TouchEvent): number {
    const list: Array<TouchObject> = event.changedTouches.length > 0 ? event.changedTouches : event.touches;
    for (let i = 0; i < list.length; i++) {
      const t: TouchObject = list[i];
      if (t.type === TouchType.Down || t.type === TouchType.Move) {
        return t.id;
      }
    }
    return list.length > 0 ? list[0].id : -1;
  }

  private static pressureOf(t: TouchObject, event: TouchEvent): number {
    // TouchObject.pressure is documented per device unit [0,65535), while
    // BaseEvent.pressure is normalised [0,1]. Prefer the normalised one when
    // the device unit is absent or zero.
    let p: number = -1;
    if (t.pressure !== undefined) {
      p = t.pressure as number;
    }
    if (p > 1) {
      return PenSampleTap.clamp01(p / 65535);
    }
    if (p >= 0) {
      return PenSampleTap.clamp01(p);
    }
    return PenSampleTap.clamp01(event.pressure);
  }

  private static normalizeForce(force: number): number {
    // HistoricalPoint.force is [0,65535); a few devices already report [0,1].
    if (force > 1) {
      return PenSampleTap.clamp01(force / 65535);
    }
    return PenSampleTap.clamp01(force);
  }

  private static clamp01(v: number): number {
    if (v !== v) {
      return 0;
    }
    if (v < 0) {
      return 0;
    }
    if (v > 1) {
      return 1;
    }
    return v;
  }
}
