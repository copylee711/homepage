import { el, iconButton } from './dom.js';
import { get, post } from './api.js';

export async function openQuota(user, confirm) {
  const dialog = el('dialog', { class: 'dialog file-dialog', attrs: { 'aria-labelledby': 'quota-title' } });
  const title = el('h2', { text: user.name + ' · 沙箱配额', id: 'quota-title' });
  const close = iconButton('x', '关闭配额设置', 'icon-button');
  const status = el('p', { class: 'field-help', attrs: { role: 'status' } });
  const form = el('form');
  dialog.append(el('div', { class: 'dialog-heading' }, title, close), status, form);
  document.body.append(dialog);
  let pending = false;
  close.addEventListener('click', () => { if (!pending) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal(); status.textContent = '正在读取配额…';
  try {
    const data = await get('/api/quotas?user_id=' + encodeURIComponent(user.id));
    if (!dialog.open) return;
    const fields = {};
    for (const [key, label] of Object.entries({ disk_mib: '磁盘容量（MiB）', memory_mib: '内存（MiB）', cpus: 'CPU 核数', pids: '进程数量', timeout: '单条命令时限（秒）' })) {
      const [min, max] = data.ranges[key];
      const input = el('input', { type: 'number', value: String(data.quota[key]), attrs: { min, max, step: key === 'cpus' ? '.1' : '1', required: '' } });
      fields[key] = input;
      form.append(el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input));
    }
    status.textContent = (data.used_bytes == null ? '工作区尚未挂载。' : '已用约 ' + Math.ceil(data.used_bytes / 1048576) + ' MiB。') + ' 主机分配预算 ' + data.total_disk_budget_mib + ' MiB。缩容不会删除文件；容量不足会拒绝。';
    const save = el('button', { type: 'submit', class: 'btn btn-solid', text: '保存配额' });
    form.append(el('div', { class: 'dialog-actions' }, save));
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (pending) return;
      const quota = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, Number(input.value)]));
      if (quota.disk_mib < data.quota.disk_mib && !await confirm({ title: '缩小工作区磁盘？', body: '将离线检查和调整文件系统。已有数据无法容纳时会拒绝。请先等待该用户任务完成。', confirmLabel: '检查并缩容', tone: 'danger' })) return;
      pending = true; save.disabled = close.disabled = true; status.textContent = '正在检查并调整配额…';
      try { await post('/api/quotas/save', { user_id: user.id, quota }); Object.assign(data.quota, quota); status.textContent = '配额已保存，后续工具调用生效。'; }
      catch (error) { status.textContent = error.message; }
      finally { pending = false; save.disabled = close.disabled = false; }
    });
  } catch (error) { status.textContent = error.message; }
}
