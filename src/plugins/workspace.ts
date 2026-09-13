import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { CapyraPlugin, Preview, ToolContext } from '../core/types.js';
import { textResult } from '../sdk.js';
import { assertHash, checkCancelled, expectedHash, isBlockedName, MAX_FILE_BYTES, readBinaryHandle, readHandle, readWorkspaceFile, sha256, stringArg, textBytes, walkWorkspace, workspacePath } from './workspace-paths.js';

const pathSchema = { type: 'string', description: 'Relative workspace path, using forward slashes.' };
const hashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Full-file SHA-256 returned by workspace.read, including when reading a content window.' };
const previewLimit = 12 * 1024;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
function previewText(content: string): string {
  return content.length <= previewLimit ? content : `${content.slice(0, previewLimit)}\n… [preview truncated; full content is covered by SHA-256]`;
}
function changedPreview(name: string, before: { content: string; hash: string } | undefined, after: string): Preview {
  return {
    title: `${before ? '更新' : '创建'} ${name}`,
    description: `Before SHA-256: ${before?.hash ?? '(missing)'}\nAfter SHA-256: ${sha256(textBytes(after))}\nAfter size: ${Buffer.byteLength(after)} bytes`,
    before: before ? previewText(before.content) : '(file does not exist)',
    after: previewText(after),
  };
}
function writeExpectation(args: Record<string, unknown>): string | undefined {
  if (args.expectedMissing === true) {
    if (args.expectedHash !== undefined) throw new Error('Provide expectedMissing or expectedHash, not both');
    return undefined;
  }
  return expectedHash(args);
}
async function prepareWrite(args: Record<string, unknown>, context: ToolContext) {
  const name = stringArg(args, 'path');
  const content = stringArg(args, 'content');
  textBytes(content);
  const hash = writeExpectation(args);
  const target = await workspacePath(context.workspace, name, { allowMissing: hash === undefined });
  if (hash === undefined) {
    try { await lstat(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { name, content, before: undefined };
      throw error;
    }
    throw new Error('File already exists; use expectedHash from read');
  }
  const before = await readWorkspaceFile(context.workspace, name, context.signal);
  assertHash(before.hash, hash);
  return { name, content, before };
}
async function prepareEdit(args: Record<string, unknown>, context: ToolContext) {
  const name = stringArg(args, 'path');
  const oldText = stringArg(args, 'oldText');
  const newText = stringArg(args, 'newText');
  if (!oldText) throw new Error('oldText must not be empty');
  const oldBytes = textBytes(oldText).length;
  const newBytes = textBytes(newText).length;
  if (args.replaceAll !== undefined && typeof args.replaceAll !== 'boolean') throw new Error('replaceAll must be a boolean');
  const before = await readWorkspaceFile(context.workspace, name, context.signal);
  assertHash(before.hash, expectedHash(args));
  const first = before.content.indexOf(oldText);
  if (first < 0) throw new Error('oldText does not occur in the file');
  if (!args.replaceAll && before.content.indexOf(oldText, first + oldText.length) >= 0) throw new Error('oldText occurs more than once; provide a unique match or set replaceAll');
  let matches = 1;
  if (args.replaceAll) {
    let position = first + oldText.length;
    while ((position = before.content.indexOf(oldText, position)) >= 0) { matches++; position += oldText.length; }
  }
  // 替换一个短词可能把小文件扩张很多倍；构建新字符串前先限制真实 UTF-8 大小。
  if (Buffer.byteLength(before.content) + matches * (newBytes - oldBytes) > MAX_FILE_BYTES) throw new Error(`Content exceeds the ${MAX_FILE_BYTES}-byte limit`);
  const content = args.replaceAll ? before.content.replaceAll(oldText, () => newText) : before.content.slice(0, first) + newText + before.content.slice(first + oldText.length);
  textBytes(content);
  return { name, content, before };
}
export async function applyWrite(name: string, content: string | Uint8Array, hash: string | undefined, context: ToolContext, mode?: number) {
  checkCancelled(context.signal);
  const target = await workspacePath(context.workspace, name, { allowMissing: hash === undefined });
  const parent = path.dirname(target);
  const parentHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const parentInfo = await parentHandle.stat();
  const temporary = path.join(parent, `.capyra-tmp-${randomUUID()}`);
  let original: FileHandle | undefined;
  let staging: FileHandle | undefined;
  try {
    // 先保留原文件和目录的身份；原文件始终保持完整，暂存阶段不做原地写入。
    if (hash !== undefined) {
      original = await open(target, constants.O_RDWR | constants.O_NOFOLLOW);
      assertHash((await readHandle(original, context.signal)).hash, hash);
    }
    const originalInfo = await original?.stat();
    checkCancelled(context.signal);
    const data = typeof content === 'string' ? textBytes(content) : Buffer.from(content);
    if (data.length > (typeof content === 'string' ? MAX_FILE_BYTES : MAX_UPLOAD_BYTES)) throw new Error('File size exceeds the upload limit');
    staging = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let written = 0;
    while (written < data.length) {
      checkCancelled(context.signal);
      const result = await staging.write(data, written, data.length - written, written);
      if (!result.bytesWritten) throw new Error('Unable to complete file write');
      written += result.bytesWritten;
    }
    if (originalInfo || mode !== undefined) await staging.chmod((originalInfo?.mode ?? mode!) & 0o7777);
    await staging.sync();

    // 暂存写入或 fsync 失败不会碰旧文件；发布前再次核对父目录、路径 inode 和完整哈希。
    await workspacePath(context.workspace, name, { allowMissing: hash === undefined });
    const currentParent = await lstat(parent);
    if (currentParent.isSymbolicLink() || currentParent.dev !== parentInfo.dev || currentParent.ino !== parentInfo.ino) throw new Error('Parent directory was replaced during preparation');
    if (hash !== undefined && originalInfo) {
      const current = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const currentInfo = await current.stat();
        if (currentInfo.dev !== originalInfo.dev || currentInfo.ino !== originalInfo.ino || currentInfo.mode !== originalInfo.mode) throw new Error('File was replaced or its permissions changed during preparation');
        assertHash((await readHandle(current, context.signal)).hash, hash);
      } finally { await current.close(); }
    }
    checkCancelled(context.signal);
    // 宿主串行调度变更；此检查加原子发布不等于对敌对本地进程提供跨进程 CAS。
    if (hash === undefined) await link(temporary, target);
    else await rename(temporary, target);
    return textResult({ path: name, bytes: data.length, previousHash: hash ?? null, hash: sha256(data) });
  } finally {
    try {
      if (staging) {
        const staged = await staging.stat();
        const current = await lstat(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (current?.dev === staged.dev && current.ino === staged.ino) await unlink(temporary);
      }
    } finally {
      await Promise.all([staging?.close(), original?.close(), parentHandle.close()]);
    }
  }
}
async function prepareMove(args: Record<string, unknown>, context: ToolContext) {
  const from = stringArg(args, 'from');
  const to = stringArg(args, 'to');
  const source = await workspacePath(context.workspace, from);
  const target = await workspacePath(context.workspace, to, { allowMissing: true });
  if (source === target) throw new Error('Source and destination must differ');
  const before = await readWorkspaceFile(context.workspace, from, context.signal);
  assertHash(before.hash, expectedHash(args));
  try { await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { from, to, source, target, before };
    throw error;
  }
  throw new Error('Destination already exists; moves never overwrite');
}

interface PatchChange { name: string; before?: Awaited<ReturnType<typeof readWorkspaceFile>>; content?: string; mode?: number }
async function preparePatch(args: Record<string, unknown>, ctx: ToolContext): Promise<PatchChange[]> {
  const patch = stringArg(args, 'patch');
  textBytes(patch);
  const hashes = args.expectedHashes;
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) throw new Error('expectedHashes maps each existing path to its observed SHA-256');
  const lines = patch.replaceAll('\r\n', '\n').trim().split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') throw new Error('Patch must use *** Begin Patch and *** End Patch markers');
  const changes: PatchChange[] = [];
  const touched = new Set<string>();
  const reserve = async (name: string, missing: boolean) => {
    const target = await workspacePath(ctx.workspace, name, { allowMissing: missing });
    if (touched.has(target)) throw new Error('A patch may change each path only once');
    touched.add(target);
    if (missing) {
      try { await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      throw new Error('Patch destination already exists');
    }
  };
  for (let index = 0; index < lines.length;) {
    if (changes.length >= 50) throw new Error('A patch can change at most 50 paths');
    const header = /^(\*\*\* (Add|Update|Delete) File): (.+)$/.exec(lines[index++]!);
    if (!header) throw new Error('Invalid patch action header');
    const kind = header[2]!;
    const name = header[3]!;
    await reserve(name, kind === 'Add');
    if (kind === 'Add') {
      const added: string[] = [];
      while (index < lines.length && !lines[index]!.startsWith('*** ')) {
        if (!lines[index]!.startsWith('+')) throw new Error('Added file lines must start with +');
        added.push(lines[index++]!.slice(1));
      }
      const content = added.join('\n') + (added.length ? '\n' : '');
      textBytes(content);
      changes.push({ name, content });
      continue;
    }
    const before = await readWorkspaceFile(ctx.workspace, name, ctx.signal);
    const mode = (await lstat(await workspacePath(ctx.workspace, name))).mode;
    assertHash(before.hash, expectedHash({ expectedHash: (hashes as Record<string, unknown>)[name] }));
    if (kind === 'Delete') { changes.push({ name, before, mode }); continue; }
    let destination: string | undefined;
    if (lines[index]?.startsWith('*** Move to: ')) { destination = lines[index++]!.slice(13); await reserve(destination, true); }
    const newline = before.content.includes('\r\n') ? '\r\n' : '\n';
    const source = before.content.replaceAll('\r\n', '\n').split('\n');
    const trailingNewline = source.at(-1) === '';
    if (trailingNewline) source.pop();
    const output: string[] = [];
    let cursor = 0;
    let hunks = 0;
    while (index < lines.length && (!lines[index]!.startsWith('*** ') || lines[index] === '*** End of File')) {
      let anchor = '';
      if (lines[index]?.startsWith('@@')) anchor = lines[index++]!.slice(2).trim();
      const old: string[] = [];
      const replacement: string[] = [];
      let endOfFile = false;
      while (index < lines.length && !lines[index]!.startsWith('@@') && !lines[index]!.startsWith('*** ')) {
        const line = lines[index++]!;
        if (line === '\\ No newline at end of file') continue;
        if (![' ', '+', '-'].includes(line[0] ?? '')) throw new Error('Patch hunk lines must start with space, + or -');
        if (line[0] !== '+') old.push(line.slice(1));
        if (line[0] !== '-') replacement.push(line.slice(1));
      }
      if (lines[index] === '*** End of File') { endOfFile = true; index++; }
      if (!old.length && !replacement.length) throw new Error('Empty patch hunk');
      let start = cursor;
      if (anchor && !/^[-+]\d/.test(anchor)) {
        const found = source.indexOf(anchor, cursor);
        if (found < 0) throw new Error(`Patch context was not found in ${name}`);
        start = found + 1;
      }
      const matches: number[] = [];
      for (let position = start; position <= source.length - old.length; position++) {
        if (endOfFile && position + old.length !== source.length) continue;
        if (old.every((line, offset) => source[position + offset] === line)) matches.push(position);
      }
      if (matches.length !== 1) throw new Error(`Patch context in ${name} must match exactly once; found ${matches.length}`);
      const position = matches[0]!;
      for (const line of source.slice(cursor, position)) output.push(line);
      for (const line of replacement) output.push(line);
      cursor = position + old.length;
      hunks++;
    }
    if (!hunks && !destination) throw new Error('Update patch has no hunks');
    const content = hunks ? [...output, ...source.slice(cursor)].join(newline) + (trailingNewline ? newline : '') : before.content;
    textBytes(content);
    if (destination) { changes.push({ name, before, mode }, { name: destination, content, mode }); }
    else changes.push({ name, before, content, mode });
  }
  if (!changes.length) throw new Error('Patch has no file changes');
  return changes;
}

async function removeFile(name: string, hash: string, ctx: ToolContext) {
  const target = await workspacePath(ctx.workspace, name);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertHash((await readHandle(handle, ctx.signal)).hash, hash);
    await workspacePath(ctx.workspace, name);
    const current = await lstat(target);
    if (before.ino !== current.ino || before.dev !== current.dev) throw new Error('File was replaced during preparation');
    checkCancelled(ctx.signal);
    await unlink(target);
  } finally { await handle.close(); }
}

export function validateIncomingFile(value: unknown): { download_url: string; file_id: string; size?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Native file reference is required');
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some(key => !['download_url', 'file_id', 'mime_type', 'file_name', 'name', 'size'].includes(key))) throw new Error('Malformed native file reference');
  if (typeof file.file_id !== 'string' || !file.file_id || file.file_id.length > 512 || /[\x00-\x1f\x7f]/.test(file.file_id)) throw new Error('Invalid native file ID');
  if (typeof file.download_url !== 'string') throw new Error('Native file download URL is required');
  trustedFileUrl(file.download_url);
  if (file.size !== undefined && file.size !== null && (typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_UPLOAD_BYTES)) throw new Error('Native file size exceeds the 32 MiB limit or is invalid');
  return { download_url: file.download_url, file_id: file.file_id, ...(typeof file.size === 'number' ? { size: file.size } : {}) };
}
function trustedFileUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid native file URL'); }
  if (url.protocol !== 'https:' || (url.hostname !== 'files.oaiusercontent.com' && !/^oaisdmntpr[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)) || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Error('Native file URL is outside trusted OpenAI file hosts');
  return url;
}
export async function downloadIncomingFile(value: unknown, signal: AbortSignal): Promise<Buffer> {
  const file = validateIncomingFile(value);
  let url = trustedFileUrl(file.download_url);
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response: Response;
    try { response = await fetch(url, { redirect: 'manual', signal: boundedSignal }); }
    catch { throw new Error('Native file download failed'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw new Error('Invalid native file redirect');
      url = trustedFileUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Native file download did not return file content'); }
    const advertised = response.headers.get('content-length');
    if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_UPLOAD_BYTES || (file.size !== undefined && Number(advertised) !== file.size))) {
      await response.body.cancel(); throw new Error('Native file size metadata mismatch or upload limit exceeded');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        checkCancelled(boundedSignal);
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_UPLOAD_BYTES) throw new Error('Native file exceeds the 32 MiB upload limit');
        chunks.push(Buffer.from(chunk.value));
      }
      if ((file.size !== undefined && size !== file.size) || (advertised !== null && size !== Number(advertised))) throw new Error('Native file size metadata mismatch');
      return Buffer.concat(chunks);
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  throw new Error('Native file redirect limit exceeded');
}

async function assertMissing(name: string, ctx: ToolContext): Promise<void> {
  const target = await workspacePath(ctx.workspace, name, { allowMissing: true });
  try { await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('Destination already exists');
}
function uploadBytes(args: Record<string, unknown>): Buffer {
  const encoded = stringArg(args, 'base64');
  if (encoded.length > 1_398_104 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid or oversized base64 content');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== encoded) throw new Error('Invalid or oversized base64 content');
  return bytes;
}

const plugin: CapyraPlugin = {
  apiVersion: 1,
  id: 'workspace',
  version: '0.1.0',
  title: 'Workspace files',
  description: 'Inspect and safely prepare text file changes within a chosen workspace.',
  permissions: ['workspace:read', 'workspace:write'],
  instructions: 'Paths are relative to the selected workspace. Read a file to obtain its hash before edits. Writes and moves require local approval. Text files are limited to 1 MiB; protected paths and symbolic links are unavailable.',
  setup(context) {
    context.registerTool({
      name: 'read_image', title: 'Read a workspace image', effect: 'read', permissions: ['workspace:read'],
      description: 'Return a PNG, JPEG, GIF or WebP image as native MCP image content, up to 1 MiB. Format is checked from the file signature.',
      inputSchema: { type: 'object', properties: { path: pathSchema }, required: ['path'], additionalProperties: false },
      async execute(args, ctx) {
        const name = stringArg(args, 'path'); const target = await workspacePath(ctx.workspace, name);
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const bytes = await readBinaryHandle(handle, ctx.signal);
          const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) ? 'image/gif' : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : undefined;
          if (!mimeType) throw new Error('Only PNG, JPEG, GIF and WebP images are supported');
          return { content: [{ type: 'text', text: JSON.stringify({ path: name, bytes: bytes.length, hash: sha256(bytes), mimeType }) }, { type: 'image', data: bytes.toString('base64'), mimeType }] };
        } finally { await handle.close(); }
      },
    });
    context.registerTool({
      name: 'search', title: 'Search workspace files', effect: 'read', permissions: ['workspace:read'],
      description: 'Search literal text in UTF-8 files or file paths. Bounded recursive traversal excludes protected paths, symlinks, binary and oversized files. Returns up to 200 matches with line numbers.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 1024 }, path: pathSchema, mode: { type: 'string', enum: ['content', 'path'], default: 'content' }, caseSensitive: { type: 'boolean', default: true }, maxDepth: { type: 'integer', minimum: 0, maximum: 20, default: 8 } }, required: ['query'], additionalProperties: false },
      async execute(args, ctx) {
        const query = stringArg(args, 'query');
        if (!query || query.length > 1024) throw new Error('query must contain 1–1024 characters');
        const depth = args.maxDepth ?? 8;
        if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0 || depth > 20) throw new Error('Invalid maxDepth');
        const needle = args.caseSensitive === false ? query.toLowerCase() : query;
        const matches: { path: string; line?: number; text?: string }[] = [];
        let scanned = 0;
        let skipped = 0;
        let truncated = false;
        const contains = (value: string) => (args.caseSensitive === false ? value.toLowerCase() : value).includes(needle);
        for await (const entry of walkWorkspace(ctx.workspace, args.path === undefined ? '.' : stringArg(args, 'path'), ctx.signal, depth)) {
          if (matches.length >= 200) { truncated = true; break; }
          if (args.mode === 'path') { if (contains(entry.path)) matches.push({ path: entry.path }); continue; }
          if (entry.type !== 'file') continue;
          scanned++;
          let content: string;
          try { content = (await readWorkspaceFile(ctx.workspace, entry.path, ctx.signal)).content; }
          catch (error) { checkCancelled(ctx.signal); if (/limit|UTF-8|Binary|hard links|ENOENT/.test(String(error))) { skipped++; continue; } throw error; }
          const lines = content.split('\n');
          for (let line = 0; line < lines.length; line++) {
            if (!contains(lines[line]!)) continue;
            if (matches.length === 200) { truncated = true; break; }
            matches.push({ path: entry.path, line: line + 1, text: lines[line]!.slice(0, 1000) });
          }
        }
        return textResult({ matches, scanned, skipped, truncated });
      },
    });
    context.registerTool({
      name: 'mkdir', title: 'Create a workspace directory', effect: 'write', permissions: ['workspace:write'],
      description: 'Create one directory within the workspace. Parent must exist; existing directories are left intact.',
      inputSchema: { type: 'object', properties: { path: pathSchema }, required: ['path'], additionalProperties: false },
      async preview(args, ctx) { const name = stringArg(args, 'path'); await workspacePath(ctx.workspace, name, { allowMissing: true }); return { title: `创建目录 ${name}`, description: 'Create the directory with private permissions.' }; },
      async execute(args, ctx) {
        const name = stringArg(args, 'path');
        const target = await workspacePath(ctx.workspace, name, { allowMissing: true });
        checkCancelled(ctx.signal);
        await mkdir(target, { mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST' || !(await lstat(await workspacePath(ctx.workspace, name))).isDirectory()) throw error; });
        return textResult({ path: name });
      },
    });
    context.registerTool({
      name: 'apply_patch', title: 'Apply a workspace patch', effect: 'write', permissions: ['workspace:write'],
      description: 'Apply a *** Begin Patch document with Add File, Update File, Delete File and Move to actions. Existing paths require SHA-256 entries in expectedHashes. All hunks must match uniquely; parent directories must exist. All paths are validated before mutation and completed changes are rolled back on failure when still unchanged.',
      inputSchema: { type: 'object', properties: { patch: { type: 'string', maxLength: MAX_FILE_BYTES }, expectedHashes: { type: 'object', additionalProperties: hashSchema } }, required: ['patch', 'expectedHashes'], additionalProperties: false },
      async preview(args, ctx) {
        const changes = await preparePatch(args, ctx);
        return { title: `修改 ${changes.length} 个文件`, description: changes.map(change => `${change.name}: ${change.before?.hash ?? '(missing)'} → ${change.content === undefined ? '(delete)' : sha256(textBytes(change.content))}`).join('\n'), before: previewText(changes.map(change => `--- ${change.name}\n${change.before?.content ?? '(missing)'}`).join('\n')), after: previewText(changes.map(change => `+++ ${change.name}\n${change.content ?? '(delete)'}`).join('\n')) };
      },
      async execute(args, ctx) {
        const changes = await preparePatch(args, ctx);
        const applied: PatchChange[] = [];
        try {
          for (const change of changes) {
            if (change.content === undefined) await removeFile(change.name, change.before!.hash, ctx);
            else await applyWrite(change.name, change.content, change.before?.hash, ctx, change.mode);
            applied.push(change);
          }
        } catch (error) {
          const failures: string[] = [];
          // 取消不能阻止恢复已发布的变更；哈希检查确保恢复不会覆盖同时出现的用户修改。
          const rollback = { ...ctx, signal: new AbortController().signal };
          for (const change of applied.reverse()) {
            try {
              if (change.before) await applyWrite(change.name, change.before.content, change.content === undefined ? undefined : sha256(textBytes(change.content)), rollback, change.mode);
              else await removeFile(change.name, sha256(textBytes(change.content!)), rollback);
            } catch { failures.push(change.name); }
          }
          throw new Error(`${error instanceof Error ? error.message : String(error)}${failures.length ? `; rollback needs local review for: ${failures.join(', ')}` : '; earlier patch changes were restored'}`);
        }
        return textResult({ files: changes.map(change => ({ path: change.name, operation: change.content === undefined ? 'delete' : change.before ? 'update' : 'add', hash: change.content === undefined ? null : sha256(textBytes(change.content)) })) });
      },
    });
    context.registerTool({
      name: 'upload', title: 'Receive a file in the workspace', effect: 'write', permissions: ['workspace:write'],
      description: 'Create an unused workspace file from base64 bytes, up to 1 MiB. Binary files are supported. Parent directory must exist.',
      inputSchema: { type: 'object', properties: { path: pathSchema, base64: { type: 'string', maxLength: 1_398_104 } }, required: ['path', 'base64'], additionalProperties: false },
      async preview(args, ctx) {
        const name = stringArg(args, 'path'); const bytes = uploadBytes(args);
        await assertMissing(name, ctx);
        return { title: `接收文件 ${name}`, description: `${bytes.length} bytes\nSHA-256: ${sha256(bytes)}` };
      },
      async execute(args, ctx) { const name = stringArg(args, 'path'); await assertMissing(name, ctx); return applyWrite(name, uploadBytes(args), undefined, ctx); },
    });
    context.registerTool({
      name: 'download_artifact', title: 'Receive an attached ChatGPT file', effect: 'write', permissions: ['workspace:write'],
      publicCatalog: true,
      description: 'Download a host-provided ChatGPT native file reference to an unused workspace path, up to 32 MiB. Only trusted OpenAI file hosts are accepted, including every redirect. Parent must exist. The file is fetched only after local approval.',
      inputSchema: { type: 'object', properties: { path: pathSchema, file: { type: 'object', properties: { download_url: { type: 'string' }, file_id: { type: 'string' }, mime_type: { type: ['string', 'null'] }, file_name: { type: ['string', 'null'] }, name: { type: ['string', 'null'] }, size: { type: ['integer', 'null'], minimum: 0, maximum: MAX_UPLOAD_BYTES } }, required: ['download_url', 'file_id'], additionalProperties: false } }, required: ['path', 'file'], additionalProperties: false },
      _meta: { 'openai/fileParams': ['file'] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      timeoutMs: 45_000,
      async preview(args, ctx) { const file = validateIncomingFile(args.file); const name = stringArg(args, 'path'); await assertMissing(name, ctx); return { title: `接收 ChatGPT 文件 ${name}`, description: `Native file ID: ${file.file_id}\nSize: ${file.size ?? 'checked during download'}\nMaximum: 32 MiB` }; },
      async execute(args, ctx) { const name = stringArg(args, 'path'); await assertMissing(name, ctx); const bytes = await downloadIncomingFile(args.file, ctx.signal); return applyWrite(name, bytes, undefined, ctx); },
    });
    context.registerTool({
      name: 'list', title: 'List workspace files', effect: 'read', permissions: ['workspace:read'],
      description: 'List one directory, excluding protected paths and symbolic links. Returns at most 500 entries.',
      inputSchema: { type: 'object', properties: { path: { ...pathSchema, default: '.' } }, additionalProperties: false },
      async execute(args, ctx) {
        const name = args.path === undefined ? '.' : stringArg(args, 'path');
        const target = await workspacePath(ctx.workspace, name, { allowRoot: true });
        const dir = await opendir(target);
        const entries: { name: string; path: string; type: string }[] = [];
        let truncated = false;
        for await (const entry of dir) {
          checkCancelled(ctx.signal);
          if (entry.isSymbolicLink() || isBlockedName(entry.name) || (!entry.isFile() && !entry.isDirectory())) continue;
          if (entries.length === 500) { truncated = true; break; }
          entries.push({ name: entry.name, path: path.posix.join(name, entry.name), type: entry.isDirectory() ? 'directory' : 'file' });
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        return textResult({ path: name, entries, truncated });
      },
    });
    context.registerTool({
      name: 'read', title: 'Read a workspace file', effect: 'read', permissions: ['workspace:read'],
      description: `Read a content window from a UTF-8 file of at most ${MAX_FILE_BYTES} bytes. offset and limit use JavaScript string positions (UTF-16 code units), not bytes. Defaults: offset 0, limit 16384; maximum limit 65536. hash and bytes always describe the entire file. Continue with nextOffset until null; truncated means more content follows this window.`,
      inputSchema: { type: 'object', properties: { path: pathSchema, offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0, description: 'Start position in UTF-16 code units, as used by JavaScript strings.' }, limit: { type: 'integer', minimum: 1, maximum: 65536, default: 16384, description: 'Maximum UTF-16 code units in the returned content window.' } }, required: ['path'], additionalProperties: false },
      async execute(args, ctx) {
        const name = stringArg(args, 'path');
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 16384;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative safe integer in UTF-16 code units');
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 65536) throw new Error('limit must be an integer between 1 and 65536 UTF-16 code units');
        const { content, hash, bytes } = await readWorkspaceFile(ctx.workspace, name, ctx.signal);
        // 全文哈希用于后续写入校验；只把内容窗口交给模型，避免大文件占满上下文。
        const window = content.slice(offset, offset + limit);
        const end = Math.min(content.length, offset + window.length);
        const truncated = end < content.length;
        return textResult({ path: name, content: window, hash, hashScope: 'full-file', bytes, offset, limit, totalCharacters: content.length, nextOffset: truncated ? end : null, truncated });
      },
    });
    context.registerTool({
      name: 'write', title: 'Write a workspace file', effect: 'write', permissions: ['workspace:write'],
      description: 'Create or replace a UTF-8 file. Supply expectedMissing: true for a new file, or expectedHash from read. Parent directory must exist.',
      inputSchema: { type: 'object', properties: { path: pathSchema, content: { type: 'string', maxLength: MAX_FILE_BYTES }, expectedHash: hashSchema, expectedMissing: { type: 'boolean', const: true } }, required: ['path', 'content'], oneOf: [{ required: ['expectedHash'] }, { required: ['expectedMissing'] }], additionalProperties: false },
      async preview(args, ctx) { const change = await prepareWrite(args, ctx); return changedPreview(change.name, change.before, change.content); },
      async execute(args, ctx) { const change = await prepareWrite(args, ctx); return applyWrite(change.name, change.content, change.before?.hash, ctx); },
    });
    context.registerTool({
      name: 'edit', title: 'Replace text in a workspace file', effect: 'write', permissions: ['workspace:write'],
      description: 'Replace an exact text match in a file with an expected SHA-256. Repeated matches require replaceAll: true.',
      inputSchema: { type: 'object', properties: { path: pathSchema, oldText: { type: 'string', minLength: 1, maxLength: MAX_FILE_BYTES }, newText: { type: 'string', maxLength: MAX_FILE_BYTES }, expectedHash: hashSchema, replaceAll: { type: 'boolean', default: false } }, required: ['path', 'oldText', 'newText', 'expectedHash'], additionalProperties: false },
      async preview(args, ctx) { const change = await prepareEdit(args, ctx); return changedPreview(change.name, change.before, change.content); },
      async execute(args, ctx) { const change = await prepareEdit(args, ctx); return applyWrite(change.name, change.content, change.before.hash, ctx); },
    });
    context.registerTool({
      name: 'move', title: 'Move a workspace file', effect: 'write', permissions: ['workspace:write'],
      description: 'Move one UTF-8 file of at most 1 MiB to an unused path in the same filesystem. Requires the source hash and an existing destination directory.',
      inputSchema: { type: 'object', properties: { from: pathSchema, to: pathSchema, expectedHash: hashSchema }, required: ['from', 'to', 'expectedHash'], additionalProperties: false },
      async preview(args, ctx) {
        const change = await prepareMove(args, ctx);
        return { title: `移动 ${change.from} 至 ${change.to}`, description: `SHA-256: ${change.before.hash}\nDestination must be missing.`, before: change.from, after: change.to };
      },
      async execute(args, ctx) {
        const change = await prepareMove(args, ctx);
        checkCancelled(ctx.signal);
        const handle = await open(change.source, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          assertHash((await readHandle(handle, ctx.signal)).hash, expectedHash(args));
          await workspacePath(ctx.workspace, change.from);
          await workspacePath(ctx.workspace, change.to, { allowMissing: true });
          checkCancelled(ctx.signal);
          // link 的目标必须不存在，避免 rename 在审批后覆盖新出现的目标文件。
          await link(change.source, change.target);
          const linked = await lstat(change.target);
          if (opened.ino !== linked.ino || opened.dev !== linked.dev) {
            await unlink(change.target);
            throw new Error('Source was replaced during move');
          }
          const current = await lstat(change.source);
          if (opened.ino !== current.ino || opened.dev !== current.dev) {
            await unlink(change.target);
            throw new Error('Source was replaced during move');
          }
          await unlink(change.source);
          return textResult({ from: change.from, to: change.to, hash: change.before.hash, bytes: change.before.bytes });
        } finally { await handle.close(); }
      },
    });
  },
};

export default plugin;
