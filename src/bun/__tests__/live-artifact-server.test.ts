import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Project, Task } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/live-artifact-server`);

vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME, OPS_DIR: `${TEST_HOME}/ops` }));

import { createLiveFetch, findTokenOnDisk, liveTokenFor } from "../live-artifact-server";
import { readLiveState } from "../live-artifact-store";

const PORT = 47001;
const TOKEN = "abcdefghijklmnopqrstuvwx";
const PAGE_DIR = `${TEST_HOME}/page`;
const project = { id: "p1", path: "/tmp/live-server-proj" } as Project;
let task: Task;
let seq = 0;
const sendToAgent = vi.fn(async () => undefined);
const addComment = vi.fn(async () => ({ id: "c-1", sent: true }));

const fetchLive = createLiveFetch({
	port: () => PORT,
	resolveToken: async (token) => (token === TOKEN ? { project, task } : null),
	sendToAgent,
	addComment,
});

function get(path: string, headers: Record<string, string> = {}) {
	return fetchLive(new Request(`http://127.0.0.1:${PORT}${path}`, { headers: { host: `127.0.0.1:${PORT}`, ...headers } }));
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
	return fetchLive(new Request(`http://127.0.0.1:${PORT}${path}`, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json", ...headers },
	}));
}

afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

beforeEach(() => {
	sendToAgent.mockClear();
	addComment.mockClear();
	mkdirSync(PAGE_DIR, { recursive: true });
	writeFileSync(`${PAGE_DIR}/index.html`, "<!doctype html><html><head><title>t</title></head><body>hi</body></html>");
	writeFileSync(`${PAGE_DIR}/app.css`, "body{}");
	task = {
		id: `00000000-0000-4000-a000-${String(++seq).padStart(12, "0")}`,
		status: "in-progress",
		liveArtifact: {
			pageRev: 7,
			createdAt: 1,
			updatedAt: 1,
			page: {
				id: "a", kind: "html", title: "Board", name: "index.html", storedPath: `${PAGE_DIR}/index.html`, originalPath: "/x", bytes: 1, createdAt: 1,
				assets: [{ name: "app.css", storedPath: `${PAGE_DIR}/app.css`, originalPath: "/x/app.css", mime: "text/css", bytes: 6 }],
			},
		},
	} as Task;
});

describe("live server guards", () => {
	it("refuses a Host it is not (DNS rebinding)", async () => {
		expect((await get(`/${TOKEN}/`, { host: `evil.example:${PORT}` })).status).toBe(421);
	});

	it("answers the browser's own favicon request quietly", async () => {
		expect((await get("/favicon.ico")).status).toBe(204);
	});

	it("does not tell a wrong token from a missing page", async () => {
		expect((await get("/nope/")).status).toBe(404);
		expect((await get("/bcdefghijklmnopqrstuvwxy/")).status).toBe(404);
	});

	it("refuses writes that are not JSON or come from another origin", async () => {
		const form = await fetchLive(new Request(`http://127.0.0.1:${PORT}/${TOKEN}/api/set`, { method: "POST", body: "a=1", headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/x-www-form-urlencoded" } }));
		expect(form.status).toBe(415);
		expect((await post(`/${TOKEN}/api/set`, {}, { origin: "https://evil.example" })).status).toBe(403);
	});
});

describe("live server pages", () => {
	it("serves a shell with the picker around the page, never inside it", async () => {
		const shell = await (await get(`/${TOKEN}/`)).text();
		expect(shell).toContain('id="live-pick"');
		expect(shell).toContain('<iframe id="live-frame" src="_page"');
		expect(shell).not.toContain("data-dev3-live-client");
		const page = await (await get(`/${TOKEN}/_page`)).text();
		expect(page).not.toContain("live-pick");
		expect(page).not.toContain("installArtifactCommentTools");
	});

	it("hides Pick once the task is finished", async () => {
		task = { ...task, status: "completed" };
		expect(await (await get(`/${TOKEN}/`)).text()).toContain('id="live-pick" hidden');
	});

	it("serves the page with the http client wired to its token base", async () => {
		const response = await get(`/${TOKEN}/_page`);
		const html = await response.text();
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("data-dev3-live-client");
		expect(html).toContain(`"base":"/${TOKEN}/"`);
		expect(html).toContain('"pageRev":7');
	});

	it("redirects the bare token to its directory so relative assets resolve", async () => {
		const response = await get(`/${TOKEN}`);
		expect(response.status).toBe(308);
		expect(response.headers.get("location")).toBe(`/${TOKEN}/`);
	});

	it("serves only files the page was published with", async () => {
		expect(await (await get(`/${TOKEN}/app.css`)).text()).toBe("body{}");
		expect((await get(`/${TOKEN}/index.html.bak`)).status).toBe(404);
		expect((await get(`/${TOKEN}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
	});
});

describe("static artifacts in the shell", () => {
	beforeEach(() => {
		writeFileSync(`${PAGE_DIR}/old.html`, "<html><head></head><body>old</body></html>");
		task = {
			...task,
			sharedArtifacts: [{
				id: "art-1", kind: "html", title: "Report", name: "index.html", storedPath: `${PAGE_DIR}/index.html`, originalPath: "/x", bytes: 1, createdAt: 1, version: 2,
				assets: [{ name: "app.css", storedPath: `${PAGE_DIR}/app.css`, originalPath: "/x/app.css", mime: "text/css", bytes: 6 }],
				previousVersions: [{ version: 1, name: "index.html", storedPath: `${PAGE_DIR}/old.html`, originalPath: "/x", bytes: 1, createdAt: 1, assets: [] }],
			}],
		} as Task;
	});

	it("serves a version inside the same shell, with no live client in the page", async () => {
		const shell = await (await get(`/${TOKEN}/a/art-1/1/`)).text();
		expect(shell).toContain('<span class="badge">v1</span>');
		expect(shell).toContain('"artifact":{"id":"art-1","version":1}');
		const page = await (await get(`/${TOKEN}/a/art-1/1/_page`)).text();
		expect(page).toContain("old");
		expect(page).not.toContain("data-dev3-live-client");
		expect(await (await get(`/${TOKEN}/a/art-1/2/app.css`)).text()).toBe("body{}");
		expect((await get(`/${TOKEN}/a/art-1/1/app.css`)).status).toBe(404);
	});

	it("redirects a bare version to its directory and 404s an unknown one", async () => {
		expect((await get(`/${TOKEN}/a/art-1/2`)).headers.get("location")).toBe(`/${TOKEN}/a/art-1/2/`);
		expect((await get(`/${TOKEN}/a/art-1/7/`)).status).toBe(404);
		expect((await get(`/${TOKEN}/a/art-1/x/`)).status).toBe(404);
	});

	it("anchors a comment to the static version the tab shows", async () => {
		await post(`/${TOKEN}/api/comment`, { artifact: { id: "art-1", version: 1 }, selector: "p", body: "Fix" });
		expect(addComment).toHaveBeenCalledWith(project, task, expect.objectContaining({ artifactId: "art-1", version: 1 }), expect.objectContaining({ body: "Fix" }));
		expect((await post(`/${TOKEN}/api/comment`, { artifact: { id: "nope", version: 1 }, selector: "p", body: "Fix" })).status).toBe(400);
	});
});

describe("live server operations", () => {
	it("writes as the user and logs the event for the agent", async () => {
		const response = await post(`/${TOKEN}/api/set`, { collection: "cards", id: "c1", data: { answer: "approve" } });
		expect(response.status).toBe(200);
		const state = await readLiveState(project.path, task.id);
		expect(state.collections.cards.c1.updatedBy).toBe("user");
		expect(state.events).toHaveLength(1);
	});

	it("maps a stale write to 409 and a finished task to 423", async () => {
		await post(`/${TOKEN}/api/set`, { collection: "cards", id: "c1", data: 1 });
		const stale = await post(`/${TOKEN}/api/set`, { collection: "cards", id: "c1", data: 2, ifRev: 0 });
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ reason: "conflict" });
		task = { ...task, status: "completed" };
		expect((await post(`/${TOKEN}/api/set`, { collection: "cards", id: "c1", data: 3 })).status).toBe(423);
		expect((await post(`/${TOKEN}/api/state`, {})).status).toBe(200);
	});

	it("send wraps the text in the artifact envelope for the agent", async () => {
		await post(`/${TOKEN}/api/send`, { text: "Approved 2 cards" });
		expect(sendToAgent).toHaveBeenCalledWith(task, expect.stringContaining("<artifact-title>Board (live)</artifact-title>"));
	});

	it("stores a picked-element comment through the review path", async () => {
		const response = await post(`/${TOKEN}/api/comment`, { selector: "#plan > li:nth-of-type(2)", text: "Step two", heading: "Plan", body: "Split this", send: true });
		expect(await response.json()).toEqual({ result: { id: "c-1", sent: true } });
		expect(addComment).toHaveBeenCalledWith(project, task, expect.objectContaining({ artifactId: `live:${task.id}`, version: 1 }), { selector: "#plan > li:nth-of-type(2)", text: "Step two", heading: "Plan", body: "Split this", send: true });
	});

	it("refuses a comment with nothing to say or nothing picked", async () => {
		expect((await post(`/${TOKEN}/api/comment`, { selector: "#a", body: "  " })).status).toBe(400);
		expect((await post(`/${TOKEN}/api/comment`, { selector: "", body: "x" })).status).toBe(400);
		expect(addComment).not.toHaveBeenCalled();
	});

	it("lists the live page's pins, ignoring comments on other artifacts", async () => {
		task = {
			...task,
			review: [
				{ id: "a", body: "Fix", createdAt: "t", anchor: { kind: "artifact-element", artifactId: `live:${task.id}`, version: 1, title: "Board", selector: "#x", text: "X", heading: null } },
				{ id: "b", body: "Other", createdAt: "t", anchor: { kind: "artifact-element", artifactId: "other", version: 1, title: "O", selector: "#y", text: "Y", heading: null } },
			],
		} as Task;
		const { result } = await (await post(`/${TOKEN}/api/comments`, {})).json();
		expect(result).toEqual([{ id: "a", n: 1, selector: "#x", text: "X", heading: null, resolved: false, active: false, body: "Fix" }]);
	});

	it("opens a stream that starts with the page revision and the store", async () => {
		const response = await get(`/${TOKEN}/api/stream`);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = response.body!.getReader();
		let text = "";
		while (!text.includes("event: snapshot")) text += new TextDecoder().decode((await reader.read()).value);
		await reader.cancel();
		expect(text.indexOf("event: page")).toBeLessThan(text.indexOf("event: snapshot"));
		expect(text).toContain('"pageRev":7');
	});
});

describe("tokens", () => {
	it("mints once, persists beside the store and is found again after a restart", () => {
		const token = liveTokenFor(project, task.id);
		expect(liveTokenFor(project, task.id)).toBe(token);
		expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
		expect(findTokenOnDisk(token, [project])).toEqual({ projectId: "p1", taskId: task.id });
		expect(findTokenOnDisk("zzzzzzzzzzzzzzzzzzzzzzzz", [project])).toBeNull();
	});
});
