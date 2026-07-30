/**
 * Every CI/release job must install the SAME Bun the app packages.
 *
 * They drifted once and it cost a red build: `build.yml` pinned Bun 1.3.10
 * while `electrobun.config.ts` packaged 1.3.14, so the first job to build the
 * native terminal host outside Windows tripped the ConPTY floor. A stale pin is
 * silent until some build step finally cares about the version, which is exactly
 * why it needs a guard rather than review discipline.
 *
 * `MINIMUM_WINDOWS_CONPTY_BUN_VERSION` is the single baseline: it feeds
 * `electrobun.config.ts` `build.bunVersion`, so pinning workflows to it keeps
 * the build toolchain and the packaged runtime identical by construction.
 *
 * If a future job genuinely needs a different Bun — proving behaviour on an
 * older runtime, say — add it to an explicit exception list here with the
 * reason. Do not loosen the equality.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MINIMUM_WINDOWS_CONPTY_BUN_VERSION } from "../../shared/native-terminal-runtime";

const WORKFLOWS_DIR = fileURLToPath(new URL("../../../.github/workflows", import.meta.url));

interface BunPin {
	workflow: string;
	line: number;
	version: string;
}

function bunPins(): BunPin[] {
	const pins: BunPin[] = [];
	for (const entry of readdirSync(WORKFLOWS_DIR, { withFileTypes: true })) {
		if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
		readFileSync(join(WORKFLOWS_DIR, entry.name), "utf8")
			.split(/\r?\n/)
			.forEach((text, index) => {
				const match = /^\s*bun-version:\s*["']?([^"'\s#]+)/.exec(text);
				if (match) pins.push({ workflow: entry.name, line: index + 1, version: match[1] });
			});
	}
	return pins;
}

function setupBunSteps(): number {
	return readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
		.reduce((total, entry) => total + (readFileSync(join(WORKFLOWS_DIR, entry.name), "utf8").match(/oven-sh\/setup-bun/g)?.length ?? 0), 0);
}

describe("workflow Bun pins", () => {
	it("finds a pin to check", () => {
		expect(bunPins().length).toBeGreaterThan(0);
	});

	it("pins every workflow to the Bun the app packages", () => {
		const drifted = bunPins()
			.filter((pin) => pin.version !== MINIMUM_WINDOWS_CONPTY_BUN_VERSION)
			.map((pin) => `${pin.workflow}:${pin.line} pins Bun ${pin.version}`);

		expect(
			drifted,
			`These jobs would build with a Bun the app does not package (${MINIMUM_WINDOWS_CONPTY_BUN_VERSION}):\n${drifted.join("\n")}`,
		).toEqual([]);
	});

	it("leaves no setup-bun step without a pin, where `latest` could drift silently", () => {
		expect(bunPins()).toHaveLength(setupBunSteps());
	});

	// A pin change IS a packaged-runtime change, so the job that proves the
	// package must re-run on it. Without this, a pure pin edit ships unproven.
	it("makes every Bun-pinning workflow trigger the packaged-runtime proof", () => {
		const packageWorkflow = "windows-conpty-package.yml";
		const triggerPaths = readFileSync(join(WORKFLOWS_DIR, packageWorkflow), "utf8")
			.split(/\r?\n/)
			.map((line) => /^\s*-\s*["']([^"']+)["']/.exec(line)?.[1])
			.filter((path): path is string => path !== undefined);
		const pinningWorkflows = [...new Set(bunPins().map((pin) => pin.workflow))];

		const untriggered = pinningWorkflows.filter((workflow) => !triggerPaths.includes(`.github/workflows/${workflow}`));

		expect(
			untriggered,
			`These workflows pin Bun but do not re-run ${packageWorkflow}, so a pin change would ship unproven:\n${untriggered.join("\n")}`,
		).toEqual([]);
	});

	it("keeps the baseline a plain release version, never a range or tag", () => {
		expect(MINIMUM_WINDOWS_CONPTY_BUN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
