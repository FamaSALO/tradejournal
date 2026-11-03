import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://famasalo.github.io/tradejournal/';
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
const swSource = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

function parseAttributes(tag) {
  const attrs = {};
  const pattern = /([a-z][a-z0-9:-]*)\s*=\s*"([^"]*)"/gi;
  let match;
  while ((match = pattern.exec(tag))) {
    attrs[match[1].toLowerCase()] = match[2];
  }
  return attrs;
}

function tags(name) {
  const result = [];
  const pattern = new RegExp('<' + name + '\\b[^>]*>', 'gi');
  let match;
  while ((match = pattern.exec(html))) result.push(parseAttributes(match[0]));
  return result;
}

const metas = tags('meta');
const links = tags('link');

function metaContent(attr, value) {
  const tag = metas.find(function (item) { return item[attr] === value; });
  return tag ? tag.content : undefined;
}

function pngSize(file) {
  const bytes = readFileSync(path.join(ROOT, file));
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', file + ' must be a PNG image');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('index.html exposes canonical and social sharing metadata', function () {
  const canonical = links.find(function (item) { return item.rel === 'canonical'; });
  assert.ok(canonical, 'canonical link is required');
  assert.equal(canonical.href, SITE);

  const title = html.match(/<title>([\s\S]*?)<\/title>/i)[1].trim();
  const description = metaContent('name', 'description');
  assert.ok(title);
  assert.ok(description);

  assert.equal(metaContent('property', 'og:type'), 'website');
  assert.equal(metaContent('property', 'og:site_name'), 'TradeJournal');
  assert.equal(metaContent('property', 'og:locale'), 'ru_RU');
  assert.equal(metaContent('property', 'og:title'), title);
  assert.equal(metaContent('property', 'og:description'), description);
  assert.equal(metaContent('property', 'og:url'), SITE);
  assert.equal(metaContent('property', 'og:image'), SITE + 'assets/og-image.png');
  assert.equal(metaContent('property', 'og:image:type'), 'image/png');
  assert.equal(metaContent('property', 'og:image:width'), '1200');
  assert.equal(metaContent('property', 'og:image:height'), '630');
  assert.ok(metaContent('property', 'og:image:alt'));

  assert.equal(metaContent('name', 'twitter:card'), 'summary_large_image');
  assert.equal(metaContent('name', 'twitter:title'), title);
  assert.equal(metaContent('name', 'twitter:description'), description);
  assert.equal(metaContent('name', 'twitter:image'), SITE + 'assets/og-image.png');
  assert.ok(metaContent('name', 'twitter:image:alt'));
});

test('Open Graph image is 1200x630 and stays under 300 KB', function () {
  const file = 'assets/og-image.png';
  const size = pngSize(file);
  assert.equal(size.width, 1200);
  assert.equal(size.height, 630);
  assert.ok(statSync(path.join(ROOT, file)).size < 300 * 1024, 'OG image must stay under 300 KB');
});

test('web manifest declares identity, category and a maskable 512 icon', function () {
  assert.equal(manifest.id, './');
  assert.ok(Array.isArray(manifest.categories));
  assert.ok(manifest.categories.includes('finance'));

  const maskable = manifest.icons.filter(function (icon) {
    return String(icon.purpose || '').split(/\s+/).includes('maskable');
  });
  assert.equal(maskable.length, 1);
  assert.equal(maskable[0].sizes, '512x512');
  assert.equal(maskable[0].type, 'image/png');

  manifest.icons.forEach(function (icon) {
    const dimensions = icon.sizes.split('x').map(Number);
    const size = pngSize(icon.src);
    assert.equal(size.width, dimensions[0], icon.src + ' width');
    assert.equal(size.height, dimensions[1], icon.src + ' height');
  });
});

test('app shell caches the Open Graph image and every manifest icon', function () {
  const block = swSource.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'APP_SHELL is required');
  const entries = Array.from(block[1].matchAll(/'([^']+)'/g)).map(function (match) {
    return match[1];
  });

  assert.ok(entries.includes('./assets/og-image.png'));
  manifest.icons.forEach(function (icon) {
    assert.ok(entries.includes('./' + icon.src), 'manifest icon is not cached: ' + icon.src);
  });
});
