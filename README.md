# Procedural Dirt Road System

A terrain-aware spline road editor with automatic river crossings. Draw curved
dirt roads, snap routes into a connected network, and generate timber bridge
structures where roads cross water.

## Features

- Procedural valley terrain with a river, meadow grass, woodland, and stone ground cover
- Textured spline roads that conform to the terrain
- Endpoint, segment, and intersection snapping for connected road networks
- Automatic timber decks, supports, and railings at valid river crossings
- Adjustable spline curvature while placing a route
- Undo, redo, and clear controls
- RTS-style camera movement with rotation and a 30–1000% zoom range

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

Create a production build with `npm run build`.
