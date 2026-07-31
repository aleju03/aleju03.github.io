# Playing card credits

Used by AlejOS Solitaire (`src/components/os/games/`).

`faces.png` is the 52 card faces of **Wine's `cards.dll`**, extracted from the
builtin DLL that ships with Wine/Proton and packed into one 13x4 sprite sheet
(rank across, suit down, in cards.dll's own `suit + 4 * (rank - 1)` order).
The bitmaps are 4-bit 71x96 DIBs; the only edit is that the classic
`#008000` key colour has been flood-filled from the four corners to
transparent, so the rounded corners sit on the baize instead of on a green
square. Nothing inside a court illustration was touched.

Wine is licensed **LGPL-2.1-or-later** (https://gitlab.winehq.org/wine/wine),
and `dlls/cards` is Wine's own reimplementation of the Windows card deck, not
Microsoft artwork. Keep this notice with the file.

The card **backs** are not from here. Wine's `cards.dll` only carries two
(a blue and a red crosshatch), where Windows offered twelve, so the Deck
dialog's twelve backs are drawn at runtime in `src/components/os/games/deck.ts`
like the rest of the site's art.
