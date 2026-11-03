/**
 * Install/build commands that can outlast one sandbox bash slot.
 * The agent chooses background execution; bash refuses these shapes so the
 * turn is not blocked inside the per-call container (which is removed when
 * the tool returns). Short commands stay on bash.
 */

const SPLIT = /&&|\|\||\n|;|\|/;
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/;
const INSTALLERS = [
  /^(?:python3|python|py)\s+-m\s+pip\s+install(?:\s|$)/,
  /^pip3?\s+install(?:\s|$)/,
  /^uv\s+pip\s+install(?:\s|$)/,
  /^poetry\s+install(?:\s|$)/,
  /^pipx\s+install(?:\s|$)/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|update)(?:\s|$)/,
  /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:build|compile)(?:\s|$)/,
  /^cargo\s+(?:build|install|fetch)(?:\s|$)/,
  /^go\s+build(?:\s|$)/,
  /^go\s+install(?:\s|$)/,
  /^go\s+mod\s+download(?:\s|$)/,
  /^(?:mvn|gradle)\s+(?:package|install|build|assemble)(?:\s|$)/,
];

function commandHead(segment) {
  let text = String(segment || '').trim();
  while (ENV_PREFIX.test(text)) text = text.replace(ENV_PREFIX, '');
  return text.trim();
}

export function prefersBackgroundInstall(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 20000) return false;
  return command.split(SPLIT).some(segment => {
    const head = commandHead(segment).toLowerCase();
    return INSTALLERS.some(pattern => pattern.test(head));
  });
}

/** Broker stores this so explicit abort can stop installs without stopping preview servers. */
export function taskPurpose(command, requested) {
  if (requested != null && requested !== '' && requested !== 'server' && requested !== 'install') {
    throw Object.assign(new Error('后台任务类型无效'), { status: 422 });
  }
  if (prefersBackgroundInstall(command)) return 'install';
  return requested === 'install' ? 'install' : 'server';
}

export const INSTALL_REDIRECT =
  '未执行该命令。pip/npm/pnpm/yarn/bun/cargo/go/mvn/gradle 这类安装或构建可能超过单次命令时限，不能用 bash 阻塞回合。' +
  '请改用 background_start，purpose 设为 install，不要设置 port。命令在既有隔离后台容器中运行（每用户 2 个、全局 4 个、最长 1 小时，出口、内存和配额与预览任务相同）。' +
  '若还有其他有用的工作，先去做。若暂时无事可做，调用 background_wait 暂停当前回合，任务结束后会带着状态和日志继续。';

export const INSTALL_GUIDANCE =
  'Package installs and builds that can outlast a single bash call must not use bash: pip/pip3/python -m pip install, uv pip install, poetry install, pipx install, npm/pnpm/yarn/bun install|ci|add|update, npm/pnpm/yarn/bun run build|compile, cargo build|install|fetch, go build|install, go mod download, mvn/gradle package|install|build|assemble. ' +
  'Call background_start with purpose "install" and no port. The host runs it in the existing background-task sandbox (same isolation, egress proxy, memory budget, 2 per user, 4 global, 1 hour). Do not claim the install finished until background_status or background_wait reports a non-running state. ' +
  'Keep working on other useful steps while it runs. If nothing else is useful, call background_wait to pause this turn; when the task exits the tool returns and you continue. ' +
  'Ordinary bash background processes (&, nohup, setsid) still die when the tool container is removed. Use purpose "server" only for long-running preview servers. ' +
  'Explicit stop, revoked execution, logout, lease expiry and the turn deadline stop in-flight install tasks. They do not stop purpose "server" previews.';
