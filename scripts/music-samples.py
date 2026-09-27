#!/usr/bin/env python3
"""
Builds the game soundtrack's sample set: public/os/music/<inst>/<midi>.mp3 and
the manifest src/game/music/samples.ts that says which notes exist.

Every recording comes from two CC0 libraries by Versilian Studios, VSCO 2
Community Edition and the Versilian Community Sample Library, fetched raw from
their GitHub repos (cached in /tmp/music-src). The table below is the whole
orchestra: which folder, which velocity layer, which range, and how far apart
the kept samples may sit (a sampler pitch-shifts the gaps, and past about two
semitones a piano starts to sound like a smaller or bigger piano).

Per file: decode to mono, cut the lead-in silence so the note starts ON its
onset, cap the length (a fade, not a chop, when it is capped), match loudness
on the attack, and encode 96 kbps mono MP3. MP3 because it is the one lossy
format every browser's decodeAudioData takes; the encoder's own padding is
skipped at runtime by an onset scan (music/sampler.ts).

The libraries do not agree on octave numbering, so each file's pitch is
measured and checked against its name. A consistent octave offset per
instrument is applied and reported; the leftover detune in cents rides into
the manifest so every note plays in tune.

  python3 scripts/music-samples.py            # build everything
  python3 scripts/music-samples.py piano harp # just these
"""
import json, os, re, shutil, subprocess, sys, urllib.parse, urllib.request
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public/os/music')
MANIFEST = os.path.join(ROOT, 'src/game/music/samples.ts')
CACHE = '/tmp/music-src'
SR = 44100
REPOS = {'VSCO': 'sgossner/VSCO-2-CE', 'VCSL': 'sgossner/VCSL'}
NOTE = r'([A-G]#?-?\d)'

# name: (repo, folder, filename regex with the note as group 1, lo, hi, min spacing, max seconds)
PITCHED = {
    'piano': ('VCSL', 'Chordophones/Zithers/Upright Piano, Knight/Sustains', rf'Player_vl1_rr1_{NOTE}\.wav', 'C2', 'G6', 2, 4.5),
    'harp': ('VSCO', 'Strings/Harp', rf'KSHarp_{NOTE}_mf\.wav', 'C2', 'C7', 2, 3.5),
    'glock': ('VCSL', 'Idiophones/Struck Idiophones/Glockenspiel', rf'glock_soft_{NOTE}_0\d\.wav', 'C4', 'C8', 1, 2.2),
    'kalimba': ('VCSL', 'Idiophones/Plucked Idiophones/Kalimba, Tanzania', rf'MBira3_pluck_Main_{NOTE}_k\d+(?:alt)?_50_100_rr2\.wav', 'C3', 'C7', 2, 2.5),
    'flute': ('VSCO', 'Woodwinds/Flute/susvib', rf'LDFlute_susvib_{NOTE}_v1_1\.wav', 'C3', 'C7', 2, 4.5),
    'ocarina': ('VCSL', 'Aerophones/Edge-blown Aerophones/Ocarina, Typical/Sustains/SusVib', rf'StdOcarina_SusVib_{NOTE}\.wav', 'C3', 'C7', 2, 4.5),
    'clarinet': ('VSCO', 'Woodwinds/Clarinet/susLong', rf'DCClar_susLong_{NOTE}_v1_rr1_sum\.wav', 'C2', 'C7', 2, 4.5),
    'oboe': ('VSCO', 'Woodwinds/Oboe/Vib', rf'Oboe_Vib_{NOTE}_v1_Main\.wav', 'C3', 'C7', 2, 4.5),
    'bassoon': ('VSCO', 'Woodwinds/Bassoon/stac', rf'PSBassoon_{NOTE}_v1_rr1\.wav', 'C1', 'C5', 2, 0.9),
    'vlnPizz': ('VSCO', 'Strings/Violin Section/Pizz', rf'VlnEns_Pizz_{NOTE}_v1_rr1\.wav', 'C2', 'C7', 2, 1.2),
    'celloPizz': ('VSCO', 'Strings/Cello Section/pizzT', rf'pizzT_{NOTE}_v1_RR1\.wav', 'C0', 'C5', 2, 1.8),
    'violins': ('VSCO', 'Strings/Violin Section/susVib', rf'VlnEns_susVib_{NOTE}_v1\.wav', 'C2', 'C7', 2, 5.5),
    'violas': ('VSCO', 'Strings/Viola Section/susvib', rf'ViolaEns_susvib_{NOTE}_v1_1\.wav', 'C1', 'C6', 2, 5.5),
    'celli': ('VSCO', 'Strings/Cello Section/susvib', rf'susvib_{NOTE}_v1_1\.wav', 'C0', 'C5', 2, 5.5),
    'horn': ('VSCO', 'Brass/F Horn/sus', rf'MOHorn_sus_{NOTE}_v1_1\.wav', 'C0', 'F5', 2, 4.5),
    'vibes': ('VCSL', 'Idiophones/Struck Idiophones/Vibraphone/Soft Mallets', rf'Vibes_soft_{NOTE}_v1_rr\d_Main\.wav', 'C2', 'C7', 2, 4.0),
    'marimba': ('VCSL', 'Idiophones/Struck Idiophones/Marimba', rf'Marimba_hit_Outrigger_{NOTE}_soft_01\.wav', 'C1', 'C7', 2, 1.6),
    'chimes': ('VCSL', 'Idiophones/Struck Idiophones/Hand Chimes', rf'sus_{NOTE}_r01_main\.wav', 'C3', 'C7', 3, 5.0),
}

# name: (repo, folder, [files], max seconds): unpitched, played by index
HITS = {
    'shaker': ('VCSL', 'Idiophones/Struck Idiophones/Shaker, Small',
               ['Mid_ShakerHighFaster_Down_rr1.wav', 'Mid_ShakerHighFaster_Up_rr1.wav',
                'Mid_ShakerHighFaster_Down_rr2.wav', 'Mid_ShakerHighFaster_Up_rr2.wav'], 0.5),
    'wood': ('VCSL', 'Idiophones/Struck Idiophones/Woodblock',
             ['wood_click_pp_rr1.wav', 'wood_click_pp_rr2.wav', 'wood_click_mp.wav'], 0.6),
    'triangle': ('VCSL', 'Idiophones/Struck Idiophones/Triangles',
                 ['Triangle6_HitM_v1_rr1_Mid.wav', 'Triangle1_Hit_v1_rr1_Mid.wav'], 3.0),
    'timpani': ('VSCO', 'Percussion/Timpani',
                ['Timpani3_Hit_v1_rr1_Sum.wav', 'Timpani2_Hit_v1_rr1_Sum.wav'], 3.0),
}

NAMES = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def midi_of(name):
    m = re.fullmatch(r'([A-G])(#?)(-?\d)', name)
    return 12 * (int(m.group(3)) + 1) + NAMES[m.group(1)] + (1 if m.group(2) else 0)


def listing(repo):
    path = os.path.join(CACHE, repo.replace('/', '_') + '.json')
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        url = f'https://api.github.com/repos/{repo}/git/trees/master?recursive=1'
        urllib.request.urlretrieve(url, path)
    return [x['path'] for x in json.load(open(path))['tree'] if x['type'] == 'blob']


def fetch(repo, path):
    local = os.path.join(CACHE, repo.replace('/', '_'), path)
    if not os.path.exists(local):
        os.makedirs(os.path.dirname(local), exist_ok=True)
        url = f'https://raw.githubusercontent.com/{repo}/master/' + urllib.parse.quote(path)
        urllib.request.urlretrieve(url, local)
    return local


def decode(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def pitch(x):
    """fundamental in Hz by normalised autocorrelation over a steady window"""
    a = int(0.08 * SR)
    w = x[a:a + int(0.25 * SR)]
    if len(w) < 2048:
        w = x[: int(0.25 * SR)]
    w = w - w.mean()
    n = len(w)
    f = np.fft.rfft(w * np.hanning(n), 2 * n)
    ac = np.fft.irfft(np.abs(f) ** 2)[:n]
    ac /= ac[0] + 1e-12
    lo, hi = int(SR / 4500), int(SR / 25)
    seg = ac[lo:hi]
    # the first peak that comes near the best one: the fundamental, not a
    # multiple of its period
    best = seg.max()
    for i in range(1, len(seg) - 1):
        if seg[i] > 0.85 * best and seg[i] >= seg[i - 1] and seg[i] >= seg[i + 1]:
            k = i
            break
    else:
        k = int(seg.argmax())
    # parabolic interpolation around the peak
    y0, y1, y2 = seg[k - 1], seg[k], seg[k + 1] if k + 1 < len(seg) else seg[k]
    d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2 + 1e-12)
    return SR / (lo + k + d)


def cents_of(x, midi):
    """how far a note sits off true pitch, from the spectrum: the strongest
    peak within 80 cents of the fundamental (or of the 2nd/3rd harmonic when
    the fundamental is weak, as on low strings and the horn). None when the
    recording has next to no energy at its labelled pitch at all, which
    means the label is wrong and the note is dropped"""
    a = int(0.1 * SR)
    w = x[a:a + int(0.5 * SR)]
    if len(w) < 8192:
        w = x[: int(0.5 * SR)]
    n = 1 << 18
    spec = np.abs(np.fft.rfft(w * np.hanning(len(w)), n))
    fr = np.fft.rfftfreq(n, 1 / SR)
    top = spec.max() + 1e-12
    f0 = 440 * 2 ** ((midi - 69) / 12)
    found = []
    for h in (1, 2, 3):
        sel = (fr > f0 * h * 2 ** (-0.8 / 12)) & (fr < f0 * h * 2 ** (0.8 / 12))
        if not sel.any():
            continue
        i = int(np.argmax(np.where(sel, spec, 0)))
        found.append((h, 1200 * np.log2(fr[i] / (f0 * h)), spec[i] / top))
    if not found:
        return None
    first = found[0]
    if first[0] == 1 and first[2] >= 0.1:
        return float(first[1])
    h, c, rel = max(found, key=lambda f: f[2])
    return float(c) if rel >= 0.05 else None


def shape(x, max_s):
    peak = np.abs(x).max() + 1e-12
    onset = int(np.argmax(np.abs(x) > 0.02 * peak))
    x = x[max(0, onset - int(0.003 * SR)):]
    n = int(max_s * SR)
    if len(x) > n:
        x = x[:n].copy()
        f = int(0.3 * n)
        x[-f:] *= 0.5 * (1 + np.cos(np.linspace(0, np.pi, f)))
    else:
        f = min(len(x), int(0.02 * SR))
        x[-f:] *= np.linspace(1, 0, f)
    # loudness matched on the attack, then a peak ceiling
    att = x[: int(0.4 * SR)]
    rms = np.sqrt(np.mean(att ** 2)) + 1e-12
    x = x * (10 ** (-20 / 20) / rms)
    p = np.abs(x).max()
    if p > 0.89:
        x *= 0.89 / p
    return x.astype(np.float32)


def encode(x, out):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-',
                    '-c:a', 'libmp3lame', '-b:a', '96k', out], input=x.tobytes(), check=True)


def pick(avail, lo, hi, spacing):
    notes = sorted(m for m in avail if lo <= m <= hi)
    kept = []
    for m in notes:
        if not kept or m - kept[-1] >= spacing:
            kept.append(m)
    return kept


def main(only):
    manifest = {}
    if os.path.exists(os.path.join(CACHE, 'manifest.json')):
        manifest = json.load(open(os.path.join(CACHE, 'manifest.json')))
    total = 0
    for name, (repo_key, folder, pat, lo, hi, spacing, max_s) in PITCHED.items():
        if only and name not in only:
            continue
        repo = REPOS[repo_key]
        files = {}
        for p in listing(repo):
            d, f = p.rsplit('/', 1) if '/' in p else ('', p)
            m = re.fullmatch(pat, f)
            if d == folder and m:
                files.setdefault(midi_of(m.group(1)), p)
        # fetch a few first to learn the octave convention from the audio
        chosen = pick(files.keys(), midi_of(lo) - 12, midi_of(hi) + 12, 1)
        measured = {}
        for m in chosen:
            x = decode(fetch(repo, files[m]))
            f0 = pitch(x)
            measured[m] = (x, 12 * np.log2(f0 / 440) + 69)
        offs = [round((real - m) / 12) * 12 for m, (_, real) in measured.items()]
        off = int(np.median(offs))
        odd = [(m, round(measured[m][1] - m, 2)) for m, o in zip(measured, offs) if o != off]
        real = {m + off: measured[m] for m in measured}
        keep = pick(real.keys(), midi_of(lo), midi_of(hi), spacing)
        shutil.rmtree(os.path.join(OUT, name), ignore_errors=True)
        notes, cents = [], []
        for m in keep:
            x, _ = real[m]
            c = cents_of(x, m)
            if c is None:
                print(f'  {name} {m}: no energy at its labelled pitch, dropped')
                continue
            y = shape(x, max_s)
            encode(y, os.path.join(OUT, name, f'{m}.mp3'))
            notes.append(m)
            cents.append(round(float(c), 1))
            total += os.path.getsize(os.path.join(OUT, name, f'{m}.mp3'))
        print(f'{name:10s} octave {off:+3d}  notes {notes}  cents {cents}' + (f'  (disagreed: {odd})' if odd else ''))
        manifest[name] = {'notes': notes, 'cents': cents}
    for name, (repo_key, folder, names, max_s) in HITS.items():
        if only and name not in only:
            continue
        repo = REPOS[repo_key]
        for i, f in enumerate(names):
            x = shape(decode(fetch(repo, f'{folder}/{f}')), max_s)
            out = os.path.join(OUT, name, f'{i}.mp3')
            encode(x, out)
            total += os.path.getsize(out)
        print(f'{name:10s} {len(names)} hits')
        manifest[name] = {'hits': len(names)}
    json.dump(manifest, open(os.path.join(CACHE, 'manifest.json'), 'w'))
    write_ts(manifest)
    print(f'wrote {total / 1e6:.2f} MB this run')


def write_ts(manifest):
    lines = [
        '/*',
        '  Generated by scripts/music-samples.py; edit the table there, not here.',
        '  Which recorded notes exist for each instrument of the soundtrack (MIDI',
        '  numbers, as measured, not as the source files were named), and how many',
        '  cents each recording sits off true pitch. The files are',
        '  public/os/music/<inst>/<midi>.mp3, CC0, credited in the LICENSE.md there.',
        '*/',
        '',
        'export interface PitchedSet { notes: readonly number[]; cents: readonly number[] }',
        'export interface HitSet { hits: number }',
        '',
        'export const PITCHED = {',
    ]
    for k in PITCHED:
        if k in manifest:
            v = manifest[k]
            lines.append(f"  {k}: {{ notes: {json.dumps(v['notes'])}, cents: {json.dumps(v['cents'])} }},")
    lines += ['} satisfies Record<string, PitchedSet>', '', 'export const HITS = {']
    for k in HITS:
        if k in manifest:
            lines.append(f"  {k}: {{ hits: {manifest[k]['hits']} }},")
    lines += ['} satisfies Record<string, HitSet>', '',
              'export type PitchedId = keyof typeof PITCHED',
              'export type HitId = keyof typeof HITS', '']
    open(MANIFEST, 'w').write('\n'.join(lines).replace('],', '],').replace(', ', ', '))


if __name__ == '__main__':
    main(set(sys.argv[1:]))
