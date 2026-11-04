Short: Stop git status processes piling up

dev3 no longer piles up `git status` processes when a repository stops answering: polling git probes now time out after 30 seconds and take their child processes with them, and concurrent polls of the same repository share one git run instead of each starting their own. This fixes `dev3 remote` (and the desktop app) accumulating thousands of stuck git processes and driving the machine's load through the roof.

Suggested by @mcaldas (h0x91b/dev-3.0#2153)
