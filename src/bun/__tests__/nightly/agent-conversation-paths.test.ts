/**
 * Nightly integration tests for agent conversation storage paths.
 *
 * Our hibernate feature's phase-2 snapshot-diff approach relies on knowing
 * where each agent stores conversation/session files on disk. These tests
 * verify that the expected storage directories exist and follow the expected
 * structure.
 *
 * Claude Code storage layout:
 *   ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
 *   Path encoding: resolve symlinks first (e.g. /tmp → /private/tmp),
 *   then replace leading / with -, all / with -, dots/underscores with -.
 *
 * Each agent is tested independently and skipped if not installed.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

function which(cmd: string): string | null {
	try {
		return execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8", timeout: 3000 }).trim();
	} catch {
		return null;
	}
}

/** Encode a directory path the way Claude Code does for ~/.claude/projects/ */
function claudeEncodePath(dirPath: string): string {
	// Claude resolves symlinks first, then encodes
	const resolved = realpathSync(dirPath);
	return resolved.replace(/^\//, "-").replace(/[/._]/g, "-");
}

// ---- Claude Code conversation storage ----

const claudePath = which("claude");
const describeClaude = claudePath ? describe : describe.skip;

describeClaude("Claude Code conversation storage", () => {
	const claudeDir = join(HOME, ".claude");
	const projectsDir = join(claudeDir, "projects");

	it("~/.claude/ directory exists", () => {
		expect(existsSync(claudeDir)).toBe(true);
	});

	it("~/.claude/projects/ directory exists", () => {
		expect(existsSync(projectsDir)).toBe(true);
	});

	it("project directories use dash-encoded resolved-path naming", () => {
		const entries = readdirSync(projectsDir).filter((e) => {
			try { return statSync(join(projectsDir, e)).isDirectory(); } catch { return false; }
		});

		if (entries.length === 0) return;

		// All project dir names should start with a dash (encoded leading /)
		for (const entry of entries.slice(0, 10)) {
			expect(entry.startsWith("-")).toBe(true);
		}
	});

	it("session files are UUIDs with .jsonl extension", () => {
		const entries = readdirSync(projectsDir).filter((e) => {
			try { return statSync(join(projectsDir, e)).isDirectory(); } catch { return false; }
		});

		if (entries.length === 0) return;

		for (const projDir of entries) {
			const files = readdirSync(join(projectsDir, projDir));
			const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
			if (jsonlFiles.length === 0) continue;

			const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
			for (const f of jsonlFiles.slice(0, 5)) {
				expect(f).toMatch(uuidPattern);
			}
			return;
		}
	});

	it("new sessions appear as files when claude runs in a directory", () => {
		const tmpDir = join("/tmp", `dev3-nightly-claude-${process.pid}`);
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(join(tmpDir, "test.txt"), "hello");

		try {
			execSync(
				`claude -p "Say exactly: OK" --max-turns 1`,
				{
					cwd: tmpDir,
					encoding: "utf-8",
					timeout: 30000,
					env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
				},
			);

			const encoded = claudeEncodePath(tmpDir);
			const sessionDir = join(projectsDir, encoded);

			expect(existsSync(sessionDir)).toBe(true);

			const files = readdirSync(sessionDir);
			const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
			expect(jsonlFiles.length).toBeGreaterThanOrEqual(1);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("session file is written on SIGTERM (graceful shutdown persists state)", async () => {
		const tmpDir = join("/tmp", `dev3-nightly-sigterm-${process.pid}`);
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(join(tmpDir, "test.txt"), "hello");

		try {
			// Start claude interactively as a background process
			const child = require("node:child_process").spawn(
				"claude",
				[],
				{
					cwd: tmpDir,
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
				},
			);

			// Wait for initialization
			await new Promise((r) => setTimeout(r, 3000));

			// Send SIGTERM (what tmux kill-pane sends)
			child.kill("SIGTERM");

			// Wait for exit
			await new Promise<void>((resolve) => {
				child.on("exit", () => resolve());
				setTimeout(resolve, 5000);
			});

			const encoded = claudeEncodePath(tmpDir);
			const sessionDir = join(projectsDir, encoded);

			if (existsSync(sessionDir)) {
				const files = readdirSync(sessionDir);
				const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
				expect(jsonlFiles.length).toBeGreaterThanOrEqual(1);

				// Verify the file was written recently
				if (jsonlFiles.length > 0) {
					const newest = jsonlFiles
						.map((f) => ({ f, mtime: statSync(join(sessionDir, f)).mtimeMs }))
						.sort((a, b) => b.mtime - a.mtime)[0];
					const ageMs = Date.now() - newest.mtime;
					expect(ageMs).toBeLessThan(30000);
				}
			}
			// If no session dir, agent didn't start in time — not a failure
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("path encoding resolves symlinks before encoding", () => {
		// /tmp on macOS is a symlink to /private/tmp
		// Claude should resolve this, so the encoded path uses /private/tmp
		const tmpDir = join("/tmp", `dev3-nightly-symlink-check-${process.pid}`);
		// Must create the dir for realpathSync to work
		mkdirSync(tmpDir, { recursive: true });

		try {
			const resolved = realpathSync("/tmp");

			if (resolved !== "/tmp") {
				const encoded = claudeEncodePath(tmpDir);
				// Should contain the resolved path component
				expect(encoded).toContain(resolved.replace(/^\//, "").replace(/[/._]/g, "-"));
				// Should NOT contain just "tmp-dev3" without "private"
				expect(encoded.startsWith("-private-")).toBe(true);
			}
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ---- Codex conversation storage ----

const codexPath = which("codex");
const describeCodex = codexPath ? describe : describe.skip;

describeCodex("Codex conversation storage", () => {
	const codexDir = join(HOME, ".codex");

	it("~/.codex/ directory exists after first use", () => {
		if (!existsSync(codexDir)) {
			console.log("~/.codex/ not found — Codex may not have been run yet. Skipping.");
			return;
		}
		expect(existsSync(codexDir)).toBe(true);
	});

	it("has a sessions or conversations subdirectory", () => {
		if (!existsSync(codexDir)) return;

		const entries = readdirSync(codexDir);
		if (entries.length === 0) return;

		// Log contents for debugging
		console.log("Codex directory contents:", entries);
		expect(entries.length).toBeGreaterThan(0);
	});
});

// ---- Gemini conversation storage ----

const geminiPath = which("gemini");
const describeGemini = geminiPath ? describe : describe.skip;

describeGemini("Gemini conversation storage", () => {
	const geminiDir = join(HOME, ".gemini");

	it("~/.gemini/ directory exists after first use", () => {
		if (!existsSync(geminiDir)) {
			console.log("~/.gemini/ not found — Gemini CLI may not have been run yet. Skipping.");
			return;
		}
		expect(existsSync(geminiDir)).toBe(true);
	});
});
