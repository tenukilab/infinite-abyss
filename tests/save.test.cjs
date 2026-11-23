'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { Script } = require('node:vm');

const SAVE_KEY = 'infinite-abyss-save-v5';
const OLD_KEYS = [1, 2, 3, 4].map(version => 'infinite-abyss-save-v' + version);
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const mainScript = new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
  filename: 'index.html (inline JavaScript)',
});

// Synthetic progress in the v0.18 format from Git commit
// 3afbb59f41bb2a721714eceb7ac3ebfd094374c6. Includes an interrupted auto-run.
const legacyBytes = readFileSync(join(__dirname, 'fixtures', 'save-v018.json'), 'utf8');
const legacySave = JSON.parse(legacyBytes);

function boot(storage = new Map(), { rejectReads = false } = {}) {
  const handlers = new Map();
  const elements = new Map();
  const downloads = [];
  const window = { addEventListener() {} };
  let rejectWrites = false;
  let confirmAction = () => true;
  let confirmations = 0;

  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, {
        classList: { add() {}, remove() {} },
        click() {},
        remove() {},
      });
    }
    return elements.get(selector);
  }

  mainScript.runInNewContext({
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      getElementById: id => element('#' + id),
      addEventListener: (name, listener) => handlers.set(name, listener),
      createElement: () => element('created'),
      body: { appendChild() {} },
    },
    localStorage: {
      getItem(key) {
        if (rejectReads) throw new DOMException('Storage blocked', 'SecurityError');
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (rejectWrites) throw new DOMException('Storage full', 'QuotaExceededError');
        storage.set(key, value);
      },
      removeItem: key => storage.delete(key),
    },
    console: { warn() {} },
    FileReader: class {
      readAsText(file) {
        this.result = file;
        this.onload();
      }
    },
    Blob,
    URL: {
      createObjectURL(blob) {
        downloads.push(blob);
        return 'blob:save-test';
      },
    },
    confirm() {
      confirmations++;
      return confirmAction();
    },
    window,
    structuredClone,
    clearTimeout() {},
    setTimeout() {},
  });

  return {
    storage,
    state: window.ABYSS_DEBUG.state,
    importText(text) {
      handlers.get('change')({ target: { id: 'importFile', files: [text] } });
    },
    click(dataset) {
      handlers.get('click')({ target: { closest: () => ({ dataset }) } });
    },
    downloads,
    saveNotice: () => element('#saveNotice'),
    setInput(selector, value) { element(selector).value = value; },
    toast: () => element('#toast').textContent || '',
    confirmations: () => confirmations,
    onConfirm(handler) { confirmAction = handler; },
    allowReads() { rejectReads = false; },
    rejectWrites() { rejectWrites = true; },
    allowWrites() { rejectWrites = false; },
  };
}

function currentSave() {
  return boot().state();
}

test('startup leaves every older storage key unchanged and allows backup', async () => {
  const oldSaves = OLD_KEYS.map((key, index) => [key, '{ "version": ' + (index + 1) + ' }']);
  const storage = new Map(oldSaves);
  const game = boot(storage);
  assert.equal(game.saveNotice().hidden, false);
  assert.equal(storage.has(SAVE_KEY), false);
  for (const [key, bytes] of oldSaves) {
    assert.equal(storage.get(key), bytes, key);
    assert.ok(game.saveNotice().innerHTML.includes('data-save-key="' + key + '"'));
    game.click({ action: 'backup-save', saveKey: key });
    assert.equal(await game.downloads.at(-1).text(), bytes);
  }
});

test('recovery protects unreadable v5 bytes from ordinary writes', async t => {
  const current = currentSave();
  const missingHistory = { ...current };
  delete missingHistory.history;
  const samples = [
    ['invalid JSON', '{ malformed'],
    ['empty value', ''],
    ['unsupported version', JSON.stringify({ ...current, version: 6 })],
    ['missing history', JSON.stringify(missingHistory)],
  ];

  for (const [label, bytes] of samples) {
    await t.test(label, async () => {
      const storage = new Map([[SAVE_KEY, bytes]]);
      const game = boot(storage);
      assert.equal(game.saveNotice().hidden, false);
      game.click({ action: 'backup-save', saveKey: SAVE_KEY });
      assert.equal(await game.downloads[0].text(), bytes);
      assert.equal(storage.get(SAVE_KEY), bytes);
      game.click({ travel: 'forest' });
      game.click({ action: 'reset' });
      assert.equal(storage.get(SAVE_KEY), bytes);
      assert.equal(game.confirmations(), 0);
    });
  }
});

test('read failure keeps saves blocked after storage becomes available', () => {
  const storage = new Map([[SAVE_KEY, legacyBytes]]);
  const game = boot(storage, { rejectReads: true });
  game.allowReads();
  game.click({ travel: 'forest' });
  assert.equal(storage.get(SAVE_KEY), legacyBytes);
});

test('confirmed import into recovery persists before allowing ordinary saves again', () => {
  const storage = new Map([[SAVE_KEY, '{ damaged']]);
  const game = boot(storage);
  const candidate = { ...currentSave(), gold: 4567 };

  game.rejectWrites();
  game.importText(JSON.stringify(candidate));
  assert.equal(storage.get(SAVE_KEY), '{ damaged');
  assert.equal(game.state().gold, 100);
  game.allowWrites();
  game.click({ travel: 'forest' });
  assert.equal(storage.get(SAVE_KEY), '{ damaged');

  game.importText(JSON.stringify(candidate));
  assert.equal(game.confirmations(), 2);
  assert.equal(JSON.parse(storage.get(SAVE_KEY)).gold, 4567);
  assert.equal(game.state().gold, 4567);
  assert.equal(game.saveNotice().hidden, true);
  game.click({ travel: 'forest' });
  assert.equal(JSON.parse(storage.get(SAVE_KEY)).location, 'forest');
});

test('a failed or cancelled import preserves the active state and previous bytes', async t => {
  const candidate = { ...currentSave(), gold: 4567 };
  const cases = [
    ['invalid JSON', '{ broken', () => {}, 0],
    ['missing history', JSON.stringify({ ...candidate, history: null }), () => {}, 0],
    ['unsupported version', JSON.stringify({ ...candidate, version: 6 }), () => {}, 0],
    ['cancelled confirmation', JSON.stringify(candidate), game => game.onConfirm(() => false), 1],
    ['storage quota failure', JSON.stringify(candidate), game => game.rejectWrites(), 1],
  ];

  for (const [label, bytes, arrange, confirmations] of cases) {
    await t.test(label, () => {
      const game = boot(new Map([[SAVE_KEY, legacyBytes]]));
      const saved = game.storage.get(SAVE_KEY);
      const active = game.state();
      arrange(game);
      game.importText(bytes);
      assert.deepEqual(game.state(), active);
      assert.equal(game.storage.get(SAVE_KEY), saved);
      assert.equal(game.confirmations(), confirmations);
      assert.doesNotMatch(game.toast(), /復元しました/);
    });
  }
});

test('malformed progress leaves startup and import data intact', async t => {
  const samples = [
    ['forest boss map', 'forest', 'bossesDefeated', '{"10":true}'],
    ['forest boss flag', 'forest', 'bossesDefeated', { 10: 'true' }],
    ['forest unlock count', 'forest', 'unlocked', '12'],
    ['otherworld win count', 'isekai', 'wins', '4'],
    ['otherworld pending encounter', 'isekai', 'pendingBossId', 1],
    ['medals', null, 'medals', '76'],
    ['casino purchase history', 'casino', 'purchased', '["relic-mage"]'],
    ['casino materials', 'casino', 'materials', { 'rust-origin': true }],
    ['equipped magic', null, 'equippedMagic', 20],
    ['missing equipped spell', null, 'equippedMagic', 'magic-999'],
    ['unknown mastery format', null, 'masterySchema', 2],
  ];

  for (const [label, section, field, value] of samples) {
    await t.test(label, () => {
      const badSave = structuredClone(legacySave);
      const progress = section ? badSave[section] : badSave;
      progress[field] = value;
      const bytes = JSON.stringify(badSave);

      const recovery = boot(new Map([[SAVE_KEY, bytes]]));
      assert.equal(recovery.saveNotice().hidden, false);
      assert.equal(recovery.storage.get(SAVE_KEY), bytes);

      const game = boot(new Map([[SAVE_KEY, legacyBytes]]));
      const priorState = game.state();
      const priorBytes = game.storage.get(SAVE_KEY);
      game.importText(bytes);
      assert.equal(game.confirmations(), 0);
      assert.deepEqual(game.state(), priorState);
      assert.equal(game.storage.get(SAVE_KEY), priorBytes);
    });
  }
});

test('missing optional dungeon progress in older v5 saves can be filled', () => {
  const incomplete = structuredClone(legacySave);
  delete incomplete.forest.bossesDefeated;
  delete incomplete.isekai.retreats;
  delete incomplete.isekai.pendingBossId;

  const game = boot(new Map([[SAVE_KEY, JSON.stringify(incomplete)]]));
  assert.equal(game.saveNotice().hidden, true);
  assert.deepEqual(game.state().forest.bossesDefeated, {});
  assert.equal(game.state().isekai.retreats, 0);
  assert.equal(game.state().isekai.pendingBossId, null);
  assert.deepEqual(game.state().forest.kills, legacySave.forest.kills);
  assert.equal(game.state().isekai.wins, legacySave.isekai.wins);
});

test('old v5 data survives migration, reload, and a JSON export/import round trip', async () => {
  const storage = new Map([[SAVE_KEY, legacyBytes]]);
  const game = boot(storage);
  const migrated = game.state();
  const expectedUnchanged = [
    'version', 'activeJob', 'level', 'xp', 'hpGrowth', 'hp', 'baseStats',
    'gold', 'medals', 'ore', 'casino', 'wins', 'deaths', 'battleCount', 'rng', 'nextId', 'inventory', 'equipped',
    'magics', 'equippedMagic', 'floor', 'location', 'forest', 'isekai', 'bossDefeated',
  ];
  for (const field of expectedUnchanged) {
    assert.deepEqual(migrated[field], legacySave[field], field);
  }
  assert.equal(migrated.unlocked, 6);
  assert.equal(Object.keys(migrated.kills).length, 50);
  for (const [floor, kills] of Object.entries(legacySave.kills)) {
    assert.equal(migrated.kills[floor], kills, 'kills on floor ' + floor);
  }
  assert.equal(Object.keys(migrated.jobProgress).length, 31);
  for (const [job, progress] of Object.entries(legacySave.jobProgress)) {
    assert.deepEqual(migrated.jobProgress[job], progress, job);
  }
  assert.deepEqual(migrated.jobProgress.grandmaster, { level: 1, xp: 0 });
  assert.equal(migrated.codex.monsters['main:boss'].wins, 1);
  assert.equal(migrated.codex.monsters['forest:foe:樹皮の獣'].wins, 1);
  assert.equal(migrated.codex.monsters['isekai:otherworld-peeluna'].sightings, 1);
  assert.equal(migrated.codex.monsters['isekai:otherworld-peeluna'].battles, 0);
  assert.equal(Object.keys(migrated.codex.monsters).length, 4);
  assert.deepEqual(migrated.codex.magics.heal, { discovered: true, drops: 1, purchases: 0 });
  assert.equal(migrated.autoRunProgress, null);
  assert.equal(migrated.lastAutoRun.status, 'stopped');
  assert.equal(migrated.lastAutoRun.completed, 4);
  assert.deepEqual(boot(storage).state(), migrated);
  assert.deepEqual(JSON.parse(storage.get(SAVE_KEY)), migrated);

  game.click({ action: 'export' });
  assert.equal(game.downloads.length, 1);
  const exported = await game.downloads[0].text();
  assert.equal(JSON.parse(exported).app, 'INFINITE_ABYSS');
  const restored = boot();
  restored.importText(exported);
  assert.equal(restored.confirmations(), 1);
  assert.deepEqual(JSON.parse(restored.storage.get(SAVE_KEY)), migrated);
  assert.deepEqual(restored.state(), migrated);
});

test('a v5 save without the old boss victory keeps floor six locked', () => {
  const bytes = JSON.stringify({ ...legacySave, bossDefeated: false });
  const game = boot(new Map([[SAVE_KEY, bytes]]));
  assert.equal(game.state().unlocked, 5);
});

test('a finished poker game remains loadable after reloading', () => {
  const game = boot();
  game.click({ travel: 'casino' });
  game.click({ exchange: '1' });
  game.setInput('#pokerBet', '1');
  game.click({ cas: 'poker-deal' });
  assert.equal(game.state().casino.poker.stage, 'hold');
  assert.deepEqual(boot(game.storage).state(), game.state());
  game.click({ cas: 'poker-draw' });
  const finished = game.state();
  assert.equal(finished.casino.poker.stage, 'finished');
  assert.equal(Object.hasOwn(finished.casino.poker, 'remaining'), false);
  assert.deepEqual(boot(game.storage).state(), finished);
});

test('a stale tab cannot overwrite another tab’s progress by playing', async () => {
  const tabA = boot();
  const sharedStorage = tabA.storage;
  const tabB = boot(sharedStorage);
  tabA.click({ travel: 'forest' });
  const committed = sharedStorage.get(SAVE_KEY);
  assert.equal(JSON.parse(committed).location, 'forest');

  tabB.click({ travel: 'isekai' });
  assert.equal(sharedStorage.get(SAVE_KEY), committed);
  assert.equal(tabB.saveNotice().hidden, false);
  tabB.click({ action: 'export' });
  const exported = JSON.parse(await tabB.downloads[0].text());
  assert.equal(exported.state.location, 'isekai');
});

test('import confirmation cannot overwrite progress saved while the dialog is open', () => {
  const importer = boot();
  const otherTab = boot(importer.storage);
  const originalState = importer.state();
  importer.onConfirm(() => {
    otherTab.click({ travel: 'forest' });
    return true;
  });

  importer.importText(JSON.stringify({ ...originalState, gold: 4567 }));
  assert.deepEqual(importer.state(), originalState);
  assert.deepEqual(JSON.parse(importer.storage.get(SAVE_KEY)), otherTab.state());
  assert.equal(otherTab.state().location, 'forest');
  assert.doesNotMatch(importer.toast(), /復元しました/);
});
