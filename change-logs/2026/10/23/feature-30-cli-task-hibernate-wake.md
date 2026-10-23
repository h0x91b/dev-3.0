Short: Hibernate and wake tasks from the CLI

Agents can now park and revive tasks: `dev3 task hibernate` does what the session bar's Hibernate button does, and `dev3 task wake --resume|--shell` matches the wake screen's two buttons. When an agent asks, you approve it in the same countdown dialog as an agent-started launch. "Wake with a plain shell" now really opens a shell instead of restarting the agent from its brief, and keeps the saved conversation for a later resume. A resumed omp or pi task now gets the dev3 protocol again; before, it came back without it.
