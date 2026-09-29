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

import AbilityStage from '@ohos.app.ability.AbilityStage';
import { CommandType, ConfigData, ContextType } from '../common/Constants';
import JsBindingUtils from '../utils/JsBindingUtils';
import LogUtil from '../utils/LogUtil';
import Want from '@ohos.app.ability.Want';
import lazy { GlobalThisHelper } from '../utils/GlobalThisHelper';
import lazy { NativeContext } from '../interface/CommonInterface';
import lazy { CommonDependencyProvider } from '../common/CommonDependencyProvider';
import { AbilityConstant } from '@kit.AbilityKit';
import { ConfigurationConstant, Configuration } from '@kit.AbilityKit';
import { NativeThemeAdapter } from '../adapter/NativeThemeAdapter'
import Inject from '../common/InjectModule';

const DELAYED_TIME = 0;
const TAG = 'WebAbilityStage';

export class WebAbilityStage extends AbilityStage {

  private nativeContext: NativeContext | undefined = undefined;
  private nativeThemeAdapter: NativeThemeAdapter | undefined;

  onCreate(): void {
    this.runTaskAsync();
  }

  onAcceptWant(want: Want): string {
    let instanceKey = want.parameters?.instanceKey;
    if (instanceKey) {
      return instanceKey.toString();
    }
    // Termination fast path: a relaunch racing the shutdown of the last
    // window must NOT round-trip kGetLastActiveWidget synchronously - with
    // the browser mid-exit the engine answers nothing and the native call
    // blocks the main thread for its full 3s wait (observed: XCollie
    // "MainThread:AcceptWant 3007ms"), which wedges teardown and ends in an
    // engine-side DisplayManagerAgent CHECK crash (SIGTRAP). Route to
    // browser1 instead - the same answer a cold start would produce.
    if (GlobalThisHelper.isTerminating()) {
      LogUtil.warn(TAG, 'onAcceptWant during termination, fast-path to default window');
      return ConfigData.DEFAULT_WINDOW_ID;
    }
    if (GlobalThisHelper.isLaunched()) {
      try {
        let result = this.nativeContext?.ExecuteCommand(
          CommandType.kGetLastActiveWidget, { is_sync: true });
        let widgetId = result?.last_widget_Id;
        if (widgetId) {
          return ConfigData.WINDOW_PREFIX + widgetId;
        }
      } catch (exception) {
        // A native query failing here must not crash the launcher path.
        LogUtil.error(TAG, 'onAcceptWant last-active query failed: ' + JSON.stringify(exception));
      }
    }
    this.context.getApplicationContext().tempDir;
    return ConfigData.DEFAULT_WINDOW_ID;
  }

  onPrepareTermination(): AbilityConstant.PrepareTermination {
    // is_sync is required here: the system kills the process right after
    // this callback returns TERMINATE_IMMEDIATELY, so an async kAppQuit
    // would never run - the engine's will-quit flush (unsaved-note save,
    // socket cleanup) would be skipped and recent edits lost. Dispatch the
    // command synchronously via JsBindingUtils so it works even if the
    // delayed init in runTaskAsync has not cached this.nativeContext yet.
    // App-level termination always means the browser is going away.
    GlobalThisHelper.markTerminating();
    const nativeContext = this.nativeContext ??
      JsBindingUtils.getNativeContext(ContextType.kMainProcess);
    nativeContext?.ExecuteCommand(CommandType.kAppQuit, { is_sync: true });
    return AbilityConstant.PrepareTermination.TERMINATE_IMMEDIATELY;
  }

  onConfigurationUpdate(config: Configuration) {
    if (config.colorMode !== undefined) {
      this.nativeThemeAdapter?.setSystemNativeTheme(config.colorMode);
    }
  }

  private runTaskAsync() {
    setTimeout(() => {
      JsBindingUtils.initNativeContext(ContextType.kMainProcess);
      this.nativeContext = JsBindingUtils.getNativeContext(ContextType.kMainProcess);
      if (!GlobalThisHelper.isLaunched()) {
        let appContext = this.context.getApplicationContext();
        GlobalThisHelper.appInit(new CommonDependencyProvider(appContext));
      }
      import('../jsbindings/JsBindingMethod').then((ns:ESObject) => {
        ns.JsBindingMethod.bind();
        this.nativeThemeAdapter = Inject.get(NativeThemeAdapter);
      }).catch((err: ESObject)=>{
        // A silent failure here leaves every JS binding unregistered and the
        // UI unresponsive with nothing but a swallowed console.log. Surface
        // it through hilog so release builds can diagnose it.
        LogUtil.error('WebAbilityStage', 'JsBindingMethod import/bind failed: ' + JSON.stringify(err));
      });
    }, DELAYED_TIME)
  }
}
