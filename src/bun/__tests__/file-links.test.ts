import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentDisposition, mintFileLink, resetFileLinks, resolveFileLinkPath, serveFileLink } from "../file-links";

const ROOT = `${process.env.DEV3_TEST_ROOT}/file-links`;
const REPORT = join(ROOT, "worktree", "report");
const SECRET = join(ROOT, "worktree", "secret.txt");

function get(path: string, method = "GET"): Promise<Response> {
	const url = new URL(`http://x${path}`);
	return serveFileLink(new Request(url, { method }), url);
}

beforeAll(() => {
	mkdirSync(join(REPORT, "assets"), { recursive: true });
	writeFileSync(join(REPORT, "index.html"), "<script>document.title='x'</script>");
	writeFileSync(join(REPORT, "assets", "style.css"), "body{}");
	writeFileSync(join(REPORT, "spec.md"), "# Spec\n");
	writeFileSync(join(REPORT, "picture.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
	writeFileSync(join(REPORT, "Makefile"), "all:\n\techo hi\n");
	writeFileSync(join(REPORT, "blob.dat"), Buffer.from([1, 2, 0, 3]));
	writeFileSync(join(REPORT, "doc.pdf"), "%PDF-1.4");
	writeFileSync(SECRET, "do not serve");
});

beforeEach(() => resetFileLinks());

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("mintFileLink / resolveFileLinkPath", () => {
	it("serves the folder's tree under a folder link and nothing above it", () => {
		const link = mintFileLink({ kind: "dir", root: REPORT, entry: "index.html" });
		expect(link).toMatch(/^\/file\/[A-Za-z0-9_-]{32}\/index\.html$/);
		const base = link.slice(0, -"index.html".length);
		expect(resolveFileLinkPath(link)).toBe(join(REPORT, "index.html"));
		expect(resolveFileLinkPath(`${base}assets/style.css`)).toBe(join(REPORT, "assets", "style.css"));
		expect(resolveFileLinkPath(`${base}../secret.txt`)).toBeNull();
		expect(resolveFileLinkPath(`${base}%2E%2E/secret.txt`)).toBeNull();
		expect(resolveFileLinkPath(`${base}..%2Fsecret.txt`)).toBeNull();
		expect(resolveFileLinkPath(`${base}`)).toBeNull();
		expect(resolveFileLinkPath(`${base}%E0%A4%A`)).toBeNull();
	});

	it("serves exactly one name under a file link", () => {
		const link = mintFileLink({ kind: "file", path: join(REPORT, "spec.md") });
		expect(resolveFileLinkPath(link)).toBe(join(REPORT, "spec.md"));
		expect(resolveFileLinkPath(link.replace("spec.md", "index.html"))).toBeNull();
	});

	it("reuses one token per scope and forgets it once expired", () => {
		const now = 1_000_000;
		const link = mintFileLink({ kind: "file", path: join(REPORT, "spec.md") }, now);
		expect(mintFileLink({ kind: "file", path: join(REPORT, "spec.md") }, now)).toBe(link);
		expect(resolveFileLinkPath(link, now + 11 * 60 * 60 * 1000)).not.toBeNull();
		expect(resolveFileLinkPath(link, now + 13 * 60 * 60 * 1000)).toBeNull();
		expect(resolveFileLinkPath("/file/not-a-token/spec.md")).toBeNull();
	});

	it("evicts the oldest link past the cap", () => {
		const first = mintFileLink({ kind: "file", path: "/a/0.txt" });
		for (let i = 1; i <= 256; i++) mintFileLink({ kind: "file", path: `/a/${i}.txt` });
		expect(resolveFileLinkPath(first)).toBeNull();
		expect(resolveFileLinkPath(mintFileLink({ kind: "file", path: "/a/256.txt" }))).toBe("/a/256.txt");
	});
});

describe("serveFileLink", () => {
	it("sandboxes HTML without same-origin, so an agent's page cannot act as the signed-in user", async () => {
		const res = await get(mintFileLink({ kind: "dir", root: REPORT, entry: "index.html" }));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toMatch(/^sandbox /);
		expect(csp).toContain("allow-scripts");
		expect(csp).not.toContain("allow-same-origin");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await res.text()).toContain("<script>");
	});

	it("sandboxes SVG too, since it can carry script", async () => {
		const res = await get(mintFileLink({ kind: "file", path: join(REPORT, "picture.svg") }));
		expect(res.headers.get("content-type")).toBe("image/svg+xml");
		expect(res.headers.get("content-security-policy")).toMatch(/^sandbox /);
	});

	it("hands Markdown over raw, for the browser or an extension to render", async () => {
		const res = await get(mintFileLink({ kind: "file", path: join(REPORT, "spec.md") }));
		expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
		expect(res.headers.get("content-security-policy")).toBeNull();
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await res.text()).toBe("# Spec\n");
	});

	it("shows unknown text as text, unknown binary as a download, and PDF unsandboxed", async () => {
		const base = mintFileLink({ kind: "dir", root: REPORT, entry: "index.html" }).slice(0, -"index.html".length);
		expect((await get(`${base}Makefile`)).headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect((await get(`${base}blob.dat`)).headers.get("content-type")).toBe("application/octet-stream");
		const pdf = await get(`${base}doc.pdf`);
		expect(pdf.headers.get("content-type")).toBe("application/pdf");
		expect(pdf.headers.get("content-security-policy")).toBeNull();
	});

	it("turns any file into an attachment with ?download=1", async () => {
		const res = await get(`${mintFileLink({ kind: "dir", root: REPORT, entry: "index.html" })}?download=1`);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("content-disposition")).toBe(`attachment; filename="index.html"; filename*=UTF-8''index.html`);
		expect(res.headers.get("content-security-policy")).toBeNull();
	});

	it("404s an unknown token, an escape or a folder, and 405s writes", async () => {
		const link = mintFileLink({ kind: "dir", root: REPORT, entry: "index.html" });
		expect((await get("/file/nope/index.html")).status).toBe(404);
		expect((await get(link.replace("index.html", "..%2Fsecret.txt"))).status).toBe(404);
		expect((await get(link.replace("index.html", "assets"))).status).toBe(404);
		expect((await get(link, "POST")).status).toBe(405);
	});
});

describe("attachmentDisposition", () => {
	it("keeps the exact UTF-8 name and an ASCII fallback without quotes", () => {
		expect(attachmentDisposition('отчёт "v2".md')).toBe(
			`attachment; filename="_____ _v2_.md"; filename*=UTF-8''${encodeURIComponent('отчёт "v2".md')}`,
		);
	});
});
