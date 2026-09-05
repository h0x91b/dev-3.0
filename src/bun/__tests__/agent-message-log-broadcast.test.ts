import { describe, expect, it, vi } from "vitest";

const broadcast = vi.hoisted(() => vi.fn());
vi.mock("../instance-broadcast", () => ({ broadcastToOtherInstances: broadcast }));

import { getPushMessage, getPushMessageLocal, setPushMessage } from "../rpc-handlers/shared-pure";

describe("message log invalidation across instances", () => {
	it("broadcasts recipient identity and does not rebroadcast received invalidations", () => {
		const local = vi.fn();
		setPushMessage(local);
		getPushMessage()?.("agentMessageLogChanged", { projectId: "recipient-project" });
		expect(local).toHaveBeenCalledWith("agentMessageLogChanged", { projectId: "recipient-project" });
		expect(broadcast).toHaveBeenCalledWith("agentMessageLogChanged", {
			event: "agentMessageLogChanged", projectId: "recipient-project",
		});
		getPushMessageLocal()?.("agentMessageLogChanged", { projectId: "recipient-project" });
		expect(local).toHaveBeenCalledTimes(2);
		expect(broadcast).toHaveBeenCalledTimes(1);
	});
});
