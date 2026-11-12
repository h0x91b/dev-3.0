Short: Number keys follow spaces

A new Keyboard setting, "Number keys follow spaces", makes ⌘1–⌘9 (and ⇧⌘1–⌘9, and `g` + digit) address spaces and standalone projects in one mixed order; a space opens its unified board and ⌘0 stays Operations. With it on, the dashboard and the spaces rail show that same order with ⌘N hints, a space can be dragged (or stepped with Move up / Move down) among standalone projects, and deleting a space keeps its projects in the slot it held; the order is stored in spaces.json as `mixedOrder`. Whatever the setting, a project switch through ⌘1–⌘9, `g` + digit, the switcher, the palette or a notification now lands on that project's own board instead of carrying the previous space board along, and `g` + digit skips Operations like ⌘ + digit.

Contributed by @diverru (h0x91b/dev-3.0#2254)
