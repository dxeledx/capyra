'use strict';
// This panel invokes the same approved tools as ChatGPT. Rendering never captures a screen.
window.capyraComputer = (() => {
  let scope = '', epoch = 0, busy = false;
  const prompt = '请使用 Capyra 的 computer 工具直接操作本机桌面。先发现工具；若原生组件未准备则请求 computer__prepare，然后检查状态并截图。每次根据最新截图选择少量操作并检查返回的新截图；不要用编码代理代替你看图操作。先完成无副作用的验收：读取当前画面并描述可见内容，不点击或输入。';
  const plugin = () => (state.data?.plugins ?? []).find(item => item.id === 'computer');
  const scopeKey = () => JSON.stringify([currentProject().path, state.online, state.authRequired, state.data?.metrics?.paused, plugin()?.enabled, hasTool('computer__screenshot')]);
  function clear() {
    epoch++;
    $('computer-preview')?.replaceChildren(empty('等待一次截图', '点击“截图测试”，查看实际返回的图片。', '▣'));
    $('computer-diagnostics')?.replaceChildren();
    text('computer-coordinates', '');
  }
  function render() {
    if (!$('computer-state')) return;
    const next = scopeKey();
    if (next !== scope) { scope = next; clear(); }
    const entry = plugin(), paused = state.data?.metrics?.paused === true;
    const ready = state.online && !state.authRequired && !paused && entry?.enabled;
    text('computer-state', !state.online ? '未连接' : paused ? '已暂停' : entry?.enabled ? '插件已启用' : '插件未启用');
    text('computer-availability', !entry ? '此配置尚未添加桌面插件。添加后可在本机选择权限与启用状态。' : !entry.enabled ? '桌面插件已登记，尚未启用。请配置所需权限，再在插件组合中启用。' : entry.error ? entry.error : '可检查系统权限并请求一次截图。macOS 系统权限以检测结果为准。');
    $('computer-register').hidden = Boolean(entry);
    $('computer-configure').hidden = !entry;
    $('computer-prepare').disabled = busy || !ready || !hasTool('computer__prepare');
    $('computer-check').disabled = busy || !ready || !hasTool('computer__status');
    $('computer-capture').disabled = busy || !ready || !hasTool('computer__screenshot');
  }
  function point(clientX, clientY, rect, width, height) {
    if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height, width, height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
    const x = (clientX - rect.left) / rect.width, y = (clientY - rect.top) / rect.height;
    if (x < 0 || y < 0 || x >= 1 || y >= 1) return null;
    return { x: Math.min(width - 1, Math.floor(x * width)), y: Math.min(height - 1, Math.floor(y * height)) };
  }
  function screenshotView(result) {
    if (result?.isError) throw new Error((result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n').slice(0, 2000) || '截图未完成。');
    const image = result?.content?.find(item => item.type === 'image' && ['image/png', 'image/jpeg'].includes(item.mimeType) && typeof item.data === 'string' && item.data.length > 0 && item.data.length < 1700000 && /^[A-Za-z0-9+/]*={0,2}$/.test(item.data));
    if (!image) throw new Error('没有收到可显示的原生截图。请检查任务结果与系统权限。');
    const root = node('div'), img = node('img', 'result-image');
    img.alt = '本次明确请求返回的桌面截图';
    img.src = `data:${image.mimeType};base64,${image.data}`;
    img.addEventListener('pointermove', event => {
      const p = point(event.clientX, event.clientY, img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight);
      text('computer-coordinates', p ? `截图坐标：(${p.x}, ${p.y}) · 原图 ${img.naturalWidth} × ${img.naturalHeight} · 仅供核对` : '');
    });
    img.addEventListener('pointerleave', () => text('computer-coordinates', ''));
    img.addEventListener('error', () => text('computer-coordinates', '图片解码失败，请检查任务原始结果。'));
    root.append(img);
    const metadata = result.structuredContent ?? result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (metadata) root.append(rawDisclosure('截图元数据', metadata));
    return root;
  }
  function diagnosticView(result) {
    const value = decodedResult({ result });
    if (!value || typeof value !== 'object' || !('screenRecording' in value)) return resultView(value);
    const root = node('div');
    const ready = value.supported && value.backendReady && value.screenRecording === 'granted' && value.accessibility === 'granted';
    root.append(node('h3', '', ready ? '截图与键鼠操作条件已具备' : '请完成下列环境准备'));
    const permission = state => state === 'granted' ? '已授权' : state === 'not_granted' ? '未授权' : '尚无法确认';
    root.append(node('p', '', `平台支持：${value.supported ? '支持' : '不支持'} · 原生后端：${value.backendReady ? '可用' : '未就绪'}`));
    root.append(node('p', '', `屏幕录制：${permission(value.screenRecording)} · 辅助功能：${permission(value.accessibility)}`));
    if (value.message) root.append(node('p', 'form-note', value.message));
    root.append(rawDisclosure('完整诊断', value));
    return root;
  }
  async function run(kind) {
    if (!['prepare', 'status', 'screenshot'].includes(kind)) throw new Error('未知的桌面诊断操作。');
    if (busy) throw new Error('已有桌面诊断正在进行，请在任务记录中查看。');
    render();
    if (!state.online || state.authRequired || state.data?.metrics?.paused || !plugin()?.enabled) throw new Error('桌面能力尚未就绪。');
    const currentScope = scopeKey(), requestEpoch = ++epoch;
    busy = true;
    if (kind === 'screenshot') { $('computer-preview').replaceChildren(empty('正在请求截图', '可在任务记录中核对批准状态。')); text('computer-coordinates', ''); }
    render();
    try {
      const result = await submitTool(`computer__${kind}`, {}, { raw: true });
      // A cleared preview, switched workspace, pause or newer request wins over a late reply.
      if (requestEpoch !== epoch || currentScope !== scopeKey()) return;
      if (kind === 'screenshot') $('computer-preview').replaceChildren(screenshotView(result));
      else $('computer-diagnostics').replaceChildren(diagnosticView(result));
    } catch (error) {
      if (requestEpoch === epoch && currentScope === scopeKey()) {
        const target = kind === 'screenshot' ? 'computer-preview' : 'computer-diagnostics';
        $(target).replaceChildren(empty('这次诊断未完成', error.message));
      }
      throw error;
    } finally { busy = false; render(); }
  }
  async function register() {
    if (plugin()) return;
    await mutation('/api/plugins/install', { id: 'computer', module: 'builtin:computer', grants: [], config: { approvalMode: 'inherit' } }, '桌面插件已添加，保持停用且未授予权限。');
    render();
  }
  document.addEventListener('DOMContentLoaded', () => {
    wire('computer-register', 'click', register);
    wire('computer-configure', 'click', () => configurePlugin('computer'));
    wire('computer-prepare', 'click', () => run('prepare'));
    wire('computer-check', 'click', () => run('status'));
    wire('computer-capture', 'click', () => run('screenshot'));
    wire('computer-clear', 'click', clear);
    wire('computer-copy-prompt', 'click', () => copyText(prompt));
    render();
    // Only local state is inspected; no screenshot or native command is polled.
    const timer = setInterval(render, 2000);
    window.addEventListener('pagehide', () => { clearInterval(timer); clear(); }, { once: true });
  });
  return { render, clear, run, register, point, screenshotView, diagnosticView };
})();
