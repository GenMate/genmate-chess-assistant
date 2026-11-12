# Source and packaging — 1.2.0

The extension source is at the repository root. No transpilation, dependency
installation or minification is required. For development, load manifest.json
with Firefox about:debugging. Run tests with `node --test tests/`.

## Packaging

Include only these extension files, preserving relative paths:
LICENSE, README.md, THIRD-PARTY-NOTICES, background.html, background.js,
chess.js, common.js, consent.html, consent.js, content.js, manifest.json,
news.json, popup.html, popup.js, icons/*.png, and wasm/*.js / wasm/*.wasm.
manifest.json must be at the archive root. Use ZIP_STORED for both .wasm
files and ZIP_DEFLATED for the other files. Exclude tests, .git, this build
document, local notes and release archives. Never include Git LFS pointers.
For installation, prefer the signed package provided by AMO.

The repository intentionally tracks both upstream engine builds, continuing
the existing vendored wasm/ layout. Full is about 99 MB; release archives and
engine source archives belong in release assets, not in Git history.

## Corresponding engine source

The GitHub Release for v1.2.0 supplies
stockfish-js-19.0.1-corresponding-source.tar.gz alongside
 genmate-chess-assistant-1.2.0-review-sources.zip and checksum files.
The reviewer ZIP contains the complete extension under extension/, this
release's exact engine-source archive and reviewer packaging instructions.

The engine-source archive includes the exact upstream C++/JavaScript source,
both NNUE inputs and BUILD-GENMATE.txt. Refer to THIRD-PARTY-NOTICES for exact
upstream versions and SHA256 values. Stockfish binaries were not rebuilt by
this project; they are byte-identical upstream assets. Independent reproducible
engine compilation has not been verified. Do not claim a bit-reproducible build.

Root news.json is a live news feed and is updated independently of packaged
extension code. Source preparation preserves its current public content;
release announcements must wait until the signed update is publicly available.
