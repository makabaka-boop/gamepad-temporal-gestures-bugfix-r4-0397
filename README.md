# Logical Gamepad

A small TypeScript layer that maps up to four browser gamepads to named logical actions.

## Features

- Supports up to four gamepad indices.
- Button and directional axis bindings, including chords.
- Per-axis deadzone and release hysteresis.
- Persistent baseline centers and temporary, session-only live calibration.
- Deterministic chord conflict resolution by priority, then chord length.
- Only emits `action-down` / `action-up` when logical state changes.
- Releases the old device's state on disconnect, page blur, or replacement at the same browser index.
- Does not transfer live calibration to a replacement device.
- Records normalized, relative-timestamp event logs.
- Replays logs one event at a time without requiring a physical gamepad.
- Every configuration change starts a new log generation and first releases active old actions.

## Quick start

```ts
import {
  BrowserGamepadProvider,
  EventRecorder,
  GamepadPoller,
  StepReplayer,
  type GamepadMappingConfig,
} from './src/index';

const config: GamepadMappingConfig = {
  axes: {
    0: { deadzone: 0.12, releaseHysteresis: 0.04 },
  },
  bindings: [
    { action: 'jump', inputs: [{ kind: 'button', index: 0 }] },
    {
      action: 'special-jump',
      priority: 10,
      inputs: [
        { kind: 'button', index: 0 },
        { kind: 'button', index: 2 },
      ],
    },
    { action: 'right', inputs: [{ kind: 'axis', index: 0, direction: 1 }] },
  ],
};

const poller = new GamepadPoller(new BrowserGamepadProvider(), config);
const recorder = new EventRecorder(poller, () => performance.now());

poller.addActionListener((event) => console.log(event));
recorder.start();
window.setInterval(() => poller.poll(), 16);
```

Apply a new mapping immediately:

```ts
poller.setConfig(nextConfig);
// generation is incremented; active old actions receive action-up first.
```

Calibrate the current raw X-axis center for gamepad zero:

```ts
poller.calibrateAxis(0, 0);
```

The calibration is scoped to the connected session. Disconnecting, blurring the page, or replacing the gamepad at index zero clears it.

## Multiple gamepads

A binding defaults to gamepad zero. Set `gamepad` explicitly:

```ts
{ action: 'p2-jump', gamepad: 1, inputs: [{ kind: 'button', index: 0 }] }
```

Use `gamepad: '*'` to create the same local binding on all four gamepads. Chord inputs default to the binding's gamepad, so local chords cannot accidentally combine buttons from separate devices.

## Export and replay

```ts
const log = recorder.stop();
const json = JSON.stringify(log);

const replayer = StepReplayer.fromJSON(json);
while (replayer.canStep()) {
  const { event, state } = replayer.step();
  // event: normalized event; state.active: currently held actions
}
```

Exported logs use the schema `logical-gamepad-events/v1`, millisecond timestamps relative to recording start, and include the configuration generation. Replay is pure data processing and does not call the Gamepad API.

## Injectable provider tests

`GamepadPoller` depends only on `GamepadProvider`. Tests inject a fake provider and cover:

- axis activation, noisy release, and hysteresis;
- high-priority chord competition;
- disconnect, stale disconnect snapshots, and same-index replacement;
- page blur/focus and session-specific calibration;
- immediate configuration generations;
- identical final state across different polling batches;
- normalized recording and step replay.

Run:

```bash
npm install
npm test
npm run typecheck
npm run build
```

A browser demo is available with `npm run dev`.

## Button gestures
Bindings may use gesture type tap, double or hold on a single button. The demo maps button zero to jump, dash and charge. A short release waits 240ms for a second click; a second press at the deadline still belongs to the double click, and while the window is open no tap is emitted yet. Hold activates at 500ms, ends on release, and is never followed by a tap. Higher priority chords consume the participating press: once a chord claims the button, its pending tap, armed double and active hold are all withdrawn. Gesture timing is keyed by device, session and configuration generation, so disconnects, same-index replacement, page blur and mapping changes never resume an old gesture, and clicks on different gamepads never combine into one double. Logical recordings preserve the emitted transition order (including equal-timestamp events), and replay validates down/up pairing per generation.
