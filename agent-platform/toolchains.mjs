import { readFile } from 'node:fs/promises';
import { sandbox, sandboxTool } from './sandbox-client.mjs';
import { fail } from './shared.mjs';
const catalog = JSON.parse(await readFile(new URL('./toolchains.json', import.meta.url), 'utf8'));
const jobs = new Map();
export function toolchainBusy(user) { return jobs.get(user)?.state === 'running'; }
export async function renewToolchain(user) {
  const job = jobs.get(user);
  if (job?.state === 'running' && job.token) await sandbox('/renew', user, job.token);
}
export function cancelToolchain(user) {
  const job = jobs.get(user);
  if (job?.state === 'running') { job.state = 'cancelled'; job.output = '工具链操作已停止'; }
}
export async function toolchainStatus(user) {
  const job = jobs.get(user);
  if (job?.state === 'running') {
    await renewToolchain(user);
    return { catalog, installed: [], job: { state: job.state, id: job.id, output: '正在沙箱中安装，请保持此面板打开。关闭后租约将自动失效。' } };
  }
  const token = (await sandbox('/lease', user)).token;
  const data = await sandboxTool(token, { op: 'toolchain-list' });
  return { ...data, job: job ? { state: job.state, id: job.id, output: job.output } : null };
}
export async function startToolchain(user, input) {
  if (!catalog.some(item => item.id === input.id) || !['install', 'remove'].includes(input.action) || !/^\d+\.\d+\.\d+[a-zA-Z0-9.-]*$/.test(input.version || '')) fail(422, '请选择工具和固定版本');
  if (toolchainBusy(user)) fail(409, '已有工具链任务正在运行');
  const job = { state: 'running', id: input.id, output: '', token: null };
  jobs.set(user, job);
  while (jobs.size > 32) {
    const old = [...jobs].find(([, value]) => value.state !== 'running');
    if (!old) break; jobs.delete(old[0]);
  }
  try { job.token = (await sandbox('/lease', user)).token; }
  catch (error) { job.state = 'failed'; job.output = error.message; throw error; }
  void sandboxTool(job.token, { op: 'toolchain-change', id: input.id, version: input.version, action: input.action }, 620000)
    .then(value => { if (job.state === 'running') { job.state = 'done'; job.output = value.output || '操作完成'; } }, error => { if (job.state === 'running') { job.state = 'failed'; job.output = error.message; } });
  return { ok: true, state: job.state };
}
