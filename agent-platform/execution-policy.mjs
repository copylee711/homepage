// Only explicitly read-only tools bypass approval. Bash is never classified by
// command text: substitutions, redirections and scripts make that unsound.
export const READ_ONLY_TOOLS = new Set(['read', 'list_directory', 'search_files', 'web_fetch', 'web_search', 'image_search', 'set_chat_title', 'ask_user', 'update_plan', 'memory_read', 'background_status', 'knowledge_search']);
export const EXECUTION_MODES = ['ask', 'edit', 'auto', 'plan'];
export function requiresApproval(mode, tool) { return mode !== 'auto' && !READ_ONLY_TOOLS.has(tool) && !(mode === 'edit' && ['write', 'edit', 'memory_update'].includes(tool)); }
// Plan mode is read-only exploration: anything that changes state is refused outright.
export function blockedInPlan(mode, tool) { return mode === 'plan' && !READ_ONLY_TOOLS.has(tool) && !tool.startsWith('mcp_'); }
