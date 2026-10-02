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

import fs from '@ohos.file.fs';
import LogUtil from './LogUtil';

const TAG: string = 'EngineFlags';

interface EngineFlagsConfig {
  touchSlopDistance?: number;
  forceDeviceScaleFactor?: number;
  extraFlags?: string[];
}

/**
 * Loads optional Chromium engine tuning flags from
 * <resourceDir>/resources/app/ohsidian-flags.json (packaged, changes need a
 * rebuild) and optionally from <filesDir>/ohsidian-flags-user.json (round
 * 96: the USER layer - app-private storage, editable without repacking, so
 * experimental switch sets can be distributed as a plain JSON file). The
 * user layer only contributes extraFlags, appended AFTER the packaged ones.
 *
 * Either file is optional; when absent or invalid it is skipped (invalid
 * packaged file resets to defaults). Available knobs:
 *  - touchSlopDistance: gesture-recognition touch slop, enlarges the effective
 *    tap tolerance so small finger jitter no longer cancels clicks.
 *  - forceDeviceScaleFactor: force Chromium UI scale; 0 keeps the engine default.
 *  - extraFlags: raw command-line switches appended verbatim.
 */
export class EngineFlags {
  private static cachedFlags: string[] | undefined = undefined;

  static getFlags(resourceDir: string, filesDir?: string): string[] {
    if (EngineFlags.cachedFlags !== undefined) {
      return EngineFlags.cachedFlags;
    }
    const flags: string[] = [];
    try {
      const filePath = resourceDir + '/resources/app/ohsidian-flags.json';
      if (fs.accessSync(filePath)) {
        const config = JSON.parse(fs.readTextSync(filePath)) as EngineFlagsConfig;
        if (config.touchSlopDistance !== undefined && config.touchSlopDistance > 0) {
          flags.push('--touch-slop-distance=' + Math.round(config.touchSlopDistance));
        }
        if (config.forceDeviceScaleFactor !== undefined && config.forceDeviceScaleFactor > 0) {
          flags.push('--force-device-scale-factor=' + config.forceDeviceScaleFactor);
        }
        if (config.extraFlags !== undefined) {
          config.extraFlags.forEach((flag: string) => {
            if (flag.length > 0) {
              flags.push(flag);
            }
          });
        }
      } else {
        LogUtil.info(TAG, 'no ohsidian-flags.json found, using defaults');
      }
    } catch (e) {
      LogUtil.warn(TAG, 'failed to load ohsidian-flags.json: ' + JSON.stringify(e));
      flags.length = 0;
    }
    if (filesDir !== undefined && filesDir.length > 0) {
      try {
        const userPath = filesDir + '/ohsidian-flags-user.json';
        if (fs.accessSync(userPath)) {
          const user = JSON.parse(fs.readTextSync(userPath)) as EngineFlagsConfig;
          if (user.extraFlags !== undefined) {
            user.extraFlags.forEach((flag: string) => {
              if (flag.length > 0) {
                flags.push(flag);
              }
            });
          }
          LogUtil.info(TAG, 'user flags loaded from ' + userPath);
        }
      } catch (e) {
        // invalid user layer only disables the user layer - the packaged
        // flags keep working
        LogUtil.warn(TAG, 'user flags load failed: ' + JSON.stringify(e));
      }
    }
    LogUtil.info(TAG, 'engine flags: ' + flags.join(' '));
    EngineFlags.cachedFlags = flags;
    return flags;
  }
}
