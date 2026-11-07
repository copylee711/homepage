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
  if (job?.state === 'running') { job.state = 'cancelled'; job.summary = '工具链操作已停止'; job.finishedAt = Date.now(); }
}
export async function toolchainStatus(user) {
  const job = jobs.get(user);
  if (job?.state === 'running') {
    await renewToolchain(user);
    return { catalog, installed: [], job: { state: job.state, id: job.id, action: job.action, version: job.version, output: '正在沙箱中安装，请保持此面板打开。关闭后租约将自动失效。' } };
  }
  const token = (await sandbox('/lease', user)).token;
  const data = await sandboxTool(token, { op: 'toolchain-list' });
  // The full output lives in a persistent workspace log; the panel only gets a one-line result.
  return { ...data, job: job ? { state: job.state, id: job.id, action: job.action, version: job.version, finishedAt: job.finishedAt, summary: job.summary, logPath: job.logPath } : null };
}
// Keep every run's full output as a workspace file the user can open and search later.
async function persistLog(job, text) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = '/workspace/.tools/logs', path = `${dir}/${stamp}-${job.action}-${job.id}.log`;
  const header = `# ${job.action === 'remove' ? '移除' : '安装'} ${job.id} ${job.version} · ${job.state === 'done' ? '成功' : '失败'} · ${new Date().toISOString()}\n\n`;
  try { await sandboxTool(job.token, { op: 'mkdir', path: dir }); await sandboxTool(job.token, { op: 'write', path, content: header + text }); job.logPath = path; } catch {}
}
function finish(job, state, text) {
  if (job.state !== 'running') return;
  job.state = state; job.finishedAt = Date.now();
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  job.summary = state === 'done' ? (lines.findLast?.(l => /success|installed|removed|完成|成功/i.test(l)) || '操作完成') : (lines[lines.length - 1] || '操作失败');
  return persistLog(job, String(text || ''));
}
export async function startToolchain(user, input) {
  if (!catalog.some(item => item.id === input.id) || !['install', 'remove'].includes(input.action) || !/^\d+\.\d+\.\d+[a-zA-Z0-9.-]*$/.test(input.version || '')) fail(422, '请选择工具和固定版本');
  if (toolchainBusy(user)) fail(409, '已有工具链任务正在运行');
  const job = { state: 'running', id: input.id, action: input.action, version: input.version, token: null };
  jobs.set(user, job);
  while (jobs.size > 32) {
    const old = [...jobs].find(([, value]) => value.state !== 'running');
    if (!old) break; jobs.delete(old[0]);
  }
  try { job.token = (await sandbox('/lease', user)).token; }
  catch (error) { job.state = 'failed'; job.summary = error.message; throw error; }
  void sandboxTool(job.token, { op: 'toolchain-change', id: input.id, version: input.version, action: input.action }, 620000)
    .then(value => finish(job, 'done', value.output || '操作完成'), error => finish(job, 'failed', error.message));
  return { ok: true, state: job.state };
}
