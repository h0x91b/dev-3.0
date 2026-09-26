Short: Native-weight, sharper terminal text

Bundled terminal fonts now use FreeType rasterization with browser fallback on glyph errors, removing the heavier, fuzzier appearance beside native terminals. Glyph caches copy on the physical-pixel grid, and cell spacing, underlines, single/double/rounded/dashed box strokes, and dark dim text use native-style metrics and intensity. System-font text and complex shaped clusters retain browser rendering; supported box strokes are procedural with every font.
