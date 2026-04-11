# agent-electrobun Setup

[agent-electrobun](https://github.com/nichochar/agent-electrobun) is a CDP (Chrome DevTools Protocol) automation CLI that lets AI agents interact with the dev-3.0 app — clicking buttons, filling forms, taking screenshots, and verifying UI changes.

## Install the CLI

Build from the vetted commit:

```bash
# Clone the repo
git clone https://github.com/nichochar/agent-electrobun.git
cd agent-electrobun

# Check out the vetted commit
git checkout c0bc0c04ff8e7a1231709e36bfab45076d7bc27a

# Build and install globally
bun install
bun build src/agent-electrobun.ts --compile --outfile agent-electrobun
sudo mv agent-electrobun /usr/local/bin/
```

Verify: `agent-electrobun --help` should print the usage info.

## Install the Claude Code skill

The `agent-electrobun` skill teaches Claude Code the generic CDP commands. Install it from the same repo:

```bash
mkdir -p ~/.claude/skills/agent-electrobun
cp SKILL.md ~/.claude/skills/agent-electrobun/SKILL.md

# If the repo has a references/ directory, copy that too
cp -r references ~/.claude/skills/agent-electrobun/references 2>/dev/null || true
```

## dev3-specific skill

The project includes a **project-level** skill at `.claude/skills/dev3-ui-control/` that builds on top of `agent-electrobun` with dev3-specific recipes (CDP port discovery, React input workarounds, UI flow guides). This skill is automatically available to all agents working in the repo — no extra installation needed.

## Quick verification

```bash
# Start a dev server for your task
dev3 dev-server start

# Get the CDP port
dev3 dev-server status
# Look for: Assigned Ports: DEV3_PORT0=NNNNN

# Test connectivity
QUIVER_CDP_PORT=NNNNN agent-electrobun list
# Expected: [shell] dev-3.0 vX.Y.Z

# Take a snapshot
QUIVER_CDP_PORT=NNNNN agent-electrobun --target shell snapshot -i
```

## Vetted commit

The current vetted commit is `c0bc0c04ff8e7a1231709e36bfab45076d7bc27a`. We pin to a specific commit because agent-electrobun is an external tool that runs arbitrary JS in the app's renderer process. Before updating, review the diff for security implications.
