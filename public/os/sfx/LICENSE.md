# Sound credits

The recorded audio on the site: the house doors in roam mode
(`doorCreak`/`doorLatch` in `src/game/core/sfx.ts`) and the footsteps of
set b (`src/game/core/footsteps.ts`, the `steps b` console switch).
Everything else (the default footsteps, landings, the UI and the backrooms
hum) is synthesized at runtime with WebAudio.

## CC BY 4.0 (attribution required)

All nine clips are cut from recordings by **Gravity Sound**, licensed CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/), via Wikimedia Commons:

| clip | source recording | segment |
| --- | --- | --- |
| `door-open-1`, `door-close-1`, `door-latch-1` | [Open and close squeaky door](https://commons.wikimedia.org/wiki/File:Open_and_close_squeaky_door_(Gravity_Sound).wav) | 1.16–1.30 + 1.44–2.00, 5.46–5.88, 6.33–6.70 |
| `door-open-2`, `door-latch-2` | [Open and close closet door](https://commons.wikimedia.org/wiki/File:Open_and_close_closet_door_(Gravity_Sound).wav) | 0.78–1.52, 3.13–3.58 |
| `door-close-2` | [Open and close closet door 3](https://commons.wikimedia.org/wiki/File:Open_and_close_closet_door_3_(Gravity_Sound).wav) | 2.43–2.95 |
| `door-open-3`, `door-close-3`, `door-latch-3` | [Open and close bathroom door](https://commons.wikimedia.org/wiki/File:Open_and_close_bathroom_door_(Gravity_Sound).wav) | 0.80–1.48, 3.98–4.52, 4.79–5.22 |

Modified: cut to the onset of each event (`door-open-1` splices the leaf popping
free straight onto its squeak, dropping the dead air between them), downmixed to
32 kHz mono, high-passed at 85 Hz, denoised, faded at both ends, normalized to a
common RMS with soft-knee limiting so one playback gain suits every variant, and
encoded as MP3.

## CC0 (public domain dedication)

`steps.mp3` packs 23 footsteps from **Kenney**'s "Impact Sounds" 1.0
(https://kenney.nl/assets/impact-sounds), released under Creative Commons
Zero (http://creativecommons.org/publicdomain/zero/1.0/). No attribution is
required; it is given anyway.

| slots | source files |
| --- | --- |
| 0-4 | `footstep_grass_000` to `004` |
| 5-9 | `footstep_wood_000` to `004` |
| 10-12 | `footstep_carpet_000`, `001`, `003` (`002` and `004` are byte-identical repeats of `001` and `003`) |
| 13-17 | `footstep_concrete_000` to `004` |
| 18-22 | `footstep_snow_000` to `004` |

Modified: high-passed at 45 Hz, cut 2 ms ahead of each onset and at -42 dB
of its tail (at most 228 ms), faded out over 30 ms, normalized to a common
RMS over the first 80 ms with a 0.95 peak ceiling, placed one per 250 ms
slot 10 ms in, and encoded as one 64 kbps mono MP3. The game plays them
some 26 to 30 dB under that, matched to the synthesized mix.
