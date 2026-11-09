Short: Renaming an API provider keeps agents working

Renaming a custom API-model provider no longer breaks agents that already use it: its proxy name stays fixed and the new name is stored separately. Older app versions sharing the same catalog file keep routing correctly but may show the old name.
