# Labyrinth Online

A mobile-first take on the sliding-maze treasure hunt for 2–4 players: play against bots instantly, or create a room and share the 4-letter code with friends (bots can fill empty seats).

**Rules in brief:** each turn, rotate the spare tile, push it in from one of the 12 arrows (never straight back where the last player pushed from), then walk your pawn along any open path. Collect your treasures in order (your current target is shown under the board; opponents can't see your list), then run back to your corner. First home wins. 12 treasures are dealt out evenly, so a 2-player game is 6 each.

- `public/game.js` is the rules engine, shared by the server and browser.
- `public/bot.js` is the bot. It only uses what a real player can see: the board and its own cards.
- `server.js` is a zero-dependency Node server using REST + Server-Sent Events. Opponents' cards never leave the server.
- Solo-vs-bots runs entirely in the browser, so it works offline once loaded (PWA, installable).
- `tools/prepare_sprites.py` rebuilds `public/img/*.webp` and the app icons from the source Labyrinth assets.

```bash
npm start   # http://localhost:3000
npm test
```

## Mobile notes
Tap-to-confirm (arrow, then arrow again; green square, then again) prevents fat-finger mistakes. Haptics on your turn, screen wake lock during a game, safe-area aware, landscape layout, reduced-motion respected. About 52 KB of WebP sprites cached for 30 days; code is gzipped and ETagged in memory.

## Online play
A seat that drops offline for 25 s is played by a bot until they reconnect, so a dead phone never stalls the table. Clients reconnect automatically and resume from `localStorage`.

## Render free tier
`render.yaml` deploys a free web service with no build step and no dependencies. Rooms live in memory, so they reset when the free instance sleeps after 15 minutes of inactivity.

Tile and treasure art come from the project's Labyrinth asset folder; Labyrinth is a Ravensburger game and this is a fan project.
