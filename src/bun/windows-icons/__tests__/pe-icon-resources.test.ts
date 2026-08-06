import { describe, expect, it } from "vitest";
import { hasEmbeddedIcon, PeFormatError, readResourceTypeIds, RT_GROUP_ICON, RT_ICON } from "../pe-icon-resources";
import { buildPeFixture, PE_WITH_ICON, PE_WITHOUT_ICON } from "./pe-fixture";

describe("readResourceTypeIds", () => {
	it("lists the resource types an executable carries", () => {
		expect(readResourceTypeIds(PE_WITH_ICON())).toEqual([RT_ICON, RT_GROUP_ICON, 16]);
	});

	it("returns nothing when the executable has no resource directory", () => {
		expect(readResourceTypeIds(buildPeFixture({ resourceTypeIds: [], withoutResourceDirectory: true }))).toEqual([]);
	});

	it("names the cause and the fix when handed something that is not a PE", () => {
		const notAnExe = new TextEncoder().encode("#!/usr/bin/env bun\nconsole.log('hi')\n".padEnd(128, " "));
		expect(() => readResourceTypeIds(notAnExe)).toThrow(PeFormatError);
		expect(() => readResourceTypeIds(notAnExe)).toThrow(/not a Windows executable.*Fix: point the icon proof at the packaged \.exe/s);
	});

	it("names the cause and the fix when the file is truncated", () => {
		expect(() => readResourceTypeIds(PE_WITH_ICON().slice(0, 8))).toThrow(/truncated or is not a PE executable.*Fix: rebuild/s);
	});

	it("refuses a resource directory no section contains", () => {
		const orphaned = buildPeFixture({ resourceTypeIds: [RT_ICON, RT_GROUP_ICON] });
		// Move the resource directory RVA away from the .rsrc section.
		const peOffset = new DataView(orphaned.buffer).getUint32(0x3c, true);
		new DataView(orphaned.buffer).setUint32(peOffset + 4 + 20 + 112 + 2 * 8, 0x99000, true);
		expect(() => readResourceTypeIds(orphaned)).toThrow(/No PE section contains the resource directory.*do not ship this binary/s);
	});
});

describe("hasEmbeddedIcon", () => {
	it("accepts an executable carrying both the images and the group that indexes them", () => {
		expect(hasEmbeddedIcon(PE_WITH_ICON())).toBe(true);
	});

	it("rejects the executable electrobun's swallowed rcedit failure leaves behind", () => {
		expect(hasEmbeddedIcon(PE_WITHOUT_ICON())).toBe(false);
	});

	// Windows needs both: a group with no images, or images with no group, renders
	// as the default icon just like having neither.
	it.each([
		["only RT_ICON", [RT_ICON]],
		["only RT_GROUP_ICON", [RT_GROUP_ICON]],
	])("rejects an executable with %s", (_label, resourceTypeIds) => {
		expect(hasEmbeddedIcon(buildPeFixture({ resourceTypeIds }))).toBe(false);
	});
});
