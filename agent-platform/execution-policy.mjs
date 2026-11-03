// Only explicitly read-only tools bypass approval. Bash is never classified by
// command text: substitutions, redirections and scripts make that unsound.
export const READ_ONLY_TOOLS = new Set(['read', 'list_directory', 'search_files', 'web_fetch', 'web_search', 'image_search', 'set_chat_title', 'ask_user', 'update_plan', 'memory_read', 'background_status']);
export function requiresApproval(mode, tool) { return mode !== 'auto' && !READ_ONLY_TOOLS.has(tool) && !(mode === 'edit' && ['write', 'edit', 'memory_update'].includes(tool)); }
