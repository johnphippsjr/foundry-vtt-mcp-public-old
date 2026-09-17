/**
 * Pure helpers for the aidm-module-* bridge tools (board #1724, design order item 9, bridge part).
 *
 * The tools install, update and remove one imported book's Foundry adventure module
 * ("aidm-<slug>-<hash8>", built offline by dnd-dm-ingest/src/module_pack.py) in the world the GM
 * client is running. This file holds every decision the tools make that does not need a live
 * Foundry: which documents an install would create and which ids block it, the plan ids, the
 * content hash, the "in play" rule, the tags every created document carries, the count check
 * after an install, and the three-way merge an update uses. queries.ts and
 * aidm-module-handlers.ts do the Foundry reads and writes.
 *
 * No Foundry globals are used here, so everything is unit tested with plain vitest.
 */

// ---------------------------------------------------------------------------------------------
// Names and ids

/** The module ids the importer's packer makes (build_record.module_id_for). Nothing else is ever touched. */
export const AIDM_MODULE_ID_RE = /^aidm-[a-z0-9-]{1,48}-[0-9a-f]{8}$/;

export function isAidmModuleId(value: unknown): value is string {
  return typeof value === 'string' && AIDM_MODULE_ID_RE.test(value);
}

/** Every tool name this lane adds. The DM brain must hide all of them from the model. */
export const AIDM_MODULE_TOOL_NAMES = [
  'aidm-module-status',
  'aidm-module-enable',
  'aidm-module-disable',
  'aidm-module-install',
  'aidm-module-update',
  'aidm-module-remove',
] as const;

/**
 * Adventure content fields (Foundry 13.351 BaseAdventure schema) with their document names, in
 * the order this lane CREATES them: folders first so documents land in their folders, scenes after
 * the actors their tokens point at, combats last. Removal uses the reverse order.
 */
export const ADVENTURE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['folders', 'Folder'],
  ['actors', 'Actor'],
  ['items', 'Item'],
  ['journal', 'JournalEntry'],
  ['tables', 'RollTable'],
  ['macros', 'Macro'],
  ['cards', 'Cards'],
  ['playlists', 'Playlist'],
  ['scenes', 'Scene'],
  ['combats', 'Combat'],
];

export const WORLD_DOCUMENT_NAMES: string[] = ADVENTURE_FIELDS.map(([, name]) => name);

/** Embedded collections by parent document name: field -> embedded document name (Foundry 13). */
export const EMBEDDED_FIELDS: Record<string, Record<string, string>> = {
  Scene: {
    walls: 'Wall',
    lights: 'AmbientLight',
    regions: 'Region',
    notes: 'Note',
    tokens: 'Token',
    tiles: 'Tile',
    drawings: 'Drawing',
    sounds: 'AmbientSound',
    templates: 'MeasuredTemplate',
  },
  Region: { behaviors: 'RegionBehavior' },
  JournalEntry: { pages: 'JournalEntryPage' },
  Actor: { items: 'Item', effects: 'ActiveEffect' },
  Item: { effects: 'ActiveEffect' },
  RollTable: { results: 'TableResult' },
  Playlist: { sounds: 'PlaylistSound' },
  Cards: { cards: 'Card' },
  Combat: { combatants: 'Combatant' },
};

/**
 * flags.aidm keys this lane writes for its own bookkeeping. They are never part of a content hash
 * or a merge: module (which module made it), build (which build it is at), adventure (which
 * Adventure in the pack it came from), hash (the content hash of the build data it was last
 * written from, top-level documents only).
 */
export const BOOKKEEPING_AIDM_KEYS = ['module', 'build', 'adventure', 'hash'] as const;

export interface AidmTags {
  module: string;
  build: number;
  adventure: string;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Writes flags.aidm.module / build / adventure onto a document's data and every embedded document
 * inside it (walls, tokens, region behaviors, journal pages, actor items ...), and flags.aidm.hash
 * onto the top-level document only. Mutates `data`. Returns how many documents were stamped.
 */
export function stampTags(
  data: any,
  documentName: string,
  tags: AidmTags,
  hash: string | null = null
): number {
  if (!isPlainObject(data)) return 0;
  data.flags = isPlainObject(data.flags) ? data.flags : {};
  data.flags.aidm = isPlainObject(data.flags.aidm) ? data.flags.aidm : {};
  data.flags.aidm.module = tags.module;
  data.flags.aidm.build = tags.build;
  data.flags.aidm.adventure = tags.adventure;
  if (hash !== null) data.flags.aidm.hash = hash;
  let n = 1;
  for (const [field, childName] of Object.entries(EMBEDDED_FIELDS[documentName] ?? {})) {
    for (const child of Array.isArray(data[field]) ? data[field] : []) {
      n += stampTags(child, childName, tags, null);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Canonical JSON and the content hash

function canonical(value: any, parentKeys: string[]): any {
  if (Array.isArray(value)) return value.map(v => canonical(v, parentKeys));
  if (!isPlainObject(value)) return value;
  const out: Record<string, any> = {};
  const inAidm =
    parentKeys.length >= 2 &&
    parentKeys[parentKeys.length - 1] === 'aidm' &&
    parentKeys[parentKeys.length - 2] === 'flags';
  for (const key of Object.keys(value).sort()) {
    if (key === '_stats') continue;
    if (inAidm && (BOOKKEEPING_AIDM_KEYS as readonly string[]).includes(key)) continue;
    const v = value[key];
    if (v === undefined) continue;
    out[key] = canonical(v, [...parentKeys, key]);
  }
  return out;
}

/** One text form of a value: sorted keys, no _stats, no bookkeeping flags. */
export function canonicalJson(value: any): string {
  return JSON.stringify(canonical(value, [])) ?? 'undefined';
}

export function sameValue(a: any, b: any): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * A 16 hex digit fingerprint of a document's content (two 32-bit FNV-1a passes with different
 * starting values over its canonical JSON). For change detection only, not security. crypto.subtle
 * is not used on purpose: the headless GM client runs on plain http, where it does not exist.
 */
export function contentHash(value: any): string {
  const text = canonicalJson(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
    h2 = (h2 ^ (h2 >>> 15)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function shortHash(lines: string[]): string {
  return contentHash(lines.join('\n')).slice(0, 8);
}

// ---------------------------------------------------------------------------------------------
// Adventures in a module pack

export type AdventurePart = 'core' | 'map' | 'journal' | 'other';

/** Which part of the book an Adventure holds, read from the packer's flags.aidm.part. */
export function adventurePart(flags: any): AdventurePart {
  const part = flags?.aidm?.part;
  if (part === 'core') return 'core';
  if (part === 'journal') return 'journal';
  if (isPlainObject(part) && 'page' in part) return 'map';
  return 'other';
}

export interface AdventureEntry {
  id: string;
  name: string | null;
  part: AdventurePart;
  sort: number;
}

/** Install order: the core Adventure first (tokens point at its actors), then maps, then text. */
export function sortAdventuresForInstall(entries: AdventureEntry[]): AdventureEntry[] {
  const rank: Record<AdventurePart, number> = { core: 0, map: 1, journal: 2, other: 3 };
  return entries
    .slice()
    .sort(
      (a, b) =>
        rank[a.part] - rank[b.part] ||
        (a.sort ?? 0) - (b.sort ?? 0) ||
        String(a.name ?? '').localeCompare(String(b.name ?? '')) ||
        a.id.localeCompare(b.id)
    );
}

/** Every top-level document in Adventure data, in create order: [{type, id, name, data}]. */
export function adventureDocuments(
  adventureData: any
): { type: string; id: string; name: string | null; data: any }[] {
  const out: { type: string; id: string; name: string | null; data: any }[] = [];
  for (const [field, type] of ADVENTURE_FIELDS) {
    for (const doc of Array.isArray(adventureData?.[field]) ? adventureData[field] : []) {
      const id = doc?._id;
      if (typeof id === 'string' && id) out.push({ type, id, name: doc?.name ?? null, data: doc });
    }
  }
  return out;
}

/**
 * Embedded document counts inside one document's data, by path: {"walls": 12,
 * "regions.behaviors": 3, "pages": 4}. Nested counts add up over every parent at that path.
 */
export function embeddedCounts(documentName: string, data: any): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (name: string, doc: any, prefix: string) => {
    for (const [field, childName] of Object.entries(EMBEDDED_FIELDS[name] ?? {})) {
      const arr = Array.isArray(doc?.[field]) ? doc[field] : [];
      if (!arr.length) continue;
      const path = prefix ? `${prefix}.${field}` : field;
      out[path] = (out[path] ?? 0) + arr.length;
      for (const child of arr) walk(childName, child, path);
    }
  };
  walk(documentName, data, '');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Install planning

/** What the world holds under one top-level id. */
export interface WorldDocInfo {
  exists: boolean;
  /** Stored but not loaded because its data failed Foundry's checks (invalidDocumentIds). */
  invalid: boolean;
  name: string | null;
  module: string | null;
  adventure: string | null;
  build: number | null;
}

export type WorldLookup = (documentName: string, id: string) => WorldDocInfo;

export type InstallConflictReason =
  | 'id-taken-untagged'
  | 'id-taken-other-module'
  | 'id-taken-other-adventure'
  | 'id-taken-invalid';

export interface InstallConflict {
  type: string;
  id: string;
  name: string | null;
  reason: InstallConflictReason;
  tagged_module: string | null;
}

export type InstallState =
  | 'not_installed'
  | 'installed'
  | 'installed_other_build'
  | 'partial'
  | 'conflicts';

export interface InstallPlan {
  module_id: string;
  adventure_id: string;
  adventure_name: string | null;
  build: number;
  state: InstallState;
  create: { type: string; id: string; name: string | null; embedded: Record<string, number> }[];
  already_installed: { type: string; id: string; name: string | null; build: number | null }[];
  conflicts: InstallConflict[];
  counts: { documents: Record<string, number>; embedded: Record<string, number> };
  plan_id: string;
}

/**
 * Decides, for every top-level document in one Adventure, whether an install creates it, finds it
 * already installed (tagged with this module and this Adventure), or is blocked by it. It never
 * plans an update or a replacement: an id the world already uses for anything else (an untagged
 * document, another module's, another Adventure's, or a stored document Foundry could not load) is
 * a conflict, and a plan with any conflict must write nothing.
 */
export function planModuleInstall(opts: {
  moduleId: string;
  build: number;
  adventureId: string;
  adventureName: string | null;
  adventureData: any;
  lookup: WorldLookup;
}): InstallPlan {
  const plan: InstallPlan = {
    module_id: opts.moduleId,
    adventure_id: opts.adventureId,
    adventure_name: opts.adventureName,
    build: opts.build,
    state: 'not_installed',
    create: [],
    already_installed: [],
    conflicts: [],
    counts: { documents: {}, embedded: {} },
    plan_id: '',
  };
  for (const doc of adventureDocuments(opts.adventureData)) {
    plan.counts.documents[doc.type] = (plan.counts.documents[doc.type] ?? 0) + 1;
    const embedded = embeddedCounts(doc.type, doc.data);
    for (const [path, n] of Object.entries(embedded)) {
      const key = `${doc.type}.${path}`;
      plan.counts.embedded[key] = (plan.counts.embedded[key] ?? 0) + n;
    }
    const w = opts.lookup(doc.type, doc.id);
    if (w.invalid && !w.exists) {
      plan.conflicts.push({
        type: doc.type,
        id: doc.id,
        name: doc.name,
        reason: 'id-taken-invalid',
        tagged_module: null,
      });
      continue;
    }
    if (!w.exists) {
      plan.create.push({ type: doc.type, id: doc.id, name: doc.name, embedded });
      continue;
    }
    if (w.module === opts.moduleId && w.adventure === opts.adventureId) {
      plan.already_installed.push({ type: doc.type, id: doc.id, name: w.name, build: w.build });
      continue;
    }
    plan.conflicts.push({
      type: doc.type,
      id: doc.id,
      name: w.name ?? doc.name,
      reason:
        w.module === opts.moduleId
          ? 'id-taken-other-adventure'
          : w.module
            ? 'id-taken-other-module'
            : 'id-taken-untagged',
      tagged_module: w.module,
    });
  }
  if (plan.conflicts.length) plan.state = 'conflicts';
  else if (!plan.already_installed.length) plan.state = 'not_installed';
  else if (!plan.create.length)
    plan.state = plan.already_installed.every(d => d.build === opts.build)
      ? 'installed'
      : 'installed_other_build';
  else plan.state = 'partial';
  plan.plan_id = installPlanId(plan);
  return plan;
}

/** mi-<documents to create>-<8 hex>: a short hash of everything the plan decided. */
export function installPlanId(plan: InstallPlan): string {
  const lines = [
    `module:${plan.module_id}`,
    `adventure:${plan.adventure_id}`,
    `build:${plan.build}`,
    `state:${plan.state}`,
    ...plan.create.map(d => `C:${d.type}:${d.id}:${canonicalJson(d.embedded)}`).sort(),
    ...plan.already_installed.map(d => `A:${d.type}:${d.id}:${d.build}`).sort(),
    ...plan.conflicts.map(c => `X:${c.type}:${c.id}:${c.reason}`).sort(),
  ];
  return `mi-${plan.create.length}-${shortHash(lines)}`;
}

export function summarizeInstallConflicts(conflicts: InstallConflict[]): string {
  const why: Record<InstallConflictReason, string> = {
    'id-taken-untagged':
      'the world already has a document with this id that this module did not make',
    'id-taken-other-module': 'the world already has a document with this id made by another module',
    'id-taken-other-adventure':
      'the world already has a document with this id from another Adventure of this module',
    'id-taken-invalid':
      "the world stores a document with this id that failed Foundry's data checks, and creating it would silently replace that record",
  };
  const shown = conflicts
    .slice(0, 10)
    .map(c => `${c.type} "${c.name ?? '(unnamed)'}" (${c.id}): ${why[c.reason]}`)
    .join('; ');
  return (
    `Refused: installing would overwrite ${conflicts.length} existing world document(s). ` +
    `Nothing was created or changed. ${shown}${
      conflicts.length > 10 ? `; and ${conflicts.length - 10} more` : ''
    }.`
  );
}

// ---------------------------------------------------------------------------------------------
// Read-back after an install

export interface ReadBackDoc {
  type: string;
  id: string;
  /** In the client collection. */
  present: boolean;
  /** In the collection's invalidDocumentIds (Foundry stored it but could not load it). */
  invalid: boolean;
  tags: { module: any; build: any; adventure: any };
  /** Live embedded counts by path (see embeddedCounts). */
  embedded: Record<string, number>;
  /** Embedded documents Foundry could not load (embedded invalidDocumentIds), by path. */
  embeddedInvalid: Record<string, number>;
}

/**
 * Compares what an install call created with what it asked Foundry to create. Any missing or
 * invalid document, any missing tag, and any embedded count that differs is a problem. An empty
 * list is the only pass.
 */
export function verifyInstallReadBack(opts: {
  expected: { type: string; id: string; data: any }[];
  createdIds: { type: string; id: string }[];
  readBack: ReadBackDoc[];
  tags: AidmTags;
}): string[] {
  const problems: string[] = [];
  const created = new Set(opts.createdIds.map(d => `${d.type}:${d.id}`));
  const byKey = new Map(opts.readBack.map(r => [`${r.type}:${r.id}`, r]));
  const expectedCount: Record<string, number> = {};
  const createdCount: Record<string, number> = {};
  for (const d of opts.createdIds) createdCount[d.type] = (createdCount[d.type] ?? 0) + 1;
  for (const e of opts.expected) {
    expectedCount[e.type] = (expectedCount[e.type] ?? 0) + 1;
    const label = `${e.type} ${e.id}`;
    const r = byKey.get(`${e.type}:${e.id}`);
    if (!created.has(`${e.type}:${e.id}`)) {
      problems.push(`${label}: Foundry did not report it as created`);
    }
    if (!r || (!r.present && !r.invalid)) {
      problems.push(`${label}: not in the world after the import`);
      continue;
    }
    if (r.invalid) {
      problems.push(
        `${label}: Foundry stored it but could not load it (it is in invalidDocumentIds)`
      );
      continue;
    }
    if (
      r.tags.module !== opts.tags.module ||
      r.tags.build !== opts.tags.build ||
      r.tags.adventure !== opts.tags.adventure
    ) {
      problems.push(`${label}: its flags.aidm module/build/adventure tags are missing or wrong`);
    }
    const want = embeddedCounts(e.type, e.data);
    for (const path of new Set([...Object.keys(want), ...Object.keys(r.embedded)])) {
      const a = want[path] ?? 0;
      const b = r.embedded[path] ?? 0;
      if (a !== b) problems.push(`${label}: ${path} holds ${b}, the Adventure has ${a}`);
    }
    for (const [path, n] of Object.entries(r.embeddedInvalid)) {
      if (n > 0) {
        problems.push(`${label}: ${n} embedded ${path} document(s) failed Foundry's data checks`);
      }
    }
  }
  for (const type of new Set([...Object.keys(expectedCount), ...Object.keys(createdCount)])) {
    if ((expectedCount[type] ?? 0) !== (createdCount[type] ?? 0)) {
      problems.push(
        `${type}: Foundry reported ${createdCount[type] ?? 0} created, the Adventure has ${
          expectedCount[type] ?? 0
        }`
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// In play, and play began

/**
 * Facts about one scene, read right before a decision. A value that could not be read is null,
 * and null always counts as "in play" (never act on a guess), like the brain's delete rule
 * (brain/app.py _adventure_delete_scenes_in_play) and the importer's
 * (dnd-dm-ingest/src/board_prep.py live_play_on_scene).
 */
export interface SceneFacts {
  id: string;
  name: string | null;
  /** Scene.active */
  active: boolean | null;
  /** Names of tokens whose actor is a player character (actor type "character"). */
  pc_tokens: string[] | null;
  /** Combat documents set on this scene. */
  combats: number | null;
  /** Connected users other than this GM client who are looking at this scene. */
  viewers: number | null;
  /** Play-state flags already written on this scene (see scenePlayBeganReasons). */
  play_flags: {
    encounters_started: number;
    traps_sprung: number;
    items_taken: number;
    tokens_with_last_area: number;
  } | null;
}

/** Plain reasons a scene is in play right now. Empty means not in play. */
export function sceneInPlayReasons(f: SceneFacts): string[] {
  const reasons: string[] = [];
  if (f.active === true) reasons.push('it is the active scene');
  else if (f.active !== false) reasons.push('could not read whether it is the active scene');
  if (!Array.isArray(f.pc_tokens)) reasons.push('could not read which tokens are on it');
  else if (f.pc_tokens.length) {
    const names = f.pc_tokens.filter(n => String(n ?? '').trim());
    reasons.push(
      names.length
        ? `player character token(s) on it: ${names.join(', ')}`
        : `${f.pc_tokens.length} player character token(s) on it`
    );
  }
  if (f.combats === null) reasons.push('could not read its combats');
  else if (f.combats > 0) reasons.push(`${f.combats} combat(s) are set on it`);
  if (f.viewers === null) reasons.push('could not read who is looking at it');
  else if (f.viewers > 0) reasons.push(`${f.viewers} connected user(s) are looking at it`);
  return reasons;
}

/**
 * Plain reasons play has begun on a scene: it is in play now, or the play state the brain writes is
 * already on it (an encounter started, a trap sprung, an item taken, a token's last area). After
 * play began, door states, token positions and hidden state are play state (design 4.4.5).
 */
export function scenePlayBeganReasons(f: SceneFacts, forced = false): string[] {
  const reasons = sceneInPlayReasons(f);
  if (forced) reasons.push('the caller said play has begun on it');
  const p = f.play_flags;
  if (!p) reasons.push('could not read its play-state flags');
  else {
    if (p.encounters_started) reasons.push(`${p.encounters_started} encounter(s) started`);
    if (p.traps_sprung) reasons.push(`${p.traps_sprung} trap(s) sprung`);
    if (p.items_taken) reasons.push(`${p.items_taken} item(s) taken`);
    if (p.tokens_with_last_area) reasons.push(`${p.tokens_with_last_area} token(s) have moved`);
  }
  return reasons;
}

/** Counts the play-state flags on a scene's data (regions' records, tokens' lastArea). */
export function playFlagCounts(sceneData: any): NonNullable<SceneFacts['play_flags']> {
  const out = { encounters_started: 0, traps_sprung: 0, items_taken: 0, tokens_with_last_area: 0 };
  for (const region of Array.isArray(sceneData?.regions) ? sceneData.regions : []) {
    const aidm = region?.flags?.aidm ?? {};
    for (const e of Array.isArray(aidm.encounter) ? aidm.encounter : []) {
      if (e?.started) out.encounters_started += 1;
    }
    for (const key of ['trap', 'hazard']) {
      for (const t of Array.isArray(aidm[key]) ? aidm[key] : [])
        if (t?.sprung) out.traps_sprung += 1;
    }
    if (Array.isArray(aidm.itemsTaken)) out.items_taken += aidm.itemsTaken.length;
  }
  for (const token of Array.isArray(sceneData?.tokens) ? sceneData.tokens : []) {
    const last = token?.flags?.aidm?.lastArea;
    if (last !== undefined && last !== null) out.tokens_with_last_area += 1;
  }
  return out;
}

/**
 * The connected-user rule for anything that reloads the world (enable, disable, remove): refused
 * unless it is PROVEN that no user other than this GM client is connected. `names` null means the
 * list could not be read. Returns the refusal text, or null when it may go ahead.
 */
export function connectedRefusal(names: string[] | null): string | null {
  if (names === null) {
    return 'Refused: could not read who is connected, so nobody is provably absent. Nothing was changed.';
  }
  if (names.length) {
    return (
      `Refused: ${names.length} other user(s) are connected. This step reloads the world for ` +
      'everyone, so it only runs when nobody else is connected. Nothing was changed.'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Three-way merge for an update

/**
 * Paths that are play state on every document of that type, always: an update never writes them.
 * "*" applies to every type. A path covers everything under it.
 */
export const ALWAYS_PLAY_STATE: Record<string, string[]> = {
  '*': ['flags.aidm.itemsTaken', 'flags.aidm.lastArea'],
  Scene: ['active', 'fog.reset'],
  Actor: [
    'system.attributes.hp.value',
    'system.attributes.hp.temp',
    'system.attributes.hp.tempmax',
    'system.attributes.death',
    'system.attributes.exhaustion',
  ],
  Token: ['delta'],
};

/** Paths that become play state once play began on the scene that holds the document. */
export const PLAY_BEGAN_STATE: Record<string, string[]> = {
  Wall: ['ds'],
  Token: ['x', 'y', 'elevation', 'hidden', 'rotation'],
  AmbientLight: ['hidden'],
  AmbientSound: ['hidden'],
};

/** Embedded document types an update never creates or deletes once play began on their scene. */
export const NO_CREATE_DELETE_AFTER_PLAY: ReadonlySet<string> = new Set(['Token']);

/** Record arrays whose elements carry a play-state key the brain writes (design 5.2). */
export const PLAY_RECORD_ARRAYS: Record<string, string> = {
  'flags.aidm.encounter': 'started',
  'flags.aidm.trap': 'sprung',
  'flags.aidm.hazard': 'sprung',
};

function coveredBy(path: string, list: string[] | undefined): boolean {
  return !!list && list.some(q => path === q || path.startsWith(`${q}.`));
}

export function isPlayStatePath(documentName: string, path: string, playBegan: boolean): boolean {
  return (
    coveredBy(path, ALWAYS_PLAY_STATE['*']) ||
    coveredBy(path, ALWAYS_PLAY_STATE[documentName]) ||
    (playBegan && coveredBy(path, PLAY_BEGAN_STATE[documentName]))
  );
}

/**
 * Leaf values of a document's own fields, by dotted path. Plain objects are walked; arrays and
 * everything else are leaves (an empty object is a leaf too). Left out: _id, _stats (anywhere),
 * flags.aidm bookkeeping keys, and the document's embedded collections (merged as documents).
 */
export function leafValues(documentName: string, data: any): Map<string, any> {
  const out = new Map<string, any>();
  const embedded = new Set(Object.keys(EMBEDDED_FIELDS[documentName] ?? {}));
  const walk = (value: any, path: string) => {
    if (!isPlainObject(value) || !Object.keys(value).length) {
      if (path) out.set(path, value);
      return;
    }
    for (const key of Object.keys(value)) {
      if (key === '_stats') continue;
      if (!path && (key === '_id' || embedded.has(key))) continue;
      if (path === 'flags.aidm' && (BOOKKEEPING_AIDM_KEYS as readonly string[]).includes(key)) {
        continue;
      }
      const v = value[key];
      if (v === undefined) continue;
      walk(v, path ? `${path}.${key}` : key);
    }
  };
  walk(data, '');
  return out;
}

export interface MergeNote {
  path: string;
  reason: string;
}

export interface FieldMerge {
  /** Paths to write, with the value to write. */
  set: Record<string, any>;
  /** Paths to remove (the new build no longer has them and nobody changed them). */
  unset: string[];
  /** Importer changes NOT written because the world value was changed since the import. */
  kept: MergeNote[];
  /** Importer changes NOT written because the path is play state. */
  protected: MergeNote[];
}

function stripKey(arr: any, key: string): any {
  return Array.isArray(arr)
    ? arr.map(el => {
        if (!isPlainObject(el)) return el;
        return Object.fromEntries(Object.entries(el).filter(([k]) => k !== key));
      })
    : arr;
}

/**
 * Three-way merge of one document's own fields (not its embedded documents):
 *  - the new build did not change a path (base == target): nothing is written;
 *  - the world already holds the new value: nothing is written;
 *  - the world still holds what the importer wrote last time (world == base): the new value is
 *    written (or the path removed, when the new build dropped it);
 *  - otherwise someone changed it since the import: it is KEPT and reported.
 * Play-state paths are never written. For the record arrays (encounter, trap, hazard) the
 * play-state key is compared out, and an element whose play-state key is already set is kept as it
 * is; other elements take the new value with the world's play-state key carried over.
 * `base` null means there is no earlier build data for this document (every difference is kept).
 */
export function mergeFields(opts: {
  documentName: string;
  /** null: no earlier build data for this document */
  base: any;
  target: any;
  world: any;
  playBegan: boolean;
}): FieldMerge {
  const res: FieldMerge = { set: {}, unset: [], kept: [], protected: [] };
  const b = opts.base === null ? new Map<string, any>() : leafValues(opts.documentName, opts.base);
  const t = leafValues(opts.documentName, opts.target);
  const w = leafValues(opts.documentName, opts.world);
  const paths = Array.from(new Set([...b.keys(), ...t.keys()])).sort();
  for (const path of paths) {
    const bv = b.get(path);
    const tv = t.get(path);
    const wv = w.get(path);
    if (sameValue(bv, tv) && opts.base !== null) continue;
    if (isPlayStatePath(opts.documentName, path, opts.playBegan)) {
      if (!sameValue(wv, tv)) res.protected.push({ path, reason: 'play state' });
      continue;
    }
    const playKey = PLAY_RECORD_ARRAYS[path];
    if (playKey && Array.isArray(tv)) {
      const sb = stripKey(bv, playKey);
      const st = stripKey(tv, playKey);
      const sw = stripKey(wv, playKey);
      if (sameValue(sb, st) && opts.base !== null) continue;
      if (sameValue(sw, st)) continue;
      const canWrite = opts.base !== null ? sameValue(sw, sb) : wv === undefined;
      if (!canWrite) {
        res.kept.push({
          path,
          reason:
            opts.base === null ? 'no earlier build to compare with' : 'changed since the import',
        });
        continue;
      }
      const wArr = Array.isArray(wv) ? wv : [];
      const merged = tv.map((el: any, i: number) => {
        const wel = wArr[i];
        if (isPlainObject(wel) && wel[playKey]) {
          res.protected.push({ path: `${path}.${i}`, reason: `play state (${playKey})` });
          return clone(wel);
        }
        if (isPlainObject(el) && isPlainObject(wel) && playKey in wel) {
          return { ...clone(el), [playKey]: wel[playKey] };
        }
        return clone(el);
      });
      if (!sameValue(merged, wv)) res.set[path] = merged;
      continue;
    }
    if (sameValue(wv, tv)) continue;
    if (opts.base !== null ? sameValue(wv, bv) : wv === undefined) {
      if (tv === undefined) res.unset.push(path);
      else res.set[path] = clone(tv);
    } else {
      res.kept.push({
        path,
        reason:
          opts.base === null ? 'no earlier build to compare with' : 'changed since the import',
      });
    }
  }
  // An object that turns from empty into a filled one (or back) shows up both as a leaf and as
  // paths under it. Never send a delete and a write for the same object in one update.
  const setPaths = Object.keys(res.set);
  res.unset = res.unset.filter(u => !setPaths.some(s => s.startsWith(`${u}.`)));
  for (const s of setPaths) {
    const v = res.set[s];
    if (isPlainObject(v) && !Object.keys(v).length && res.unset.some(u => u.startsWith(`${s}.`))) {
      delete res.set[s];
    }
  }
  return res;
}

/** True when a document (and every embedded document under it) still holds the base values. */
export function unchangedSinceBase(documentName: string, base: any, world: any): boolean {
  const b = leafValues(documentName, base);
  const w = leafValues(documentName, world);
  for (const [path, value] of b) if (!sameValue(value, w.get(path))) return false;
  for (const path of w.keys()) if (!b.has(path)) return false;
  for (const [field, childName] of Object.entries(EMBEDDED_FIELDS[documentName] ?? {})) {
    const bArr: any[] = Array.isArray(base?.[field]) ? base[field] : [];
    const wArr: any[] = Array.isArray(world?.[field]) ? world[field] : [];
    if (bArr.length !== wArr.length) return false;
    const wById = new Map(wArr.map(d => [d?._id, d]));
    for (const bd of bArr) {
      const wd = wById.get(bd?._id);
      if (!wd || !unchangedSinceBase(childName, bd, wd)) return false;
    }
  }
  return true;
}

/** Where an embedded document lives: the chain of parents from the top-level document down. */
export interface ParentRef {
  type: string;
  id: string;
  field: string | null;
  parent: ParentRef | null;
}

export type UpdateOp =
  | {
      action: 'create';
      type: string;
      id: string;
      parent: ParentRef | null;
      field: string | null;
      data: any;
    }
  | {
      action: 'update';
      type: string;
      id: string;
      parent: ParentRef | null;
      field: string | null;
      set: Record<string, any>;
      unset: string[];
      /** true when nothing but the build tag (and hash) changes */
      bump_only: boolean;
      /** the top-level content hash to record (null for embedded documents) */
      hash: string | null;
    }
  | { action: 'delete'; type: string; id: string; parent: ParentRef | null; field: string | null };

export interface UpdateNote {
  type: string;
  id: string;
  parent_id: string | null;
  path: string | null;
  reason: string;
}

export interface UpdatePlan {
  module_id: string;
  adventure_id: string;
  base_build: number;
  target_build: number;
  ops: UpdateOp[];
  kept: UpdateNote[];
  protected: UpdateNote[];
  skipped: UpdateNote[];
  in_play: { scene_id: string; name: string | null; reasons: string[] }[];
  play_began: { scene_id: string; reasons: string[] }[];
  summary: {
    create: number;
    update: number;
    fields_written: number;
    delete: number;
    build_tag_only: number;
    kept_changes: number;
    protected_play_state: number;
    skipped: number;
  };
  plan_id: string;
}

function isOurs(doc: any, moduleId: string): boolean {
  return doc?.flags?.aidm?.module === moduleId;
}

/**
 * The update plan for one Adventure: base (the build the world copy was installed or last updated
 * from), target (the new build), both as Foundry-cleaned Adventure data, and the world's current
 * data for every top-level id either of them holds. Rules, per top-level document:
 *  - in both builds and in the world, tagged with this module and Adventure: its fields and its
 *    embedded documents are merged (mergeFields), and it is re-tagged with the new build;
 *  - its scene is in play right now: skipped whole (deferred), nothing on it changes;
 *  - it is at a build that is neither base nor target: skipped;
 *  - its recorded content hash does not match the base data given: skipped (the base is not what
 *    was installed), unless acceptBaseMismatch;
 *  - in the target only and free in the world: created, tagged;
 *  - in the base only (the new build dropped it), unchanged since the import, and not a scene
 *    where play began: deleted; otherwise kept and reported;
 *  - in the base and target but gone from the world: someone deleted it; it stays deleted;
 *  - an id the world uses for a document this module did not make: skipped, never touched.
 * Embedded documents follow the same rules inside their parent. A document someone added (not
 * tagged with this module) is never touched.
 */
export function planModuleUpdate(opts: {
  moduleId: string;
  adventureId: string;
  baseBuild: number;
  targetBuild: number;
  base: any;
  target: any;
  /** World data (toObject) by `${type}:${id}` for every top-level id in base or target. */
  world: Map<string, any>;
  /** Stored-but-invalid world ids by `${type}:${id}`. */
  invalid: Set<string>;
  sceneFacts: Map<string, SceneFacts>;
  forcePlayBegan?: Set<string>;
  acceptBaseMismatch?: boolean;
}): UpdatePlan {
  const plan: UpdatePlan = {
    module_id: opts.moduleId,
    adventure_id: opts.adventureId,
    base_build: opts.baseBuild,
    target_build: opts.targetBuild,
    ops: [],
    kept: [],
    protected: [],
    skipped: [],
    in_play: [],
    play_began: [],
    summary: {
      create: 0,
      update: 0,
      fields_written: 0,
      delete: 0,
      build_tag_only: 0,
      kept_changes: 0,
      protected_play_state: 0,
      skipped: 0,
    },
    plan_id: '',
  };
  const baseDocs = new Map(adventureDocuments(opts.base).map(d => [`${d.type}:${d.id}`, d]));
  const targetDocs = new Map(adventureDocuments(opts.target).map(d => [`${d.type}:${d.id}`, d]));
  const keys = Array.from(new Set([...targetDocs.keys(), ...baseDocs.keys()]));
  const note = (
    list: UpdateNote[],
    type: string,
    id: string,
    parent: ParentRef | null,
    path: string | null,
    reason: string
  ) => list.push({ type, id, parent_id: parent ? parent.id : null, path, reason });

  const playBeganFor = (sceneId: string | null): boolean => {
    if (!sceneId) return false;
    const f = opts.sceneFacts.get(sceneId);
    if (!f) return true;
    return scenePlayBeganReasons(f, !!opts.forcePlayBegan?.has(sceneId)).length > 0;
  };

  const mergeEmbedded = (
    parentType: string,
    parentRef: ParentRef,
    bParent: any,
    tParent: any,
    wParent: any,
    sceneId: string | null
  ) => {
    const playBegan = playBeganFor(sceneId);
    for (const [field, childType] of Object.entries(EMBEDDED_FIELDS[parentType] ?? {})) {
      const bArr: any[] = Array.isArray(bParent?.[field]) ? bParent[field] : [];
      const tArr: any[] = Array.isArray(tParent?.[field]) ? tParent[field] : [];
      const wArr: any[] = Array.isArray(wParent?.[field]) ? wParent[field] : [];
      const bById = new Map(bArr.map(d => [d?._id, d]));
      const tById = new Map(tArr.map(d => [d?._id, d]));
      const wById = new Map(wArr.map(d => [d?._id, d]));
      const ids = Array.from(new Set([...tById.keys(), ...bById.keys()])).filter(
        (id): id is string => typeof id === 'string' && !!id
      );
      for (const id of ids) {
        const bd = bById.get(id);
        const td = tById.get(id);
        const wd = wById.get(id);
        const ref: ParentRef = { type: childType, id, field, parent: parentRef };
        if (td && !bd) {
          if (!wd) {
            if (playBegan && NO_CREATE_DELETE_AFTER_PLAY.has(childType)) {
              note(
                plan.protected,
                childType,
                id,
                parentRef,
                null,
                'play began: new tokens are not placed'
              );
            } else {
              plan.ops.push({
                action: 'create',
                type: childType,
                id,
                parent: parentRef,
                field,
                data: clone(td),
              });
            }
          } else if (isOurs(wd, opts.moduleId)) {
            pushMerge(childType, id, parentRef, field, null, td, wd, playBegan, null);
            mergeEmbedded(childType, ref, null, td, wd, sceneId);
          } else {
            note(
              plan.skipped,
              childType,
              id,
              parentRef,
              null,
              'an embedded document this module did not make has this id'
            );
          }
          continue;
        }
        if (bd && !td) {
          if (!wd || !isOurs(wd, opts.moduleId)) continue;
          if (playBegan && NO_CREATE_DELETE_AFTER_PLAY.has(childType)) {
            note(
              plan.protected,
              childType,
              id,
              parentRef,
              null,
              'play began: tokens are not removed'
            );
          } else if (unchangedSinceBase(childType, bd, wd)) {
            plan.ops.push({ action: 'delete', type: childType, id, parent: parentRef, field });
          } else {
            note(
              plan.kept,
              childType,
              id,
              parentRef,
              null,
              'the new build removes it, but it was changed since the import'
            );
          }
          continue;
        }
        if (!wd) {
          note(
            plan.kept,
            childType,
            id,
            parentRef,
            null,
            'deleted since the import; it stays deleted'
          );
          continue;
        }
        if (!isOurs(wd, opts.moduleId)) {
          note(
            plan.skipped,
            childType,
            id,
            parentRef,
            null,
            'an embedded document this module did not make has this id'
          );
          continue;
        }
        pushMerge(childType, id, parentRef, field, bd, td, wd, playBegan, null);
        mergeEmbedded(childType, ref, bd, td, wd, sceneId);
      }
    }
  };

  const pushMerge = (
    type: string,
    id: string,
    parent: ParentRef | null,
    field: string | null,
    bd: any,
    td: any,
    wd: any,
    playBegan: boolean,
    hash: string | null
  ) => {
    const m = mergeFields({ documentName: type, base: bd, target: td, world: wd, playBegan });
    for (const k of m.kept) note(plan.kept, type, id, parent, k.path, k.reason);
    for (const p of m.protected) note(plan.protected, type, id, parent, p.path, p.reason);
    const changes = Object.keys(m.set).length + m.unset.length;
    const wBuild = wd?.flags?.aidm?.build;
    const hashChanged = hash !== null && wd?.flags?.aidm?.hash !== hash;
    // Top-level documents are re-tagged with the new build even when no field changes, so the
    // world's build is plain to read. Embedded documents are written only when a field changes.
    const retag = parent === null && (wBuild !== opts.targetBuild || hashChanged);
    if (changes || retag) {
      plan.ops.push({
        action: 'update',
        type,
        id,
        parent,
        field,
        set: m.set,
        unset: m.unset,
        bump_only: changes === 0,
        hash,
      });
    }
  };

  for (const key of keys) {
    const bd = baseDocs.get(key);
    const td = targetDocs.get(key);
    const type = (td ?? bd)!.type;
    const id = (td ?? bd)!.id;
    const wd = opts.world.get(key);
    const sceneId = type === 'Scene' ? id : null;
    if (sceneId) {
      const f = opts.sceneFacts.get(sceneId);
      if (f && wd) {
        const inPlay = sceneInPlayReasons(f);
        if (inPlay.length) {
          plan.in_play.push({ scene_id: id, name: f.name, reasons: inPlay });
          note(
            plan.skipped,
            type,
            id,
            null,
            null,
            `in play right now (${inPlay.join('; ')}); run the update again later`
          );
          continue;
        }
        const began = scenePlayBeganReasons(f, !!opts.forcePlayBegan?.has(sceneId));
        if (began.length) plan.play_began.push({ scene_id: id, reasons: began });
      }
    }
    if (!wd) {
      if (opts.invalid.has(key)) {
        note(
          plan.skipped,
          type,
          id,
          null,
          null,
          "the world stores a document with this id that failed Foundry's data checks"
        );
        continue;
      }
      if (td && !bd) {
        const data = clone(td.data);
        plan.ops.push({ action: 'create', type, id, parent: null, field: null, data });
      } else if (bd && td) {
        note(plan.kept, type, id, null, null, 'deleted since the import; it stays deleted');
      }
      continue;
    }
    const tags = wd?.flags?.aidm ?? {};
    if (tags.module !== opts.moduleId || tags.adventure !== opts.adventureId) {
      note(
        plan.skipped,
        type,
        id,
        null,
        null,
        tags.module
          ? `tagged with ${tags.module} / ${tags.adventure}, not this Adventure`
          : 'a document this module did not make has this id'
      );
      continue;
    }
    if (tags.build !== opts.baseBuild && tags.build !== opts.targetBuild) {
      note(
        plan.skipped,
        type,
        id,
        null,
        null,
        `it is at build ${tags.build}, not the base build ${opts.baseBuild} or the new build ${opts.targetBuild}`
      );
      continue;
    }
    if (
      bd &&
      tags.build === opts.baseBuild &&
      typeof tags.hash === 'string' &&
      tags.hash !== contentHash(bd.data) &&
      !opts.acceptBaseMismatch
    ) {
      note(
        plan.skipped,
        type,
        id,
        null,
        null,
        'the base data given is not the data this document was installed from (content hash differs)'
      );
      continue;
    }
    const playBegan = playBeganFor(sceneId);
    if (bd && !td) {
      if (sceneId && playBegan) {
        note(
          plan.kept,
          type,
          id,
          null,
          null,
          'the new build removes this scene, but play has begun on it'
        );
      } else if (unchangedSinceBase(type, bd.data, wd)) {
        plan.ops.push({ action: 'delete', type, id, parent: null, field: null });
      } else {
        note(
          plan.kept,
          type,
          id,
          null,
          null,
          'the new build removes it, but it was changed since the import'
        );
      }
      continue;
    }
    const ref: ParentRef = { type, id, field: null, parent: null };
    pushMerge(
      type,
      id,
      null,
      null,
      bd ? bd.data : null,
      td!.data,
      wd,
      playBegan,
      contentHash(td!.data)
    );
    mergeEmbedded(type, ref, bd ? bd.data : null, td!.data, wd, sceneId);
  }

  for (const op of plan.ops) {
    if (op.action === 'create') plan.summary.create += 1;
    else if (op.action === 'delete') plan.summary.delete += 1;
    else if (op.bump_only) plan.summary.build_tag_only += 1;
    else {
      plan.summary.update += 1;
      plan.summary.fields_written += Object.keys(op.set).length + op.unset.length;
    }
  }
  plan.summary.kept_changes = plan.kept.length;
  plan.summary.protected_play_state = plan.protected.length;
  plan.summary.skipped = plan.skipped.length;
  plan.plan_id = updatePlanId(plan);
  return plan;
}

/** mu-<writes>-<8 hex>: a short hash of every operation, value and note in the plan. */
export function updatePlanId(plan: UpdatePlan): string {
  const refText = (op: { type: string; id: string; parent: ParentRef | null }) => {
    const chain: string[] = [];
    let r: ParentRef | null = op.parent;
    while (r) {
      chain.unshift(`${r.type}:${r.id}`);
      r = r.parent;
    }
    return [...chain, `${op.type}:${op.id}`].join('>');
  };
  const lines = [
    `module:${plan.module_id}`,
    `adventure:${plan.adventure_id}`,
    `builds:${plan.base_build}>${plan.target_build}`,
    ...plan.ops.map(op => {
      if (op.action === 'update') {
        return `U:${refText(op)}:${canonicalJson(op.set)}:${op.unset.slice().sort().join(',')}:${op.hash ?? ''}`;
      }
      if (op.action === 'create') return `C:${refText(op)}:${contentHash(op.data)}`;
      return `D:${refText(op)}`;
    }),
    ...[...plan.kept, ...plan.protected, ...plan.skipped].map(
      n => `N:${n.type}:${n.parent_id ?? ''}:${n.id}:${n.path ?? ''}:${n.reason}`
    ),
  ].sort();
  const writes = plan.ops.filter(op => !(op.action === 'update' && op.bump_only)).length;
  return `mu-${writes}-${shortHash(lines)}`;
}

/**
 * The Foundry update payload for one update op: dotted paths to set, and "-=" deletion keys for
 * the paths to remove ("a.b.-=c": null, Foundry 13 foundry.mjs line 1595).
 */
export function updatePayload(
  op: Extract<UpdateOp, { action: 'update' }>,
  tags: { build: number }
): Record<string, any> {
  const out: Record<string, any> = { _id: op.id };
  for (const [path, value] of Object.entries(op.set)) out[path] = value;
  for (const path of op.unset) {
    const i = path.lastIndexOf('.');
    out[i < 0 ? `-=${path}` : `${path.slice(0, i)}.-=${path.slice(i + 1)}`] = null;
  }
  out['flags.aidm.build'] = tags.build;
  if (op.hash !== null) out['flags.aidm.hash'] = op.hash;
  return out;
}

/** The top-level document an op belongs to: {type, id} of the root of its parent chain. */
export function opRoot(op: UpdateOp): { type: string; id: string } {
  let r: ParentRef | null = op.parent;
  if (!r) return { type: op.type, id: op.id };
  while (r.parent) r = r.parent;
  return { type: r.type, id: r.id };
}

/** Reads a dotted path out of plain data. */
export function getPath(data: any, path: string): any {
  let cur = data;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Caps a list for a reply, saying how many were left out. */
export function capList<T>(list: T[], max = 200): { items: T[]; truncated: number } {
  return list.length > max
    ? { items: list.slice(0, max), truncated: list.length - max }
    : { items: list, truncated: 0 };
}

// ---------------------------------------------------------------------------------------------
// Call journal (settling a call the MCP side gave up on)

export interface CallRecord {
  call_id: string;
  tool: string;
  module_id: string;
  adventure_id: string | null;
  state: 'queued' | 'running' | 'done';
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  result: { success: boolean; changed: boolean; error: string | null; mode: string | null } | null;
}

/**
 * Remembers the last calls in this GM client, so a caller whose request timed out on the MCP side
 * (the call still runs here) can ask aidm-module-status what happened, and so a retry with the same
 * call_id never runs twice.
 */
export class CallJournal {
  private records: CallRecord[] = [];
  constructor(
    private readonly limit = 50,
    private readonly now: () => number = () => Date.now()
  ) {}

  get(callId: string): CallRecord | undefined {
    return this.records.find(r => r.call_id === callId);
  }

  queue(callId: string, tool: string, moduleId: string, adventureId: string | null): CallRecord {
    const rec: CallRecord = {
      call_id: callId,
      tool,
      module_id: moduleId,
      adventure_id: adventureId,
      state: 'queued',
      queued_at: this.now(),
      started_at: null,
      finished_at: null,
      result: null,
    };
    this.records.push(rec);
    while (this.records.length > this.limit) this.records.shift();
    return rec;
  }

  start(rec: CallRecord): void {
    rec.state = 'running';
    rec.started_at = this.now();
  }

  finish(rec: CallRecord, reply: any): void {
    rec.state = 'done';
    rec.finished_at = this.now();
    rec.result = {
      success: reply?.success === true,
      changed: reply?.changed === true,
      error: typeof reply?.error === 'string' ? reply.error.slice(0, 500) : null,
      mode: typeof reply?.mode === 'string' ? reply.mode : null,
    };
  }

  forModule(moduleId: string, max = 10): CallRecord[] {
    return this.records.filter(r => r.module_id === moduleId).slice(-max);
  }
}
