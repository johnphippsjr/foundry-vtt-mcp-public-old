/**
 * Board #1724: handler-level tests for the aidm-module-* tools.
 *
 * They run the REAL QueryHandlers (queries.ts) and AidmModuleHandlers against an in-memory Foundry
 * world. As in adventure-import-handler.test.ts, the Adventure class's prepareImport and
 * importContent bodies are copied word for word from the live Foundry 13.351 client
 * (foundry.mjs lines 41964-41995 and 42000-42033, read from the dnd-dm foundry pod on 2026-09-16),
 * so the import decisions exercised here are Foundry's own code. The fake document classes model
 * the 13.351 server: a keepId create over a stored id is accepted and recorded as a replacement,
 * never refused, so no test can pass on a refusal the real server would not give.
 *
 * What this does NOT prove: that a live Foundry accepts an offline-packed module, that the module
 * setting plus reload works headless and gmhost reconnects, that a call fits the 60 s bridge limit,
 * or how Foundry's own data cleaning affects the update's content hash. Those need the gate world.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./data-access.js', () => ({ FoundryDataAccess: class {} }));
vi.mock('./comfyui-manager.js', () => ({ ComfyUIManager: class {} }));

import { QueryHandlers } from './queries.js';
import { EMBEDDED_FIELDS, contentHash } from './aidm-module-utils.js';

// ---------------------------------------------------------------------------------------------
// Foundry 13.351 helper, copied from foundry.mjs line 1995 (installed as Array#partition there).
function partition(this: any[], rule: (v: any) => boolean) {
  return this.reduce(
    (acc: any[][], val: any) => {
      const test = rule(val);
      acc[Number(test)]!.push(val);
      return acc;
    },
    [[], []]
  );
}
if (!(Array.prototype as any).partition) {
  Object.defineProperty(Array.prototype, 'partition', { value: partition, configurable: true });
}

declare const game: any;
declare const ui: any;
declare const CONFIG: any;

// ---------------------------------------------------------------------------------------------
// In-memory world

type Call = {
  op: string;
  documentName: string;
  ids: string[];
  parent?: string;
  replaced?: string[];
  data?: any;
};
let calls: Call[] = [];
let idCounter = 0;
const newId = () => `gen${String(++idCounter).padStart(13, '0')}`;

class FakeCollection extends Map<string, any> {
  stored = new Map<string, any>();
  invalidDocumentIds = new Set<string>();
  get contents() {
    return [...this.values()];
  }
  override [Symbol.iterator](): any {
    return this.values();
  }
}

const invalidEmbedded = new WeakMap<object, Record<string, Set<string>>>();
function invalidSet(source: any, field: string): Set<string> {
  const rec = invalidEmbedded.get(source) ?? {};
  rec[field] ??= new Set();
  invalidEmbedded.set(source, rec);
  return rec[field]!;
}

function applyChanges(source: any, changes: any) {
  for (const [key, value] of Object.entries(changes)) {
    if (key === '_id') continue;
    const parts = key.split('.');
    const last = parts.pop()!;
    let obj = source;
    for (const p of parts) {
      if (!obj[p] || typeof obj[p] !== 'object') obj[p] = {};
      obj = obj[p];
    }
    if (last.startsWith('-=')) delete obj[last.slice(2)];
    else obj[last] = structuredClone(value);
  }
}

function fieldFor(parentName: string, childName: string): string {
  const hit = Object.entries(EMBEDDED_FIELDS[parentName] ?? {}).find(([, n]) => n === childName);
  if (!hit) throw new Error(`${childName} cannot be embedded in ${parentName}`);
  return hit[0];
}

function makeDoc(documentName: string, source: any): any {
  const doc: any = {
    documentName,
    _source: source,
    get id() {
      return this._source._id;
    },
    get name() {
      return this._source.name;
    },
    get flags() {
      return this._source.flags ?? {};
    },
    get type() {
      return this._source.type;
    },
    get active() {
      return !!this._source.active;
    },
    get actorId() {
      return this._source.actorId;
    },
    get actor() {
      return this._source.actorId ? game.actors.get(this._source.actorId) : null;
    },
    get folder() {
      return this._source.folder ? (game.folders.get(this._source.folder) ?? null) : null;
    },
    get _stats() {
      return this._source._stats ?? {};
    },
    toObject() {
      return structuredClone(this._source);
    },
    async createEmbeddedDocuments(childName: string, datas: any[], options: any = {}) {
      const field = fieldFor(documentName, childName);
      this._source[field] ??= [];
      calls.push({
        op: 'createEmbedded',
        documentName: childName,
        ids: datas.map(d => d._id),
        parent: this.id,
      });
      return datas.map(d => {
        const id = options.keepId && d._id ? d._id : newId();
        if (this._source[field].some((e: any) => e._id === id))
          throw new Error(`duplicate embedded id ${id}`);
        const src = { ...structuredClone(d), _id: id };
        this._source[field].push(src);
        return makeDoc(childName, src);
      });
    },
    async updateEmbeddedDocuments(childName: string, updates: any[]) {
      const field = fieldFor(documentName, childName);
      if ((doc as any).failEmbeddedUpdate?.has(childName))
        throw new Error(`${childName} update failed (socket closed)`);
      calls.push({
        op: 'updateEmbedded',
        documentName: childName,
        ids: updates.map(u => u._id),
        parent: this.id,
        data: structuredClone(updates),
      });
      for (const u of updates) {
        const src = (this._source[field] ?? []).find((e: any) => e._id === u._id);
        if (!src) throw new Error(`${childName} ${u._id} does not exist`);
        applyChanges(src, u);
      }
      return updates;
    },
    async deleteEmbeddedDocuments(childName: string, ids: string[]) {
      const field = fieldFor(documentName, childName);
      calls.push({ op: 'deleteEmbedded', documentName: childName, ids: [...ids], parent: this.id });
      for (const id of ids) {
        if (!(this._source[field] ?? []).some((e: any) => e._id === id))
          throw new Error(`${childName} ${id} does not exist`);
      }
      this._source[field] = this._source[field].filter((e: any) => !ids.includes(e._id));
      return ids;
    },
  };
  for (const [field, childName] of Object.entries(EMBEDDED_FIELDS[documentName] ?? {})) {
    Object.defineProperty(doc, field, {
      get() {
        const coll = new FakeCollection();
        const bad = invalidSet(this._source, field);
        coll.invalidDocumentIds = bad;
        for (const src of this._source[field] ?? []) {
          if (!bad.has(src._id)) coll.set(src._id, makeDoc(childName, src));
        }
        return coll;
      },
      configurable: true,
    });
  }
  return doc;
}

function makeDocClass(documentName: string, collection: FakeCollection) {
  const Cls: any = class {
    static documentName = documentName;
    static invalidOnCreate = new Set<string>();
    static dropEmbeddedOnCreate: { field: string; id: string } | null = null;
    static invalidEmbeddedOnCreate: { field: string; id: string } | null = null;
    static database = {
      async get(_cls: any, operation: any) {
        const id = operation?.query?._id;
        return collection.stored.has(id) ? [structuredClone(collection.stored.get(id))] : [];
      },
    };
    static async createDocuments(data: any[], options: any = {}) {
      const replaced: string[] = [];
      const docs = data.map(d => {
        const id = options.keepId && d._id ? d._id : newId();
        if (collection.stored.has(id)) replaced.push(id);
        const src = { ...structuredClone(d), _id: id };
        if (Cls.dropEmbeddedOnCreate) {
          const { field, id: drop } = Cls.dropEmbeddedOnCreate;
          src[field] = (src[field] ?? []).filter((e: any) => e._id !== drop);
        }
        const doc = makeDoc(documentName, src);
        if (Cls.invalidEmbeddedOnCreate)
          invalidSet(src, Cls.invalidEmbeddedOnCreate.field).add(Cls.invalidEmbeddedOnCreate.id);
        collection.stored.set(id, src);
        if (Cls.invalidOnCreate.has(id)) collection.invalidDocumentIds.add(id);
        else collection.set(id, doc);
        return doc;
      });
      calls.push({ op: 'create', documentName, ids: data.map(d => d._id), replaced });
      if (Cls.failAfterCreate) throw new Error(`${documentName} create failed after save`);
      return docs;
    }
    static failAfterCreate = false;
    static async updateDocuments(updates: any[]) {
      if (Cls.failUpdate) throw new Error(`${documentName} update failed (socket closed)`);
      calls.push({
        op: 'update',
        documentName,
        ids: updates.map(u => u._id),
        data: structuredClone(updates),
      });
      for (const u of updates) {
        const doc = collection.get(u._id);
        if (!doc) throw new Error(`${documentName} ${u._id} does not exist`);
        applyChanges(doc._source, u);
      }
      return updates;
    }
    static failUpdate = false;
    static async deleteDocuments(ids: string[]) {
      calls.push({ op: 'delete', documentName, ids: [...ids] });
      for (const id of ids) {
        if (!collection.has(id) && !collection.invalidDocumentIds.has(id)) {
          throw new Error(`${documentName} ${id} does not exist in the collection`);
        }
      }
      for (const id of ids) {
        collection.delete(id);
        collection.stored.delete(id);
      }
      return ids;
    }
    static async create(data: any, options: any = {}) {
      return (await Cls.createDocuments([data], options))[0];
    }
  };
  Cls.implementation = Cls;
  return Cls;
}

// Foundry 13.351 BaseAdventure field order (foundry.mjs lines 14416-14425)
const ADV_FIELDS: [string, string][] = [
  ['actors', 'Actor'],
  ['combats', 'Combat'],
  ['items', 'Item'],
  ['journal', 'JournalEntry'],
  ['scenes', 'Scene'],
  ['tables', 'RollTable'],
  ['macros', 'Macro'],
  ['cards', 'Cards'],
  ['playlists', 'Playlist'],
  ['folders', 'Folder'],
];
let CONTENT_FIELDS: Record<string, any> = {};
function getDocumentClass$1(documentName: string) {
  return CONFIG[documentName]?.documentClass;
}

class Adventure {
  static get contentFields() {
    return CONTENT_FIELDS;
  }
  _source: any;
  constructor(source: any) {
    // Stands in for Foundry's data cleaning: every content field becomes an array.
    const s = structuredClone(source);
    for (const [field] of ADV_FIELDS) s[field] = Array.isArray(s[field]) ? s[field] : [];
    this._source = s;
  }
  get id() {
    return this._source._id;
  }
  get name() {
    return this._source.name;
  }
  get flags() {
    return this._source.flags ?? {};
  }
  toObject() {
    return structuredClone(this._source);
  }

  // ---- BEGIN verbatim foundry.mjs 41964-41995 (Foundry 13.351). Only TypeScript "any" type
  // annotations were added; prettier is told to leave the original formatting alone. ----
  // prettier-ignore
  async prepareImport(options: any) {
    const importFields = new Set(options.importFields);
    const adventureData: any = this.toObject();
    const toCreate: any = {};
    const toUpdate: any = {};
    let documentCount = 0;
    const importAll = !importFields.size || importFields.has("all");
    const keep = new Set();
    for ( const [field, cls] of Object.entries(Adventure.contentFields) as any ) {
      if ( !importAll && !importFields.has(field) ) continue;
      keep.add(cls.documentName);
      const collection = game.collections.get(cls.documentName);
      let [c, u] = adventureData[field].partition((d: any) => collection.has(d._id));
      if ( (field === "folders") && !importAll ) {
        c = c.filter((f: any) => keep.has(f.type));
        u = u.filter((f: any) => keep.has(f.type));
      }
      if ( c.length ) {
        toCreate[cls.documentName] = c;
        documentCount += c.length;
      }
      if ( u.length ) {
        toUpdate[cls.documentName] = u;
        documentCount += u.length;
      }
    }
    return {toCreate, toUpdate, documentCount};
  }
  // ---- END verbatim ----

  // ---- BEGIN verbatim foundry.mjs 42000-42033 (Foundry 13.351). Only TypeScript "any" type
  // annotations were added; prettier is told to leave the original formatting alone. ----
  // prettier-ignore
  async importContent({toCreate, toUpdate, documentCount}: any={}) {
    const created: any = {};
    const updated: any = {};
    const bar = ui.notifications.info("ADVENTURE.ImportProgress", {localize: true, progress: true});

    // Create new documents
    let nImported = 0;
    for ( const [documentName, createData] of Object.entries(toCreate) as any ) {
      const cls = getDocumentClass$1(documentName);
      const docs = await cls.createDocuments(createData, {
        keepId: true,       // Keep adventure document IDs
        render: false,      // Do not re-render related applications
        renderSheet: false  // Do not render new sheets
      });
      created[documentName] = docs;
      nImported += docs.length;
      bar.update({pct: nImported / documentCount});
    }

    // Update existing documents
    for ( const [documentName, updateData] of Object.entries(toUpdate) as any ) {
      const cls = getDocumentClass$1(documentName);
      const docs = await cls.updateDocuments(updateData, {
        diff: false,
        recursive: false,
        noHook: true,
        render: false      // Do not re-render related applications
      });
      updated[documentName] = docs;
      nImported += docs.length;
      bar.update({pct: nImported / documentCount});
    }
    bar.update({pct: 1});
    return {created, updated};
  }
  // ---- END verbatim ----
}

// ---------------------------------------------------------------------------------------------
// A small importer-built module (the shapes module_docs.py makes), three Adventures.

const MOD = 'aidm-test-book-0a1b2c3d';
const PACK = `${MOD}.adventure`;
const id16 = (s: string) => (s + '0000000000000000').slice(0, 16);
const CORE = id16('advCore');
const MAP = id16('advMap');
const TEXT = id16('advText');
const F_MON = id16('folderMon');
const GOB = id16('actorGob');
const GOB_ITEM = id16('itemScim');
const KEY = id16('itemKey');
const SCENE = id16('sceneHide');
const W1 = id16('wallDoor1');
const W2 = id16('wallPlain2');
const W3 = id16('wallPlain3');
const W4 = id16('wallPlain4');
const T1 = id16('tokenGob1');
const R1 = id16('regionArea1');
const B1 = id16('behavior1');
const N1 = id16('noteArea1');
const J1 = id16('journalArea');
const P1 = id16('pageRead1');
const P2 = id16('pageGm2');
const J2 = id16('journalText');
const P3 = id16('pageText3');

const derived = (stage: string) => ({ derived: { module: 'Test Book', stage, version: '1.0.0' } });
const top = (stage: string, extra: any = {}) => ({
  aidm: { ...derived(stage), module: MOD, ...extra },
});

function coreAdventure(build = 1) {
  return {
    _id: CORE,
    name: 'Test Book: core',
    sort: 0,
    flags: { aidm: { module: MOD, part: 'core', ...derived('pack') } },
    folders: [{ _id: F_MON, name: 'Monsters', type: 'Actor', folder: null, flags: top('pack') }],
    actors: [
      {
        _id: GOB,
        name: 'Goblin',
        type: 'npc',
        folder: F_MON,
        system: { attributes: { hp: { value: 7, max: build === 1 ? 7 : 11 }, ac: { flat: 15 } } },
        items: [
          { _id: GOB_ITEM, name: 'Scimitar', type: 'weapon', flags: { aidm: derived('P4') } },
        ],
        flags: top('P4'),
      },
    ],
    items: [{ _id: KEY, name: 'Iron key', type: 'loot', flags: top('E5') }],
  };
}

function mapAdventure(build = 1) {
  const walls = [
    { _id: W1, c: [0, 0, 100, 0], door: 1, ds: 0, flags: { aidm: derived('P5b') } },
    { _id: W2, c: [100, 0, 100, 100], door: 0, ds: 0, flags: { aidm: derived('P5b') } },
    { _id: W3, c: [0, 100, 100, 100], door: 0, ds: 0, flags: { aidm: derived('P5b') } },
    { _id: W4, c: [0, 0, 0, 100], door: 1, ds: 0, flags: { aidm: derived('P5b') } },
  ];
  if (build >= 2) {
    walls[0]!.c = [0, 0, 110, 0]; // importer moved door W1
    walls[1]!.c = [110, 0, 110, 100]; // importer moved W2
    walls[3]!.ds = 2; // importer locks door W4
    walls.splice(2, 1); // importer dropped W3
  }
  return {
    _id: MAP,
    name: 'Hideout',
    sort: 9001,
    flags: { aidm: { module: MOD, part: { page: 9, map: 0 }, ...derived('pack') } },
    scenes: [
      {
        _id: SCENE,
        name: build >= 2 ? 'Hideout (re-scanned)' : 'Hideout',
        active: false,
        grid: { type: 1, size: build >= 2 ? 36 : 50, distance: 5 },
        background: { src: `modules/${MOD}/maps/p9-m0.jpg` },
        walls,
        tokens: [
          {
            _id: T1,
            actorId: GOB,
            x: build >= 2 ? 150 : 100,
            y: 100,
            hidden: true,
            name: 'Goblin',
            flags: { aidm: derived('E4') },
          },
        ],
        regions: [
          {
            _id: R1,
            name: 'Area 1',
            flags: {
              aidm: {
                ...derived('P5d'),
                area: '1',
                encounter: [
                  {
                    monsters: [{ name: 'Goblin', count: build >= 2 ? 2 : 1 }],
                    trigger: 'on_enter',
                    started: false,
                  },
                ],
              },
            },
            behaviors: [{ _id: B1, type: 'executeMacro', disabled: true, system: {} }],
          },
        ],
        notes: [{ _id: N1, x: 50, y: 50, entryId: J1, flags: { aidm: derived('E1') } }],
        flags: top('P5', { pipeline: { kind: 'battle_map' } }),
      },
    ],
    journal: [
      {
        _id: J1,
        name: 'Area 1',
        ownership: { default: 0 },
        pages: [
          { _id: P1, name: 'Read aloud', text: { content: '<p>A cave.</p>' } },
          { _id: P2, name: 'GM', text: { content: '<p>Goblins.</p>' } },
        ],
        flags: top('P2', { scene: SCENE }),
      },
    ],
  };
}

function textAdventure() {
  return {
    _id: TEXT,
    name: 'Test Book: text',
    sort: 99999999,
    flags: { aidm: { module: MOD, part: 'journal', ...derived('pack') } },
    journal: [{ _id: J2, name: 'Chapter', pages: [{ _id: P3, name: 'Intro' }], flags: top('P2') }],
  };
}

let collections: Map<string, FakeCollection>;
let classes: Record<string, any>;
let settings: Record<string, any>;
let scheduled: { fn: () => void; ms: number }[];
let diskBuild: number | null;
let packSources: Record<string, any>;

function installWorld(
  opts: { build?: number; active?: boolean; registered?: boolean; users?: any[] } = {}
) {
  calls = [];
  idCounter = 0;
  scheduled = [];
  const build = opts.build ?? 1;
  diskBuild = build;
  collections = new Map(ADV_FIELDS.map(([, name]) => [name, new FakeCollection()]));
  classes = {};
  CONTENT_FIELDS = {};
  for (const [field, name] of ADV_FIELDS) {
    classes[name] = makeDocClass(name, collections.get(name)!);
    CONTENT_FIELDS[field] = classes[name];
  }
  packSources = {
    [CORE]: coreAdventure(build),
    [MAP]: mapAdventure(build),
    [TEXT]: textAdventure(),
  };
  const pack = {
    collection: PACK,
    metadata: { type: 'Adventure', packageName: MOD },
    async getIndex() {
      return Object.values(packSources).map((a: any) => ({
        _id: a._id,
        name: a.name,
        sort: a.sort,
        flags: a.flags,
      }));
    },
    async getDocument(id: string) {
      return packSources[id] ? new Adventure(packSources[id]) : null;
    },
  };
  const g: any = globalThis;
  g.CONFIG = Object.fromEntries(
    ADV_FIELDS.map(([, name]) => [name, { documentClass: classes[name] }])
  );
  g.CONFIG.Adventure = { documentClass: Adventure };
  g.CONFIG.queries = {};
  g.ui = { notifications: { info: () => ({ update: () => {} }) } };
  settings = { moduleConfiguration: { [MOD]: opts.active !== false, 'foundry-mcp-bridge': true } };
  const users = new FakeCollection();
  for (const u of opts.users ?? [{ id: 'gmhost', name: 'Overseer', active: true, isGM: true }])
    users.set(u.id, u);
  const modules = new Map<string, any>([
    ['foundry-mcp-bridge', { id: 'foundry-mcp-bridge', active: true }],
  ]);
  if (opts.registered !== false) {
    modules.set(MOD, {
      id: MOD,
      title: 'Test Book (AI-DM import)',
      active: opts.active !== false,
      version: `1.${build}.0`,
      flags: { aidm: { build } },
      relationships: { requires: new Set() },
    });
  }
  g.game = {
    user: { id: 'gmhost', isGM: true },
    users,
    collections,
    scenes: collections.get('Scene'),
    actors: collections.get('Actor'),
    items: collections.get('Item'),
    journal: collections.get('JournalEntry'),
    folders: collections.get('Folder'),
    combats: collections.get('Combat'),
    packs: new Map(opts.active === false ? [] : [[PACK, pack]]),
    modules,
    settings: {
      get(ns: string, key: string) {
        if (ns !== 'core') throw new Error('unexpected setting');
        return structuredClone(settings[key]);
      },
      async set(ns: string, key: string, value: any) {
        calls.push({
          op: 'setting',
          documentName: `${ns}.${key}`,
          ids: [],
          data: structuredClone(value),
        });
        settings[key] = structuredClone(value);
        return value;
      },
    },
    socket: { emit: vi.fn() },
  };
  for (const [, name] of ADV_FIELDS) g[name] = classes[name];
  g.foundry = {
    utils: { randomID: () => newId(), debouncedReload: vi.fn(), getRoute: (p: string) => `/${p}` },
  };
  g.fromUuidSync = (uuid: string) => {
    const m = /^Scene\.([A-Za-z0-9]{16})(?:\.Region\.([A-Za-z0-9]{16}))?/.exec(uuid);
    const scene = m ? collections.get('Scene')!.get(m[1]!) : null;
    if (!scene) return null;
    return m![2] ? (scene.regions.get(m![2]) ?? null) : scene;
  };
  g.fetch = vi.fn(async (url: string) => {
    if (!url.startsWith(`/modules/${MOD}/module.json`) || diskBuild === null) {
      return { status: 404, ok: false, json: async () => ({}) };
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({
        id: MOD,
        version: `1.${diskBuild}.0`,
        flags: { aidm: { build: diskBuild } },
      }),
    };
  });
}

function handlers(): any {
  const h: any = new QueryHandlers();
  h.aidmModules.schedule = (fn: () => void, ms: number) => scheduled.push({ fn, ms });
  return h;
}

const writes = () => calls.filter(c => c.op !== 'setting');
const replaced = () => calls.flatMap(c => c.replaced ?? []);

/** The gate's own tagged-document count (dnd-dm/eval/gate_foundry_window.py TAGGED_COUNT_JS), in TS. */
function gateTaggedCount(moduleId: string) {
  const tagged = (d: any) => d?.flags?.aidm?.module === moduleId;
  let total = 0;
  for (const c of [
    'Scene',
    'Actor',
    'Item',
    'JournalEntry',
    'RollTable',
    'Macro',
    'Playlist',
    'Cards',
    'Folder',
  ]) {
    total += collections.get(c)!.contents.filter(tagged).length;
  }
  for (const s of collections.get('Scene')!.contents) {
    for (const k of [
      'walls',
      'tokens',
      'regions',
      'notes',
      'lights',
      'drawings',
      'tiles',
      'sounds',
    ]) {
      total += (s._source[k] ?? []).filter(tagged).length;
    }
  }
  return total;
}

async function install(h: any, adventureId: string, extra: any = {}) {
  const dry = await h.handleAidmModuleInstall({ module_id: MOD, adventure_id: adventureId });
  expect(dry.success).toBe(true);
  return await h.handleAidmModuleInstall({
    module_id: MOD,
    adventure_id: adventureId,
    apply: true,
    plan_id: dry.plan_id,
    ...extra,
  });
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

beforeEach(() => installWorld());

// ---------------------------------------------------------------------------------------------

describe('aidm-module-* registration and access', () => {
  it('registers all six queries under the bridge module prefix', () => {
    const h = handlers();
    h.registerHandlers();
    for (const t of ['status', 'enable', 'disable', 'install', 'update', 'remove']) {
      expect(typeof CONFIG.queries[`foundry-mcp-bridge.aidm-module-${t}`]).toBe('function');
    }
  });

  it('every tool is GM-only and writes nothing for a non-GM user', async () => {
    game.user.isGM = false;
    const h = handlers();
    const results = await Promise.all([
      h.handleAidmModuleStatus({ module_id: MOD }),
      h.handleAidmModuleEnable({ module_id: MOD }),
      h.handleAidmModuleDisable({ module_id: MOD }),
      h.handleAidmModuleInstall({ module_id: MOD, adventure_id: CORE, apply: true, plan_id: 'x' }),
      h.handleAidmModuleUpdate({ module_id: MOD, adventure_id: MAP, apply: true, plan_id: 'x' }),
      h.handleAidmModuleRemove({ module_id: MOD, apply: true, plan_id: 'x' }),
    ]);
    for (const r of results) expect(r).toEqual({ success: false, error: 'Access denied' });
    expect(calls).toEqual([]);
  });

  it('refuses any module id that is not an importer module id, and never touches other modules', async () => {
    const h = handlers();
    for (const bad of ['curse-of-strahd-by-claygolem', 'aidm-synthetic-core', undefined]) {
      const r = await h.handleAidmModuleRemove({ module_id: bad, apply: true, plan_id: 'x' });
      expect(r.success).toBe(false);
      expect(r.error).toContain('aidm-<name>-<8 hex digits>');
    }
    expect(calls).toEqual([]);
  });
});

describe('aidm-module-status', () => {
  it('before install: registered, enabled, loaded build, disk build, empty world copy', async () => {
    const s = await handlers().handleAidmModuleStatus({ module_id: MOD });
    expect(s.success).toBe(true);
    expect(s.module).toMatchObject({
      registered: true,
      enabled: true,
      enabled_setting: true,
      reload_pending: false,
      loaded_build: 1,
      disk_read: 'ok',
      disk_build: 1,
      restart_needed: false,
    });
    expect(s.pack.adventures.map((a: any) => [a.id, a.part, a.world_documents])).toEqual([
      [CORE, 'core', 0],
      [MAP, 'map', 0],
      [TEXT, 'journal', 0],
    ]);
    expect(s.world).toMatchObject({ build: null, builds: [], total: 0 });
    expect(s.connected).toBe(0);
    expect(calls).toEqual([]);
  });

  it('a newer build on disk than the one Foundry loaded means a restart is needed; so does an unregistered folder', async () => {
    diskBuild = 2;
    expect(
      (await handlers().handleAidmModuleStatus({ module_id: MOD })).module.restart_needed
    ).toBe(true);
    installWorld({ registered: false });
    const s = await handlers().handleAidmModuleStatus({ module_id: MOD });
    expect(s.module).toMatchObject({ registered: false, disk_read: 'ok', restart_needed: true });
    diskBuild = null;
    expect((await handlers().handleAidmModuleStatus({ module_id: MOD })).module).toMatchObject({
      disk_read: 'missing',
      restart_needed: false,
    });
  });

  it('after install: the world build, counts by type and tagged embedded counts, and scenes in play', async () => {
    const h = handlers();
    expect((await install(h, CORE)).success).toBe(true);
    expect((await install(h, MAP)).success).toBe(true);
    collections.get('Scene')!.get(SCENE)._source.active = true;
    const s = await h.handleAidmModuleStatus({ module_id: MOD });
    expect(s.world).toMatchObject({ build: 1, builds: [1], mixed_builds: false, total: 5 });
    expect(s.world.documents).toEqual({ Folder: 1, Actor: 1, Item: 1, JournalEntry: 1, Scene: 1 });
    expect(s.world.embedded).toMatchObject({
      Wall: 4,
      Token: 1,
      Region: 1,
      RegionBehavior: 1,
      Note: 1,
      JournalEntryPage: 2,
      Item: 1,
    });
    expect(s.pack.adventures.map((a: any) => a.world_documents)).toEqual([3, 2, 0]);
    expect(s.in_play).toEqual([
      { scene_id: SCENE, name: 'Hideout', reasons: ['it is the active scene'] },
    ]);
    expect(s.recent_calls.map((c: any) => [c.tool, c.state, c.result.success])).toEqual([
      ['aidm-module-install', 'done', true],
      ['aidm-module-install', 'done', true],
    ]);
  });
});

describe('aidm-module-enable / aidm-module-disable', () => {
  it('enables: writes the setting, replies first, then reloads every client', async () => {
    installWorld({ active: false });
    const h = handlers();
    const r = await h.handleAidmModuleEnable({ module_id: MOD, call_id: 'en-1' });
    expect(r).toMatchObject({
      success: true,
      changed: true,
      enabled_setting: true,
      reload: { scheduled: true, in_ms: 2000 },
      call_id: 'en-1',
    });
    expect(settings.moduleConfiguration[MOD]).toBe(true);
    expect(settings.moduleConfiguration['foundry-mcp-bridge']).toBe(true); // other modules untouched
    expect(game.socket.emit).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    scheduled[0]!.fn();
    expect(game.socket.emit).toHaveBeenCalledWith('reload');
    expect((globalThis as any).foundry.utils.debouncedReload).toHaveBeenCalled();
  });

  it('refuses, changing nothing, when anyone else is connected or it cannot be read', async () => {
    installWorld({
      active: false,
      users: [
        { id: 'gmhost', name: 'Overseer', active: true },
        { id: 'p1', name: 'Ada', active: true },
      ],
    });
    const r = await handlers().handleAidmModuleEnable({ module_id: MOD });
    expect(r.success).toBe(false);
    expect(r.error).toContain('1 other user(s) are connected');
    expect(r.error).not.toContain('Ada');
    installWorld({ active: false });
    game.users = undefined;
    const u = await handlers().handleAidmModuleEnable({ module_id: MOD });
    expect(u.error).toContain('could not read who is connected');
    expect(calls).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  it('refuses an unregistered module (a restart is needed first) and a missing required module', async () => {
    installWorld({ registered: false, active: false });
    expect((await handlers().handleAidmModuleEnable({ module_id: MOD })).error).toContain(
      'restarts'
    );
    installWorld({ active: false });
    game.modules.get(MOD).relationships.requires = new Set([
      { id: 'monks-active-tiles', type: 'module' },
    ]);
    expect((await handlers().handleAidmModuleEnable({ module_id: MOD })).error).toContain(
      'monks-active-tiles'
    );
    expect(calls).toEqual([]);
  });

  it('disable is refused while a scene of the module is in play (PC token, combat, active)', async () => {
    const h = handlers();
    await install(h, CORE);
    await install(h, MAP);
    const scene = collections.get('Scene')!.get(SCENE);
    await classes.Actor.createDocuments([{ _id: id16('pc'), name: 'Ada', type: 'character' }], {
      keepId: true,
    });
    scene._source.tokens.push({ _id: id16('pcTok'), actorId: id16('pc'), name: 'Ada' });
    calls = [];
    const r = await h.handleAidmModuleDisable({ module_id: MOD });
    expect(r.success).toBe(false);
    expect(r.in_play[0].reasons[0]).toContain('Ada');
    scene._source.tokens.pop();
    collections.get('Combat')!.set('c1', { _source: { scene: SCENE } });
    expect((await h.handleAidmModuleDisable({ module_id: MOD })).in_play[0].reasons).toEqual([
      '1 combat(s) are set on it',
    ]);
    expect(calls).toEqual([]);
  });

  it('an already enabled module is a no-op; reload:false saves without a reload; disable reports documents left', async () => {
    const h = handlers();
    expect(await h.handleAidmModuleEnable({ module_id: MOD })).toMatchObject({
      success: true,
      changed: false,
    });
    await install(h, CORE);
    const d = await h.handleAidmModuleDisable({ module_id: MOD, reload: false });
    expect(d).toMatchObject({
      success: true,
      changed: true,
      reload: { scheduled: false },
      tagged_documents_remain: 3,
    });
    expect(scheduled).toEqual([]);
  });
});

describe('aidm-module-install: plan first, never overwrite', () => {
  it('without adventure_id lists the install order and the next Adventure; writes nothing', async () => {
    const r = await handlers().handleAidmModuleInstall({ module_id: MOD });
    expect(r.install_order.map((a: any) => a.id)).toEqual([CORE, MAP, TEXT]);
    expect(r.next_adventure).toBe(CORE);
    expect(calls).toEqual([]);
  });

  it('the dry run lists every document it would create, with embedded counts, and a plan_id', async () => {
    const r = await handlers().handleAidmModuleInstall({ module_id: MOD, adventure_id: MAP });
    expect(r).toMatchObject({
      success: true,
      mode: 'dry-run',
      changed: false,
      state: 'not_installed',
      build: 1,
      order_ok: false,
    });
    expect(r.create.map((c: any) => [c.type, c.id])).toEqual([
      ['JournalEntry', J1],
      ['Scene', SCENE],
    ]);
    expect(r.create[1].embedded).toEqual({
      walls: 4,
      tokens: 1,
      regions: 1,
      'regions.behaviors': 1,
      notes: 1,
    });
    expect(r.plan_id).toMatch(/^mi-2-[0-9a-f]{8}$/);
    expect(r.next_step).toContain('core Adventure first');
    expect(calls).toEqual([]);
  });

  it('apply without a plan_id, or with a stale one, is refused without revealing the live plan', async () => {
    const h = handlers();
    const live = (await h.handleAidmModuleInstall({ module_id: MOD, adventure_id: CORE })).plan_id;
    const none = await h.handleAidmModuleInstall({
      module_id: MOD,
      adventure_id: CORE,
      apply: true,
    });
    expect(none.success).toBe(false);
    const stale = await h.handleAidmModuleInstall({
      module_id: MOD,
      adventure_id: CORE,
      apply: true,
      plan_id: 'mi-3-00000000',
    });
    expect(stale.success).toBe(false);
    expect(stale.error).toContain('Nothing was changed');
    expect(JSON.stringify(stale)).not.toContain(live);
    expect(writes()).toEqual([]);
  });

  it('refuses a map Adventure before the core Adventure is installed', async () => {
    const r = await install(handlers(), MAP);
    expect(r.success).toBe(false);
    expect(r.error).toContain('install the core Adventure first');
    expect(writes()).toEqual([]);
  });

  it('installs the core, then a map: every Adventure field, ids kept, every document and embedded document tagged', async () => {
    const h = handlers();
    const core = await install(h, CORE);
    expect(core).toMatchObject({
      success: true,
      changed: true,
      state: 'installed',
      build: 1,
      created: { Folder: 1, Actor: 1, Item: 1 },
    });
    const map = await install(h, MAP);
    expect(map).toMatchObject({
      success: true,
      created: { JournalEntry: 1, Scene: 1 },
      verification: { documents_checked: 2, problems: [] },
    });
    expect(calls.filter(c => c.op === 'create').map(c => c.documentName)).toEqual([
      'Folder',
      'Actor',
      'Item',
      'JournalEntry',
      'Scene',
    ]);
    expect(calls.every(c => c.op !== 'update')).toBe(true);
    expect(replaced()).toEqual([]);
    const scene = collections.get('Scene')!.get(SCENE)._source;
    expect(scene.flags.aidm).toMatchObject({
      module: MOD,
      build: 1,
      adventure: MAP,
      pipeline: { kind: 'battle_map' },
    });
    expect(scene.flags.aidm.hash).toBe(contentHash(mapAdventure().scenes[0]));
    for (const w of scene.walls)
      expect(w.flags.aidm).toMatchObject({ module: MOD, build: 1, adventure: MAP });
    expect(scene.regions[0].behaviors[0].flags.aidm.build).toBe(1);
    expect(scene.regions[0].flags.aidm.area).toBe('1'); // the importer's own flags stay
    const actor = collections.get('Actor')!.get(GOB)._source;
    expect(actor.items[0].flags.aidm.module).toBe(MOD);
    expect(actor.folder).toBe(F_MON);
    expect(collections.get('JournalEntry')!.get(J1)._source.pages[1].flags.aidm.adventure).toBe(
      MAP
    );
    expect(gateTaggedCount(MOD)).toBe(5 + 4 + 1 + 1 + 1); // top-level + walls, tokens, regions, notes
  });

  it('never overwrites an untagged document: the whole call is refused and nothing is written', async () => {
    const h = handlers();
    await install(h, CORE);
    await classes.Scene.createDocuments([{ _id: SCENE, name: 'GM hand-built scene', walls: [] }], {
      keepId: true,
    });
    calls = [];
    const dry = await h.handleAidmModuleInstall({ module_id: MOD, adventure_id: MAP });
    expect(dry.state).toBe('conflicts');
    expect(dry.conflicts).toEqual([
      {
        type: 'Scene',
        id: SCENE,
        name: 'GM hand-built scene',
        reason: 'id-taken-untagged',
        tagged_module: null,
      },
    ]);
    const r = await h.handleAidmModuleInstall({
      module_id: MOD,
      adventure_id: MAP,
      apply: true,
      plan_id: dry.plan_id,
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('Nothing was created or changed');
    expect(writes()).toEqual([]);
    expect(collections.get('Scene')!.get(SCENE).name).toBe('GM hand-built scene');
    expect(collections.get('JournalEntry')!.has(J1)).toBe(false);
  });

  it('a stored document Foundry could not load blocks its id (never silently replaced)', async () => {
    const h = handlers();
    await install(h, CORE);
    collections.get('Scene')!.stored.set(SCENE, { _id: SCENE, name: 'broken' });
    collections.get('Scene')!.invalidDocumentIds.add(SCENE);
    calls = [];
    const dry = await h.handleAidmModuleInstall({ module_id: MOD, adventure_id: MAP });
    expect(dry.conflicts.map((c: any) => c.reason)).toEqual(['id-taken-invalid']);
    const r = await h.handleAidmModuleInstall({
      module_id: MOD,
      adventure_id: MAP,
      apply: true,
      plan_id: dry.plan_id,
    });
    expect(r.success).toBe(false);
    expect(replaced()).toEqual([]);
    expect(collections.get('Scene')!.stored.get(SCENE).name).toBe('broken');
  });

  it('a created document that lands in invalidDocumentIds is a FAILURE: everything the call created is rolled back', async () => {
    const h = handlers();
    await install(h, CORE);
    classes.Scene.invalidOnCreate.add(SCENE);
    calls = [];
    const r = await install(h, MAP);
    expect(r.success).toBe(false);
    expect(r.problems.join(' ')).toContain('invalidDocumentIds');
    expect(r.cleanup.failed).toEqual([]);
    expect(r.cleanup.deleted.map((d: any) => d.id).sort()).toEqual([J1, SCENE].sort());
    expect(collections.get('Scene')!.stored.has(SCENE)).toBe(false);
    expect(collections.get('JournalEntry')!.has(J1)).toBe(false);
    expect(collections.get('Actor')!.has(GOB)).toBe(true); // the core install is untouched
  });

  it('an embedded document Foundry dropped or could not load fails the count check and rolls back', async () => {
    const h = handlers();
    await install(h, CORE);
    classes.Scene.dropEmbeddedOnCreate = { field: 'walls', id: W2 };
    const dropped = await install(h, MAP);
    expect(dropped.success).toBe(false);
    expect(dropped.problems.join(' ')).toContain('walls holds 3, the Adventure has 4');
    expect(collections.get('Scene')!.size).toBe(0);
    classes.Scene.dropEmbeddedOnCreate = null;
    classes.Scene.invalidEmbeddedOnCreate = { field: 'tokens', id: T1 };
    const bad = await install(h, MAP);
    expect(bad.success).toBe(false);
    expect(bad.problems.join(' ')).toContain("tokens document(s) failed Foundry's data checks");
    expect(collections.get('Scene')!.size).toBe(0);
  });

  it('tokens pointing at an actor the world lacks fail the install and roll it back', async () => {
    const h = handlers();
    await install(h, CORE);
    await classes.Actor.deleteDocuments([GOB]); // a GM deleted the goblin after the core install
    const r = await install(h, MAP);
    expect(r.success).toBe(false);
    expect(r.error).toContain(GOB);
    expect(collections.get('Scene')!.size).toBe(0);
  });

  it('importContent throwing after its creates rolls back what was saved', async () => {
    const h = handlers();
    await install(h, CORE);
    classes.JournalEntry.failAfterCreate = true;
    const r = await install(h, MAP);
    expect(r.success).toBe(false);
    expect(r.error).toContain('create failed after save');
    expect(r.cleanup.deleted.map((d: any) => d.id)).toEqual([J1]);
    expect(collections.get('JournalEntry')!.stored.size).toBe(0);
  });
});

describe('aidm-module-install: a call the MCP side gave up on', () => {
  it('still finishes in the GM client; status settles it; a repeat apply is a no-op; the same call_id is never run twice', async () => {
    const h = handlers();
    const hold = gate();
    const realGet = packSources;
    void realGet;
    const dry = await h.handleAidmModuleInstall({ module_id: MOD, adventure_id: CORE });
    const origGetDocument = game.packs.get(PACK).getDocument;
    game.packs.get(PACK).getDocument = async (id: string) => {
      const adv: any = await origGetDocument(id);
      const imp = adv.importContent.bind(adv);
      adv.importContent = async (d: any) => {
        await hold.promise;
        return imp(d);
      };
      return adv;
    };
    // The MCP side sends the call, then times out (it stops waiting; nothing is awaited here).
    const first = h.handleAidmModuleInstall({
      module_id: MOD,
      adventure_id: CORE,
      apply: true,
      plan_id: dry.plan_id,
      call_id: 'install-core-1',
    });
    await new Promise(r => setTimeout(r, 10));
    const busy = await h.handleAidmModuleStatus({ module_id: MOD });
    expect(busy.busy).toBe(true);
    expect(busy.recent_calls.map((c: any) => [c.call_id, c.state])).toEqual([
      ['install-core-1', 'running'],
    ]);
    // A retry with the same call_id while it runs: nothing new starts.
    const retry = await h.handleAidmModuleInstall({
      module_id: MOD,
      adventure_id: CORE,
      apply: true,
      plan_id: dry.plan_id,
      call_id: 'install-core-1',
    });
    expect(retry).toMatchObject({ success: false, in_progress: true });
    hold.open();
    expect((await first).success).toBe(true);
    const settled = await h.handleAidmModuleStatus({ module_id: MOD });
    expect(settled.busy).toBe(false);
    expect(settled.recent_calls[0]).toMatchObject({
      call_id: 'install-core-1',
      state: 'done',
      result: { success: true, changed: true },
    });
    expect(settled.world.total).toBe(3);
    // The same call_id again: replayed from the journal, not run.
    calls = [];
    const replay = await h.handleAidmModuleInstall({
      module_id: MOD,
      adventure_id: CORE,
      apply: true,
      plan_id: dry.plan_id,
      call_id: 'install-core-1',
    });
    expect(replay).toMatchObject({ success: true, changed: false, replayed: true });
    // A new call with the (now stale) plan_id: the Adventure is installed, so it is a no-op success.
    const again = await h.handleAidmModuleInstall({
      module_id: MOD,
      adventure_id: CORE,
      apply: true,
      plan_id: dry.plan_id,
    });
    expect(again).toMatchObject({
      success: true,
      changed: false,
      state: 'installed',
      reused: true,
    });
    expect(writes()).toEqual([]);
    expect(replaced()).toEqual([]);
  });

  it('install and adventure-import share one lock: a queued adventure-import waits for the install', async () => {
    const h = handlers();
    const hold = gate();
    const events: string[] = [];
    const dry = await h.handleAidmModuleInstall({ module_id: MOD, adventure_id: CORE });
    const origGetDocument = game.packs.get(PACK).getDocument;
    game.packs.get(PACK).getDocument = async (id: string) => {
      const adv: any = await origGetDocument(id);
      const imp = adv.importContent.bind(adv);
      adv.importContent = async (d: any) => {
        events.push('install-import-start');
        await hold.promise;
        const r = await imp(d);
        events.push('install-import-end');
        return r;
      };
      return adv;
    };
    const installing = h.handleAidmModuleInstall({
      module_id: MOD,
      adventure_id: CORE,
      apply: true,
      plan_id: dry.plan_id,
    });
    const importing = h.handleAdventureImport({ package: 'x', scene_ref: 'bad' }).then((r: any) => {
      events.push('adventure-import-done');
      return r;
    });
    await new Promise(r => setTimeout(r, 10));
    expect(events).toEqual(['install-import-start']);
    hold.open();
    await Promise.all([installing, importing]);
    expect(events).toEqual(['install-import-start', 'install-import-end', 'adventure-import-done']);
  });
});

describe('aidm-module-update: three-way merge', () => {
  /** Installs build 1, then plays and edits like a table would. */
  async function installedAndPlayed() {
    const h = handlers();
    expect((await install(h, CORE)).success).toBe(true);
    expect((await install(h, MAP)).success).toBe(true);
    const scene = collections.get('Scene')!.get(SCENE)._source;
    scene.walls.find((w: any) => w._id === W1).c = [0, 0, 90, 0]; // a GM moved door W1
    scene.walls.find((w: any) => w._id === W4).ds = 1; // door W4 opened in play
    scene.walls.push({ _id: id16('gmWall'), c: [5, 5, 6, 6] }); // a GM added a wall
    scene.regions[0].flags.aidm.encounter[0].started = true; // the brain fired the encounter
    scene.regions[0].flags.aidm.itemsTaken = ['key'];
    scene.tokens[0].x = 300; // the goblin moved in play
    scene.notes = []; // a GM deleted the note
    collections.get('Actor')!.get(GOB)._source.system.attributes.hp.value = 3; // took damage
    calls = [];
    return h;
  }

  const target = () => ({ target: mapAdventure(2), target_build: 2 });

  it('the dry run shows what it would write, what GM edits it keeps, and what play state it protects; it writes nothing', async () => {
    const h = await installedAndPlayed();
    const before = JSON.stringify(collections.get('Scene')!.get(SCENE)._source);
    const dry = await h.handleAidmModuleUpdate({ module_id: MOD, adventure_id: MAP, ...target() });
    expect(dry).toMatchObject({
      success: true,
      mode: 'dry-run',
      changed: false,
      base_build: 1,
      target_build: 2,
    });
    expect(dry.plan_id).toMatch(/^mu-\d+-[0-9a-f]{8}$/);
    const ops = dry.ops.map((o: any) => `${o.action}:${o.type}:${o.id}`);
    expect(ops).toContain(`update:Scene:${SCENE}`);
    expect(ops).toContain(`update:Wall:${W2}`);
    expect(ops).toContain(`delete:Wall:${W3}`);
    expect(ops).not.toContain(`update:Wall:${W1}`);
    expect(dry.kept_gm_edits.map((k: any) => `${k.type}:${k.id}:${k.path ?? ''}`)).toEqual(
      expect.arrayContaining([`Wall:${W1}:c`, `Note:${N1}:`])
    );
    expect(dry.protected_play_state.map((p: any) => `${p.type}:${p.id}:${p.path}`)).toEqual(
      expect.arrayContaining([
        `Wall:${W4}:ds`,
        `Token:${T1}:x`,
        `Region:${R1}:flags.aidm.encounter.0`,
      ])
    );
    expect(dry.play_began[0].reasons).toEqual(['1 encounter(s) started', '1 item(s) taken']);
    expect(writes()).toEqual([]);
    expect(JSON.stringify(collections.get('Scene')!.get(SCENE)._source)).toBe(before);
  });

  it('apply changes only what the importer wrote and nobody changed; GM edits and play state stay; documents re-tagged', async () => {
    const h = await installedAndPlayed();
    const dry = await h.handleAidmModuleUpdate({ module_id: MOD, adventure_id: MAP, ...target() });
    const r = await h.handleAidmModuleUpdate({
      module_id: MOD,
      adventure_id: MAP,
      ...target(),
      apply: true,
      plan_id: dry.plan_id,
    });
    expect(r).toMatchObject({ success: true, mode: 'apply', changed: true });
    expect(r.verification.problems).toEqual([]);
    const scene = collections.get('Scene')!.get(SCENE)._source;
    const wall = (id: string) => scene.walls.find((w: any) => w._id === id);
    expect(scene.name).toBe('Hideout (re-scanned)'); // untouched by a GM: new value
    expect(scene.grid.size).toBe(36);
    expect(wall(W1).c).toEqual([0, 0, 90, 0]); // GM edit kept
    expect(wall(W2).c).toEqual([110, 0, 110, 100]); // importer change applied
    expect(wall(W2).flags.aidm.build).toBe(2);
    expect(wall(W3)).toBeUndefined(); // dropped by the importer, untouched: deleted
    expect(wall(W4).ds).toBe(1); // opened in play: the new lock is NOT written
    expect(wall(id16('gmWall'))).toBeDefined(); // a GM's own wall is never touched
    expect(scene.notes).toEqual([]); // a GM deleted it: it stays deleted
    expect(scene.tokens[0].x).toBe(300); // play position kept
    const region = scene.regions[0].flags.aidm;
    expect(region.encounter[0]).toEqual({
      monsters: [{ name: 'Goblin', count: 1 }],
      trigger: 'on_enter',
      started: true,
    });
    expect(region.itemsTaken).toEqual(['key']);
    expect(scene.flags.aidm.build).toBe(2);
    expect(scene.flags.aidm.hash).toBe(
      contentHash(new CONFIG.Adventure.documentClass(mapAdventure(2)).toObject().scenes[0])
    );
    expect(collections.get('JournalEntry')!.get(J1)._source.flags.aidm.build).toBe(2); // re-tagged, no field change
    expect(replaced()).toEqual([]);
  });

  it('actors: an importer change to max hit points is written, current hit points never', async () => {
    const h = await installedAndPlayed();
    const args = {
      module_id: MOD,
      adventure_id: CORE,
      target: coreAdventure(2),
      target_build: 2,
      base: coreAdventure(1),
      base_build: 1,
    };
    const dry = await h.handleAidmModuleUpdate(args);
    const r = await h.handleAidmModuleUpdate({ ...args, apply: true, plan_id: dry.plan_id });
    expect(r.success).toBe(true);
    expect(collections.get('Actor')!.get(GOB)._source.system.attributes.hp).toEqual({
      value: 3,
      max: 11,
    });
  });

  it('a scene in play right now is skipped whole; the rest of the Adventure still updates', async () => {
    const h = await installedAndPlayed();
    collections.get('Scene')!.get(SCENE)._source.active = true;
    const before = JSON.stringify(collections.get('Scene')!.get(SCENE)._source);
    const dry = await h.handleAidmModuleUpdate({ module_id: MOD, adventure_id: MAP, ...target() });
    expect(dry.skipped[0].reason).toContain('in play right now');
    const r = await h.handleAidmModuleUpdate({
      module_id: MOD,
      adventure_id: MAP,
      ...target(),
      apply: true,
      plan_id: dry.plan_id,
    });
    expect(r.success).toBe(true);
    expect(JSON.stringify(collections.get('Scene')!.get(SCENE)._source)).toBe(before);
    expect(collections.get('JournalEntry')!.get(J1)._source.flags.aidm.build).toBe(2);
  });

  it('a stale plan_id is refused and nothing is written', async () => {
    const h = await installedAndPlayed();
    const dry = await h.handleAidmModuleUpdate({ module_id: MOD, adventure_id: MAP, ...target() });
    collections
      .get('Scene')!
      .get(SCENE)
      ._source.walls.find((w: any) => w._id === W2).c = [1, 1, 1, 1]; // world changed
    const r = await h.handleAidmModuleUpdate({
      module_id: MOD,
      adventure_id: MAP,
      ...target(),
      apply: true,
      plan_id: dry.plan_id,
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('Nothing was changed');
    expect(JSON.stringify(r)).not.toContain(dry.plan_id);
    expect(writes()).toEqual([]);
  });

  it('a failure part-way undoes every write the call made', async () => {
    const h = await installedAndPlayed();
    const snapshot = () =>
      JSON.stringify([...collections.entries()].map(([n, c]) => [n, [...c.stored.entries()]]));
    const before = snapshot();
    const dry = await h.handleAidmModuleUpdate({ module_id: MOD, adventure_id: MAP, ...target() });
    // The scene and journal updates go through; the embedded wall update then fails.
    const scene = collections.get('Scene')!.get(SCENE);
    scene.failEmbeddedUpdate = new Set(['Wall']);
    const r = await h.handleAidmModuleUpdate({
      module_id: MOD,
      adventure_id: MAP,
      ...target(),
      apply: true,
      plan_id: dry.plan_id,
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('socket closed');
    expect(r.undo.failed).toEqual([]);
    expect(r.undo.restored.length).toBeGreaterThan(0);
    expect(snapshot()).toBe(before);
  });

  it('without base data it uses the loaded pack only when that is the build the world copy is at', async () => {
    const h = await installedAndPlayed();
    const dry = await h.handleAidmModuleUpdate({ module_id: MOD, adventure_id: MAP, ...target() });
    expect(dry.success).toBe(true); // loaded build 1 == world build 1
    game.modules.get(MOD).flags.aidm.build = 2; // Foundry restarted onto the new files
    const noBase = await h.handleAidmModuleUpdate({
      module_id: MOD,
      adventure_id: MAP,
      ...target(),
    });
    expect(noBase.success).toBe(false);
    expect(noBase.error).toContain('must be passed as base and base_build');
    const withBase = await h.handleAidmModuleUpdate({
      module_id: MOD,
      adventure_id: MAP,
      ...target(),
      base: mapAdventure(1),
      base_build: 1,
    });
    expect(withBase.success).toBe(true);
    expect(withBase.plan_id).toBe(dry.plan_id);
  });

  it('refuses an Adventure that is not installed, and target data without its build number', async () => {
    const h = handlers();
    expect(
      (await h.handleAidmModuleUpdate({ module_id: MOD, adventure_id: MAP, ...target() })).error
    ).toContain('aidm-module-install');
    await install(h, CORE);
    await install(h, MAP);
    expect(
      (
        await h.handleAidmModuleUpdate({
          module_id: MOD,
          adventure_id: MAP,
          target: mapAdventure(2),
        })
      ).error
    ).toContain('target_build');
  });
});

describe('aidm-module-remove', () => {
  async function installedAll() {
    const h = handlers();
    for (const a of [CORE, MAP, TEXT]) expect((await install(h, a)).success).toBe(true);
    calls = [];
    return h;
  }

  it('dry run lists every tagged document and writes nothing', async () => {
    const h = await installedAll();
    const r = await h.handleAidmModuleRemove({ module_id: MOD });
    expect(r).toMatchObject({
      success: true,
      mode: 'dry-run',
      changed: false,
      total: 6,
      will_disable_module: true,
    });
    expect(r.counts).toEqual({ Folder: 1, Actor: 1, Item: 1, JournalEntry: 2, Scene: 1 });
    expect(r.plan_id).toMatch(/^mr-6-[0-9a-f]{8}$/);
    expect(writes()).toEqual([]);
  });

  it('removes the module as one unit: nothing tagged is left (the gate count is zero), GM documents stay, then it disables', async () => {
    const h = await installedAll();
    await classes.Scene.createDocuments([{ _id: id16('gmScene'), name: 'GM scene', walls: [] }], {
      keepId: true,
    });
    calls = [];
    const dry = await h.handleAidmModuleRemove({ module_id: MOD });
    const r = await h.handleAidmModuleRemove({ module_id: MOD, apply: true, plan_id: dry.plan_id });
    expect(r).toMatchObject({
      success: true,
      changed: true,
      remaining: 0,
      module_disabled: true,
      deleted: { Scene: 1, JournalEntry: 2, Item: 1, Actor: 1, Folder: 1 },
    });
    expect(calls.filter(c => c.op === 'delete').map(c => c.documentName)).toEqual([
      'Scene',
      'JournalEntry',
      'Item',
      'Actor',
      'Folder',
    ]);
    expect(gateTaggedCount(MOD)).toBe(0);
    expect(collections.get('Scene')!.has(id16('gmScene'))).toBe(true);
    expect(settings.moduleConfiguration[MOD]).toBe(false);
    expect(scheduled).toHaveLength(1);
  });

  it('is refused while a scene of the module is in play, or anyone else is connected; nothing is deleted', async () => {
    const h = await installedAll();
    collections.get('Scene')!.get(SCENE)._source.active = true;
    const dry = await h.handleAidmModuleRemove({ module_id: MOD });
    expect(dry.next_step).toContain('would be refused');
    const r = await h.handleAidmModuleRemove({ module_id: MOD, apply: true, plan_id: dry.plan_id });
    expect(r.success).toBe(false);
    expect(r.error).toContain('it is the active scene');
    collections.get('Scene')!.get(SCENE)._source.active = false;
    game.users.set('p1', { id: 'p1', name: 'Ada', active: true });
    const dry2 = await h.handleAidmModuleRemove({ module_id: MOD });
    const r2 = await h.handleAidmModuleRemove({
      module_id: MOD,
      apply: true,
      plan_id: dry2.plan_id,
    });
    expect(r2.error).toContain('other user(s) are connected');
    expect(writes()).toEqual([]);
    expect(gateTaggedCount(MOD)).toBeGreaterThan(0);
  });

  it('apply without a plan_id, with a made-up one, or after the world changed is refused and deletes nothing', async () => {
    const h = await installedAll();
    const dry = await h.handleAidmModuleRemove({ module_id: MOD });
    const none = await h.handleAidmModuleRemove({ module_id: MOD, apply: true });
    expect(none.success).toBe(false);
    const madeUp = await h.handleAidmModuleRemove({
      module_id: MOD,
      apply: true,
      plan_id: 'mr-6-00000000',
    });
    expect(madeUp.success).toBe(false);
    expect(madeUp.error).toContain('Nothing was changed');
    expect(JSON.stringify(madeUp)).not.toContain(dry.plan_id);
    // the world changed after the dry run: a new tagged document appeared
    const extra = structuredClone(packSources[TEXT].journal[0]);
    extra._id = id16('journalLate');
    extra.flags.aidm.adventure = TEXT;
    await classes.JournalEntry.createDocuments([extra], { keepId: true });
    calls = [];
    const stale = await h.handleAidmModuleRemove({
      module_id: MOD,
      apply: true,
      plan_id: dry.plan_id,
    });
    expect(stale.success).toBe(false);
    expect(writes()).toEqual([]);
    expect(gateTaggedCount(MOD)).toBeGreaterThan(0);
  });

  it("reports tokens on a GM's own scene that would lose their actor (never deletes them)", async () => {
    const h = await installedAll();
    await classes.Scene.createDocuments(
      [{ _id: id16('gmScene'), name: 'GM scene', tokens: [{ _id: id16('gmTok'), actorId: GOB }] }],
      { keepId: true }
    );
    const dry = await h.handleAidmModuleRemove({ module_id: MOD });
    expect(dry.tokens_left_without_their_actor).toEqual([
      { scene_id: id16('gmScene'), scene_name: 'GM scene', token_id: id16('gmTok'), actor_id: GOB },
    ]);
    const r = await h.handleAidmModuleRemove({ module_id: MOD, apply: true, plan_id: dry.plan_id });
    expect(r.success).toBe(true);
    expect(r.tokens_left_without_their_actor).toHaveLength(1);
    expect(collections.get('Scene')!.get(id16('gmScene'))._source.tokens).toHaveLength(1);
  });

  it('keeps a GM copy made with Duplicate (it carries the tags) and reports it', async () => {
    const h = await installedAll();
    const copy = collections.get('Scene')!.get(SCENE).toObject();
    copy._id = id16('sceneCopy');
    copy._stats = { duplicateSource: `Scene.${SCENE}` };
    await classes.Scene.createDocuments([copy], { keepId: true });
    const dry = await h.handleAidmModuleRemove({ module_id: MOD });
    expect(dry.kept_gm_copies).toEqual([{ type: 'Scene', id: id16('sceneCopy'), name: 'Hideout' }]);
    const r = await h.handleAidmModuleRemove({ module_id: MOD, apply: true, plan_id: dry.plan_id });
    expect(r.success).toBe(true);
    expect(collections.get('Scene')!.has(id16('sceneCopy'))).toBe(true);
  });

  it('with adventure_id removes only that Adventure and leaves the module enabled', async () => {
    const h = await installedAll();
    const dry = await h.handleAidmModuleRemove({ module_id: MOD, adventure_id: MAP });
    expect(dry.will_disable_module).toBe(false);
    const r = await h.handleAidmModuleRemove({
      module_id: MOD,
      adventure_id: MAP,
      apply: true,
      plan_id: dry.plan_id,
    });
    expect(r).toMatchObject({
      success: true,
      deleted: { Scene: 1, JournalEntry: 1 },
      module_disabled: false,
    });
    expect(collections.get('Actor')!.has(GOB)).toBe(true);
    expect(collections.get('JournalEntry')!.has(J2)).toBe(true);
    expect(settings.moduleConfiguration[MOD]).toBe(true);
    // and it can be installed again
    expect((await install(h, MAP)).success).toBe(true);
  });

  it('a delete that fails leaves the module enabled and says what is left', async () => {
    const h = await installedAll();
    const dry = await h.handleAidmModuleRemove({ module_id: MOD });
    classes.Actor.deleteDocuments = async () => {
      throw new Error('server refused');
    };
    const r = await h.handleAidmModuleRemove({ module_id: MOD, apply: true, plan_id: dry.plan_id });
    expect(r.success).toBe(false);
    expect(r.remaining).toBe(1);
    expect(r.module_disabled).toBe(false);
    expect(settings.moduleConfiguration[MOD]).toBe(true);
  });
});
