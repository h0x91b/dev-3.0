Short: Address a variant by seq

`dev3 message` now takes `--variant <i>` next to `--task seq:<N>`, so one member of a live variant group can be addressed by the number on its card instead of a 36-char UUID. A wrong index fails loudly and names the indices that do exist, and the reply command inside a cross-task message envelope uses the readable form too.
