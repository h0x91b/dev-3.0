# Scenario → roadmap map (MIG-001)

Each backend-neutral parity scenario and the tmux-removal roadmap items
(seq 1141 `plan.md`) it protects. The authoritative source is the `protects`
field on every scenario in [`corpus.ts`](./corpus.ts); `corpus.test.ts` fails if
this file drifts from it.

Legend — **Parity:** `required` (native must match) / `intent-diff` (native may
differ; the tmux behavior is a quirk). **Verify:** `live` (real tmux via
TmuxClient) / `pure` (product pure helper) / `gap` (documented, not driven here).

| Scenario | Verb | Parity | Verify | Protects |
|---|---|---|---|---|
| `create.session-cwd-env` | create | required | live | INT-001, INT-004, MIG-004 |
| `create.stable-logical-id` | create | required | live | MIG-003, LAY-003, INT-001 |
| `attach.read-current-and-subsequent-output` | attach | required | live | INT-001, INT-002, HOST-005 |
| `attach.missing-session-is-clean` | attach (neg) | required | live | MIG-006, INT-005 |
| `attach.duplicate-attach-does-not-disrupt` | attach (neg) | intent-diff | gap | HOST-004, HOST-005 |
| `input.keys-reach-process` | input | required | live | INT-002, INT-005, HOST-005 |
| `resize.min-across-clients` | resize | intent-diff | pure | HOST-005, LAY-005, LAY-007 |
| `resize.invalid-is-ignored` | resize (neg) | required | pure | HOST-005, LAY-007 |
| `split.adds-second-view` | split | required | live | LAY-004, INT-001, INT-002, MIG-004 |
| `focus.exactly-one-active-view` | focus | required | live | LAY-004, LAY-005, INT-002 |
| `capture.content-and-ordering` | capture | required | live | STATE-008, INT-002, INT-007 |
| `capture.dead-view-is-clean` | capture (neg) | required | live | INT-003, STATE-008 |
| `reconnect.session-survives-detach` | reconnect | required | live | HOST-006, LAY-003, STATE-006, INT-001 |
| `high-output.lossless-ordered` | high-output | required | live | STATE-006, STATE-007, INT-002 |
| `exit.process-exit-ends-view` | exit | required | live | INT-003, INT-007, STATE-008 |
| `exit.status-code-propagates` | exit | required | gap | INT-003, INT-007 |
| `cleanup.removes-session` | cleanup | required | live | INT-003, MIG-006, CUT-004 |
| `cleanup.reaps-owned-process-tree` | cleanup | required | gap | INT-003, INT-007, MIG-006 |
| `cleanup.retry-is-idempotent` | cleanup (neg) | required | live | INT-003, MIG-006 |

## Reverse index — which scenarios guard each roadmap item

- **MIG-003** (backend identity as backward-compatible data): `create.stable-logical-id`
- **MIG-004** (native creation opt-in, single owner): `create.session-cwd-env`, `split.adds-second-view`
- **MIG-006** (tmux failure isolation): `attach.missing-session-is-clean`, `cleanup.removes-session`, `cleanup.reaps-owned-process-tree`, `cleanup.retry-is-idempotent`
- **HOST-004** (no duplicate hosts/attaches): `attach.duplicate-attach-does-not-disrupt`
- **HOST-005** (multi-client, one writer): `attach.read-current-and-subsequent-output`, `attach.duplicate-attach-does-not-disrupt`, `input.keys-reach-process`, `resize.min-across-clients`, `resize.invalid-is-ignored`
- **HOST-006** (survive restart/reconnect): `reconnect.session-survives-detach`
- **LAY-003** (logical view ids across remounts): `create.stable-logical-id`, `reconnect.session-survives-detach`
- **LAY-004** (layout behavior): `split.adds-second-view`, `focus.exactly-one-active-view`
- **LAY-005** (shared vs client-local state): `focus.exactly-one-active-view`, `resize.min-across-clients`
- **LAY-007** (multi-surface rendering): `resize.min-across-clients`, `resize.invalid-is-ignored`
- **STATE-006** (stream resync): `reconnect.session-survives-detach`, `high-output.lossless-ordered`
- **STATE-007** (backpressure/memory budgets): `high-output.lossless-ordered`
- **STATE-008** (restore terminal features — capture/search): `capture.content-and-ordering`, `capture.dead-view-is-clean`, `exit.process-exit-ends-view`
- **INT-001** (task/project/variant terminals): `create.session-cwd-env`, `create.stable-logical-id`, `attach.read-current-and-subsequent-output`, `split.adds-second-view`, `reconnect.session-survives-detach`
- **INT-002** (agent control plane): `attach.read-current-and-subsequent-output`, `input.keys-reach-process`, `split.adds-second-view`, `focus.exactly-one-active-view`, `capture.content-and-ordering`, `high-output.lossless-ordered`
- **INT-003** (lifecycle cleanup): `capture.dead-view-is-clean`, `exit.process-exit-ends-view`, `exit.status-code-propagates`, `cleanup.removes-session`, `cleanup.reaps-owned-process-tree`, `cleanup.retry-is-idempotent`
- **INT-004** (project scripts/dev servers): `create.session-cwd-env`
- **INT-005** (CLI lifecycle): `attach.missing-session-is-clean`, `input.keys-reach-process`
- **INT-007** (process tools): `capture.content-and-ordering`, `exit.process-exit-ends-view`, `exit.status-code-propagates`, `cleanup.reaps-owned-process-tree`
- **CUT-004** (stop creating new tmux sessions): `cleanup.removes-session`

## Roadmap items this corpus does NOT directly protect

These are defended by later roadmap work, not by a corpus scenario, and are noted
so the gap is explicit rather than implied:

- **MIG-001** — this corpus is the artifact itself; it protects the others.
- **MIG-002** (introduce the product backend contract) and **MIG-005** (safe
  rollback) describe the future seam and its migration semantics, which are out
  of scope for this test-only corpus.
- **CUT-001** (run native and tmux contract tests side by side) is the *consumer*
  of this corpus: once a native runner exists it implements the same
  `ParityRunner` and reuses these checks. The intentional-difference catalog in
  `corpus.ts` is the "record intentional differences" half of CUT-001.
