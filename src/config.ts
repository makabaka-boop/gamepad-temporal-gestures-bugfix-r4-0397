import type {
  ActionBinding,
  GamepadMappingConfig,
  NormalizedAxisTuning,
  NormalizedConfig,
  PhysicalInput,
} from './types';

export const MAX_GAMEPADS = 4;

export function inputKey(input: PhysicalInput, gamepad: number): string {
  const pad = input.gamepad ?? gamepad;
  return input.kind === 'button'
    ? `g${pad}.b${input.index}`
    : `g${pad}.a${input.index}.${input.direction < 0 ? '-' : '+'}`;
}

function requireUnit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number in [0, 1]`);
  }
}

function assertGamepadIndex(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value >= MAX_GAMEPADS)) {
    throw new RangeError(`${name} must be an integer from 0 to ${MAX_GAMEPADS - 1}`);
  }
}

function normalizeBinding(binding: ActionBinding): ActionBinding {
  if (!binding.action || typeof binding.action !== 'string') {
    throw new TypeError('Every binding requires a non-empty action');
  }
  if (!Array.isArray(binding.inputs) || binding.inputs.length === 0) {
    throw new TypeError(`Action ${binding.action} requires at least one input`);
  }

  const bindingPad = binding.gamepad === '*' ? 0 : binding.gamepad ?? 0;
  assertGamepadIndex(bindingPad, `Action ${binding.action} gamepad`);

  const inputs = binding.inputs.map((input) => {
    assertGamepadIndex(input.gamepad, `Action ${binding.action} input gamepad`);
    if (!Number.isInteger(input.index) || input.index < 0) {
      throw new RangeError(`Action ${binding.action} uses an invalid input index`);
    }
    if (input.kind === 'axis' && input.direction !== -1 && input.direction !== 1) {
      throw new TypeError(`Action ${binding.action} axis direction must be -1 or 1`);
    }
    return { ...input };
  });

  let gesture = binding.gesture ? { ...binding.gesture } : undefined;
  if (gesture) {
    if (inputs.length !== 1 || inputs[0]?.kind !== 'button' || !['tap','double','hold'].includes(gesture.type)) throw new TypeError('Gestures require one button and a known type');
    for (const value of [gesture.gapMs, gesture.holdMs]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new RangeError('Gesture timing must be positive');
  }
  const gamepad = binding.gamepad === '*' ? '*' : bindingPad;
  return {
    action: binding.action,
    inputs,
    ...(gesture ? { gesture } : {}),
    ...(binding.priority !== undefined ? { priority: binding.priority } : {}),
    gamepad,
  };
}

/**
 * Return a deep, immutable copy. Bindings remain plain JSON data so configs can
 * be stored or transported without losing their shape.
 */
export function normalizeConfig(config: GamepadMappingConfig): NormalizedConfig {
  if (!config || !Array.isArray(config.bindings)) {
    throw new TypeError('config.bindings must be an array');
  }

  const axes: Record<number, NormalizedAxisTuning> = {};
  for (const [rawIndex, tuning] of Object.entries(config.axes ?? {})) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError(`Invalid axis index ${rawIndex}`);
    }
    requireUnit(tuning.deadzone, `Axis ${index} deadzone`);
    requireUnit(tuning.releaseHysteresis, `Axis ${index} releaseHysteresis`);
    if (tuning.center !== undefined) {
      requireUnit(Math.abs(tuning.center), `Axis ${index} center`);
    }
    if (tuning.releaseHysteresis > tuning.deadzone) {
      throw new RangeError(`Axis ${index} releaseHysteresis cannot exceed deadzone`);
    }
    axes[index] = {
      deadzone: tuning.deadzone,
      releaseHysteresis: tuning.releaseHysteresis,
      center: tuning.center ?? 0,
    };
  }

  const gamepads: NormalizedConfig['gamepads'] = {};
  for (const [rawIndex, tuning] of Object.entries(config.gamepads ?? {})) {
    const index = Number(rawIndex);
    assertGamepadIndex(index, 'Gamepad tuning index');
    const axisCenters: Record<number, number> = {};
    for (const [rawAxis, center] of Object.entries(tuning.axisCenters ?? {})) {
      const axis = Number(rawAxis);
      if (!Number.isInteger(axis) || axis < 0) throw new RangeError('Invalid calibrated axis');
      requireUnit(Math.abs(center), `Gamepad ${index} axis ${axis} center`);
      axisCenters[axis] = center;
    }
    gamepads[index] = { ...(Object.keys(axisCenters).length ? { axisCenters } : {}) };
  }

  return Object.freeze({
    bindings: Object.freeze(config.bindings.map(normalizeBinding)),
    axes,
    gamepads,
  });
}

export function cloneConfig(config: GamepadMappingConfig): GamepadMappingConfig {
  return structuredClone({
    bindings: config.bindings ?? [],
    ...(config.axes ? { axes: config.axes } : {}),
    ...(config.gamepads ? { gamepads: config.gamepads } : {}),
  });
}
