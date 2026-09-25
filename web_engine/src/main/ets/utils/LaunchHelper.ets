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
                           options: StartOptions): boolean {
    try {
      let context = uiContext as common.UIAbilityContext ||
        uiContext as common.UIExtensionContext;
      if (!context) {
        LogUtil.error(TAG, `excute failed, want: ${JSON.stringify(want)}, options:  ${JSON.stringify(options)}`);
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
            LogUtil.warn(TAG, 'retrying with geometry-only StartOptions');
            context.startAbility(want, reduced)
              .then(() => {
                LogUtil.info(TAG, `geometry-only retry succeeded`);
              })
              .catch((retryError: BusinessError) => {
                LogUtil.error(TAG, `geometry-only retry failed: ${JSON.stringify(retryError)} - launching bare`);
                context.startAbility(want)
                  .then(() => {
                    LogUtil.info(TAG, `bare retry succeeded`);
                  })
                  .catch((bareError: BusinessError) => {
                    LogUtil.error(TAG, `bare launch failed. Cause: ${JSON.stringify(bareError)}`);
                  });
              });
          }
          return false;
        });
    } catch (exception) {
      LogUtil.error(TAG, `excute failed exception. Cause: ${JSON.stringify(exception)}`);
      return false;
    }
    return true;
  }

  static Launch(uiContext: Context | undefined, want: Want): boolean {
    return LaunchHelper.LaunchWithOptions(uiContext, want, {});
  }
}
