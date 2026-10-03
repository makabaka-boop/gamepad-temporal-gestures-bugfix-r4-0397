import { inputKey } from "./config";
import type { ActionBinding } from "./types";

export interface GestureGroup {
  key: string;
  /** Device session this group belongs to; timing never crosses sessions. */
  session: string;
  pad: number;
  bindings: ActionBinding[];
}

export interface GestureSignal {
  action: string;
  key: string;
  pad: number;
}

export interface GestureUpdateResult {
  /** Holds that are currently active; the poller treats them as held actions. */
  holds: GestureSignal[];
  /** Momentary gestures (tap resolved, double click) fired this update. */
  pulses: GestureSignal[];
}

interface GestureState {
  down: boolean;
  started: number;
  /**
   * The current press has been consumed by a chord (or by a completed double):
   * it can no longer activate a hold, and its release must not emit a tap.
   */
  claimed: boolean;
  /** A hold is currently being reported for the current press. */
  holdActive: boolean;
  /** Release time eligible to start a double click, or -Infinity when unarmed. */
  lastRelease: number;
  /** Tap whose result is deferred until the double-click gap elapses. */
  pending: { action: string; at: number } | null;
  session: string;
}

const DEFAULT_GAP_MS = 240;
const DEFAULT_HOLD_MS = 500;

/**
 * Recognizes tap / double / hold gestures per physical button.
 *
 * Recognition rules:
 * - A short release waits `gapMs` for a second press: the tap is pending and
 *   only fires if no second press completes the double. A second press exactly
 *   at the deadline still belongs to the double.
 * - A press that reaches `holdMs` becomes a hold; releasing it never emits a
 *   tap, and the release does not arm another double.
 * - A press claimed by a higher-priority chord is consumed: no hold, no tap on
 *   release, and it cannot complete a pending double.
 * - Timing is keyed by the full physical key (device + button), session id and
 *   recognizer generation, so disconnects, replacements, blur and config
 *   changes can never continue an old gesture in a later session.
 */
export class GestureRecognizer {
  private states = new Map<string, GestureState>();

  /** Forget every in-flight gesture (configuration generation boundary). */
  reset(): void {
    this.states.clear();
  }

  /** Drop only the gestures owned by one device session. */
  resetPad(pad: number): void {
    const prefix = `g${pad}.`;
    for (const key of [...this.states.keys()]) {
      if (key.startsWith(prefix)) this.states.delete(key);
    }
  }

  update(
    groups: GestureGroup[],
    physical: ReadonlySet<string>,
    claimed: ReadonlySet<string>,
    now: number,
  ): GestureUpdateResult {
    const holds: GestureSignal[] = [];
    const pulses: GestureSignal[] = [];

    for (const group of groups) {
      let state = this.states.get(group.key);
      if (!state || state.session !== group.session) {
        state = {
          down: false,
          started: now,
          claimed: false,
          holdActive: false,
          lastRelease: -Infinity,
          pending: null,
          session: group.session,
        };
        this.states.set(group.key, state);
      }

      const down = physical.has(group.key);
      const isClaimed = claimed.has(group.key);
      const tap = group.bindings.find((b) => b.gesture?.type === "tap");
      const dbl = group.bindings.find((b) => b.gesture?.type === "double");
      const hold = group.bindings.find((b) => b.gesture?.type === "hold");
      const gap = dbl?.gesture?.gapMs ?? DEFAULT_GAP_MS;
      const holdMs = hold?.gesture?.holdMs ?? DEFAULT_HOLD_MS;
      const emit = (binding: ActionBinding | undefined): void => {
        if (binding) {
          pulses.push({ action: binding.action, key: group.key, pad: group.pad });
        }
      };

      if (down && !state.down) {
        // Press edge.
        state.started = now;
        state.holdActive = false;
        if (isClaimed) {
          // The press already belongs to a chord. It is not a gesture click, it
          // breaks any click chain waiting for a second press, and the earlier
          // click's deferred tap is consumed by the combo as well.
          state.claimed = true;
          state.lastRelease = -Infinity;
          state.pending = null;
        } else if (
          dbl &&
          state.lastRelease !== -Infinity &&
          now - state.lastRelease <= gap
        ) {
          // Deadline press is inclusive: this completes the double click, and
          // the deferred tap from the first release is canceled.
          emit(dbl);
          state.claimed = true;
          state.lastRelease = -Infinity;
          state.pending = null;
        } else {
          state.claimed = false;
          state.lastRelease = -Infinity;
        }
      } else if (down && isClaimed && !state.claimed) {
        // Chord formed (or took over) after the button was already held: the
        // gesture (including an active hold and any deferred tap) is withdrawn.
        state.claimed = true;
        state.holdActive = false;
        state.pending = null;
      }

      if (
        down &&
        !state.claimed &&
        hold &&
        now - state.started >= holdMs
      ) {
        // Reached the threshold: report continuously until release/claim so the
        // poller keeps the logical action held across polls.
        state.holdActive = true;
      }

      if (!down && state.down) {
        // Release edge.
        const wasHold = state.holdActive;
        state.holdActive = false;
        if (!wasHold && !state.claimed) {
          // A genuine short release: arm the double-click window and defer the
          // tap until the gap elapses (emit immediately without a double).
          state.lastRelease = now;
          if (tap) {
            if (dbl) {
              state.pending = { action: tap.action, at: now + gap };
            } else {
              emit(tap);
            }
          }
        } else {
          // Held / chord / completed-double release: no tap, no new chain.
          state.lastRelease = -Infinity;
        }
        state.claimed = false;
      }
      state.down = down;

      if (state.holdActive && hold) {
        holds.push({ action: hold.action, key: group.key, pad: group.pad });
      }

      if (state.pending && now >= state.pending.at) {
        pulses.push({
          action: state.pending.action,
          key: group.key,
          pad: group.pad,
        });
        state.pending = null;
      }
    }

    // States for keys absent from this update (binding removed, session ended
    // or a different device generation owns the key now) must be dropped:
    // otherwise a stale "still down" edge could fire inside a future group.
    const liveKeys = new Set(groups.map((group) => group.key));
    for (const key of [...this.states.keys()]) {
      if (!liveKeys.has(key)) this.states.delete(key);
    }

    return { holds, pulses };
  }
}

export function gestureGroups(
  bindings: readonly ActionBinding[],
  sessions: ReadonlyMap<number, { id: string }>,
): GestureGroup[] {
  const groups = new Map<string, GestureGroup>();
  for (const binding of bindings) {
    if (!binding.gesture) continue;
    for (const pad of binding.gamepad === "*"
      ? [0, 1, 2, 3]
      : [binding.gamepad ?? 0]) {
      const input = binding.inputs[0]!;
      const inputPad = input.gamepad ?? pad;
      const session = sessions.get(inputPad);
      if (!session) continue;
      const key = inputKey(input, pad);
      const g = groups.get(key) ?? {
        key,
        session: session.id,
        pad: inputPad,
        bindings: [],
      };
      g.bindings.push(binding);
      groups.set(key, g);
    }
  }
  return [...groups.values()];
}
