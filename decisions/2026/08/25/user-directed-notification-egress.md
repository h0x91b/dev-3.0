# Notification hooks read a file the RPC layer never writes

## Context

Task notifications reach two destinations, and both need a live listener:
`postNativeTaskNotification` wants the desktop in front of you, `pushWebNotification` wants
an open browser tab. Close the lid and the event is gone — precisely when an agent blocking
on a question is most expensive. A third destination that survives having no listener has to
name a command or a URL, which is configuration of a different kind from a UI preference.

## Investigation

`saveSettings` is reachable from the RPC surface (`src/bun/rpc-handlers/settings-config.ts`,
`app-handlers.ts`), and `dev3 remote` serves that same RPC to any authenticated browser
session. Putting an `exec` transport in `GlobalSettings` would therefore let a session plant
a command that dev-3.0 re-executes on every future notification: not a new capability for a
session that already has `/pty`, but a persistent and invisible one that outlives it.

## Decision

Config lives in `$DEV3_HOME/notifications.json`, read by `loadNotificationConfig`
(`src/bun/notification-transports.ts`) and never written by `saveSettings`. Absent, malformed
or empty, the whole path is inert — there is no default endpoint. `outboundNotify` is called
at the end of `deliverTaskNotification` (`src/bun/rpc-handlers/shared.ts`), after the
`isProjectSilenced` and `isNotificationSuppressed` gates, so a muted project stays muted.
Commands are argv-only and the payload goes over stdin, because a task title is
user-authored and must never reach a shell parser.

## Risks

A hook is still arbitrary code run by dev-3.0, so a compromised home directory can execute
commands — the same as any dotfile, and unreachable from the remote RPC surface, which is the
threat this guards. Delivery is best-effort: a hook that is down misses the event, and the
app's reconcile-on-open covers the gap. Content is sent by default, so a user who points a
transport at a channel they do not control (a public ntfy topic) publishes task titles;
`includeContent: false` is settable per transport for exactly that case.

## Alternatives considered

`GlobalSettings` with a UI editor — idiomatic and discoverable, rejected for the RPC exposure
above. Redacting content by default — safe, but `#42 needs you` cannot be triaged without
opening the app, which is the cost the notification exists to avoid; exposure is a property
of the transport (a local command, an own webhook, and an RFC 8291-encrypted Web Push payload
are all private) and belongs on the transport. A built-in ntfy/Telegram client — one more
vendor to track and a default endpoint dev-3.0 would own.
