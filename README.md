# RareCandyExporter

RareCandyExporter fetches a RareCandy profile portfolio and exports it to CSV.

## What it does

- Loads a RareCandy profile URL
- Pulls the portfolio data from the live RareCandy GraphQL endpoint
- Normalizes card fields such as name, set, number, rarity, quantity, condition, and language
- Aggregates duplicate rows by card identity for the CSV export
- Prints a summary showing total portfolio entries, distinct cards, and total copies

## Installation

Install the package in editable mode from the repository root:

```bash
pip install -e .
```

## Usage

Export a profile directly:

```bash
rarecandyexporter --profile-url https://rarecandy.com/profile/your-profile?tab=portfolio --output rarecandy_portfolio.csv
```

Or run the module directly:

```bash
python -m rarecandyexporter.exporter --profile-url https://rarecandy.com/profile/your-profile?tab=portfolio --output rarecandy_portfolio.csv
```

A helper shell script is also available:

```bash
./export.sh "https://rarecandy.com/profile/your-profile?tab=portfolio" rarecandy_portfolio.csv
```

## Output format

The generated CSV contains these columns:

- name
- quantity
- rarity
- set
- number
- condition
- language

## Development

Run the test suite:

```bash
pytest -q
```
