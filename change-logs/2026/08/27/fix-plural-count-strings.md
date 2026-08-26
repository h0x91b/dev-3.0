Short: Counts read correctly at one

Counts next to a noun no longer say "1 commits ahead" or "1 коммитов позади": 21 flat strings across English, Russian and Spanish gained proper plural forms, and the diff badge's hardcoded English "file/files" now goes through the translations. Plural forms come from the runtime's own CLDR table (`Intl.PluralRules`) instead of a hand-written Russian branch, so a future locale needs no code, and a new test fails on any count string that forgets its plural forms.
