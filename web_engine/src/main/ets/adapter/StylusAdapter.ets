/*
 * Copyright (c) 2023-2025 Haitai FangYuan Co., Ltd.
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this list of
 * conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list
 * of conditions and the following disclaimer in the documentation and/or other materials
 * provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used
 * to endorse or promote products derived from this software without specific prior written
 * permission.
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

import { stylusInteraction } from '@kit.Penkit';
import { BusinessError } from '@kit.BasicServicesKit';
import LogUtil from '../utils/LogUtil';

const TAG: string = 'StylusAdapter';

/**
 * A pen-barrel gesture the system reports for the whole process. The events
 * carry only a timestamp, so the meaning (pen/eraser toggle, palette, undo…)
 * is decided by the renderer's ink layer.
 */
export type StylusKind = 'doubleTap' | 'squeeze';

export type StylusSender = (kind: StylusKind, ts: number) => void;

/**
 * One process-wide subscription to Pen Kit's stylusInteraction service plus a
 * tiny registry so each Obsidian window (Index page) can receive the gesture
 * that belongs to it.
 *
 * Why a static class instead of an injected adapter: the service is process
 * scoped, not per-ability, and registering it once is the whole point. A
 * second `on()` from another window would duplicate every gesture.
 */
export class StylusAdapter {
  private static subscribed: boolean = false;
  private static supported: boolean = false;
  private static availableCache: number = -1;
  private static lastError: string = '';
  private static lastKind: string = '';
  private static lastEventAt: number = 0;
  private static eventCount: number = 0;
  private static senders: Map<string, StylusSender> = new Map<string, StylusSender>();

  static available(): boolean {
    if (StylusAdapter.availableCache >= 0) {
      return StylusAdapter.availableCache === 1;
    }
    try {
      const ok: boolean = canIUse('SystemCapability.Stylus.StylusService');
      StylusAdapter.availableCache = ok ? 1 : 0;
      return ok;
    } catch (e) {
      StylusAdapter.availableCache = 0;
      return false;
    }
  }

  /**
   * Subscribes once. Safe to call from every page; unsupported devices simply
   * leave `supported` false and the settings page reports it.
   */
  static ensure(): void {
    StylusAdapter.supported = StylusAdapter.available();
    if (StylusAdapter.subscribed || !StylusAdapter.supported) {
      return;
    }
    try {
      stylusInteraction.on('doubleTap', (e: stylusInteraction.DoubleTapEvent) => {
        StylusAdapter.dispatch('doubleTap', e.timestamp);
      });
      stylusInteraction.on('squeeze', (e: stylusInteraction.SqueezeEvent) => {
        StylusAdapter.dispatch('squeeze', e.timestamp);
      });
      StylusAdapter.subscribed = true;
      StylusAdapter.lastError = '';
      LogUtil.info(TAG, 'stylus interaction subscribed');
    } catch (err) {
      const e = err as BusinessError;
      StylusAdapter.lastError = 'code=' + e.code + ' ' + e.message;
      LogUtil.warn(TAG, 'stylus interaction subscribe failed: ' + StylusAdapter.lastError);
    }
  }

  static register(id: string, sender: StylusSender): void {
    StylusAdapter.senders.set(id, sender);
    StylusAdapter.ensure();
  }

  static unregister(id: string): void {
    StylusAdapter.senders.delete(id);
  }

  static isSubscribed(): boolean {
    return StylusAdapter.subscribed;
  }

  static isSupported(): boolean {
    return StylusAdapter.supported;
  }

  static errorText(): string {
    return StylusAdapter.lastError;
  }

  static lastGesture(): string {
    if (!StylusAdapter.lastKind) {
      return '';
    }
    const age: number = StylusAdapter.lastEventAt > 0 ? Date.now() - StylusAdapter.lastEventAt : -1;
    return StylusAdapter.lastKind + '@' + age + 'ms';
  }

  static count(): number {
    return StylusAdapter.eventCount;
  }

  /**
   * A window that is not focused drops the gesture. The renderer also checks
   * document.hasFocus(); this is the first, cheap half of the double filter.
   */
  private static dispatch(kind: StylusKind, ts: number): void {
    StylusAdapter.lastKind = kind;
    StylusAdapter.lastEventAt = Date.now();
    StylusAdapter.eventCount++;
    StylusAdapter.senders.forEach((send: StylusSender) => {
      try {
        send(kind, ts);
      } catch (e) {
        // One dead window must not stop the others.
        LogUtil.warn(TAG, 'stylus sender threw: ' + JSON.stringify(e));
      }
    });
  }
}
