Fixed the broken AI Review project setting so turning it off is now saved correctly in repo config and local overrides instead of silently reopening as enabled and continuing to auto-review tasks. Added a separate automatic-review opt-in so manual drag-to-review in the AI Review column still works independently, and Project Settings now shows a sticky Save/Discard bar while keeping the leave-page confirmation dialog as a fallback. Dirty-state detection now also clears correctly when a toggle is returned to its effective default value.

Suggested by @genrym (h0x91b/dev-3.0#336)
