// Regenerates server/src/timezones.js — the IANA timezone -> ISO country map
// the analytics capture route uses when no edge geo header is present.
//
// Everything comes from the tzdata already installed on this machine:
//   - zone.tab / zone1970.tab give canonical zone -> country
//   - aliases (Asia/Calcutta -> Asia/Kolkata) come from content-hashing the
//     zoneinfo tree, because the `backward` source file is not installed on
//     most distros but aliases are byte-identical copies of their canonical
//     zone, and browsers on older systems still report them
//
// Run: node scripts/gen-timezones.mjs

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = '/usr/share/zoneinfo';
const OUT = fileURLToPath(new URL('../server/src/timezones.js', import.meta.url));
const SKIP_DIRS = new Set(['posix', 'right', 'SystemV']);
const SKIP_FILES = new Set(['leapseconds', 'tzdata.zi', 'localtime', 'iso3166.tab']);
// zones that describe an offset, not a place
const NOT_A_PLACE = ['UTC', 'GMT', 'Universal', 'Zulu', 'GMT0', 'Greenwich', 'GMT+0', 'GMT-0'];

const zoneCountry = new Map();
for (const tab of ['zone.tab', 'zone1970.tab']) {
  for (const line of readFileSync(join(ROOT, tab), 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    // zone1970 lists every country sharing a zone; the first is the primary
    if (!zoneCountry.has(parts[2])) zoneCountry.set(parts[2], parts[0].split(',')[0]);
  }
}

const byDigest = new Map();
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full);
      continue;
    }
    const name = relative(ROOT, full);
    if (SKIP_FILES.has(name) || /\.(tab|list|zi)$/.test(name)) continue;
    const buf = readFileSync(full);
    if (buf.subarray(0, 4).toString() !== 'TZif') continue;
    const digest = createHash('sha256').update(buf).digest('hex');
    if (!byDigest.has(digest)) byDigest.set(digest, []);
    byDigest.get(digest).push(name);
  }
}
walk(ROOT);

let aliases = 0;
for (const names of byDigest.values()) {
  const known = names.filter((n) => zoneCountry.has(n));
  if (known.length === 0) continue;
  const countries = new Set(known.map((n) => zoneCountry.get(n)));
  // a shared offset across countries proves nothing about location
  if (countries.size !== 1) continue;
  const cc = zoneCountry.get(known[0]);
  for (const n of names) {
    if (!zoneCountry.has(n) && n.includes('/')) {
      zoneCountry.set(n, cc);
      aliases += 1;
    }
  }
}

for (const bogus of NOT_A_PLACE) zoneCountry.delete(bogus);
for (const zone of [...zoneCountry.keys()]) {
  if (zone.startsWith('Etc/')) zoneCountry.delete(zone);
}

const byCountry = new Map();
for (const zone of [...zoneCountry.keys()].sort()) {
  const cc = zoneCountry.get(zone);
  if (!byCountry.has(cc)) byCountry.set(cc, []);
  byCountry.get(cc).push(zone);
}

const body = [...byCountry.keys()]
  .sort()
  .map((cc) => `  ${cc}: '${byCountry.get(cc).join(' ')}',`)
  .join('\n');

writeFileSync(
  OUT,
  `// IANA timezone -> ISO 3166 country, generated from the tzdata shipped with
// the system: \`zone.tab\` + \`zone1970.tab\` primaries, plus every alias
// recovered by content-hashing the zoneinfo tree (the \`backward\` file is not
// installed on most distros, but aliases are byte-identical copies of their
// canonical zone, so Asia/Calcutta still resolves to IN).
//
// This is the fallback geo source. A real edge (Cloudflare, Vercel) resolves
// the country from the client IP and sends it in a header, which always wins;
// behind a plain Caddy there is no such header, so the browser's own timezone
// stands in. It is a decent proxy for where someone physically is - clocks are
// set to where you are - and unlike an IP database it needs no license key, no
// file to keep updated, and no third-party request sitting in the capture
// path. It is also client-supplied and so trivially wrong for anyone who wants
// it to be, which is the right amount of rigour here.
//
// DO NOT EDIT: regenerate with \`node scripts/gen-timezones.mjs\`.

const ZONES_BY_COUNTRY = {
${body}
};

const COUNTRY_BY_ZONE = new Map();
for (const [country, zones] of Object.entries(ZONES_BY_COUNTRY)) {
  for (const zone of zones.split(' ')) COUNTRY_BY_ZONE.set(zone, country);
}

/** ISO country for an IANA timezone name, or null if it says nothing useful. */
export function countryForTimeZone(zone) {
  if (typeof zone !== 'string') return null;
  return COUNTRY_BY_ZONE.get(zone.trim()) ?? null;
}
`,
  'utf8'
);

console.log(
  `${zoneCountry.size} zones / ${byCountry.size} countries (${aliases} aliases recovered) -> ${OUT}`
);
