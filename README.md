# RareCandyExporter

Exports a [rarecandy.com](https://rarecandy.com) profile's card portfolio to a
CSV formatted for import into PulseTCG.

## How it works

The portfolio page renders its card grid client-side and only loads cards
progressively as you scroll, so a plain HTTP fetch can't see the full
collection. This tool drives headless Chrome (via [Puppeteer](https://pptr.dev/))
to load the page, scroll until no new cards appear, and then extract every
card tile from the rendered DOM.

It cross-checks the number of cards it extracted against the "N cards" total
shown in the profile header and prints a warning if they don't match — a
sign the site's layout has changed and the parser needs updating.

## Installation

```bash
npm install
```

This also downloads a bundled Chromium build for Puppeteer (a one-time,
~200MB download).

## Usage

```bash
node export.js <profile-name-or-url> <output.csv> [--language <lang>] [--currency <code>] [--headful] [--m2a-variants] [--cookies <file>]
```

Examples:

```bash
node export.js Earlyflash earlyflash.csv
node export.js https://rarecandy.com/profile/Earlyflash?tab=portfolio earlyflash.csv
node export.js Earlyflash earlyflash.csv --language English
node export.js Earlyflash earlyflash.csv --currency GBP
node export.js Earlyflash earlyflash.csv --m2a-variants --headful
```

### Arguments

- `<profile-name-or-url>` — either a bare rarecandy.com username (e.g.
  `Earlyflash`) or a full profile URL. The portfolio tab is selected
  automatically either way.
- `<output.csv>` — path to write the CSV to.

### Flags

- `--language <lang>` — each card's `Language` column is normally detected
  automatically, per card (see below), so a profile with a mix of English
  and Japanese cards is exported correctly without this flag. It's only
  used as a fallback for the (uncommon) cards where detection isn't
  possible — e.g. non-Pokémon games on the site, or a card with no image.
  Defaults to `Japanese` for that fallback case.
- `--currency <code>` — converts every row's **Purchase Price** into the
  given ISO 4217 currency code (e.g. `GBP`), fetching a live exchange rate
  from a free conversion service. Defaults to `USD`, rarecandy.com's native
  currency, in which case no conversion happens. Useful for import targets
  that assume the price column is in a specific currency (e.g. GBP) rather
  than always USD.
- `--headful` — run with a visible browser window instead of headless.
  Useful for debugging if an export fails or looks wrong, and required the
  first time you use `--m2a-variants` (see below) so you can log in.
- `--m2a-variants` (optional, off by default) — enriches MEGA Dream ex
  (Japanese set code M2a) cards numbered #1–193 with their actual owned
  print finish. See [MEGA Dream ex variants](#mega-dream-ex-m2a-variants)
  below — this is a plain CLI flag, so it works the same on any OS and
  doesn't need Claude or any other tool to drive it.
- `--cookies <file>` — where the login session for `--m2a-variants` is
  cached. Defaults to `.rarecandy-session.json` in the current directory
  (already git-ignored).

## MEGA Dream ex (M2a) variants

Every other set on rarecandy.com sells each card in a single print finish,
so the portfolio grid's aggregated "qty N" tile is enough. MEGA Dream ex
(M2a) is the exception: its base-set cards (#1–193) can exist as **Normal**,
**Energy Reverse Holofoil**, and a card-specific "*something* Ball Reverse
Holofoil" (e.g. Love Ball, Quick Ball, Friend Ball — it varies per card).
Cards #194 onwards (SAR/S/etc. chase cards) only ever come in one finish, so
they're excluded automatically.

The portfolio grid never exposes which finish(es) you own for a given card
— it just sums the total quantity across all of them into one tile. The
only place that breakdown exists is the "In Your Collection" panel on each
card's own page, and that panel only shows *your own* signed-in account's
ownership, not the profile being viewed. So `--m2a-variants` requires
signing in to rarecandy.com as the profile owner:

```bash
node export.js Earlyflash earlyflash.csv --m2a-variants --headful
```

A visible browser window opens; log in, then press Enter in the terminal
to continue. The tool then visits each owned M2a base-set card's page,
reads its finish breakdown, and writes one CSV row per finish (with the
correct per-unit price and quantity, splitting the old aggregated row).
The login session is cached in `.rarecandy-session.json`, so subsequent
runs — even without `--headful` — reuse it until it expires.

## Output format

The CSV matches PulseTCG's import schema:

```
Product Name,Set Name,Purchase Date,Card Number,Language,Material/Finish,Grading Company,Grade,Purchase Price,Quantity,Promo Info,Rarity,Notes
```

Notes on specific columns:

- **Language** is detected per card, not assumed uniform across a profile.
  rarecandy.com's card images are proxied scrydex.com URLs that mark
  non-English prints with a language code right before the card number
  (e.g. `.../pokemon/sv6a_ja-76/large` for a Japanese print vs
  `.../pokemon/sv10-s3/large`, no `_ja`, for an English one), so the tool
  reads that off each card's tile image. Cards where this can't be read
  (no matching image URL — e.g. non-Pokémon games, or a card with no
  image) fall back to the `--language` flag.
- **Purchase Price** is rarecandy.com's current market value for the card,
  not necessarily what you actually paid for it. It's quoted in USD unless
  `--currency` is given, in which case it's converted (see above); the
  column itself never states which currency it's in, so match whatever
  your import target expects.
- **Material/Finish** is blank for every card except MEGA Dream ex (M2a)
  base-set cards when run with `--m2a-variants` (see above), where it holds
  the print finish (e.g. `Normal`, `Energy Reverse Holofoil`, `Love Ball
  Reverse Holofoil`). Those same rows also get `Condition: NM` (or
  whatever condition rarecandy.com lists) appended to **Notes**; everyone
  else's rows leave **Notes** blank.
- **Purchase Date**, **Grading Company**, **Grade**, and **Promo Info**
  are always left blank — this data isn't shown anywhere the tool reads.
- **Rarity** is the raw single-letter code rarecandy.com uses (e.g. `C`,
  `U`, `R`, `D`, `A`, `S`, `M`) rather than an expanded name like "Ultra
  Rare", since the exact mapping isn't confirmed.
- Each row represents one unique card/variant; duplicates are represented
  via the **Quantity** column rather than repeated rows.

## Requirements

- Node.js 18+

## How this was built

This tool was built with [Claude Code](https://claude.com/claude-code),
Anthropic's CLI coding agent, working interactively with the repo owner.

The process: Claude first used its Chrome browser automation to manually
open a rarecandy.com profile and figure out how to get the full card list
out of it. That involved a few dead ends — trying to read the site's
internal GraphQL API by hooking `fetch` and inspecting network traffic —
before landing on the approach that actually worked: scrolling the page
to trigger its lazy-loading and reading the rendered card tiles straight
out of the DOM. Once that was proven out by hand, Claude turned it into
this standalone script (swapping the interactive browser session for
Puppeteer-driven headless Chrome) so it could be run repeatedly from the
command line instead of walked through manually each time.

An earlier Python-based implementation of this same idea lived in this
repo first but didn't work reliably; it was deleted and replaced with
this version.
