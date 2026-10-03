import { GestureRecognizer, gestureGroups } from './gestures';
import { MAX_GAMEPADS, inputKey, normalizeConfig } from './config';
import type {
  ActionBinding,
  GamepadLike,
  GamepadMappingConfig,
  GamepadProvider,
  GamepadSnapshot,
  LogicalActionEvent,
  LogicalActionListener,
  NormalizedConfig,
  PhysicalInput,
} from './types';

interface SessionState {
  id: string;
  /** Runtime calibration never survives disconnect/blur or index replacement. */
  centers: Map<number, number>;
}

interface ActiveAction {
  pads: Set<number>;
  sources: Set<string>;
}

interface Candidate {
  action: string;
  pad: number;
  priority: number;
  order: number;
  required: Set<string>;
  sources: string[];
  pads: number[];
}

interface PhysicalInputState {
  pad: number;
}

const DEFAULT_DEADZONE = 0.1;
const DEFAULT_RELEASE_HYSTERESIS = 0.03;

export class GamepadPoller {
  private config: NormalizedConfig;
  private generation = 1;
  private gestures = new GestureRecognizer();
  private readonly listeners = new Set<LogicalActionListener>();
  private readonly sessions = new Map<number, SessionState>();
  private readonly active = new Map<string, ActiveAction>();
  private readonly physical = new Map<string, PhysicalInputState>();
  private readonly axisActive = new Map<string, boolean>();
  private readonly disconnectedIndexes = new Map<number, string>();
  private lastSnapshot: GamepadSnapshot = [];
  private focused = true;
  private pendingBlur = false;
  private focusEpoch = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly provider: GamepadProvider,
    config: GamepadMappingConfig,
  ) {
    this.config = normalizeConfig(config);

    this.disposers.push(
      this.provider.addGamepadDisconnected?.(({ index }) => {
        const session = this.sessions.get(index);
        if (session) this.disconnectedIndexes.set(index, session.id);
      }) ?? (() => {}),
    );

    this.disposers.push(
      this.provider.addWindowBlur?.(() => {
        this.pendingBlur = true;
      }) ?? (() => {}),
    );
    this.disposers.push(this.provider.addWindowFocus?.(() => this.handleFocus()) ?? (() => {}));
  }

  getGeneration(): number {
    return this.generation;
  }

  setConfig(config: GamepadMappingConfig): void {
    const normalized = normalizeConfig(config);

    // End logical actions under the old mapping; releases are part of the new
    // log generation so a config boundary is never represented by stale data.
    this.generation += 1;
    for (const [action, state] of [...this.active].sort(([a], [b]) => a.localeCompare(b))) {
      this.dispatch('action-up', action, state.sources);
    }
    this.active.clear();

    // Axis latches belong to the old tuning/mapping and must not leak forward.
    this.axisActive.clear();
    this.config = normalized;
    this.gestures.reset();
  }

  addActionListener(listener: LogicalActionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  poll(): readonly LogicalActionEvent[] {
    if (this.pendingBlur) {
      const events = this.handleBlur();
      return events;
    }
    if (!this.focused) return [];

    const snapshot = this.provider.getGamepads();
    this.lastSnapshot = snapshot;
    const skipped = new Set<number>();
    const endedSessions = new Set<number>();

    for (let index = 0; index < MAX_GAMEPADS; index += 1) {
      const gamepad = snapshot[index];
      const oldSession = this.sessions.get(index);
      const staleSessionId = this.disconnectedIndexes.get(index);
      const staleDisconnect = staleSessionId !== undefined && gamepad?.connected === true;
      if (staleDisconnect) {
        const nextSessionId = this.sessionId(gamepad);
        if (nextSessionId !== staleSessionId) {
          this.disconnectedIndexes.delete(index);
        } else {
          // Browser already emitted disconnect; a still-present snapshot is stale.
          skipped.add(index);
        }
      }
      const desired = gamepad?.connected && !skipped.has(index) ? gamepad : undefined;

      if (!desired) {
        if (oldSession) {
          this.endSession(index);
          endedSessions.add(index);
        }
        continue;
      }
      this.disconnectedIndexes.delete(index);

      if (oldSession && oldSession.id !== this.sessionId(desired)) {
        // Release the old device's physical inputs before creating its session.
        this.endSession(index);
        endedSessions.add(index);
      }
      if (!this.sessions.has(index)) {
        this.sessions.set(index, { id: this.sessionId(desired), centers: new Map() });
      }
    }

    const removedIndexes = new Set([...skipped, ...endedSessions]);
    return this.reconcile(snapshot, removedIndexes);
  }

  handleBlur(): LogicalActionEvent[] {
    if (!this.focused) return [];
    this.pendingBlur = false;
    this.focused = false;
    this.gestures.reset();
    this.physical.clear();
    this.axisActive.clear();
    this.sessions.clear();
    const events: LogicalActionEvent[] = [];
    // No device inputs remain, so every active logical action must release now.
    for (const [action, state] of [...this.active].sort(([a], [b]) => a.localeCompare(b))) {
      const event: LogicalActionEvent = {
        type: 'action-up',
        action,
        generation: this.generation,
        time: this.now(),
        sources: [...state.sources].sort(),
      };
      events.push(event);
      this.dispatchEvent(event);
    }
    this.active.clear();
    this.physical.clear();
    this.axisActive.clear();
    this.sessions.clear();
    return events;
  }

  handleFocus(): void {
    if (this.focused) return;
    this.focused = true;
    this.pendingBlur = false;
    this.focusEpoch += 1;
    this.disconnectedIndexes.clear();
  }

  /**
   * Set a session-specific axis center. Pass no center to calibrate to the
   * latest polled raw value. The override disappears if this session ends.
   */
  calibrateAxis(index: number, axis: number, center?: number): void {
    const session = this.sessions.get(index);
    if (!session) throw new Error(`Cannot calibrate inactive gamepad ${index}`);
    const value = center ?? this.lastSnapshot[index]?.axes[axis];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`No current value for gamepad ${index} axis ${axis}`);
    }
    session.centers.set(axis, value);
    this.axisActive.delete(`${index}:${axis}`);
    this.reconcile(this.provider.getGamepads(), new Set());
  }

  getAxisCenter(index: number, axis: number): number {
    return this.sessions.get(index)?.centers.get(axis) ?? this.baselineCenter(index, axis);
  }

  dispose(): void {
    for (const disposer of this.disposers) disposer();
    this.disposers.length = 0;
    this.listeners.clear();
  }

  private endSession(index: number): void {
    const prefix = `g${index}.`;
    for (const key of [...this.physical.keys()]) {
      if (key.startsWith(prefix)) this.physical.delete(key);
    }
    for (const key of [...this.axisActive.keys()]) {
      if (key.startsWith(`${index}:`)) this.axisActive.delete(key);
    }
    this.sessions.delete(index);
  }

  private reconcile(snapshot: GamepadSnapshot, skipped: ReadonlySet<number>): LogicalActionEvent[] {
    this.readPhysicalInputs(snapshot, skipped);
    const candidates = this.buildCandidates();
    const selected = this.selectCandidates(candidates);
    const claimed = new Set<string>();
    for (const [action, state] of selected) {
      if (action.startsWith('@@gesture:')) selected.delete(action);
      else for (const source of state.sources) claimed.add(source);
    }
    const groups = gestureGroups(this.config.bindings, this.sessions).filter(g => !skipped.has(g.pad));
    const result = this.gestures.update(groups, new Set(this.physical.keys()), claimed, this.now());
    for (const hold of result.holds) {
      const state = selected.get(hold.action) ?? { pads: new Set<number>(), sources: new Set<string>() };
      state.pads.add(hold.pad); state.sources.add(hold.key); selected.set(hold.action, state);
    }
    const events = this.applySelection(selected);
    for (const pulse of result.pulses) {
      if (selected.has(pulse.action)) continue;
      for (const type of ['action-down','action-up'] as const) {
        const event: LogicalActionEvent = { type, action: pulse.action, sources: [pulse.key], time: this.now(), generation: this.generation };
        events.push(event); this.dispatchEvent(event);
      }
    }
    return events;
  }

  private readPhysicalInputs(snapshot: GamepadSnapshot, skipped: ReadonlySet<number>): void {
    this.physical.clear();

    for (let index = 0; index < MAX_GAMEPADS; index += 1) {
      if (skipped.has(index)) continue;
      const gamepad = snapshot[index];
      if (!gamepad?.connected || !this.sessions.has(index)) continue;

      gamepad.buttons.forEach((button, buttonIndex) => {
        const value = button.value ?? (button.pressed ? 1 : 0);
        const pressed = button.pressed ?? value >= 0.5;
        if (pressed || value >= 0.5) {
          this.physical.set(`g${index}.b${buttonIndex}`, { pad: index });
        }
      });

      gamepad.axes.forEach((raw, axis) => {
        const tuning = this.axisTuning(axis);
        const center = this.getAxisCenter(index, axis);
        const offset = this.clampUnit(raw - center);
        const magnitude = Math.abs(offset);
        const latchKey = `${index}:${axis}`;
        const wasActive = this.axisActive.get(latchKey) ?? false;
        const active = wasActive
          ? magnitude >= tuning.deadzone - tuning.releaseHysteresis
          : magnitude >= tuning.deadzone;
        this.axisActive.set(latchKey, active);

        if (active && offset !== 0) {
          const direction = offset > 0 ? '+' : '-';
          this.physical.set(`g${index}.a${axis}.${direction}`, { pad: index });
        }
      });
    }
  }

  private buildCandidates(): Map<string, Candidate> {
    const candidates = new Map<string, Candidate>();

    this.config.bindings.forEach((binding, order) => {
      if (binding.gesture) return;
      const pads = binding.gamepad === '*' ? [0, 1, 2, 3] : [binding.gamepad ?? 0];
      for (const pad of pads) {
        const required = new Set<string>();
        const candidatePads = new Set<number>();
        for (const input of binding.inputs) {
          const key = inputKey(input, pad);
          required.add(key);
          candidatePads.add(input.gamepad ?? pad);
        }
        if ([...required].some((key) => !this.physical.has(key))) continue;

        const candidate: Candidate = {
          action: binding.action,
          pad,
          priority: binding.priority ?? 0,
          order,
          required,
          sources: [...required].sort(),
          pads: [...candidatePads].sort((a, b) => a - b),
        };
        candidates.set(this.candidateKey(binding, pad, required), candidate);
      }
    });

    for (const g of gestureGroups(this.config.bindings, this.sessions)) {
      if (!this.physical.has(g.key)) continue;
      candidates.set(`gesture:${g.key}`, { action: `@@gesture:${g.key}`, pad: g.pad, priority: Math.max(...g.bindings.map(b => b.priority ?? 0)), order: 0, required: new Set([g.key]), sources: [g.key], pads: [g.pad] });
    }
    return candidates;
  }

  private selectCandidates(candidates: Map<string, Candidate>): Map<string, ActiveAction> {
    const sorted = [...candidates.values()].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.required.size !== a.required.size) return b.required.size - a.required.size;
      if (a.action !== b.action) return a.action.localeCompare(b.action);
      return a.pad - b.pad || a.order - b.order;
    });

    const usedInputs = new Set<string>();
    const selected = new Map<string, ActiveAction>();

    for (const candidate of sorted) {
      if ([...candidate.required].some((key) => usedInputs.has(key))) continue;
      let state = selected.get(candidate.action);
      if (!state) {
        state = { pads: new Set(), sources: new Set() };
        selected.set(candidate.action, state);
      }
      for (const key of candidate.required) usedInputs.add(key);
      for (const pad of candidate.pads) state.pads.add(pad);
      for (const source of candidate.sources) state.sources.add(source);
    }

    return selected;
  }

  private applySelection(next: Map<string, ActiveAction>): LogicalActionEvent[] {
    const events: LogicalActionEvent[] = [];
    const dispatch = (event: LogicalActionEvent): void => {
      events.push(event);
      this.dispatchEvent(event);
    };

    for (const [action, state] of [...this.active].sort(([a], [b]) => a.localeCompare(b))) {
      if (!next.has(action)) {
        dispatch({
          type: 'action-up',
          action,
          generation: this.generation,
          time: this.now(),
          sources: [...state.sources].sort(),
        });
      }
    }

    for (const [action, state] of [...next].sort(([a], [b]) => a.localeCompare(b))) {
      const previous = this.active.get(action);
      if (!previous) {
        dispatch({
          type: 'action-down',
          action,
          generation: this.generation,
          time: this.now(),
          sources: [...state.sources].sort(),
        });
      } else {
        // Additional devices can join an already-active logical action silently.
        previous.pads = state.pads;
        previous.sources = state.sources;
      }
    }

    this.active.clear();
    for (const [action, state] of next) this.active.set(action, state);
    return events;
  }

  private candidateKey(binding: ActionBinding, pad: number, required: Set<string>): string {
    // Explicit cross-device bindings all declare gamepad zero, but their full
    // input set keeps them distinct from a gamepad-zero-only binding.
    return `${binding.action}:${binding.gamepad === '*' ? pad : binding.gamepad ?? 0}:${[...required].sort().join('|')}`;
  }

  private axisTuning(axis: number) {
    return this.config.axes[axis] ?? {
      deadzone: DEFAULT_DEADZONE,
      releaseHysteresis: DEFAULT_RELEASE_HYSTERESIS,
      center: 0,
    };
  }

  private baselineCenter(index: number, axis: number): number {
    return this.config.gamepads[index]?.axisCenters?.[axis] ?? this.axisTuning(axis).center;
  }

  private sessionId(gamepad: GamepadLike): string {
    return `e${this.focusEpoch}:${gamepad.index}:${gamepad.id}:${gamepad.connectedAt ?? 'snapshot'}`;
  }

  private clampUnit(value: number): number {
    return Math.max(-1, Math.min(1, value));
  }

  private now(): number {
    return this.provider.now?.() ?? 0;
  }

  private dispatch(type: LogicalActionEvent['type'], action: string, sources: Set<string>): void {
    this.dispatchEvent({
      type,
      action,
      generation: this.generation,
      time: this.now(),
      sources: [...sources].sort(),
    });
  }

  private dispatchEvent(event: LogicalActionEvent): void {
    for (const listener of this.listeners) listener({ ...event, sources: [...event.sources] });
  }
}

export type { PhysicalInput };
