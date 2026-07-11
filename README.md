# GenMate Chess Assistant — Lite v1

> Engine thinks — you move.

Stockfish 18 Lite hints in real time while you play vs computer on Lichess.
The engine runs entirely in your browser. Nothing is sent to any server.

## Quick start

1. Open `about:debugging` in Firefox → **This Firefox** → **Load Temporary Add-on…**
2. Select `manifest.json` from this folder
3. Click the GenMate icon in the browser toolbar
4. Get a token: [lichess.org/account/oauth/token/create](https://lichess.org/account/oauth/token/create)
   — enable **board:play** — paste it into the popup → **Save token**
5. Open a game vs computer on Lichess — hints appear automatically

## Supported games

| Mode | Works |
|---|---|
| vs Stockfish (any level) | Yes |
| vs Lichess AI | Yes |
| vs human | Full version only |
| Spectating | No |

Full version (more variations, stronger engine): lichess.org/@/GenMate

## Optional: stronger engine

This Lite build ships with the small Stockfish 18 Lite engine. You can switch to
the full Stockfish 18 NNUE engine without editing any code:

1. Put these two files into the `wasm/` folder:
   `stockfish-18-single.js` and `stockfish-18-single.wasm`
2. Reopen the popup — an **Engine** selector appears
3. Choose **Strong** — the full engine loads on the next analysis

Remove the two files to go back to Lite.

## Community

- Lichess: lichess.org/@/GenMate

## Support

If it helps you, you can tip the project: pay.cloudtips.ru/p/45b63590

## License

GNU General Public License v3.0
Source: github.com/GenMate/genmate-chess-assistant

Stockfish © T. Romstad et al. — GPL v3
chess.js © Jeff Hlywa — BSD 2-Clause
