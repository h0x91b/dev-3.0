Short: Share a report as a gist link

dev3 now ships a `dev3-share-artifact` skill to every agent: ask for a link to a report and the agent folds the multi-file artifact into one self-contained HTML file, publishes it as a secret GitHub gist, and verifies the preview URL before handing it over. The folding is a new `dev3 inline-html` command that embeds local CSS, JS, images and fonts, leaves CDN links alone, and refuses to write a page carrying a credential-shaped string or a missing local asset. `ask-dev3` now routes "share this report" to it.
