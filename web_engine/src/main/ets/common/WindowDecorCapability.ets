/*
 * WMS decor capability cache (report 2026-11-22, T2-2 / NF-017).
 *
 * On a tablet touch-fixed window the WMS answers 801 ("The device is not
 * supported") for the caption family: title drag, topmost, modal, drag-resize.
 * Every cold start issued those calls unconditionally and logged an E/W pair
 * for each, so six-plus lines of pure noise landed before the first frame and
 * buried the actual signal.
 *
 * A 801 is a capability verdict, not a bug: it cannot be fixed in the app and
 * it repeats on every event. This cache reports the FIRST 801 per call kind
 * once (one info line naming the capability) and drops the repeats to debug;
 * any other error keeps the old loud behaviour.
 *
 * Deliberately NO call is skipped after a 801. A 801 can be form-factor
 * dependent (the touch-fixed window has no caption at all, while a free window
 * of the same process still wants one), so muting a kind for the whole session
 * could leave a later free/multi-window without its caption, drag or modal
 * state. The real noise reduction comes from WebAbility only issuing the
 * caption family for a window form factor; this class only fixes the logging.
 */
import LogUtil from '../utils/LogUtil';
import { BusinessError } from '@ohos.base';

const TAG: string = 'WindowDecorCapability';

export class WindowDecorCapability {
  /* Kinds that answered 801 at least once this session (boot-log snapshot). */
  private static reported: Set<string> = new Set<string>();

  /* Runs one decor call; a repeat 801 is logged at debug, not per event.
     Returns false when the call threw, so callers that own a latch can keep
     it unchanged instead of recording a state the WMS refused. */
  static run(kind: string, action: () => void): boolean {
    try {
      action();
      return true;
    } catch (exception) {
      WindowDecorCapability.record(kind, exception);
      return false;
    }
  }

  /* Records a decor failure from a sync catch or a rejected promise. */
  static record(kind: string, exception: Object): void {
    let code: number = 0;
    try {
      code = (exception as BusinessError).code;
    } catch (castException) {
      code = 0;
    }
    if (code !== 801) {
      LogUtil.warn(TAG, 'decor call failed: ' + kind + ' :: ' + JSON.stringify(exception));
      return;
    }
    if (!WindowDecorCapability.reported.has(kind)) {
      WindowDecorCapability.reported.add(kind);
      LogUtil.info(TAG, 'decor API answered 801 (device does not support it): ' + kind +
        ' - repeats at debug level');
      return;
    }
    LogUtil.debug(TAG, 'decor API answered 801 again: ' + kind);
  }

  /* Boot-log snapshot: which decor capabilities this device turned out to lack. */
  static snapshot(): string {
    const parts: string[] = [];
    WindowDecorCapability.reported.forEach((kind: string) => {
      parts.push(kind);
    });
    return '801=[' + parts.join(',') + ']';
  }
}
