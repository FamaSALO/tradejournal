import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');

function block(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
  assert.ok(match, 'missing CSS block for ' + selector);
  return match[1];
}

test('data cards and journal entries use the selected theme surfaces', function () {
  const kpi = block('.kpi');
  assert.match(kpi, /var\(--card-bg-a\)/);
  assert.match(kpi, /var\(--card-bg-b\)/);

  const note = block('.note-card');
  assert.match(note, /var\(--card-bg-a\)/);
  assert.match(note, /var\(--card-bg-b\)/);
  assert.doesNotMatch(note, /rgba\(20,\s*29,\s*41/);

  const tooltip = block('.chart-tooltip');
  assert.match(tooltip, /background:\s*var\(--panel\)/);
});

test('warnings and secondary values use theme-aware colors', function () {
  assert.match(block('.rule-status.warn'), /color:\s*var\(--amber\)/);
  assert.match(block('.rule-top b'), /color:\s*var\(--text-strong\)/);
  assert.match(block('.legend-row b'), /color:\s*var\(--text-strong\)/);
  assert.match(block('.hb-label'), /color:\s*var\(--text-strong\)/);
});

test('light and dark themes define strong and soft text tones', function () {
  const root = block(':root');
  assert.match(root, /--text-strong:/);
  assert.match(root, /--text-soft:/);
  const light = block(':root[data-theme="light"]');
  assert.match(light, /--text-strong:\s*#243040/);
  assert.match(light, /--text-soft:\s*#41566d/);
});
