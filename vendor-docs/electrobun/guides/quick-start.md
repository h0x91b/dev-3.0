# Quick Start

Welcome to Electrobun! This guide will help you create your first ultra-fast, tiny desktop application with TypeScript.

## Prerequisites

Before getting started, make sure you have:

- [Bun](https://bun.sh) installed on your system
- A text editor or IDE
- Basic knowledge of TypeScript/JavaScript

## Getting Started

Create a new Electrobun project with a single command:

```bash
bunx electrobun init
```

It'll ask you which template project you want to get started with.

This creates a new directory with the basic project structure:

```
my-app/
├── src/
│   ├── main.ts          # Main process entry point
│   └── renderer/
│       ├── index.html   # UI template
│       ├── style.css    # Styles
│       └── script.ts    # Frontend logic
├── package.json         # Project dependencies
└── electrobun.config.ts # Build configuration
```

## Running Your App

Navigate to your project directory and start development:

```bash
cd my-app
bun install
bun start
```

This will use the Electrobun cli to:

- Create a quick start project on your machine
- Do a dev build of your app
- Open your app in dev mode

## Next Steps

Now that you have a basic app running, explore these topics:

- [Hello World](./hello-world.md) - Create a hello world from scratch
- [Creating UI](./creating-ui.md) - Build beautiful interfaces with web technologies
- [Bun API](../apis/bun.md) - Learn about the main process APIs
- [BrowserView](../apis/browser-view.md) - Manage multiple webviews
- [Bundling & Distribution](./bundling-and-distribution.md) - Package your app for distribution

## Need Help?

If you run into any issues:

- Check the [GitHub repository](https://github.com/blackboardsh/electrobun)
- Join the [Discord community](https://discord.gg/ueKE4tjaCE)
- Read through the other documentation guides
