Short: Oh My Pi as a built-in agent

Oh My Pi (`omp`) is now a first-class coding agent with its own presets, so launching it no longer needs
a hand-built custom agent. It receives the dev3 protocol, the managed skills and session resume, and
dev3's permission modes map onto its approval tiers, with Default asking first rather than inheriting
omp's own unattended default. Status still moves by hand — automatic hooks are a separate follow-up.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1544)
