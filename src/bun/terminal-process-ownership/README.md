# Terminal process & port ownership (seq 1293)

One backend-neutral answer to *"which processes does this terminal session own,
how much do they cost, and which ports do they listen on?"* — for tmux sessions
and native sessions alike.

This is the safety/observability gate that must exist **before** the native
backend becomes a normal product backend: today's resource and port accounting is
written against tmux pane PIDs, so a native session would simply be invisible to
it.

## Shape

```
claim (per backend)                 →   snapshot (backend-neutral)
────────────────────────────────────    ─────────────────────────────────────
tmux-source.ts   pane PIDs from the      collector.ts  roots + descendants,
                 live tmux server                      aggregated cost,
native-source.ts host/shell PIDs from                  listening ports,
                 the session record                    measured coverage
                 + ownership verdict
```

* `contract.ts` — pure vocabulary: `TerminalOwnershipClaim`, `TerminalOwnership`,
  proof helpers. No spawns, no clock, no tmux, no registry.
* `collector.ts` — the adapter over the app's **existing** scanners
  (`collectProcessInfo` for the shared `ps` snapshot, `aggregateResources`,
  `getLsofOutput` + `parseLsofOutput`). There is no second monitoring subsystem:
  this module only decides *which* PIDs those scanners may attribute.
* `tmux-source.ts` — the only file here that speaks tmux, via the existing
  pane-PID helpers (typed tmux client singleton; no raw spawn, no `-F` format).
* `native-source.ts` — translates the native session record + ownership verdict.
  Standalone by contract: it declares plain input types instead of importing the
  native session store, whose isolation test forbids outside references.

## Ownership is proved, never assumed

A claim carries a proof. Anything short of a proof becomes an explicit state with
a reason, and **nothing** is attributed:

| state         | when                                                            |
| ------------- | --------------------------------------------------------------- |
| `owned`       | tmux reported the pane, or the record's PIDs verified as `owned` |
| `stale`       | the recorded host/shell process has exited (`dead` verdict)      |
| `reused`      | a recorded PID is alive but is no longer our process             |
| `unavailable` | no record, no verdict, foreign record, or no usable PID          |

An unproved claim short-circuits `collectOwnershipSnapshot` — no `ps`, no `lsof`,
and on the native path never a tmux call.

`coverage` reports what could actually be measured. On Windows both scanners are
absent (they shell out to `ps` / `lsof`), so `descendants`/`resources`/`ports` are
`false` while ownership itself still verifies through Job Object membership — the
snapshot says "not measured", never "nothing there".

## Scope

Read-only accounting. No launch/attach/resize/stop, no backend selection or
fallback, no process signalling, no UI or RPC, and no changes to the existing
tmux pollers — this task owns the adapter and its tests only.
