/*
 * Window shape state machine (handover 2026-11-17, landed 2026-11-18).
 *
 * Layer 1 DeviceProfile  - locked once from deviceInfo.deviceType.
 * Layer 2 WindowShape    - the only place that interprets WMS mode events.
 * Layer 3 PublishMode    - derive-only: the mode file has ONE writer (the
 *                          publication action below), never the event callback.
 *
 * Phone is intentionally absent: the shipped module declares only `2in1` and
 * `tablet` in deviceTypes, so a phone can never install this app. Everything
 * else maps to OTHER, which publishes `desktop` exactly like the old
 * "non-touch device type" branch did.
 *
 * Invariants this class is responsible for (spec §八):
 *   I1  the publish value is derived from the shape only - no geometry, no
 *       live getWindowStatus() read inside an event callback;
 *   I2  transitions consume the event value + the current shape variable
 *       (transition-start semantics), never a fresh status read;
 *   I6  leaving TOUCH_FULL requires a real form-factor migration event;
 *   I7  unknown/failed values change nothing (KEEP);
 *   I11 P-2IN1 publishes desktop unconditionally and never requests the
 *       touch-regime corrections.
 *
 * The class is deliberately pure: it performs no WMS calls, so it can be unit
 * reasoned about and the callers keep all side effects.
 */

export enum LayoutProfile {
  TABLET = 0,
  PC2IN1 = 1,
  OTHER = 2
}

export enum WindowShape {
  STARTING = 0,
  TOUCH_FULL = 1,
  FREE_FLOAT = 2,
  SPLIT = 3,
  MAXIMIZED = 4,
  FULLSCREEN = 5,
  MINIMIZED = 6,
  UNKNOWN = 7
}

export enum PublishMode {
  KEEP = 0,
  DESKTOP = 1,
  TOUCH = 2
}

/* window.WindowStatusType values (SDK 6.1.1): UNDEFINED=0, FULL_SCREEN=1,
   MAXIMIZE=2, MINIMIZE=3, FLOATING=4, SPLIT_SCREEN=5. Kept as a local enum so
   this module stays import-free; WebAbility converts with fromWindowStatus. */
export enum ShapeEvent {
  UNKNOWN = 0,
  FULL_SCREEN = 1,
  MAXIMIZE = 2,
  MINIMIZE = 3,
  FLOATING = 4,
  SPLIT_SCREEN = 5
}

export class ShapeEventResult {
  previous: WindowShape = WindowShape.STARTING;
  current: WindowShape = WindowShape.STARTING;
  shapeChanged: boolean = false;
  publish: PublishMode = PublishMode.KEEP;
  // Round 153 self-heal edge: the touch regime lost its fullscreen rect and the
  // window must be re-asserted (only ever true for a tablet in TOUCH_FULL).
  correctTouchFullscreen: boolean = false;
  note: string = '';
}

export class WindowShapeMachine {
  private profile: LayoutProfile = LayoutProfile.OTHER;
  private pcMode: boolean = false;
  private shape: WindowShape = WindowShape.STARTING;
  private returnShape: WindowShape = WindowShape.TOUCH_FULL;

  // Process-wide handle for the adapters that guard WMS calls (AppWindowAdapter
  // is a singleton owned by the injector, WebAbility is one instance per
  // window). The LAST bound live window wins; see bind().
  private static shared: WindowShapeMachine | null = null;

  constructor(deviceType: string) {
    this.profile = WindowShapeMachine.profileOf(deviceType);
  }

  static profileOf(deviceType: string): LayoutProfile {
    if (deviceType === '2in1') {
      return LayoutProfile.PC2IN1;
    }
    if (deviceType === 'tablet') {
      return LayoutProfile.TABLET;
    }
    return LayoutProfile.OTHER;
  }

  static fromWindowStatus(status: number): ShapeEvent {
    switch (status) {
      case 1:
        return ShapeEvent.FULL_SCREEN;
      case 2:
        return ShapeEvent.MAXIMIZE;
      case 3:
        return ShapeEvent.MINIMIZE;
      case 4:
        return ShapeEvent.FLOATING;
      case 5:
        return ShapeEvent.SPLIT_SCREEN;
      default:
        return ShapeEvent.UNKNOWN;
    }
  }

  static bind(machine: WindowShapeMachine): void {
    WindowShapeMachine.shared = machine;
  }

  static unbind(machine: WindowShapeMachine): void {
    if (WindowShapeMachine.shared === machine) {
      WindowShapeMachine.shared = null;
    }
  }

  static sharedMachine(): WindowShapeMachine | null {
    return WindowShapeMachine.shared;
  }

  getProfile(): LayoutProfile {
    return this.profile;
  }

  getShape(): WindowShape {
    return this.shape;
  }

  isPcMode(): boolean {
    return this.pcMode;
  }

  // Boot: adopt the live status WITHOUT treating it as a transition and without
  // publishing (spec S0 -> S1/S2: the disk value stays authoritative until the
  // first real mode event).
  seedStatus(status: number): void {
    const event: ShapeEvent = WindowShapeMachine.fromWindowStatus(status);
    this.shape = this.shapeOfEvent(event, this.shape);
    if (this.shape === WindowShape.MINIMIZED) {
      this.returnShape = WindowShape.TOUCH_FULL;
    }
  }

  // E2 (observer) and the boot read: PC mode is a profile parameter, not a
  // publication input (D2). Returns the publication the caller should apply.
  setPcMode(on: boolean): PublishMode {
    this.pcMode = on;
    return this.publishValue();
  }

  onStatus(event: ShapeEvent): ShapeEventResult {
    const result = new ShapeEventResult();
    result.previous = this.shape;
    result.note = '';
    if (event === ShapeEvent.UNKNOWN) {
      // I7: an unknown value must not move either the shape or the layout.
      result.current = this.shape;
      result.publish = PublishMode.KEEP;
      result.note = 'unknown status, keep shape';
      return result;
    }
    if (event === ShapeEvent.MINIMIZE) {
      if (this.shape !== WindowShape.MINIMIZED) {
        this.returnShape = this.shape;
      }
      this.shape = WindowShape.MINIMIZED;
      result.current = this.shape;
      result.shapeChanged = true;
      result.publish = PublishMode.KEEP;
      result.note = 'minimize: visibility change, publication unchanged';
      return result;
    }
    const next: WindowShape = this.shapeOfEvent(event, this.shape);
    this.shape = next;
    result.current = next;
    result.shapeChanged = next !== result.previous;
    result.publish = this.publishValue();
    // Round 153 edge: a touch-regime window that reports FLOATING/MAXIMIZE lost
    // its display rect (or the WMS "helpfully" maximized it, reason:1). The
    // shape stays TOUCH_FULL and the caller re-asserts the display rect.
    if (this.profile !== LayoutProfile.PC2IN1 &&
      this.shape === WindowShape.TOUCH_FULL &&
      (event === ShapeEvent.FLOATING || event === ShapeEvent.MAXIMIZE)) {
      result.correctTouchFullscreen = true;
      result.note = 'touch regime lost the display rect, re-assert';
    } else if (result.shapeChanged) {
      result.note = 'shape transition';
    }
    return result;
  }

  publishValue(): PublishMode {
    if (this.profile === LayoutProfile.OTHER) {
      return PublishMode.DESKTOP;
    }
    if (this.profile === LayoutProfile.PC2IN1) {
      // I11 / D1: a profile constant. Boot, observer and every event path agree.
      return PublishMode.DESKTOP;
    }
    if (this.shape === WindowShape.STARTING) {
      return PublishMode.KEEP;
    }
    if (this.pcMode) {
      // Tablet in PC mode: the touch regime is not reachable, every shape is a
      // desktop window (S2/S3/S4/S5 semantics).
      return PublishMode.DESKTOP;
    }
    if (this.shape === WindowShape.TOUCH_FULL) {
      return PublishMode.TOUCH;
    }
    if (this.shape === WindowShape.MINIMIZED || this.shape === WindowShape.UNKNOWN) {
      return PublishMode.KEEP;
    }
    return PublishMode.DESKTOP;
  }

  // True while the window is a touch-regime window (display-sized, no caption).
  // Touch-regime-only actions (display-rect correction, layout fullscreen) are
  // gated on this instead of ad-hoc device/status checks (I10).
  isTouchRegime(): boolean {
    return this.profile === LayoutProfile.TABLET &&
      !this.pcMode &&
      this.shape === WindowShape.TOUCH_FULL;
  }

  isFreeWindowShape(): boolean {
    return this.shape === WindowShape.FREE_FLOAT ||
      this.shape === WindowShape.SPLIT ||
      this.shape === WindowShape.MAXIMIZED ||
      this.shape === WindowShape.FULLSCREEN;
  }

  // ---- E9 guard table (spec §6.4) -----------------------------------------

  allowMaximize(): boolean {
    if (this.shape === WindowShape.MAXIMIZED) {
      return false;
    }
    if (this.profile !== LayoutProfile.PC2IN1 && this.shape === WindowShape.TOUCH_FULL) {
      return false;
    }
    return true;
  }

  allowEnterImmersive(): boolean {
    if (this.shape === WindowShape.FULLSCREEN) {
      return false;
    }
    if (this.profile !== LayoutProfile.PC2IN1 && this.shape === WindowShape.TOUCH_FULL) {
      return false;
    }
    return true;
  }

  // fromBridge = this entry point opened the immersive (setFullScreen / simple
  // fullscreen); such a window must always be exitable or F11 traps it in S5.
  allowExitImmersive(fromBridge: boolean): boolean {
    if (fromBridge) {
      return true;
    }
    return this.shape !== WindowShape.TOUCH_FULL;
  }

  allowMinimize(): boolean {
    if (this.profile === LayoutProfile.PC2IN1) {
      return true;
    }
    return this.shape !== WindowShape.TOUCH_FULL;
  }

  allowRestore(isLiveMinimized: boolean): boolean {
    if (this.profile === LayoutProfile.PC2IN1) {
      return true;
    }
    return isLiveMinimized;
  }

  // A display-sized touch window rejects setBounds with 1300010 (spec §十).
  allowSetBounds(): boolean {
    if (this.profile !== LayoutProfile.PC2IN1 && this.shape === WindowShape.TOUCH_FULL) {
      return false;
    }
    return true;
  }

  shapeName(): string {
    switch (this.shape) {
      case WindowShape.STARTING:
        return 'STARTING';
      case WindowShape.TOUCH_FULL:
        return 'TOUCH_FULL';
      case WindowShape.FREE_FLOAT:
        return 'FREE_FLOAT';
      case WindowShape.SPLIT:
        return 'SPLIT';
      case WindowShape.MAXIMIZED:
        return 'MAXIMIZED';
      case WindowShape.FULLSCREEN:
        return 'FULLSCREEN';
      case WindowShape.MINIMIZED:
        return 'MINIMIZED';
      default:
        return 'UNKNOWN';
    }
  }

  profileName(): string {
    switch (this.profile) {
      case LayoutProfile.TABLET:
        return 'tablet';
      case LayoutProfile.PC2IN1:
        return '2in1';
      default:
        return 'other';
    }
  }

  snapshot(): string {
    return 'profile=' + this.profileName() + ', pcMode=' + this.pcMode +
      ', shape=' + this.shapeName();
  }

  // Transition table (spec §6.3), transition-start semantics (I2): the target
  // shape depends on the event AND on where the window came from.
  private shapeOfEvent(event: ShapeEvent, previous: WindowShape): WindowShape {
    switch (event) {
      case ShapeEvent.FLOATING:
        return WindowShape.FREE_FLOAT;
      case ShapeEvent.SPLIT_SCREEN:
        return WindowShape.SPLIT;
      case ShapeEvent.MAXIMIZE:
        // From the touch regime (or before any shape is known) a MAXIMIZE event
        // is the WMS "helpfully" filling the display - the shape stays
        // TOUCH_FULL and the caller re-asserts the rect. From a free window it
        // is S4 (the Bug1 fix: maximize is a window shape, not a form factor).
        if (previous === WindowShape.TOUCH_FULL || previous === WindowShape.STARTING) {
          return WindowShape.TOUCH_FULL;
        }
        return WindowShape.MAXIMIZED;
      case ShapeEvent.FULL_SCREEN:
        // Immersive fullscreen is a member of the free-window family (S5); from
        // the touch regime it is simply the touch fullscreen.
        if (previous === WindowShape.FREE_FLOAT || previous === WindowShape.SPLIT ||
          previous === WindowShape.MAXIMIZED || previous === WindowShape.FULLSCREEN) {
          return WindowShape.FULLSCREEN;
        }
        return WindowShape.TOUCH_FULL;
      case ShapeEvent.MINIMIZE:
        return WindowShape.MINIMIZED;
      default:
        return previous;
    }
  }
}
