Short: Find inside HTML artifacts

HTML artifacts now have a find bar: press ⌘F (Ctrl+F on Linux) while the artifact viewer has focus, or click the new magnifier in its header, to search the rendered document with match counts and ↑/↓ stepping. Because the artifact renders in an opaque-origin sandboxed iframe, the query is relayed into an injected script that highlights matches with the CSS Custom Highlight API and scrolls them into view without touching the artifact's own DOM.
