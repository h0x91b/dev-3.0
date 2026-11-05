Short: Release closed terminal memory

Switching tasks no longer leaves document mouse handlers retaining disposed terminals and their canvas resources. Terminal and file-link overlay canvases now release their backing stores explicitly when closed, reducing WebKit memory growth with both Codex and Claude terminals. Docker builds include the dependency patch, and release caches invalidate when its contents change.

Contributed by @diverru (h0x91b/dev-3.0#2029)
