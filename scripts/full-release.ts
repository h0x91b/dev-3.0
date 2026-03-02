#!/usr/bin/env bun

import { $ } from "bun";

const CONFIG_PATH = "electrobun.config.ts";

const content = await Bun.file(CONFIG_PATH).text();

const match = content.match(/version:\s*"(\d+\.\d+\.\d+)"/);
if (!match) {
	console.error("Could not find version in", CONFIG_PATH);
	process.exit(1);
}

const version = match[1];
const tag = `full-v${version}`;

console.log(`Creating full release tag: ${tag}`);

await $`git tag ${tag}`;
await $`git push origin ${tag}`;

console.log(`Tag ${tag} pushed. This will trigger a full cross-platform build (ARM64 + Intel Mac + Linux).`);
