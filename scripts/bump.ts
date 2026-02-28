#!/usr/bin/env bun

import { $ } from "bun";

const CONFIG_PATH = "electrobun.config.ts";

type BumpType = "patch" | "minor" | "major";

function bumpVersion(version: string, type: BumpType): string {
	const [major, minor, patch] = version.split(".").map(Number);

	switch (type) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

const arg = process.argv[2] as BumpType | undefined;
const type: BumpType = arg && ["patch", "minor", "major"].includes(arg) ? arg : "patch";

const content = await Bun.file(CONFIG_PATH).text();

const match = content.match(/version:\s*"(\d+\.\d+\.\d+)"/);
if (!match) {
	console.error("Could not find version in", CONFIG_PATH);
	process.exit(1);
}

const oldVersion = match[1];
const newVersion = bumpVersion(oldVersion, type);

const updated = content.replace(
	`version: "${oldVersion}"`,
	`version: "${newVersion}"`,
);

await Bun.write(CONFIG_PATH, updated);

console.log(`${oldVersion} → ${newVersion} (${type})`);

await $`git add ${CONFIG_PATH}`;
await $`git commit -m ${"v" + newVersion}`;
await $`git tag ${"v" + newVersion}`;

console.log(`Tag v${newVersion} created. Push with: git push && git push --tags`);
