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
import { Want, wantConstant } from '@kit.AbilityKit';
import uri from '@ohos.uri';

import { BaseAdapter } from '../common/BaseAdapter';
import LogMethod from '../common/LogDecorator';
import LogUtil from '../utils/LogUtil';
import LaunchHelper from '../utils/LaunchHelper';
import { ContextAdapter } from './ContextAdapter';

@injectable()
export class ExternalProtocolAdapter extends BaseAdapter {
  private static TAG: string = 'ExternalProtocolAdapter';
  private static ALLOWED_SCHEMES: string[] = ['http', 'https', 'mailto', 'tel', 'obsidian'];
  private ctxAdapter: ContextAdapter;

  constructor(@inject(ContextAdapter) ctxAdapter: ContextAdapter) {
    super();
    this.ctxAdapter = ctxAdapter;
  }

  // Only launch well-known web/contact schemes. The renderer passes arbitrary
  // strings here and FLAG_START_WITHOUT_TIPS silently launches the handler,
  // so an unfiltered URI would let a page open arbitrary system handlers.
  @LogMethod
  openExternal(urlStr: string) {
    let scheme: string = '';
    try {
      scheme = (new uri.URI(urlStr)).scheme.toLowerCase();
    } catch (err) {
      LogUtil.error(ExternalProtocolAdapter.TAG, 'openExternal: failed to parse url');
      return;
    }
    if (scheme.length === 0 || !ExternalProtocolAdapter.ALLOWED_SCHEMES.includes(scheme)) {
      LogUtil.error(ExternalProtocolAdapter.TAG, 'openExternal: scheme not allowed: ' + scheme);
      return;
    }
    const want: Want = {
      flags: wantConstant.Flags.FLAG_START_WITHOUT_TIPS,
      uri: urlStr
    }
    LaunchHelper.Launch(this.ctxAdapter.getActiveContext(), want);
  }
}
