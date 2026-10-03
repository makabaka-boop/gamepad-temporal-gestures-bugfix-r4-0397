import type {
  CanonicalActionEvent,
  CanonicalEventLog,
  GamepadProvider,
  LogicalActionEvent,
} from './types';
import { GamepadPoller } from './GamepadPoller';
import type { GamepadMappingConfig } from './types';

/**
 * Records only logical state changes. Timestamps are relative to recording
 * start and zero-based, making exports independent of the machine clock.
 */
export class EventRecorder {
  private events: Array<CanonicalActionEvent & { seq: number }> = [];
  private seq = 0;
  private recording = false;
  private startTime = 0;
  private generation = 1;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly poller: GamepadPoller,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.generation = poller.getGeneration();
    this.unsubscribe = poller.addActionListener((event) => this.record(event));
  }

  isRecording(): boolean {
    return this.recording;
  }

  getGeneration(): number {
    return this.generation;
  }

  getEvents(): readonly CanonicalActionEvent[] {
    return this.events;
  }

  start(): void {
    this.events = [];
    this.seq = 0;
    this.generation = this.poller.getGeneration();
    this.startTime = this.now();
    this.recording = true;
  }

  stop(): CanonicalEventLog {
    this.recording = false;
    return this.exportLog();
  }

  exportLog(): CanonicalEventLog {
    // Sort by timestamp, then by emission order. The tiebreak matters within one
    // poll batch (e.g. a release immediately followed by another down at the
    // same clock tick): replay must reproduce exactly what live listeners saw.
    const sorted = [...this.events].sort((a, b) => a.t - b.t || a.seq - b.seq);
    return {
      schema: 'logical-gamepad-events/v1',
      generation: this.generation,
      events: sorted.map((event) => ({
        action: event.action,
        t: event.t,
        type: event.type,
        generation: event.generation,
      })),
    };
  }

  toJSON(): string {
    return JSON.stringify(this.exportLog(), null, 2);
  }

  dispose(): void {
    this.unsubscribe();
  }

  private record(event: LogicalActionEvent): void {
    if (!this.recording) return;
    this.generation = event.generation;
    this.events.push({
      seq: this.seq++,
      t: Math.max(0, event.time - this.startTime),
      type: event.type === 'action-down' ? 'down' : 'up',
      action: event.action,
      generation: event.generation,
    });
  }
}

export interface ReplayState {
  events: readonly CanonicalActionEvent[];
  index: number;
  finished: boolean;
  /** Action keys whose down event has been replayed without a matching up. */
  active: readonly string[];
  generation: number;
  currentEventGeneration: number | null;
}

export interface ReplayStep {
  event: CanonicalActionEvent | null;
  state: ReplayState;
}

export class StepReplayer {
  private readonly events: CanonicalActionEvent[];
  private cursor = 0;
  private readonly activeActions = new Set<string>();

  constructor(private readonly log: CanonicalEventLog) {
    validateEventLog(log);
    this.events = log.events.map((event) => ({ ...event }));
  }

  static fromJSON(json: string): StepReplayer {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      throw new Error(`Invalid event log JSON: ${(error as Error).message}`);
    }
    return new StepReplayer(parsed as CanonicalEventLog);
  }

  get length(): number {
    return this.events.length;
  }

  get state(): ReplayState {
    return {
      events: this.events.map((event) => ({ ...event })),
      index: this.cursor,
      finished: this.cursor >= this.events.length,
      active: [...this.activeActions].sort(),
      generation: this.log.generation,
      currentEventGeneration: this.events[this.cursor - 1]?.generation ?? null,
    };
  }

  canStep(): boolean {
    return this.cursor < this.events.length;
  }

  step(): ReplayStep {
    const event = this.events[this.cursor] ?? null;
    if (event) {
      if (event.type === 'down') this.activeActions.add(event.action);
      else this.activeActions.delete(event.action);
      this.cursor += 1;
    }
    return { event: event ? { ...event } : null, state: this.state };
  }

  reset(): void {
    this.cursor = 0;
    this.activeActions.clear();
  }
}

export function validateEventLog(log: unknown): asserts log is CanonicalEventLog {
  if (!log || typeof log !== 'object') throw new TypeError('Event log must be an object');
  const candidate = log as Partial<CanonicalEventLog>;
  if (candidate.schema !== 'logical-gamepad-events/v1') {
    throw new TypeError('Unsupported event log schema');
  }
  const generation = candidate.generation;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
    throw new TypeError('Event log generation must be a positive integer');
  }
  if (!Array.isArray(candidate.events)) throw new TypeError('Event log events must be an array');

  const active = new Set<string>();
  let lastGeneration = 0;
  for (const event of candidate.events) {
    if (!event || typeof event !== 'object') throw new TypeError('Each event must be an object');
    if (typeof event.action !== 'string' || event.action.length === 0) {
      throw new TypeError('Each event requires an action');
    }
    if (event.type !== 'down' && event.type !== 'up') {
      throw new TypeError('Each event type must be down or up');
    }
    if (!Number.isFinite(event.t) || event.t < 0) {
      throw new TypeError('Each event requires a non-negative timestamp');
    }
    if (!Number.isInteger(event.generation) || event.generation < 1) {
      throw new TypeError('Each event requires a positive generation');
    }
    // A configuration boundary releases every old action implicitly.
    if (event.generation !== lastGeneration) {
      active.clear();
      lastGeneration = event.generation;
    }
    if (event.type === 'down') {
      if (active.has(event.action)) {
        throw new TypeError(`Duplicate action-down for ${event.action} without an up`);
      }
      active.add(event.action);
    } else if (!active.delete(event.action)) {
      throw new TypeError(`action-up for ${event.action} without a matching down`);
    }
  }
}

export function createGamepadPoller(
  provider: GamepadProvider,
  config: GamepadMappingConfig,
): GamepadPoller {
  return new GamepadPoller(provider, config);
}
