Short: Fix broken Add Project menu

The native "Add Project" menu item now works: its openAddProjectModal push was missing a renderer handler, so the menu did nothing. Also declared the cliShowImage / cliShowArtifact push messages in the RPC schema (they were sent and handled but undeclared).
