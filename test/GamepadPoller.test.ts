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
