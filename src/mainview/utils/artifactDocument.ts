interface ArtifactAssetPayload {
	name: string;
	mime: string;
	dataUrl: string;
}

// The iframe sandbox (opaque origin, allow-scripts only) is the security boundary,
// not this CSP: artifacts may load libraries from any origin and talk to any server
// (fetch/WebSocket) so agents can build integrations with the user's own services or
// the dev3 dev server (decision 163). Only plugin/base-url legacy vectors stay closed.
const CSP = "default-src data: blob: https: http:; script-src 'unsafe-inline' data: blob: https: http:; style-src 'unsafe-inline' data: blob: https: http:; connect-src data: blob: https: http: ws: wss:; object-src 'none'; base-uri 'none'";

/**
 * Right-click "Save image" for artifact images. The iframe is opaque-origin and
 * sandboxed without `allow-downloads`, so a download can't fire from here — we hand
 * the image data URL to the parent viewer, which saves it via its own origin.
 */
function saveImageMenuScript(label: string): string {
	return `<script data-dev3-artifact-menu>(function(){var LABEL=${JSON.stringify(label)};var menu=null,current=null;function hide(){if(menu){menu.remove();menu=null;current=null;}}function build(){var m=document.createElement('div');m.setAttribute('data-dev3-artifact-menu','');m.style.cssText='position:fixed;z-index:2147483647;min-width:160px;padding:4px;border-radius:10px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:rgb(var(--dev3-surface-elevated,21 26 41));color:rgb(var(--dev3-text-primary,250 252 255));border:1px solid rgb(var(--dev3-border,32 38 55));box-shadow:0 8px 24px rgba(0,0,0,.35)';var item=document.createElement('button');item.type='button';item.textContent=LABEL;item.style.cssText='display:block;width:100%;text-align:left;padding:7px 10px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer';item.addEventListener('mouseenter',function(){item.style.background='rgb(var(--dev3-accent,68 150 255))';item.style.color='rgb(var(--dev3-on-accent,255 255 255))';});item.addEventListener('mouseleave',function(){item.style.background='transparent';item.style.color='inherit';});item.addEventListener('click',function(){if(current&&current.src){parent.postMessage({type:'dev3-artifact-save-image',src:current.src,alt:current.getAttribute('alt')||''},'*');}hide();});m.appendChild(item);return m;}document.addEventListener('contextmenu',function(e){var img=e.target&&e.target.closest?e.target.closest('img'):null;if(!img||!img.src){hide();return;}e.preventDefault();hide();current=img;menu=build();document.body.appendChild(menu);var x=Math.max(8,Math.min(e.clientX,window.innerWidth-menu.offsetWidth-8));var y=Math.max(8,Math.min(e.clientY,window.innerHeight-menu.offsetHeight-8));menu.style.left=x+'px';menu.style.top=y+'px';menu.firstChild.focus();},true);document.addEventListener('pointerdown',function(e){if(menu&&!menu.contains(e.target))hide();},true);window.addEventListener('keydown',function(e){if(e.key==='Escape')hide();},true);window.addEventListener('blur',hide);window.addEventListener('scroll',hide,true);window.addEventListener('resize',hide);})();</script>`;
}

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
export function composeArtifactDocument(source: string, assets: ArtifactAssetPayload[], saveImageLabel?: string): string {
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

	const injected = `<meta http-equiv="Content-Security-Policy" content="${CSP}">${saveImageLabel ? saveImageMenuScript(saveImageLabel) : ""}`;
	if (/<head(?:\s|>)/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${injected}`);
	if (/<html(?:\s|>)/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${injected}</head>`);
	const body = html.replace(/<!doctype[^>]*>/i, "");
	return `<!doctype html><html><head>${injected}</head><body>${body}</body></html>`;
}
