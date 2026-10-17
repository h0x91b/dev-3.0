import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOWNLOAD_TTL_MS, FILE_LINK_SANDBOX, attachmentDisposition, mintFileLink, openCheckedFile, openFileLinkResponses, resetFileLinks, resolveFileLinkPath, serveFileLink } from "../file-links";
import { spawnSync } from "node:child_process";

const ROOT = `${process.env.DEV3_TEST_ROOT}/file-links`;
const REPORT = join(ROOT, "worktree", "report");
const SECRET = join(ROOT, "worktree", "secret.txt");

function get(path: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<Response> {
	const url = new URL(`http://x${path}`);
	return serveFileLink(new Request(url, init), url);
}

function reportLink(): { link: string; base: string } {
	const link = mintFileLink({ kind: "dir", root: REPORT, entry: "index.html" });
	return { link, base: link.slice(0, -"index.html".length) };
}

beforeAll(() => {
	mkdirSync(join(REPORT, "assets"), { recursive: true });
	mkdirSync(join(REPORT, ".git"), { recursive: true });
	writeFileSync(join(REPORT, "index.html"), "<script>document.title='x'</script>");
	writeFileSync(join(REPORT, "assets", "style.css"), "body{}");
	writeFileSync(join(REPORT, "spec.md"), "# Spec\n");
	writeFileSync(join(REPORT, "picture.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
	writeFileSync(join(REPORT, "Makefile"), "all:\n\techo hi\n");
	writeFileSync(join(REPORT, "blob.dat"), Buffer.from([1, 2, 0, 3]));
	writeFileSync(join(REPORT, "doc.pdf"), "%PDF-1.4");
	writeFileSync(join(REPORT, "ten.txt"), "0123456789");
	writeFileSync(join(REPORT, "big.txt"), "x".repeat(3 * 1024 * 1024));
	writeFileSync(join(REPORT, ".env"), "TOKEN=1");
	writeFileSync(join(REPORT, ".git", "config"), "[core]");
	writeFileSync(SECRET, "do not serve");
	symlinkSync(SECRET, join(REPORT, "leak.txt"));
	symlinkSync(join(ROOT, "worktree"), join(REPORT, "up"));
	symlinkSync(join(REPORT, ".env"), join(REPORT, "e"));
	mkdirSync(join(REPORT, "sub"), { recursive: true });
});

beforeEach(() => resetFileLinks());

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("mintFileLink / resolveFileLinkPath", () => {
	it("serves the folder's tree under a folder link and nothing above it", () => {
		const { link, base } = reportLink();
		expect(link).toMatch(/^\/file\/[A-Za-z0-9_-]{32}\/index\.html$/);
		expect(resolveFileLinkPath(link)).toBe(join(REPORT, "index.html"));
		expect(resolveFileLinkPath(`${base}assets/style.css`)).toBe(join(REPORT, "assets", "style.css"));
		for (const escape of ["../secret.txt", "%2E%2E/secret.txt", "..%2Fsecret.txt", "..%5Csecret.txt", "", "%E0%A4%A"]) {
			expect(resolveFileLinkPath(`${base}${escape}`)).toBeNull();
		}
	});

	it("refuses dot-files and dot-folders under a folder link, however the URL spells them", () => {
		const { base } = reportLink();
		for (const spelled of [".env", ".git/config", "%2Eenv", "x%2F..%2F.env", "sub%2F..%2F.env", "sub/..%2F.env", "assets%2F..%2F.git%2Fconfig"]) {
			expect(resolveFileLinkPath(`${base}${spelled}`)).toBeNull();
		}
	});

	it("refuses a symlink that leads to a dot-file inside the folder", () => {
		expect(resolveFileLinkPath(`${reportLink().base}e`)).toBeNull();
	});

	it("rejects encoded separators even when they would land inside the folder", () => {
		const { base } = reportLink();
		expect(resolveFileLinkPath(`${base}assets%2Fstyle.css`)).toBeNull();
		expect(resolveFileLinkPath(`${base}a%2F..%2F..%2Fsecret.txt`)).toBeNull();
		expect(resolveFileLinkPath(`${base}assets//style.css`)).toBeNull();
	});

	it("follows symlinks only while they stay inside the folder", () => {
		const { base } = reportLink();
		expect(resolveFileLinkPath(`${base}leak.txt`)).toBeNull();
		expect(resolveFileLinkPath(`${base}up/secret.txt`)).toBeNull();
	});

	it("serves exactly one name under a file link, and not a symlink swapped in after minting", () => {
		const path = join(ROOT, "worktree", "one.md");
		writeFileSync(path, "# one");
		const link = mintFileLink({ kind: "file", path });
		expect(resolveFileLinkPath(link)).toBe(path);
		expect(resolveFileLinkPath(link.replace("one.md", "secret.txt"))).toBeNull();
		rmSync(path);
		symlinkSync(SECRET, path);
		expect(resolveFileLinkPath(link)).toBeNull();
		rmSync(path);
	});

	it("mints a fresh token on every call and forgets one once expired", () => {
		const now = 1_000_000;
		const first = mintFileLink({ kind: "file", path: join(REPORT, "spec.md") }, { now });
		expect(mintFileLink({ kind: "file", path: join(REPORT, "spec.md") }, { now })).not.toBe(first);
		expect(resolveFileLinkPath(first, now + 11 * 60 * 60 * 1000)).not.toBeNull();
		expect(resolveFileLinkPath(first, now + 13 * 60 * 60 * 1000)).toBeNull();
		expect(resolveFileLinkPath("/file/not-a-token/spec.md")).toBeNull();
	});

	it("lets a download link live only briefly", () => {
		const now = 1_000_000;
		const link = mintFileLink({ kind: "file", path: join(REPORT, "spec.md") }, { now, ttlMs: DOWNLOAD_TTL_MS });
		expect(resolveFileLinkPath(link, now + DOWNLOAD_TTL_MS - 1)).not.toBeNull();
		expect(resolveFileLinkPath(link, now + DOWNLOAD_TTL_MS)).toBeNull();
	});

	it("evicts the least recently used link past the cap, not one still in use", () => {
		const spec = { kind: "file" as const, path: join(REPORT, "spec.md") };
		const inUse = mintFileLink(spec);
		const idle = mintFileLink(spec);
		for (let i = 0; i < 254; i++) mintFileLink(spec);
		expect(resolveFileLinkPath(inUse)).not.toBeNull();
		mintFileLink(spec);
		expect(resolveFileLinkPath(idle)).toBeNull();
		expect(resolveFileLinkPath(inUse)).not.toBeNull();
	});

	it("serves a POSIX file whose name holds a backslash", () => {
		if (process.platform === "win32") return;
		const odd = join(REPORT, "a\\b.txt");
		writeFileSync(odd, "x");
		const link = mintFileLink({ kind: "file", path: odd });
		expect(resolveFileLinkPath(link)).toBe(odd);
		rmSync(odd);
	});
});

describe("serveFileLink", () => {
	it("sandboxes HTML without same-origin, so an agent's page cannot act as the signed-in user", async () => {
		const res = await get(reportLink().link);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toBe(FILE_LINK_SANDBOX);
		expect(csp).toMatch(/^sandbox /);
		expect(csp).not.toContain("allow-same-origin");
		expect(csp).not.toContain("allow-forms");
		expect(csp).not.toContain("allow-modals");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await res.text()).toContain("<script>");
	});

	it("sandboxes Markdown, SVG and plain text too — an extension may inject script into them", async () => {
		const { base } = reportLink();
		for (const [name, type] of [["spec.md", "text/markdown; charset=utf-8"], ["picture.svg", "image/svg+xml"], ["Makefile", "text/plain; charset=utf-8"]]) {
			const res = await get(`${base}${name}`);
			expect(res.headers.get("content-type")).toBe(type);
			expect(res.headers.get("content-security-policy")).toBe(FILE_LINK_SANDBOX);
		}
		expect(await (await get(`${base}spec.md`)).text()).toBe("# Spec\n");
	});

	it("never renders a PDF on the dev3 origin, plays media unsandboxed, and downloads unknown binary", async () => {
		const { base } = reportLink();
		const pdf = await get(`${base}doc.pdf`);
		expect(pdf.headers.get("content-type")).toBe("application/octet-stream");
		expect(pdf.headers.get("content-disposition")).toMatch(/^attachment; filename="doc\.pdf"/);
		writeFileSync(join(REPORT, "clip.mp4"), "MP4");
		const clip = await get(`${base}clip.mp4`);
		expect(clip.headers.get("content-type")).toBe("video/mp4");
		expect(clip.headers.get("content-security-policy")).toBeNull();
		expect((await get(`${base}blob.dat`)).headers.get("content-type")).toBe("application/octet-stream");
	});

	it("answers HEAD and byte ranges", async () => {
		const { base } = reportLink();
		const head = await get(`${base}ten.txt`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe("10");
		expect(await head.text()).toBe("");
		const range = await get(`${base}ten.txt`, { headers: { range: "bytes=2-4" } });
		expect(range.status).toBe(206);
		expect(range.headers.get("content-range")).toBe("bytes 2-4/10");
		expect(await range.text()).toBe("234");
	});

	it("turns any file into an attachment with ?download=1", async () => {
		const res = await get(`${reportLink().link}?download=1`);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("content-disposition")).toBe(`attachment; filename="index.html"; filename*=UTF-8''index.html`);
		expect(res.headers.get("content-security-policy")).toBeNull();
	});

	it("404s an unknown token, an escape, a folder, and a file that vanished; 405s writes", async () => {
		const { link, base } = reportLink();
		expect((await get("/file/nope/index.html")).status).toBe(404);
		expect((await get(`${base}..%2Fsecret.txt`)).status).toBe(404);
		expect((await get(`${base}assets`)).status).toBe(404);
		expect((await get(link, { method: "POST" })).status).toBe(405);
		const gone = join(REPORT, "gone.txt");
		writeFileSync(gone, "x");
		rmSync(gone);
		expect((await get(`${base}gone.txt`)).status).toBe(404);
	});
});

describe("openCheckedFile", () => {
	// The race the reviewer won 20 times in ~900 requests: the path is checked,
	// then a folder on it is swapped for a symlink before the file is opened.
	it("refuses to hand over a file reached through a folder swapped in after the check", async () => {
		const base = join(ROOT, "swap");
		mkdirSync(join(base, "docs"), { recursive: true });
		mkdirSync(join(base, "secret"), { recursive: true });
		writeFileSync(join(base, "docs", "data.txt"), "public");
		writeFileSync(join(base, "secret", "data.txt"), "SECRET-KEY");
		const link = mintFileLink({ kind: "dir", root: join(base, "docs"), entry: "data.txt" });
		const checked = resolveFileLinkPath(link);
		expect(checked).toBe(join(base, "docs", "data.txt"));

		renameSync(join(base, "docs"), join(base, "real-docs"));
		symlinkSync(join(base, "secret"), join(base, "docs"));
		expect(await openCheckedFile(checked!)).toBeNull();

		rmSync(join(base, "docs"));
		renameSync(join(base, "real-docs"), join(base, "docs"));
		const handle = await openCheckedFile(checked!);
		expect(handle).not.toBeNull();
		await handle!.close();
	});
});

describe("open response cap", () => {
	// Bigger than one 1 MB read, so the body is still unsent after the eager first pull.
	it("holds a slot until the body is read or abandoned, and refuses past 32", async () => {
		const { base } = reportLink();
		const pending: Response[] = [];
		for (let i = 0; i < 32; i++) pending.push(await get(`${base}big.txt`));
		await new Promise((r) => setTimeout(r, 20));
		expect(openFileLinkResponses()).toBe(32);
		expect((await get(`${base}big.txt`)).status).toBe(503);
		await pending[0].text();
		await pending[1].body!.cancel();
		expect(openFileLinkResponses()).toBe(30);
		expect((await get(`${base}big.txt`, { method: "HEAD" })).status).toBe(200);
		expect(openFileLinkResponses()).toBe(30);
		await Promise.all(pending.slice(2).map((res) => res.body!.cancel()));
		expect(openFileLinkResponses()).toBe(0);
	});

	it("does not hang on a FIFO planted in the folder", async () => {
		if (process.platform === "win32") return;
		const fifo = join(REPORT, "pipe");
		if (spawnSync("mkfifo", [fifo]).status !== 0) return;
		try {
			const res = await Promise.race([get(`${reportLink().base}pipe`), new Promise<"hung">((r) => setTimeout(() => r("hung"), 2000))]);
			expect(res).not.toBe("hung");
			expect((res as Response).status).toBe(404);
			expect(openFileLinkResponses()).toBe(0);
		} finally {
			rmSync(fifo, { force: true });
		}
	});
});

describe("attachmentDisposition", () => {
	it("keeps the exact UTF-8 name and an ASCII fallback without quotes", () => {
		expect(attachmentDisposition('отчёт "v2".md')).toBe(
			`attachment; filename="_____ _v2_.md"; filename*=UTF-8''${encodeURIComponent('отчёт "v2".md')}`,
		);
	});
});
