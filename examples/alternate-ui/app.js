const element = id => document.getElementById(id);
const statusNames = { preparing: '准备中', awaiting_approval: '等待本机确认', queued: '排队中', running: '正在执行', succeeded: '已完成', failed: '未完成', denied: '已拒绝', cancelled: '已取消', interrupted: '已中断' };
let loading = false;

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'X-Capyra-Local': '1', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `请求失败 (${response.status})`);
  return body;
}
function setStatus(message, failed = false) {
  element('connection').textContent = message;
  element('connection').classList.toggle('error', failed);
}
function textCell(row, value) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); return cell; }
async function detail(task) {
  try {
    const data = await request(`/api/tasks/${encodeURIComponent(task.id)}`);
    element('detail-title').textContent = task.tool;
    // 使用 textContent 展示模型结果及文件内容，避免把不可信结果解释为 HTML。
    element('detail').textContent = JSON.stringify(data, null, 2);
    element('detail-panel').hidden = false;
    element('detail').focus();
  } catch (error) { setStatus(error.message, true); }
}
async function refresh() {
  if (loading) return;
  loading = true; element('refresh').disabled = true;
  try {
    const state = await request('/api/state');
    element('running').textContent = state.metrics.runningTasks;
    element('memory').textContent = `${(state.metrics.rssBytes / 1024 / 1024).toFixed(1)} MB`;
    element('plugins').textContent = state.metrics.pluginCount;
    element('uptime').textContent = state.metrics.uptimeSeconds >= 60 ? `${Math.floor(state.metrics.uptimeSeconds / 60)} 分钟` : `${state.metrics.uptimeSeconds} 秒`;
    element('workspace').textContent = state.config.workspace;
    element('task-count').textContent = `${state.tasks.length} 项`;
    element('empty').hidden = state.tasks.length > 0;
    const rows = document.createDocumentFragment();
    for (const task of state.tasks) {
      const row = document.createElement('tr');
      textCell(row, task.tool);
      const status = textCell(row, statusNames[task.status] ?? task.status); status.dataset.status = task.status;
      textCell(row, new Date(task.updatedAt).toLocaleString());
      const cell = document.createElement('td'); const button = document.createElement('button'); button.type = 'button'; button.textContent = '查看'; button.setAttribute('aria-label', `查看 ${task.tool} 的任务详情`); button.addEventListener('click', () => detail(task)); cell.append(button); row.append(cell); rows.append(row);
    }
    element('tasks').replaceChildren(rows);
    setStatus(`${state.metrics.paused ? '本机访问已暂停' : '本机服务已连接'} · 更新于 ${new Date().toLocaleTimeString()}`);
  } catch (error) { setStatus(error.message, true); }
  finally { loading = false; element('refresh').disabled = false; }
}
element('refresh').addEventListener('click', refresh);
element('close-detail').addEventListener('click', () => { element('detail-panel').hidden = true; element('refresh').focus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') element('detail-panel').hidden = true; });

async function start() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const nonce = fragment.get('bootstrap');
  // 一次性随机数只存在启动链接的 fragment；兑换后立即移除，登录状态由 HttpOnly cookie 保存。
  if (nonce) {
    history.replaceState(null, '', location.pathname + location.search);
    try { await request('/api/bootstrap', { method: 'POST', body: JSON.stringify({ nonce }) }); }
    catch (error) { setStatus(error.message, true); return; }
  }
  await refresh();
}
void start();
