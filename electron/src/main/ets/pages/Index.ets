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

import { WebWindow, BackPressBridge } from 'web_engine';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { KeyCode } from '@kit.InputKit';
import CustomChildProcess from '../process/CustomChildProcess';

// Round 105: how long the renderer gets to answer a back gesture with its
// verdict (it polls the mode file every 200ms) before we retry once and then
// give up. Giving up means "keep the app open": a missed verdict must never
// close the app, a stale one must never fire.
const BACK_EXIT_CHECK_MS: number = 350;
const BACK_EXIT_RETRIES: number = 1;
 
interface IStyleData {
  backgroundColor: string,
  opacity: number
};

interface IUpdateStyle {
  registerUpdateStyleFunction: Function,
  removeUpdateStyleFunction: Function
};

CustomChildProcess.toString();
let storage = LocalStorage.getShared();
@Entry(storage)
@Component
struct Index {
  @LocalStorageLink('updateStyle') updateStyle: IUpdateStyle = {
    registerUpdateStyleFunction: (id: string, initStyle: IStyleData, func: (style: IStyleData) => void) => {},
    removeUpdateStyleFunction: (id: string) => {}
  };
  @LocalStorageLink('xcomponentId') xcomponentId: string = '';

  private initStyle: IStyleData = {
    backgroundColor: 'ffffffff',
    opacity: 1
  };

  @State private backgroundColor_: string = `#${this.initStyle.backgroundColor}`;
  @State private opacity_: number = this.initStyle.opacity;

  aboutToAppear() {
    // registerUpdateStyleFunction
    this.updateStyle.registerUpdateStyleFunction(this.xcomponentId, this.initStyle, (style: IStyleData) => {
      this.backgroundColor_ = `#${style.backgroundColor}`;
      this.opacity_ = style.opacity;
    });
  }

  aboutToDisappear() {
    if (this.backTimer >= 0) {
      clearTimeout(this.backTimer);
      this.backTimer = -1;
    }
    // removeUpdateStyleFunction
    this.updateStyle.removeUpdateStyleFunction(this.xcomponentId);
  }

  // Back gesture (round 96): consumed instead of the default Ability
  // teardown (removeMissionAfterTerminate made one side-swipe close the
  // window). Published to the renderer through the mode file; the 500ms
  // debounce absorbs the multi-fire of one gesture (device-verified in
  // the Vitreus project: one quick swipe never fires twice).
  private lastBackMs: number = 0;
  // Round 105: pending verdict timer for the gesture published last.
  private backTimer: number = -1;

  onBackPress(): boolean {
    const now: number = Date.now();
    if (now - this.lastBackMs < 500) {
      return true;
    }
    this.lastBackMs = now;
    let seq: number = 0;
    try {
      seq = BackPressBridge.notify(getContext(this).getApplicationContext().filesDir, this.xcomponentId);
    } catch (e) {
      // publish failure must not propagate - the gesture stays consumed
    }
    if (seq > 0) {
      this.armExitCheck(seq);
    }
    return true;
  }

  // Round 105: wait for the renderer's verdict on this gesture. Nothing
  // consumed while in touch mode means we are at the root (no overlay, no
  // drawer, no tab switcher, no leaf history) - the user expects back to
  // exit, which is the platform default we replaced in round 96 because it
  // fired too early (before the renderer processed the same gesture).
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
      // Consumed by the app, or desktop/PC mode where back never closes the
      // session from here.
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
      WebWindow()
    }.onKeyEvent((event?: KeyEvent) => {
      if (event) {
        if (event.type == KeyType.Down && event.keyCode == KeyCode.KEYCODE_ESCAPE) {
          event.stopPropagation();
        }
      }
    })
    .backgroundColor(this.backgroundColor_)
    .opacity(this.opacity_)
    .width('100%')
    .height('100%')
  }
}
