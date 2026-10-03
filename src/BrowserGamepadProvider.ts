import type { GamepadLike, GamepadProvider, GamepadSnapshot } from './types';

interface BrowserGamepadProviderOptions {
  windowRef?: Window & typeof globalThis;
  navigatorRef?: Navigator;
}

/**
 * Adapter around navigator.getGamepads(). It also remembers observed browser
 * indices and listens for gamepaddisconnected, because a stale snapshot alone
 * may briefly continue to report a disconnected device.
 */
export class BrowserGamepadProvider implements GamepadProvider {
  private readonly windowRef: Window & typeof globalThis;
  private readonly navigatorRef: Navigator;
  private readonly connectedAt = new Map<number, number>();
  private readonly disconnectedListeners = new Set<(event: { index: number }) => void>();
  private readonly blurListeners = new Set<() => void>();
  private readonly focusListeners = new Set<() => void>();
  private readonly onDisconnect: (event: Event) => void;
  private readonly onBlur: () => void;
  private readonly onFocus: () => void;

  constructor(options: BrowserGamepadProviderOptions = {}) {
    this.windowRef = options.windowRef ?? globalThis.window;
    this.navigatorRef = options.navigatorRef ?? this.windowRef.navigator;

    this.onDisconnect = (event) => {
      const gamepadEvent = event as GamepadEvent;
      this.connectedAt.delete(gamepadEvent.gamepad.index);
      for (const listener of this.disconnectedListeners) {
        listener({ index: gamepadEvent.gamepad.index });
      }
    };
    this.onBlur = () => {
      for (const listener of this.blurListeners) listener();
    };
    this.onFocus = () => {
      for (const listener of this.focusListeners) listener();
    };

    this.windowRef.addEventListener('gamepaddisconnected', this.onDisconnect);
    this.windowRef.addEventListener('blur', this.onBlur);
    this.windowRef.addEventListener('focus', this.onFocus);
  }

  getGamepads(): GamepadSnapshot {
    const raw = this.navigatorRef.getGamepads?.() ?? [];
    return Array.from({ length: 4 }, (_, index) => {
      const gamepad = raw[index];
      if (!gamepad || !gamepad.connected) return null;
      if (!this.connectedAt.has(index)) this.connectedAt.set(index, performance.now());
      return this.toGamepadLike(gamepad, this.connectedAt.get(index));
    });
  }

  now(): number {
    return this.windowRef.performance.now();
  }

  addGamepadDisconnected(listener: (event: { index: number }) => void): () => void {
    this.disconnectedListeners.add(listener);
    return () => this.disconnectedListeners.delete(listener);
  }

  addWindowBlur(listener: () => void): () => void {
    this.blurListeners.add(listener);
    return () => this.blurListeners.delete(listener);
  }

  addWindowFocus(listener: () => void): () => void {
    this.focusListeners.add(listener);
    return () => this.focusListeners.delete(listener);
  }

  dispose(): void {
    this.windowRef.removeEventListener('gamepaddisconnected', this.onDisconnect);
    this.windowRef.removeEventListener('blur', this.onBlur);
    this.windowRef.removeEventListener('focus', this.onFocus);
    this.disconnectedListeners.clear();
    this.blurListeners.clear();
    this.focusListeners.clear();
  }

  private toGamepadLike(gamepad: Gamepad, connectionTime: number | undefined): GamepadLike {
    return {
      index: gamepad.index,
      id: gamepad.id,
      connected: gamepad.connected,
      buttons: [...gamepad.buttons].map((button) => ({
        pressed: button.pressed,
        value: button.value,
      })),
      axes: [...gamepad.axes],
      ...(connectionTime !== undefined ? { connectedAt: connectionTime } : {}),
    };
  }
}
