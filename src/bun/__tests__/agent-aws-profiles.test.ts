import { describe, expect, it } from "vitest";
import { validateAwsProfiles } from "../agent-aws-profiles";

describe("validateAwsProfiles", () => {
	it("trims entries and drops an empty region", () => {
		expect(validateAwsProfiles([{ name: " og ", awsProfile: " og-aws ", region: " " }], "og")).toEqual({
			profiles: [{ name: "og", awsProfile: "og-aws" }],
			defaultProfile: "og",
		});
	});
	it("rejects duplicate names", () => {
		expect(() => validateAwsProfiles([{ name: "og", awsProfile: "a" }, { name: "og", awsProfile: "b" }], undefined)).toThrow("twice");
	});
	it("rejects an entry missing its AWS profile", () => {
		expect(() => validateAwsProfiles([{ name: "og" }], undefined)).toThrow("needs both");
	});
	it("rejects a default that is not listed", () => {
		expect(() => validateAwsProfiles([{ name: "og", awsProfile: "a" }], "kort")).toThrow("not in the list");
	});
	it("accepts an empty list (clear)", () => {
		expect(validateAwsProfiles([], undefined)).toEqual({ profiles: [], defaultProfile: undefined });
	});
});
