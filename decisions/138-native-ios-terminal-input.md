# Native iOS terminal input interception

## Context

The iOS terminal must preserve dev3's Shift-only functional-key sequences, especially `Shift+Enter → ESC+CR`, while leaving SwiftTerm responsible for ordinary text, IME, and terminal-mode-aware input. It must also prevent the terminal from claiming focus while the higher-level composer owns keyboard input.

## Investigation

SwiftTerm 1.14.0 handles hardware input in `TerminalView.pressesBegan`, but that override is `public` rather than `open`, so `Dev3SwiftTermView` cannot intercept it from another module. UIKit exposes priority `UIKeyCommand` bindings for the relevant functional keys, while the SwiftTerm delegate protocol has not adopted Swift 6 actor annotations.

## Decision

`Dev3SwiftTermView` registers Shift-only priority key commands and resolves them through the pure table in `TerminalInput.swift`; SwiftTerm continues to handle all unclaimed keys and IME input. `Dev3TerminalView.Coordinator` is `@MainActor` with an `@preconcurrency TerminalViewDelegate` conformance, and compose mode disables first-responder eligibility entirely.

## Risks

UIKit does not publish a key-command input constant for Insert, so the complete encoder covers it for callers but the view cannot claim that physical key through this mechanism. The concurrency annotation relies on keeping SwiftTerm feed and delegate interactions on the main actor; moving terminal feeds off-main would require a new delegate isolation audit.

## Alternatives considered

Forking SwiftTerm to make `pressesBegan` open would add a long-lived dependency patch for one interception point. Reimplementing all keyboard handling would discard SwiftTerm's terminal modes and IME behavior, while treating Shift+Enter as normal Enter would regress the established tmux and Claude Code convention.
