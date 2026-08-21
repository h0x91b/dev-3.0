import type { Space, SpacesFile } from "../../shared/types";
import * as spacesData from "../spaces-data";
import { getPushMessage } from "./shared";

/** Broadcast the fresh file after any mutation so every window stays in sync. */
async function pushSpacesUpdated(): Promise<void> {
	const file = await spacesData.loadSpacesFile();
	getPushMessage()?.("spacesUpdated", { file });
}

async function getSpaces(_params: Record<string, never>): Promise<SpacesFile> {
	return spacesData.loadSpacesFile();
}

async function createSpace(params: { name: string; projectIds: string[] }): Promise<Space> {
	const space = await spacesData.createSpace(params.name, params.projectIds);
	await pushSpacesUpdated();
	return space;
}

async function renameSpace(params: { spaceId: string; name: string }): Promise<Space> {
	const space = await spacesData.renameSpace(params.spaceId, params.name);
	await pushSpacesUpdated();
	return space;
}

async function setSpaceSensitive(params: { spaceId: string; sensitive: boolean }): Promise<Space> {
	const space = await spacesData.setSpaceSensitive(params.spaceId, params.sensitive);
	await pushSpacesUpdated();
	return space;
}

async function deleteSpace(params: { spaceId: string }): Promise<void> {
	await spacesData.deleteSpace(params.spaceId);
	await pushSpacesUpdated();
}

async function setProjectSpaces(
	params: { projectId: string; spaceIds: string[] },
): Promise<{ file: SpacesFile; autoDeleted: Space[] }> {
	const result = await spacesData.setProjectSpaces(params.projectId, params.spaceIds);
	await pushSpacesUpdated();
	return result;
}

async function reorderSpaces(params: { order: string[] }): Promise<SpacesFile> {
	const file = await spacesData.reorderSpaces(params.order);
	await pushSpacesUpdated();
	return file;
}

async function reorderSpaceProjects(params: { spaceId: string; projectIds: string[] }): Promise<Space> {
	const space = await spacesData.reorderSpaceProjects(params.spaceId, params.projectIds);
	await pushSpacesUpdated();
	return space;
}

export const spacesHandlers = {
	getSpaces,
	createSpace,
	renameSpace,
	setSpaceSensitive,
	deleteSpace,
	setProjectSpaces,
	reorderSpaces,
	reorderSpaceProjects,
};
