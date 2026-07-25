#!/usr/bin/env bun
/**
 * Manual driver for the native multi-pane coordinator (seq 1283).
 * NOT wired into the production `dev3` CLI (src/cli/main.ts) — a dev-only harness.
 *
 * Every command runs in a FRESH process, so `list`/`split`/`close` after a
 * `create` exercise the real fresh-controller recovery path: they rediscover the
 * same logical session, pane ordering, host pids, and shell pids from disk
 * without spawning or attaching twice.
 *
 *   bun src/bun/native-terminal-multipane/cli.ts create <id> [--panes N] [--cols N] [--rows N]
 *   bun src/bun/native-terminal-multipane/cli.ts list <id>                       # reconnect + print
 *   bun src/bun/native-terminal-multipane/cli.ts split <id> <paneId> [--vertical]
 *   bun src/bun/native-terminal-multipane/cli.ts focus <id> <paneId> <left|right|up|down>
 *   bun src/bun/native-terminal-multipane/cli.ts zoom <id> <paneId>
 *   bun src/bun/native-terminal-multipane/cli.ts resize <id> <paneId> <cols> <rows>
 *   bun src/bun/native-terminal-multipane/cli.ts write <id> <paneId> <text>
 *   bun src/bun/native-terminal-multipane/cli.ts close <id> <paneId>
 *   bun src/bun/native-terminal-multipane/cli.ts cleanup <id>
 */

import { getPaneRects, type SplitDirection, type SplitNode, type SplitOrientation, type SplitTree } from "../../shared/split-tree";
import {
	decodeShellLaunchSpec,
	defaultNativeShellLaunchSpec,
	defineShellLaunchSpec,
	NATIVE_SESSION_LAUNCH_ENV,
} from "../native-terminal-registry/shell-launch";
import { NativeMultipaneCoordinator, type PaneLaunchSpec } from "./coordinator";

function positionalArgs(): string[] {
	return process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
}

function hasFlag(flag: string): boolean {
	return process.argv.includes(flag);
}

function flagValue(flag: string, fallback: number): number {
	const index = process.argv.indexOf(flag);
	if (index < 0) return fallback;
	const parsed = Number(process.argv[index + 1]);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function requireArg(index: number, name: string): string {
	const value = positionalArgs()[index];
	if (!value) {
		process.stderr.write(`usage: cli.ts <command> <${name}>\n`);
		process.exit(2);
	}
	return value;
}

/** A genuinely independent shell per pane: explicit executable/argv/cwd/env. */
function paneLaunchSpec(paneId: string): PaneLaunchSpec {
	const explicit = process.env[NATIVE_SESSION_LAUNCH_ENV];
	const base = explicit
		? decodeShellLaunchSpec(explicit)
		: defaultNativeShellLaunchSpec({ platform: process.platform, cwd: process.cwd(), env: process.env });
	return {
		launch: defineShellLaunchSpec({ ...base, env: { ...base.env, DEV3_NATIVE_PANE_ID: paneId } }),
		cols: flagValue("--cols", 80),
		rows: flagValue("--rows", 24),
	};
}

function renderNode(node: SplitNode, depth: number, out: string[]): void {
	const indent = "  ".repeat(depth + 1);
	if (node.type === "pane") {
		out.push(`${indent}${node.id}`);
		return;
	}
	out.push(`${indent}${node.id} ${node.orientation} ratio=${node.ratio.toFixed(2)}`);
	renderNode(node.first, depth + 1, out);
	renderNode(node.second, depth + 1, out);
}

function renderLayout(tree: SplitTree): string {
	const out: string[] = ["layout:"];
	renderNode(tree.root, 0, out);
	const rects = getPaneRects(tree);
	for (const [paneId, rect] of rects) {
		out.push(
			`  rect ${paneId}\tx=${rect.x.toFixed(3)}\ty=${rect.y.toFixed(3)}\tw=${rect.width.toFixed(3)}\th=${rect.height.toFixed(3)}`,
		);
	}
	return `${out.join("\n")}\n`;
}

async function printCoordinator(coordinator: NativeMultipaneCoordinator): Promise<void> {
	const panes = await coordinator.listPanes();
	process.stdout.write(`coordinator=${coordinator.coordinatorId} panes=${panes.length} epoch=${coordinator.epoch}\n`);
	for (const pane of panes) {
		process.stdout.write(
			`  ${pane.paneId}\tsession=${pane.sessionId}\thostPid=${pane.hostPid}\tshellPid=${pane.shellPid}\tsize=${pane.cols}x${pane.rows}\tstate=${pane.state}\n`,
		);
	}
	process.stdout.write(renderLayout(coordinator.layout));
}

/** Fresh-controller recovery; every non-create command starts here. */
async function requireCoordinator(coordinatorId: string): Promise<NativeMultipaneCoordinator> {
	const coordinator = await NativeMultipaneCoordinator.recover(coordinatorId);
	if (!coordinator) {
		process.stderr.write(`no live native multipane coordinator ${coordinatorId} (run \`create ${coordinatorId}\` first)\n`);
		process.exit(1);
	}
	return coordinator;
}

function orientation(): SplitOrientation {
	return hasFlag("--vertical") ? "vertical" : "horizontal";
}

async function create(coordinatorId: string): Promise<void> {
	const target = flagValue("--panes", 1);
	const coordinator = await NativeMultipaneCoordinator.create(coordinatorId, paneLaunchSpec("pane-1"));
	let lastPaneId = coordinator.paneIds()[0]!;
	for (let index = 1; index < target; index++) {
		// Alternate orientation off the newest pane: deterministic, and it produces
		// a genuinely 2-dimensional layout for directional-focus checks.
		const nextOrientation: SplitOrientation = index % 2 === 1 ? "horizontal" : "vertical";
		lastPaneId = await coordinator.split(lastPaneId, nextOrientation, paneLaunchSpec(`pane-${index + 1}`));
	}
	await printCoordinator(coordinator);
	coordinator.detach();
}

async function main(): Promise<void> {
	const [command] = positionalArgs();
	switch (command) {
		case "create": {
			await create(requireArg(1, "coordinatorId"));
			process.exit(0);
			break;
		}
		case "list": {
			const coordinator = await requireCoordinator(requireArg(1, "coordinatorId"));
			await printCoordinator(coordinator);
			coordinator.detach();
			process.exit(0);
			break;
		}
		case "split": {
			const coordinator = await requireCoordinator(requireArg(1, "coordinatorId"));
			const paneId = requireArg(2, "paneId");
			const created = await coordinator.split(paneId, orientation(), paneLaunchSpec("split"));
			process.stdout.write(`split ${paneId} ${orientation()} -> ${created}\n`);
			await printCoordinator(coordinator);
			coordinator.detach();
			process.exit(0);
			break;
		}
		case "focus": {
			const coordinator = await requireCoordinator(requireArg(1, "coordinatorId"));
			const from = requireArg(2, "paneId");
			const direction = requireArg(3, "direction") as SplitDirection;
			// Focus is client-local: two views over the same shared layout stay independent.
			const viewA = coordinator.attachClient("view-a");
			const viewB = coordinator.attachClient("view-b");
			viewA.focus(from);
			viewA.focusDirection(coordinator.layout, direction);
			process.stdout.write(
				`view-a focus=${viewA.focusedPaneId} zoom=${viewA.zoomedPaneId}\nview-b focus=${viewB.focusedPaneId} zoom=${viewB.zoomedPaneId}\n`,
			);
			coordinator.detach();
			process.exit(0);
			break;
		}
		case "zoom": {
			const coordinator = await requireCoordinator(requireArg(1, "coordinatorId"));
			const paneId = requireArg(2, "paneId");
			const viewA = coordinator.attachClient("view-a");
			const viewB = coordinator.attachClient("view-b");
			viewA.toggleZoom(paneId);
			process.stdout.write(
				`view-a zoom=${viewA.zoomedPaneId}\nview-b zoom=${viewB.zoomedPaneId}\nsharedZoom=${coordinator.layout.zoomedPaneId}\n`,
			);
			coordinator.detach();
			process.exit(0);
			break;
		}
		case "resize": {
			const coordinator = await requireCoordinator(requireArg(1, "coordinatorId"));
			const paneId = requireArg(2, "paneId");
			await coordinator.resizePane(paneId, Number(requireArg(3, "cols")), Number(requireArg(4, "rows")));
			await printCoordinator(coordinator);
			coordinator.detach();
			process.exit(0);
			break;
		}
		case "write": {
			const coordinator = await requireCoordinator(requireArg(1, "coordinatorId"));
			const paneId = requireArg(2, "paneId");
			await coordinator.writePane(paneId, `${requireArg(3, "text")}${process.platform === "win32" ? "\r" : "\n"}`);
			process.stdout.write(`wrote to ${paneId}\n`);
			coordinator.detach();
			process.exit(0);
			break;
		}
		case "close": {
			const coordinator = await requireCoordinator(requireArg(1, "coordinatorId"));
			const result = await coordinator.closePane(requireArg(2, "paneId"));
			process.stdout.write(
				`closed ${result.closedPaneId} remaining=${result.remainingPaneIds.join(",") || "none"} sessionTornDown=${result.sessionTornDown}\n`,
			);
			if (!result.sessionTornDown) await printCoordinator(coordinator);
			coordinator.detach();
			process.exit(0);
			break;
		}
		case "cleanup": {
			const coordinatorId = requireArg(1, "coordinatorId");
			const coordinator = await NativeMultipaneCoordinator.recover(coordinatorId);
			if (!coordinator) {
				process.stdout.write(`nothing to clean up for ${coordinatorId}\n`);
				process.exit(0);
			}
			await coordinator.cleanup();
			process.stdout.write(`cleaned up ${coordinatorId}\n`);
			process.exit(0);
			break;
		}
		default:
			process.stdout.write(
				"usage: cli.ts create|list|split|focus|zoom|resize|write|close|cleanup <coordinatorId> [...]\n",
			);
			process.exit(2);
	}
}

void main().catch((err) => {
	process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
