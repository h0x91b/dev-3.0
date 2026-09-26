Short: Sharp terminal text at fractional zoom

Terminal text is sharp again at fractional display scales — 125%, 150% and 175% on Windows, and the matching browser zooms in dev3 remote. The glyph cache sized its slots in CSS pixels, so every cell was blitted a quarter of a pixel off the device grid and resampled; slots are now whole device pixels and the row's remaining fraction is rasterised into the glyph instead of being smeared across it. Scales whose row grid cannot be placed exactly, such as 110% and 130%, now skip the cache and render directly rather than settle for an approximation.
