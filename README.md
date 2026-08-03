# Kupa Roadworks

A fully client-side extraction of the road-building experience from
`medieval-road-system`. It opens directly on one fixed small Kupa Valley map—no
login, world setup, server, or save backend.

## Included

- The medieval project’s RTS camera tuning and 30–1000% zoom range
- Fixed Kupa Valley terrain recipe, river layout, meadow grass, woodland, and stones
- Textured spline dirt roads with snapping and road-network intersections
- Automatic timber decks, supports, and railings wherever a valid road crosses the river
- The original construction hammer artwork and road-placement sound
- Undo, redo, clear, and device-local runtime state only

## Controls

- `R` toggles the road tool
- Left-click places spline control points
- `Ctrl` + mouse wheel curves the pending segment
- `Enter` builds the road
- `Esc` cancels the draft
- `Ctrl/Cmd + Z` and `Ctrl/Cmd + Y` undo/redo
- `WASD` pans, middle mouse rotates, mouse wheel zooms, and `Q`/`E` rotate

## Run

```bash
npm install
npm run dev
```

The production build is a static client bundle created with `npm run build`.
