import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ComputerError } from './controller.js';
import { MACOS_HELPER_SOURCE } from './native-source.js';
import { COMPUTER_LIMITS, type BackendActionResult, type ComputerBackend, type ComputerStatus, type DesktopAction, type DesktopTarget, type NativeScreenshot, type PermissionState } from './types.js';

const MAX_HELPER_OUTPUT_BYTES = 1_750_000;
const MAX_HELPER_ERROR_BYTES = 32_768;
const COMPILE_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 20_000;

interface HelperResult {
  ok: boolean;
  screenRecording?: PermissionState;
  accessibility?: PermissionState;
  screenshot?: NativeScreenshot;
  completedActions?: number;
  failedAction?: number;
  error?: { code?: string; message?: string };
}

function backendError(result: HelperResult, fallback: string): ComputerError {
  const code = typeof result.error?.code === 'string' && result.error.code ? result.error.code : 'NATIVE_HELPER_FAILED';
  const message = typeof result.error?.message === 'string' && result.error.message ? result.error.message : fallback;
  return new ComputerError(code, message, result.completedActions, result.failedAction);
}

function privateDirectory(directory: string): Promise<void> {
  return mkdir(directory, { recursive: true, mode: 0o700 }).then(async () => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ComputerError('INVALID_HELPER_CACHE', 'The Computer Use helper cache must be a private ordinary directory.');
    await chmod(directory, 0o700);
  });
}

interface ProcessResult { stdout: Buffer; stderr: string; code: number | null; signal: NodeJS.Signals | null }
type ChildStopReason = 'cancelled' | 'timeout' | 'output' | 'stdin';

/** 子进程取消先发送 SIGTERM，让 Swift helper 有机会释放按键和鼠标，再用 SIGKILL 封顶。 */
export function childResult(child: ChildProcess, input: Buffer | undefined, signal: AbortSignal, timeoutMs: number, outputLimit: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, settled = false, stopReason: ChildStopReason | undefined;
    let stdinFailed = false, terminationStarted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (reason: ChildStopReason) => {
      stopReason ??= reason;
      if (terminationStarted || child.exitCode !== null || child.signalCode !== null) return;
      terminationStarted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 750); killTimer.unref();
    };
    const abort = () => terminate('cancelled');
    const timeout = setTimeout(() => terminate('timeout'), timeoutMs); timeout.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputLimit) { terminate('output'); return; }
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_HELPER_ERROR_BYTES) return;
      const remaining = MAX_HELPER_ERROR_BYTES - stderrBytes;
      stderr.push(chunk.subarray(0, remaining)); stderrBytes += Math.min(chunk.length, remaining);
    });
    child.once('error', error => {
      if (settled) return; settled = true; clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', abort);
      reject(new ComputerError('NATIVE_HELPER_UNAVAILABLE', 'Could not start the macOS desktop helper. Check the local helper cache and Xcode Command Line Tools, then retry.'));
    });
    child.once('close', (code, processSignal) => {
      if (settled) return; settled = true; clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', abort);
      if (stopReason === 'cancelled') { reject(new ComputerError('CANCELLED', 'Desktop operation was cancelled; the completed action count is unknown and some actions may have finished before helper-owned input state was released.')); return; }
      if (stopReason === 'timeout') { reject(new ComputerError('NATIVE_TIMEOUT', 'The bounded macOS desktop helper timed out; the completed action count is unknown and some actions may have finished before helper-owned input state was released.')); return; }
      if (stopReason === 'output') { reject(new ComputerError('NATIVE_OUTPUT_TOO_LARGE', 'The macOS desktop helper exceeded its bounded output limit.')); return; }
      if (stopReason === 'stdin' || stdinFailed) { reject(new ComputerError('NATIVE_INPUT_FAILED', 'The macOS desktop helper closed its input before receiving the complete bounded request.')); return; }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8'), code, signal: processSignal });
    });
    child.stdin?.on('error', () => { stdinFailed = true; terminate('stdin'); });
    if (signal.aborted) {
      terminate('cancelled');
      child.stdin?.destroy();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (input && child.stdin) child.stdin.end(input);
      else if (child.stdin) child.stdin.end();
      else if (input) terminate('stdin');
    } catch { stdinFailed = true; terminate('stdin'); }
  });
}

export class MacOSComputerBackend implements ComputerBackend {
  private readonly children = new Set<ChildProcess>();
  private compile?: Promise<string>;
  private disposed = false;

  constructor(private readonly stateDir: string) {}

  private spawn(command: string, args: string[], options: { input?: Buffer; signal: AbortSignal; timeoutMs: number; outputLimit: number; env?: Record<string, string> }): Promise<ProcessResult> {
    if (this.disposed) throw new ComputerError('COMPUTER_DISPOSED', 'Computer Use has been disabled.');
    if (options.signal.aborted) throw new ComputerError('CANCELLED', 'Desktop operation was cancelled before the native helper started.');
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: os.tmpdir(), ...options.env },
    });
    this.children.add(child);
    return childResult(child, options.input, options.signal, options.timeoutMs, options.outputLimit).finally(() => { this.children.delete(child); });
  }

  private helper(signal: AbortSignal): Promise<string> {
    if (!this.compile) {
      const compiling = this.compileHelper(signal);
      this.compile = compiling;
      void compiling.catch(() => { if (this.compile === compiling) this.compile = undefined; });
    }
    return this.compile;
  }

  private locations() {
    const root = path.join(this.stateDir, 'computer', 'native');
    return { root, binary: path.join(root, 'capyra-computer'), manifest: path.join(root, 'manifest.json') };
  }

  private async existingHelper(): Promise<string | undefined> {
    const { root, binary, manifest } = this.locations();
    try {
      const [rootInfo, binaryInfo, manifestInfo, saved, executable] = await Promise.all([lstat(root), lstat(binary), lstat(manifest), readFile(manifest, 'utf8'), readFile(binary)]);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !binaryInfo.isFile() || binaryInfo.isSymbolicLink() || binaryInfo.nlink !== 1 || !manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1) throw new Error('invalid cache objects');
      const record = JSON.parse(saved) as { sourceSha256?: string; binarySha256?: string };
      const sourceSha256 = createHash('sha256').update(MACOS_HELPER_SOURCE).digest('hex');
      const binarySha256 = createHash('sha256').update(executable).digest('hex');
      if (record.sourceSha256 !== sourceSha256 || record.binarySha256 !== binarySha256) return undefined;
      return binary;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      if (error instanceof ComputerError) throw error;
      throw new ComputerError('INVALID_HELPER_CACHE', 'The cached Computer Use helper is invalid. Prepare the native component again.');
    }
  }

  private async compileHelper(signal: AbortSignal): Promise<string> {
    if (process.platform !== 'darwin') throw new ComputerError('UNSUPPORTED_OS', `Computer Use supports macOS in this release; current platform is ${process.platform}.`);
    const cached = await this.existingHelper();
    if (cached) return cached;
    const { root, binary, manifest } = this.locations();
    await privateDirectory(path.join(this.stateDir, 'computer'));
    await privateDirectory(root);
    const nonce = randomUUID(), source = path.join(root, `.main-${nonce}.swift`), temporary = path.join(root, `.capyra-computer-${nonce}`), temporaryManifest = path.join(root, `.manifest-${nonce}.json`);
    try {
      await writeFile(source, MACOS_HELPER_SOURCE, { flag: 'wx', mode: 0o600 });
      const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
      const moduleCache = path.join(root, 'module-cache');
      await privateDirectory(moduleCache);
      const result = await this.spawn('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${architecture}-apple-macosx14.0`, source, '-o', temporary, '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ImageIO', '-framework', 'ScreenCaptureKit', '-framework', 'UniformTypeIdentifiers'], { signal, timeoutMs: COMPILE_TIMEOUT_MS, outputLimit: 64_000, env: { CLANG_MODULE_CACHE_PATH: moduleCache, SWIFT_MODULECACHE_PATH: moduleCache } });
      if (result.code !== 0) {
        throw new ComputerError('NATIVE_HELPER_BUILD_FAILED', 'The macOS desktop helper could not be compiled. Install current Xcode Command Line Tools and retry.');
      }
      const info = await lstat(temporary);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new ComputerError('NATIVE_HELPER_BUILD_FAILED', 'The compiled desktop helper is not an ordinary file.');
      await chmod(temporary, 0o700);
      const record = {
        sourceSha256: createHash('sha256').update(MACOS_HELPER_SOURCE).digest('hex'),
        binarySha256: createHash('sha256').update(await readFile(temporary)).digest('hex'),
      };
      await writeFile(temporaryManifest, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
      // 固定可执行路径让 macOS 隐私授权有稳定目标；manifest 绑定当前源码和实际二进制字节。
      await rename(temporary, binary);
      await rename(temporaryManifest, manifest);
      return binary;
    } finally { await Promise.all([unlink(source).catch(() => {}), unlink(temporary).catch(() => {}), unlink(temporaryManifest).catch(() => {})]); }
  }

  private async request(payload: Record<string, unknown>, signal: AbortSignal, prepare = false): Promise<HelperResult> {
    signal.throwIfAborted();
    const binary = prepare ? await this.helper(signal) : await this.existingHelper();
    if (!binary) throw new ComputerError('COMPUTER_NOT_PREPARED', 'Prepare the macOS Computer Use component before checking permissions or using the desktop.');
    signal.throwIfAborted();
    const input = Buffer.from(JSON.stringify(payload));
    if (input.length > 250_000) throw new ComputerError('NATIVE_REQUEST_TOO_LARGE', 'The desktop action batch exceeds the native helper input limit.');
    const result = await this.spawn(binary, [], { input, signal, timeoutMs: REQUEST_TIMEOUT_MS, outputLimit: MAX_HELPER_OUTPUT_BYTES });
    if (result.code !== 0) throw new ComputerError('NATIVE_HELPER_EXITED', `The macOS desktop helper exited unexpectedly${result.signal ? ` (${result.signal})` : ''}. Input state was released when possible.`);
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout.toString('utf8')); }
    catch { throw new ComputerError('INVALID_NATIVE_RESPONSE', 'The macOS desktop helper returned an invalid response.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as HelperResult).ok !== 'boolean') throw new ComputerError('INVALID_NATIVE_RESPONSE', 'The macOS desktop helper returned an invalid response.');
    return parsed as HelperResult;
  }

  async status(signal: AbortSignal): Promise<ComputerStatus> {
    try {
      const result = await this.request({ operation: 'status' }, signal);
      if (!result.ok) throw backendError(result, 'Could not inspect macOS desktop permissions.');
      return {
        platform: 'darwin', supported: true, backendReady: true, displaySelection: 'primary',
        screenRecording: result.screenRecording ?? 'unknown', accessibility: result.accessibility ?? 'unknown',
        message: result.screenRecording === 'granted' && result.accessibility === 'granted'
          ? 'Computer Use is ready for the primary display.'
          : 'Grant the listed macOS privacy permissions to the Capyra/Terminal process in System Settings, then restart that process. This status check never prompts or changes permissions.',
      };
    } catch (error) {
      if (signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : 'Unknown native helper error.';
      return { platform: 'darwin', supported: true, backendReady: false, displaySelection: 'primary', screenRecording: 'unknown', accessibility: 'unknown', message: detail };
    }
  }

  async prepare(signal: AbortSignal): Promise<ComputerStatus> {
    try {
      const result = await this.request({ operation: 'status' }, signal, true);
      if (!result.ok) throw backendError(result, 'Could not inspect macOS desktop permissions.');
      return {
        platform: 'darwin', supported: true, backendReady: true, displaySelection: 'primary',
        screenRecording: result.screenRecording ?? 'unknown', accessibility: result.accessibility ?? 'unknown',
        message: result.screenRecording === 'granted' && result.accessibility === 'granted'
          ? 'Computer Use is ready for the primary display.'
          : 'The native component is prepared. Grant the listed macOS privacy permissions to the displayed Capyra host process, then restart that process.',
      };
    } catch (error) {
      if (signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : 'Unknown native helper error.';
      return { platform: 'darwin', supported: true, backendReady: false, displaySelection: 'primary', screenRecording: 'unknown', accessibility: 'unknown', message: detail };
    }
  }

  async screenshot(signal: AbortSignal): Promise<NativeScreenshot> {
    const result = await this.request({ operation: 'screenshot', maxWidth: COMPUTER_LIMITS.maxScreenshotWidth, maxHeight: COMPUTER_LIMITS.maxScreenshotHeight, maxBytes: COMPUTER_LIMITS.maxScreenshotBytes }, signal);
    if (!result.ok || !result.screenshot) throw backendError(result, 'The primary display could not be captured.');
    return result.screenshot;
  }

  async perform(actions: readonly DesktopAction[], target: DesktopTarget, signal: AbortSignal): Promise<BackendActionResult> {
    const result = await this.request({ operation: 'actions', actions, expectedDisplayId: target.displayId, expectedBounds: target.coordinateBounds }, signal);
    const completedActions = Number.isInteger(result.completedActions) ? result.completedActions! : 0;
    if (completedActions < 0 || completedActions > actions.length || result.failedAction !== undefined && (!Number.isInteger(result.failedAction) || result.failedAction < 0 || result.failedAction >= actions.length)) throw new ComputerError('INVALID_NATIVE_RESPONSE', 'The macOS desktop helper returned invalid action progress.');
    if (!result.ok && (!result.error?.code || !result.error.message)) throw new ComputerError('INVALID_NATIVE_RESPONSE', 'The macOS desktop helper returned an invalid action error.');
    if (result.ok) return { completedActions };
    const error = backendError(result, 'The desktop action batch stopped before completion.');
    return {
      completedActions,
      ...(Number.isInteger(result.failedAction) ? { failedAction: result.failedAction } : {}),
      error: { code: error.code, message: error.message },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const children = [...this.children];
    const closed = children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('close', () => resolve())));
    for (const child of children) child.kill('SIGTERM');
    const force = setTimeout(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 750);
    force.unref();
    let bound!: NodeJS.Timeout;
    const deadline = new Promise<void>(resolve => { bound = setTimeout(resolve, 2_000); bound.unref(); });
    try { await Promise.race([Promise.allSettled(closed).then(() => undefined), deadline]); }
    finally { clearTimeout(force); clearTimeout(bound); }
    this.children.clear();
  }
}

class UnsupportedComputerBackend implements ComputerBackend {
  constructor(private readonly platform: string) {}
  async status(): Promise<ComputerStatus> {
    return { platform: this.platform, supported: false, backendReady: false, displaySelection: 'primary', screenRecording: 'unknown', accessibility: 'unknown', message: `Computer Use supports macOS in this release; current platform is ${this.platform}.` };
  }
  async prepare(): Promise<ComputerStatus> { return this.status(); }
  async screenshot(): Promise<NativeScreenshot> { throw new ComputerError('UNSUPPORTED_OS', `Computer Use supports macOS in this release; current platform is ${this.platform}.`); }
  async perform(): Promise<BackendActionResult> { throw new ComputerError('UNSUPPORTED_OS', `Computer Use supports macOS in this release; current platform is ${this.platform}.`); }
  async dispose() {}
}

export function createComputerBackend(stateDir: string, platform = process.platform): ComputerBackend {
  return platform === 'darwin' ? new MacOSComputerBackend(stateDir) : new UnsupportedComputerBackend(platform);
}
