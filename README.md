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
node export.js <profile-name-or-url> <output.csv> [--language <lang>] [--headful]
```

Examples:

```bash
node export.js Earlyflash earlyflash.csv
node export.js https://rarecandy.com/profile/Earlyflash?tab=portfolio earlyflash.csv
node export.js Earlyflash earlyflash.csv --language English
```

### Arguments

- `<profile-name-or-url>` — either a bare rarecandy.com username (e.g.
  `Earlyflash`) or a full profile URL. The portfolio tab is selected
  automatically either way.
- `<output.csv>` — path to write the CSV to.

### Flags

- `--language <lang>` — value written to every row's `Language` column.
  Defaults to `Japanese`, since rarecandy.com's card images are
  predominantly Japanese-print cards. Override this per profile if it's
  mostly English (or other) cards.
- `--headful` — run with a visible browser window instead of headless.
  Useful for debugging if an export fails or looks wrong.

## Output format

The CSV matches PulseTCG's import schema:

```
Product Name,Set Name,Purchase Date,Card Number,Language,Material/Finish,Grading Company,Grade,Purchase Price,Quantity,Promo Info,Rarity,Notes
```

Notes on specific columns:

- **Purchase Price** is rarecandy.com's current market value for the card,
  not necessarily what you actually paid for it.
- **Purchase Date**, **Material/Finish**, **Grading Company**, **Grade**,
  **Promo Info**, and **Notes** are left blank — this data isn't shown on
  the portfolio listing page.
- **Rarity** is the raw single-letter code rarecandy.com uses (e.g. `C`,
  `U`, `R`, `D`, `A`, `S`, `M`) rather than an expanded name like "Ultra
  Rare", since the exact mapping isn't confirmed.
- Each row represents one unique card/variant; duplicates are represented
  via the **Quantity** column rather than repeated rows.

## Requirements

- Node.js 18+
