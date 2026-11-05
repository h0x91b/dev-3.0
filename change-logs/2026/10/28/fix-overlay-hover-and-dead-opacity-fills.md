Short: Hover highlights show in menus again

Rows and buttons in menus, popovers, pickers, sheets and dialogs now get a visible hover in the dark theme (new overlay-hover surface token) instead of an invisible or darker-than-surface fill, selected rows on popups use the accent tint, and classes that compiled to no CSS at all (`/8` and `/12` opacity, `ring-offset-base`, `border-current/N`) now render, guarded by a test that fails on any off-scale or keyword-colour opacity modifier.
