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
import { KeyCode } from '@kit.InputKit';

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

  onBackPress(): boolean {
    const now: number = Date.now();
    if (now - this.lastBackMs < 500) {
      return true;
    }
    this.lastBackMs = now;
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
      BackPressBridge.notify(getContext(this).getApplicationContext().filesDir, windowId);
    } catch (e) {
      // publish failure must not propagate - the gesture stays consumed
    }
    return true;
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
