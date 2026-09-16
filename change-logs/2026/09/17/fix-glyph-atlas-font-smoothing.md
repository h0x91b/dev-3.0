Short: Terminal text is no longer too bold

Terminal glyphs on macOS rendered noticeably heavier than the same font in a native terminal, because the glyph atlas rasterised them on detached canvases that never received the app's font-smoothing rule. The atlas strips now live in a hidden host inside the document, so cached glyphs match direct rendering; measured in a real WKWebView, total ink per row went from up to 30% heavier than direct rendering down to within 0.1% of it.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1786)
