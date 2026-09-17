import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ComponentProps,
	type ReactNode,
} from "react";
import { api } from "../../rpc";
import { isRelativeUrl } from "./markdown-urls";

/**
 * Repo-relative images in a rendered markdown document (`![](docs/shot.png)`).
 * The webview has no base URL pointing at the checkout, so such a src can never
 * load as a plain URL — it is read off disk through `readFilePreview` and swapped
 * in as a data URL. Same handler the terminal path preview uses, so the path is
 * gated on the bun side to the home dir, the OS temp directories and registered
 * project roots. A src with enough `..` segments resolves into one of those temp
 * directories, and this read needs no click — an image there loads on render.
 *
 * Markdown images are React components, so resolved data URLs remain stable
 * across parent renders without mutating renderer-owned DOM. The `src` arriving
 * here is already resolved by `markdown-urls.ts`, so a relative one provably came
 * from the document being rendered.
 */

const MAX_IMAGES_PER_DOCUMENT = 40;
/** Data URLs are heavy (up to 4 MB each), so the cache stays deliberately small. */
const MAX_CACHED_IMAGES = 24;
const allowEveryImage = () => true;
const DiskImageBudgetContext = createContext<(absPath: string) => boolean>(allowEveryImage);

/** Absolute path → data URL, or null for "read failed / not an image". */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/**
 * Resolve a markdown image src to an absolute path. `baseDir` is the directory
 * of the document; a root-relative src (`/docs/shot.png`) resolves against
 * `rootDir` instead, which is how such links are meant inside a repo.
 */
export function resolveDiskImagePath(src: string, baseDir: string, rootDir?: string | null): string | null {
	const withoutSuffix = src.replace(/[?#].*$/, "");
	let target: string;
	try {
		target = decodeURIComponent(withoutSuffix);
	} catch {
		target = withoutSuffix;
	}
	if (!target || target.includes("\0")) return null;
	const rootRelative = target.startsWith("/");
	const base = rootRelative ? rootDir : baseDir;
	if (!base) return null;
	const segments = base.split("/").filter((part, index) => part || index === 0);
	for (const part of target.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (segments.length > 1) segments.pop();
			continue;
		}
		segments.push(part);
	}
	const abs = segments.join("/");
	return abs.startsWith("/") ? abs : null;
}

function readImage(absPath: string): Promise<string | null> {
	const cached = cache.get(absPath);
	if (cached !== undefined) return Promise.resolve(cached);
	const pending = inflight.get(absPath);
	if (pending) return pending;
	const request = api.request
		.readFilePreview({ path: absPath })
		.then((result) => (result.kind === "image" ? result.dataUrl : null))
		.catch(() => null)
		.then((dataUrl) => {
			if (cache.size >= MAX_CACHED_IMAGES) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) cache.delete(oldest);
			}
			cache.set(absPath, dataUrl);
			inflight.delete(absPath);
			return dataUrl;
		});
	inflight.set(absPath, request);
	return request;
}

type MarkdownImageProps = ComponentProps<"img"> & {
	imageBaseDir?: string | null;
	imageRootDir?: string | null;
};

export function MarkdownImageProvider({
	children,
	resetKey,
}: {
	children: ReactNode;
	resetKey: unknown;
}) {
	const claimPath = useMemo(() => {
		const claimedPaths = new Set<string>();
		return (absPath: string) => {
			if (claimedPaths.has(absPath)) return true;
			if (claimedPaths.size >= MAX_IMAGES_PER_DOCUMENT) return false;
			claimedPaths.add(absPath);
			return true;
		};
	}, [resetKey]);

	return (
		<DiskImageBudgetContext.Provider value={claimPath}>
			{children}
		</DiskImageBudgetContext.Provider>
	);
}

export function MarkdownImage({
	src,
	imageBaseDir,
	imageRootDir,
	...props
}: MarkdownImageProps) {
	const claimPath = useContext(DiskImageBudgetContext);
	const originalSrc = src ?? "";
	const diskBacked = Boolean(imageBaseDir && originalSrc && isRelativeUrl(originalSrc));
	const absPath = useMemo(
		() => (diskBacked ? resolveDiskImagePath(originalSrc, imageBaseDir!, imageRootDir) : null),
		[diskBacked, originalSrc, imageBaseDir, imageRootDir],
	);
	const [resolved, setResolved] = useState<string | null | undefined>(undefined);

	useEffect(() => {
		if (!diskBacked || !absPath) {
			setResolved(absPath === null && diskBacked ? null : undefined);
			return;
		}
		if (!claimPath(absPath)) {
			setResolved(null);
			return;
		}
		let stale = false;
		setResolved(undefined);
		void readImage(absPath).then((dataUrl) => {
			if (!stale) setResolved(dataUrl);
		});
		return () => {
			stale = true;
		};
	}, [diskBacked, absPath, claimPath]);

	if (!diskBacked) {
		return <img {...props} src={originalSrc || undefined} />;
	}

	const state = resolved === undefined ? "loading" : resolved ? "loaded" : "missing";
	return (
		<img
			{...props}
			src={resolved ?? undefined}
			title={originalSrc}
			data-dev3-md-image={state}
		/>
	);
}
