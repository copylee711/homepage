/** The ONLY tools registered in RPC mode. Every filesystem/shell operation is remote. */
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createBashToolDefinition } from '@earendil-works/pi-coding-agent';

export default function (pi) {
  const url = process.env.SANDBOX_URL;
  const token = process.env.SANDBOX_LEASE;
  if (!url || !token) throw new Error('Sandbox lease required');
  async function call(op, fields = {}, signal?) {
    const response = await fetch(url + '/tool', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ op, ...fields }), signal: signal || AbortSignal.timeout(80000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sandbox unavailable');
    return result;
  }
  const readFile = async path => Buffer.from((await call('read', { path })).data, 'base64');
  const access = async path => { await call('access', { path }); };
  const writeFile = async (path, content) => { await call('write', { path, content }); };
  const cwd = '/workspace';
  pi.registerTool(createReadToolDefinition(cwd, { operations: { readFile, access,
    detectImageMimeType: async () => null } }));
  pi.registerTool(createWriteToolDefinition(cwd, { operations: { writeFile,
    mkdir: async path => { await call('mkdir', { path }); } } }));
  pi.registerTool(createEditToolDefinition(cwd, { operations: { readFile, writeFile, access } }));
  pi.registerTool(createBashToolDefinition(cwd, { exposeSessionEnvironment: false, operations: {
    exec: async (command, _cwd, { onData, signal, timeout }) => {
      const result = await call('bash', { command, timeout }, signal);
      onData(Buffer.from(result.output)); return { exitCode: result.exitCode };
    },
  } }));
  pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt +
    '\nAll tools run in your private Linux sandbox at /workspace. Network is disabled. ' +
    'Workspace capacity is 256 MiB; each command is limited to 60 seconds. ' +
    'Files in /workspace persist; /tmp and background processes do not survive tool calls. ' +
    'The model service and credentials are outside this sandbox.' }));
}
