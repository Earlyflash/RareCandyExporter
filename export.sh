#!/usr/bin/env bash
set -euo pipefail

PROFILE_URL="${1:-https://rarecandy.com/profile/your-profile?tab=portfolio}"
OUTPUT="${2:-rarecandy_portfolio.csv}"

PYTHONPATH=src /home/codespace/.python/current/bin/python -m rarecandyexporter.exporter --profile-url "$PROFILE_URL" --output "$OUTPUT"
