Short: Launch modal default config fixed

Fixed the Launch Task modal preselecting a broken default when the saved global default config belonged to a different provider than the default provider (which left the Mode field empty and the launch inert). The picker now falls back to the provider's own default, matching the Spawn Agent and Bug Hunters surfaces.
