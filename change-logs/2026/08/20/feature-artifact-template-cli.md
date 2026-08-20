Short: Recover a missing artifact starter

New `dev3 artifact-template` command copies this task's pristine dev3 artifact starter into `./dev3-artifact-report` and prints where it went. It is the recovery path when `$DEV3_ARTIFACT_TEMPLATE_DIR` is absent — that variable is baked into a session's environment at launch, so an older session or a shell that never inherited it could not reach the starter at all.

Suggested by @DolevEpshtein (h0x91b/dev-3.0#1437)
