Short: Renderer tests run on newer Node

Fixed the renderer test suite failing wholesale on Node 25.6 and later: the setup file substitutes an in-memory `localStorage` only when Node's experimental global is `undefined`, but newer Node exposes it as an object whose methods are missing, so the shim never installed and 148 of 297 test files died on `localStorage.getItem is not a function`. It now probes for a usable Storage instead.
