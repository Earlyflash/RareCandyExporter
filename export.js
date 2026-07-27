#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

function printUsageAndExit(code) {
  console.error(
    'Usage: node export.js <profile-name-or-url> <output.csv> [--language <lang>] [--headful]\n' +
    '\n' +
    'Examples:\n' +
    '  node export.js Earlyflash earlyflash.csv\n' +
    '  node export.js https://rarecandy.com/profile/Earlyflash?tab=portfolio earlyflash.csv\n' +
    '  node export.js Earlyflash earlyflash.csv --language English\n'
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = { language: 'Japanese', headful: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--language') {
      flags.language = args[++i];
    } else if (a === '--headful') {
      flags.headful = true;
    } else if (a === '--help' || a === '-h') {
      printUsageAndExit(0);
    } else {
      positional.push(a);
    }
  }

  if (positional.length < 2) printUsageAndExit(1);
  return { profileOrUrl: positional[0], outCsv: positional[1], ...flags };
}

function buildPortfolioUrl(profileOrUrl) {
  let url;
  if (/^https?:\/\//i.test(profileOrUrl)) {
    url = new URL(profileOrUrl);
  } else {
    url = new URL(`https://rarecandy.com/profile/${encodeURIComponent(profileOrUrl)}`);
  }
  url.searchParams.set('tab', 'portfolio');
  return url.toString();
}

// Card tile links follow /<game>/sets/<setSlug>/<cardSlug>/<id> across all
// TCGs on the site (pokemon, magic, lorcana, gundam, ...), so match on path
// shape rather than hardcoding a game segment. These run inside the page
// context via page.evaluate, so the check is duplicated rather than shared.
function countCardLinksInPage() {
  function isCardLinkInPage(href) {
    try {
      const u = new URL(href, 'https://rarecandy.com');
      const parts = u.pathname.split('/').filter(Boolean);
      return parts.length === 5 && parts[1] === 'sets';
    } catch {
      return false;
    }
  }
  window.scrollTo(0, document.body.scrollHeight);
  return Array.from(document.querySelectorAll('a[href]')).filter((a) => isCardLinkInPage(a.getAttribute('href'))).length;
}

async function autoScrollUntilStable(page, { maxIterations = 300, stableRounds = 6, waitMs = 500 } = {}) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < maxIterations; i++) {
    const count = await page.evaluate(countCardLinksInPage);

    if (count === last) {
      stable++;
      if (stable > stableRounds) break;
    } else {
      stable = 0;
    }
    last = count;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}

async function extractCards(page) {
  return page.evaluate(() => {
    function isCardLinkInPage(href) {
      try {
        const u = new URL(href, 'https://rarecandy.com');
        const parts = u.pathname.split('/').filter(Boolean);
        return parts.length === 5 && parts[1] === 'sets';
      } catch {
        return false;
      }
    }
    const links = Array.from(document.querySelectorAll('a[href]')).filter((a) => isCardLinkInPage(a.getAttribute('href')));
    return links.map((a) => ({
      href: a.getAttribute('href'),
      lines: a.innerText.split('\n').filter((l) => l.length > 0),
    }));
  });
}

async function extractDeclaredTotal(page) {
  return page.evaluate(() => {
    const text = document.body.innerText;
    const m = text.match(/([\d,]+)\s*\n\s*cards/i);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
  });
}

function parseCardEntry(lines) {
  // Expected shape: [Name, "$Price", SetName, "#Number[ Rarity]", Quantity]
  const name = lines[0];
  const priceRaw = lines[1] || '';
  const setName = lines[2] || '';
  const numRarity = lines[3] || '';
  const qty = lines[4] || '1';

  const price = priceRaw.replace('$', '').trim();
  const m = numRarity.match(/^#(\S+)\s*(\S*)$/);
  const cardNumber = m ? m[1] : numRarity.replace(/^#/, '');
  const rarity = m ? m[2] : '';

  return { name, setName, cardNumber, rarity, quantity: qty, price };
}

function csvEscape(v) {
  v = String(v == null ? '' : v);
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function toPulseTcgCsv(rows, language) {
  const header = ['Product Name', 'Set Name', 'Purchase Date', 'Card Number', 'Language', 'Material/Finish', 'Grading Company', 'Grade', 'Purchase Price', 'Quantity', 'Promo Info', 'Rarity', 'Notes'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.name,
      r.setName,
      '',
      r.cardNumber,
      language,
      '',
      '',
      '',
      r.price,
      r.quantity,
      '',
      r.rarity,
      '',
    ].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const { profileOrUrl, outCsv, language, headful } = parseArgs(process.argv);
  const url = buildPortfolioUrl(profileOrUrl);

  console.log(`Fetching portfolio: ${url}`);

  const browser = await puppeteer.launch({ headless: !headful });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    try {
      await page.waitForSelector('a[href]', { timeout: 15000 });
    } catch {
      throw new Error('Page did not render any content. The profile may not exist or the site may be down.');
    }

    // Give the initial batch of cards a moment to hydrate before scrolling.
    await new Promise((r) => setTimeout(r, 1000));

    const finalCount = await autoScrollUntilStable(page);
    if (finalCount === 0) {
      throw new Error('No cards found. Check that the profile name is correct and its portfolio is public.');
    }

    const raw = await extractCards(page);
    const rows = raw.map((r) => parseCardEntry(r.lines));

    const declaredTotal = await extractDeclaredTotal(page);
    const summedQty = rows.reduce((s, r) => s + (parseInt(r.quantity, 10) || 0), 0);

    if (declaredTotal != null && declaredTotal !== summedQty) {
      console.warn(
        `Warning: profile header reports ${declaredTotal} cards, but extracted rows sum to ${summedQty}. ` +
        `The page layout may have changed — double check the output before importing.`
      );
    }

    const csv = toPulseTcgCsv(rows, language);
    const outPath = path.resolve(process.cwd(), outCsv);
    fs.writeFileSync(outPath, csv);

    console.log(`Wrote ${rows.length} unique card rows (${summedQty} total cards) to ${outPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
