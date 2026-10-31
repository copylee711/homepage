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
