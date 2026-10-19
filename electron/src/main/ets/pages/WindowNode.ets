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

import { WebWindowNode, BackPressBridge } from 'web_engine';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { KeyCode } from '@kit.InputKit';

// Round 105: same root-exit contract as pages/Index.ets (see
// BackPressBridge): the engine launches extra windows through BrowserAbility,
// which renders THIS page, and in touch mode the surviving vault window can
// be one of those - so the exit check must exist here too. The touch-mode
// gate inside BackPressBridge.shouldExit keeps PC/desktop sessions intact.
const BACK_EXIT_CHECK_MS: number = 350;
const BACK_EXIT_RETRIES: number = 1;

let storage = LocalStorage.getShared();
@Entry(storage)
@Component
struct WindowNode {
  // Back gesture (round 96): same semantics as Index - consumed instead of
  // the default Ability teardown, published to the focused renderer through
  // the mode file. The page itself carries no xcomponentId link; the id
  // comes from the shared LocalStorage the ability stored it under (used
  // for logging only - the consumer routes by window focus).
  private lastBackMs: number = 0;
  // Round 105: pending verdict timer for the gesture published last.
  private backTimer: number = -1;

  aboutToDisappear() {
    if (this.backTimer >= 0) {
      clearTimeout(this.backTimer);
      this.backTimer = -1;
    }
  }

  onBackPress(): boolean {
    const now: number = Date.now();
    if (now - this.lastBackMs < 500) {
      return true;
    }
    this.lastBackMs = now;
    let seq: number = 0;
    try {
      let windowId: string = '';
      try {
        const v = LocalStorage.getShared().get<string>('xcomponentId');
        if (typeof v === 'string') {
          windowId = v;
        }
      } catch (eL) {
        // LocalStorage entry absent - publish without the id
      }
      seq = BackPressBridge.notify(getContext(this).getApplicationContext().filesDir, windowId);
    } catch (e) {
      // publish failure must not propagate - the gesture stays consumed
    }
    if (seq > 0) {
      this.armExitCheck(seq);
    }
    return true;
  }

  private armExitCheck(seq: number): void {
    if (this.backTimer >= 0) {
      clearTimeout(this.backTimer);
    }
    this.backTimer = setTimeout(() => {
      this.backTimer = -1;
      this.checkBackExit(seq, 0);
    }, BACK_EXIT_CHECK_MS);
  }

  private checkBackExit(seq: number, attempt: number): void {
    let decision: number = -1;
    try {
      const filesDir: string = getContext(this).getApplicationContext().filesDir;
      // 1 = exit, 0 = stay (consumed, or desktop mode), -1 = no verdict yet.
      decision = BackPressBridge.shouldExit(filesDir, seq);
    } catch (e) {
      decision = -1;
    }
    if (decision < 0) {
      if (attempt < BACK_EXIT_RETRIES) {
        this.backTimer = setTimeout(() => {
          this.backTimer = -1;
          this.checkBackExit(seq, attempt + 1);
        }, BACK_EXIT_CHECK_MS);
      }
      return;
    }
    if (decision === 0) {
      return;
    }
    try {
      const context = getContext(this) as common.UIAbilityContext;
      context.terminateSelf().catch((err: BusinessError) => {
        console.error('OHSidian back exit: terminateSelf failed: ' + JSON.stringify(err));
      });
    } catch (e) {
      console.error('OHSidian back exit failed: ' + JSON.stringify(e));
    }
  }

  build() {
    Row() {
      WebWindowNode()
    }.onKeyEvent((event?: KeyEvent) => {
      if (event) {
        if (event.type == KeyType.Down && event.keyCode == KeyCode.KEYCODE_ESCAPE) {
          event.stopPropagation();
        }
      }
    })
    .width('100%')
    .height('100%')
  }
}
