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
const reservedJobs = [
  'guardian', 'weapon_master', 'samurai', 'floraflulu',
  'dark_knight', 'treasure_hunter', 'gambler', 'sage',
];

function boot(storage = new Map(), { rejectReads = false } = {}) {
  const handlers = new Map();
  const elements = new Map();
  const downloads = [];
  const savedWrites = [];
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
        scrollIntoView() {},
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
        if (key === SAVE_KEY) savedWrites.push(value);
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
    stats: window.ABYSS_DEBUG.stats,
    gainExp: window.ABYSS_DEBUG.gainExp,
    changeJob: window.ABYSS_DEBUG.changeJob,
    stepAutoRun: window.ABYSS_DEBUG.autoStep,
    importText(text) {
      handlers.get('change')({ target: { id: 'importFile', files: [text] } });
    },
    click(dataset) {
      handlers.get('click')({ target: { closest: () => ({ dataset }) } });
    },
    downloads,
    savedWrites,
    rendered: selector => element(selector).innerHTML,
    saveNotice: () => element('#saveNotice'),
    setInput(selector, value) { element(selector).value = value; },
    setChecked(selector, checked) { element(selector).checked = checked; },
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

function bootSaved(saved) {
  return boot(new Map([[SAVE_KEY, JSON.stringify(saved)]]));
}

function highLevelBattleSave(activeJob, location) {
  return {
    ...currentSave(), activeJob, location, level: 100_000, rng: 0xab155005,
    hpGrowth: 10_000_001, hp: 10_000_000,
  };
}

function equipTestSpell(save, key, name, uses) {
  save.magics = [{ id: 'magic-1', key, name, kind: 'spell', uses, maxUses: 5000, containerId: null }];
  save.equippedMagic = 'magic-1';
  save.nextId = 2;
}

test('old growth above the new limits is preserved in saves and capped in play', async () => {
  const older = structuredClone(legacySave);
  older.baseStats = { str: 20_001, mag: 25_670, vit: 80_310, dex: 22_000, agi: 40_800, luk: 27_910 };
  older.hpGrowth = 13_100_000;
  older.hp = 12_345_678;
  const rawGrowth = ['baseStats', 'hpGrowth', 'hp', 'inventory', 'equipped'];
  const game = bootSaved(older);

  assert.equal(game.saveNotice().hidden, true);
  const stats = game.stats();
  for (const key of Object.keys(older.baseStats)) {
    assert.equal(stats[key], 20_000, key);
  }
  assert.equal(stats.maxHP, 10_000_000);
  assert.match(game.rendered('#hero'), /HP 10,000,000 \/ 10,000,000/);

  game.click({ travel: 'main' });
  game.click({ action: 'export' });
  const exported = await game.downloads[0].text();
  const restored = boot();
  restored.importText(exported);
  const persisted = JSON.parse(game.storage.get(SAVE_KEY));
  const reloaded = boot(game.storage).state();
  for (const key of rawGrowth) {
    assert.deepEqual(game.state()[key], older[key], key);
    assert.deepEqual(persisted[key], older[key], key);
    assert.deepEqual(reloaded[key], older[key], key);
    assert.deepEqual(restored.state()[key], older[key], key);
  }
});

test('ordinary job selection skips the reserved eight jobs regardless of level and mastery', () => {
  const saved = { ...currentSave(), level: 1_000_000 };
  for (const job of Object.keys(saved.jobProgress)) {
    saved.jobProgress[job] = { level: 60, xp: 0 };
  }
  const game = bootSaved(saved);
  game.click({ section: 'build' });
  game.click({ build: 'jobs' });
  assert.match(game.rendered('#view'), /data-job="fighter"/);
  const before = game.state();
  const bytes = game.storage.get(SAVE_KEY);

  for (const job of reservedJobs) {
    assert.ok(!game.rendered('#view').includes('data-job="' + job + '"'), job);
    game.click({ job });
    game.changeJob(job);
    assert.equal(game.state().activeJob, 'mage', job);
  }
  assert.deepEqual(game.state(), before);
  assert.equal(game.storage.get(SAVE_KEY), bytes);
});

test('a v5 save already using a reserved job can continue using it', () => {
  const saved = { ...currentSave(), level: 100_000, hp: 43, xp: 17 };
  for (const job of reservedJobs) {
    saved.activeJob = job;
    saved.jobProgress[job] = { level: 28, xp: 12 };
    const game = bootSaved(saved);
    assert.equal(game.saveNotice().hidden, true, job);
    assert.equal(game.state().activeJob, job);
    assert.deepEqual(game.state().jobProgress[job], { level: 28, xp: 12 });
    assert.equal(game.state().hp, saved.hp);
    assert.equal(game.stats().maxHP, 78, job);
    assert.equal(boot(game.storage).state().activeJob, job);
  }
});

test('leaving a reserved job requires confirmation while its route is unpublished', () => {
  const saved = { ...currentSave(), activeJob: 'guardian', level: 100_000 };
  saved.baseStats = { ...saved.baseStats, vit: 23_000 };
  saved.hpGrowth = 13_100_000;
  saved.hp = 12_345_678;
  const game = bootSaved(saved);
  const raw = game.storage.get(SAVE_KEY);

  game.onConfirm(() => false);
  game.click({ job: 'fighter' });
  assert.equal(game.state().activeJob, 'guardian');
  assert.equal(game.storage.get(SAVE_KEY), raw);

  game.onConfirm(() => true);
  game.click({ job: 'fighter' });
  assert.equal(game.confirmations(), 2);
  assert.equal(game.state().activeJob, 'fighter');
  assert.deepEqual(game.state().baseStats, saved.baseStats);
  assert.equal(game.state().hpGrowth, saved.hpGrowth);
  assert.equal(game.state().hp, saved.hp);
  assert.equal(game.stats().maxHP, 10_000_000);
});

test('EXP earned at the old total level limit carries forward on the next gain', () => {
  const saved = { ...currentSave(), level: 100_000, xp: 25_000_250_040 };
  const game = bootSaved(saved);
  assert.equal(game.state().level, 100_000);
  assert.equal(game.state().xp, saved.xp);

  game.gainExp(1);
  assert.equal(game.state().level, 100_001);
  assert.equal(game.state().xp, 1);
  assert.deepEqual(game.state().jobProgress.mage, { level: 1, xp: 1 });
  assert.equal(boot(game.storage).state().level, 100_001);
});

test('total level stops at one million even with enough EXP for another level', () => {
  const saved = { ...currentSave(), level: 999_999, xp: 2_499_997_500_039 };
  const game = bootSaved(saved);
  game.gainExp(2_500_002_500_041);
  assert.equal(game.state().level, 1_000_000);
  assert.equal(game.state().jobProgress.mage.level, 60);
  assert.equal(game.state().growthPoints, 1);
  game.gainExp(2_500_002_500_040);
  assert.equal(game.state().level, 1_000_000);
  assert.equal(game.state().growthPoints, 1);
  assert.equal(boot(game.storage).state().level, 1_000_000);
});

test('growth points record only new levels after 100,000 and survive reload and JSON transfer', async () => {
  const saved = { ...currentSave(), level: 99_999, xp: 24_999_750_039 };
  delete saved.growthPoints;
  const game = bootSaved(saved);
  assert.equal(game.state().growthPoints, 0);

  game.gainExp(1);
  assert.equal(game.state().level, 100_000);
  assert.equal(game.state().growthPoints, 0);
  game.gainExp(25_000_250_040 + 25_000_750_045);
  assert.equal(game.state().level, 100_002);
  assert.equal(game.state().growthPoints, 2);
  assert.match(game.rendered('#hero'), /育成ポイント 2</);
  game.gainExp(1);
  assert.equal(game.state().growthPoints, 2);
  assert.equal(boot(game.storage).state().growthPoints, 2);

  game.click({ action: 'export' });
  const exported = await game.downloads[0].text();
  assert.equal(JSON.parse(exported).state.growthPoints, 2);
  const restored = boot();
  restored.importText(exported);
  assert.equal(restored.state().growthPoints, 2);
  assert.equal(JSON.parse(restored.storage.get(SAVE_KEY)).growthPoints, 2);
});

test('a legacy save above the growth threshold earns no retroactive points', () => {
  const saved = { ...currentSave(), level: 300_000 };
  delete saved.growthPoints;
  const game = bootSaved(saved);
  assert.equal(game.state().growthPoints, 0);
  assert.equal(boot(game.storage).state().growthPoints, 0);

  game.gainExp(225_000_750_040);
  assert.equal(game.state().level, 300_001);
  assert.equal(game.state().growthPoints, 1);
});

test('upper jobs scale wounded HP and Wall during battle and restore the normal HP ratio', () => {
  const matchups = [
    ['guardian', 15_000_000, 13_500_002],
    ['dark_knight', 12_000_000, 10_800_001],
  ];
  for (const [job, battleMaxHP, battleStartHP] of matchups) {
    const save = highLevelBattleSave(job, 'forest');
    save.hp = 9_000_001;
    Object.assign(save.baseStats, { str: 20_000, dex: 20_000, luk: 20_000 });
    equipTestSpell(save, 'wall', 'ウォール', 7);
    const game = bootSaved(save);
    assert.equal(game.stats().maxHP, 10_000_000, job);

    game.click({ forestfight: '1' });
    const result = game.state().forest.battleRecords[0];
    assert.equal(result.win, true, job);
    assert.equal(result.turns[0].playerHpBefore, battleStartHP, job);
    assert.equal(result.turns[0].playerHpAfter, battleStartHP, job);
    assert.equal(result.turns[0].wallAfter, battleMaxHP, job);
    const wallLimit = (battleMaxHP * 3).toLocaleString('ja-JP');
    assert.ok(result.turns[0].events.some(line => line.includes('上限' + wallLimit)), job);
    assert.equal(game.stats().maxHP, 10_000_000, job);
    assert.equal(JSON.parse(game.storage.get(SAVE_KEY)).hp, 9_000_001, job);
  }
});

test('defeated upper jobs recover a quarter of normal max HP rounded up', () => {
  for (const job of ['guardian', 'dark_knight']) {
    const save = highLevelBattleSave(job, 'forest');
    save.hp = 1;
    save.hpGrowth = 9_999_997 - 50 - 4 * save.baseStats.vit;
    save.forest.floor = save.forest.unlocked = 50;
    const game = bootSaved(save);
    game.setInput('#retreat', '0');
    assert.equal(game.stats().maxHP, 9_999_997, job);

    game.click({ forestboss: '1' });
    const state = game.state();
    const result = state.forest.battleRecords[0];
    assert.equal(result.win, false, job);
    assert.equal(result.retreated, false, job);
    assert.equal(state.deaths, 1, job);
    assert.equal(state.hp, 2_500_000, job);
    assert.equal(boot(game.storage).state().hp, 2_500_000, job);
  }
});

test('manual and auto 150-turn retreats only save normal HP and keep 70% EXP', async t => {
  for (const automated of [false, true]) {
    await t.test(automated ? 'auto' : 'manual', () => {
      const save = highLevelBattleSave('guardian', 'isekai');
      save.isekai.pendingBossId = 'otherworld-peeluna';
      Object.assign(save.baseStats, { agi: 20_000, luk: 20_000 });
      equipTestSpell(save, 'heal', 'ヒール', 300);
      const game = bootSaved(save);

      if (automated) {
        game.setInput('#autoMax', '3');
        game.setInput('#autoRetreat', '0');
        game.setChecked('#autoBoss', true);
        game.setChecked('#autoPeeluna', false);
        game.click({ auto: 'start' });
        assert.equal(game.state().autoRunProgress.maxHP, 10_000_000);
        game.stepAutoRun();
      } else {
        game.click({ isekaifight: '1' });
      }

      const state = game.state();
      const result = state.isekai.battleRecords[0];
      assert.equal(result.rounds, 150);
      assert.equal(result.retreated, true);
      assert.equal(result.exp, 21_140_000);
      assert.equal(result.gold, 0);
      assert.ok(result.turns.at(-1).playerHpAfter > 10_000_000);
      assert.equal(state.isekai.retreats, 1);
      assert.equal(state.deaths, 0);
      assert.equal(state.battleCount, 1);
      assert.equal(state.hp, 10_000_000);
      assert.equal(boot(game.storage).state().hp, 10_000_000);

      const writes = game.savedWrites.map(raw => JSON.parse(raw));
      assert.ok(writes.every(snapshot => snapshot.hp <= 10_000_000));
      if (automated) {
        assert.equal(state.autoRunProgress, null);
        assert.equal(state.lastAutoRun.completed, 1);
        assert.equal(state.lastAutoRun.status, 'stopped');
        assert.equal(state.lastAutoRun.maxHP, 10_000_000);
        const completedRun = writes.find(snapshot => snapshot.autoRunProgress?.completed === 1);
        assert.equal(completedRun?.autoRunProgress.maxHP, 10_000_000);
        assert.equal(completedRun?.autoRunProgress.lastHP, 10_000_000);
      }
    });
  }
});

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
    ['growth point string', null, 'growthPoints', '2'],
    ['negative growth points', null, 'growthPoints', -1],
    ['fractional growth points', null, 'growthPoints', 1.5],
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
