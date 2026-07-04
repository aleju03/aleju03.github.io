#!/usr/bin/env python3
"""Build a Rhythm Keys track from a real osu!mania beatmap.

Downloads a beatmapset from the catboy.best mirror, picks the 4K mania
difficulty whose name matches, converts its .osu into the chart.json the
game loads, and stages the audio as song.mp3 (re-encoding through ffmpeg
when asked or when the source is not mp3 — lame/ffmpeg round-trips were
measured shift-free by cross-correlation, see the arcade notes).

Long notes become taps at their head: the game is deliberately tap-only.

usage:
  python3 scripts/osu-chart.py <beatmapset-id> "<diff name substring>" <outdir> [bitrate]

example:
  python3 scripts/osu-chart.py 2477633 "comfortable" public/os/games/vsrg/madeoffire
  python3 scripts/osu-chart.py 361806 "C.Star" public/os/games/vsrg/freedomdive 128k
"""

import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

MIRROR = 'https://catboy.best/d/{}'


def parse_osu(text: str):
    section = None
    general, meta = {}, {}
    timing = []
    notes = []
    long_notes = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('//'):
            continue
        m = re.match(r'^\[(\w+)\]$', line)
        if m:
            section = m.group(1)
            continue
        if section in ('General', 'Metadata', 'Difficulty'):
            if ':' in line:
                k, v = line.split(':', 1)
                (general if section == 'General' else meta)[k.strip()] = v.strip()
        elif section == 'TimingPoints':
            parts = line.split(',')
            if len(parts) >= 2:
                beat_len = float(parts[1])
                if beat_len > 0:  # uninherited points only
                    timing.append((float(parts[0]), beat_len))
        elif section == 'HitObjects':
            parts = line.split(',')
            if len(parts) < 5:
                continue
            x, t, typ = int(parts[0]), int(parts[2]), int(parts[3])
            lane = min(3, max(0, x * 4 // 512))
            if typ & 128:
                long_notes += 1
            notes.append((t, lane))
    notes.sort()
    # drop exact duplicates, they would be unhittable stacked circles
    seen, clean = set(), []
    for n in notes:
        if n not in seen:
            seen.add(n)
            clean.append(n)
    return general, meta, timing, clean, long_notes


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    set_id, want, outdir = sys.argv[1], sys.argv[2].lower(), Path(sys.argv[3])
    bitrate = sys.argv[4] if len(sys.argv) > 4 else None

    with tempfile.TemporaryDirectory() as tmp:
        osz = Path(tmp) / 'set.osz'
        print(f'downloading set {set_id} from the mirror...')
        urllib.request.urlretrieve(MIRROR.format(set_id), osz)
        z = zipfile.ZipFile(osz)

        picked = None
        for name in z.namelist():
            if not name.lower().endswith('.osu'):
                continue
            text = z.read(name).decode('utf-8-sig', errors='replace')
            general, meta, timing, notes, long_notes = parse_osu(text)
            if general.get('Mode') != '3' or meta.get('CircleSize', general.get('CircleSize')) not in (None, '4'):
                pass
            if want not in meta.get('Version', '').lower():
                continue
            if general.get('Mode') != '3':
                print(f'  skipping {name}: not a mania chart')
                continue
            picked = (name, general, meta, timing, notes, long_notes)
            break
        if not picked:
            print('no matching mania difficulty found; available:')
            for name in z.namelist():
                if name.lower().endswith('.osu'):
                    print('  ', name)
            sys.exit(1)

        name, general, meta, timing, notes, long_notes = picked
        bpm = round(60000 / timing[0][1], 3) if timing else 120
        outdir.mkdir(parents=True, exist_ok=True)
        chart = {
            'title': meta.get('Title', '?'),
            'artist': meta.get('Artist', '?'),
            'version': meta.get('Version', '?'),
            'creator': meta.get('Creator', '?'),
            'bpm': bpm,
            'notes': [[t, l] for t, l in notes],
        }
        (outdir / 'chart.json').write_text(json.dumps(chart, separators=(',', ':')))

        audio_name = general.get('AudioFilename', '')
        audio = z.read(audio_name)
        src = Path(tmp) / audio_name
        src.write_bytes(audio)
        dest = outdir / 'song.mp3'
        if bitrate or not audio_name.lower().endswith('.mp3'):
            subprocess.run(
                ['ffmpeg', '-loglevel', 'error', '-y', '-i', str(src),
                 '-codec:a', 'libmp3lame', '-b:a', bitrate or '160k', '-ar', '44100', str(dest)],
                check=True)
        else:
            shutil.copyfile(src, dest)

        dur = notes[-1][0] / 1000 if notes else 0
        print(f"{chart['artist']} - {chart['title']} [{chart['version']}] by {chart['creator']}")
        print(f'  bpm {bpm} | {len(notes)} notes ({long_notes} LNs became taps) | {dur:.0f}s')
        print(f'  audio {dest.stat().st_size / 1e6:.1f} MB | wrote {outdir}/chart.json + song.mp3')
        print(f'  TrackDef: bpm: {round(bpm)}, seconds: {round(dur)}, noteCount: {len(notes)}')


if __name__ == '__main__':
    main()
