import { describe, expect, it, vi } from "vitest";

const { pushCliToast } = vi.hoisted(() => ({ pushCliToast: vi.fn() }));
vi.mock("../rpc-handlers/shared", () => ({ pushCliToast }));
vi.mock("../rpc-handlers", () => ({ getPushMessage: () => undefined }));
vi.mock("../agent-aws-profiles", () => ({
	setAgentAwsProfiles: vi.fn(async () => ({ agentId: "claude", name: "Claude", provider: "bedrock", profiles: [], defaultProfile: null })),
}));
vi.mock("../agents", () => ({ getAllAgents: vi.fn(async () => []) }));

import { agentHandlers } from "../cli-socket/agent-commands";

describe("agent.awsProfiles.set", () => {
	it("tells the user on screen, since any agent can move every later launch to another AWS account", async () => {
		await agentHandlers["agent.awsProfiles.set"]!({ agentId: "claude", profiles: [] });
		expect(pushCliToast).toHaveBeenCalledWith(expect.objectContaining({ messageKey: "kanban.awsProfilesChangedFromCli", level: "info" }));
	});
});
