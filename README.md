# GenMate Chess Assistant 1.2.0

> Engine thinks — you move.

Stockfish 19 hints in real time while you play vs computer on Lichess.
The engine runs entirely in your browser.

## Changelog

- **1.2.0** — Deep navy HUD and popup with an amber HUD frame, fixed resizable HUD, persistent hints during reconnection, viewport-safe positioning, up to three lines with two by default, stable hint font across line counts, origin-square hints by default, default-on extension news and bundled Stockfish 19 Full. Lite remains the default.

- **1.1.1** — supports the new Lichess game page URLs (`/game/<id>`); legacy
  URLs (`/<id>`) still work. More reliable reconnection with clear status
  messages in the hint box (HUD). New data settings page: after installing or
  updating, allow game access once to use hints. Engine updated to
  Stockfish 19 Lite (stockfish.js 19.0.1). The cloud evaluation request
  was removed — analysis is local only. News checks were opt-in in that release; version 1.2.0 enables them by default.
  Settings and the token are now stored in this browser only (not synced).
- **1.1.0** — first public release.

## Quick start

1. Install the extension (signed package from addons.mozilla.org), or for
   testing: `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
   → select `manifest.json` from this folder
2. A **Data settings** tab opens once — click **Allow game access**
3. Click the GenMate icon in the browser toolbar
4. Get a token: [lichess.org/account/oauth/token/create](https://lichess.org/account/oauth/token/create)
   — enable **board:play** — paste it into the popup → **Save token**
5. Open a game vs computer on Lichess — hints appear automatically

## Supported games

| Mode | Works |
|---|---|
| vs Stockfish / Lichess AI (any level) | Yes |
| Standard chess or "From position" | Yes |
| Chess960 and other variants | No (the HUD says so) |
| vs human | No |
| Lichess TV | No (no HUD) |
| Spectating | No (hints require access to your own game) |

## Data

Stockfish analysis runs locally in your browser. With your permission, the
extension sends your Lichess API token and the ID of the game you open to
lichess.org, only to read that game's moves. The developer does not receive
your token, games or positions. The extension also checks a small
news file hosted on GitHub every few hours; that request contains no token,
game or browsing data. News checks are enabled by default; unread items can be dismissed.
The extension stores your token and settings in this
browser only (not synced). A token saved by version 1.1.0 may also be kept in
Firefox Sync storage, which Firefox manages; "Remove token" deletes the local
token and requests deletion of the old Firefox Sync copy; any storage error is
shown. Removing the token from the extension does not revoke it on Lichess.
No analytics or telemetry.

You can change your choice any time: popup → **Data settings**.

## Engine choice

Both Stockfish 19 Lite and Full NNUE (single-threaded) are included. Choose the
engine in the toolbar popup. Lite is the default and uses fewer resources.
Full starts only when selected; no additional download or installation is needed.
Only one engine worker runs at a time. Inactive workers are unloaded after the
existing idle timeout. The package is larger because it contains both engines.
A failed Full start is reported; it does not silently switch to Lite.

Public MultiPV supports 1, 2 or 3 lines. New installations show the piece and
origin square; existing saved display choices are retained.

Stockfish and its networks are GPL-3.0. Exact versions, hashes and source links
are in THIRD-PARTY-NOTICES. The distribution includes a separate corresponding
source archive with the original source tree, build instructions and NNUE inputs.

## HUD layout

The base HUD is 330 CSS pixels wide. Selecting 1, 2 or 3 lines adjusts its height
without shrinking the hint font. Two lines are selected by default for new or
unset preferences. A two-line status area remains reserved during analysis and
reconnection. Drag the header to move, or use the lower-right grip to resize.
The gear stays green and scores are bold without an equals prefix.

Timed analysis keeps its final hints and depth without an extra completion message.

## Source and packaging

See [BUILD-AND-SOURCE.md](https://github.com/GenMate/genmate-chess-assistant/blob/main/BUILD-AND-SOURCE.md). This repository intentionally
keeps the bundled engine JavaScript and WebAssembly files in the established
`wasm/` layout so a checkout remains directly loadable and packageable. No Git
LFS pointers or executable downloads are used. The complete corresponding
engine source and NNUE inputs are distributed as GitHub Release assets.

## Community and license

- Lichess: https://lichess.org/@/GenMate
- License: GNU General Public License v3.0; see LICENSE and THIRD-PARTY-NOTICES.
