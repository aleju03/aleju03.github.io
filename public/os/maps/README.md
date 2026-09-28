# Map pictures

The prints on the map sheet (`src/components/os/MapPicker.tsx`), one per map
in `src/game/levels/maps.ts`, named by its id. They are this project's own
renders, not downloaded assets: `npm run drive -- mapcards` photographs each
map with the page's HUD hidden (`shots/sandbox/mapcard-*.png`), and each file
here is one of those scaled to 640x400 (nearest neighbour) and saved as WebP.
A new map needs a new picture here, or its print is blank.
