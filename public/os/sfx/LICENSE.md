# Sound credits

The only recorded audio on the site: the house doors in roam mode
(`doorCreak`/`doorLatch` in `src/game/core/sfx.ts`). Everything else — footsteps,
landings, the UI and the backrooms hum — is synthesized at runtime with WebAudio.

## CC BY 4.0 (attribution required)

All nine clips are cut from recordings by **Gravity Sound**, licensed CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/), via Wikimedia Commons:

| clip | source recording | segment |
| --- | --- | --- |
| `door-open-1`, `door-close-1`, `door-latch-1` | [Open and close squeaky door](https://commons.wikimedia.org/wiki/File:Open_and_close_squeaky_door_(Gravity_Sound).wav) | 1.16–1.30 + 1.44–2.00, 5.46–5.88, 6.33–6.70 |
| `door-open-2`, `door-latch-2` | [Open and close closet door](https://commons.wikimedia.org/wiki/File:Open_and_close_closet_door_(Gravity_Sound).wav) | 0.78–1.52, 3.13–3.58 |
| `door-close-2` | [Open and close closet door 3](https://commons.wikimedia.org/wiki/File:Open_and_close_closet_door_3_(Gravity_Sound).wav) | 2.43–2.95 |
| `door-open-3`, `door-close-3`, `door-latch-3` | [Open and close bathroom door](https://commons.wikimedia.org/wiki/File:Open_and_close_bathroom_door_(Gravity_Sound).wav) | 0.80–1.48, 3.98–4.52, 4.79–5.22 |

Modified — cut to the onset of each event (`door-open-1` splices the leaf popping
free straight onto its squeak, dropping the dead air between them), downmixed to
32 kHz mono, high-passed at 85 Hz, denoised, faded at both ends, normalized to a
common RMS with soft-knee limiting so one playback gain suits every variant, and
encoded as MP3.
