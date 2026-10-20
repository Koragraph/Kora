// Starter roster + Kora + names + hire helpers (docs/bots/SPEC.md "Starter roster").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, resetHome, tempHome } from './testkit-team';
tempHome('tpl-');

import { BlobStore } from './store';
import { blobHome } from './home';
import { CHIEF_SOUL } from './chief';
import { FUNNY_NAMES, KORA_SOUL, KORA_SPEC, STARTERS, getTemplate, hireFromDraft, hireTemplate, koraTemplate, listTemplates, suggestName, upgradeKoraSoul, validateDraft, normalizeOutfitItem, outfitWithArt, refreshStarterSouls, soulHash, LEGACY_SOUL_HASHES, TEMPLATE_VERSION } from './templates';

const SPEC_ROSTER: Array<[string, string, { head?: string; face?: string; neck?: string }]> = [
  ['Popo', 'Researcher', { face: 'round-glasses' }], ['Bobble', 'Inbox', { head: 'headphones' }], ['Dimp', 'Planner', { head: 'cap' }],
  ['Junip', 'Writer', { head: 'beret' }], ['Wobbo', 'Analyst', { face: 'monocle' }], ['Tibbo', 'Briefing', { head: 'top-hat' }],
  ['Mibble', 'Shopper', { face: 'sunglasses' }], ['Zonk', 'Traveller', { head: 'beanie' }], ['Plonk', 'Builder', { face: 'square-glasses' }], ['Fizzle', 'Social', { head: 'flower' }],
];

test('the ten starters match the SPEC roster exactly (names, jobs, outfits) and are complete', () => {
  const t = listTemplates();
  assert.equal(t.length, 10);
  assert.deepEqual(t.map((x) => [x.draft.name, x.draft.title]), SPEC_ROSTER.map(([n, ti]) => [n, ti]));
  assert.equal(new Set(t.map((x) => x.id)).size, 10);
  assert.equal(new Set(t.map((x) => x.draft.name.toLowerCase())).size, 10);
  for (const [i, [, , o]] of SPEC_ROSTER.entries()) {
    assert.deepEqual(t[i].draft.outfit, { head: o.head ?? null, face: o.face ?? null, neck: o.neck ?? null }, t[i].draft.name);
  }
  for (const x of t) {
    assert.equal(x.draft.permission, 'auto');
    assert.equal(x.draft.engine, null, 'best installed engine at hire time');
    assert.equal(x.draft.howItWorks.length, 3);
    assert.equal(x.exampleAsks.length, 3);
    assert.ok(x.draft.job.length > 10);
    assert.ok(x.blurb.length > 10);
    assert.deepEqual(validateDraft(x.draft), [], x.draft.name);
    assert.ok(x.draft.soul.length > 1500 && x.draft.soul.length < 6000, `${x.draft.name} soul length ${x.draft.soul.length}`);
    assert.ok(!x.draft.soul.includes('`'), 'no backticks in SOULs');
    for (const ask of x.exampleAsks) assert.ok(x.draft.soul.includes(ask), `${x.draft.name}: example ask "${ask}" is in the SOUL`);
    assert.match(x.draft.soul, new RegExp(`You are ${x.draft.name}`));
    assert.match(x.draft.soul, /Things people ask you/);
    assert.match(x.draft.soul, /Apps you want/);
    assert.match(x.draft.soul, /Suggested routine/);
    for (const r of x.draft.routines) assert.ok(r.title && r.cadence);
  }
});

test('SOULs carry the concrete working method the SPEC calls for', () => {
  const soul = (id: string) => getTemplate(id)!.draft.soul;
  assert.match(soul('popo'), /cite/i); assert.match(soul('popo'), /outputs\//);
  assert.match(soul('wobbo'), /spreadsheet skill/); assert.match(soul('wobbo'), /blob-tools xlsx/);
  assert.match(soul('bobble'), /Never send/i);
  assert.match(soul('mibble'), /never buy|never spend/i);
  assert.match(soul('zonk'), /never book|never book, reserve/i);
  assert.match(soul('fizzle'), /never, ever post|always asks first/i);
  assert.match(soul('plonk'), /dry run/); assert.match(soul('plonk'), /Code surface/);
  assert.match(soul('tibbo'), /8:00/);
  assert.deepEqual(getTemplate('tibbo')!.draft.routines.map((r) => r.title), ['Morning brief']);
});

test('Kora: crown + bow tie, Chief role text, never hireable', () => {
  const k = koraTemplate();
  assert.equal(k.draft.name, 'Kora');
  assert.deepEqual(k.draft.outfit, { head: 'crown', face: null, neck: 'bow-tie' });
  assert.ok(!listTemplates().some((x) => x.id === 'kora'));
  assert.equal(getTemplate('kora'), null);
  for (const must of ['plan_job', 'delegate_to', 'wait_for', 'propose_blob', 'never create', 'Hire', 'question cards', 'Popo is the best fit', 'self-contained', 'two blobs never edit the same file']) {
    assert.ok(KORA_SOUL.toLowerCase().includes(must.toLowerCase()), `Kora SOUL mentions "${must}"`);
  }
  assert.ok(!KORA_SOUL.includes('`'));
  assert.equal(KORA_SPEC.soul, KORA_SOUL);
  // only Kora may wear the crown
  assert.ok(validateDraft({ ...getTemplate('popo')!.draft, outfit: { head: 'crown', face: null, neck: null } }).some((p) => /crown/.test(p)));
});

test('funny names: 60+, unique, plain, none collide with the starters; suggestName avoids taken names', () => {
  assert.ok(FUNNY_NAMES.length >= 60);
  assert.equal(new Set(FUNNY_NAMES.map((n) => n.toLowerCase())).size, FUNNY_NAMES.length);
  const reserved = new Set([...STARTERS.map((s) => s.name.toLowerCase()), 'kora']);
  for (const n of FUNNY_NAMES) { assert.match(n, /^[A-Z][a-z]{2,9}$/, n); assert.ok(!reserved.has(n.toLowerCase())); }
  for (const n of ['Tiki', 'Zibbo', 'Wumpy']) assert.ok(FUNNY_NAMES.includes(n));
  const taken = FUNNY_NAMES.slice(1);
  assert.equal(suggestName(taken, () => 0), FUNNY_NAMES[0]);
  assert.match(suggestName(FUNNY_NAMES, () => 0), /^Tiki 2$/);
  assert.ok(!['popo', 'kora'].includes(suggestName([], () => 0.5).toLowerCase()));
});

test('hire: creates with the best engine + routines paused; second hire refused; archived is rehired; Kora SOUL upgrade only when unedited', () => {
  resetHome();
  const store = new BlobStore();
  const ctx = { defaultEngine: ENGINE };
  const r = hireTemplate(store, 'tibbo', ctx);
  assert.ok('profile' in r && !r.rehired);
  const z = (r as any).profile;
  assert.equal(z.name, 'Tibbo'); assert.equal(z.templateId, 'tibbo'); assert.deepEqual(z.outfit, { head: 'top-hat', face: null, neck: null }); assert.deepEqual(z.engine, ENGINE);
  assert.equal(store.soul(z.id), getTemplate('tibbo')!.draft.soul.trim());
  const routines = JSON.parse(fs.readFileSync(path.join(blobHome(z.id), 'routines.json'), 'utf8'));
  assert.equal(routines.routines[0].paused, true);
  assert.deepEqual(hireTemplate(store, 'tibbo', ctx), { error: 'Tibbo is already on the team' });
  assert.deepEqual(hireTemplate(store, 'nope', ctx), { error: 'no starter template "nope"' });
  store.archive(z.id);
  const back = hireTemplate(store, 'tibbo', ctx) as any;
  assert.equal(back.rehired, true); assert.equal(back.profile.id, z.id);
  // custom draft path used by Hire on a proposal
  const custom = hireFromDraft(store, { ...getTemplate('fizzle')!.draft, name: 'Tiki', templateId: null, outfit: { head: 'beanie', face: null, neck: null } }, ctx);
  assert.equal(custom.name, 'Tiki');
  // Kora SOUL upgrade
  const kora = store.ensureKora(ENGINE, CHIEF_SOUL);
  assert.equal(upgradeKoraSoul(store, kora.id), true);
  assert.equal(store.soul(kora.id), KORA_SOUL);
  store.writeSoul(kora.id, 'Edited by the user.');
  assert.equal(upgradeKoraSoul(store, kora.id), false);
  assert.equal(store.soul(kora.id), 'Edited by the user.');
});

test('refreshStarterSouls: an unchanged old template SOUL moves to the current one; an edited SOUL is never touched; idempotent', () => {
  resetHome();
  const store = new BlobStore();
  const OLD = 'You are Popo. Put the absolute path in your reply.';
  const legacy = { popo: [soulHash(OLD)] };
  const ctx = { defaultEngine: ENGINE };
  const popo = hireTemplate(store, 'popo', ctx) as any;
  assert.equal(popo.profile.templateVersion, TEMPLATE_VERSION, 'a fresh hire is stamped current');
  // simulate a blob hired before versions existed: old text, no stamp
  store.writeSoul(popo.profile.id, OLD);
  const raw = path.join(blobHome(popo.profile.id), 'profile.json');
  const j = JSON.parse(fs.readFileSync(raw, 'utf8')); delete j.templateVersion; fs.writeFileSync(raw, JSON.stringify(j));
  store.load();
  assert.deepEqual(refreshStarterSouls(store, legacy), ['Popo']);
  assert.equal(store.soul(popo.profile.id), getTemplate('popo')!.draft.soul.trim());
  assert.equal(store.get(popo.profile.id)!.templateVersion, TEMPLATE_VERSION);
  assert.deepEqual(refreshStarterSouls(store, legacy), [], 'second run does nothing');
  // a user-edited SOUL from an old blob stays
  const bobble = hireTemplate(store, 'bobble', ctx) as any;
  store.writeSoul(bobble.profile.id, 'My own Bobble rules.');
  const jb = JSON.parse(fs.readFileSync(path.join(blobHome(bobble.profile.id), 'profile.json'), 'utf8')); delete jb.templateVersion;
  fs.writeFileSync(path.join(blobHome(bobble.profile.id), 'profile.json'), JSON.stringify(jb)); store.load();
  assert.deepEqual(refreshStarterSouls(store, { bobble: [soulHash('My own Bobble rules.x')] }), []);
  assert.equal(store.soul(bobble.profile.id), 'My own Bobble rules.');
  assert.equal(store.get(bobble.profile.id)!.templateVersion, TEMPLATE_VERSION, 'examined blobs are stamped so later edits are never compared');
  // shipped legacy list never contains a current text
  for (const s of [...STARTERS, KORA_SPEC]) assert.ok(!(LEGACY_SOUL_HASHES[s.id] ?? []).includes(soulHash(s.soul)), s.id);
});

test('renamed starters: a blob hired as Pintu keeps its name and template id; only its SOUL text is refreshed', () => {
  resetHome();
  const store = new BlobStore();
  const OLD = 'You are Pintu, the team writer. Old rules.';
  const p = store.create({ name: 'Pintu', title: 'Writer', soul: OLD, engine: ENGINE, permission: 'auto', outfit: { head: 'beret', face: null, neck: null }, templateId: 'pintu' });
  const raw = path.join(blobHome(p.id), 'profile.json');
  const j = JSON.parse(fs.readFileSync(raw, 'utf8')); delete j.templateVersion; fs.writeFileSync(raw, JSON.stringify(j));
  store.load();
  assert.deepEqual(refreshStarterSouls(store, { junip: [soulHash(OLD)] }), ['Pintu']);
  const after = store.get(p.id)!;
  assert.equal(after.name, 'Pintu'); assert.equal(after.templateId, 'pintu'); assert.equal(after.templateVersion, TEMPLATE_VERSION);
  assert.match(store.soul(p.id), /You are Pintu, the team's writer/);
  assert.ok(!/\bJunip\b/.test(store.soul(p.id).split('\n')[0]!));
  // old ids and names still resolve; the pre-rename names are not in the funny-name pool
  assert.equal(getTemplate('pintu')!.id, 'junip'); assert.equal(getTemplate('Pip')!.id, 'fizzle');
  for (const n of ['Pintu', 'Gumbo', 'Zuzu', 'Mochi', 'Noodle', 'Bloop', 'Pip', 'Junip', 'Wobbo', 'Tibbo', 'Mibble', 'Zonk', 'Plonk', 'Fizzle']) assert.ok(!FUNNY_NAMES.includes(n), n);
  // a hired-under-the-old-name blob is not offered again as a free starter
  assert.deepEqual(hireTemplate(store, 'pintu', { defaultEngine: ENGINE }, 'Pintu'), { error: 'Pintu is already on the team' });
});

test('outfit ids are limited to ones with sprite art; retired ids become "nothing" and a bare proposal gets one accessory', () => {
  for (const retired of ['moustache', 'Party Hat', 'scarf', 'bow tie', 'eyepatch', 'bandana']) assert.equal(normalizeOutfitItem(retired), null, retired);
  assert.equal(normalizeOutfitItem('Round Glasses'), 'round-glasses');
  assert.equal(normalizeOutfitItem('shades'), 'sunglasses');
  const bare = outfitWithArt({ head: null, face: null, neck: null }, 'Tiki');
  assert.equal([bare.head, bare.face].filter(Boolean).length, 1);
  assert.equal(bare.neck, null);
  assert.deepEqual(outfitWithArt({ head: 'beanie', face: null, neck: 'scarf' }, 'Tiki'), { head: 'beanie', face: null, neck: null });
  assert.deepEqual(outfitWithArt({ head: 'crown', face: null, neck: null }, 'Tiki').head, 'crown');
  const bad = validateDraft({ name: 'X', title: 't', job: 'j', soul: 's', permission: 'auto', outfit: { head: 'party-hat', face: 'moustache', neck: 'scarf' } } as never);
  assert.equal(bad.length, 3);
});
