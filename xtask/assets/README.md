# Committed assets

`KFGQPC-Hafs-V30.ttf` is the KFGQPC Hafs V30 font, byte for byte the file pinned in `../assets.lock`. `cargo xtask
fetch-assets` downloads the font from fonts.qurancomplex.gov.sa and falls back to this copy when the download fails
(docs/ARCHITECTURE.md §4.7, LEAD 24).

The font is © King Fahd Glorious Qur'an Printing Complex and is used under its end-user licence, reproduced in
`../../public/fonts/KFGQPC-Hafs-V30.LICENSE.txt`. It is not covered by the repository's GPL. The licence allows
unmodified redistribution only: never edit, subset or convert this file.
