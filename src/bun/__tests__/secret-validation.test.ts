import { describe, expect, it } from "vitest";
import { secretTransportAllowed, validateSecretCommand } from "../../shared/secret-request";

describe("secret request validation", () => {
	it.each(["TOKEN=value", "", "1TOKEN", "TOKEN\0", "a".repeat(129)])("rejects invalid environment names", (name) => {
		expect(() => validateSecretCommand(name, ["upload"])).toThrow("valid environment variable");
	});
	it.each([[], [""], ["upload", "\0"], Array(129).fill("a"), ["a".repeat(32_769)], [42]])("rejects invalid command arguments", (command) => {
		expect(() => validateSecretCommand("TOKEN", command)).toThrow("Supply a command");
	});
	it("accepts literal arguments without reinterpreting shell characters", () => {
		expect(() => validateSecretCommand("API_TOKEN", ["upload", "a b", "$(example)"])).not.toThrow();
	});
	it.each([
		["https:", "example.com", true], ["http:", "example.com", false], ["http:", "localhost", true],
		["http:", "127.0.0.1", true], ["http:", "[::1]", true], ["views:", "mainview", true],
		["http:", "localhost.example.com", false],
	])("gates input transport %s %s", (protocol, hostname, allowed) => {
		expect(secretTransportAllowed({ protocol, hostname })).toBe(allowed);
	});
});
