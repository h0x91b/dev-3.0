# Link Detection

System for detecting and interacting with hyperlinks in the terminal.

## Overview

ghostty-web supports two types of links:

1. **OSC 8 hyperlinks** -- Explicit hyperlinks created by applications using the `\x1b]8;;URL\x07TEXT\x1b]8;;\x07` escape sequence
2. **URL regex** -- Plain text URLs detected by regex pattern matching

Links are detected via a provider system. Multiple providers can be registered, with priority determined by registration order. OSC 8 providers run first (explicit links take precedence).

## LinkDetector

Manages link detection across multiple providers with intelligent caching.

### Methods

#### `registerProvider(provider: ILinkProvider): void`

Register a link detection provider. Invalidates cache.

#### `getLinkAt(col: number, row: number): Promise<ILink | undefined>`

Get link at buffer position. Uses cache for fast lookups.

#### `invalidateCache(): void`

Clear link cache. Called automatically on terminal write, resize, or clear.

#### `invalidateRows(startRow: number, endRow: number): void`

Invalidate cache for specific rows.

#### `dispose(): void`

Clean up providers and caches.

## ILinkProvider Interface

```typescript
interface ILinkProvider {
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;
  dispose?(): void;
}
```

## ILink Interface

```typescript
interface ILink {
  text: string;            // URL or link text
  range: IBufferRange;     // Position in buffer (may span multiple lines)
  activate(event: MouseEvent): void;   // Called on click
  hover?(isHovered: boolean): void;    // Called on hover enter/leave
  dispose?(): void;
}
```

## OSC8LinkProvider

Detects hyperlinks created with OSC 8 escape sequences. Ghostty WASM assigns `hyperlink_id` to cells, so the provider scans for contiguous regions with the same ID.

**Features:**
- Multi-line link support (wrapped links)
- Fast lookup by `hyperlink_id` cache key
- Automatic range detection (scans backwards/forwards)

**Activation:** Ctrl+Click or Cmd+Click opens the link in a new tab.

## UrlRegexProvider

Detects plain text URLs using regex pattern matching.

**Supported protocols:**
- `https://`, `http://`
- `mailto:`
- `ftp://`, `ssh://`, `git://`
- `tel:`, `magnet:`
- `gemini://`, `gopher://`, `news:`

**Features:**
- Single-line detection
- Trailing punctuation stripping (`.`, `,`, `;`, `!`, `?`, `)`, `]`)
- Minimum URL length: 8 characters

**Activation:** Ctrl+Click or Cmd+Click opens the link in a new tab.

## Custom Link Providers

Register custom providers for application-specific link detection:

```typescript
term.registerLinkProvider({
  provideLinks(y, callback) {
    const line = term.buffer.active.getLine(y);
    if (!line) { callback(undefined); return; }

    const text = line.translateToString();
    const links: ILink[] = [];

    // Detect custom patterns (e.g., issue references)
    const regex = /#(\d+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const issueNum = match[1];
      links.push({
        text: `#${issueNum}`,
        range: {
          start: { x: match.index, y },
          end: { x: match.index + match[0].length - 1, y },
        },
        activate: (event) => {
          if (event.ctrlKey || event.metaKey) {
            window.open(`https://github.com/org/repo/issues/${issueNum}`, '_blank');
          }
        },
      });
    }

    callback(links.length > 0 ? links : undefined);
  },
});
```

## Caching Strategy

The `LinkDetector` uses two-level caching:

1. **By hyperlink_id** (key: `h${id}`) -- for OSC 8 links. Stable across rows since the same hyperlink_id always represents the same link.
2. **By position** (key: `r${row}:${startX}-${endX}`) -- for regex links. Position-based fallback.

Cache is invalidated on:
- Terminal write (content changed)
- Terminal resize
- New provider registration

## Mouse Interaction

On hover:
- OSC 8 links: underline cells with matching `hyperlink_id`
- Regex links: underline the matched range
- Cursor changes to `pointer`

On click (with Ctrl/Cmd modifier):
- Link's `activate()` method is called
- Default: opens URL in new tab with `noopener,noreferrer`
