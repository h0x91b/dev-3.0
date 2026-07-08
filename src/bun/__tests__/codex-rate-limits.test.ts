import { describe, expect, it, vi } from "vitest";
import { fetchCodexRateLimitSnapshot } from "../codex-rate-limits";

function stream(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body!;
}

describe("fetchCodexRateLimitSnapshot", () => {
	it("handshakes with codex app-server and parses account/rateLimits/read", async () => {
		let input = "";
		let inputClosed = false;
		let inputClosedBeforeResponse = false;
		const response = `${JSON.stringify({ id: 0, result: { userAgent: "test" } })}\n${JSON.stringify({
			id: 7,
			result: {
				rateLimits: {
					primary: null,
					secondary: null,
					individualLimit: { limit: "8824", used: "329.53", remainingPercent: 96, resetsAt: 1_785_542_400 },
				},
			},
		})}\n`;
		const spawnProcess = vi.fn(() => ({
			stdin: {
				write: vi.fn((chunk: string) => {
					input += chunk;
				}),
				end: vi.fn(() => {
					inputClosed = true;
				}),
			},
			stdout: new ReadableStream<Uint8Array>({
				async pull(controller) {
					await Promise.resolve();
					inputClosedBeforeResponse = inputClosed;
					if (!inputClosed) controller.enqueue(new TextEncoder().encode(response));
					controller.close();
				},
			}),
			stderr: stream(""),
			exited: Promise.resolve(0),
			kill: vi.fn(),
		}));

		const snapshot = await fetchCodexRateLimitSnapshot(spawnProcess as never, 1000, 1_783_200_000_000);

		expect(spawnProcess).toHaveBeenCalledWith(
			["codex", "app-server", "--stdio"],
			expect.objectContaining({ stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
		);
		expect(input).toContain('"method":"initialize"');
		expect(input).toContain('"method":"account/rateLimits/read"');
		expect(snapshot?.monthlyCredits?.limit).toBe(8824);
		expect(inputClosedBeforeResponse).toBe(false);
		expect(inputClosed).toBe(true);
	});

	it("returns null when Codex is unavailable", async () => {
		const spawnProcess = vi.fn(() => {
			throw new Error("ENOENT");
		});
		expect(await fetchCodexRateLimitSnapshot(spawnProcess as never, 1000)).toBeNull();
	});
});
