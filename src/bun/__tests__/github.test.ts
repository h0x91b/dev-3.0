import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const whichMock = vi.fn();

function fakeProc(stdout: string, stderr = "", exitCode = 0) {
	const encoder = new TextEncoder();
	return {
		exited: Promise.resolve(exitCode),
		stdout: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stdout));
				controller.close();
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stderr));
				controller.close();
			},
		}),
	};
}

vi.mock("../spawn", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("../which", () => ({
	which: (...args: unknown[]) => whichMock(...args),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

describe("github", () => {
	beforeEach(() => {
		vi.resetModules();
		spawnMock.mockReset();
		whichMock.mockReset();
	});

	it("returns not_installed when gh is missing", async () => {
		whichMock.mockResolvedValue(null);

		const { getGitHubCliStatus } = await import("../github");
		await expect(getGitHubCliStatus()).resolves.toEqual({
			authStatus: "not_installed",
			binaryPath: null,
			accounts: [],
		});
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("parses authenticated accounts from gh auth status json", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		spawnMock.mockReturnValue(fakeProc(JSON.stringify({
			hosts: {
				"github.com": [
					{ login: "h0x91b", host: "github.com", active: true, state: "success" },
					{ login: "h0x91b-wix", host: "github.com", active: false, state: "success" },
					{ login: "broken", host: "github.com", active: false, state: "failure" },
				],
			},
		})));

		const { getGitHubCliStatus } = await import("../github");
		await expect(getGitHubCliStatus()).resolves.toEqual({
			authStatus: "authenticated",
			binaryPath: "/opt/homebrew/bin/gh",
			accounts: [
				{ login: "h0x91b", host: "github.com", active: true },
				{ login: "h0x91b-wix", host: "github.com", active: false },
			],
		});
	});

	it("returns token env for the configured project account", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc(JSON.stringify({
					hosts: {
						"github.com": [
							{ login: "h0x91b", host: "github.com", active: true, state: "success" },
							{ login: "h0x91b-wix", host: "github.com", active: false, state: "success" },
						],
					},
				}));
			}
			if (cmd.join(" ") === "gh auth token --hostname github.com --user h0x91b-wix") {
				return fakeProc("secret-token\n");
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const { getGitHubAuthEnv } = await import("../github");
		await expect(getGitHubAuthEnv({
			githubAuthHost: "github.com",
			githubAuthLogin: "h0x91b-wix",
		})).resolves.toEqual({
			GH_TOKEN: "secret-token",
			GITHUB_TOKEN: "secret-token",
		});
	});

	it("builds shell exports for the resolved account", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		spawnMock.mockReturnValue(fakeProc(JSON.stringify({
			hosts: {
				"github.com": [
					{ login: "h0x91b", host: "github.com", active: true, state: "success" },
				],
			},
		})));

		const { getGitHubShellExports } = await import("../github");
		const lines = await getGitHubShellExports({
			githubAuthHost: null,
			githubAuthLogin: null,
		});

		expect(lines.join("\n")).toContain("gh auth token --hostname 'github.com' --user 'h0x91b'");
		expect(lines).toContain('export GH_TOKEN="$__DEV3_GH_TOKEN"');
		expect(lines).toContain('export GITHUB_TOKEN="$__DEV3_GH_TOKEN"');
	});
});
