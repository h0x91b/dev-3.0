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

/**
 * ⌘F find inside the artifact. The viewer's iframe is opaque-origin, so the parent
 * cannot walk this document — it posts the query in and reads {matches,index} back.
 * Highlighting prefers the CSS Custom Highlight API because it paints without
 * touching the DOM (artifact scripts and layout stay intact); where it is missing we
 * fall back to selecting the active range, which every engine renders.
 */
function findScript(): string {
	return `<script data-dev3-artifact-find>(function(){var NAME='dev3-artifact-find',ACTIVE='dev3-artifact-find-active';var api=typeof CSS!=='undefined'&&CSS.highlights&&typeof Highlight==='function';var ranges=[],index=-1,styled=false;function style(){if(styled||!api)return;styled=true;var el=document.createElement('style');el.textContent='::highlight('+NAME+'){background-color:rgba(250,204,21,.4);color:inherit}::highlight('+ACTIVE+'){background-color:#f59e0b;color:#111}';(document.head||document.documentElement).appendChild(el);}function paint(){if(!api){var sel=window.getSelection&&window.getSelection();if(sel){sel.removeAllRanges();if(ranges[index])sel.addRange(ranges[index]);}return;}style();CSS.highlights.delete(NAME);CSS.highlights.delete(ACTIVE);if(!ranges.length)return;var rest=new Highlight();ranges.forEach(function(range,i){if(i!==index)rest.add(range);});if(rest.size)CSS.highlights.set(NAME,rest);if(ranges[index])CSS.highlights.set(ACTIVE,new Highlight(ranges[index]));}function reset(){ranges=[];index=-1;if(api&&CSS.highlights){CSS.highlights.delete(NAME);CSS.highlights.delete(ACTIVE);}else{var sel=window.getSelection&&window.getSelection();if(sel)sel.removeAllRanges();}}function collect(query){reset();if(!query)return;var needle=query.toLowerCase();var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:function(node){if(!node.nodeValue||!node.nodeValue.trim())return NodeFilter.FILTER_REJECT;var parent=node.parentElement;if(!parent)return NodeFilter.FILTER_REJECT;if(/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(parent.tagName))return NodeFilter.FILTER_REJECT;if(parent.closest('[data-dev3-artifact-menu]'))return NodeFilter.FILTER_REJECT;return NodeFilter.FILTER_ACCEPT;}});var node;while((node=walker.nextNode())){var text=node.nodeValue.toLowerCase();var from=0;while(ranges.length<2000){var at=text.indexOf(needle,from);if(at<0)break;var range=document.createRange();range.setStart(node,at);range.setEnd(node,at+needle.length);ranges.push(range);from=at+needle.length;}}if(ranges.length)index=0;}function reveal(){var range=ranges[index];if(!range)return;var target=range.startContainer.parentElement;if(target&&target.scrollIntoView)target.scrollIntoView({block:'center',inline:'nearest'});}function reply(token){parent.postMessage({type:'dev3-artifact-find-result',token:token,matches:ranges.length,index:index},'*');}window.addEventListener('message',function(event){var data=event.data;if(!data||typeof data.type!=='string')return;if(data.type==='dev3-artifact-find'){collect(typeof data.query==='string'?data.query:'');paint();reveal();reply(data.token);}else if(data.type==='dev3-artifact-find-step'){if(ranges.length){index=(index+(data.delta<0?-1:1)+ranges.length)%ranges.length;paint();reveal();}reply(data.token);}else if(data.type==='dev3-artifact-find-clear'){reset();}},false);var mac=/Mac|iP(hone|ad|od)/.test(navigator.platform||navigator.userAgent||'');window.addEventListener('keydown',function(event){var combo=mac?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey;if(!combo||event.shiftKey||event.altKey||event.code!=='KeyF')return;event.preventDefault();parent.postMessage({type:'dev3-artifact-find-open'},'*');},true);})();</script>`;
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

	const injected = `<meta http-equiv="Content-Security-Policy" content="${CSP}">${findScript()}${saveImageLabel ? saveImageMenuScript(saveImageLabel) : ""}`;
	if (/<head(?:\s|>)/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${injected}`);
	if (/<html(?:\s|>)/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${injected}</head>`);
	const body = html.replace(/<!doctype[^>]*>/i, "");
	return `<!doctype html><html><head>${injected}</head><body>${body}</body></html>`;
}
