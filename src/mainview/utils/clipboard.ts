/**
 * Copy text to the clipboard, resilient to remote/mobile constraints.
 *
 * `navigator.clipboard.writeText` requires a secure context — which a phone
 * reaching `dev3 remote` over plain http on the LAN often is NOT. When it is
 * missing or rejects, fall back to a hidden `<textarea>` + `execCommand("copy")`
 * so copying still works on those devices. Returns whether the copy succeeded.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		/* fall through to the execCommand path */
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.top = "0";
		ta.style.left = "0";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}
