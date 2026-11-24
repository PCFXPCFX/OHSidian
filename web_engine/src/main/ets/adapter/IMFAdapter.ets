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

import { injectable } from 'inversify';
import inputMethod from '@ohos.inputMethod';

import { BaseAdapter } from '../common/BaseAdapter';
import { BusinessError } from '@ohos.base';
import LogMethod from '../common/LogDecorator';
import LogUtil from '../utils/LogUtil';
import { deviceInfo } from '@kit.BasicServicesKit';

import {
  IMFAdapterCursorInfo,
  IMFAdapterInputAttribute,
  IMFAdapterTextConfig } from '../interface/CommonInterface';

const TAG: string = 'IMFAdapter';

/*
 * Issue #2 (手写输入法文字重复堆叠): the engine bridge exposes only
 * insert / delete-back / delete-forward / enter / move-cursor. It has no
 * composition (preview-text) channel and no selection or surround-text
 * readback, so an input method whose model is "replace the current composition
 * candidate" - handwriting, pen-by-pen recognition - can only degrade to
 * deleteBackward(n) + insertText(candidate), with n guessed by the IME itself.
 * When that guess is short (observed 0 or 1 while the real candidate was
 * longer), every revision leaves the previous candidate on screen and text
 * accumulates: AB -> AAAB, 今天天气不错 -> 今天天气今天天气不错, and it gets worse
 * the more often the candidate is revised - exactly the reported shape.
 *
 * The adapter cannot create a composition channel (that is the engine's bridge,
 * see the audit report), but it does know exactly what it last inserted. So it
 * can close the bookkeeping loop on the events that DO arrive: when a
 * deleteBackward is immediately followed by an insert whose text continues the
 * previous insert (same prefix), top up the delete to the previous insert's
 * length before inserting. That is purely local accounting over events already
 * delivered to the renderer - no ABI change, no new bridge symbol.
 *
 * Scope guard rails (all deliberately tight):
 *  - revision window 40 ms: a human cannot backspace and retype within it, but
 *    an IME emits delete+insert for one revision back to back;
 *  - prefix relation required, so "今天" -> "明天" (a real edit) is never
 *    treated as a revision;
 *  - UNDER-deletion is topped up (Issue #2 堆叠);
 *  - OVER-deletion inside a burst that already removed the candidate is dropped
 *    (v2.2.0 "退格吞字": one backspace carried D(6)+D(1) for a 6-char candidate,
 *    so the extra delete removed 正文 before the candidate). Bounded by
 *    IME_MAX_OVERDELETE_DROPS so a held backspace still deletes;
 *  - empty inserts (composition-boundary markers) are forwarded as no-ops but
 *    no longer clear the bookkeeping - clearing it blinded the over-delete guard;
 *  - segment / correction length caps keep a misfire small and bounded;
 *  - any other input event (forward delete, enter, cursor move, detach) clears
 *    the tracked segment.
 *
 * Residual risk (documented in docs/IME-BRIDGE.md and docs/CHANGES-2026-11.md):
 * an IME that legitimately deletes the candidate AND one surrounding character
 * inside the same 40 ms burst loses that second delete and needs another press
 * (logged). Set IME_SEGMENT_CORRECTION_ENABLED / IME_OVERDELETE_GUARD_ENABLED to
 * false for a one-line rollback; real-device regression is still required.
 */
const IME_SEGMENT_CORRECTION_ENABLED: boolean = true;
const IME_REVISION_WINDOW_MS: number = 40;
const IME_SEGMENT_MAX_CHARS: number = 16;
const IME_SEGMENT_MAX_CORRECTION: number = 12;
/* The pinned engine ignores the count argument of the delete-backward bridge:
   one call removes one character. Keep true for this engine; see imeDeleteBack. */
const IME_EMULATE_MULTI_DELETE: boolean = true;
/* Safety cap for the emulated loop: handwriting revisions never ask for more
   than a candidate segment, and an unbounded loop on a broken event stream
   would block the UI thread. Larger requests are clamped and logged. */
const IME_MAX_DELETE_CHARS: number = 64;
/* Over-delete guard (device report 2026-11-24 "退格吞字"): 微信输入法 sends
   DeleteLeft(6) + DeleteLeft(1) for ONE backspace on a 6-character candidate.
   The extra delete is the key press itself and lands after the candidate is
   already gone, so it eats a character of the text BEFORE the candidate.
   Keep this separate from IME_SEGMENT_CORRECTION_ENABLED so a device A/B run can
   tell the two heuristics apart. */
const IME_OVERDELETE_GUARD_ENABLED: boolean = true;
/* A held backspace must keep deleting: only the first few over-deletes of one
   burst are dropped, then normal forwarding resumes. */
const IME_MAX_OVERDELETE_DROPS: number = 2;
/* Per-event diagnostics (lengths only, no text content). Flip to true when a
   device log is needed for an IME event-stream investigation. */
const IME_DEBUG_EVENTS: boolean = false;

/*
 * Issue #2 accounting state lives at MODULE scope on purpose. IMFAdapter is
 * resolved through Inject.getOrCreate(), which lazily binds it with the default
 * inversify scope (transient): every native callback and every focus change can
 * resolve a fresh instance. Instance fields would therefore reset on each
 * callback, and each showTextInput() on a fresh instance would register a
 * SECOND set of keyboard listeners (double-delivered text). One module-level
 * object is shared by all instances, so the bookkeeping and the "listeners
 * already registered" flag survive however the adapter is bound (audit B-4).
 */
class ImeSegmentState {
  lastInsertText: string = '';
  pendingDeleteLength: number = -1;
  pendingDeleteAt: number = 0;
  lastInsertAt: number = 0;
  listenBound: boolean = false;
  overDeleteDrops: number = 0;
}

const imeSegment: ImeSegmentState = new ImeSegmentState();

@injectable()
export class IMFAdapter extends BaseAdapter {
  private inputMethodController = inputMethod.getController();

  @LogMethod
  attachTextInput(textConfigIMF: IMFAdapterTextConfig, requestKeyboardReason: number, callback: (ret: boolean) => void) {
    this.resetImeSegmentState();
    this.attachTextInputHelper(textConfigIMF, requestKeyboardReason, callback)
  }

  @LogMethod
  cursorUpdate(cursorInfoIMF: IMFAdapterCursorInfo) {
    let cursorInfo: inputMethod.CursorInfo = {
      left: cursorInfoIMF.left as number,
      top: cursorInfoIMF.top as number,
      width: cursorInfoIMF.width as number,
      height: cursorInfoIMF.height as number
    };
    this.inputMethodController.updateCursor(cursorInfo, (err: BusinessError) => {
      if (err) {
        LogUtil.error(TAG, `Failed to updateCursor:` + JSON.stringify(err));
        return;
      }
    });
  }

  @LogMethod
  detachTextInput(callback: (ret: boolean) => void) {
    this.resetImeSegmentState();
    this.detachTextInputHelper(callback);
  }

  @LogMethod
  updateAttribute(inputAttributeIMF: IMFAdapterInputAttribute) {
    let inputAttribute: inputMethod.InputAttribute = {
      textInputType: inputAttributeIMF.inputPattern as inputMethod.TextInputType,
      enterKeyType: inputAttributeIMF.enterKeyType as inputMethod.EnterKeyType
    };
    this.inputMethodController.updateAttribute(inputAttribute, (err: BusinessError) => {
      if (err) {
        LogUtil.error(TAG, `Failed to updateAttribute:` + JSON.stringify(err));
        return;
      }
    });
  }

  @LogMethod
  showTextInput(requestKeyboardReason: number) {
    // Re-register the IME listeners if a previous offListenIME() detached
    // them: without this the soft keyboard comes up but typing is dead.
    // (showTextInputHelper does the same for the attach-driven path.)
    if (!imeSegment.listenBound) {
      this.onListenIME();
      imeSegment.listenBound = true;
    }
    if (deviceInfo.sdkApiVersion >= 15) {
      this.inputMethodController.showTextInput(requestKeyboardReason).then(() => {
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, `Failed to showTextInput:` + JSON.stringify(err));
      });
    } else {
      this.inputMethodController.showTextInput((err: BusinessError) => {
        if (err) {
          LogUtil.error(TAG, `Failed to showTextInput:` + JSON.stringify(err));
          return;
        }
      });
    }
  }

  @LogMethod
  offListenIME(){
    LogUtil.info(TAG, 'Unregisters the input method event listening function');
    this.inputMethodController.off('insertText');
    this.inputMethodController.off('deleteLeft');
    this.inputMethodController.off('deleteRight');
    this.inputMethodController.off('sendFunctionKey');
    this.inputMethodController.off('moveCursor');
    // Allow a later attach to re-register the listeners, otherwise the soft
    // keyboard stops delivering input for the rest of the session.
    imeSegment.listenBound = false;
    this.resetImeSegmentState();
  }

  private attachTextInputHelper(textConfigIMF: IMFAdapterTextConfig, requestKeyboardReason: number,
    callback: (ret: boolean) => void) {
    let textConfig: inputMethod.TextConfig = {
      inputAttribute: {
        textInputType: textConfigIMF.inputAttribute.inputPattern,
        enterKeyType: textConfigIMF.inputAttribute.enterKeyType
      },
      cursorInfo: {
        left: textConfigIMF.cursorInfo.left,
        top: textConfigIMF.cursorInfo.top,
        width: textConfigIMF.cursorInfo.width,
        height: textConfigIMF.cursorInfo.height
      }
    };
    this.inputMethodController.attach(true, textConfig).then(() => {
      this.showTextInputHelper(requestKeyboardReason, callback);
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `Failed to attach:` + JSON.stringify(err));
      callback(false);
    });
  }

  private showTextInputHelper(requestKeyboardReason: number, callback: (ret: boolean) => void) {
    if (deviceInfo.sdkApiVersion >= 15) {
      this.inputMethodController.showTextInput(requestKeyboardReason).then(() => {
        if (!imeSegment.listenBound) {
          this.onListenIME();
          imeSegment.listenBound = true;
        }
        callback(true);
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, `Failed to showTextInput:` + JSON.stringify(err));
        callback(false);
      });
    } else {
      this.inputMethodController.showTextInput().then(() => {
        if (!imeSegment.listenBound) {
          this.onListenIME();
          imeSegment.listenBound = true;
        }
        callback(true);
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, `Failed to showTextInput:` + JSON.stringify(err));
        callback(false);
      });
    }
  }

  private onListenIME() {
    // The module-level flag is the real guard: a fresh adapter instance (see the
    // ImeSegmentState comment) must not register a second listener set.
    if (imeSegment.listenBound) {
      return;
    }
    imeSegment.listenBound = true;
    this.inputMethodController.on('insertText', (text: string) => {
      this.applyImeInsert(text);
      // Deliberately NOT calling changeSelection here: the text buffer lives
      // in the web renderer, the adapter has no real text to report, and the
      // previous "0"/"1"/"2"... counter poisoned the IME's selection state
      // (jumpy candidates and bogus composition highlights while typing).
    });
    this.inputMethodController.on('deleteLeft', (length: number) => {
      this.applyImeDeleteLeft(length);
    });
    this.inputMethodController.on('deleteRight', (length: number) => {
      this.resetImeSegmentState();
      this.nativeContext.DeleteForwardCallback(length);
    });
    this.inputMethodController.on('sendFunctionKey', () => {
      this.resetImeSegmentState();
      this.nativeContext.SendEnterKeyEventCallback();
    });
    this.inputMethodController.on('moveCursor', (direction: inputMethod.Direction) => {
      this.resetImeSegmentState();
      this.nativeContext.MoveCursorCallback(direction);
    });
  }

  /**
   * Issue #2: remember what the IME just inserted so a following candidate
   * revision can be checked against the text that is actually on screen.
   */
  private applyImeInsert(text: string): void {
    let now: number = Date.now();
    if (IME_DEBUG_EVENTS) {
      LogUtil.info(TAG, `IME ev insert len=${text.length} burst=${imeSegment.pendingDeleteLength} last=${imeSegment.lastInsertText.length}`);
    }
    if (text.length === 0) {
      /* Composition-boundary marker: the buffer change is a no-op, but the
         segment bookkeeping MUST survive it. Clearing the pending delete here
         used to blind the over-delete guard exactly in the burst that needed it
         (device report 2026-11-24: D(6) -> I("") -> D(1) -> ...). */
      this.nativeContext.InsertTextCallback(text);
      return;
    }
    let prev: string = imeSegment.lastInsertText;
    let withinDelete: boolean = imeSegment.pendingDeleteAt > 0 &&
      (now - imeSegment.pendingDeleteAt) <= IME_REVISION_WINDOW_MS &&
      imeSegment.pendingDeleteLength >= 0;
    let withinInsert: boolean = imeSegment.lastInsertAt > 0 &&
      (now - imeSegment.lastInsertAt) <= IME_REVISION_WINDOW_MS;
    if (IME_SEGMENT_CORRECTION_ENABLED && prev.length > 0 && prev.length <= IME_SEGMENT_MAX_CHARS &&
      !this.imeHasSurrogate(prev) && !this.imeHasSurrogate(text) &&
      this.imePrefixRelated(prev, text)) {
      let deficit: number = -1;
      if (withinDelete) {
        // The IME removed the current candidate and is writing its replacement.
        // Deficit > 0 means it removed less than the previous candidate length.
        deficit = prev.length - imeSegment.pendingDeleteLength;
      } else if (withinInsert && text.length > prev.length) {
        // The IME replaced the candidate without deleting at all.
        deficit = prev.length;
      }
      if (deficit > 0 && deficit <= IME_SEGMENT_MAX_CORRECTION) {
        this.imeDeleteBack(deficit);
        LogUtil.info(TAG, `IME candidate revision: removed ${deficit} leftover char(s) of "${prev}"`);
      }
    }
    this.nativeContext.InsertTextCallback(text);
    imeSegment.lastInsertText = text;
    imeSegment.lastInsertAt = now;
    imeSegment.pendingDeleteLength = -1;
    imeSegment.pendingDeleteAt = 0;
    imeSegment.overDeleteDrops = 0;
  }

  /**
   * Issue #2: forward the deletion, but remember how much was removed within the
   * revision window (one revision can arrive as several chunks). Deletes that
   * would eat text before an already-removed candidate are dropped first.
   */
  private applyImeDeleteLeft(length: number): void {
    let now: number = Date.now();
    let inBurst: boolean = imeSegment.pendingDeleteAt > 0 &&
      (now - imeSegment.pendingDeleteAt) <= IME_REVISION_WINDOW_MS;
    if (IME_DEBUG_EVENTS) {
      LogUtil.info(TAG, `IME ev delete len=${length} burst=${imeSegment.pendingDeleteLength} last=${imeSegment.lastInsertText.length}`);
    }
    if (IME_OVERDELETE_GUARD_ENABLED && inBurst && length > 0 &&
      imeSegment.pendingDeleteLength >= 2 && imeSegment.lastInsertText.length >= 2 &&
      imeSegment.pendingDeleteLength >= imeSegment.lastInsertText.length &&
      imeSegment.overDeleteDrops < IME_MAX_OVERDELETE_DROPS) {
      /* The candidate at the caret has already been removed inside this burst;
         another delete can only take a character of the surrounding text.
         Refresh the burst timestamp so the rest of the burst stays guarded. */
      imeSegment.overDeleteDrops++;
      imeSegment.pendingDeleteAt = now;
      LogUtil.warn(TAG, `IME over-delete dropped: ${length} char(s) after ${imeSegment.pendingDeleteLength}/${imeSegment.lastInsertText.length} (device backspace case)`);
      return;
    }
    if (!inBurst) {
      imeSegment.overDeleteDrops = 0;
    }
    this.imeDeleteBack(length);
    if (inBurst) {
      imeSegment.pendingDeleteLength += length;
    } else {
      imeSegment.pendingDeleteLength = length;
    }
    imeSegment.pendingDeleteAt = now;
    if (imeSegment.pendingDeleteLength > IME_SEGMENT_MAX_CHARS) {
      // Too much removed to be one candidate segment; stop trusting the window.
      this.resetImeSegmentState();
    }
  }

  /**
   * The engine bridge's DeleteBackward ignores the count: a device HiLog trace
   * (2026-11-24, MatePad Air / 7.0.0) shows `DeleteLeft,length: 2` moving the
   * caret exactly one character, twice in a row. The IME's handwriting model is
   * "replace the whole current candidate", so every multi-character revision
   * left the previous candidate behind and the text accumulated
   * (我爱 → 我爱我爱北 → …). Emulate the count with one-character deletes.
   *
   * NOTE: this is coupled to the pinned engine binaries (electron/libs/*.so).
   * If a future engine honours the argument, set IME_EMULATE_MULTI_DELETE to
   * false (otherwise every delete would be applied count×count times).
   */
  private imeDeleteBack(count: number): void {
    let n: number = Math.floor(count);
    if (!(n > 0)) {
      return;
    }
    if (n > IME_MAX_DELETE_CHARS) {
      LogUtil.warn(TAG, `IME delete clamped: ${n} -> ${IME_MAX_DELETE_CHARS}`);
      n = IME_MAX_DELETE_CHARS;
    }
    if (!IME_EMULATE_MULTI_DELETE || n === 1) {
      this.nativeContext.DeleteBackCallback(n);
      return;
    }
    LogUtil.info(TAG, `IME multi-delete emulated: ${n} characters (engine ignores the count)`);
    for (let i = 0; i < n; i++) {
      this.nativeContext.DeleteBackCallback(1);
    }
  }

  /**
   * Audit B-1: `prev.length` is in UTF-16 code units while IMF's deleteLeft
   * length is in the platform's own character unit. They coincide for BMP text
   * (every common CJK char) and diverge for supplementary code points
   * (rare CJK extensions, emoji). Guess-correction is only safe where the two
   * units provably agree, so a candidate segment containing a surrogate pair
   * disables the correction for that round instead of deleting the wrong count.
   */
  private imeHasSurrogate(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
      let code: number = text.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDFFF) {
        return true;
      }
    }
    return false;
  }

  private imePrefixRelated(prev: string, next: string): boolean {
    if (prev.length === 0 || next.length === 0) {
      return false;
    }
    let common: number = Math.min(prev.length, next.length);
    for (let i = 0; i < common; i++) {
      if (prev.charAt(i) !== next.charAt(i)) {
        return false;
      }
    }
    return true;
  }

  private resetImeSegmentState(): void {
    imeSegment.lastInsertText = '';
    imeSegment.pendingDeleteLength = -1;
    imeSegment.pendingDeleteAt = 0;
    imeSegment.lastInsertAt = 0;
    imeSegment.overDeleteDrops = 0;
  }

  private detachTextInputHelper(callback: (ret: boolean) => void) {
    this.inputMethodController.detach().then(() => {
      callback(true); 
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `Failed to detach:` + JSON.stringify(err));
      callback(false);
    });
  }
}
