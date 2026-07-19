# 139 — sanitize-html (not DOMPurify) for PR comment markdown

## Context

The diff viewer renders GitHub PR review threads and conversation comments — arbitrary third-party GitHub-flavored markdown — inside the app webview (`src/mainview/components/pr-review/markdown.tsx`). The pipeline must be XSS-safe by construction, and its safety must be pinned by unit tests running in the project's `happy-dom` vitest environment.

## Investigation

The first implementation used `marked` + `DOMPurify`. Under `happy-dom`, `DOMPurify.isSupported` reports `true` but sanitization silently fails: `sanitize('<p>x <script>alert(1)</script></p>')` returns the `<script>` tag intact while stripping the harmless `<p>`. DOMPurify requires a complete browser DOM (NodeIterator/TreeWalker internals) that happy-dom does not provide, so the sanitization tests could never honestly pin the production behavior.

## Decision

Use `marked` (GFM → HTML) + `sanitize-html` (parser-based on htmlparser2, no DOM required) with an explicit allowlist in `renderCommentMarkdown()`. Because sanitize-html never touches the environment's DOM, the exact same code path runs in the WKWebView/browser and in happy-dom tests (`src/mainview/components/pr-review/__tests__/markdown.test.tsx`). Links are rewritten to `target="_blank" rel="noopener noreferrer"`; schemes are limited to http/https/mailto.

## Risks

sanitize-html has a larger bundle footprint than DOMPurify (htmlparser2 + postcss). Its allowlist is maintained by us — new GitHub markdown features (e.g. new embed tags) stay stripped until explicitly allowed, which fails safe.

## Alternatives considered

- **DOMPurify + jsdom test environment**: adds a heavy dev dependency and splits the test environment; the component tests that embed comments would still run under happy-dom with a silently broken sanitizer.
- **react-markdown**: safe by construction, but drops the raw HTML (`<details>`, `<table>`, `<img>`) that GitHub bots use heavily in PR comments; the unified/remark dependency tree is also far larger.
