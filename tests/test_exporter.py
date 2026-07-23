import json
from pathlib import Path
from tempfile import TemporaryDirectory

from rarecandyexporter.exporter import (
    export_items,
    load_sample_collection,
    load_cards_from_profile,
    main,
    parse_profile_cards,
)


def test_export_items_creates_csv(tmp_path: Path) -> None:
    items = [
        {"name": "Rare Candy A", "quantity": 3, "rarity": "Rare"},
        {"name": "Rare Candy B", "quantity": 1, "rarity": "Very Rare"},
    ]
    output_path = tmp_path / "export.csv"
    result = export_items(items, output_path)

    assert result == output_path
    assert output_path.exists()
    content = output_path.read_text(encoding="utf-8")
    assert "name,quantity,rarity" in content
    assert "Rare Candy A" in content
    assert "Rare Candy B" in content


def test_load_sample_collection_returns_items() -> None:
    items = load_sample_collection()
    assert isinstance(items, list)
    assert len(items) >= 1
    assert all("name" in item for item in items)
    assert all("quantity" in item for item in items)


def test_parse_profile_cards_extracts_cards_from_embedded_payload() -> None:
    html = """
    <html><head><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"profile":{"username":"sample-user"},"cards":[{"name":"Pikachu","set":"Base Set","number":"1","rarity":"Common","quantity":2}]}}}</script></head></html>
    """

    cards = parse_profile_cards(html)

    assert len(cards) == 1
    assert cards[0]["name"] == "Pikachu"
    assert cards[0]["set"] == "Base Set"
    assert cards[0]["quantity"] == 2


def test_load_cards_from_profile_uses_profile_page_payload(monkeypatch) -> None:
    class DummyResponse:
        def __init__(self, html: str) -> None:
            self.text = html

    def fake_get(url: str, timeout: int = 20) -> DummyResponse:
        assert url == "https://rarecandy.com/profile/sample-user"
        return DummyResponse(
            '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"cards":[{"name":"Charizard","set":"Base Set","number":"4","rarity":"Rare","quantity":1}]}}}</script>'
        )

    monkeypatch.setattr("rarecandyexporter.exporter.requests.get", fake_get)

    cards = load_cards_from_profile("https://rarecandy.com/profile/sample-user")

    assert len(cards) == 1
    assert cards[0]["name"] == "Charizard"
    assert cards[0]["set"] == "Base Set"


def test_main_exports_profile_url_to_csv(tmp_path: Path, monkeypatch) -> None:
    cards = [{"name": "Pikachu", "set": "Base Set", "number": "1", "rarity": "Common", "quantity": 2}]

    monkeypatch.setattr("rarecandyexporter.exporter.load_cards_from_profile", lambda profile_url: cards)

    output_path = tmp_path / "cards.csv"
    exit_code = main(["--profile-url", "https://rarecandy.com/profile/sample-user", "--output", str(output_path)])

    assert exit_code == 0
    assert output_path.exists()
    assert "Pikachu" in output_path.read_text(encoding="utf-8")


def test_main_reports_total_and_distinct_card_counts(tmp_path: Path, monkeypatch, capsys) -> None:
    cards = [
        {"name": "Pikachu", "set": "Base Set", "number": "1", "rarity": "Common", "quantity": 2},
        {"name": "Pikachu", "set": "Base Set", "number": "1", "rarity": "Common", "quantity": 1},
        {"name": "Charizard", "set": "Base Set", "number": "4", "rarity": "Rare", "quantity": 1},
    ]

    monkeypatch.setattr("rarecandyexporter.exporter.load_cards_from_profile", lambda profile_url: cards)

    output_path = tmp_path / "cards.csv"
    exit_code = main(["--profile-url", "https://rarecandy.com/profile/sample-user", "--output", str(output_path)])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert "3 total card entries" in captured.out
    assert "2 distinct cards" in captured.out
    assert "4 total copies" in captured.out
