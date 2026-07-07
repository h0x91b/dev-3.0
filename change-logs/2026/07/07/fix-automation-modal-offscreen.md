Fixed the automation create/edit modal rendering partially off-screen. It was nested inside the Project Settings blur-backed card, whose backdrop-filter trapped the modal's fixed positioning; it now portals to the document body and anchors to the viewport like every other modal.

Suggested by @EvgenyAlterman (h0x91b/dev-3.0#845)
