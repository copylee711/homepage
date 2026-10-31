# Agent workspace behavior

Visual ownership is [DESIGN.md](../DESIGN.md); `web/style.css` consumes the canonical
Homepage tokens. Both settings dialogs reuse native dialog focus/keyboard behavior,
the same labels, form controls, button variants and inline live status feedback.

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
unprivileged networkless containers. `/workspace` persists, `/tmp` and background
processes do not. A task can run for at most 10 minutes; a command for at most 60 seconds.
Errors are text, never executable markup. Provider keys are never returned to browsers
or passed to tool containers. New task, cancellation, authorization and service failures
must remain distinguishable in feedback. Mobile dialogs scroll within the viewport;
Escape closes idle dialogs and focus returns to their trigger.


## Conversation and file workflows

- The sidebar groups pinned chats and recent dates, filters titles locally, and offers
  rename, pin/unpin, archive/unarchive and Markdown/JSON export. Metadata is server-side
  in `/data/chat-meta/<user hash>.json`; Pi history is preserved. Archive does not free
  storage quota. Export omits provider replay metadata and masks known service model keys.
- Menus support arrows/Home/End/Escape. Native dialogs keep focus; asynchronous mutations
  disable repeat submission, preserve entered values on error and announce outcomes.
- Retry resends the last user task; continue appends an explicit instruction. Neither
  silently replaces history. Tools and thinking are expandable, with real lifecycle states.
  Message/code copy operates only on the visible selected content.
- Streaming follows the bottom while the reader stays nearby; scrolling up pauses follow
  and exposes “回到最新”. A premature stream close is an error rather than a completed task.
- Workspace files are listed, previewed, uploaded and downloaded through the user's sandbox.
  Preview is UTF-8 text (first 64 KiB), including valid empty/truncated text. Stale responses
  cannot replace a more recently selected preview. Paths can be inserted into the composer.
  Upload cap is 256 KiB; duplicate uploads require explicit overwrite confirmation. Downloads
  over 1 MiB are rejected, never silently truncated. Browsing never cancels an active task;
  a busy sandbox reports that the reader should refresh later.
- Model connection settings remain admin-only; an execution grant exposes no provider keys.
  Failure to refresh identity disables execution and offers reload/sign-in recovery.
- Harmless theme/sidebar/panel preferences may be stored locally. Message text, provider keys
  and history are never written to localStorage. Opening/closing drawers, menus and messages
  is animated; repeated streaming deltas do not replay entry effects. Reduced motion disables
  nonessential transitions. Mobile panels remain within the viewport without page overflow.
