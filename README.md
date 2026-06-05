# GenMate Chess Assistant — Lite v1

> Engine thinks — you move.

Stockfish 18 Lite hints in real time while you play vs computer on Lichess.
The engine runs entirely in your browser. Nothing is sent to any server.

## Quick start

1. Open `about:debugging` in Firefox → **This Firefox** → **Load Temporary Add-on…**
2. Select `manifest.json` from this folder
3. Click the GenMate icon in the browser toolbar
4. Get a token: [lichess.org/account/oauth/token/create](https://lichess.org/account/oauth/token/create)
   — enable **board:play** — copy and paste into the popup → **Save**
5. Open a game vs computer on Lichess — hints appear automatically

## Supported games

| Mode | Works |
|---|---|
| vs Stockfish (any level) | ✅ |
| vs Lichess AI | ✅ |
| vs human | ❌ Full version only |
| Spectating | ❌ |

Full version (multiple variations, stronger engine):
lichess.org/@/GenMate

## Community

- Lichess: lichess.org/@/GenMate
- YouTube: youtube.com/@genmate

## License

GNU General Public License v3.0
Source: github.com/GenMate/genmate-chess-assistant

Stockfish © T. Romstad et al. — GPL v3
chess.js © Jeff Hlywa — BSD 2-Clause
