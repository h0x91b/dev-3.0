/**
 * `/file/` over a real socket, under Bun. The vitest suite runs on Node against a
 * stubbed Bun and cannot see what Bun puts on the wire or how it treats a client
 * that disconnects — which is exactly where the slot and descriptor leaks hid.
 *
 *   bun run test:file-links-e2e
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintFileLink, mintFolderLink, openFileLinkResponses, serveFileLink } from "../file-links";

const dir = mkdtempSync(join(tmpdir(), "dev3-file-links-e2e-"));
mkdirSync(dir, { recursive: true });
const big = join(dir, "big.txt");
writeFileSync(big, "x".repeat(8 * 1024 * 1024));
const link = mintFileLink({ kind: "file", path: big });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => serveFileLink(req, new URL(req.url)) });
const port = server.port ?? 0;
const problems: string[] = [];

/** Raw HTTP/1.1 request; resolves with the header block, or as soon as `closeEarly` drops the socket. */
function rawRequest(headers: string, closeEarly = false): Promise<string> {
	return new Promise((resolve, reject) => {
		let received = "";
		Bun.connect({
			hostname: "127.0.0.1",
			port,
			socket: {
				open(socket) {
					socket.write(`GET ${link} HTTP/1.1\r\nHost: 127.0.0.1\r\n${headers}Connection: close\r\n\r\n`);
					if (closeEarly) {
						socket.end();
						resolve("");
					}
				},
				data(socket, chunk) {
					received += chunk.toString("latin1");
					const end = received.indexOf("\r\n\r\n");
					if (end >= 0) {
						socket.end();
						resolve(received.slice(0, end));
					}
				},
				error: (_socket, err) => reject(err),
				close: () => resolve(received),
			},
		}).catch(reject);
	});
}

// 1. A ranged reply keeps its Content-Length on the wire (WebKit rejects a chunked 206).
const head = (await rawRequest("Range: bytes=0-99\r\n")).toLowerCase();
if (!head.startsWith("http/1.1 206")) problems.push(`range reply is not 206: ${head.split("\r\n")[0]}`);
if (!/\r\ncontent-length: 100\b/.test(head)) problems.push("range reply has no Content-Length: 100 on the wire");
if (head.includes("transfer-encoding: chunked")) problems.push("range reply is chunked on the wire");

// 2. Clients that leave while the handler runs must not keep a slot (Bun never cancels their body).
// A handler that takes 100 ms stands in for a slow filesystem (WSL's /mnt/c, a network mount).
const slow = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => {
	await Bun.sleep(100);
	return serveFileLink(req, new URL(req.url));
} });
await Promise.all(Array.from({ length: 20 }, () => Bun.connect({
	hostname: "127.0.0.1",
	port: slow.port ?? 0,
	socket: {
		open(socket) {
			socket.write(`GET ${link} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
			setTimeout(() => socket.end(), 20);
		},
		data() {},
	},
})));
await Bun.sleep(2000);
if (openFileLinkResponses() !== 0) problems.push(`${openFileLinkResponses()} slots still held after clients left mid-handler`);
slow.stop(true);
const after = await fetch(`http://127.0.0.1:${port}${link}`, { headers: { range: "bytes=0-9" } });
if (after.status !== 206) problems.push(`a normal request after the disconnects got ${after.status}`);
await after.arrayBuffer();

// 3. Downloads aborted mid-body must not leak descriptors (Linux: /proc/self/fd).
if (process.platform === "linux") {
	const fds = () => readdirSync("/proc/self/fd").length;
	const before = fds();
	for (let i = 0; i < 20; i++) {
		const client = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}${link}`, { signal: client.signal });
		const reader = res.body!.getReader();
		await reader.read();
		client.abort();
		await reader.read().catch(() => {});
	}
	await Bun.sleep(1500);
	Bun.gc(true);
	const leaked = fds() - before;
	if (leaked > 5) problems.push(`${leaked} descriptors leaked after 20 aborted downloads`);
	if (openFileLinkResponses() !== 0) problems.push(`${openFileLinkResponses()} slots still held after aborted downloads`);
}

// 4. A page's burst of small assets is never refused (cloudflared hands them over all at once).
const assets = join(dir, "site");
mkdirSync(assets, { recursive: true });
writeFileSync(join(assets, "index.html"), "<p>page</p>");
for (let i = 0; i < 30; i++) writeFileSync(join(assets, `img${i}.png`), "PNG");
const site = mintFileLink({ kind: "dir", root: assets, entry: "index.html" });
const siteBase = `http://127.0.0.1:${port}${site.slice(0, -"index.html".length)}`;
const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => fetch(`${siteBase}img${i}.png`).then(async (res) => (await res.arrayBuffer(), res.status))));
const refused = burst.filter((status) => status !== 200).length;
if (refused) problems.push(`${refused} of 30 parallel small assets were refused`);

// 5. A folder link in a real git checkout, minted as createFileLink does: the page's assets load
// (all 150 at once), a gitignored secret does not.
const repo = join(dir, "repo");
mkdirSync(join(repo, "config", "assets"), { recursive: true });
if (Bun.spawnSync(["git", "init", "-q", repo]).exitCode !== 0) problems.push("git is required for the gitignore check and could not init a repo");
else {
	writeFileSync(join(repo, ".gitignore"), "config/master.key\n");
	writeFileSync(join(repo, "config", "x.html"), "<p>page</p>");
	writeFileSync(join(repo, "config", "master.key"), "SECRET");
	for (let i = 0; i < 150; i++) writeFileSync(join(repo, "config", "assets", `a${i}.png`), "PNG");
	const page = await mintFolderLink(realpathSync(join(repo, "config", "x.html")), realpathSync(repo));
	const base = `http://127.0.0.1:${port}${page.slice(0, -"x.html".length)}`;
	const codes = await Promise.all(Array.from({ length: 150 }, (_, i) => fetch(`${base}assets/a${i}.png`).then(async (res) => (await res.arrayBuffer(), res.status))));
	const broken = codes.filter((code) => code !== 200).length;
	if (broken) problems.push(`${broken} of 150 assets under a gitignore-filtered folder link failed`);
	for (const [name, want] of [["x.html", 200], ["master.key", 404]] as const) {
		const res = await fetch(base + name);
		await res.arrayBuffer();
		if (res.status !== want) problems.push(`folder link ${name}: expected ${want}, got ${res.status}`);
	}
}

server.stop(true);
rmSync(dir, { recursive: true, force: true });
if (problems.length) {
	console.error(`file-links socket e2e FAILED:\n- ${problems.join("\n- ")}`);
	process.exit(1);
}
console.log("file-links socket e2e: ok (range Content-Length on the wire, no slot or descriptor leaks, gitignore filter, asset bursts)");
