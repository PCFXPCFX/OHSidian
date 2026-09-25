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

import { inject, injectable } from 'inversify';
import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';
import { BusinessError } from '@ohos.base';
import window from '@ohos.window';
import { ContextAdapter } from './ContextAdapter';

const TAG: string = 'RunningLock';

@injectable()
export class RunningLockAdapter extends BaseAdapter {
  private ctxAdapter: ContextAdapter;
  // Whether the engine currently wants the screen kept on (RunningLock.Start
  // without a matching Stop). Restored when the app returns to foreground.
  private engineRequested: boolean = false;
  // Foreground reference count across all WebAbility instances; the screen
  // flag is cleared only when the LAST window goes to the background.
  private foregroundWindows: number = 0;

  constructor(@inject(ContextAdapter) ctxAdapter: ContextAdapter) {
    super();
    this.ctxAdapter = ctxAdapter;
  }

  @LogMethod
  start() {
    this.engineRequested = true;
    this.keepScreenOn(true);
  }

  @LogMethod
  stop() {
    this.engineRequested = false;
    this.keepScreenOn(false);
  }

  // Battery guard, driven by WebAbility.onForeground/onBackground. A leaked
  // Start (engine or plugin asked for prevent-display-sleep and never
  // stopped it) must not keep the screen on while the app is backgrounded.
  // The engine's request is remembered while backgrounded and re-applied on
  // the first foreground window; the engine can always Start again itself.
  notifyAppForeground(): void {
    this.foregroundWindows += 1;
    if (this.foregroundWindows === 1 && this.engineRequested) {
      this.keepScreenOn(true);
    }
  }

  notifyAppBackground(): void {
    if (this.foregroundWindows > 0) {
      this.foregroundWindows -= 1;
    }
    if (this.foregroundWindows === 0) {
      this.keepScreenOn(false);
    }
  }

  private keepScreenOn(isKeepScreenOn: boolean) {
    window.getLastWindow(this.ctxAdapter.getActiveContext()).then((data) => {
      try {
        data.setWindowKeepScreenOn(isKeepScreenOn, (err: BusinessError) => {
          const errCode: number = err.code;
          if (errCode) {
            LogUtil.error(TAG, 'Failed to set the screen on. Cause: ' + JSON.stringify(err));
            return;
          }
        });
      } catch (exception) {
        LogUtil.error(TAG, 'Failed to set the screen on. Cause: ' + JSON.stringify(exception));
      }
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, 'Failed to obtain the top window. Cause: ' + JSON.stringify(err));
    });
  }
}
