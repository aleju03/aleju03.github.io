# Animal model credits

The open world's fauna (`src/game/world/fauna.ts`), loaded lazily after the
planet attaches and never on a boot that stays indoors.

## CC0

All six are from the "Ultimate Animated Animal Pack" by Quaternius
(https://quaternius.com/packs/ultimateanimatedanimals.html), mirrored on
poly.pizza (https://poly.pizza/bundle/Animated-Animal-Pack-ILAPXeUYiS), under
CC0. No attribution is required; it is recorded here because every other model
in this repo is.

- `deer.glb`, `fox.glb`, `wolf.glb`, `horse.glb`, `cow.glb`, `alpaca.glb`

Six is what covers all eleven land biomes with one or two species each; the
pack ships twelve, and the other six (bull, donkey, husky, shiba inu, stag,
white horse) are a `SPECIES_FILES` entry and a download away.

## Modified from the published files

Each published GLB is about 1 MB, of which roughly two thirds is animation,
for two reasons: every clip ships twice, once bare and once prefixed
`AnimalArmature|`, and there are 24 to 26 of them, including four death and
hit-react variants an ambient deer will never play.

These copies keep `Idle`, `Walk`, `Gallop` and `Eating` — the four the state
machine plays — deduped, resampled and welded with `@gltf-transform`
(`resample`, `weld`, `dedup`, `prune`). That is ~1.0 MB down to ~0.3 MB each,
and 105-130 kB gzipped over the wire. Geometry is untouched: 3.7k to 5k
vertices, which is where it was.

They are also drawn at roughly 2.2x this world's scale — a fox out of the box
stands 2.69 units against a 3.84 eye height. The per-species scale that fixes
that lives in `KINDS` in `fauna.ts`, not in the files.
