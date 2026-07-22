Short: Name artifact download from title

Artifact downloads are now named from the artifact title (sanitized) instead of the source HTML basename, so a titled report saves as "Q4 Revenue.zip" rather than "index.zip". Falls back to the HTML file name when no usable title is present.
