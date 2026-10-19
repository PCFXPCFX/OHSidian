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

import { fileIo } from '@kit.CoreFileKit';
import LogUtil from './LogUtil';

const TAG: string = 'BackPressBridge';

// Back-press bridge (round 96; verdict channel round 105). The system back
// gesture had no in-app handler, so it ran the default Ability teardown -
// with removeMissionAfterTerminate:true on every window ability, one
// side-swipe closed the whole window (the reported "侧划直接退出"). The
// @Entry pages (Index / WindowNode) consume the gesture in onBackPress() and
// publish it through the mode file; the renderer's 200ms mode poll
// (applyBackPress) turns it into close-overlay / navigate-back on the
// FOCUSED window. Round 104 added the overlay/drawer/tab-switcher ladder;
// round 105 added the verdict channel, so a gesture the renderer could not
// consume (the root case) exits the app instead of dying silently.
//
// Channel notes: NativeContext cannot carry it (7 commands, no back, closed
// source) and JSBind points the wrong way (engine -> ArkTS), so this rides
// the mode-file channel - the same one the geometry writers use. RMW with a
// DISTINCT temp suffix + rename publish (atomicity standard from round 94;
// a private suffix keeps this writer's temp file from ever colliding with
// another window's geometry publish if abilities ever run multi-process).
// All ArkTS writers are on one UI thread per process, so intra-process RMW
// windows are already serialized.
export class BackPressBridge {
  // Verdict codes for ackOf(). UNKNOWN means "the renderer has not answered
  // for this seq yet" - it must never be treated as "consumed", or the
  // gesture would be dropped for good again (the round-104 bug class).
  static readonly ACK_HANDLED: number = 0;
  static readonly ACK_UNHANDLED: number = 1;
  static readonly ACK_UNKNOWN: number = -1;

  private static readonly MODE_FILE: string = '/ohsidian-mode.json';
  private static lastSeq: number = 0;

  private static modePath(filesDir: string): string {
    return filesDir + BackPressBridge.MODE_FILE;
  }

  // One read path for all three users (publish, verdict, mode query): the
  // mode file is written by ArkTS and the renderer, so a malformed or
  // half-written file must degrade to "no answer" instead of throwing.
  private static readMode(filesDir: string): Record<string, Object> | null {
    try {
      const filePath: string = BackPressBridge.modePath(filesDir);
      if (!fileIo.accessSync(filePath)) {
        return null;
      }
      const parsed = JSON.parse(fileIo.readTextSync(filePath)) as Record<string, Object>;
      if (parsed === null) {
        return null;
      }
      return parsed;
    } catch (e) {
      return null;
    }
  }

  // Returns the seq it published (0 when the publish failed) so the caller
  // can wait for the renderer's verdict on exactly this gesture.
  static notify(filesDir: string, windowId: string): number {
    let published: number = 0;
    try {
      let cfg: Record<string, Object> = {};
      const loaded = BackPressBridge.readMode(filesDir);
      if (loaded !== null) {
        cfg = loaded;
      }
      let seq: number = BackPressBridge.lastSeq + 1;
      const prev = cfg['backPress'];
      if (prev !== undefined && prev !== null) {
        const p = prev as Record<string, Object>;
        if (typeof p['seq'] === 'number' && (p['seq'] as number) >= seq) {
          seq = (p['seq'] as number) + 1;
        }
      }
      BackPressBridge.lastSeq = seq;
      const payload: Record<string, Object> = {
        'seq': seq,
        'ts': Date.now(),
        'windowId': windowId,
      };
      cfg['backPress'] = payload;
      // A new gesture invalidates the previous verdict; the seq check in
      // ackOf() already guarantees that, this keeps the file honest for logs.
      const cleared: Record<string, Object> = {
        'seq': 0,
        'handled': false,
        'ts': Date.now(),
      };
      cfg['backAck'] = cleared;
      const tmpPath: string = BackPressBridge.modePath(filesDir) + '.bp.tmp';
      const tmp = fileIo.openSync(tmpPath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(tmp.fd, JSON.stringify(cfg));
      } finally {
        fileIo.closeSync(tmp);
      }
      fileIo.renameSync(tmpPath, BackPressBridge.modePath(filesDir));
      published = seq;
      LogUtil.info(TAG, 'back press published: seq=' + seq + ', win=' + windowId);
    } catch (e) {
      // onBackPress is a synchronous system path - failures must never
      // propagate; the gesture is consumed either way.
      LogUtil.warn(TAG, 'back press publish failed: ' + JSON.stringify(e));
    }
    return published;
  }

  // Verdict of the renderer for one gesture: HANDLED / UNHANDLED / UNKNOWN.
  static ackOf(filesDir: string, seq: number): number {
    const cfg = BackPressBridge.readMode(filesDir);
    if (cfg === null) {
      return BackPressBridge.ACK_UNKNOWN;
    }
    const raw = cfg['backAck'];
    if (raw === undefined || raw === null) {
      return BackPressBridge.ACK_UNKNOWN;
    }
    const ack = raw as Record<string, Object>;
    const ackSeq = ack['seq'];
    if (typeof ackSeq !== 'number' || (ackSeq as number) !== seq) {
      return BackPressBridge.ACK_UNKNOWN;
    }
    const handled = ack['handled'] as boolean;
    return handled === true ? BackPressBridge.ACK_HANDLED : BackPressBridge.ACK_UNHANDLED;
  }

  // Three-way helper for the pages: 1 = exit the app, 0 = keep it open, -1 =
  // the renderer has not answered yet (retry once, then keep it open - a
  // missed verdict must never close the app, a stale one must never fire).
  static shouldExit(filesDir: string, seq: number): number {
    const verdict = BackPressBridge.ackOf(filesDir, seq);
    if (verdict === BackPressBridge.ACK_UNKNOWN) {
      return -1;
    }
    if (verdict === BackPressBridge.ACK_HANDLED) {
      return 0;
    }
    return BackPressBridge.isTouchMode(filesDir) ? 1 : 0;
  }

  // Exit-on-root is a touch-mode rule: in desktop/PC mode several windows are
  // visible and back must never tear the whole session down. The mode file is
  // the same source of truth the renderer's resolveWant() reads: override
  // wins, then the system window mode.
  static isTouchMode(filesDir: string): boolean {
    const cfg = BackPressBridge.readMode(filesDir);
    if (cfg === null) {
      return false;
    }
    const rawOverride = cfg['override'];
    let mode: string = 'auto';
    if (typeof rawOverride === 'string') {
      mode = rawOverride as string;
    }
    if (mode === 'touch') {
      return true;
    }
    if (mode === 'desktop') {
      return false;
    }
    const rawSystem = cfg['systemMode'];
    return typeof rawSystem === 'string' && (rawSystem as string) === 'touch';
  }
}
