Short: Opt-in lean agent protocol

Setting `DEV3_LEAN_PROTOCOL=1` on the dev3 server makes every launch inject a lean protocol of about 9 KB instead of about 27 KB: the rules an agent must follow from its first turn, plus the path to the full protocol on disk. It is off by default and meant for small-context and local models.
