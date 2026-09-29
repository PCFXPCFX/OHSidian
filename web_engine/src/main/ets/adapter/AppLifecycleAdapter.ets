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
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';

import { AbilityManager } from '../common/AbilityManager';
import { BaseAdapter } from '../common/BaseAdapter';
import { WebStatus } from '../common/Constants';
import LogMethod from '../common/LogDecorator';
import LogUtil from '../utils/LogUtil';

@injectable()
export class AppLifecycleAdapter extends BaseAdapter {
  private abilityManager: AbilityManager;
  private webStatus: WebStatus;

  constructor(
    @inject(AbilityManager) abilityManager: AbilityManager,
  ) {
    super();
    this.abilityManager = abilityManager;
    this.webStatus = WebStatus.kInit;
  }

  @LogMethod
  onWebCreate() {
    this.webStatus = WebStatus.kStart;
    this.start();
  }

  @LogMethod
  onWebDestroy() {
    this.webStatus = WebStatus.kDestroy;
    this.destroy();
  }

  getWebStatus(): number {
    return this.webStatus;
  }

  start() {}

  destroy() {
    let proxy_list = this.abilityManager.getProxyList();
    // Sub-window/floating-window proxies share their parent ability's
    // context, and a single ability can own several windows - terminating
    // the same context N+1 times only works once and then rejects with
    // "already terminating". Terminate each DISTINCT context once; killing
    // the owning ability also tears down its child windows.
    let terminated: Set<Object> = new Set();
    for (let i = 0; i < proxy_list.length; i++) {
      let context = proxy_list[i].getWindowContext() as common.UIAbilityContext;
      if (!context || terminated.has(context)) {
        continue;
      }
      terminated.add(context);
      context.terminateSelf()?.catch((err: BusinessError) => {
        LogUtil.error('AppLifecycleAdapter', 'terminateSelf failed: ' + JSON.stringify(err));
      });
    }
  }
}
