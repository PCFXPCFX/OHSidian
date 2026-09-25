/*
 * Copyright (c) 2023-2025 Haitai FangYuan Co., Ltd.
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this list of
 *    conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list
 *    of conditions and the following disclaimer in the documentation and/or other materials
 *    provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used
 *    to endorse or promote products derived from this software without specific prior written
 *    permission.
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

import LogUtil from './LogUtil';

const TAG: string = 'SurfaceReady';

export class SurfaceReady {
  private static POLL_INTERVAL_MS: number = 50;
  private static MAX_ATTEMPTS: number = 100;

  // The engine reads the XComponent surface size exactly once, when the
  // browser starts. At XComponent onLoad the surface exists but the first
  // layout pass has not run yet, so that query returns 0x0 (seen in device
  // logs as "Get xcomponent surface size success:0 0") and the browser
  // renders into a zero/default-size viewport - the window never fills the
  // screen on cold start. Poll the surface rect until it reports a real
  // size, then run the start callback.
  static whenReady(getRect: () => SurfaceRect, start: () => void): void {
    let attempts: number = 0;
    const poll = () => {
      let ready: boolean = false;
      let size: string = 'unknown';
      try {
        const rect: SurfaceRect = getRect();
        size = rect.surfaceWidth + 'x' + rect.surfaceHeight;
        ready = rect.surfaceWidth > 0 && rect.surfaceHeight > 0;
      } catch (exception) {
        ready = false;
      }
      attempts++;
      if (!ready && attempts < SurfaceReady.MAX_ATTEMPTS) {
        setTimeout(poll, SurfaceReady.POLL_INTERVAL_MS);
        return;
      }
      if (ready) {
        LogUtil.info(TAG, 'surface ready after ' + attempts + ' poll(s): ' + size);
      } else {
        // Never block the browser indefinitely on a layout hiccup.
        LogUtil.warn(TAG, 'surface size unknown after ' + attempts + ' poll(s), starting anyway');
      }
      start();
    };
    poll();
  }
}
