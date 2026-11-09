import { describe, expect, it } from "vitest";
import { parseAwsProfileSpec } from "../commands/agent";

describe("parseAwsProfileSpec", () => {
	it("reads name, AWS profile and region", () => {
		expect(parseAwsProfileSpec("og=og-aws-claude-code,us-west-2")).toEqual({ name: "og", awsProfile: "og-aws-claude-code", region: "us-west-2" });
	});
	it("leaves the region out when not given", () => {
		expect(parseAwsProfileSpec("sandbox=sandbox-aws")).toEqual({ name: "sandbox", awsProfile: "sandbox-aws" });
	});
	it.each(["og", "=x", "og=", "og=a,b,c"])("rejects %s", (spec) => {
		expect(() => parseAwsProfileSpec(spec)).toThrow("<name>=<AWS_PROFILE>");
	});
});
