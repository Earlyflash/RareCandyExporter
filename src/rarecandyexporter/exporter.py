import argparse
import csv
import json
import re
from pathlib import Path
from typing import Any

import requests


def load_sample_collection() -> list[dict[str, Any]]:
    """Return a sample rare candy collection."""
    return [
        {"name": "Rare Candy A", "quantity": 5, "rarity": "Very Rare"},
        {"name": "Rare Candy B", "quantity": 2, "rarity": "Ultra Rare"},
    ]


def _normalize_card(item: dict[str, Any]) -> dict[str, Any]:
    set_info = item.get("set") or {}
    rarity_info = item.get("rarity") or {}
    language_info = item.get("language") or {}

    if isinstance(set_info, dict):
        set_name = str(set_info.get("name", "")).strip()
    else:
        set_name = str(set_info).strip()

    if isinstance(rarity_info, dict):
        rarity_name = str(rarity_info.get("label", "")).strip()
    else:
        rarity_name = str(rarity_info).strip()

    if isinstance(language_info, dict):
        language_name = str(language_info.get("name", "")).strip()
    else:
        language_name = str(language_info).strip()

    condition_value = ""
    for key in ["condition", "conditionName", "cardCondition", "grading", "grade"]:
        value = item.get(key)
        if isinstance(value, dict):
            if value.get("name"):
                condition_value = str(value.get("name", "")).strip()
                break
            if value.get("label"):
                condition_value = str(value.get("label", "")).strip()
                break
            if value.get("value"):
                condition_value = str(value.get("value", "")).strip()
                break
        elif value is not None:
            condition_value = str(value).strip()
            break

    return {
        "name": str(item.get("name", "")).strip(),
        "set": set_name,
        "number": str(item.get("number", "")).strip(),
        "rarity": rarity_name or str(item.get("rarity", "")).strip(),
        "quantity": int(item.get("quantityOwned", item.get("quantity", 1)) or 1),
        "condition": condition_value,
        "language": language_name,
    }


def _card_identity(card: dict[str, Any]) -> tuple[str, str, str]:
    return (card.get("name", ""), card.get("set", ""), card.get("number", ""))


def parse_profile_cards(html: str) -> list[dict[str, Any]]:
    """Extract cards from a profile page's embedded Next.js payload."""
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not match:
        return []

    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return []

    cards: list[dict[str, Any]] = []
    page_props = payload.get("props", {}).get("pageProps", {})

    raw_cards = page_props.get("cards")
    if isinstance(raw_cards, list):
        cards = [_normalize_card(card) for card in raw_cards if isinstance(card, dict)]

    return cards


def parse_portfolio_graphql(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract cards from the RareCandy GraphQL portfolio payload."""
    user_profile = payload.get("data", {}).get("userProfile", {})
    portfolio = user_profile.get("portfolio", {})
    products = portfolio.get("products", {}).get("results", [])
    cards: list[dict[str, Any]] = []
    for product in products:
        if not isinstance(product, dict):
            continue
        if product.get("category") != "SINGLE_CARD":
            continue
        if not product.get("isOwned"):
            continue
        card = _normalize_card(product)
        if card["name"]:
            cards.append(card)
    return cards


def extract_pagination_last_key(payload: dict[str, Any]) -> str | None:
    """Extract the next pagination cursor from the GraphQL response."""
    products = payload.get("data", {}).get("userProfile", {}).get("portfolio", {}).get("products", {})
    pagination_info = products.get("paginationInfo", {})
    last_key = pagination_info.get("lastKey")
    if last_key in {None, ""}:
        return None
    return str(last_key)


def load_cards_from_profile(profile_url: str) -> list[dict[str, Any]]:
    """Fetch the profile page and extract cards from the embedded JSON payload or GraphQL portfolio endpoint."""
    response = requests.get(profile_url, timeout=30)
    if hasattr(response, "raise_for_status"):
        response.raise_for_status()
    html_cards = parse_profile_cards(response.text)
    if html_cards:
        return html_cards

    graphql_url = "https://rarecandy.foo/graphql"
    username = profile_url.rstrip("/").split("/")[-1].split("?")[0]
    query = """
    query UserPortfolioProducts($input: UserProfileV2Input!, $filter: PortfolioProductsFilter) {
      userProfile: userProfileV2(input: $input) {
        username
        portfolio {
          isMe
          products(filter: $filter) {
            results {
              id
              name
              displayPrice
              slug
              ... on CardProductV2 {
                category
                number
                rarity {
                  label
                }
                set {
                  id
                  name
                  slug
                  brand {
                    name
                    slug
                  }
                }
              }
              images {
                small
                large
                type
              }
              isOwned
              isWanted
              language {
                abbreviatedName
                iso639Code
                name
              }
              quantityOwned
              shareUrl
              listingGroups {
                source
                type
                url
              }
            }
            paginationInfo {
              totalCount
              lastKey
              facets {
                facet {
                  field
                  label
                  isMultiSelect
                  iconType
                  iconName
                  iconUnicode
                  iconColor
                  imageUrl
                }
                facetValues {
                  value
                  label
                  iconType
                  iconName
                  iconUnicode
                  iconColor
                  imageUrl
                  isDefault
                }
              }
            }
          }
        }
      }
    }
    """
    cards: list[dict[str, Any]] = []
    last_key: str | None = None
    for _ in range(20):
        payload = {
            "query": query,
            "variables": {
                "input": {"username": username},
                "filter": {"pageSize": 25, "searchTerm": "", "facets": [], "lastKey": last_key},
            },
            "operationName": "UserPortfolioProducts",
        }
        graphql_response = requests.post(
            graphql_url,
            json=payload,
            timeout=30,
            headers={
                "content-type": "application/json",
                "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36",
                "apollographql-client-name": "pokemart",
                "referer": "https://rarecandy.com/",
                "app": "pokemart",
                "authorization": "",
            },
        )
        graphql_response.raise_for_status()
        try:
            graphql_payload = graphql_response.json()
        except ValueError:
            break

        page_cards = parse_portfolio_graphql(graphql_payload)
        if not page_cards:
            break
        cards.extend(page_cards)
        next_last_key = extract_pagination_last_key(graphql_payload)
        if not next_last_key:
            break
        last_key = next_last_key

    return cards


def export_items(items: list[dict[str, Any]], output: Path | str) -> Path:
    """Export items to a CSV file and return the output path."""
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = ["name", "quantity", "rarity", "set", "number", "condition", "language"]
    with output_path.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for item in items:
            row = {key: item.get(key, "") for key in fieldnames}
            writer.writerow(row)

    return output_path


def export_cards(cards: list[dict[str, Any]], output: Path | str) -> Path:
    """Export card dictionaries to CSV while aggregating duplicates by card identity."""
    aggregated: dict[tuple[str, str, str], dict[str, Any]] = {}
    for card in cards:
        normalized = _normalize_card(card)
        key = _card_identity(normalized)
        existing = aggregated.get(key)
        if existing is None:
            aggregated[key] = normalized
        else:
            existing["quantity"] += normalized["quantity"]

    ordered_cards = [aggregated[key] for key in sorted(aggregated)]
    return export_items(ordered_cards, output)


def parse_args(args=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export a RareCandy profile or a collection JSON file to CSV."
    )
    parser.add_argument(
        "--input",
        help="Path to a JSON file containing the collection. If omitted, a sample collection is used.",
    )
    parser.add_argument(
        "--profile-url",
        help="A RareCandy profile URL to scrape and export.",
    )
    parser.add_argument(
        "--output",
        default="rarecandy_export.csv",
        help="CSV output path (default: rarecandy_export.csv).",
    )
    return parser.parse_args(args)


def main(args=None) -> int:
    parsed = parse_args(args)
    if parsed.profile_url:
        cards = load_cards_from_profile(parsed.profile_url)
        output_path = export_cards(cards, parsed.output)
        distinct_cards = len({_card_identity(_normalize_card(card)) for card in cards})
        total_copies = sum(int(_normalize_card(card).get("quantity", 0) or 0) for card in cards)
        print(
            f"Exported {len(cards)} total card entries, {distinct_cards} distinct cards, and {total_copies} total copies from {parsed.profile_url} to {output_path}"
        )
        return 0

    if parsed.input:
        input_path = Path(parsed.input)
        with input_path.open("r", encoding="utf-8") as handle:
            items = json.load(handle)
        output_path = export_cards(items, parsed.output)
        distinct_items = len({_card_identity(_normalize_card(item)) for item in items})
        total_copies = sum(int(_normalize_card(item).get("quantity", 0) or 0) for item in items)
        print(f"Exported {len(items)} total item entries, {distinct_items} distinct items, and {total_copies} total copies to {output_path}")
        return 0

    items = load_sample_collection()
    output_path = export_items(items, parsed.output)
    print(f"Exported {len(items)} item(s) to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
