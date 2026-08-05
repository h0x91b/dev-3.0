Short: Invisible icons across the app now render

Icon glyphs written as `text-base` were being painted in the page background colour, because the `base` design token also emitted a `text-base` colour utility that collided with Tailwind's font-size class — 107 of them were invisible on the Dashboard alone. The Dashboard project rows also no longer hide their settings, Open in Finder, project terminal and remove buttons until you hover, and the diff viewer's copy-path button no longer out-sizes the file name it sits next to.
