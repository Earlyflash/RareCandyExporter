#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
// puppeteer is ESM-only as of v25, so it's loaded via dynamic import() at the
// point of use instead of require().

// MEGA Dream ex (Japanese set code "M2a") is the only set on the site that
// currently sells common/uncommon cards in multiple print finishes (Normal,
// Energy Reverse Holofoil, and a card-specific "<Something> Ball Reverse
// Holofoil"). The portfolio grid collapses all of a card's owned copies —
// regardless of finish — into a single tile with just a summed quantity, so
// that breakdown has to be fetched per-card from the card's own detail page
// instead. Only cards #1-193 are the base set; #194+ are SAR/S/etc. chase
// cards that only ever exist in one finish, so they're skipped.
const M2A_SET_HREF_SEGMENT = '/pokemon/sets/mega-dream-ex/';
const M2A_BASE_SET_MAX_NUMBER = 193;

function printUsageAndExit(code) {
  console.error(
    'Usage: node export.js <profile-name-or-url> <output.csv> [--language <lang>] [--currency <code>] [--headful] [--m2a-variants] [--cookies <file>]\n' +
    '\n' +
    'Examples:\n' +
    '  node export.js Earlyflash earlyflash.csv\n' +
    '  node export.js https://rarecandy.com/profile/Earlyflash?tab=portfolio earlyflash.csv\n' +
    '  node export.js Earlyflash earlyflash.csv --language English\n' +
    '  node export.js Earlyflash earlyflash.csv --currency GBP\n' +
    '  node export.js Earlyflash earlyflash.csv --m2a-variants --headful\n' +
    '\n' +
    '--currency <code> (optional, defaults to USD, rarecandy.com\'s native\n' +
    'currency) converts every Purchase Price into the given ISO 4217 code\n' +
    '(e.g. GBP) using a live exchange rate, for imports that assume the\n' +
    'price column is in a specific currency rather than always USD.\n' +
    '\n' +
    '--language <lang> (optional, defaults to Japanese) is only used as a\n' +
    'fallback for cards whose print language can\'t be auto-detected from\n' +
    'their card image (e.g. non-Pokemon games, or a card with no image).\n' +
    'Most cards get their Language column set automatically per-card, so a\n' +
    'profile with a mix of English and Japanese cards is exported correctly\n' +
    'without needing this flag at all.\n' +
    '\n' +
    '--m2a-variants (optional, off by default) enriches MEGA Dream ex (M2a)\n' +
    'cards #1-193 with their per-variant finish (Normal / Energy Reverse\n' +
    'Holofoil / Ball Reverse Holofoil) by visiting each owned card\'s page.\n' +
    'That requires being signed in to rarecandy.com as the profile owner —\n' +
    'combine with --headful the first time to log in interactively; the\n' +
    'session is then cached in the --cookies file for subsequent runs.\n'
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = { language: 'Japanese', currency: 'USD', headful: false, m2aVariants: false, cookiesFile: '.rarecandy-session.json' };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--language') {
      flags.language = args[++i];
    } else if (a === '--currency') {
      flags.currency = (args[++i] || '').toUpperCase();
    } else if (a === '--headful') {
      flags.headful = true;
    } else if (a === '--m2a-variants') {
      flags.m2aVariants = true;
    } else if (a === '--cookies') {
      flags.cookiesFile = args[++i];
    } else if (a === '--help' || a === '-h') {
      printUsageAndExit(0);
    } else {
      positional.push(a);
    }
  }

  if (positional.length < 2) printUsageAndExit(1);
  if (!/^[A-Z]{3}$/.test(flags.currency)) {
    console.error(`Invalid --currency "${flags.currency}": expected a 3-letter ISO 4217 code, e.g. GBP.\n`);
    printUsageAndExit(1);
  }
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
//
// This also sums quantities (not just unique link count) because that's
// what the profile header's "N cards" total actually counts, and it's the
// metric autoScrollUntilStable needs to compare against that target.
function scrollProgressInPage() {
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
  const links = Array.from(document.querySelectorAll('a[href]')).filter((a) => isCardLinkInPage(a.getAttribute('href')));
  let qty = 0;
  for (const a of links) {
    const lines = a.innerText.split('\n').filter((l) => l.length > 0);
    const q = parseInt(lines[4] || '1', 10);
    qty += Number.isFinite(q) ? q : 1;
  }
  return { count: links.length, qty };
}

async function autoScrollUntilStable(page, { maxIterations = 600, stableRounds = 6, waitMs = 700, initialLoadGraceRounds = 40, targetQty = null, maxStableRetries = 20 } = {}) {
  let last = -1;
  let lastQty = -1;
  let stable = 0;
  let stableRetries = 0;
  for (let i = 0; i < maxIterations; i++) {
    const { count, qty } = await page.evaluate(scrollProgressInPage);

    if (count === 0 && last <= 0) {
      // The card grid loads via an async GraphQL call that can take several
      // seconds after the page itself settles. A run of zero counts here
      // means "hasn't loaded yet", not "finished scrolling" — don't let it
      // satisfy the stability check. Give it a grace window before giving up.
      if (i >= initialLoadGraceRounds) break;
    } else if (targetQty != null && qty >= targetQty) {
      last = count;
      break;
    } else if (count === last) {
      stable++;
      if (stable > stableRounds) {
        if (targetQty != null && qty < targetQty && stableRetries < maxStableRetries) {
          // The count held steady, but we're still short of the header's
          // declared total — the lazy-load fetch may have stalled rather
          // than finished. Nudge it by scrolling up and back down instead
          // of giving up, and give it another stability window.
          stableRetries++;
          stable = 0;
          await page.evaluate(() => window.scrollTo(0, Math.max(0, document.body.scrollHeight - 3000)));
          await new Promise((r) => setTimeout(r, waitMs));
          last = count;
          lastQty = qty;
          continue;
        }
        break;
      }
    } else {
      stable = 0;
      stableRetries = 0;
    }
    last = count;
    lastQty = qty;
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
    return links.map((a) => {
      const img = a.querySelector('img');
      return {
        href: a.getAttribute('href'),
        lines: a.innerText.split('\n').filter((l) => l.length > 0),
        imgSrc: img ? img.getAttribute('src') : null,
      };
    });
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
  // Usual shape: [Name, "$Price", SetName, "#Number[ Rarity]", Quantity].
  // But the $Price and "#Number Rarity" lines are each individually
  // optional — untracked cards (e.g. some basic Energy cards) render tiles
  // without a market price and/or without a number/rarity badge at all, and
  // when that happens every later line shifts left by one. Reading fields
  // by fixed index would then silently misassign the set name into the
  // price column (or similar), so match each line by shape instead and
  // consume it from the front only when found.
  const name = lines[0];
  const rest = lines.slice(1);

  let price = '';
  if (rest[0] && rest[0].startsWith('$')) {
    price = rest.shift().replace('$', '').trim();
  }

  const setName = rest.shift() || '';

  let cardNumber = '';
  let rarity = '';
  if (rest[0] && rest[0].startsWith('#')) {
    const m = rest.shift().match(/^#(\S+)\s*(\S*)$/);
    cardNumber = m ? m[1] : '';
    rarity = m ? m[2] : '';
  }

  const qty = rest.shift() || '1';

  return { name, setName, cardNumber, rarity, quantity: qty, price };
}

// rarecandy.com's card images are proxied Next.js Image URLs wrapping a
// scrydex.com source, e.g. ".../pokemon/sv6a_ja-76/large" for a Japanese
// print vs ".../pokemon/sv10-s3/large" (no "_ja") for an English one — that
// "_<lang>" segment right before the card number is scrydex's print-language
// marker (absent means English, its default). This lets language be detected
// per card from the tile itself, rather than assumed to be uniform across a
// whole profile. Returns null (caller should fall back to --language) when
// the image URL doesn't match this shape at all, e.g. a non-Pokémon game
// that doesn't use scrydex images, or a card with no image.
const IMAGE_LANGUAGE_CODE_NAMES = {
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  de: 'German',
  fr: 'French',
  it: 'Italian',
  es: 'Spanish',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  id: 'Indonesian',
  th: 'Thai',
};

function detectLanguageFromImageSrc(src) {
  if (!src) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    decoded = src;
  }
  const m = decoded.match(/scrydex\.com\/[a-z]+\/[a-zA-Z0-9]+?(?:_([a-z]{2}))?-/i);
  if (!m) return null;
  const code = (m[1] || 'en').toLowerCase();
  return IMAGE_LANGUAGE_CODE_NAMES[code] || code.toUpperCase();
}

function isM2aBaseSetCard(row) {
  if (!row.href || !row.href.includes(M2A_SET_HREF_SEGMENT)) return false;
  const num = parseInt(row.cardNumber, 10);
  return Number.isFinite(num) && num <= M2A_BASE_SET_MAX_NUMBER;
}

function isLoggedInInPage() {
  // The signed-out header always shows a literal "Sign In / Up" link; nothing
  // else on these card pages produces that text, so its absence is a cheap
  // and reliable enough signed-in check without depending on brittle markup.
  return !/sign in\s*\/\s*up/i.test(document.body.innerText);
}

// Reads the "In Your Collection" panel on a card's own page, which — unlike
// the portfolio grid — breaks owned copies down per finish/condition. Only
// meaningful when the browser is signed in as the profile being exported;
// callers are responsible for confirming that first.
function ownedVariantsInPage() {
  const text = document.body.innerText;
  const startMarker = 'In Your Collection';
  const endMarker = 'Market Price';
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;
  const afterStart = text.slice(startIdx + startMarker.length);
  const endIdx = afterStart.indexOf(endMarker);
  const section = endIdx === -1 ? afterStart : afterStart.slice(0, endIdx);
  const lines = section.split('\n').map((l) => l.trim()).filter(Boolean);

  if (lines[0] === 'None collected!') return [];

  let i = 0;
  if (/^\(\d+\)$/.test(lines[0])) i = 1; // leading "(2)" total-copies count

  const entries = [];
  while (i < lines.length && !/^Total\b/i.test(lines[i])) {
    const conditionFinish = lines[i]; i++;
    const priceRaw = lines[i]; i++;
    if (lines[i] === 'ea') i++;
    const qtyRaw = lines[i]; i++;

    const m = conditionFinish.match(/^(\S+)\s*•\s*(.+)$/);
    entries.push({
      condition: m ? m[1] : '',
      finish: m ? m[2] : conditionFinish,
      price: (priceRaw || '').replace('$', '').trim(),
      quantity: parseInt(qtyRaw, 10) || 1,
    });
  }
  return entries;
}

function loadCookiesFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveCookiesFile(file, cookies) {
  fs.writeFileSync(file, JSON.stringify(cookies, null, 2));
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

// Returns a new rows array: for each M2a base-set row, replaces the single
// aggregated tile with one row per owned finish (accurate per-unit price and
// quantity instead of the portfolio grid's summed total). Rows with no
// readable breakdown are left untouched. Requires the page to already be
// signed in as the profile owner.
async function enrichM2aVariants(page, rows, { onProgress } = {}) {
  const targets = rows.filter(isM2aBaseSetCard);
  const expandedByHref = new Map();

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    const url = new URL(row.href, 'https://rarecandy.com').toString();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForFunction(
        () => document.body.innerText.includes('In Your Collection'),
        { timeout: 15000 }
      );
    } catch {
      // Fall through — ownedVariantsInPage() below will return null and the
      // row is left as-is rather than aborting the whole export over one card.
    }
    await new Promise((r) => setTimeout(r, 300));

    const entries = await page.evaluate(ownedVariantsInPage);
    if (entries && entries.length > 0) {
      expandedByHref.set(row.href, entries.map((e) => ({
        ...row,
        quantity: String(e.quantity),
        price: e.price,
        finish: e.finish,
        condition: e.condition,
      })));
    }

    if (onProgress) onProgress(i + 1, targets.length);
  }

  const result = [];
  for (const row of rows) {
    const expanded = row.href && expandedByHref.get(row.href);
    if (expanded) result.push(...expanded);
    else result.push(row);
  }
  return result;
}

// rarecandy.com always quotes prices in USD. When the caller wants a
// different currency, fetch a live USD-> target rate from Frankfurter
// (a free, no-API-key exchange rate service backed by ECB reference rates)
// rather than shipping a stale hardcoded conversion.
async function fetchExchangeRate(to, from = 'USD') {
  if (to === from) return 1;
  const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Could not reach the currency conversion service (${err.message}).`);
  }
  if (!res.ok) {
    throw new Error(`Currency conversion service returned HTTP ${res.status} for ${from}->${to}.`);
  }
  const data = await res.json();
  const rate = data && data.rates && data.rates[to];
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new Error(`Currency conversion service didn't return a ${to} rate for ${from}. Is "${to}" a valid ISO 4217 code?`);
  }
  return rate;
}

// Converts every row's Purchase Price (in USD, as rarecandy.com reports it)
// into the target currency at the given rate. Prices are re-quoted to 2
// decimal places; blank prices (untracked cards) are left blank.
function convertRowsCurrency(rows, rate) {
  return rows.map((r) => {
    if (!r.price) return r;
    const usd = parseFloat(r.price);
    if (!Number.isFinite(usd)) return r;
    return { ...r, price: (usd * rate).toFixed(2) };
  });
}

function csvEscape(v) {
  v = String(v == null ? '' : v);
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function toPulseTcgCsv(rows, fallbackLanguage) {
  const header = ['Product Name', 'Set Name', 'Purchase Date', 'Card Number', 'Language', 'Material/Finish', 'Grading Company', 'Grade', 'Purchase Price', 'Quantity', 'Promo Info', 'Rarity', 'Notes'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.name,
      r.setName,
      '',
      r.cardNumber,
      r.language || fallbackLanguage,
      r.finish || '',
      '',
      '',
      r.price,
      r.quantity,
      '',
      r.rarity,
      r.condition ? `Condition: ${r.condition}` : '',
    ].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const { profileOrUrl, outCsv, language, currency, headful, m2aVariants, cookiesFile } = parseArgs(process.argv);
  const url = buildPortfolioUrl(profileOrUrl);

  console.log(`Fetching portfolio: ${url}`);

  const { default: puppeteer } = await import('puppeteer');
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

    // The profile header's "N cards" total renders independently of the
    // (lazy-loaded) card grid, so it's available early and gives the
    // scroll loop a concrete target instead of just guessing "done" from
    // a few seconds of no visible growth.
    const declaredTotal = await extractDeclaredTotal(page);

    const finalCount = await autoScrollUntilStable(page, { targetQty: declaredTotal });
    if (finalCount === 0) {
      throw new Error('No cards found. Check that the profile name is correct and its portfolio is public.');
    }

    const raw = await extractCards(page);
    let rows = raw.map((r) => ({
      ...parseCardEntry(r.lines),
      href: r.href,
      language: detectLanguageFromImageSrc(r.imgSrc),
    }));

    const variantTargets = rows.filter(isM2aBaseSetCard);
    if (variantTargets.length > 0 && m2aVariants) {
      console.log(`Found ${variantTargets.length} MEGA Dream ex (M2a) base-set card(s) — fetching per-variant ownership...`);

      const cookiesPath = path.resolve(process.cwd(), cookiesFile);
      const savedCookies = loadCookiesFile(cookiesPath);
      if (savedCookies) await page.setCookie(...savedCookies);

      const firstUrl = new URL(variantTargets[0].href, 'https://rarecandy.com').toString();
      await page.goto(firstUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise((r) => setTimeout(r, 800));
      let loggedIn = await page.evaluate(isLoggedInInPage);

      if (!loggedIn) {
        if (!headful) {
          throw new Error(
            'MEGA Dream ex (M2a) variant capture requires being signed in to rarecandy.com as the ' +
            'profile owner. Re-run with --headful (in addition to --m2a-variants) to log in ' +
            `interactively — the session is then cached in ${cookiesFile} for next time. Omit ` +
            '--m2a-variants to export without per-variant finish data.'
          );
        }
        console.log('\nPlease sign in to rarecandy.com as the profile owner in the browser window that just opened.');
        await waitForEnter('Press Enter here once you are signed in to continue...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise((r) => setTimeout(r, 800));
        loggedIn = await page.evaluate(isLoggedInInPage);
      }

      if (loggedIn) {
        saveCookiesFile(cookiesPath, await page.cookies());
        rows = await enrichM2aVariants(page, rows, {
          onProgress: (done, total) => {
            if (done === total || done % 10 === 0) console.log(`  ...${done}/${total} M2a cards checked`);
          },
        });
      } else {
        console.warn('Still not signed in — skipping per-variant finish data for MEGA Dream ex cards.');
      }
    }

    const summedQty = rows.reduce((s, r) => s + (parseInt(r.quantity, 10) || 0), 0);

    if (declaredTotal != null && declaredTotal !== summedQty) {
      console.warn(
        `Warning: profile header reports ${declaredTotal} cards, but extracted rows sum to ${summedQty}. ` +
        `The page layout may have changed — double check the output before importing.`
      );
    }

    if (currency !== 'USD') {
      console.log(`Converting Purchase Price from USD to ${currency}...`);
      const rate = await fetchExchangeRate(currency);
      console.log(`  ...using rate 1 USD = ${rate} ${currency}`);
      rows = convertRowsCurrency(rows, rate);
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
