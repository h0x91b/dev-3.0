Short: Native-weight, sharper terminal text

Bundled terminal fonts now use FreeType rasterization instead of browser-specific hinting, removing the heavier, fuzzier appearance beside native terminals. Glyph caches copy on the physical-pixel grid, and cell spacing, underlines, light/heavy box strokes, and dark dim text use native-style metrics and intensity. At 16px on Windows with 125% scaling, the full comparison sample matches WezTerm within one RGB level per channel at every pixel; system fonts and complex shaped clusters retain browser rendering.
