import { describe, expect, it, vi } from 'vitest';
import {
  EventRecorder,
  GamepadPoller,
  StepReplayer,
  type GamepadLike,
  type GamepadMappingConfig,
  type GamepadProvider,
} from '../src';

function button(pressed = false, value = pressed ? 1 : 0) {
  return { pressed, value };
}

function gamepad(
  index: number,
  options: Partial<Omit<GamepadLike, 'index' | 'buttons' | 'axes'>> & {
    buttons?: boolean[];
    axes?: number[];
  } = {},
): GamepadLike {
  const buttons = options.buttons ?? [];
  return {
    index,
    id: options.id ?? `pad-${index}`,
    connected: options.connected ?? true,
    connectedAt: options.connectedAt ?? 1000 + index,
    buttons: buttons.map((pressed) => button(pressed)),
    axes: options.axes ?? [],
  };
}

class FakeGamepadProvider implements GamepadProvider {
  pads: Array<GamepadLike | null> = [null, null, null, null];
  private time = 100;
  private disconnectListeners = new Set<(event: { index: number }) => void>();
  private blurListeners = new Set<() => void>();
  private focusListeners = new Set<() => void>();

  getGamepads() {
    return [...this.pads];
  }

  now() {
    return this.time;
  }

  setTime(time: number) {
    this.time = time;
  }

  disconnect(index: number, clearSnapshot = true) {
    if (clearSnapshot) this.pads[index] = null;
    for (const listener of this.disconnectListeners) listener({ index });
  }

  replace(index: number, pad: GamepadLike) {
    this.pads[index] = pad;
  }

  blur() {
    this.pads = [null, null, null, null];
    for (const listener of this.blurListeners) listener();
  }

  focus() {
    for (const listener of this.focusListeners) listener();
  }

  addGamepadDisconnected(listener: (event: { index: number }) => void) {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  addWindowBlur(listener: () => void) {
    this.blurListeners.add(listener);
    return () => this.blurListeners.delete(listener);
  }

  addWindowFocus(listener: () => void) {
    this.focusListeners.add(listener);
    return () => this.focusListeners.delete(listener);
  }
}

function pollerWith(config: GamepadMappingConfig, provider = new FakeGamepadProvider()) {
  return { provider, poller: new GamepadPoller(provider, config) };
}

const buttonConfig: GamepadMappingConfig = {
  bindings: [{ action: 'jump', inputs: [{ kind: 'button', index: 0 }] }],
};

describe('GamepadPoller', () => {
  it('records only logical state transitions for buttons', () => {
    const { provider, poller } = pollerWith(buttonConfig);
    const listener = vi.fn();
    poller.addActionListener(listener);

    provider.pads[0] = gamepad(0);
    expect(poller.poll()).toEqual([]);

    provider.pads[0] = gamepad(0, { buttons: [true] });
    expect(poller.poll().map((event) => `${event.type}:${event.action}`)).toEqual([
      'action-down:jump',
    ]);
    expect(poller.poll()).toEqual([]);

    provider.pads[0] = gamepad(0, { buttons: [false] });
    expect(poller.poll().map((event) => `${event.type}:${event.action}`)).toEqual([
      'action-up:jump',
    ]);
    expect(poller.poll()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('applies deadzone and release hysteresis to noisy axes', () => {
    const { provider, poller } = pollerWith({
      axes: { 0: { deadzone: 0.2, releaseHysteresis: 0.05 } },
      bindings: [{ action: 'right', inputs: [{ kind: 'axis', index: 0, direction: 1 }] }],
    });

    provider.pads[0] = gamepad(0, { axes: [0.19] });
    expect(poller.poll()).toEqual([]);

    provider.pads[0] = gamepad(0, { axes: [0.2] });
    expect(poller.poll().map((event) => event.type)).toEqual(['action-down']);

    // Noise that remains above deadzone - hysteresis must not cause an up event.
    provider.pads[0] = gamepad(0, { axes: [0.16] });
    expect(poller.poll()).toEqual([]);

    provider.pads[0] = gamepad(0, { axes: [0.14] });
    expect(poller.poll().map((event) => event.type)).toEqual(['action-up']);
  });

  it('uses session-specific center calibration and does not carry it to replacement', () => {
    const { provider, poller } = pollerWith({
      axes: { 0: { deadzone: 0.2, releaseHysteresis: 0.05 } },
      bindings: [{ action: 'right', inputs: [{ kind: 'axis', index: 0, direction: 1 }] }],
    });

    provider.pads[0] = gamepad(0, { axes: [0.2] });
    poller.poll();
    poller.calibrateAxis(0, 0, 0.2);
    expect(poller.getAxisCenter(0, 0)).toBe(0.2);

    provider.pads[0] = gamepad(0, { axes: [0.3] });
    expect(poller.poll()).toEqual([]);

    provider.pads[0] = gamepad(0, { axes: [0.41] });
    expect(poller.poll().map((event) => event.type)).toEqual(['action-down']);

    const replacement = gamepad(0, { id: 'other-pad', connectedAt: 5000, buttons: [false] });
    provider.replace(0, replacement);
    expect(poller.poll().map((event) => event.type)).toEqual(['action-up']);
    expect(poller.getAxisCenter(0, 0)).toBe(0);

    provider.pads[0] = gamepad(0, { id: 'other-pad', connectedAt: 5000, buttons: [true] });
    poller.poll();

    provider.disconnect(0);
    poller.poll();
    provider.replace(
      0,
      gamepad(0, { id: 'pad-0', connectedAt: 6000, axes: [0.1] }),
    );
    poller.poll();
    expect(poller.getAxisCenter(0, 0)).toBe(0);
    provider.pads[0] = gamepad(0, { id: 'pad-0', connectedAt: 6000, axes: [0.41] });
    expect(poller.poll().map((event) => event.action)).toEqual(['right']);
  });

  it('gives overlapping chord priority to higher-priority, more specific bindings', () => {
    const { provider, poller } = pollerWith({
      bindings: [
        { action: 'fire', priority: 1, inputs: [{ kind: 'button', index: 0 }] },
        {
          action: 'special-fire',
          priority: 10,
          inputs: [
            { kind: 'button', index: 0 },
            { kind: 'button', index: 2 },
          ],
        },
      ],
    });

    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.pads[0] = gamepad(0, { buttons: [true, false, true] });
    expect(poller.poll().map(({ type, action }) => `${type}:${action}`)).toEqual([
      'action-up:fire',
      'action-down:special-fire',
    ]);

    provider.pads[0] = gamepad(0, { buttons: [true] });
    expect(poller.poll().map(({ type, action }) => `${type}:${action}`)).toEqual([
      'action-up:special-fire',
      'action-down:fire',
    ]);
  });

  it('releases device-specific actions when a pad disconnects or index is replaced', () => {
    const { provider, poller} = pollerWith({
      bindings: [
        { action: 'jump', inputs: [{ kind: 'button', index: 0 }] },
        { action: 'jump2', gamepad: 1, inputs: [{ kind: 'button', index: 0 }] },
      ],
    });

    provider.pads[0] = gamepad(0, { buttons: [true] });
    provider.pads[1] = gamepad(1, { id: 'pad-1', connectedAt: 2000, buttons: [true] });
    poller.poll();

    provider.disconnect(0);
    let events = poller.poll().map((event) => event.action);
    expect(events).toEqual(['jump']);

    provider.replace(0, gamepad(0, { id: 'new-pad', connectedAt: 3000, buttons: [true] }));
    events = poller.poll().map((event) => event.action);
    expect(events).toEqual(['jump']);
    // Pad one is unaffected by the lifecycle at index zero.
    expect(poller.poll()).toEqual([]);
  });

  it('releases on disconnect event even when a stale browser snapshot remains', () => {
    const { provider, poller } = pollerWith(buttonConfig);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();

    provider.disconnect(0, false);
    expect(poller.poll().map((event) => event.action)).toEqual(['jump']);

    // The stale snapshot remains until it is replaced by a different session.
    expect(poller.poll()).toEqual([]);
    provider.replace(0, gamepad(0, { id: 'pad-0', connectedAt: 1000 }));
    expect(poller.poll()).toEqual([]);
    provider.replace(0, gamepad(0, { id: 'reconnected', connectedAt: 6000 }));
    expect(poller.poll()).toEqual([]);
  });

  it('releases every active action on page blur', () => {
    const { provider, poller } = pollerWith({
      bindings: [
        { action: 'a0', inputs: [{ kind: 'button', index: 0 }] },
        { action: 'a1', gamepad: 1, inputs: [{ kind: 'button', index: 0 }] },
      ],
    });
    provider.pads[0] = gamepad(0, { buttons: [true] });
    provider.pads[1] = gamepad(1, { buttons: [true] });
    poller.poll();

    provider.blur();
    const events = poller.poll();
    expect(events.map((event) => event.action).sort()).toEqual(['a0', 'a1']);
    expect(events.every((event) => event.type === 'action-up')).toBe(true);

    provider.focus();
    provider.pads[0] = gamepad(0, { buttons: [true] });
    provider.pads[1] = gamepad(1, { buttons: [true] });
    expect(poller.poll().map((event) => event.action).sort()).toEqual(['a0', 'a1']);
  });

  it('advances log generation and releases old actions immediately on config change', () => {
    const { provider, poller } = pollerWith(buttonConfig);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();

    poller.setConfig({
      bindings: [{ action: 'newJump', inputs: [{ kind: 'button', index: 1 }] }],
    });
    expect(poller.getGeneration()).toBe(2);

    // Button zero remains physically held, but belongs to no new action.
    const events = poller.poll();
    expect(events).toEqual([]);

    provider.pads[0] = gamepad(0, { buttons: [true, true] });
    expect(poller.poll().map((event) => [event.action, event.generation])).toEqual([
      ['newJump', 2],
    ]);
  });

  it('produces the same selected action set regardless of poll batching', () => {
    const config: GamepadMappingConfig = {
      bindings: [
        { action: 'x', inputs: [{ kind: 'button', index: 0 }] },
        {
          action: 'xy',
          priority: 10,
          inputs: [
            { kind: 'button', index: 0 },
            { kind: 'button', index: 1 },
          ],
        },
      ],
    };
    const batchOne = pollerWith(config);
    const batchTwo = pollerWith(config);

    batchOne.provider.pads[0] = gamepad(0, { buttons: [true, true] });
    batchOne.poller.poll();

    batchTwo.provider.pads[0] = gamepad(0, { buttons: [true] });
    batchTwo.poller.poll();
    batchTwo.provider.pads[0] = gamepad(0, { buttons: [true, true] });
    batchTwo.poller.poll();

    const pad = gamepad(0, { buttons: [true, true] });
    batchOne.provider.pads[0] = pad;
    batchTwo.provider.pads[0] = pad;
    expect(batchOne.poller.poll()).toEqual([]);
    expect(batchTwo.poller.poll()).toEqual([]);
  });
});

const gestureConfig: GamepadMappingConfig = {
  bindings: [
    { action: 'jump', inputs: [{ kind: 'button', index: 0 }], gesture: { type: 'tap' } },
    {
      action: 'dash',
      inputs: [{ kind: 'button', index: 0 }],
      gesture: { type: 'double', gapMs: 240 },
    },
    {
      action: 'charge',
      inputs: [{ kind: 'button', index: 0 }],
      gesture: { type: 'hold', holdMs: 500 },
    },
  ],
};

const gestureChordConfig: GamepadMappingConfig = {
  bindings: [
    { action: 'jump', inputs: [{ kind: 'button', index: 0 }], gesture: { type: 'tap' } },
    {
      action: 'dash',
      inputs: [{ kind: 'button', index: 0 }],
      gesture: { type: 'double', gapMs: 240 },
    },
    {
      action: 'special-jump',
      priority: 10,
      inputs: [
        { kind: 'button', index: 0 },
        { kind: 'button', index: 2 },
      ],
    },
  ],
};

describe('button gestures', () => {
  it('a completed double produces only the double, never an extra tap', () => {
    const { provider, poller } = pollerWith(gestureConfig);
    const events: string[] = [];
    poller.addActionListener((event) => events.push(`${event.type}:${event.action}`));

    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(100);
    provider.pads[0] = gamepad(0);
    poller.poll();
    provider.setTime(300);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(400);
    provider.pads[0] = gamepad(0);
    poller.poll();

    // Far beyond every pending deadline.
    provider.setTime(1000);
    poller.poll();

    expect(events).toEqual(['action-down:dash', 'action-up:dash']);
  });

  it('emits a tap only after the double-click gap and not together with a double', () => {
    const { provider, poller } = pollerWith(gestureConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    expect(poller.poll()).toEqual([]);

    provider.setTime(100);
    provider.pads[0] = gamepad(0);
    expect(poller.poll()).toEqual([]);

    // Still inside the gap: no tap yet.
    provider.setTime(339);
    expect(poller.poll()).toEqual([]);

    // Deadline press at exactly gap elapsed (100 + 240 = 340) is the double.
    provider.setTime(340);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    expect(poller.poll().map((event) => event.action)).toEqual(['dash', 'dash']);
  });

  it('fires the deferred tap as soon as the gap elapses', () => {
    const { provider, poller } = pollerWith(gestureConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(100);
    provider.pads[0] = gamepad(0);
    poller.poll();

    provider.setTime(340);
    const events = poller.poll();
    expect(events.map((event) => event.action)).toEqual(['jump', 'jump']);
    expect(events.map((event) => event.type)).toEqual(['action-down', 'action-up']);
  });

  it('activates a hold at the threshold and never补发 a tap on release', () => {
    const { provider, poller } = pollerWith(gestureConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();

    provider.setTime(499);
    expect(poller.poll()).toEqual([]);

    provider.setTime(500);
    expect(poller.poll().map((event) => event.action)).toEqual(['charge']);
    expect(poller.poll()).toEqual([]);

    provider.setTime(700);
    provider.pads[0] = gamepad(0);
    expect(poller.poll().map((event) => event.action)).toEqual(['charge']);

    // Long after release there must be no tap and no armed double.
    provider.setTime(1000);
    expect(poller.poll()).toEqual([]);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    provider.setTime(1001);
    expect(poller.poll()).toEqual([]);
  });

  it('does not arm a double after a long hold release', () => {
    const { provider, poller } = pollerWith(gestureConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(600);
    expect(poller.poll().map((event) => event.action)).toEqual(['charge']);
    provider.setTime(700);
    provider.pads[0] = gamepad(0);
    poller.poll();

    // A quick press right after the hold is a fresh, single click.
    provider.setTime(750);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(800);
    provider.pads[0] = gamepad(0);
    poller.poll();
    provider.setTime(1040);
    expect(poller.poll().map((event) => event.action)).toEqual(['jump', 'jump']);
  });

  it('consumes a press once a higher-priority chord takes it over', () => {
    const { provider, poller } = pollerWith(gestureChordConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();

    // Second button joins: chord owns the first button's press.
    provider.setTime(100);
    provider.pads[0] = gamepad(0, { buttons: [true, false, true] });
    poller.poll();

    provider.setTime(200);
    provider.pads[0] = gamepad(0);
    expect(poller.poll().map(({ type, action }) => `${type}:${action}`)).toEqual([
      'action-up:special-jump',
    ]);

    // No deferred tap may resolve for the consumed press.
    provider.setTime(500);
    expect(poller.poll()).toEqual([]);
  });

  it('does not fire a deferred tap when the button is held through the gap by a chord', () => {
    const { provider, poller } = pollerWith(gestureChordConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(100);
    provider.pads[0] = gamepad(0);
    poller.poll();

    // Chord formed with the same button before the tap deadline (240+100=340).
    provider.setTime(200);
    provider.pads[0] = gamepad(0, { buttons: [true, false, true] });
    expect(poller.poll().map(({ type, action }) => `${type}:${action}`)).toEqual([
      'action-down:special-jump',
    ]);
    // The pending tap never resolves while the combo owns the button.
    provider.setTime(400);
    expect(poller.poll()).toEqual([]);
    provider.setTime(500);
    provider.pads[0] = gamepad(0);
    expect(poller.poll().map(({ type, action }) => `${type}:${action}`)).toEqual([
      'action-up:special-jump',
    ]);
  });

  it('a claimed second press cannot complete the double or resolve the first tap', () => {
    const { provider, poller } = pollerWith(gestureChordConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(100);
    provider.pads[0] = gamepad(0);
    poller.poll();

    // Second press lands in the gap but already as part of the chord.
    provider.setTime(200);
    provider.pads[0] = gamepad(0, { buttons: [true, false, true] });
    expect(poller.poll().map(({ type, action }) => `${type}:${action}`)).toEqual([
      'action-down:special-jump',
    ]);

    provider.setTime(250);
    provider.pads[0] = gamepad(0);
    expect(poller.poll().map(({ type, action }) => `${type}:${action}`)).toEqual([
      'action-up:special-jump',
    ]);

    // Neither the double nor the deferred tap of the first click survive.
    provider.setTime(340);
    expect(poller.poll()).toEqual([]);
    provider.setTime(500);
    expect(poller.poll()).toEqual([]);
  });

  it('keeps double-click timing scoped to one physical gamepad', () => {
    const twoPadConfig: GamepadMappingConfig = {
      bindings: [
        {
          action: 'jump',
          gamepad: '*',
          inputs: [{ kind: 'button', index: 0 }],
          gesture: { type: 'tap' },
        },
        {
          action: 'dash',
          gamepad: '*',
          inputs: [{ kind: 'button', index: 0 }],
          gesture: { type: 'double', gapMs: 240 },
        },
      ],
    };
    const { provider, poller } = pollerWith(twoPadConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    provider.pads[1] = gamepad(1, { id: 'pad-1', connectedAt: 2000, buttons: [true] });
    poller.poll();

    // Pad one completes a whole short click before pad zero moves.
    provider.setTime(20);
    provider.pads[1] = gamepad(1, { id: 'pad-1', connectedAt: 2000 });
    poller.poll();
    provider.setTime(260);
    expect(poller.poll().map((event) => event.action)).toEqual(['jump', 'jump']);

    // Pad zero releases and starts its own window.
    provider.setTime(300);
    provider.pads[0] = gamepad(0);
    poller.poll();

    // Pad one's second click lands inside pad zero's window (deadline 540) but
    // far past pad one's last release (20): it must be an isolated single.
    provider.setTime(400);
    provider.pads[1] = gamepad(1, { id: 'pad-1', connectedAt: 2000, buttons: [true] });
    poller.poll();
    provider.setTime(420);
    provider.pads[1] = gamepad(1, { id: 'pad-1', connectedAt: 2000 });
    poller.poll();
    provider.setTime(540);
    expect(poller.poll().map((event) => event.action)).toEqual(['jump', 'jump']);

    // Pad one's later tap resolves on its own deadline.
    provider.setTime(660);
    expect(poller.poll().map((event) => event.action)).toEqual(['jump', 'jump']);
  });

  it('drops pending and held gestures when the device session ends', () => {
    const { provider, poller } = pollerWith(gestureConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(100);
    provider.pads[0] = gamepad(0);
    poller.poll();

    provider.disconnect(0);
    expect(poller.poll()).toEqual([]);
    // The old pending tap (deadline t=340) is gone with the session.
    provider.setTime(400);
    expect(poller.poll()).toEqual([]);

    // A brand-new session at the same index starts from a clean gesture state:
    // its own short click defers a fresh tap relative to its own release.
    provider.replace(0, gamepad(0, { id: 'reconnected', connectedAt: 9000, buttons: [true] }));
    provider.setTime(450);
    poller.poll();
    provider.setTime(550);
    provider.pads[0] = gamepad(0, { id: 'reconnected', connectedAt: 9000 });
    poller.poll();
    // Before the new session's deadline (550 + 240 = 790) nothing fires...
    provider.setTime(789);
    expect(poller.poll()).toEqual([]);
    // ...and at the deadline only the new session's tap appears once.
    provider.setTime(790);
    expect(poller.poll().map((event) => event.action)).toEqual(['jump', 'jump']);
  });

  it('withdraws an already-active hold when a higher-priority chord takes over', () => {
    const { provider, poller } = pollerWith({
      bindings: [
        {
          action: 'charge',
          inputs: [{ kind: 'button', index: 0 }],
          gesture: { type: 'hold', holdMs: 500 },
        },
        {
          action: 'special-jump',
          priority: 10,
          inputs: [
            { kind: 'button', index: 0 },
            { kind: 'button', index: 2 },
          ],
        },
      ],
    });
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(500);
    expect(poller.poll().map(({ type, action }) => `${type}:${action}`)).toEqual([
      'action-down:charge',
    ]);

    // Chord forms while the hold is active: hold ends, combo begins.
    provider.setTime(600);
    provider.pads[0] = gamepad(0, { buttons: [true, false, true] });
    expect(poller.poll().map(({ type, action }) => `${type}:${action}`)).toEqual([
      'action-up:charge',
      'action-down:special-jump',
    ]);

    provider.setTime(700);
    provider.pads[0] = gamepad(0);
    expect(poller.poll().map(({ type, action }) => `${type}:${action}`)).toEqual([
      'action-up:special-jump',
    ]);
  });

  it('releases an active hold on blur and never resumes the gesture', () => {
    const { provider, poller } = pollerWith(gestureConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(600);
    expect(poller.poll().map((event) => event.action)).toEqual(['charge']);

    provider.blur();
    const blurEvents = poller.poll();
    expect(blurEvents.map((event) => event.action)).toEqual(['charge']);
    expect(blurEvents.every((event) => event.type === 'action-up')).toBe(true);

    provider.setTime(700);
    expect(poller.poll()).toEqual([]);
  });

  it('starts a fresh gesture generation when the mapping changes', () => {
    const { provider, poller } = pollerWith(gestureConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(100);
    provider.pads[0] = gamepad(0);
    poller.poll();

    poller.setConfig({
      bindings: [{ action: 'newJump', inputs: [{ kind: 'button', index: 0 }] }],
    });

    // The old mapping's pending tap deadline (340) must not fire afterwards.
    provider.setTime(400);
    expect(poller.poll()).toEqual([]);
  });

  it('drops a pending tap when the mapping changes before the deadline', () => {
    const { provider, poller } = pollerWith(gestureConfig);
    provider.setTime(0);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(100);
    provider.pads[0] = gamepad(0);
    poller.poll();

    // Same gestures, new generation: timing from generation one cannot carry on.
    poller.setConfig(gestureConfig);
    provider.setTime(340);
    expect(poller.poll()).toEqual([]);
  });

  it('records deferred taps and replays them in the exact live emission order', () => {
    const { provider, poller } = pollerWith({
      bindings: [
        { action: 'jump', inputs: [{ kind: 'button', index: 0 }], gesture: { type: 'tap' } },
        {
          action: 'dash',
          inputs: [{ kind: 'button', index: 0 }],
          gesture: { type: 'double', gapMs: 240 },
        },
        { action: 'fire', inputs: [{ kind: 'button', index: 1 }] },
      ],
    });
    const live: string[] = [];
    poller.addActionListener((event) => live.push(`${event.time}:${event.type}:${event.action}`));
    const recorder = new EventRecorder(poller, () => provider.now());

    provider.setTime(0);
    recorder.start();
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(100);
    provider.pads[0] = gamepad(0);
    poller.poll();

    // Same timestamp: the tap resolves at the same tick another button fires.
    provider.setTime(340);
    provider.pads[0] = gamepad(0, { buttons: [false, true] });
    poller.poll();
    provider.setTime(400);
    provider.pads[0] = gamepad(0);
    poller.poll();

    const log = recorder.stop();
    const replayNames = log.events.map((event) => `${event.t}:${event.type === 'down' ? 'action-down' : 'action-up'}:${event.action}`);
    expect(replayNames).toEqual(live);

    const replayer = StepReplayer.fromJSON(JSON.stringify(log));
    const seen: string[] = [];
    while (replayer.canStep()) {
      const { event } = replayer.step();
      if (event) seen.push(`${event.t}:${event.type === 'down' ? 'action-down' : 'action-up'}:${event.action}`);
    }
    expect(seen).toEqual(live);
    expect(replayer.state.active).toEqual([]);
    recorder.dispose();
  });

  it('rejects logs whose down/up pairing is inconsistent', () => {
    expect(() =>
      new StepReplayer({
        schema: 'logical-gamepad-events/v1',
        generation: 1,
        events: [
          { action: 'jump', t: 0, type: 'down', generation: 1 },
          { action: 'jump', t: 10, type: 'down', generation: 1 },
        ],
      }),
    ).toThrow(/Duplicate action-down/);
    expect(() =>
      new StepReplayer({
        schema: 'logical-gamepad-events/v1',
        generation: 1,
        events: [{ action: 'jump', t: 10, type: 'up', generation: 1 }],
      }),
    ).toThrow(/without a matching down/);
  });
});

describe('recording and replay', () => {
  it('records canonical relative events and replays without a real gamepad', async () => {
    const { provider, poller } = pollerWith(buttonConfig);
    const clock = vi.fn(() => 0);
    const recorder = new EventRecorder(poller, clock);
    recorder.start();

    provider.setTime(10);
    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    provider.setTime(35);
    provider.pads[0] = gamepad(0);
    poller.poll();

    const exported = recorder.stop();
    expect(exported).toEqual({
      schema: 'logical-gamepad-events/v1',
      generation: 1,
      events: [
        { t: 10, type: 'down', action: 'jump', generation: 1 },
        { t: 35, type: 'up', action: 'jump', generation: 1 },
      ],
    });

    const replayer = StepReplayer.fromJSON(JSON.stringify(exported));
    expect(replayer.canStep()).toBe(true);
    expect((await replayer.step()).event).toEqual(exported.events[0]);
    expect(replayer.state.active).toEqual(['jump']);
    expect((await replayer.step()).event).toEqual(exported.events[1]);
    expect(replayer.state.finished).toBe(true);
    expect(replayer.step().event).toBeNull();
    recorder.dispose();
  });

  it('exports subsequent events under the new generation when config changes', () => {
    const { provider, poller } = pollerWith(buttonConfig);
    const recorder = new EventRecorder(poller, () => 0);
    recorder.start();

    provider.pads[0] = gamepad(0, { buttons: [true] });
    poller.poll();
    poller.setConfig({
      bindings: [{ action: 'jump', inputs: [{ kind: 'button', index: 1 }] }],
    });
    provider.pads[0] = gamepad(0, { buttons: [false, true] });
    poller.poll();

    const log = recorder.stop();
    expect(log.generation).toBe(2);
    expect(log.events).toHaveLength(3);
    expect(log.events.map((event) => event.type)).toEqual(['down', 'up', 'down']);
    expect(log.events.map((event) => event.generation)).toEqual([1, 2, 2]);
  });
});
