Short: Stable scrolling in diff review

Fix the diff review jumping by tens of thousands of pixels when scrolling up or jumping to a file, caused by lazily built file sections growing above the viewport. The scroll region now keeps its first visible file in place itself, because WKWebView has no CSS scroll anchoring.

Contributed by @diverru (h0x91b/dev-3.0#2010)
