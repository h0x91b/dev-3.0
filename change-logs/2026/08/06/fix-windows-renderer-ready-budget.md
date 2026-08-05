Short: Windows launch no longer gives up early

The Windows desktop launch waited only 45 seconds for its renderer, which measurement showed was barely longer than the slowest healthy packaged startup — so a slow or loaded machine could be told it had no UI when it simply had not painted yet. The budget is now sized off 40 measured launches, and every packaged-launch proof records how long the renderer actually took so it stays that way.
