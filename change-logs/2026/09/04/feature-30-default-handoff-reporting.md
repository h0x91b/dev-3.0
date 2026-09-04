Short: Launched agents report back as files

A task launched by a peer agent now hears, in its very first message, that its description is the brief and that progress and results go into a file under its own task directory — it messages the launcher only the absolute path. Coordinators no longer have to type that instruction by hand after every launch, and a launcher with standing rules of its own can append them with `--handoff-file <path>` on `dev3 task move --status in-progress` or `dev3 task create --scratch --run`.
