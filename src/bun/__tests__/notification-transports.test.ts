/**
 * The outbound notification hook. Guards the properties that make a
 * user-configured egress path safe to ship: it is inert until configured, it
 * never reaches a shell, a broken transport cannot fail the task transition that
 * triggered it, and the content policy is per destination.
 *
 * Per AGENTS.md ("Telemetry — anonymous always"), the protection that must fail
 * loudly if removed is that dev-3.0 never picks the destination: an unconfigured
 * install sends nothing, anywhere.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests run under Node, where Bun.spawn does not exist; the repo's
// convention is to mock the wrapper and assert the contract passed to it.
const spawned: { cmd: string[]; stdin: string }[] = [];
const spawnControl = vi.hoisted(() => ({
	next: null as null | { exited: Promise<number>; kill: ReturnType<typeof vi.fn> },
}));
vi.mock("../spawn", () => ({
	spawn: vi.fn((cmd: string[], opts: { stdin?: Uint8Array }) => {
		spawned.push({ cmd, stdin: new TextDecoder().decode(opts?.stdin ?? new Uint8Array()) });
		if (spawnControl.next) {
			const next = spawnControl.next;
			spawnControl.next = null;
			return next;
		}
		return { exited: Promise.resolve(0), kill: () => {} };
	}),
	spawnSync: vi.fn(() => ({ exitCode: 0, stdout: new Uint8Array() })),
}));
import {
	deliverToTransports,
	loadNotificationConfig,
	parseNotificationConfig,
	redactEvent,
	shouldDeliver,
	type NotificationEvent,
	type NotificationHookConfig,
} from "../notification-transports";

const event: NotificationEvent = {
	taskId: "ccddc351-a96a-4b28-8f6c-392f4512c96f",
	projectId: "3f2a91c4-77bd-4e1a-9a02-1d5e6f8b0c33",
	title: "#42 Refactor the acme-nda billing flow",
	body: "Agent has questions",
	level: "info",
	taskSeq: 42,
	taskTitle: "Refactor the acme-nda billing flow",
	projectName: "acme-nda",
};

const dir = mkdtempSync(join(tmpdir(), "dev3-notify-"));
const hook = ["/usr/local/bin/notify-hook"];
const sent = (i = 0): NotificationEvent => JSON.parse(spawned[i].stdin);

beforeEach(() => {
	spawned.length = 0;
	spawnControl.next = null;
});

describe("no destination unless the user picked one", () => {
	it("stays inert when the config file is absent", () => {
		expect(loadNotificationConfig(join(dir, "nope.json"))).toBeNull();
	});

	it("stays inert on malformed JSON rather than failing startup", () => {
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{not json");
		expect(loadNotificationConfig(bad)).toBeNull();
	});

	it("has no default endpoint — an empty transport list is not a config", () => {
		expect(parseNotificationConfig({ transports: [] })).toBeNull();
		expect(parseNotificationConfig({})).toBeNull();
	});
});

describe("config validation", () => {
	it("rejects a shell string masquerading as a command", () => {
		expect(parseNotificationConfig({ transports: [{ kind: "exec", command: "rm -rf /" }] })).toBeNull();
	});

	it("rejects a webhook whose URL is not http(s)", () => {
		expect(parseNotificationConfig({ transports: [{ kind: "webhook", url: "file:///etc/passwd" }] })).toBeNull();
		expect(parseNotificationConfig({ transports: [{ kind: "webhook", url: "not a url" }] })).toBeNull();
	});

	it("keeps the valid transports and drops the rest", () => {
		const config = parseNotificationConfig({
			transports: [{ kind: "exec", command: ["/bin/true"] }, { kind: "nonsense" }, { kind: "webhook", url: "https://ok/x" }],
		});
		expect(config?.transports).toHaveLength(2);
	});
});

describe("content policy", () => {
	it("sends content by default — a notification has to be triageable", async () => {
		await deliverToTransports(event, { transports: [{ kind: "exec", command: hook }] });
		expect(sent().taskTitle).toBe(event.taskTitle);
		expect(sent().projectName).toBe("acme-nda");
	});

	it("hands the payload over stdin, never as an argument", async () => {
		await deliverToTransports(event, { transports: [{ kind: "exec", command: hook }] });
		expect(spawned[0].cmd).toEqual(hook);
		expect(spawned[0].cmd.join(" ")).not.toContain("acme-nda");
	});

	it("strips the user-authored strings when asked, and keeps the ids", () => {
		const r = redactEvent(event);
		expect(r.title).toBe("#42 needs you");
		expect(r.body).toBe("");
		expect(r.taskTitle).toBe("");
		expect(r.projectName).toBe("");
		expect(JSON.stringify(r)).not.toContain("acme-nda");
		expect(r.taskId).toBe(event.taskId);
	});

	it("lets one destination get detail while another gets ids only", async () => {
		await deliverToTransports(event, {
			includeContent: false,
			transports: [
				{ kind: "exec", command: hook, includeContent: true },
				{ kind: "exec", command: ["/usr/local/bin/other-hook"] },
			],
		});
		expect(sent(0).projectName).toBe("acme-nda");
		expect(sent(1).projectName).toBe("");
		expect(sent(1).title).toBe("#42 needs you");
	});
});

describe("level allowlist", () => {
	const base: NotificationHookConfig = { transports: [] };
	it("delivers an allowed level", () => {
		expect(shouldDeliver(event, { ...base, levels: ["info"] })).toBe(true);
	});
	it("drops the others", () => {
		expect(shouldDeliver(event, { ...base, levels: ["error"] })).toBe(false);
	});
	it("treats an absent allowlist as every level", () => {
		expect(shouldDeliver(event, base)).toBe(true);
	});
});

describe("a broken hook cannot break the caller", () => {
	it("swallows a missing binary and an unreachable webhook", async () => {
		await expect(
			deliverToTransports(event, {
				transports: [
					{ kind: "exec", command: ["/nonexistent/binary"] },
					{ kind: "webhook", url: "http://127.0.0.1:1/nope", timeoutMs: 300 },
				],
			}),
		).resolves.toBeUndefined();
	});

	it("does not let an unreachable webhook stall the fan-out", async () => {
		const started = Date.now();
		await deliverToTransports(event, {
			transports: [{ kind: "webhook", url: "http://127.0.0.1:1/nope", timeoutMs: 250 }],
		});
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("hard-kills an exec hook at its configured deadline", async () => {
		let finish!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			finish = resolve;
		});
		const kill = vi.fn((signal: number) => {
			if (signal === 9) finish(137);
		});
		spawnControl.next = { exited, kill };

		const started = Date.now();
		await deliverToTransports(event, {
			transports: [{ kind: "exec", command: hook, timeoutMs: 20 }],
		});

		expect(kill).toHaveBeenCalledWith(9);
		expect(Date.now() - started).toBeLessThan(500);
	});
});

if (existsSync(dir)) {
	process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}
