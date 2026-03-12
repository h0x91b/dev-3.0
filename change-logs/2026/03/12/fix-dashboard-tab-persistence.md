Dashboard now remembers the active tab (Activity/Projects) in localStorage. Navigation state replaced single previousRoute with a full route history stack (capped at 15 entries), enabling future back/forward navigation. Changelog Escape key now uses goBack() for proper history traversal.

Suggested by @avivros007 (h0x91b/dev-3.0#289)
