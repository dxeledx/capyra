export const COMPUTER_LIMITS = {
  maxActions: 24,
  maxWaitMs: 2_000,
  maxBatchDelayMs: 10_000,
  maxTextCharacters: 4_000,
  maxBatchTextCharacters: 8_000,
  maxScreenshotBytes: 1_200_000,
  maxScreenshotWidth: 1_440,
  maxScreenshotHeight: 1_200,
} as const;

export type PermissionState = 'granted' | 'not_granted' | 'unknown';

export interface ComputerStatus {
  platform: string;
  supported: boolean;
  backendReady: boolean;
  displaySelection: 'primary';
  screenRecording: PermissionState;
  accessibility: PermissionState;
  message: string;
}

export interface DesktopBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopTarget {
  displayId: string;
  coordinateBounds: DesktopBounds;
}

export interface NativeScreenshot {
  data: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  bytes: number;
  displayId: string;
  coordinateBounds: DesktopBounds;
}

export type ComputerModifier = 'command' | 'control' | 'option' | 'shift';

export type ComputerAction =
  | { type: 'mouse_move'; x: number; y: number }
  | { type: 'click'; x: number; y: number }
  | { type: 'double_click'; x: number; y: number }
  | { type: 'right_click'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; toX: number; toY: number; durationMs?: number }
  | { type: 'scroll'; x: number; y: number; deltaX?: number; deltaY: number }
  | { type: 'type_text'; text: string }
  | { type: 'key'; key: string; modifiers?: ComputerModifier[] }
  | { type: 'wait'; durationMs: number };

export type DesktopAction =
  | { type: 'mouse_move'; x: number; y: number }
  | { type: 'click'; x: number; y: number }
  | { type: 'double_click'; x: number; y: number }
  | { type: 'right_click'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; toX: number; toY: number; durationMs: number }
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'type_text'; text: string }
  | { type: 'key'; key: string; modifiers: ComputerModifier[] }
  | { type: 'wait'; durationMs: number };

export interface BackendActionResult {
  completedActions: number;
  failedAction?: number;
  error?: { code: string; message: string };
}

export interface ComputerBackend {
  prepare?(signal: AbortSignal): Promise<ComputerStatus>;
  status(signal: AbortSignal): Promise<ComputerStatus>;
  screenshot(signal: AbortSignal): Promise<NativeScreenshot>;
  perform(actions: readonly DesktopAction[], target: DesktopTarget, signal: AbortSignal): Promise<BackendActionResult>;
  dispose(): Promise<void>;
}

export interface ScreenshotFrame extends Omit<NativeScreenshot, 'data'> {
  screenshotId: string;
  capturedAt: string;
  displaySelection: 'primary';
  coordinateMapping: {
    input: 'screenshot_pixels';
    desktopX: string;
    desktopY: string;
  };
}

export interface ScreenshotResult {
  frame: ScreenshotFrame;
  imageData: string;
}

export interface ActionResult {
  ok: boolean;
  requestedActions: number;
  completedActions: number | null;
  failedAction?: number;
  error?: { code: string; message: string };
  screenshot?: ScreenshotResult;
  refreshError?: { code: string; message: string };
}
