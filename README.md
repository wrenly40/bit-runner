# Bit Runner

A 3D runner made for GitHub Game Off 2026 (theme: SHIFT).

One lane. Doors roll toward you with numbers on them. Match the number
exactly, or crash. Your value starts at 7.

## Controls

- Left Shift: ×2
- Right Shift: ÷2
- X: +1
- , (comma): −1
- Esc: pause

Values grow without limit, but reaching 0 ends the run. Golden doors are
worth more, and missing one never kills you. Bursts are groups of doors
close together, each one shift from the last. Every 10 doors, the world
shifts to a new sector.

## Play

Open `index.html` in a browser. No build step, no server needed.

## Build

The game is assembled from `build/`:

```
cd build && cat top.html vendor/three.module.js post.js game.js bottom.html > ../index.html
```

Built with Three.js (vendored in `build/vendor/`) and procedural WebAudio
music and sound — no audio or image assets.

## AI disclosure

The code was written with AI assistance.
