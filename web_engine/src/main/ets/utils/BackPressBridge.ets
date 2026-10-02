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

// Back-press bridge (round 96). The system back gesture had no in-app
// handler, so it ran the default Ability teardown - with
// removeMissionAfterTerminate:true on every window ability, one side-swipe
// closed the whole window (the reported "侧划直接退出"). The @Entry pages
// (Index / WindowNode) now consume the gesture in onBackPress() and publish
// it through the mode file; the renderer's 200ms mode poll (applyBackPress)
// turns it into close-overlay / navigate-back on the FOCUSED window.
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
  private static lastSeq: number = 0;

  static notify(filesDir: string, windowId: string): void {
    try {
      const filePath: string = filesDir + '/ohsidian-mode.json';
      let cfg: Record<string, Object> = {};
      try {
        if (fileIo.accessSync(filePath)) {
          cfg = JSON.parse(fileIo.readTextSync(filePath)) as Record<string, Object>;
          if (!cfg) {
            cfg = {};
          }
        }
      } catch (e) {
        cfg = {};
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
      const tmpPath: string = filePath + '.bp.tmp';
      const tmp = fileIo.openSync(tmpPath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(tmp.fd, JSON.stringify(cfg));
      } finally {
        fileIo.closeSync(tmp);
      }
      fileIo.renameSync(tmpPath, filePath);
      LogUtil.info(TAG, 'back press published: seq=' + seq + ', win=' + windowId);
    } catch (e) {
      // onBackPress is a synchronous system path - failures must never
      // propagate; the gesture is consumed either way.
      LogUtil.warn(TAG, 'back press publish failed: ' + JSON.stringify(e));
    }
  }
}
