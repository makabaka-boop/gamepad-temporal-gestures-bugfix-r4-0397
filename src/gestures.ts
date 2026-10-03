import { inputKey } from "./config";
import type { ActionBinding } from "./types";
export interface GestureGroup {
  key: string;
  session: string;
  pad: number;
  bindings: ActionBinding[];
}
export class GestureRecognizer {
  private states = new Map<
    string,
    { down: boolean; started: number; last: number; held: boolean }
  >();
  reset(): void {}
  update(
    groups: GestureGroup[],
    physical: ReadonlySet<string>,
    claimed: ReadonlySet<string>,
    now: number,
  ) {
    const holds: Array<{ action: string; key: string; pad: number }> = [];
    const pulses: Array<{ action: string; key: string; pad: number }> = [];
    for (const group of groups) {
      const key = group.key.split(".")[1]!;
      const s = this.states.get(key) ?? {
        down: false,
        started: now,
        last: -Infinity,
        held: false,
      };
      this.states.set(key, s);
      const down = physical.has(group.key);
      const tap = group.bindings.find((b) => b.gesture?.type === "tap");
      const dbl = group.bindings.find((b) => b.gesture?.type === "double");
      const hold = group.bindings.find((b) => b.gesture?.type === "hold");
      const emit = (binding: ActionBinding | undefined) => {
        if (binding)
          pulses.push({
            action: binding.action,
            key: group.key,
            pad: group.pad,
          });
      };
      if (down && !s.down) {
        s.started = now;
        if (now - s.last <= (dbl?.gesture?.gapMs ?? 240)) emit(dbl);
      }
      if (down && hold && now - s.started >= (hold.gesture?.holdMs ?? 500)) {
        s.held = true;
        holds.push({ action: hold.action, key: group.key, pad: group.pad });
      }
      if (!down && s.down) {
        emit(tap);
        s.last = now;
        s.held = false;
      }
      s.down = down;
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
      if (!sessions.has(input.gamepad ?? pad)) continue;
      const key = inputKey(input, pad);
      const g = groups.get(key) ?? {
        key,
        session: "",
        pad: input.gamepad ?? pad,
        bindings: [],
      };
      g.bindings.push(binding);
      groups.set(key, g);
    }
  }
  return [...groups.values()];
}
