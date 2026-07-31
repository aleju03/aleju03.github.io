# Page audio credits

Recorded audio for the portfolio page's score. A file here is played by the cue
that names it in `SAMPLES` (`src/audio/bank.ts`); every cue not listed there
plays the synthesized voice in the same file, which is also the fallback if a
file here is missing or the browser will not decode it.

Nothing has landed yet. The whole bank is currently synthesized.

## The rule for anything that lands here

**CC0 only.** This repository is public, so cloning it redistributes whatever is
in `public/`, and CC0 makes that a non-question: no attribution chain to keep
intact, no licence file that has to travel with the bytes. That is the one
difference from `public/os/sfx/`, where the house doors are CC BY and carry a
`LICENSE.md` for exactly that reason. Provenance still gets written down below,
because "where did this come from" is a question I will ask again later.

[Kenney](https://kenney.nl/assets/interface-sounds) and
[Freesound](https://freesound.org) filtered to Creative Commons 0 are the two
sources that qualify. The Sonniss GDC bundle does not: its licence covers use in
a project and excludes redistributing the raw files, which is what committing
one here would be. Neither do BBC Sound Effects or Zapsplat.

## What a file has to be

Mono, 44.1 kHz, WAV or MP3, and **trimmed to start on the transient**. Room tone
at the head of a file is not air around the sound, it is the site being slow.

Do not pre-normalise: `loadSample` decodes each file, measures its true peak and
re-encodes it at the level `PEAK` declares for that cue, so `bank.ts` stays the
single place loudness is decided. Library files arrive mastered near 0 dBFS,
roughly four times hotter than this mix, and a hand-gained one sitting next to
the synthesized cues does not add a sound, it adds a sound that shouts.

`boot` is deliberately excluded. It is the one cue that should be musical rather
than physical, it is already tuned to the E minor centre AlejOS boots in, and a
field recording there would break the thing the bank does best, which is that
the page and the machine inside it sound like one instrument.

## Sources

| file | cue | source | licence |
| --- | --- | --- | --- |
| | | *nothing yet* | |
