Short: Artifact inputs stop looking native

Every standard form control in the artifact template is now skinned on the element itself instead of only inside a `.field` wrapper, so a bare `<textarea>` or `<select>` an author drops into a report matches the rest of the shell. Textareas get a real box, their own font and auto-growing height; a plain `<select>` draws its own caret; and file, color, search, number, date, multi-select, checkbox and radio glyphs, placeholders, and the disabled, read-only and invalid states all follow the dev3 tokens in both themes.
