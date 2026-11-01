import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const problems = [];
let expected = null;

function fail(message) {
  problems.push(message);
}

async function text(file) {
  return readFile(path.join(root, file), 'utf8');
}

function capture(file, source, regex, label) {
  const match = source.match(regex);
  if (!match) {
    fail(file + ': не найдено значение ' + label + '.');
    return null;
  }
  return match[1].trim();
}

function compare(file, label, value) {
  if (value === null) return;
  if (!expected) {
    expected = value;
    return;
  }
  if (value !== expected) {
    fail(file + ': ' + label + ' = ' + value + ', ожидается ' + expected + '.');
  }
}

const pkg = JSON.parse(await text('package.json'));
compare('package.json', 'version', String(pkg.version || ''));

const lock = JSON.parse(await text('package-lock.json'));
compare('package-lock.json', 'version', String(lock.version || ''));
compare('package-lock.json', 'packages[""].version', String(lock.packages && lock.packages[''] ? lock.packages[''].version : ''));

const tauri = JSON.parse(await text('src-tauri/tauri.conf.json'));
compare('src-tauri/tauri.conf.json', 'version', String(tauri.version || ''));

const cargo = await text('src-tauri/Cargo.toml');
compare('src-tauri/Cargo.toml', 'package version',
  capture('src-tauri/Cargo.toml', cargo, /^version\s*=\s*"([^"]+)"/m, 'version'));

const cargoLock = await text('src-tauri/Cargo.lock');
const cargoLockMatch = cargoLock.match(/\[\[package\]\]\r?\nname = "tradejournal"\r?\nversion = "([^"]+)"/);
compare('src-tauri/Cargo.lock', 'tradejournal version', cargoLockMatch ? cargoLockMatch[1] : null);
if (!cargoLockMatch) fail('src-tauri/Cargo.lock: не найден пакет tradejournal.');

const appJs = await text('js/app.js');
compare('js/app.js', 'APP_VERSION',
  capture('js/app.js', appJs, /const APP_VERSION = '([^']+)'/, 'APP_VERSION'));

const html = await text('index.html');
compare('index.html', 'appVersion',
  capture('index.html', html, /id="appVersion">v([^<]+)</, 'appVersion'));

const sw = await text('sw.js');
compare('sw.js', 'CACHE_NAME',
  capture('sw.js', sw, /const CACHE_NAME = 'tradejournal-v([^']+)'/, 'CACHE_NAME'));

const readme = await text('README.md');
const setupNames = Array.from(readme.matchAll(/TradeJournal_([0-9]+\.[0-9]+\.[0-9]+)_x64-setup\.exe/g));
const portableNames = Array.from(readme.matchAll(/TradeJournal-portable-([0-9]+\.[0-9]+\.[0-9]+)-x64\.zip/g));
if (!setupNames.length) fail('README.md: не найдено имя установщика TradeJournal_<версия>_x64-setup.exe.');
if (!portableNames.length) fail('README.md: не найдено имя портативной сборки TradeJournal-portable-<версия>-x64.zip.');
setupNames.forEach(function (match) { compare('README.md', 'имя установщика', match[1]); });
portableNames.forEach(function (match) { compare('README.md', 'имя портативной сборки', match[1]); });

if (problems.length) {
  console.error('Проверка версий не пройдена:');
  problems.forEach(function (problem) { console.error(' - ' + problem); });
  process.exit(1);
}

console.log('Версии согласованы: ' + expected);
