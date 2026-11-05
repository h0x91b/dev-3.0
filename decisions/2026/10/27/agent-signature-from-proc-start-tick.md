# Pin an agent process by its /proc start tick on Linux

## 1. Context
A held `dev3 message`, an `--agent` handle, a `<reply-with>` reply and an author-bound self-reminder all name one agent process by a start signature, checked again right before typing (`decisions/2026/10/26/agent-addressed-messages-and-replies.md`). The signature was `pid@<ps lstart>`.

## 2. Investigation
On Linux `ps lstart` is the boot time plus the process's start tick, and the kernel recomputes the boot time from the wall clock. On a WSL box it moved 47 s in 12 minutes. A live agent's signature changed between queueing and release, and its messages were dropped as "no longer running" after the CLI had reported them queued.

## 3. Decision
`src/bun/agent-process-signature.ts` reads `pid@linux:<boot id>:<start tick>` from `/proc/<pid>/stat` (field 22) and `/proc/sys/kernel/random/boot_id` on Linux. Neither moves with the clock, and the boot id keeps a reboot from matching. Other platforms keep `pid@<ps lstart>`. `isSameAgentProcess` reads a stored signature back in the form it was written, so an `lstart` signature from an older build is still checked.

## 4. Risks
An older build on the same machine compares its `lstart` reading to a `linux:` signature written by a newer one and refuses that message, the same outcome as the drift it already suffers. The native terminal registry (`native-terminal-registry/process-identity-native.ts`) still uses `lstart` for host and shell ownership; it writes those to disk for other versions, so it is left for its own change.

## 5. Alternatives considered
Comparing `lstart` with a tolerance: the drift has no bound over the hours a reminder or handle lives. Recomputing `lstart` from a boot time cached at startup: wrong for a server started after the step, and still per-process state.
