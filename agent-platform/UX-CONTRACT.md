# Agent workspace behavior

Iris visual tokens are owned by `web/src/styles/tokens.css`; shared controls live in
`web/src/components`. Dialogs use the shared focus helper and application-owned
confirmation flow, with the same labels, buttons and inline status feedback.

## Authorization

| Account | Own conversations and sandbox | Provider settings/test | User grants |
| --- | --- | --- | --- |
| Anonymous or invalid parent session | Denied | Denied | Denied |
| Ordinary, no active grant | Denied | Denied | Denied |
| Ordinary, active grant and rollout enabled | Allowed | Denied | Denied |
| Administrator | Allowed | Allowed | Allowed |

The backend is authoritative on every request. Management controls are hidden for
ordinary accounts; disabled composer controls explain missing execution permission.
Execution permission never implies administrator or provider access. Disabled accounts
and expired/revoked parent sessions cannot use an execution grant.

## User grants

- Admin opens “用户执行授权” from the sidebar. Account search filters the loaded
  recent 500 accounts locally by name/email; no results has an explicit message.
- Choose 1, 7 or 30 days and grant/renew. Pending requests disable mutation controls;
  success reloads authoritative state and announces the result. Failures retain the
  list and offer refresh. Dates render in the browser's local time with Chinese labels.
- Revoke removes execution permission and actively cancels the user's work. Conversation
  and workspace files remain; regrant is the recovery action. This is not account deletion.
- Rollout disabled permits review/revoke but blocks new grants server-side and in the UI.
- The stream rechecks identity every 5 seconds. Lost renewal expires the sandbox lease
  within 20 seconds, including when the gateway/runner/account service fails.

## Sandboxes

Each user has a distinct bounded persistent workspace. Tool calls run in disposable,
unprivileged containers on an internal network. Public HTTP(S) uses an IP-validated
egress proxy; host/private/metadata and direct access are blocked. `/workspace`
persists, `/tmp` and background processes do not. A task runs at most 10 minutes;
per-user command, memory, CPU, process and disk quotas are administered separately.
Errors are text, never executable markup. Provider keys are never returned to browsers
or passed to tool containers. New task, cancellation, authorization and service failures
must remain distinguishable in feedback. Mobile dialogs scroll within the viewport;
Escape closes idle dialogs and focus returns to their trigger.


## Conversation and file workflows

- Read-only conversation snapshots use Pi's canonical branch/compaction projection
  and never start a model process. Server snapshots invalidate on file version changes.
  Recent chats and the root workspace listing preload after authentication; bounded
  memory caches render immediately then refresh, with no conversation localStorage.
  Workspace server read snapshots last at most 2 seconds and invalidate on mutations
  and model task boundaries. Active model reads bypass the snapshot cache.
- Workspace right-click/Shift+F10 and a visible menu provide new file/folder,
  text editing, move/rename and delete. Deletion requires confirmation and directories
  must be empty. Paths remain tenant-rooted; destination overwrite is refused.
  The UTF-8 editor accepts at most 256 KiB, has Ctrl/Cmd+S and unsaved-change confirmation.
  Saves check a SHA-256 revision and atomically replace only an unchanged file.
- Admins manage Pi package text resources at fixed versions. Catalog content is
  escaped text. Downloads verify SHA-512 and have archive/file/size bounds; package
  code, dependencies, scripts, themes and JS/TS extensions are not executed.
- Authorized users manage their own optional toolchain versions in `.tools`.
  Install jobs are mutually exclusive with their model work and require continuing
  authorized polling to renew a 20-second lease. Closing a running job asks to stop.
  Administrators assign quotas from each user's grant row; quota editing does not
  change grants. Disk resizing requires idle tools, checks existing data, refuses
  unsafe shrinking and never deletes files to meet the new limit.

- The sidebar groups pinned chats and recent dates, filters titles locally, and offers
  rename, pin/unpin, archive/unarchive and Markdown/JSON export. Metadata is server-side
  in `/data/chat-meta/<user hash>.json`; Pi history is preserved. Archive does not free
  storage quota. Export omits provider replay metadata and masks known service model keys.
- Both sidebar and header menus offer permanent deletion with explicit confirmation.
  Deletion removes that owned JSONL, its cwd backup and metadata, releases history quota
  and clears snapshots; workspace files remain. Active generation must stop first.
- Menus support arrows/Home/End/Escape. Native dialogs keep focus; asynchronous mutations
  disable repeat submission, preserve entered values on error and announce outcomes.
- Retry/rewind explicitly return to a selected user turn in a linear, uncompacted history.
  The server atomically replaces the suffix after writing an owned `.rewind-backup`.
  Compacted/branched histories reject this operation; failure leaves the UI and server
  history intact. Fork creates a new UUID without overwriting an existing conversation.
  Continue appends an instruction. Tools and thinking expose real lifecycle states.
  Message/code copy operates only on the visible selected content.
- Streaming follows the bottom while the reader stays nearby; scrolling up pauses follow
  and exposes “回到最新”. The end gap (scroll padding / padding-bottom) includes any
  overlap of the composer stack, so “at bottom” means the latest text sits fully above
  that chrome and the jump control hides once it does. A click scrolls to that same end.
  The project/branch row is part of the composer stack, not an overlay on the transcript.
  Hiding the tab does not cancel an in-flight prompt; only the stop control does.
  A premature stream close is an error rather than a completed task.
- Workspace files are listed, previewed, uploaded and downloaded through the user's sandbox.
  Preview is UTF-8 text (first 64 KiB), including valid empty/truncated text. Stale responses
  cannot replace a more recently selected preview. Paths can be inserted into the composer.
  Text editor uploads are limited to 256 KiB. Composer attachments accept binary/base64
  files up to 15 MiB, use unique filenames under the selected project's `uploads/`, and
  never silently overwrite another attachment. Downloads
  over 15 MiB are rejected, never silently truncated. Browsing never cancels an active task;
  a busy sandbox reports that the reader should refresh later.
- Model connection settings remain admin-only; an execution grant exposes no provider keys.
  Failure to refresh identity disables execution and offers reload/sign-in recovery.
- Harmless theme/sidebar/panel preferences may be stored locally. Message text, provider keys
  and history are never written to localStorage. Opening/closing drawers, menus and messages
  is animated; repeated streaming deltas do not replay entry effects. Reduced motion disables
  nonessential transitions. Mobile panels remain within the viewport without page overflow.

## Projects and workspace display

- A new conversation binds its primary project and Agent access scope with the first
  prompt. Subsequent prompts cannot change that binding. The owner can update access
  while idle; cached Pi processes are restarted so the next turn receives the new lease.
- Project-only leases mount only the primary directory. Scoped leases additionally
  mount chosen projects read-only/read-write; Linux enforces this for Bash as well as
  file tools. Full scope mounts the owner's entire workspace. Owner-operated file and
  terminal panels retain access to the owner's workspace; these are separate from Agent scope.
- Project scope is managed only in the upper project menu: primary project, subordinate
  read/write grants and the explicit whole-workspace option. “添加从属项目” always opens
  the shared selection dialog, including when there is only one candidate. The old
  duplicate advanced project/permissions dialog is removed.
- The lower execution menu selects “需要审批” (default), “允许编辑” or “自动执行”.
  Explicitly read-only native tools (file read/list/search, web search/fetch, memory
  read, background status), user questions and plan updates bypass approval. Edit
  mode also permits file writes/edits and memory updates; Bash, background starts
  and remote MCP tools still require approval. Auto mode permits tools within the
  same OS-enforced project scope. Runtime mode changes apply to the next tool and
  release pending operations that the new mode permits. Scope changes remain idle-only.
  Pending approval IDs are bound to a live user/thread, are one-time, expire after
  120 seconds and fail closed on cancellation. Unknown tools require approval.
- Deleting a project requires removing associated conversations first and preserves files.
  Existing root-level files remain in place and can be managed from the owner's file panel
  or accessed by an explicitly full-scope Agent. They are not silently moved into `default`.
- The eye button toggles dotfiles/directories such as `.git` and `.env`, off by default.
  Only this harmless display preference is stored locally; hiding does not change access.
- Workspace controls occupy a separate row above full-width, horizontally scrollable
  breadcrumbs. The current directory scrolls into view and full paths are available by title.
- Welcome entry fades without translating the outer scroll surface. Symmetric scrollbar
  gutters keep the welcome content centered when overflow changes.
- The terminal executes one bounded command per request (15 seconds); it is not an
  interactive persistent shell. Agent/toolchain tasks must be idle before terminal or Git writes.

## Streaming and conversation navigation

- Each model message has its own content-index namespace. Final assistant message
  snapshots reconcile missing deltas. Text/thinking/tool order is preserved in
  live views and replay. Groups include adjacent tools only, across consecutive
  assistant messages in the same user turn; intervening text splits groups.
  A multi-operation group stays open while any child is running or pending, and
  collapses once every child has succeeded or failed. Reopening that settled
  group pins it open until the reader collapses it or a child runs again.
- Thinking preview follows the newest lines until the reader scrolls upward.
  Parent conversation follow also pauses on manual scrolling. User timestamps
  appear below their message bubbles.
- The user-turn navigator exposes an accessible button per user message, a text
  summary, current-turn state, keyboard arrows/Home/End and direct scrolling.
  It is contained within the conversation pane, including on mobile.
- Sidebar scrolling uses a short, faint rail with drag and keyboard support.
  Forced-colors mode restores native scrollbar behavior. The original scroll
  surface remains the keyboard and touch scroll target.
- Unauthorized accounts see a centered access notice and account settings; no
  unusable composer/model controls or misleading send-first-message instructions.
- Workspace upload accepts any file type as exact base64-framed bytes, up to
  15 MiB. Text editing remains UTF-8 only and 256 KiB. Other formats are downloadable;
  supported image previews remain bounded to 1 MiB. Filenames do not restrict type.

## Personal settings and tools

- Persona/global/project memory lives outside user tool mounts. Only the active
  primary project's memory is injected. Writes are atomic and revision-checked;
  account and project isolation is authoritative on the server. Agent writes use
  the same execution policy as other persistent changes. Memory supplements,
  never replaces, higher-priority system and isolation instructions.
- `ask_user` is independent of execution approval. No option is submitted merely
  because it is marked recommended. Users can choose an option or type an answer.
  Replies are one-time, user/thread-bound, and cancelled on task end.
- Search settings are per account: source enable/order, preferred engine, proxy
  toggle, language/count and custom HTTPS JSON request/mapping configuration.
  Secret fields are masked, empty preserves saved values, endpoint change clears
  previous secrets, and keys never enter model tools or public settings responses.
  API redirects are refused; DNS and destination IP checks pin public connections.
- Capability settings load built-in and personal Markdown skills explicitly,
  expose native Pi context statistics/compaction, and adapt remote MCP tool discovery
  and execution to the browser. Remote MCP credentials remain server-only; tools
  integrate with the same approval flow. Arbitrary host executable plugins are
  not loaded. Configuration saves require idle tasks and invalidate cached Pi instances.
- Background tasks use distinct non-root containers with current project mounts,
  memory/CPU/PID limits, bounded logs and no published host ports. Maximum two per
  user, four globally and one hour each. Ordinary task cancellation preserves them;
  explicit stop, scope revocation, expiry and broker restart terminate them. Scope
  changes stop old containers before applying a new grant set.
- Preview URLs are random, temporary task capabilities. They work without SSO
  cookies for module loading, but every active document receives CSP `sandbox`
  without `allow-same-origin`; preview code cannot read Iris storage or authenticated
  API responses. Preview HTTP is bounded to 2 MiB per resource; WebSocket forwarding
  is not supported and the UI says to refresh after code changes.
- Settings with draft edits warn before navigation; cancellation preserves fields.
  Secrets and personal text are never persisted in browser storage.
