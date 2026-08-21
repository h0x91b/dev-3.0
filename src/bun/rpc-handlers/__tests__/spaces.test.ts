import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Space, SpacesFile } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
	loadSpacesFile: vi.fn(),
	createSpace: vi.fn(),
	renameSpace: vi.fn(),
	setSpaceSensitive: vi.fn(),
	deleteSpace: vi.fn(),
	setProjectSpaces: vi.fn(),
	reorderSpaces: vi.fn(),
	reorderSpaceProjects: vi.fn(),
	pushMessage: vi.fn(),
}));

vi.mock("../../spaces-data", () => ({
	loadSpacesFile: mocks.loadSpacesFile,
	createSpace: mocks.createSpace,
	renameSpace: mocks.renameSpace,
	setSpaceSensitive: mocks.setSpaceSensitive,
	deleteSpace: mocks.deleteSpace,
	setProjectSpaces: mocks.setProjectSpaces,
	reorderSpaces: mocks.reorderSpaces,
	reorderSpaceProjects: mocks.reorderSpaceProjects,
}));

vi.mock("../shared", () => ({
	getPushMessage: () => mocks.pushMessage,
}));

import { spacesHandlers } from "../spaces";

const space: Space = { id: "sp_1", name: "A", parentId: null, projectIds: ["p1"], createdAt: 1 };
const file: SpacesFile = { version: 1, spaces: [space], order: ["sp_1"] };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadSpacesFile.mockResolvedValue(file);
});

describe("spacesHandlers", () => {
	it("getSpaces delegates to loadSpacesFile and does not push", async () => {
		expect(await spacesHandlers.getSpaces({})).toEqual(file);
		expect(mocks.pushMessage).not.toHaveBeenCalled();
	});

	it("setSpaceSensitive delegates and pushes, so every window remasks at once", async () => {
		const marked = { ...space, sensitive: true };
		mocks.setSpaceSensitive.mockResolvedValue(marked);
		expect(await spacesHandlers.setSpaceSensitive({ spaceId: "sp_1", sensitive: true })).toEqual(marked);
		expect(mocks.setSpaceSensitive).toHaveBeenCalledWith("sp_1", true);
		expect(mocks.pushMessage).toHaveBeenCalledWith("spacesUpdated", { file });
	});

	it("createSpace delegates and pushes spacesUpdated with the fresh file", async () => {
		mocks.createSpace.mockResolvedValue(space);
		expect(await spacesHandlers.createSpace({ name: "A", projectIds: ["p1"] })).toEqual(space);
		expect(mocks.createSpace).toHaveBeenCalledWith("A", ["p1"]);
		expect(mocks.pushMessage).toHaveBeenCalledWith("spacesUpdated", { file });
	});

	it("renameSpace delegates and pushes", async () => {
		mocks.renameSpace.mockResolvedValue({ ...space, name: "B" });
		expect((await spacesHandlers.renameSpace({ spaceId: "sp_1", name: "B" })).name).toBe("B");
		expect(mocks.renameSpace).toHaveBeenCalledWith("sp_1", "B");
		expect(mocks.pushMessage).toHaveBeenCalledWith("spacesUpdated", { file });
	});

	it("deleteSpace delegates and pushes", async () => {
		mocks.deleteSpace.mockResolvedValue(undefined);
		await spacesHandlers.deleteSpace({ spaceId: "sp_1" });
		expect(mocks.deleteSpace).toHaveBeenCalledWith("sp_1");
		expect(mocks.pushMessage).toHaveBeenCalledWith("spacesUpdated", { file });
	});

	it("setProjectSpaces delegates, returns autoDeleted, and pushes", async () => {
		mocks.setProjectSpaces.mockResolvedValue({ file, autoDeleted: [space] });
		const result = await spacesHandlers.setProjectSpaces({ projectId: "p1", spaceIds: [] });
		expect(result.autoDeleted).toEqual([space]);
		expect(mocks.setProjectSpaces).toHaveBeenCalledWith("p1", []);
		expect(mocks.pushMessage).toHaveBeenCalledWith("spacesUpdated", { file });
	});

	it("reorderSpaces and reorderSpaceProjects delegate and push", async () => {
		mocks.reorderSpaces.mockResolvedValue(file);
		mocks.reorderSpaceProjects.mockResolvedValue(space);
		await spacesHandlers.reorderSpaces({ order: ["sp_1"] });
		expect(mocks.reorderSpaces).toHaveBeenCalledWith(["sp_1"]);
		await spacesHandlers.reorderSpaceProjects({ spaceId: "sp_1", projectIds: ["p1"] });
		expect(mocks.reorderSpaceProjects).toHaveBeenCalledWith("sp_1", ["p1"]);
		expect(mocks.pushMessage).toHaveBeenCalledTimes(2);
	});
});
