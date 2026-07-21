#!/usr/bin/env bun
/**
 * Offline replay verifier for captured Windows session journals.
 *
 * Runs the same detach-boundary roundtrip the golden fixtures use: ingest the
 * captured bytes into a fresh Ghostty core (live), snapshot it, replay the
 * snapshot into another fresh core, and assert the semantic states match at the
 * detach boundary and again after the post-detach events. Ghostty runs OUTSIDE
 * any PTY callback here, which is the supported path on Bun 1.3.14 Windows
 * (decision 146). Emits a structured verdict for the evidence record.
 */

import { readFileSync } from "node:fs";
import {
	HeadlessTerminalState,
	decodeCaptureOutput,
	parseTerminalSnapshot,
	replayTerminalSnapshot,
	serializeTerminalSnapshot,
	type TerminalCaptureEvent,
	type TerminalCaptureFixture,
	type TerminalSemanticState,
} from "./terminal-state";
import {
	isRawSessionJournal,
	journalToFixture,
	splitAtDetach,
	type RawSessionJournal,
} from "./session-journal";

export interface CapabilityCoverage {
	cursor: boolean;
	modes: string[];
	wrapping: boolean;
	unicode: boolean;
	colors: boolean;
	alternateScreen: boolean;
	finalDimensions: { cols: number; rows: number };
}

export interface VerifyVerdict {
	target: string;
	matchesAtDetach: boolean;
	matchesAfterReplay: boolean;
	detachEvents: number;
	afterReplayEvents: number;
	coverage: CapabilityCoverage;
}

function stableEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

async function applyEvents(
	targets: HeadlessTerminalState[],
	events: TerminalCaptureEvent[],
): Promise<void> {
	for (const event of events) {
		if (event.type === "output") {
			const data = decodeCaptureOutput(event);
			for (const target of targets) await target.ingest(data);
		} else {
			for (const target of targets) target.resize(event.cols, event.rows);
		}
	}
}

function detectColors(state: TerminalSemanticState): boolean {
	for (const line of [...state.screen, ...state.scrollback]) {
		for (const cell of line.cells) {
			if (cell.attributes.length > 0) return true;
			if (cell.foreground !== "rgb:ffffff" && cell.foreground !== "rgb:000000") return true;
			if (cell.background !== "rgb:000000") return true;
		}
	}
	return false;
}

function detectUnicode(state: TerminalSemanticState): boolean {
	for (const line of [...state.screen, ...state.scrollback]) {
		for (const cell of line.cells) {
			if (cell.width > 1) return true;
			if (cell.text && cell.text.codePointAt(0)! > 0x7f) return true;
		}
	}
	return false;
}

function activeModes(state: TerminalSemanticState): string[] {
	const active: string[] = [];
	for (const [name, value] of Object.entries(state.modes)) {
		if (typeof value === "boolean" && value) active.push(name);
		else if (typeof value === "string" && value !== "none") active.push(`${name}=${value}`);
	}
	return active.sort();
}

function coverageFor(journal: RawSessionJournal, finalState: TerminalSemanticState): CapabilityCoverage {
	const rawText = journal.events
		.map((event) =>
			event.type === "output"
				? event.encoding === "base64"
					? new TextDecoder().decode(Uint8Array.from(Buffer.from(event.data, "base64")))
					: event.data
				: "",
		)
		.join("");
	const enteredAlternate = /\x1b\[\?(?:1049|1047|47)h/.test(rawText);
	return {
		cursor: true,
		modes: activeModes(finalState),
		wrapping: [...finalState.screen, ...finalState.scrollback].some((line) => line.wrapped === true),
		unicode: detectUnicode(finalState),
		colors: detectColors(finalState) || /\x1b\[[0-9;]*[34]8[;0-9]*m/.test(rawText),
		alternateScreen: enteredAlternate || finalState.activeBuffer === "alternate",
		finalDimensions: finalState.dimensions,
	};
}

export async function verifyJournal(journal: RawSessionJournal): Promise<VerifyVerdict> {
	const { events, afterReplay } = splitAtDetach(journal);

	const source = await HeadlessTerminalState.create(journal.initial);
	await applyEvents([source], events);
	const liveAtDetach = source.inspect();

	const snapshot = source.snapshot();
	const replay = await replayTerminalSnapshot(parseTerminalSnapshot(serializeTerminalSnapshot(snapshot)));
	const matchesAtDetach = stableEqual(liveAtDetach, replay.inspect());

	await applyEvents([source, replay], afterReplay);
	const finalState = source.inspect();
	const matchesAfterReplay = stableEqual(finalState, replay.inspect());

	source.dispose();
	replay.dispose();

	return {
		target: journal.target,
		matchesAtDetach,
		matchesAfterReplay,
		detachEvents: events.length,
		afterReplayEvents: afterReplay.length,
		coverage: coverageFor(journal, finalState),
	};
}

function stableExpectations(state: TerminalSemanticState): Partial<TerminalSemanticState> {
	return {
		activeBuffer: state.activeBuffer,
		title: state.title,
		dimensions: state.dimensions,
		cursor: {
			x: state.cursor.x,
			y: state.cursor.y,
			visible: state.cursor.visible,
			style: state.cursor.style,
			blink: state.cursor.blink,
		},
	};
}

/**
 * Build a harness fixture from a shell journal. Refused for agent journals so
 * raw agent bytes never enter a stored fixture.
 */
export async function buildHarnessFixture(
	journal: RawSessionJournal,
	name: string,
): Promise<TerminalCaptureFixture> {
	if (journal.kind === "agent") {
		throw new Error("Refusing to emit a fixture from an agent journal (would store raw bytes)");
	}
	const { events, afterReplay } = splitAtDetach(journal);
	const source = await HeadlessTerminalState.create(journal.initial);
	await applyEvents([source], events);
	const expected = stableExpectations(source.inspect());
	let expectedAfterReplay: Partial<TerminalSemanticState> | undefined;
	if (afterReplay.length > 0) {
		await applyEvents([source], afterReplay);
		expectedAfterReplay = stableExpectations(source.inspect());
	}
	source.dispose();
	return journalToFixture(journal, name, { expected, expectedAfterReplay });
}

async function main(): Promise<void> {
	const path = Bun.argv[2];
	if (!path) throw new Error("Usage: verify-journal.ts <journal.json> [fixtureName fixtureOut.json]");
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRawSessionJournal(parsed)) throw new Error(`Not a session journal: ${path}`);
	const verdict = await verifyJournal(parsed);
	console.log(JSON.stringify(verdict, null, 2));

	const fixtureName = Bun.argv[3];
	const fixtureOut = Bun.argv[4];
	if (fixtureName && fixtureOut) {
		const fixture = await buildHarnessFixture(parsed, fixtureName);
		await Bun.write(fixtureOut, `${JSON.stringify(fixture, null, 2)}\n`);
		console.error(`wrote harness fixture ${fixtureName} → ${fixtureOut}`);
	}

	if (!verdict.matchesAtDetach || !verdict.matchesAfterReplay) process.exit(1);
}

if (import.meta.main) await main();
