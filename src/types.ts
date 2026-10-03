/**
 * Public types for the logical gamepad mapper.
 *
 * A binding is gamepad-local by default. A chord therefore cannot
 * accidentally combine buttons from two different physical devices.
 * Explicit gamepad indices on every input may still describe a deliberate
 * cross-device chord.
 */

export type GamepadDirection = -1 | 1;

export interface ButtonInput {
  kind: 'button';
  index: number;
  /** Defaults to the binding's gamepad, or zero when neither is supplied. */
  gamepad?: number;
}

export interface AxisInput {
  kind: 'axis';
  index: number;
  direction: GamepadDirection;
  /** Defaults to the binding's gamepad, or zero when neither is supplied. */
  gamepad?: number;
}

export type PhysicalInput = ButtonInput | AxisInput;

export interface ActionBinding {
  action: string;
  inputs: PhysicalInput[];
  /** Higher numbers win when chords or buttons claim the same physical input. */
  priority?: number;
  gesture?: { type: 'tap' | 'double' | 'hold'; gapMs?: number; holdMs?: number };
  /** A convenience default for all inputs. '*' creates the binding on pads 0-3. */
  gamepad?: number | '*';
}

export interface AxisTuning {
  /** Input must reach this distance from center before it activates. */
  deadzone: number;
  /** While active it may fall this far below the deadzone before releasing. */
  releaseHysteresis: number;
  /** Persistent fallback center; a live calibration overrides it per session. */
  center?: number;
}

export interface GamepadTuning {
  /** Persistent per-axis centers for this logical browser index. */
  axisCenters?: Record<number, number>;
}

export interface GamepadMappingConfig {
  bindings: ActionBinding[];
  axes?: Record<number, AxisTuning>;
  gamepads?: Record<number, GamepadTuning>;
}

export interface NormalizedAxisTuning {
  deadzone: number;
  releaseHysteresis: number;
  center: number;
}

export interface NormalizedConfig {
  bindings: readonly ActionBinding[];
  axes: Record<number, NormalizedAxisTuning>;
  gamepads: Record<number, GamepadTuning>;
}

export interface GamepadButtonLike {
  pressed?: boolean;
  value?: number;
}

export interface GamepadLike {
  index: number;
  id: string;
  connected: boolean;
  buttons: readonly GamepadButtonLike[];
  axes: readonly number[];
  /**
   * Test doubles can supply this. Browser snapshots do not expose connection
   * time, so the browser provider additionally listens for disconnect events.
   */
  connectedAt?: number;
}

export type GamepadSnapshot = readonly (GamepadLike | null)[];

export interface GamepadProvider {
  getGamepads(): GamepadSnapshot;
  now?(): number;
  addGamepadDisconnected?(listener: (event: { index: number }) => void): () => void;
  addWindowBlur?(listener: () => void): () => void;
  addWindowFocus?(listener: () => void): () => void;
}

export type LogicalActionEventType = 'action-down' | 'action-up';

export interface LogicalActionEvent {
  type: LogicalActionEventType;
  action: string;
  generation: number;
  /** Provider timestamp in milliseconds. */
  time: number;
  /** Physical inputs that caused the action to be selected. */
  sources: string[];
}

export type LogicalActionListener = (event: LogicalActionEvent) => void;

export interface CanonicalActionEvent {
  action: string;
  /** Milliseconds since recording started. */
  t: number;
  type: 'down' | 'up';
  /** Config generation active when this logical transition occurred. */
  generation: number;
}

export interface CanonicalEventLog {
  events: CanonicalActionEvent[];
  generation: number;
  schema: 'logical-gamepad-events/v1';
}
