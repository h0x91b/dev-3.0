## Context

The browser-mode application menu bar occupied a 32px row on phone-sized viewports. Its narrow form duplicated the GlobalHeader `More` bottom sheet and command-palette touch entry, while reducing the vertical space available to the primary screen.

## Investigation

The mobile header already folds utility actions into `GlobalHeader` and exposes the command palette as a touch action. The browser menu remains available on wider remote layouts, and no native desktop menu is affected.

## Decision

Hide `AppMenuBar` below the shared 768px narrow breakpoint. Keep the component and shared menu definition unchanged for wide browser layouts; narrow actions continue through the existing header sheet and object-specific surfaces.

## Risks

Any action that is only present in the application menu must remain reachable through the narrow command palette, header sheet, or its owning object surface. The AppMenuBar component test and browser QA cover the removed row and preserved wide rendering.

## Alternatives considered

Keeping the 32px row with a single hamburger preserved menu parity but wasted scarce mobile height and duplicated the existing touch entry. Moving all application-menu items into the header would add new header chrome and duplicate the shared menu taxonomy.
