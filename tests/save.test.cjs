'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { Script } = require('node:vm');

const SAVE_KEY = 'infinite-abyss-save-v5';
const NORMAL_HP_LIMIT = 99_999_999;
const ABILITY_LIMIT = 199_999;
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
        style: {},
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
    console: { warn() {}, error: (...args) => console.error(...args) },
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
    growth: window.ABYSS_DEBUG.grow,
    codexMonsters: window.ABYSS_DEBUG.codexMonsters,
    rollIsekaiBoss: window.ABYSS_DEBUG.rollIsekaiBoss,
    mainFloors: window.ABYSS_DEBUG.mainFloors,
    masteryProcRate: window.ABYSS_DEBUG.masteryProcRate,
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
    hpGrowth: 100_000_001, hp: NORMAL_HP_LIMIT,
  };
}

function equipTestSpell(save, key, name, uses) {
  save.magics = [{ id: 'magic-1', key, name, kind: 'spell', uses, maxUses: 5000, containerId: null }];
  save.equippedMagic = 'magic-1';
  save.nextId = 2;
}

function forestEffectSave(activeJob, { floor = 10, jobLevel = 1, seed = 0xab155005 } = {}) {
  const saved = {
    ...currentSave(), activeJob, location: 'forest', level: 100_000, hpGrowth: 10_000, hp: 3_000, rng: seed,
  };
  Object.assign(saved.baseStats, { str: 60, mag: 60, dex: 70 });
  saved.forest.floor = saved.forest.unlocked = floor;
  saved.jobProgress[activeJob].level = jobLevel;
  return saved;
}

function fightFromSave(saved) {
  const game = bootSaved(saved);
  const action = saved.location === 'isekai' ? { isekaifight: '1' } :
    saved.forest.floor % 10 === 0 ? { forestboss: '1' } : { forestfight: '1' };
  game.click(action);
  const state = game.state();
  return { game, state, result: state[saved.location].battleRecords[0] };
}

function firstNormalHit(turn) {
  const attack = turn.events.find(event => event.startsWith('通常攻撃'));
  return Number(attack.match(/ ([\d,]+)ダメージ/)[1].replaceAll(',', ''));
}

test('old growth above the new limits is preserved in saves and capped in play', async () => {
  const older = structuredClone(legacySave);
  older.baseStats = { str: 200_001, mag: 256_700, vit: 803_100, dex: 220_000, agi: 408_000, luk: 279_100 };
  older.hpGrowth = 131_000_000;
  older.hp = 123_456_789;
  const rawGrowth = ['baseStats', 'hpGrowth', 'hp', 'inventory', 'equipped'];
  const game = bootSaved(older);

  assert.equal(game.saveNotice().hidden, true);
  const stats = game.stats();
  for (const key of Object.keys(older.baseStats)) {
    assert.equal(stats[key], ABILITY_LIMIT, key);
  }
  assert.equal(stats.maxHP, NORMAL_HP_LIMIT);
  assert.match(game.rendered('#hero'), /HP 99,999,999 \/ 99,999,999/);

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
  saved.baseStats = { ...saved.baseStats, vit: 230_000 };
  saved.hpGrowth = 131_000_000;
  saved.hp = 123_456_789;
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
  assert.equal(game.stats().maxHP, NORMAL_HP_LIMIT);
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

test('the revised jobs use the approved six-attribute growth rows', () => {
  const attributes = ['str', 'mag', 'vit', 'dex', 'agi', 'luk'];
  const expectedGrowth = {
    spellblade: [2.2, 2.8, 1.2, 1.6, 1.1, 0.7],
    general: [3.0, 0.2, 3.2, 1.5, 0.6, 0.7],
    paladin: [2.2, 1.7, 3.6, 0.9, 0.5, 1.1],
    court_mage: [0.3, 4.1, 1.4, 1.4, 0.7, 1.2],
    sniper: [2.5, 0.2, 1.0, 4.1, 1.3, 1.2],
    ninja: [1.9, 0.8, 1.0, 2.5, 4.1, 1.1],
    assassin: [2.9, 0.3, 1.0, 3.5, 2.9, 1.7],
    berserker: [4.1, 0.1, 1.8, 1.2, 0.9, 0.7],
    hero: [3.7, 2.6, 3.2, 2.3, 1.8, 1.8],
    grandmaster: [3.8, 3.6, 3.4, 3.2, 3.1, 2.8],
  };
  const actualGrowth = boot().growth();
  for (const [job, expected] of Object.entries(expectedGrowth)) {
    assert.deepEqual(attributes.map(attribute => actualGrowth[job][attribute]), expected, job);
  }
});

test('new Hero and Grandmaster growth accrues on top of saved permanent stats above the effective cap', () => {
  const cases = {
    hero: { str: 4, mag: 2, vit: 3, dex: 3, agi: 2, luk: 1 },
    grandmaster: { str: 4, mag: 3, vit: 3, dex: 4, agi: 3, luk: 2 },
  };
  for (const [job, gains] of Object.entries(cases)) {
    const saved = {
      ...currentSave(), activeJob: job, level: 100_000, xp: 25_000_250_039, rng: 0xab155005,
      hpGrowth: 101_000_000, hp: 50_000_000,
      baseStats: { str: 201_000, mag: 224_000, vit: 221_000, dex: 215_000, agi: 207_000, luk: 203_000 },
    };
    const game = bootSaved(saved);
    assert.deepEqual(game.state().baseStats, saved.baseStats, job);
    assert.equal(game.state().hpGrowth, saved.hpGrowth, job);

    game.gainExp(1);
    const updated = game.state();
    const reloaded = boot(game.storage).state();
    for (const [attribute, gain] of Object.entries(gains)) {
      assert.equal(updated.baseStats[attribute], saved.baseStats[attribute] + gain, job + ' ' + attribute);
      assert.equal(reloaded.baseStats[attribute], updated.baseStats[attribute], job + ' ' + attribute);
    }
    assert.equal(updated.hpGrowth, 101_100_003, job);
    assert.equal(reloaded.hpGrowth, updated.hpGrowth, job);
    assert.equal(game.stats().vit, ABILITY_LIMIT, job);
    assert.equal(game.stats().maxHP, NORMAL_HP_LIMIT, job);
    assert.equal(updated.growthPoints, 1, job);
  }
});

test('the ordinary damage path applies the Fighter, Hero, Grandmaster and Berserker passives', () => {
  const baseline = fightFromSave(forestEffectSave('ninja')).result.turns[0];
  const baselineDamage = firstNormalHit(baseline);
  const baselineInjury = baseline.playerHpBefore - baseline.playerHpAfter;
  const matchups = [
    ['fighter', 1.10, 100], ['hero', 1.35, 85], ['grandmaster', 1.20, 80], ['berserker', 1.35, 110],
  ];
  for (const [job, attackMultiplier, incomingPercent] of matchups) {
    const turn = fightFromSave(forestEffectSave(job)).result.turns[0];
    assert.equal(firstNormalHit(turn), Math.round(baselineDamage * attackMultiplier), job);
    assert.equal(turn.playerHpBefore - turn.playerHpAfter, Math.ceil(baselineInjury * incomingPercent / 100), job);
  }

  const nonBossBaseline = fightFromSave(forestEffectSave('ninja', { floor: 1 })).result.turns[0];
  const nonBossHero = fightFromSave(forestEffectSave('hero', { floor: 1 })).result.turns[0];
  assert.equal(firstNormalHit(nonBossHero), firstNormalHit(nonBossBaseline));

  const healthyBerserker = forestEffectSave('berserker');
  healthyBerserker.hp = 8_000;
  const healthy = fightFromSave(healthyBerserker).result.turns[0];
  assert.equal(firstNormalHit(healthy), baselineDamage);
  assert.equal(healthy.playerHpBefore - healthy.playerHpAfter, baselineInjury);

  const mastered = fightFromSave(forestEffectSave('berserker', { jobLevel: 60 })).result.turns[0];
  assert.ok(mastered.events.some(event => event.includes('職業補正×1.5')));
  assert.ok(mastered.events.some(event => event.includes('バーサーカー×1.1')));
});

test('Healer boosts the Heal spell and fixed-healing skill while spending one charge', () => {
  const save = forestEffectSave('healer', { floor: 1, jobLevel: 60 });
  Object.assign(save.baseStats, { mag: 20_000, luk: 20_000 });
  equipTestSpell(save, 'heal', 'ヒール', 7);
  const { state, result } = fightFromSave(save);
  assert.equal(result.rounds, 1);
  assert.equal(state.magics[0].uses, 6);
  assert.ok(result.turns[0].events.some(event => /【ヒール】HP\+375（残6回）/.test(event)));
  assert.ok(result.turns[0].events.some(event => /【大天の審判】.*HP\+37$/.test(event)));
});

test('Court Mage retains a charge on successful rolls and still casts the spell', () => {
  // Seed 1 passes the 25% rate and fails 15%. Seed 3 passes 15%.
  for (const [jobLevel, seed, uses] of [[1, 1, 6], [60, 1, 7], [1, 3, 7]]) {
    const save = forestEffectSave('court_mage', { floor: 1, jobLevel, seed });
    Object.assign(save.baseStats, { mag: 20_000, luk: 20_000 });
    equipTestSpell(save, 'heal', 'ヒール', 7);
    const { game, state, result } = fightFromSave(save);
    assert.equal(result.rounds, 1);
    assert.ok(result.turns[0].events.some(event => event.includes('【ヒール】HP+300')));
    assert.equal(state.magics[0].uses, uses);
    assert.equal(boot(game.storage).state().magics[0].uses, uses);
  }
});

test('Thief can evade a standard attack that hits another job at the same accuracy roll', () => {
  // The first enemy attack roll is between the ordinary and Thief hit rates.
  const seed = 20_249_797;
  const baseline = fightFromSave(forestEffectSave('ninja', { seed })).result.turns[0];
  const thief = fightFromSave(forestEffectSave('thief', { seed })).result.turns[0];
  assert.equal(firstNormalHit(thief), firstNormalHit(baseline));
  assert.ok(baseline.playerHpAfter < baseline.playerHpBefore);
  assert.equal(thief.playerHpAfter, thief.playerHpBefore);
  assert.ok(thief.events.includes('敵の攻撃を回避！'));
});

test('Paladin recovery uses the HP damage actually dealt after incoming mitigation', () => {
  for (const [jobLevel, percent] of [[1, 15], [60, 25]]) {
    const turn = fightFromSave(forestEffectSave('paladin', { jobLevel })).result.turns[0];
    const incoming = turn.events.find(event => event.startsWith('敵の攻撃 '));
    const injury = Number(incoming.match(/HP被害 ([\d,]+)/)[1].replaceAll(',', ''));
    assert.ok(injury > 0);
    assert.equal(turn.playerHpBefore - turn.playerHpAfter, injury - Math.floor(injury * percent / 100));
  }

  const shielded = forestEffectSave('paladin', { seed: 11_778_040 });
  shielded.baseStats.luk = 20_000;
  equipTestSpell(shielded, 'wall', 'ウォール', 7);
  const turn = fightFromSave(shielded).result.turns[0];
  assert.ok(turn.events.some(event => event.includes('HP被害 0')));
  assert.equal(turn.playerHpAfter, turn.playerHpBefore);
  assert.ok(turn.events.every(event => !event.includes('パラディン：HP+')));
});

test('Master Hero heals once on a qualifying surviving hit', () => {
  const save = forestEffectSave('hero', { jobLevel: 60 });
  save.baseStats.str = 30;
  const { game, result } = fightFromSave(save);
  const maxHP = game.stats().maxHP;
  const recoveryHits = result.turns.flatMap(turn => turn.events).filter(event => event.includes('勇者：HP+'));
  assert.equal(recoveryHits.length, 1);
  assert.ok(recoveryHits[0].includes('HP+' + Math.floor(maxHP * 0.10).toLocaleString('ja-JP')));
  assert.ok(result.turns.slice(1).some(turn => turn.playerHpAfter > 0 && turn.playerHpAfter <= maxHP * 0.35 &&
    turn.events.some(event => event.startsWith('敵の攻撃 '))));
});

test('Master Grandmaster prevents one applicable status per encounter', () => {
  const save = forestEffectSave('grandmaster', { jobLevel: 60 });
  save.location = 'isekai';
  save.isekai.pendingBossId = 'otherworld-1';
  save.hp = 500_000;
  save.hpGrowth = 1_000_000;
  const { result } = fightFromSave(save);
  const events = result.turns.flatMap(turn => turn.events);
  const wards = events.filter(event => /【グランドマスター】.*を防いだ/.test(event));
  assert.equal(wards.length, 1);
  assert.ok(events.slice(events.indexOf(wards[0]) + 1).some(event => event.startsWith('状態異常：')));

  save.jobProgress.grandmaster.level = 59;
  const withoutMastery = fightFromSave(save).result.turns.flatMap(turn => turn.events);
  assert.ok(withoutMastery.some(event => event.startsWith('状態異常：')));
  assert.ok(withoutMastery.every(event => !/【グランドマスター】.*を防いだ/.test(event)));
});

test('Grandmaster adds three percentage points to both mastery rolls during battle', () => {
  for (const job of ['ninja', 'grandmaster']) {
    const save = forestEffectSave(job, { seed: 456 });
    save.baseStats.str = 30;
    for (const slot of ['weapon', 'body']) {
      const id = 'test-' + slot;
      save.inventory.push({
        id, name: id, slot, job: 'all', baseAttack: 0, baseDefense: 0,
        mastery: 50, masteryXp: 0, maxMastery: 2000, stat: {}, enhance: 0, price: 0,
      });
      save.equipped[slot] = id;
    }
    const { game, result } = fightFromSave(save);
    const events = result.turns[0].events.join(' ');
    assert.equal(events.includes('極撃×5'), job === 'grandmaster');
    assert.equal(events.includes('再生：'), job === 'grandmaster');
    assert.equal(game.masteryProcRate('weapon'), 15);
    assert.equal(game.masteryProcRate('body'), 15);
  }
});

test('Spellblade and Sniper boost just the first landed attack in the qualifying turn', () => {
  const forEachMastery = [
    [1, 1.25, 1.3],
    [60, 1.4, 1.45],
  ];
  for (const [jobLevel, spellbladeMultiplier, sniperMultiplier] of forEachMastery) {
    const spellblade = forestEffectSave('spellblade', { jobLevel });
    Object.assign(spellblade.baseStats, { agi: 60, luk: 20_000 });
    const withoutSpell = fightFromSave(spellblade).result.turns[0].events;
    assert.ok(withoutSpell.every(event => !event.includes('職業補正')));

    equipTestSpell(spellblade, 'heal', 'ヒール', 7);
    const withSpell = fightFromSave(spellblade).result.turns[0].events;
    assert.ok(withSpell[1].startsWith('【ヒール】'));
    assert.ok(withSpell[2].includes('職業補正×' + spellbladeMultiplier));
    assert.equal(withSpell.filter(event => event.includes('職業補正')).length, 1);

    const sniper = forestEffectSave('sniper', { jobLevel, seed: 11_950_933 });
    Object.assign(sniper.baseStats, { agi: 60, dex: 8 });
    const sniping = fightFromSave(sniper).result.turns[0].events;
    assert.equal(sniping[1], '命中失敗');
    assert.ok(sniping[2].includes('職業補正×' + sniperMultiplier));
    assert.equal(sniping.filter(event => event.includes('職業補正')).length, 1);
  }
});

test('Ninja boosts the first landed attack in the turn after dodging', () => {
  for (const [jobLevel, seed, multiplier] of [[1, 11_259_361, 1.3], [60, 11_778_040, 1.45]]) {
    const save = forestEffectSave('ninja', { jobLevel, seed });
    save.baseStats.agi = 60;
    const { result } = fightFromSave(save);
    const [dodge, counter] = result.turns;
    assert.ok(dodge.events.includes('敵の攻撃を回避！'));
    assert.ok(dodge.events.every(event => !event.includes('職業補正')));
    assert.ok(counter.events[1].includes('職業補正×' + multiplier));
    assert.equal(counter.events.filter(event => event.includes('職業補正')).length, 1);
  }
});

test('Assassin checks enemy HP immediately before each hit, including earlier hits in the same turn', () => {
  for (const [jobLevel, multiplier] of [[1, 1.25], [60, 1.4]]) {
    const save = forestEffectSave('assassin', { jobLevel });
    Object.assign(save.baseStats, { agi: 60, str: 200 });
    const { result } = fightFromSave(save);
    const enemyMaxHP = result.turns[0].enemyHpBefore;
    let boostedHits = 0;
    let ordinaryHits = 0;
    for (const turn of result.turns) {
      let enemyHP = turn.enemyHpBefore;
      for (const event of turn.events) {
        if (event.startsWith('敵の攻撃 ')) continue;
        const hit = event.match(/ ([\d,]+)ダメージ/);
        if (!hit) continue;
        if (enemyHP <= enemyMaxHP * 0.30) {
          assert.ok(event.includes('職業補正×' + multiplier));
          boostedHits++;
        } else {
          assert.ok(!event.includes('職業補正'));
          ordinaryHits++;
        }
        enemyHP -= Number(hit[1].replaceAll(',', ''));
      }
    }
    assert.ok(boostedHits > 0 && ordinaryHits > 0);
  }
});

test('General adds five or ten percentage points to a triggered guard', () => {
  for (const [jobLevel, seed, points] of [[15, 0xab155005, 5], [60, 14_198_542, 10]]) {
    const save = forestEffectSave('general', { jobLevel, seed });
    if (jobLevel === 15) save.baseStats.luk = 20_000;
    const turn = fightFromSave(save).result.turns[0];
    assert.ok(turn.events.some(event => event.startsWith('【鉄壁の一撃】')));
    assert.ok(turn.events.includes('【ジェネラル】ガード+' + points + 'ポイント'));
  }
});

test('upper jobs scale wounded HP and Wall during battle and restore the normal HP ratio', () => {
  const matchups = [
    ['guardian', 149_999_998, 135_000_001],
    ['dark_knight', 119_999_998, 108_000_000],
  ];
  for (const [job, battleMaxHP, battleStartHP] of matchups) {
    const save = highLevelBattleSave(job, 'forest');
    save.hp = 90_000_001;
    Object.assign(save.baseStats, { str: 20_000, dex: 20_000, luk: 20_000 });
    equipTestSpell(save, 'wall', 'ウォール', 7);
    const game = bootSaved(save);
    assert.equal(game.stats().maxHP, NORMAL_HP_LIMIT, job);

    game.click({ forestfight: '1' });
    const result = game.state().forest.battleRecords[0];
    assert.equal(result.win, true, job);
    assert.equal(result.turns[0].playerHpBefore, battleStartHP, job);
    assert.equal(result.turns[0].playerHpAfter, battleStartHP, job);
    assert.equal(result.turns[0].wallAfter, battleMaxHP, job);
    const wallLimit = (battleMaxHP * 3).toLocaleString('ja-JP');
    assert.ok(result.turns[0].events.some(line => line.includes('上限' + wallLimit)), job);
    assert.equal(game.stats().maxHP, NORMAL_HP_LIMIT, job);
    assert.equal(JSON.parse(game.storage.get(SAVE_KEY)).hp, 90_000_001, job);
  }
});

test('defeated upper jobs recover a quarter of normal max HP rounded up', () => {
  for (const job of ['guardian', 'dark_knight']) {
    const save = highLevelBattleSave(job, 'forest');
    save.hp = 1;
    save.hpGrowth = 99_999_997 - 50 - 4 * save.baseStats.vit;
    save.forest.floor = save.forest.unlocked = 50;
    const game = bootSaved(save);
    game.setInput('#retreat', '0');
    assert.equal(game.stats().maxHP, 99_999_997, job);

    game.click({ forestboss: '1' });
    const state = game.state();
    const result = state.forest.battleRecords[0];
    assert.equal(result.win, false, job);
    assert.equal(result.retreated, false, job);
    assert.equal(state.deaths, 1, job);
    assert.equal(state.hp, 25_000_000, job);
    assert.equal(boot(game.storage).state().hp, 25_000_000, job);
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
        assert.equal(game.state().autoRunProgress.maxHP, NORMAL_HP_LIMIT);
        game.stepAutoRun();
      } else {
        game.click({ isekaifight: '1' });
      }

      const state = game.state();
      const result = state.isekai.battleRecords[0];
      assert.equal(result.rounds, 150);
      assert.equal(result.retreated, true);
      assert.equal(result.exp, 700_000_000);
      assert.equal(result.gold, 0);
      assert.ok(result.turns.at(-1).playerHpAfter > NORMAL_HP_LIMIT);
      assert.equal(state.isekai.retreats, 1);
      assert.equal(state.deaths, 0);
      assert.equal(state.battleCount, 1);
      assert.equal(state.hp, NORMAL_HP_LIMIT);
      assert.equal(boot(game.storage).state().hp, NORMAL_HP_LIMIT);

      const writes = game.savedWrites.map(raw => JSON.parse(raw));
      assert.ok(writes.every(snapshot => snapshot.hp <= NORMAL_HP_LIMIT));
      if (automated) {
        assert.equal(state.autoRunProgress, null);
        assert.equal(state.lastAutoRun.completed, 1);
        assert.equal(state.lastAutoRun.status, 'stopped');
        assert.equal(state.lastAutoRun.maxHP, NORMAL_HP_LIMIT);
        const completedRun = writes.find(snapshot => snapshot.autoRunProgress?.completed === 1);
        assert.equal(completedRun?.autoRunProgress.maxHP, NORMAL_HP_LIMIT);
        assert.equal(completedRun?.autoRunProgress.lastHP, NORMAL_HP_LIMIT);
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


test('the two Blue-Flame Skeletons have independent IDs and battle records', () => {
  const game = boot();
  const name = '青燐の骸骨兵';
  const monsters = game.codexMonsters();
  assert.equal(monsters.length, 256);
  assert.equal(new Set(monsters.map(monster => monster.id)).size, 256);
  const encounters = monsters.filter(monster => monster.group === 'main' && monster.name === name);
  assert.deepEqual(encounters.map(monster => monster.floor), [2, 15]);

  const retiredId = 'main:foe:' + name;
  const otherId = 'main:foe:苔喰いネズミ';
  const record = { sightings: 7, battles: 7, wins: 7, losses: 0, retreats: 0, drops: {} };
  const save = game.state();
  save.codex.monsters = { [retiredId]: record, [otherId]: record };
  save.unlocked = 15;
  save.kills[2] = 6;
  save.baseStats = { str: 50000, mag: 50000, vit: 1000, dex: 10000, agi: 50, luk: 50 };

  const migrated = bootSaved(save).state();
  assert.deepEqual(migrated.codex.monsters, { [otherId]: record });
  assert.deepEqual(migrated.kills, save.kills);

  const restored = boot();
  restored.importText(JSON.stringify({ state: save }));
  assert.deepEqual(restored.state().codex.monsters, migrated.codex.monsters);

  const withoutCodex = { ...save, history: [{ id: 2, headline: '勝利：' + name, body: '' }] };
  delete withoutCodex.codex;
  assert.deepEqual(bootSaved(withoutCodex).state().codex.monsters, {});

  let progress = migrated;
  for (const { id, floor } of encounters) {
    const foes = game.mainFloors()[floor].foes;
    const index = foes.findIndex(foe => foe[0] === name);
    let seed = 1;
    for (; seed < 100000; seed++) {
      let x = seed;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      if (Math.floor((x >>> 0) / 4294967296 * foes.length) === index) break;
    }
    const dungeon = bootSaved({ ...progress, floor, rng: seed });
    dungeon.click({ fight: '1' });
    progress = boot(dungeon.storage).state();
    assert.equal(progress.codex.monsters[id].wins, 1);
    assert.equal(progress.codex.monsters[retiredId], undefined);
  }
  assert.deepEqual(encounters.map(({ id }) => progress.codex.monsters[id].wins), [1, 1]);
  assert.deepEqual(progress.codex.monsters[otherId], record);
});

test('the rare boss is selected only below the 0.01 percent encounter threshold', () => {
  const save = currentSave();
  // These seeds produce adjacent 32-bit rolls on either side of the threshold.
  const rare = bootSaved({ ...save, rng: 3683737958 });
  const ordinary = bootSaved({ ...save, rng: 690283599 });
  assert.equal(rare.rollIsekaiBoss(), '異世界に迷い込んだぴーるな');
  assert.notEqual(ordinary.rollIsekaiBoss(), '異世界に迷い込んだぴーるな');
});

test('victory logs show the EXP actually awarded by the current job', () => {
  const { state, result } = fightFromSave(forestEffectSave('floraflulu', { floor: 1 }));
  assert.equal(result.win, true);
  assert.equal(result.exp, 37);
  assert.match(state.history[0].body, /EXP\+37 \/ /);
});

function configureAutoRun(game, target = 3) {
  game.setInput('#autoMax', String(target));
  game.setInput('#autoRetreat', '0');
  game.setChecked('#autoBoss', true);
}

test('auto-run requires a successful save before starting', async t => {
  await t.test('storage is full', () => {
    const game = boot();
    const bytes = game.storage.get(SAVE_KEY);
    configureAutoRun(game);
    game.rejectWrites();
    game.click({ auto: 'start' });
    game.stepAutoRun();
    const progress = game.state();
    assert.equal(progress.battleCount, 0);
    assert.equal(progress.autoRunProgress, null);
    assert.match(game.toast(), /保存/);
    assert.equal(game.storage.get(SAVE_KEY), bytes);
  });

  await t.test('unreadable save in recovery', () => {
    const original = '{broken JSON';
    const game = boot(new Map([[SAVE_KEY, original]]));
    configureAutoRun(game);
    game.click({ auto: 'start' });
    game.stepAutoRun();
    assert.equal(game.state().battleCount, 0);
    assert.equal(game.state().autoRunProgress, null);
    assert.equal(game.storage.get(SAVE_KEY), original);
    assert.match(game.toast(), /復旧/);
  });
});

test('auto-run stops after the first unsaved battle and keeps the result available for export', async t => {
  for (const failure of ['storage full', 'other tab']) {
    await t.test(failure, async () => {
      const game = bootSaved(autoRunSave());
      configureAutoRun(game);
      game.click({ auto: 'start' });
      game.stepAutoRun();
      assert.equal(JSON.parse(game.storage.get(SAVE_KEY)).battleCount, 1);

      if (failure === 'storage full') {
        game.rejectWrites();
      } else {
        const other = boot(game.storage);
        other.click({ fight: '1' });
        other.click({ fight: '1' });
      }
      const bytes = game.storage.get(SAVE_KEY);
      game.stepAutoRun();
      game.stepAutoRun();
      assert.equal(game.storage.get(SAVE_KEY), bytes);
      const progress = game.state();
      assert.equal(progress.battleCount, 2);
      assert.equal(progress.autoRunProgress, null);
      assert.equal(progress.lastAutoRun.completed, 2);
      assert.match(progress.lastAutoRun.reason, /保存/);

      game.click({ action: 'export' });
      const exported = JSON.parse(await game.downloads.at(-1).text()).state;
      assert.equal(exported.battleCount, 2);
      assert.equal(exported.xp, progress.xp);
      assert.equal(exported.gold, progress.gold);
    });
  }
});

function autoRunSave() {
  const save = currentSave();
  save.hpGrowth = 40_000;
  save.hp = 40_000;
  Object.assign(save.baseStats, { mag: ABILITY_LIMIT, dex: ABILITY_LIMIT });
  return save;
}

test('auto-run rejects 1,001 battles and saves exactly 1,000 at the limit', () => {
  const game = bootSaved(autoRunSave());
  configureAutoRun(game, 1001);
  game.click({ auto: 'start' });
  assert.equal(game.state().autoRunProgress, null);

  configureAutoRun(game, 1000);
  game.click({ auto: 'start' });
  for (let step = 0; step < 1001; step++) game.stepAutoRun();
  const progress = boot(game.storage).state();
  assert.equal(progress.battleCount, 1000);
  assert.equal(progress.wins, 1000);
  assert.equal(progress.lastAutoRun.completed, 1000);
  assert.equal(progress.lastAutoRun.reason, '周回数の上限に到達');
  assert.equal(progress.autoRunProgress, null);
});

test('manual stop and reload retain completed auto-run battles without resuming', async t => {
  for (const stop of ['manual', 'reload']) {
    await t.test(stop, () => {
      const game = bootSaved(autoRunSave());
      configureAutoRun(game);
      game.click({ auto: 'start' });
      game.stepAutoRun();

      if (stop === 'manual') game.click({ auto: 'stop' });
      const reopened = boot(game.storage);
      reopened.stepAutoRun();
      const progress = reopened.state();
      assert.equal(progress.battleCount, 1);
      assert.equal(progress.wins, 1);
      assert.equal(progress.lastAutoRun.completed, 1);
      assert.equal(progress.autoRunProgress, null);
      assert.match(progress.lastAutoRun.reason, stop === 'manual' ? /手動停止/ : /再読み込み/);
    });
  }
});

test('auto-run stops at the HP threshold or when the active job reaches MASTER', async t => {
  await t.test('HP at the exact threshold rejects the start', () => {
    const save = currentSave();
    save.hp = 39;
    const game = bootSaved(save);
    configureAutoRun(game);
    game.setInput('#autoRetreat', '50');
    game.click({ auto: 'start' });
    game.stepAutoRun();
    assert.equal(game.state().battleCount, 0);
    assert.match(game.toast(), /HPが撤退条件/);
  });

  await t.test('the victory that earns MASTER is the last battle', () => {
    const save = autoRunSave();
    save.jobProgress.mage = { level: 59, xp: 8889 };
    const game = bootSaved(save);
    configureAutoRun(game);
    game.setChecked('#autoMaster', true);
    game.click({ auto: 'start' });
    game.stepAutoRun();
    game.stepAutoRun();
    const progress = boot(game.storage).state();
    assert.equal(progress.jobProgress.mage.level, 60);
    assert.equal(progress.battleCount, 1);
    assert.equal(progress.lastAutoRun.reason, 'ジョブマスター到達');
  });
});

test('rare auto-run encounter is saved without fighting and consumed by a manual fight', () => {
  const save = highLevelBattleSave('guardian', 'isekai');
  save.rng = 3683737958;
  const game = bootSaved(save);
  configureAutoRun(game);
  game.setChecked('#autoPeeluna', true);
  game.click({ auto: 'start' });
  game.stepAutoRun();

  const reopened = boot(game.storage);
  const id = 'otherworld-peeluna';
  const record = () => reopened.state().codex.monsters['isekai:' + id];
  assert.equal(reopened.state().isekai.pendingBossId, id);
  assert.equal(reopened.state().lastAutoRun.completed, 0);
  assert.equal(reopened.state().battleCount, 0);
  assert.equal(record().sightings, 1);
  assert.equal(record().battles, 0);

  reopened.click({ isekaifight: '1' });
  assert.equal(reopened.state().isekai.pendingBossId, null);
  assert.equal(reopened.state().battleCount, 1);
  assert.equal(record().sightings, 1);
  assert.equal(record().battles, 1);
  assert.equal(reopened.state().isekai.battleRecords[0].name, '異世界に迷い込んだぴーるな');
});
