# Battleship Toys — Publish Package

Toy fleets, tiny islands, big splashes. An isometric naval duel rendered on `<canvas>`:
play the computer, share one keyboard, or play online via copy-paste invite codes (WebRTC).

## What's in this package

- `index.html` — the entry page. Loads the game component full-screen.
- `battleship-game.js` — the entire game: a self-contained vanilla web component
  (`<battleship-game>`). No framework, no build step, no dependencies.
  The only external resource is the Nunito font from Google Fonts (the game
  degrades gracefully without it).

**This is production-ready static content, not a design mock.** It runs as-is in any
modern browser. The task is purely to publish it, not to recreate it.

## Task for Claude Code: publish to GitHub Pages

1. Create a new public GitHub repository (suggested name: `battleship-toys`) with
   these two files at the repo root.
2. Commit and push.
3. Enable GitHub Pages: Settings → Pages → Deploy from branch → `main`, root (`/`).
   Or via CLI after pushing:
   ```
   gh repo create battleship-toys --public --source . --push
   gh api -X POST repos/{owner}/battleship-toys/pages -f 'source[branch]=main' -f 'source[path]=/'
   ```
4. Verify the site at `https://<owner>.github.io/battleship-toys/` — the menu screen
   should appear; "Play the computer" should start a match immediately.

Notes:
- No build, no `package.json`, no CI needed. Do not add a bundler.
- All paths are relative, so it works from a project subpath (`/battleship-toys/`)
  as well as a custom domain.
- Online multiplayer uses manual-signaling WebRTC (players exchange invite codes
  by hand), so it needs **no server** — static hosting is sufficient. It uses a
  public Google STUN server; no TURN, so some strict NATs may fail to connect.
- Requires a secure context in practice; GitHub Pages (HTTPS) is fine.

## Game configuration

Attributes on the `<battleship-game>` tag in `index.html`:

- `map-size` — battlefield size in tiles, 12–40 (default 20)
- `win-score` — sinkings needed to win, 1–20 (default 5)

## Controls (shown in-game)

- Sail: WASD or Arrows
- Space cannon · E torpedo · R missile · Q broadside · F drops mines (with pickup)
- Local 2-player: Red = WASD/Space/E/R/Q/F, Blue = Arrows/Enter/⇧/./​//,

## Features worth smoke-testing

- AI opponent, local 2-player, online host/join flow (invite code copy buttons)
- Power-ups: Tailwind, Iron hull, Quick load, Homing torpedoes, Rockets, Sea mines
- Destructible islands (cannon fire erodes terrain), rocks, shallows
- A sea monster lairs at a seeded deep-water spot — bubbles + a dark pulsing
  shadow mark it; sailing close triggers its attack
- All sound is synthesized via Web Audio (no audio assets)
