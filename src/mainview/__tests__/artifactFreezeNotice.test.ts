import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc", () => ({
	api: { request: { consumeArtifactFreezeNotice: vi.fn() } },
}));
vi.mock("../toast", () => ({
	toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { api } from "../rpc";
import { toast } from "../toast";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";
import { maybeShowArtifactFreezeNotice } from "../utils/artifactFreezeNotice";

const consume = api.request.consumeArtifactFreezeNotice as unknown as ReturnType<typeof vi.fn>;
const info = toast.info as unknown as ReturnType<typeof vi.fn>;
const t = ((key: string) => key) as never;

beforeEach(() => {
	consume.mockReset();
	info.mockReset();
});

describe("artifact freeze notice", () => {
	it("says nothing when the previous session was healthy", async () => {
		consume.mockResolvedValue(null);
		await maybeShowArtifactFreezeNotice(t);
		expect(info).not.toHaveBeenCalled();
	});

	it("explains the switch and routes to the setting that owns it", async () => {
		consume.mockResolvedValue({ freezeAt: 1 });
		const seen: CustomEvent[] = [];
		window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, (e) => seen.push(e as CustomEvent));

		await maybeShowArtifactFreezeNotice(t);

		expect(info).toHaveBeenCalledTimes(1);
		const [message, opts] = info.mock.calls[0];
		expect(message).toBe("settings.artifactPopupAutoEnabled");
		expect(opts.source).toBe("settings");
		opts.onClick();
		expect(seen[0].detail).toEqual({ section: "behavior", anchor: "artifact-popup" });
	});

	it("stays quiet when the host cannot be asked", async () => {
		consume.mockRejectedValue(new Error("rpc down"));
		await expect(maybeShowArtifactFreezeNotice(t)).resolves.toBeUndefined();
		expect(info).not.toHaveBeenCalled();
	});
});
