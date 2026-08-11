Short: Artifact panels, padding and chart labels

The dev3 artifact starter no longer stacks panels flush against each other: `main.app` spaces its children, and a bare `.card` carries its own padding, so a report looks right whatever order panels are written in. Chart value labels also stopped rendering as dark grey text inside a white halo on the dark theme — charts now declare the card surface they sit on, so ECharts picks readable label colors in both themes.
