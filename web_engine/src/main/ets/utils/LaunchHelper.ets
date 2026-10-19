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

import { StartOptions, Want } from '@kit.AbilityKit';
import LogUtil from './LogUtil';
import common from '@ohos.app.ability.common';
import { BusinessError } from '@kit.BasicServicesKit';

const TAG: string = 'LaunchHelper';

export default class LaunchHelper {
  static LaunchWithOptions(uiContext: Context | undefined,
                           want: Want,
                           options: StartOptions,
                           onAllFailed?: () => void): boolean {
    const notifyFailed = (): void => {
      if (onAllFailed === undefined) {
        return;
      }
      try {
        onAllFailed();
      } catch (callbackException) {
        LogUtil.warn(TAG, 'onAllFailed callback threw: ' + JSON.stringify(callbackException));
      }
    };
    try {
      let context = uiContext as common.UIAbilityContext ||
        uiContext as common.UIExtensionContext;
      if (!context) {
        LogUtil.error(TAG, `excute failed, want: ${JSON.stringify(want)}, options:  ${JSON.stringify(options)}`);
        notifyFailed();
        return false;
      }
      context.startAbility(want, options)
        .then(() => {
          LogUtil.info(TAG, `excute success`);
        })
        .catch((error: BusinessError) => {
          LogUtil.error(TAG, `excute failed. Cause: ${JSON.stringify(error)}`);
          // This WMS build rejects parts of the full option set with 16000067
          // ("The StartOptions check failed") - observed even with valid
          // geometry, which points at the processMode/startupVisibility pair.
          // Retry ladder: geometry-only StartOptions (keeps the intended size
          // and placement), then a bare want (system-default placement).
          // Round 106 audit P1: any OTHER error means the ladder never starts
          // (16200001 = "ability not started", the exact code a terminating
          // context answers with) - report the failure here, otherwise the
          // P0 acceptance anchor ("every launch attempt failed") would never
          // be printed on the path it exists for.
          if (error.code === 16000067) {
            let reduced: StartOptions = {};
            if (options.windowLeft !== undefined) {
              reduced.windowLeft = options.windowLeft;
            }
            if (options.windowTop !== undefined) {
              reduced.windowTop = options.windowTop;
            }
            if (options.windowWidth !== undefined) {
              reduced.windowWidth = options.windowWidth;
            }
            if (options.windowHeight !== undefined) {
              reduced.windowHeight = options.windowHeight;
            }
            if (options.displayId !== undefined) {
              reduced.displayId = options.displayId;
            }
            // Round 99: windowMode MUST survive the ladder. Dropping it turned
            // a fullscreen touch-mode launch into a system-default floating
            // window that was only corrected afterwards - the visible "窗口跳
            // 转错误" (a small window appears, then jumps/fills). The rejected
            // pair is processMode/startupVisibility, not windowMode.
            if (options.windowMode !== undefined) {
              reduced.windowMode = options.windowMode;
            }
            LogUtil.warn(TAG, 'retrying with geometry-only StartOptions');
            LaunchHelper.startRung(context, want, reduced, 'geometry-only retry', false, notifyFailed);
          } else {
            notifyFailed();
          }
          return false;
        });
    } catch (exception) {
      LogUtil.error(TAG, `excute failed exception. Cause: ${JSON.stringify(exception)}`);
      notifyFailed();
      return false;
    }
    return true;
  }

  static Launch(uiContext: Context | undefined, want: Want): boolean {
    return LaunchHelper.LaunchWithOptions(uiContext, want, {});
  }

  // One rung of the retry ladder (round 106 audit: the promise-only chain
  // missed synchronous throws - startAbility can throw for an invalid/terminating
  // context - and then never notified the caller; every rung must therefore be
  // wrapped, and the last rung must notify).
  private static startRung(context: common.UIAbilityContext | common.UIExtensionContext,
                           want: Want,
                           options: StartOptions,
                           label: string,
                           isLast: boolean,
                           notifyFailed: () => void): void {
    try {
      context.startAbility(want, options)
        .then(() => {
          LogUtil.info(TAG, `${label} succeeded`);
        })
        .catch((error: BusinessError) => {
          if (isLast) {
            LogUtil.error(TAG, `${label} failed. Cause: ${JSON.stringify(error)}`);
            notifyFailed();
            return;
          }
          LogUtil.error(TAG, `${label} failed: ${JSON.stringify(error)} - launching bare`);
          LaunchHelper.startRung(context, want, {}, 'bare launch', true, notifyFailed);
        });
    } catch (exception) {
      LogUtil.error(TAG, `${label} threw: ${JSON.stringify(exception)}`);
      notifyFailed();
    }
  }
}
