import {
  BrowserGamepadProvider,
  EventRecorder,
  GamepadPoller,
  StepReplayer,
  type GamepadMappingConfig,
} from '../index';

const defaultConfig: GamepadMappingConfig = {
  axes: { 0: { deadzone: 0.1, releaseHysteresis: 0.03 } },
  bindings: [
    { action: 'jump', inputs: [{ kind: 'button', index: 0 }], gesture: { type: 'tap' } },
    { action: 'dash', inputs: [{ kind: 'button', index: 0 }], gesture: { type: 'double', gapMs: 240 } },
    { action: 'charge', inputs: [{ kind: 'button', index: 0 }], gesture: { type: 'hold', holdMs: 500 } },
    { action: 'special', priority: 10, inputs: [{ kind: 'button', index: 0 }, { kind: 'button', index: 2 }] },
    { action: 'right', inputs: [{ kind: 'axis', index: 0, direction: 1 }] },
    { action: 'left', inputs: [{ kind: 'axis', index: 0, direction: -1 }] },
    { action: 'down', inputs: [{ kind: 'axis', index: 1, direction: 1 }] },
    { action: 'up', inputs: [{ kind: 'axis', index: 1, direction: -1 }] },
  ],
};

const provider = new BrowserGamepadProvider();
const poller = new GamepadPoller(provider, defaultConfig);
const recorder = new EventRecorder(poller, () => performance.now());

const active = new Set<string>();
let replayer: StepReplayer | null = null;
let currentLog = recorder.exportLog();

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
};

const form = $('#config-form') as HTMLFormElement;
const deadzone = $('#deadzone') as HTMLInputElement;
const hysteresis = $('#hysteresis') as HTMLInputElement;
const recordButton = $('#record') as HTMLButtonElement;
const stopButton = $('#stop') as HTMLButtonElement;
const stepButton = $('#step') as HTMLButtonElement;
const exportButton = $('#export') as HTMLButtonElement;
const generationElement = $('#generation');
const activeElement = $('#active-actions');
const eventsElement = $('#events');
const replayStateElement = $('#replay-state');

poller.addActionListener((event) => {
  if (event.type === 'action-down') active.add(event.action);
  else active.delete(event.action);
  currentLog = recorder.exportLog();
  render();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  poller.setConfig({
    ...defaultConfig,
    axes: {
      0: {
        deadzone: Number(deadzone.value),
        releaseHysteresis: Number(hysteresis.value),
      },
    },
  });
  render();
});

$('#calibrate').addEventListener('click', () => {
  try {
    poller.calibrateAxis(0, 0);
  } catch (error) {
    alert((error as Error).message);
  }
});

recordButton.addEventListener('click', () => {
  active.clear();
  recorder.start();
  replayer = null;
  render();
});

stopButton.addEventListener('click', () => {
  currentLog = recorder.stop();
  replayer = new StepReplayer(currentLog);
  render();
});

stepButton.addEventListener('click', () => {
  replayer?.step();
  render();
});

exportButton.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(currentLog, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `gamepad-events-${currentLog.generation}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

function pollLoop() {
  poller.poll();
  requestAnimationFrame(pollLoop);
}

function render() {
  generationElement.textContent = String(recorder.getGeneration());
  stopButton.disabled = !recorder.isRecording();
  recordButton.disabled = recorder.isRecording();
  stepButton.disabled = !replayer || !replayer.canStep();
  exportButton.disabled = currentLog.events.length === 0;
  activeElement.innerHTML = active.size
    ? [...active].sort().map((action) => `<li>${action}</li>`).join('')
    : '<li class="muted">无</li>';
  eventsElement.textContent = JSON.stringify(currentLog.events, null, 2);
  replayStateElement.textContent = replayer
    ? JSON.stringify(replayer.state, null, 2)
    : '尚未回放';
}

pollLoop();
render();
