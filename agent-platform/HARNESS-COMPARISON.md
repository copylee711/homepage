# Harness comparison and Iris adaptation

Reviewed the local `D:/Projects/ZCode` implementation and the
[ZCode repository](https://github.com/zai-org/ZCode), especially
`packages/ui/src/v4/conversationAssistantWorkItems.ts` (adjacent tool groups) and
`packages/shared/src/zcode-protocol-v4/input-intent.ts` (running-task guidance).
The goal is useful browser behavior in Iris's existing isolated architecture.

| Capability | Iris implementation |
| --- | --- |
| Ordered assistant work | Sequence-scoped live blocks; canonical final-message reconciliation; only adjacent tools grouped; original branch history survives model compaction |
| Running task guidance | `steer` RPC, composer accepts supplemental instructions while a task runs |
| User decisions | Structured `ask_user`, recommended options and free text, one-time user/thread-bound replies |
| Plan progress | `update_plan` with a live plan card |
| Approval policy | Read tools bypass approval; ask/edit/auto modes; changes take effect before subsequent tools, including pending approvals |
| Background work | Dedicated bounded containers, logs, stop, TTL and private opaque-origin HTTP previews |
| Persona and memory | Per-account persona/global memory and per-primary-project memory, server persistence and edit UI |
| Context management | Pi native token/context statistics, automatic compaction toggle and manual compaction |
| Skills | Three built-in Markdown skills enabled by default, personal skill configuration, explicit Pi skill loading |
| MCP | Remote HTTPS Streamable HTTP tools with JSON/SSE replies, bearer configuration, discovery/test UI and tool approval integration |
| Web search | Iris-owned free engines, authenticated JSON APIs, DeepSeek preset, custom templates/mappings and fallback ordering |
| Long conversation navigation | User-turn marks with summaries and direct jumps |

Desktop-host automation, arbitrary host stdio MCP processes, automatic OAuth
registration and terminal-rendered third-party extension UIs are separate
capabilities. Iris does not execute arbitrary npm extension JavaScript beside its
model credentials. The resource marketplace explicitly loads verified Markdown;
browser-adapted native capabilities have their own working settings panels.

Search references:
[dsh-free-search](https://github.com/copylee711/dsh-free-search),
[upstream](https://github.com/DDDMUC/dsh-free-search), and
[DeepSeek Search API](https://api-docs.deepseek.com/zh-cn/guides/search/).
