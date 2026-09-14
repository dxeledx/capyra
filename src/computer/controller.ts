import { randomUUID } from 'node:crypto';
import { COMPUTER_LIMITS, type ActionResult, type ComputerAction, type ComputerBackend, type DesktopAction, type NativeScreenshot, type ScreenshotFrame, type ScreenshotResult } from './types.js';

interface Scope { owner: string; workspace: string; session: string }
interface StoredFrame extends ScreenshotResult { owner: string; workspace: string }

export class ComputerError extends Error {
  constructor(readonly code: string, message: string, readonly completedActions?: number, readonly failedAction?: number) {
    super(message);
    this.name = 'ComputerError';
  }
}

function errorInfo(error: unknown): { code: string; message: string; completedActions?: number; failedAction?: number } {
  if (error instanceof ComputerError) return { code: error.code, message: error.message, completedActions: error.completedActions, failedAction: error.failedAction };
  if (error instanceof Error) return { code: 'COMPUTER_BACKEND_ERROR', message: error.message || 'Desktop operation failed.' };
  return { code: 'COMPUTER_BACKEND_ERROR', message: 'Desktop operation failed.' };
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ComputerError('INVALID_ACTION', `${name} must be a finite number.`);
  return value;
}

/** 所有桌面读写共享一条队列，避免不同调用者同时观察或操纵同一物理桌面。 */
class SerialDesktopQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new ComputerError('COMPUTER_DISPOSED', 'Computer Use is no longer available. Re-enable the plugin and try again.');
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.catch(() => {}).then(() => turn);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new ComputerError('CANCELLED', 'Desktop operation was cancelled before it started.'));
      else { onAbort = () => reject(new ComputerError('CANCELLED', 'Desktop operation was cancelled before it started.')); signal.addEventListener('abort', onAbort, { once: true }); }
    });
    try {
      await Promise.race([previous, aborted]);
      signal.throwIfAborted();
      if (this.closed) throw new ComputerError('COMPUTER_DISPOSED', 'Computer Use is no longer available. Re-enable the plugin and try again.');
      return await operation();
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort); release(); }
  }

  close() { this.closed = true; }
  async drained() { await this.tail.catch(() => {}); }
}

function verifyScreenshot(image: NativeScreenshot): void {
  const maxEncodedLength = Math.ceil(COMPUTER_LIMITS.maxScreenshotBytes / 3) * 4;
  // 先检查声明值和字符串上界，再做线性字符检查与解码，避免对超大输入分配 Buffer。
  if (typeof image.data !== 'string') throw new ComputerError('INVALID_SCREENSHOT', 'The desktop backend returned an invalid PNG payload.');
  if (image.bytes > COMPUTER_LIMITS.maxScreenshotBytes || image.data.length > maxEncodedLength) throw new ComputerError('SCREENSHOT_TOO_LARGE', `The desktop screenshot exceeds the ${COMPUTER_LIMITS.maxScreenshotBytes}-byte payload limit.`);
  if (image.mimeType !== 'image/png' || !Number.isInteger(image.bytes) || image.bytes < 1 || image.data.length < 4 || image.data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new ComputerError('INVALID_SCREENSHOT', 'The desktop backend returned an invalid or oversized PNG payload.');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length !== image.bytes || bytes.toString('base64') !== image.data || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new ComputerError('INVALID_SCREENSHOT', 'The desktop backend returned a non-canonical or invalid PNG payload.');
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > COMPUTER_LIMITS.maxScreenshotWidth || image.height > COMPUTER_LIMITS.maxScreenshotHeight) throw new ComputerError('INVALID_SCREENSHOT', 'The desktop backend returned invalid screenshot dimensions.');
  const bounds = image.coordinateBounds;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new ComputerError('INVALID_SCREENSHOT', 'The desktop backend returned invalid display coordinates.');
}

function publicFrame(image: NativeScreenshot): ScreenshotFrame {
  const { data: _data, ...metadata } = image;
  return {
    ...metadata,
    screenshotId: randomUUID(),
    capturedAt: new Date().toISOString(),
    displaySelection: 'primary',
    coordinateMapping: {
      input: 'screenshot_pixels',
      desktopX: `desktop_x = ${metadata.coordinateBounds.x} + screenshot_x * ${metadata.coordinateBounds.width} / ${metadata.width}`,
      desktopY: `desktop_y = ${metadata.coordinateBounds.y} + screenshot_y * ${metadata.coordinateBounds.height} / ${metadata.height}`,
    },
  };
}

function sameScope(frame: StoredFrame, scope: Scope) { return frame.owner === scope.owner && frame.workspace === scope.workspace; }

/** 坐标始终以返回图片像素为准，再按显示器坐标边界映射到 Retina/非 Retina 桌面。 */
export function screenshotPoint(frame: ScreenshotFrame, xValue: unknown, yValue: unknown): { x: number; y: number } {
  const x = finite(xValue, 'x'), y = finite(yValue, 'y');
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw new ComputerError('COORDINATE_OUT_OF_BOUNDS', `Screenshot coordinate (${x}, ${y}) is outside ${frame.width}x${frame.height}. Read a fresh screenshot and choose a point inside it.`);
  return {
    x: frame.coordinateBounds.x + x * frame.coordinateBounds.width / frame.width,
    y: frame.coordinateBounds.y + y * frame.coordinateBounds.height / frame.height,
  };
}

function normalizeActions(frame: ScreenshotFrame, actions: readonly ComputerAction[]): DesktopAction[] {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > COMPUTER_LIMITS.maxActions) throw new ComputerError('INVALID_ACTION_BATCH', `actions must contain 1-${COMPUTER_LIMITS.maxActions} items.`);
  let delayMs = 0, textCharacters = 0;
  const normalized = actions.map((action, index): DesktopAction => {
    if (!action || typeof action !== 'object') throw new ComputerError('INVALID_ACTION', `Action ${index} must be an object.`);
    switch (action.type) {
      case 'mouse_move': return { type: action.type, ...screenshotPoint(frame, action.x, action.y) };
      case 'click': return { type: action.type, ...screenshotPoint(frame, action.x, action.y) };
      case 'double_click': return { type: action.type, ...screenshotPoint(frame, action.x, action.y) };
      case 'right_click': return { type: action.type, ...screenshotPoint(frame, action.x, action.y) };
      case 'drag': {
        const from = screenshotPoint(frame, action.x, action.y), to = screenshotPoint(frame, action.toX, action.toY);
        const durationMs = action.durationMs ?? 500;
        if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 3_000) throw new ComputerError('INVALID_ACTION', `Action ${index} durationMs must be an integer from 0 to 3000.`);
        delayMs += durationMs;
        return { type: action.type, ...from, toX: to.x, toY: to.y, durationMs };
      }
      case 'scroll': {
        const point = screenshotPoint(frame, action.x, action.y);
        const deltaX = finite(action.deltaX ?? 0, 'deltaX'), deltaY = finite(action.deltaY, 'deltaY');
        if (Math.abs(deltaX) > 2_000 || Math.abs(deltaY) > 2_000) throw new ComputerError('INVALID_ACTION', `Action ${index} scroll deltas must be between -2000 and 2000.`);
        return { type: action.type, ...point, deltaX, deltaY };
      }
      case 'type_text':
        if (typeof action.text !== 'string' || action.text.length < 1 || action.text.length > COMPUTER_LIMITS.maxTextCharacters || Buffer.byteLength(action.text) > 16_000) throw new ComputerError('INVALID_ACTION', `Action ${index} text must contain 1-${COMPUTER_LIMITS.maxTextCharacters} characters and at most 16000 UTF-8 bytes.`);
        textCharacters += action.text.length;
        return { type: action.type, text: action.text };
      case 'key': {
        if (typeof action.key !== 'string' || !/^[a-z0-9]$|^(enter|tab|space|escape|backspace|delete|left|right|up|down|home|end|page_up|page_down|f(?:[1-9]|1[0-2]))$/.test(action.key)) throw new ComputerError('INVALID_ACTION', `Action ${index} contains an unsupported key.`);
        const modifiers = action.modifiers ?? [];
        if (!Array.isArray(modifiers) || modifiers.some(value => !['command', 'control', 'option', 'shift'].includes(value)) || new Set(modifiers).size !== modifiers.length) throw new ComputerError('INVALID_ACTION', `Action ${index} contains invalid or duplicate modifiers.`);
        return { type: action.type, key: action.key, modifiers: [...modifiers] };
      }
      case 'wait': {
        const durationMs = action.durationMs;
        if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > COMPUTER_LIMITS.maxWaitMs) throw new ComputerError('INVALID_ACTION', `Action ${index} durationMs must be an integer from 0 to ${COMPUTER_LIMITS.maxWaitMs}.`);
        delayMs += durationMs;
        return { type: action.type, durationMs };
      }
      default: throw new ComputerError('INVALID_ACTION', `Action ${index} has an unsupported type.`);
    }
  });
  if (delayMs > COMPUTER_LIMITS.maxBatchDelayMs) throw new ComputerError('BATCH_DELAY_TOO_LARGE', `Batch delay exceeds ${COMPUTER_LIMITS.maxBatchDelayMs} ms.`);
  if (textCharacters > COMPUTER_LIMITS.maxBatchTextCharacters) throw new ComputerError('BATCH_TEXT_TOO_LARGE', `Batch text exceeds ${COMPUTER_LIMITS.maxBatchTextCharacters} characters.`);
  return normalized;
}

export class ComputerController {
  private readonly queue = new SerialDesktopQueue();
  private latest?: StoredFrame;
  private disposed = false;

  constructor(private readonly backend: ComputerBackend) {}

  prepare(signal: AbortSignal) { return this.queue.run(signal, () => this.backend.prepare?.(signal) ?? this.backend.status(signal)); }

  status(signal: AbortSignal) { return this.queue.run(signal, () => this.backend.status(signal)); }

  screenshot(scope: Scope, signal: AbortSignal): Promise<ScreenshotResult> {
    return this.queue.run(signal, async () => this.capture(scope, signal));
  }

  private async capture(scope: Scope, signal: AbortSignal): Promise<ScreenshotResult> {
    signal.throwIfAborted();
    const image = await this.backend.screenshot(signal);
    verifyScreenshot(image);
    signal.throwIfAborted();
    const frame = publicFrame(image), result = { frame, imageData: image.data };
    // 物理桌面只有一个“当前观察”；生成新帧会使所有先前坐标依据失效。
    this.latest = { ...result, ...scope };
    return result;
  }

  act(scope: Scope, screenshotId: string, actions: readonly ComputerAction[], refresh: boolean, signal: AbortSignal): Promise<ActionResult> {
    return this.queue.run(signal, async () => {
      const frame = this.latest;
      if (!frame || frame.frame.screenshotId !== screenshotId) throw new ComputerError('STALE_SCREENSHOT', 'Screenshot is stale or unknown. Read a fresh screenshot before acting.');
      if (!sameScope(frame, scope)) throw new ComputerError('SCREENSHOT_SCOPE_MISMATCH', 'Screenshot belongs to another caller or workspace. Read a screenshot in the current conversation workspace.');
      const normalized = normalizeActions(frame.frame, actions);
      // 动作可能只执行一部分；开始前即撤销旧帧，禁止用旧视觉状态重放后续变更。
      this.latest = undefined;
      let report: ActionResult;
      try {
        const outcome = await this.backend.perform(normalized, { displayId: frame.frame.displayId, coordinateBounds: frame.frame.coordinateBounds }, signal);
        report = {
          ok: !outcome.error,
          requestedActions: normalized.length,
          completedActions: outcome.completedActions,
          ...(outcome.failedAction === undefined ? {} : { failedAction: outcome.failedAction }),
          ...(outcome.error ? { error: outcome.error } : {}),
        };
      } catch (error) {
        const detail = errorInfo(error);
        report = {
          ok: false,
          requestedActions: normalized.length,
          completedActions: detail.completedActions ?? null,
          ...(detail.failedAction === undefined ? {} : { failedAction: detail.failedAction }),
          error: { code: detail.code, message: detail.message },
        };
      }
      if (refresh && !signal.aborted) {
        try { report.screenshot = await this.capture(scope, signal); }
        catch (error) { const detail = errorInfo(error); report.refreshError = { code: detail.code, message: detail.message }; }
      }
      return report;
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.latest = undefined;
    this.queue.close();
    await this.backend.dispose();
    await this.queue.drained();
  }
}
