interface ArtifactAssetPayload {
	name: string;
	mime: string;
	dataUrl: string;
}

const CSP = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function assetKey(url: string): string | null {
	if (/^(?:data:|blob:|https?:|\/\/|#)/i.test(url)) return null;
	const clean = url.split(/[?#]/, 1)[0].replace(/^\.\//, "");
	try {
		return decodeURIComponent(clean);
	} catch {
		return clean;
	}
}

/**
 * Prepare stored artifact HTML for an opaque-origin sandboxed iframe.
 * Relative raster references are replaced with the copied assets' data URLs;
 * everything else remains visible in source but is blocked by the injected CSP.
 */
export function composeArtifactDocument(source: string, assets: ArtifactAssetPayload[]): string {
	const byName = new Map(assets.map((asset) => [asset.name, asset.dataUrl]));
	const resolve = (url: string): string => {
		const key = assetKey(url.trim());
		return (key && byName.get(key)) || url;
	};

	let html = source.replace(
		/(\b(?:src|poster)\s*=\s*)(["'])(.*?)\2/gi,
		(_match, prefix: string, quote: string, value: string) => `${prefix}${quote}${resolve(value)}${quote}`,
	);
	html = html.replace(
		/(\bsrcset\s*=\s*)(["'])(.*?)\2/gi,
		(_match, prefix: string, quote: string, value: string) => {
			const replaced = value.split(",").map((candidate) => {
				const parts = candidate.trim().split(/\s+/);
				return [resolve(parts[0]), ...parts.slice(1)].join(" ");
			}).join(", ");
			return `${prefix}${quote}${replaced}${quote}`;
		},
	);
	html = html.replace(
		/url\(\s*(["']?)(.*?)\1\s*\)/gi,
		(_match, quote: string, value: string) => `url(${quote}${resolve(value)}${quote})`,
	);

	const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
	if (/<head(?:\s|>)/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
	if (/<html(?:\s|>)/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${meta}</head>`);
	const body = html.replace(/<!doctype[^>]*>/i, "");
	return `<!doctype html><html><head>${meta}</head><body>${body}</body></html>`;
}
