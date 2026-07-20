# 142 — Treat diff extension payloads as optional

## Context

`TaskDiffViewer` uses the diff library's extension renderer for local comments and GitHub review threads. In split mode the library renders both sides of a row to synchronize their heights, even when only one side owns extension data.

## Investigation

The crash report pointed to `.github` inside `renderExtendLine`. Inspection of `DiffSplitExtendLineNormal` showed that it calls the renderer with `currentExtend?.data` whenever either side has data, so `undefined` is a legitimate runtime value despite the library's non-optional generic type.

## Decision

Treat `ExtendLineData` as optional at the `TaskDiffViewer` callback boundary and guard both local and GitHub thread reads. The component test mock renders the empty split counterpart with `undefined`, matching the library contract that caused the crash.

## Risks

The empty counterpart now renders no extension content, which is the intended split-row behavior. If the library later tightens its contract, the optional guard remains harmless.

## Alternatives considered

Normalizing `extendData` cannot cover the mirrored callback because the missing value is created inside the library. Catching the render error or clearing persisted reviews would hide the defect and risk losing the user's comments.
