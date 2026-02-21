# CLI Arguments

## Installation

The Electrobun CLI is installed via Bun and made available through `node_modules/bin`:

```bash
bun install electrobun
```

This enables the `electrobun` command in npm scripts or via `bunx`/`npx`.

## Commands

### `electrobun init`

Initializes new Electrobun projects with starter templates.

**Usage:**

```bash
electrobun init
electrobun init [template-name]
```

**Available Templates:**

- `hello-world` - Basic single-window application
- `photo-booth` - Camera app with photo capture
- `interactive-playground` - Interactive Electrobun API showcase
- `multitab-browser` - Multi-tabbed web browser

**Examples:**

```bash
bunx electrobun init
bunx electrobun init photo-booth
bunx electrobun init multitab-browser
```

### `electrobun build`

Builds applications according to `electrobun.config.ts` configuration.

**Usage:**

```bash
electrobun build [options]
```

**Options:**

| Option | Description | Values | Default |
|--------|-------------|--------|---------|
| `--env` | Build environment | `dev`, `canary`, `stable` | `dev` |

Builds target the current host platform and architecture. For multiple platforms, use CI runners for each OS/architecture.

**Examples:**

```bash
electrobun build
electrobun build --env=dev
electrobun build --env=canary
electrobun build --env=stable
```

## Build Environments

### Development (`dev`)

- Terminal output of logs and errors
- No code signing or notarization
- Creates build in `build/` folder
- No artifacts generated
- Fast iteration for testing

### Canary

- Pre-release/beta builds
- Optional code signing and notarization
- Generates distribution artifacts
- Creates update manifests for auto-updates
- Testing with limited users

### Stable

- Production-ready builds
- Full code signing and notarization (if configured)
- Optimized and compressed artifacts
- Distribution-ready
- Generates all update files

## Build Script Examples

**Basic Setup:**

```json
{
  "scripts": {
    "dev": "electrobun build && electrobun dev",
    "build": "electrobun build --env=canary",
    "build:stable": "electrobun build --env=stable"
  }
}
```

**Development Workflow:**

```json
{
  "scripts": {
    "dev": "electrobun build --env=dev && electrobun dev",
    "dev:watch": "nodemon --watch src --exec 'bun run dev'",
    "test": "bun test && bun run build"
  }
}
```

**CI Build Scripts:**

```json
{
  "scripts": {
    "build:dev": "electrobun build",
    "build:canary": "electrobun build --env=canary",
    "build:stable": "electrobun build --env=stable"
  }
}
```
