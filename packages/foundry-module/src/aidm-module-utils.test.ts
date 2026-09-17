/**
 * Board #1724: pure-logic tests for the aidm-module-* tools (aidm-module-utils.ts).
 * The handler tests (aidm-module-handlers.test.ts) run the same rules against an in-memory world.
 */

import { describe, it, expect } from 'vitest';
import {
  AIDM_MODULE_TOOL_NAMES,
  CallJournal,
  adventureDocuments,
  canonicalJson,
  connectedRefusal,
  contentHash,
  embeddedCounts,
  installPlanId,
  isAidmModuleId,
  isPlayStatePath,
  leafValues,
  mergeFields,
  opRoot,
  planModuleInstall,
  planModuleUpdate,
  playFlagCounts,
  sceneInPlayReasons,
  scenePlayBeganReasons,
  sortAdventuresForInstall,
  stampTags,
  summarizeInstallConflicts,
  unchangedSinceBase,
  updatePayload,
  verifyInstallReadBack,
  type SceneFacts,
  type WorldDocInfo,
} from './aidm-module-utils.js';

const MOD = 'aidm-lost-mine-1a2b3c4d';
const ADV = 'advMap0000000001';

const free: WorldDocInfo = {
  exists: false,
  invalid: false,
  name: null,
  module: null,
  adventure: null,
  build: null,
};

function adventure() {
  return {
    _id: ADV,
    name: 'Map',
    folders: [{ _id: 'fold000000000001', name: 'Monsters', type: 'Actor' }],
    actors: [
      {
        _id: 'actor00000000001',
        name: 'Goblin',
        type: 'npc',
        items: [{ _id: 'itm0000000000001', name: 'Scimitar' }],
      },
    ],
    items: [],
    journal: [
      {
        _id: 'jour000000000001',
        name: 'Area 1',
        pages: [{ _id: 'page000000000001' }, { _id: 'page000000000002' }],
      },
    ],
    tables: [],
    macros: [],
    cards: [],
    playlists: [],
    combats: [],
    scenes: [
      {
        _id: 'scene00000000001',
        name: 'Hideout',
        walls: [{ _id: 'wall000000000001', c: [0, 0, 100, 0], ds: 0 }],
        tokens: [
          { _id: 'tok0000000000001', actorId: 'actor00000000001', x: 100, y: 100, hidden: true },
        ],
        regions: [{ _id: 'reg0000000000001', behaviors: [{ _id: 'beh0000000000001' }] }],
      },
    ],
  };
}

function facts(extra: Partial<SceneFacts> = {}): SceneFacts {
  return {
    id: 'scene00000000001',
    name: 'Hideout',
    active: false,
    pc_tokens: [],
    combats: 0,
    viewers: 0,
    play_flags: {
      encounters_started: 0,
      traps_sprung: 0,
      items_taken: 0,
      tokens_with_last_area: 0,
    },
    ...extra,
  };
}

describe('names and ids', () => {
  it('accepts only importer module ids', () => {
    expect(isAidmModuleId(MOD)).toBe(true);
    for (const bad of [
      'aidm-synthetic-core',
      'curse-of-strahd-by-claygolem',
      'aidm-x-1A2B3C4D',
      '',
      null,
      'aidm--12345678x',
    ]) {
      expect(isAidmModuleId(bad)).toBe(false);
    }
  });

  it('names all six tools', () => {
    expect([...AIDM_MODULE_TOOL_NAMES]).toEqual([
      'aidm-module-status',
      'aidm-module-enable',
      'aidm-module-disable',
      'aidm-module-install',
      'aidm-module-update',
      'aidm-module-remove',
    ]);
  });
});

describe('tags and hashes', () => {
  it('stamps module, build and adventure on the document and every embedded document, the hash on the top only', () => {
    const scene = adventure().scenes[0];
    const n = stampTags(scene, 'Scene', { module: MOD, build: 3, adventure: ADV }, 'h1');
    expect(n).toBe(5); // scene, wall, token, region, behavior
    expect(scene.flags.aidm).toEqual({ module: MOD, build: 3, adventure: ADV, hash: 'h1' });
    const beh: any = scene.regions[0]!.behaviors[0];
    expect(beh.flags.aidm).toEqual({ module: MOD, build: 3, adventure: ADV });
    expect((scene.walls[0] as any).flags.aidm.hash).toBeUndefined();
  });

  it('keeps flags other writers own when stamping', () => {
    const d: any = { _id: 'x', flags: { aidm: { area: '3' }, core: { a: 1 } } };
    stampTags(d, 'Scene', { module: MOD, build: 1, adventure: ADV });
    expect(d.flags.aidm.area).toBe('3');
    expect(d.flags.core).toEqual({ a: 1 });
  });

  it('the content hash ignores key order, _stats and the bookkeeping tags, and sees real changes', () => {
    const a = { b: 1, a: [1, 2], _stats: { modifiedTime: 1 }, flags: { aidm: { area: '1' } } };
    const b = {
      a: [1, 2],
      flags: { aidm: { area: '1', build: 9, module: MOD, hash: 'x', adventure: ADV } },
      b: 1,
      _stats: { modifiedTime: 2 },
    };
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash({ ...a, b: 2 })).not.toBe(contentHash(a));
    expect(contentHash({ ...a, a: [2, 1] })).not.toBe(contentHash(a)); // array order matters
    expect(canonicalJson({ z: 1, a: undefined })).toBe('{"z":1}');
  });
});

describe('adventures', () => {
  it('orders core first, then maps by sort, then text', () => {
    const order = sortAdventuresForInstall([
      { id: 't', name: 'text', part: 'journal', sort: 99999999 },
      { id: 'm2', name: 'b', part: 'map', sort: 21001 },
      { id: 'c', name: 'core', part: 'core', sort: 0 },
      { id: 'm1', name: 'a', part: 'map', sort: 9001 },
    ]);
    expect(order.map(o => o.id)).toEqual(['c', 'm1', 'm2', 't']);
  });

  it('lists top-level documents in create order and counts embedded documents by path', () => {
    const docs = adventureDocuments(adventure());
    expect(docs.map(d => d.type)).toEqual(['Folder', 'Actor', 'JournalEntry', 'Scene']);
    expect(embeddedCounts('Scene', adventure().scenes[0])).toEqual({
      walls: 1,
      tokens: 1,
      regions: 1,
      'regions.behaviors': 1,
    });
    expect(embeddedCounts('Actor', adventure().actors[0])).toEqual({ items: 1 });
  });
});

describe('install planning', () => {
  it('a fresh world plans every document for creation', () => {
    const plan = planModuleInstall({
      moduleId: MOD,
      build: 2,
      adventureId: ADV,
      adventureName: 'Map',
      adventureData: adventure(),
      lookup: () => free,
    });
    expect(plan.state).toBe('not_installed');
    expect(plan.create.map(c => c.type)).toEqual(['Folder', 'Actor', 'JournalEntry', 'Scene']);
    expect(plan.counts.documents).toEqual({ Folder: 1, Actor: 1, JournalEntry: 1, Scene: 1 });
    expect(plan.counts.embedded['Scene.regions.behaviors']).toBe(1);
    expect(plan.plan_id).toMatch(/^mi-4-[0-9a-f]{8}$/);
  });

  it('every kind of taken id is a conflict, and conflicts win over everything else', () => {
    const world: Record<string, WorldDocInfo> = {
      'Folder:fold000000000001': { ...free, exists: true, name: 'GM folder' },
      'Actor:actor00000000001': {
        ...free,
        exists: true,
        module: 'aidm-other-book-00000000',
        adventure: 'x',
      },
      'JournalEntry:jour000000000001': {
        ...free,
        exists: true,
        module: MOD,
        adventure: 'otherAdventure01',
      },
      'Scene:scene00000000001': { ...free, invalid: true },
    };
    const plan = planModuleInstall({
      moduleId: MOD,
      build: 2,
      adventureId: ADV,
      adventureName: 'Map',
      adventureData: adventure(),
      lookup: (t, id) => world[`${t}:${id}`] ?? free,
    });
    expect(plan.state).toBe('conflicts');
    expect(plan.create).toEqual([]);
    expect(plan.conflicts.map(c => c.reason)).toEqual([
      'id-taken-untagged',
      'id-taken-other-module',
      'id-taken-other-adventure',
      'id-taken-invalid',
    ]);
    const text = summarizeInstallConflicts(plan.conflicts);
    expect(text).toContain('Nothing was created or changed');
    expect(text).toContain("failed Foundry's data checks");
  });

  it('installed, installed at another build, and partial are told apart', () => {
    const ours = (build: number): WorldDocInfo => ({
      ...free,
      exists: true,
      module: MOD,
      adventure: ADV,
      build,
    });
    const all = planModuleInstall({
      moduleId: MOD,
      build: 2,
      adventureId: ADV,
      adventureName: null,
      adventureData: adventure(),
      lookup: () => ours(2),
    });
    expect(all.state).toBe('installed');
    const older = planModuleInstall({
      moduleId: MOD,
      build: 2,
      adventureId: ADV,
      adventureName: null,
      adventureData: adventure(),
      lookup: () => ours(1),
    });
    expect(older.state).toBe('installed_other_build');
    const partial = planModuleInstall({
      moduleId: MOD,
      build: 2,
      adventureId: ADV,
      adventureName: null,
      adventureData: adventure(),
      lookup: t => (t === 'Scene' ? free : ours(2)),
    });
    expect(partial.state).toBe('partial');
  });

  it('the plan id changes when the world or the build changes, and not otherwise', () => {
    const base = {
      moduleId: MOD,
      adventureId: ADV,
      adventureName: 'Map',
      adventureData: adventure(),
      lookup: () => free,
    };
    const a = planModuleInstall({ ...base, build: 2 });
    expect(planModuleInstall({ ...base, build: 2 }).plan_id).toBe(a.plan_id);
    expect(planModuleInstall({ ...base, build: 3 }).plan_id).not.toBe(a.plan_id);
    const taken = planModuleInstall({
      ...base,
      build: 2,
      lookup: (t: string) => (t === 'Scene' ? { ...free, exists: true } : free),
    });
    expect(taken.plan_id).not.toBe(a.plan_id);
    expect(installPlanId(a)).toBe(a.plan_id);
  });
});

describe('install read-back', () => {
  const tags = { module: MOD, build: 2, adventure: ADV };
  const scene = adventure().scenes[0];
  const good = {
    type: 'Scene',
    id: scene._id,
    present: true,
    invalid: false,
    tags,
    embedded: embeddedCounts('Scene', scene),
    embeddedInvalid: {},
  };

  it('passes only when everything is there, loaded, tagged and counted', () => {
    expect(
      verifyInstallReadBack({
        expected: [{ type: 'Scene', id: scene._id, data: scene }],
        createdIds: [{ type: 'Scene', id: scene._id }],
        readBack: [good],
        tags,
      })
    ).toEqual([]);
  });

  it('an id in invalidDocumentIds is a failure, not a pass', () => {
    const problems = verifyInstallReadBack({
      expected: [{ type: 'Scene', id: scene._id, data: scene }],
      createdIds: [{ type: 'Scene', id: scene._id }],
      readBack: [{ ...good, present: false, invalid: true }],
      tags,
    });
    expect(problems.join(' ')).toContain('invalidDocumentIds');
  });

  it('a dropped embedded document, a bad embedded document, a missing tag or an unreported create each fail', () => {
    const run = (r: any, created = [{ type: 'Scene', id: scene._id }]) =>
      verifyInstallReadBack({
        expected: [{ type: 'Scene', id: scene._id, data: scene }],
        createdIds: created,
        readBack: [r],
        tags,
      });
    expect(run({ ...good, embedded: { ...good.embedded, walls: 0 } }).join(' ')).toContain(
      'walls holds 0, the Adventure has 1'
    );
    expect(run({ ...good, embeddedInvalid: { tokens: 1 } }).join(' ')).toContain(
      "failed Foundry's data checks"
    );
    expect(run({ ...good, tags: { ...tags, build: 1 } }).join(' ')).toContain(
      'tags are missing or wrong'
    );
    expect(run(good, []).join(' ')).toContain('did not report it as created');
    expect(run({ ...good, present: false }).join(' ')).toContain('not in the world');
  });
});

describe('in play and play began', () => {
  it('a scene is in play when active, with a PC token, a combat or a connected viewer; unreadable counts as in play', () => {
    expect(sceneInPlayReasons(facts())).toEqual([]);
    expect(sceneInPlayReasons(facts({ active: true }))).toEqual(['it is the active scene']);
    expect(sceneInPlayReasons(facts({ pc_tokens: ['Ada'] }))[0]).toContain('Ada');
    expect(sceneInPlayReasons(facts({ combats: 1 }))[0]).toContain('combat');
    expect(sceneInPlayReasons(facts({ viewers: 2 }))[0]).toContain('looking at it');
    const unknown = sceneInPlayReasons(
      facts({ active: null, pc_tokens: null, combats: null, viewers: null })
    );
    expect(unknown).toHaveLength(4);
    expect(unknown.every(r => r.startsWith('could not read'))).toBe(true);
  });

  it('play began also when the brain already wrote play state, or the caller says so', () => {
    expect(scenePlayBeganReasons(facts())).toEqual([]);
    expect(
      scenePlayBeganReasons(
        facts({
          play_flags: {
            encounters_started: 1,
            traps_sprung: 0,
            items_taken: 0,
            tokens_with_last_area: 0,
          },
        })
      )
    ).toEqual(['1 encounter(s) started']);
    expect(scenePlayBeganReasons(facts(), true)).toEqual(['the caller said play has begun on it']);
    expect(scenePlayBeganReasons(facts({ play_flags: null }))[0]).toContain('could not read');
  });

  it('counts play-state flags on scene data', () => {
    const counts = playFlagCounts({
      regions: [
        {
          flags: {
            aidm: {
              encounter: [{ started: true }, { started: false }],
              trap: [{ sprung: true }],
              itemsTaken: ['key'],
            },
          },
        },
        { flags: { aidm: { hazard: [{ sprung: true }] } } },
      ],
      tokens: [{ flags: { aidm: { lastArea: '2' } } }, { flags: {} }],
    });
    expect(counts).toEqual({
      encounters_started: 1,
      traps_sprung: 2,
      items_taken: 1,
      tokens_with_last_area: 1,
    });
  });

  it('the connected rule refuses unless nobody else is PROVABLY connected', () => {
    expect(connectedRefusal([])).toBeNull();
    expect(connectedRefusal(['Ada'])).toContain('1 other user(s) are connected');
    expect(connectedRefusal(null)).toContain('could not read who is connected');
  });
});

describe('three-way merge of fields', () => {
  it('writes an importer change nobody touched, keeps a GM edit, leaves unchanged paths alone', () => {
    const base = { name: 'Room', grid: { size: 50, distance: 5 }, padding: 0.25 };
    const target = { name: 'Room (fixed)', grid: { size: 36, distance: 5 }, padding: 0.25 };
    const world = { name: 'GM renamed', grid: { size: 50, distance: 10 }, padding: 0.25 };
    const m = mergeFields({ documentName: 'Scene', base, target, world, playBegan: false });
    expect(m.set).toEqual({ 'grid.size': 36 });
    expect(m.kept).toEqual([{ path: 'name', reason: 'changed since the import' }]);
    expect(m.unset).toEqual([]);
  });

  it('removes a path the new build dropped only when the world still holds the old value', () => {
    const m = mergeFields({
      documentName: 'Wall',
      base: { flags: { aidm: { lockDC: 15, detectDC: 12 } } },
      target: { flags: { aidm: {} } },
      world: { flags: { aidm: { lockDC: 15, detectDC: 20 } } },
      playBegan: false,
    });
    expect(m.unset).toEqual(['flags.aidm.lockDC']);
    expect(m.kept.map(k => k.path)).toEqual(['flags.aidm.detectDC']);
  });

  it('never writes play state: door state and token position after play began; hit points and itemsTaken always', () => {
    const wall = mergeFields({
      documentName: 'Wall',
      base: { ds: 0, c: [0, 0, 1, 1] },
      target: { ds: 2, c: [0, 0, 2, 2] },
      world: { ds: 0, c: [0, 0, 1, 1] },
      playBegan: true,
    });
    expect(wall.set).toEqual({ c: [0, 0, 2, 2] });
    expect(wall.protected.map(p => p.path)).toEqual(['ds']);
    const before = mergeFields({
      documentName: 'Wall',
      base: { ds: 0 },
      target: { ds: 2 },
      world: { ds: 0 },
      playBegan: false,
    });
    expect(before.set).toEqual({ ds: 2 }); // before play the door state is the importer's

    const token = mergeFields({
      documentName: 'Token',
      base: { x: 10, y: 10, name: 'G' },
      target: { x: 20, y: 20, name: 'Goblin' },
      world: { x: 10, y: 10, name: 'G' },
      playBegan: true,
    });
    expect(token.set).toEqual({ name: 'Goblin' });
    expect(token.protected.map(p => p.path).sort()).toEqual(['x', 'y']);

    const actor = mergeFields({
      documentName: 'Actor',
      base: { system: { attributes: { hp: { value: 7, max: 7 } } } },
      target: { system: { attributes: { hp: { value: 11, max: 11 } } } },
      world: { system: { attributes: { hp: { value: 7, max: 7 } } } },
      playBegan: false,
    });
    expect(actor.set).toEqual({ 'system.attributes.hp.max': 11 });
    expect(actor.protected.map(p => p.path)).toEqual(['system.attributes.hp.value']);

    expect(isPlayStatePath('Region', 'flags.aidm.itemsTaken', false)).toBe(true);
    expect(isPlayStatePath('Token', 'delta.system.attributes.hp.value', false)).toBe(true);
    expect(isPlayStatePath('Scene', 'active', false)).toBe(true);
  });

  it('encounter records: started is never overwritten, a started encounter is kept whole, the rest merge', () => {
    const base = {
      flags: {
        aidm: {
          encounter: [
            { monsters: [{ name: 'Goblin', count: 2 }], started: false },
            { monsters: [{ name: 'Wolf', count: 1 }], started: false },
          ],
        },
      },
    };
    const target = {
      flags: {
        aidm: {
          encounter: [
            { monsters: [{ name: 'Goblin', count: 3 }], started: false },
            { monsters: [{ name: 'Wolf', count: 2 }], started: false },
          ],
        },
      },
    };
    const world = {
      flags: {
        aidm: {
          encounter: [
            { monsters: [{ name: 'Goblin', count: 2 }], started: true },
            { monsters: [{ name: 'Wolf', count: 1 }], started: false },
          ],
        },
      },
    };
    const m = mergeFields({ documentName: 'Region', base, target, world, playBegan: false });
    expect(m.set['flags.aidm.encounter']).toEqual([
      { monsters: [{ name: 'Goblin', count: 2 }], started: true },
      { monsters: [{ name: 'Wolf', count: 2 }], started: false },
    ]);
    expect(m.protected.map(p => p.path)).toEqual(['flags.aidm.encounter.0']);
  });

  it('a GM edit to an encounter record keeps the whole record list', () => {
    const base = { flags: { aidm: { encounter: [{ trigger: 'on_enter' }] } } };
    const m = mergeFields({
      documentName: 'Region',
      base,
      target: { flags: { aidm: { encounter: [{ trigger: 'on_search' }] } } },
      world: { flags: { aidm: { encounter: [{ trigger: 'scripted' }] } } },
      playBegan: false,
    });
    expect(m.set).toEqual({});
    expect(m.kept.map(k => k.path)).toEqual(['flags.aidm.encounter']);
  });

  it('with no base, only paths the world lacks are written', () => {
    const m = mergeFields({
      documentName: 'Scene',
      base: null,
      target: { a: 1, b: 2 },
      world: { a: 5 },
      playBegan: false,
    });
    expect(m.set).toEqual({ b: 2 });
    expect(m.kept).toEqual([{ path: 'a', reason: 'no earlier build to compare with' }]);
  });

  it('never sends a delete and a write for the same object', () => {
    const m = mergeFields({
      documentName: 'Scene',
      base: { flags: { x: {} } },
      target: { flags: { x: { a: 1 } } },
      world: { flags: { x: {} } },
      playBegan: false,
    });
    expect(m.set).toEqual({ 'flags.x.a': 1 });
    expect(m.unset).toEqual([]);
  });

  it('leaf values skip _id, _stats, bookkeeping tags and embedded collections', () => {
    const leaves = leafValues('Scene', {
      _id: 'x',
      _stats: { a: 1 },
      walls: [1],
      name: 'n',
      flags: { aidm: { build: 1, module: MOD, area: '1' } },
    });
    expect([...leaves.keys()].sort()).toEqual(['flags.aidm.area', 'name']);
  });

  it('unchangedSinceBase looks at embedded documents too', () => {
    const base = { name: 'A', walls: [{ _id: 'w1', c: [0, 0, 1, 1] }] };
    expect(
      unchangedSinceBase('Scene', base, {
        name: 'A',
        walls: [{ _id: 'w1', c: [0, 0, 1, 1], flags: { aidm: { build: 1 } } }],
      })
    ).toBe(true);
    expect(
      unchangedSinceBase('Scene', base, { name: 'A', walls: [{ _id: 'w1', c: [0, 0, 1, 2] }] })
    ).toBe(false);
    expect(unchangedSinceBase('Scene', base, { name: 'A', walls: [] })).toBe(false);
    expect(
      unchangedSinceBase('Scene', base, {
        name: 'A',
        note: 'GM',
        walls: [{ _id: 'w1', c: [0, 0, 1, 1] }],
      })
    ).toBe(false);
  });

  it('builds the Foundry update payload with deletion keys and the build tag', () => {
    const payload = updatePayload(
      {
        action: 'update',
        type: 'Wall',
        id: 'w1',
        parent: null,
        field: null,
        set: { c: [1, 2, 3, 4] },
        unset: ['flags.aidm.lockDC', 'top'],
        bump_only: false,
        hash: 'abc',
      },
      { build: 4 }
    );
    expect(payload).toEqual({
      _id: 'w1',
      c: [1, 2, 3, 4],
      'flags.aidm.-=lockDC': null,
      '-=top': null,
      'flags.aidm.build': 4,
      'flags.aidm.hash': 'abc',
    });
  });
});

describe('update planning', () => {
  const tag = (doc: any, build: number, hash?: string) => {
    const d = JSON.parse(JSON.stringify(doc));
    stampTags(d, 'Scene', { module: MOD, build, adventure: ADV }, hash ?? null);
    return d;
  };
  const sceneOf = (a: any) => a.scenes[0];
  const onlyScene = (scene: any) => ({ _id: ADV, scenes: [scene] });

  function world(scene: any) {
    return new Map([[`Scene:${scene._id}`, scene]]);
  }

  it('merges a scene: new wall created, dropped wall deleted, GM-deleted wall stays deleted, GM wall untouched, GM edit kept', () => {
    const base = sceneOf(adventure());
    base.walls.push(
      { _id: 'wall000000000002', c: [5, 5, 6, 6], ds: 0 },
      { _id: 'wall000000000003', c: [7, 7, 8, 8], ds: 0 }
    );
    const target = JSON.parse(JSON.stringify(base));
    target.name = 'Hideout v2';
    target.walls = target.walls.filter((w: any) => w._id !== 'wall000000000002'); // dropped by the importer
    target.walls[0].c = [0, 0, 120, 0]; // moved by the importer
    target.walls.push({ _id: 'wall000000000009', c: [9, 9, 10, 10], ds: 0 }); // new
    const w = tag(base, 1, contentHash(base));
    w.walls = w.walls.filter((x: any) => x._id !== 'wall000000000003'); // a GM deleted it
    w.walls.push({ _id: 'gmWall0000000001', c: [1, 1, 2, 2] }); // a GM added it (no tags)
    w.tokens[0].name = 'Boss goblin'; // a GM edit on an importer token
    const plan = planModuleUpdate({
      moduleId: MOD,
      adventureId: ADV,
      baseBuild: 1,
      targetBuild: 2,
      base: onlyScene(base),
      target: onlyScene(target),
      world: world(w),
      invalid: new Set(),
      sceneFacts: new Map([[base._id, facts()]]),
    });
    const ops = plan.ops.map(o => `${o.action}:${o.type}:${o.id}`);
    expect(ops).toContain('update:Scene:scene00000000001');
    expect(ops).toContain('update:Wall:wall000000000001');
    expect(ops).toContain('delete:Wall:wall000000000002');
    expect(ops).toContain('create:Wall:wall000000000009');
    expect(ops.some(o => o.includes('gmWall'))).toBe(false);
    expect(ops.some(o => o.includes('wall000000000003'))).toBe(false);
    expect(plan.kept.find(k => k.id === 'wall000000000003')!.reason).toContain('stays deleted');
    const sceneOp: any = plan.ops.find(o => o.type === 'Scene');
    expect(sceneOp.set).toEqual({ name: 'Hideout v2' });
    expect(sceneOp.hash).toBe(contentHash(target));
    expect(plan.plan_id).toMatch(/^mu-\d+-[0-9a-f]{8}$/);
  });

  it('skips a scene in play right now, whole', () => {
    const base = sceneOf(adventure());
    const target = { ...JSON.parse(JSON.stringify(base)), name: 'changed' };
    const plan = planModuleUpdate({
      moduleId: MOD,
      adventureId: ADV,
      baseBuild: 1,
      targetBuild: 2,
      base: onlyScene(base),
      target: onlyScene(target),
      world: world(tag(base, 1)),
      invalid: new Set(),
      sceneFacts: new Map([[base._id, facts({ active: true })]]),
    });
    expect(plan.ops).toEqual([]);
    expect(plan.skipped[0]!.reason).toContain('in play right now');
    expect(plan.in_play[0]!.scene_id).toBe(base._id);
  });

  it('after play began, tokens are neither placed nor removed, and door states and positions stay', () => {
    const base = sceneOf(adventure());
    const target = JSON.parse(JSON.stringify(base));
    target.tokens = [{ _id: 'tok0000000000002', actorId: 'actor00000000001', x: 1, y: 1 }];
    target.walls[0].ds = 2;
    const plan = planModuleUpdate({
      moduleId: MOD,
      adventureId: ADV,
      baseBuild: 1,
      targetBuild: 2,
      base: onlyScene(base),
      target: onlyScene(target),
      world: world(tag(base, 1)),
      invalid: new Set(),
      sceneFacts: new Map([
        [
          base._id,
          facts({
            play_flags: {
              encounters_started: 1,
              traps_sprung: 0,
              items_taken: 0,
              tokens_with_last_area: 0,
            },
          }),
        ],
      ]),
    });
    expect(plan.ops.filter(o => o.type === 'Token')).toEqual([]);
    expect(plan.ops.filter(o => o.type === 'Wall')).toEqual([]);
    expect(plan.protected.map(p => `${p.type}:${p.id}:${p.path ?? ''}`).sort()).toEqual([
      'Token:tok0000000000001:',
      'Token:tok0000000000002:',
      'Wall:wall000000000001:ds',
    ]);
    expect(plan.play_began[0]!.reasons).toEqual(['1 encounter(s) started']);
  });

  it('skips documents at an unexpected build, with a different content hash, or made by someone else', () => {
    const base = sceneOf(adventure());
    const target = { ...JSON.parse(JSON.stringify(base)), name: 'changed' };
    const run = (w: any, accept = false) =>
      planModuleUpdate({
        moduleId: MOD,
        adventureId: ADV,
        baseBuild: 1,
        targetBuild: 2,
        base: onlyScene(base),
        target: onlyScene(target),
        world: world(w),
        invalid: new Set(),
        sceneFacts: new Map([[base._id, facts()]]),
        acceptBaseMismatch: accept,
      });
    expect(run(tag(base, 5)).skipped[0]!.reason).toContain('build 5');
    expect(run(tag(base, 1, 'not-the-hash')).skipped[0]!.reason).toContain('content hash differs');
    expect(run(tag(base, 1, 'not-the-hash'), true).ops.length).toBeGreaterThan(0);
    const untagged = JSON.parse(JSON.stringify(base));
    expect(run(untagged).skipped[0]!.reason).toContain('did not make');
  });

  it('creates a document only the new build has, and deletes one it dropped only when unchanged', () => {
    const baseA = adventure();
    const targetA = adventure();
    targetA.journal = [];
    targetA.items = [{ _id: 'newItem000000001', name: 'Key' } as any];
    const journalWorld = JSON.parse(JSON.stringify(baseA.journal[0]));
    stampTags(journalWorld, 'JournalEntry', { module: MOD, build: 1, adventure: ADV });
    const plan = planModuleUpdate({
      moduleId: MOD,
      adventureId: ADV,
      baseBuild: 1,
      targetBuild: 2,
      base: { _id: ADV, journal: baseA.journal, items: [] },
      target: { _id: ADV, journal: [], items: targetA.items },
      world: new Map([['JournalEntry:jour000000000001', journalWorld]]),
      invalid: new Set(),
      sceneFacts: new Map(),
    });
    expect(plan.ops.map(o => `${o.action}:${o.type}`)).toEqual([
      'create:Item',
      'delete:JournalEntry',
    ]);
    journalWorld.name = 'GM notes';
    const edited = planModuleUpdate({
      moduleId: MOD,
      adventureId: ADV,
      baseBuild: 1,
      targetBuild: 2,
      base: { _id: ADV, journal: baseA.journal },
      target: { _id: ADV, journal: [] },
      world: new Map([['JournalEntry:jour000000000001', journalWorld]]),
      invalid: new Set(),
      sceneFacts: new Map(),
    });
    expect(edited.ops).toEqual([]);
    expect(edited.kept[0]!.reason).toContain('changed since the import');
  });

  it('opRoot finds the top-level document of an embedded op', () => {
    const scene = { type: 'Scene', id: 's', field: null, parent: null };
    const region = { type: 'Region', id: 'r', field: 'regions', parent: scene };
    expect(
      opRoot({
        action: 'delete',
        type: 'RegionBehavior',
        id: 'b',
        parent: region,
        field: 'behaviors',
      })
    ).toEqual({ type: 'Scene', id: 's' });
    expect(opRoot({ action: 'delete', type: 'Actor', id: 'a', parent: null, field: null })).toEqual(
      { type: 'Actor', id: 'a' }
    );
  });
});

describe('call journal', () => {
  it('records queued, running and done calls, newest last, capped', () => {
    let t = 0;
    const j = new CallJournal(3, () => ++t);
    const a = j.queue('a', 'aidm-module-install', MOD, ADV);
    expect(j.get('a')!.state).toBe('queued');
    j.start(a);
    expect(j.get('a')!.state).toBe('running');
    j.finish(a, { success: true, changed: true, mode: 'apply' });
    expect(j.get('a')!.result).toEqual({
      success: true,
      changed: true,
      error: null,
      mode: 'apply',
    });
    for (const id of ['b', 'c', 'd']) j.queue(id, 'aidm-module-status', MOD, null);
    expect(j.get('a')).toBeUndefined();
    expect(j.forModule(MOD).map(r => r.call_id)).toEqual(['b', 'c', 'd']);
  });
});
