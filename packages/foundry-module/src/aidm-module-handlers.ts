/**
 * The aidm-module-* bridge tools (board #1724, design order item 9, bridge part; design
 * dnd-dm/docs/IMPORT-MODULE-AND-GATE-DESIGN-2026-09-17.md sections 4.4.3 to 4.4.5, operator
 * decisions 1, 11 and 13).
 *
 * They install, update and remove ONE imported book's Foundry adventure module
 * ("aidm-<slug>-<hash8>", packed offline by dnd-dm-ingest/src/module_pack.py) in the world this
 * GM client is running:
 *   aidm-module-status   read-only: registered? enabled? which build is in the world? restart needed?
 *   aidm-module-enable   switch the module on in this world (world reload)
 *   aidm-module-disable  switch it off (world reload)
 *   aidm-module-install  plan, then import ONE Adventure per call, everything tagged, never overwriting
 *   aidm-module-update   plan, then a three-way merge of a new build onto the world copy
 *   aidm-module-remove   plan, then delete every document tagged with the module, then disable it
 *
 * Every tool is GM-only. Every write runs inside the same one-at-a-time lock adventure-import uses
 * (queries.ts adventureWriteLock), so two writes in this client can never interleave. A call the MCP
 * side gave up on (its 60 s query timeout) STILL RUNS here; pass a call_id, then read
 * aidm-module-status (recent_calls, and the world's tags) before trying again. A repeat call with the
 * same call_id never runs twice.
 *
 * The pure decisions (plans, hashes, merge, in-play rule) live in aidm-module-utils.ts.
 */

import {
  ADVENTURE_FIELDS,
  EMBEDDED_FIELDS,
  WORLD_DOCUMENT_NAMES,
  CallJournal,
  adventurePart,
  canonicalJson,
  capList,
  clone,
  connectedRefusal,
  contentHash,
  getPath,
  isAidmModuleId,
  planModuleInstall,
  planModuleUpdate,
  playFlagCounts,
  sameValue,
  sceneInPlayReasons,
  sortAdventuresForInstall,
  stampTags,
  summarizeInstallConflicts,
  updatePayload,
  verifyInstallReadBack,
  type AdventureEntry,
  type ParentRef,
  type ReadBackDoc,
  type SceneFacts,
  type UpdateOp,
  type UpdatePlan,
  type WorldDocInfo,
} from './aidm-module-utils.js';
import {
  collectCreatedDocuments,
  type CleanupReport,
  type CreatedDocRef,
  type SerialLock,
  type UnresolvedSceneRef,
} from './adventure-import-utils.js';

export interface AidmModuleDeps {
  /** The shared one-at-a-time write lock (queries.ts adventureWriteLock). */
  lock: SerialLock;
  isGM: () => boolean;
  /** queries.ts _rollbackCreatedDocuments */
  rollbackCreated: (created: CreatedDocRef[]) => Promise<CleanupReport>;
  /** queries.ts _savedAfterFailedCreate */
  savedAfterFailedCreate: (
    cls: any,
    collection: any,
    id: string
  ) => Promise<'client' | 'server-only' | null>;
  /** queries.ts _resolveSceneRefs */
  resolveSceneRefs: (scenes: any[]) => Promise<UnresolvedSceneRef[]>;
  /** queries.ts _missingActorIds */
  missingActorIds: (scenes: any[]) => string[];
  journal?: CallJournal;
  schedule?: (fn: () => void, ms: number) => void;
}

const g = (): any => globalThis as any;
const DEFAULT_RELOAD_DELAY_MS = 2000;
const DELETE_BATCH = 100;

function errText(e: any): string {
  return String((e && (e.stack || e.message)) || e);
}

function accessDenied(): any {
  return { success: false, error: 'Access denied' };
}

function badModuleId(mode: string): any {
  return {
    success: false,
    mode,
    changed: false,
    error:
      'module_id is required and must be an importer module id: "aidm-<name>-<8 hex digits>" ' +
      '(the id module_pack.py writes into module.json). Other modules are never touched.',
  };
}

function asBuild(value: any): number | null {
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/** A live Foundry collection or embedded collection as an array. */
function contentsOf(coll: any): any[] {
  if (!coll) return [];
  if (Array.isArray(coll)) return coll;
  if (Array.isArray(coll.contents)) return coll.contents;
  try {
    return Array.from(coll.values ? coll.values() : coll);
  } catch (e) {
    return [];
  }
}

function worldCollection(documentName: string): any {
  const game = g().game;
  const byName = game?.collections?.get?.(documentName);
  if (byName) return byName;
  // game.actors, game.scenes, game.journal ... are named like the Adventure fields
  const field = ADVENTURE_FIELDS.find(([, n]) => n === documentName)?.[0];
  return field ? game?.[field] : undefined;
}

function documentClass(documentName: string): any {
  const cls = g().CONFIG?.[documentName]?.documentClass ?? g()[documentName];
  return cls?.implementation ?? cls;
}

function lookupWorld(documentName: string, id: string): WorldDocInfo {
  const coll = worldCollection(documentName);
  const doc = coll?.get?.(id);
  const aidm = doc?.flags?.aidm ?? {};
  return {
    exists: !!doc,
    invalid: !!coll?.invalidDocumentIds?.has?.(id),
    name: doc?.name ?? null,
    module: typeof aidm.module === 'string' ? aidm.module : null,
    adventure: typeof aidm.adventure === 'string' ? aidm.adventure : null,
    build: asBuild(aidm.build),
  };
}

function toData(doc: any): any {
  try {
    return doc?.toObject ? doc.toObject() : clone(doc);
  } catch (e) {
    return clone(doc?._source ?? doc);
  }
}

interface TaggedDoc {
  type: string;
  id: string;
  name: string | null;
  build: number | null;
  adventure: string | null;
  /** A copy a GM made with Duplicate (it carries the tags too, but it is the GM's). */
  copy: boolean;
  doc: any;
}

function taggedDocuments(moduleId: string, adventureId: string | null = null): TaggedDoc[] {
  const out: TaggedDoc[] = [];
  for (const type of WORLD_DOCUMENT_NAMES) {
    for (const doc of contentsOf(worldCollection(type))) {
      const aidm = doc?.flags?.aidm;
      if (!aidm || aidm.module !== moduleId) continue;
      if (adventureId && aidm.adventure !== adventureId) continue;
      out.push({
        type,
        id: doc.id,
        name: doc.name ?? null,
        build: asBuild(aidm.build),
        adventure: typeof aidm.adventure === 'string' ? aidm.adventure : null,
        copy: !!doc._stats?.duplicateSource,
        doc,
      });
    }
  }
  return out;
}

/** Live embedded counts (and embedded documents Foundry could not load) inside one document. */
function liveEmbedded(
  documentName: string,
  doc: any
): {
  counts: Record<string, number>;
  invalid: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const invalid: Record<string, number> = {};
  const walk = (name: string, d: any, prefix: string) => {
    for (const [field, childName] of Object.entries(EMBEDDED_FIELDS[name] ?? {})) {
      const coll = d?.[field];
      if (!coll) continue;
      const items = contentsOf(coll);
      const path = prefix ? `${prefix}.${field}` : field;
      if (items.length) counts[path] = (counts[path] ?? 0) + items.length;
      const bad = coll?.invalidDocumentIds?.size ?? 0;
      if (bad) invalid[path] = (invalid[path] ?? 0) + bad;
      for (const item of items) walk(childName, item, path);
    }
  };
  walk(documentName, doc, '');
  return { counts, invalid };
}

/** Embedded documents tagged with this module inside one live document, by embedded type. */
function taggedEmbedded(documentName: string, doc: any, moduleId: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (name: string, d: any) => {
    for (const [field, childName] of Object.entries(EMBEDDED_FIELDS[name] ?? {})) {
      for (const item of contentsOf(d?.[field])) {
        if (item?.flags?.aidm?.module === moduleId) out[childName] = (out[childName] ?? 0) + 1;
        walk(childName, item);
      }
    }
  };
  walk(documentName, doc);
  return out;
}

function readConnectedOthers(): string[] | null {
  try {
    const game = g().game;
    const self = game?.user?.id;
    const users = contentsOf(game?.users);
    if (!game?.users) return null;
    return users
      .filter((u: any) => u?.active && u?.id !== self)
      .map((u: any) => String(u?.name ?? u?.id));
  } catch (e) {
    return null;
  }
}

function readSceneFacts(scene: any): SceneFacts {
  const game = g().game;
  const facts: SceneFacts = {
    id: scene?.id,
    name: scene?.name ?? null,
    active: null,
    pc_tokens: null,
    combats: null,
    viewers: null,
    play_flags: null,
  };
  try {
    facts.active = typeof scene.active === 'boolean' ? scene.active : null;
  } catch (e) {
    facts.active = null;
  }
  try {
    const pcs: string[] = [];
    for (const t of contentsOf(scene.tokens)) {
      const actor = t?.actor;
      if (actor && actor.type === 'character') pcs.push(String(t.name ?? actor.name ?? t.id ?? ''));
    }
    facts.pc_tokens = pcs;
  } catch (e) {
    facts.pc_tokens = null;
  }
  try {
    if (!game?.combats) throw new Error('no combats collection');
    facts.combats = contentsOf(game.combats).filter((c: any) => {
      const sceneRef = c?._source?.scene ?? c?.scene?.id ?? c?.scene;
      return sceneRef === scene.id;
    }).length;
  } catch (e) {
    facts.combats = null;
  }
  try {
    const self = game?.user?.id;
    if (!game?.users) throw new Error('no users collection');
    facts.viewers = contentsOf(game.users).filter(
      (u: any) => u?.active && u?.id !== self && u?.viewedScene === scene.id
    ).length;
  } catch (e) {
    facts.viewers = null;
  }
  try {
    facts.play_flags = playFlagCounts(toData(scene));
  } catch (e) {
    facts.play_flags = null;
  }
  return facts;
}

function moduleInfo(moduleId: string): {
  registered: boolean;
  active: boolean;
  build: number | null;
  version: string | null;
  title: string | null;
  module: any;
} {
  const mod = g().game?.modules?.get?.(moduleId);
  return {
    registered: !!mod,
    active: mod?.active === true,
    build: asBuild(mod?.flags?.aidm?.build),
    version: typeof mod?.version === 'string' ? mod.version : null,
    title: mod?.title ?? null,
    module: mod,
  };
}

function readModuleSetting(): Record<string, boolean> | null {
  try {
    const value = g().game?.settings?.get?.('core', 'moduleConfiguration');
    return value && typeof value === 'object' ? { ...value } : null;
  } catch (e) {
    return null;
  }
}

function modulePacks(moduleId: string): any[] {
  const packs = contentsOf(g().game?.packs);
  return packs.filter(
    (p: any) => p?.metadata?.packageName === moduleId && p?.metadata?.type === 'Adventure'
  );
}

async function adventureIndex(moduleId: string): Promise<(AdventureEntry & { pack: any })[]> {
  const out: (AdventureEntry & { pack: any })[] = [];
  for (const pack of modulePacks(moduleId)) {
    const index = contentsOf(await pack.getIndex({ fields: ['flags.aidm', 'sort'] }));
    for (const e of index) {
      if (!e?._id) continue;
      out.push({
        id: e._id,
        name: e.name ?? null,
        part: adventurePart(e.flags),
        sort: Number(e.sort ?? 0),
        pack,
      });
    }
  }
  return sortAdventuresForInstall(out) as (AdventureEntry & { pack: any })[];
}

async function readDiskModuleJson(moduleId: string): Promise<{
  read: 'ok' | 'missing' | 'unreadable';
  build: number | null;
  version: string | null;
}> {
  const fetchFn = g().fetch;
  if (typeof fetchFn !== 'function') return { read: 'unreadable', build: null, version: null };
  const route = g().foundry?.utils?.getRoute;
  const url =
    typeof route === 'function'
      ? route(`modules/${moduleId}/module.json`)
      : `/modules/${moduleId}/module.json`;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;
  try {
    const res = await fetchFn(`${url}?aidm=${Date.now()}`, {
      cache: 'no-store',
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (res.status === 404) return { read: 'missing', build: null, version: null };
    if (!res.ok) return { read: 'unreadable', build: null, version: null };
    const json = await res.json();
    if (json?.id !== moduleId) return { read: 'unreadable', build: null, version: null };
    return {
      read: 'ok',
      build: asBuild(json?.flags?.aidm?.build),
      version: typeof json?.version === 'string' ? json.version : null,
    };
  } catch (e) {
    return { read: 'unreadable', build: null, version: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Foundry's own cleaning and validation of Adventure data: new Adventure(data).toObject(). */
function cleanAdventure(source: any): any {
  const Cls = g().CONFIG?.Adventure?.documentClass ?? g().Adventure;
  if (typeof Cls !== 'function') throw new Error('the Adventure document class is not available');
  const doc = new Cls(clone(source));
  return doc.toObject ? doc.toObject() : clone(doc);
}

/** The live document a parent chain points at (top-level document, then embedded ones). */
function resolveParent(ref: ParentRef): any {
  const chain: ParentRef[] = [];
  let r: ParentRef | null = ref;
  while (r) {
    chain.unshift(r);
    r = r.parent;
  }
  let doc = worldCollection(chain[0].type)?.get?.(chain[0].id);
  for (const link of chain.slice(1)) {
    doc = link.field ? doc?.[link.field]?.get?.(link.id) : undefined;
  }
  return doc;
}

function parentKey(ref: ParentRef | null): string {
  const parts: string[] = [];
  let r = ref;
  while (r) {
    parts.unshift(`${r.type}:${r.id}`);
    r = r.parent;
  }
  return parts.join('>');
}

function liveDocFor(op: {
  type: string;
  id: string;
  parent: ParentRef | null;
  field: string | null;
}): any {
  if (!op.parent) return worldCollection(op.type)?.get?.(op.id);
  const parent = resolveParent(op.parent);
  return op.field ? parent?.[op.field]?.get?.(op.id) : undefined;
}

type UndoEntry =
  | { kind: 'created'; type: string; id: string; parent: ParentRef | null; field: string | null }
  | {
      kind: 'updated';
      type: string;
      id: string;
      parent: ParentRef | null;
      field: string | null;
      before: Record<string, any>;
    }
  | {
      kind: 'deleted';
      type: string;
      id: string;
      parent: ParentRef | null;
      field: string | null;
      snapshot: any;
    };

export class AidmModuleHandlers {
  private readonly journal: CallJournal;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private autoCallId = 0;

  constructor(private readonly deps: AidmModuleDeps) {
    this.journal = deps.journal ?? new CallJournal();
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  // ---- shared ------------------------------------------------------------------------------

  /** Runs a write inside the shared lock, recorded in the call journal under its call_id. */
  private async journaled(
    tool: string,
    data: any,
    moduleId: string,
    adventureId: string | null,
    run: () => Promise<any>
  ): Promise<any> {
    const given =
      typeof data?.call_id === 'string' && data.call_id.trim()
        ? data.call_id.trim().slice(0, 100)
        : null;
    if (given) {
      const prior = this.journal.get(given);
      if (prior) {
        if (prior.tool !== tool || prior.module_id !== moduleId) {
          return {
            success: false,
            changed: false,
            error: `call_id "${given}" was already used for a different call (${prior.tool} on ${prior.module_id}). Nothing was run.`,
          };
        }
        if (prior.state === 'done') {
          return {
            success: prior.result?.success === true,
            changed: false,
            replayed: true,
            call: prior,
            note:
              'This call_id already ran in this GM client, so nothing was run again. Its outcome is in call.result; ' +
              'read aidm-module-status for the world as it is now.',
          };
        }
        return {
          success: false,
          changed: false,
          in_progress: true,
          call: prior,
          error:
            'This call_id is still queued or running in the GM client. Nothing new was started. Wait, then read ' +
            'aidm-module-status (recent_calls) before calling again.',
        };
      }
    }
    this.autoCallId += 1;
    const rec = this.journal.queue(given ?? `auto-${this.autoCallId}`, tool, moduleId, adventureId);
    return await this.deps.lock(async () => {
      this.journal.start(rec);
      let reply: any;
      try {
        reply = await run();
      } catch (e) {
        reply = { success: false, changed: false, error: `${tool} failed: ${errText(e)}` };
      }
      this.journal.finish(rec, reply);
      return { ...reply, call_id: rec.call_id };
    });
  }

  private inPlayScenes(moduleId: string, adventureId: string | null = null) {
    return taggedDocuments(moduleId, adventureId)
      .filter(d => d.type === 'Scene')
      .map(d => {
        const facts = readSceneFacts(d.doc);
        return { scene_id: d.id, name: d.name, reasons: sceneInPlayReasons(facts), copy: d.copy };
      })
      .filter(s => s.reasons.length);
  }

  private scheduleReload(delayMs: number): void {
    this.schedule(() => {
      try {
        g().game?.socket?.emit?.('reload');
      } catch (e) {
        // the local reload below still runs
      }
      try {
        g().foundry?.utils?.debouncedReload?.();
      } catch (e) {
        // nothing more can be done from here
      }
    }, delayMs);
  }

  private reloadDelay(data: any): number {
    const ms = Number(data?.reload_delay_ms);
    return Number.isFinite(ms)
      ? Math.min(30000, Math.max(250, Math.round(ms)))
      : DEFAULT_RELOAD_DELAY_MS;
  }

  // ---- aidm-module-status ------------------------------------------------------------------

  async status(data: { module_id?: string }): Promise<any> {
    if (!this.deps.isGM()) return accessDenied();
    const moduleId = data?.module_id;
    if (!isAidmModuleId(moduleId)) return badModuleId('status');
    try {
      const mod = moduleInfo(moduleId);
      const setting = readModuleSetting();
      const disk = await readDiskModuleJson(moduleId);
      const tagged = taggedDocuments(moduleId);
      const documents: Record<string, number> = {};
      const builds = new Set<number | null>();
      const byAdventure = new Map<string, { documents: number; builds: Set<number | null> }>();
      const embedded: Record<string, number> = {};
      let copies = 0;
      for (const d of tagged) {
        documents[d.type] = (documents[d.type] ?? 0) + 1;
        if (d.copy) copies += 1;
        builds.add(d.build);
        const key = d.adventure ?? '(none)';
        const entry = byAdventure.get(key) ?? { documents: 0, builds: new Set() };
        entry.documents += 1;
        entry.builds.add(d.build);
        byAdventure.set(key, entry);
      }
      for (const type of WORLD_DOCUMENT_NAMES) {
        for (const doc of contentsOf(worldCollection(type))) {
          for (const [name, n] of Object.entries(taggedEmbedded(type, doc, moduleId))) {
            embedded[name] = (embedded[name] ?? 0) + n;
          }
        }
      }
      let adventures: any[] = [];
      let packError: string | null = null;
      if (mod.active) {
        try {
          adventures = (await adventureIndex(moduleId)).map(e => {
            const w = byAdventure.get(e.id);
            return {
              id: e.id,
              name: e.name,
              part: e.part,
              sort: e.sort,
              world_documents: w?.documents ?? 0,
              world_builds: w ? Array.from(w.builds).sort() : [],
            };
          });
        } catch (e) {
          packError = errText(e);
        }
      }
      const buildList = Array.from(builds)
        .filter((b): b is number => b !== null)
        .sort((a, b) => a - b);
      const connected = readConnectedOthers();
      const enabledSetting = setting ? setting[moduleId] === true : null;
      const restartNeeded = !mod.registered
        ? disk.read === 'ok'
        : disk.build !== null && mod.build !== null && disk.build !== mod.build;
      const reply: any = {
        success: true,
        mode: 'status',
        module_id: moduleId,
        module: {
          registered: mod.registered,
          enabled: mod.active,
          enabled_setting: enabledSetting,
          reload_pending:
            mod.registered && enabledSetting !== null && enabledSetting !== mod.active,
          loaded_build: mod.build,
          loaded_version: mod.version,
          disk_read: disk.read,
          disk_build: disk.build,
          disk_version: disk.version,
          restart_needed: restartNeeded,
        },
        pack: {
          available: mod.active && !packError && adventures.length > 0,
          adventures,
          ...(packError ? { error: packError } : {}),
          ...(mod.active
            ? {}
            : { note: 'the pack can only be read while the module is enabled in this world' }),
        },
        world: {
          build: buildList.length === 1 && !builds.has(null) ? buildList[0] : null,
          builds: buildList,
          mixed_builds: builds.size > 1,
          untagged_build_documents: tagged.filter(d => d.build === null).length,
          documents,
          embedded,
          total: tagged.length,
          gm_copies: copies,
          adventures_in_world: Array.from(byAdventure.entries()).map(([id, v]) => ({
            id,
            documents: v.documents,
            builds: Array.from(v.builds).sort(),
          })),
        },
        in_play: this.inPlayScenes(moduleId).map(({ copy: _copy, ...s }) => s),
        connected: connected === null ? null : connected.length,
        busy: this.deps.lock.pending() > 0,
        queued_calls: this.deps.lock.pending(),
        recent_calls: this.journal.forModule(moduleId),
      };
      return reply;
    } catch (e) {
      return { success: false, mode: 'status', error: errText(e) };
    }
  }

  // ---- aidm-module-enable / aidm-module-disable ---------------------------------------------

  async setEnabled(
    data: { module_id?: string; reload?: boolean; reload_delay_ms?: number; call_id?: string },
    enabled: boolean
  ): Promise<any> {
    const mode = enabled ? 'enable' : 'disable';
    if (!this.deps.isGM()) return accessDenied();
    const moduleId = data?.module_id;
    if (!isAidmModuleId(moduleId)) return badModuleId(mode);
    const tool = enabled ? 'aidm-module-enable' : 'aidm-module-disable';
    return await this.journaled(tool, data, moduleId, null, () =>
      this.setEnabledLocked(moduleId, enabled, data?.reload !== false, this.reloadDelay(data))
    );
  }

  private async setEnabledLocked(
    moduleId: string,
    enabled: boolean,
    reload: boolean,
    delayMs: number
  ): Promise<any> {
    const mode = enabled ? 'enable' : 'disable';
    const refuse = (error: string, extra: any = {}) => ({
      success: false,
      mode,
      changed: false,
      module_id: moduleId,
      error,
      ...extra,
    });
    const mod = moduleInfo(moduleId);
    const setting = readModuleSetting();
    if (setting === null) {
      return refuse(
        "Refused: could not read the world's module settings (core.moduleConfiguration). Nothing was changed."
      );
    }
    if (enabled && !mod.registered) {
      return refuse(
        `Refused: Foundry does not know the module ${moduleId}. A new module folder is only seen after Foundry ` +
          'restarts (the boot-time swap moves a staged folder into Data/modules first). Nothing was changed.'
      );
    }
    const current = setting[moduleId] === true;
    if (current === enabled && (mod.active === enabled || !mod.registered)) {
      return {
        success: true,
        mode,
        changed: false,
        module_id: moduleId,
        enabled_setting: current,
        note: `The module is already ${enabled ? 'enabled' : 'disabled'} in this world. Nothing was changed.`,
      };
    }
    if (this.deps.lock.pending() > 1) {
      return refuse(
        `Refused: ${this.deps.lock.pending() - 1} other bridge write call(s) are queued in this GM client, and the ` +
          'world reload would cut them off. Nothing was changed. Try again when aidm-module-status shows busy: false.'
      );
    }
    const refusal = connectedRefusal(readConnectedOthers());
    if (refusal) return refuse(refusal);
    const inPlay = this.inPlayScenes(moduleId);
    if (inPlay.length) {
      return refuse(
        `Refused: ${inPlay.length} scene(s) of this module are in play: ${inPlay
          .map(s => `"${s.name}" (${s.reasons.join('; ')})`)
          .join('; ')}. Nothing was changed.`,
        { in_play: inPlay.map(({ copy: _copy, ...s }) => s) }
      );
    }
    if (enabled) {
      const requires = mod.module?.relationships?.requires;
      const list: any[] = requires ? contentsOf(requires) : [];
      const missing = list
        .filter(dep => !dep?.type || dep.type === 'module')
        .map(dep => String(dep?.id ?? ''))
        .filter(id => id && !(g().game?.modules?.get?.(id)?.active || setting[id] === true));
      if (missing.length) {
        return refuse(
          `Refused: the module needs ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not enabled ` +
            'in this world. Nothing was changed.'
        );
      }
    }
    await g().game.settings.set('core', 'moduleConfiguration', { ...setting, [moduleId]: enabled });
    const after = readModuleSetting();
    if (!after || (after[moduleId] === true) !== enabled) {
      return {
        success: false,
        mode,
        changed: false,
        module_id: moduleId,
        error:
          'The module setting was written but did not read back as expected, so no reload was started. Read ' +
          'aidm-module-status.',
      };
    }
    if (reload) this.scheduleReload(delayMs);
    const remaining = enabled ? 0 : taggedDocuments(moduleId).length;
    return {
      success: true,
      mode,
      changed: true,
      module_id: moduleId,
      enabled_setting: enabled,
      reload: { scheduled: reload, in_ms: reload ? delayMs : null },
      ...(remaining ? { tagged_documents_remain: remaining } : {}),
      note: reload
        ? `The world reloads for every client in about ${delayMs} ms. The bridge connection drops while the GM ` +
          'client reloads; read aidm-module-status once it is back.'
        : 'Saved without a reload: the change takes effect at the next world reload or Foundry restart.',
    };
  }

  // ---- aidm-module-install ------------------------------------------------------------------

  async install(data: {
    module_id?: string;
    adventure_id?: string;
    apply?: boolean;
    plan_id?: string;
    call_id?: string;
  }): Promise<any> {
    if (!this.deps.isGM()) return accessDenied();
    const moduleId = data?.module_id;
    const apply = data?.apply === true;
    const mode = apply ? 'apply' : 'dry-run';
    if (!isAidmModuleId(moduleId)) return badModuleId(mode);
    const adventureId =
      typeof data?.adventure_id === 'string' && data.adventure_id ? data.adventure_id : null;
    if (!apply) {
      try {
        return await this.installDryRun(moduleId, adventureId);
      } catch (e) {
        return { success: false, mode, changed: false, error: errText(e) };
      }
    }
    if (!adventureId || typeof data?.plan_id !== 'string' || !data.plan_id) {
      return {
        success: false,
        mode,
        changed: false,
        error:
          'Refused: apply installs ONE Adventure and needs adventure_id and the plan_id from a dry run of that same ' +
          'Adventure. Nothing was changed.',
      };
    }
    return await this.journaled('aidm-module-install', data, moduleId, adventureId, () =>
      this.installApply(moduleId, adventureId, String(data.plan_id))
    );
  }

  private async loadForInstall(moduleId: string, adventureId: string | null) {
    const mod = moduleInfo(moduleId);
    if (!mod.registered) {
      return {
        error: `Foundry does not know the module ${moduleId}. Stage its folder and restart Foundry first.`,
      } as const;
    }
    if (!mod.active) {
      return {
        error: `The module ${moduleId} is not enabled in this world, so its pack cannot be read. Run aidm-module-enable first.`,
      } as const;
    }
    if (mod.build === null) {
      return {
        error: `The loaded module.json of ${moduleId} has no flags.aidm.build, so it is not an importer build. Nothing was changed.`,
      } as const;
    }
    const index = await adventureIndex(moduleId);
    if (!index.length) {
      return {
        error: `The module ${moduleId} has no Adventure pack with any Adventure in it.`,
      } as const;
    }
    let adventure: any = null;
    let entry: (typeof index)[number] | null = null;
    if (adventureId) {
      entry = index.find(e => e.id === adventureId) ?? null;
      if (!entry) {
        return {
          error: `No Adventure ${adventureId} in the module ${moduleId}. Its Adventures: ${index
            .map(e => `${e.id} (${e.name})`)
            .join(', ')}.`,
        } as const;
      }
      adventure = await entry.pack.getDocument(adventureId);
      if (!adventure)
        return { error: `The pack did not return the Adventure ${adventureId}.` } as const;
      if (adventure?.flags?.aidm?.module !== moduleId) {
        return {
          error: `The Adventure ${adventureId} is not tagged as part of ${moduleId} (flags.aidm.module). Nothing was changed.`,
        } as const;
      }
    }
    return { mod, index, entry, adventure, build: mod.build } as const;
  }

  private orderRefusal(
    moduleId: string,
    index: AdventureEntry[],
    entry: AdventureEntry
  ): string | null {
    if (entry.part === 'core') return null;
    const cores = index.filter(e => e.part === 'core');
    const missing = cores.filter(c => taggedDocuments(moduleId, c.id).length === 0);
    if (!missing.length) return null;
    return (
      `Refused: install the core Adventure first (${missing.map(c => `${c.id} "${c.name}"`).join(', ')}); ` +
      "the other Adventures' tokens and encounters point at its actors. Nothing was changed."
    );
  }

  private async installDryRun(moduleId: string, adventureId: string | null): Promise<any> {
    const loaded = await this.loadForInstall(moduleId, adventureId);
    if ('error' in loaded)
      return { success: false, mode: 'dry-run', changed: false, error: loaded.error };
    if (!adventureId || !loaded.entry) {
      const adventures = loaded.index.map(e => {
        const docs = taggedDocuments(moduleId, e.id);
        return {
          id: e.id,
          name: e.name,
          part: e.part,
          sort: e.sort,
          world_documents: docs.length,
          world_builds: Array.from(new Set(docs.map(d => d.build))).sort(),
        };
      });
      const next = adventures.find(a => a.world_documents === 0) ?? null;
      return {
        success: true,
        mode: 'dry-run',
        changed: false,
        module_id: moduleId,
        build: loaded.build,
        install_order: adventures,
        next_adventure: next ? next.id : null,
        next_step: next
          ? `Call again with adventure_id "${next.id}" for its full plan and plan_id.`
          : 'Every Adventure of this module already has documents in the world. Use aidm-module-status and aidm-module-update.',
      };
    }
    const advData = toData(loaded.adventure);
    const plan = planModuleInstall({
      moduleId,
      build: loaded.build,
      adventureId,
      adventureName: loaded.entry.name,
      adventureData: advData,
      lookup: lookupWorld,
    });
    const order = this.orderRefusal(moduleId, loaded.index, loaded.entry);
    const create = capList(plan.create, 500);
    const connected = readConnectedOthers();
    let nextStep: string;
    if (plan.state === 'installed') nextStep = 'Already installed at this build. Nothing to do.';
    else if (plan.state === 'not_installed' && !order) {
      nextStep = `To create the ${plan.create.length} document(s) listed under create, call again with apply: true and plan_id "${plan.plan_id}".`;
    } else if (order) nextStep = order;
    else if (plan.state === 'conflicts') nextStep = summarizeInstallConflicts(plan.conflicts);
    else if (plan.state === 'installed_other_build') {
      nextStep =
        'The world holds this Adventure at another build. Use aidm-module-update, not install.';
    } else {
      nextStep =
        'Partly installed: some of its documents exist and some do not (a GM deleted some, or an earlier rollback ' +
        'could not finish). Install will not fill the gaps. Remove this Adventure (aidm-module-remove with ' +
        'adventure_id) and install it again, or use aidm-module-update.';
    }
    return {
      success: true,
      mode: 'dry-run',
      changed: false,
      module_id: moduleId,
      adventure_id: adventureId,
      adventure_name: plan.adventure_name,
      part: loaded.entry.part,
      build: plan.build,
      state: plan.state,
      plan_id: plan.plan_id,
      counts: plan.counts,
      create: create.items,
      ...(create.truncated ? { create_truncated: create.truncated } : {}),
      already_installed: capList(plan.already_installed, 500).items,
      conflicts: plan.conflicts,
      order_ok: !order,
      connected: connected === null ? null : connected.length,
      next_step: nextStep,
    };
  }

  private async installApply(moduleId: string, adventureId: string, planId: string): Promise<any> {
    const mode = 'apply';
    const refuse = (error: string, extra: any = {}) => ({
      success: false,
      mode,
      changed: false,
      module_id: moduleId,
      adventure_id: adventureId,
      error,
      ...extra,
    });
    const loaded = await this.loadForInstall(moduleId, adventureId);
    if ('error' in loaded) return refuse(`Refused: ${loaded.error}`);
    const adv = loaded.adventure;
    const build = loaded.build;
    const plan = planModuleInstall({
      moduleId,
      build,
      adventureId,
      adventureName: loaded.entry!.name,
      adventureData: toData(adv),
      lookup: lookupWorld,
    });
    if (plan.state === 'installed') {
      // Idempotent: a call that timed out on the MCP side but finished here, called again.
      return {
        success: true,
        mode,
        changed: false,
        module_id: moduleId,
        adventure_id: adventureId,
        build,
        state: 'installed',
        reused: true,
        counts: plan.counts,
        note: 'Already installed at this build (every document is in the world and tagged). Nothing was changed.',
      };
    }
    if (plan.plan_id !== planId) {
      // Never echo the live plan or plan_id here: apply must follow a dry run a caller has read.
      return refuse(
        'Refused: the plan_id does not match the plan built from the world now. Either no dry run was run, or the ' +
          'world or the module changed since. Nothing was changed. Run the dry run again, read it, then apply with ' +
          'the plan_id it returns.',
        { state: plan.state }
      );
    }
    if (plan.state === 'conflicts') {
      return refuse(summarizeInstallConflicts(plan.conflicts), { conflicts: plan.conflicts });
    }
    if (plan.state !== 'not_installed') {
      return refuse(
        plan.state === 'partial'
          ? 'Refused: this Adventure is partly installed. Remove it (aidm-module-remove with adventure_id) and install again. Nothing was changed.'
          : 'Refused: the world holds this Adventure at another build. Use aidm-module-update. Nothing was changed.',
        { state: plan.state }
      );
    }
    const order = this.orderRefusal(moduleId, loaded.index, loaded.entry!);
    if (order) return refuse(order);
    if (!(typeof adv.prepareImport === 'function' && typeof adv.importContent === 'function')) {
      return refuse(
        'Refused: this Foundry has no Adventure prepareImport/importContent. The Adventure import() fallback is ' +
          'never used, because it overwrites existing documents. Nothing was changed.'
      );
    }
    const prepared = await adv.prepareImport({
      importFields: ADVENTURE_FIELDS.map(([field]) => field),
    });
    const updates = Object.entries(prepared?.toUpdate ?? {}).filter(
      ([, docs]) => Array.isArray(docs) && docs.length
    );
    if (updates.length) {
      return refuse(
        `Refused: Foundry planned to replace existing world documents (${updates
          .map(([name, docs]) => `${(docs as any[]).length} ${name}`)
          .join(', ')}). Nothing was changed.`
      );
    }
    const tags = { module: moduleId, build, adventure: adventureId };
    const toCreate: Record<string, any[]> = {};
    const expected: { type: string; id: string; data: any }[] = [];
    let documentCount = 0;
    for (const [, name] of ADVENTURE_FIELDS) {
      const docs: any[] = Array.isArray(prepared?.toCreate?.[name]) ? prepared.toCreate[name] : [];
      if (!docs.length) continue;
      toCreate[name] = docs.map(d => {
        const data = clone(d);
        const hash = contentHash(data);
        stampTags(data, name, tags, hash);
        expected.push({ type: name, id: data._id, data });
        return data;
      });
      documentCount += docs.length;
    }
    const plannedKeys = plan.create.map(d => `${d.type}:${d.id}`).sort();
    const preparedKeys = expected.map(d => `${d.type}:${d.id}`).sort();
    if (canonicalJson(plannedKeys) !== canonicalJson(preparedKeys)) {
      return refuse(
        'Refused: what Foundry prepared to import is not the list the plan made. Nothing was changed. Run the dry run again.'
      );
    }

    const tracker: CreatedDocRef[] = [];
    try {
      let result: any;
      try {
        result = await adv.importContent({ toCreate, toUpdate: {}, documentCount });
      } catch (e) {
        for (const d of expected) {
          const where = await this.deps.savedAfterFailedCreate(
            documentClass(d.type),
            worldCollection(d.type),
            d.id
          );
          if (where && !tracker.some(t => t.type === d.type && t.id === d.id)) {
            tracker.push(
              where === 'client'
                ? { type: d.type, id: d.id }
                : { type: d.type, id: d.id, loadedInClient: false }
            );
          }
        }
        throw e;
      }
      tracker.push(...collectCreatedDocuments(result?.created));

      const readBack: ReadBackDoc[] = expected.map(e => {
        const coll = worldCollection(e.type);
        const doc = coll?.get?.(e.id);
        const live = doc ? liveEmbedded(e.type, doc) : { counts: {}, invalid: {} };
        const aidm = doc?.flags?.aidm ?? {};
        return {
          type: e.type,
          id: e.id,
          present: !!doc,
          invalid: !!coll?.invalidDocumentIds?.has?.(e.id),
          tags: { module: aidm.module, build: aidm.build, adventure: aidm.adventure },
          embedded: live.counts,
          embeddedInvalid: live.invalid,
        };
      });
      const problems = verifyInstallReadBack({
        expected,
        createdIds: tracker.map(t => ({ type: t.type, id: t.id })),
        readBack,
        tags,
      });
      const scenes = expected
        .filter(e => e.type === 'Scene')
        .map(e => worldCollection('Scene')?.get?.(e.id))
        .filter(Boolean);
      const missingActors = this.deps.missingActorIds(scenes);
      if (missingActors.length) {
        problems.push(
          `token(s) point at ${missingActors.length} actor id(s) the world does not have: ${missingActors.slice(0, 10).join(', ')}`
        );
      }
      const refs = await this.deps.resolveSceneRefs(scenes);
      if (refs.length) {
        problems.push(
          `${refs.length} region behavior reference(s) point at a scene or region that does not exist: ${refs
            .slice(0, 5)
            .map(r => r.target)
            .join(', ')}`
        );
      }
      if (problems.length) {
        const cleanup = await this.deps.rollbackCreated(tracker.splice(0));
        return {
          success: false,
          mode,
          changed: cleanup.failed.length > 0,
          module_id: moduleId,
          adventure_id: adventureId,
          build,
          error: `Install failed its read-back check (${problems.length} problem(s)): ${problems.slice(0, 5).join('; ')}. ${
            cleanup.failed.length
              ? `Rollback could NOT delete ${cleanup.failed.length} document(s); they are listed under cleanup.failed.`
              : 'Every document this call created was deleted again.'
          }`,
          problems,
          cleanup,
        };
      }
      const created: Record<string, number> = {};
      for (const t of expected) created[t.type] = (created[t.type] ?? 0) + 1;
      return {
        success: true,
        mode,
        changed: true,
        module_id: moduleId,
        adventure_id: adventureId,
        adventure_name: plan.adventure_name,
        build,
        state: 'installed',
        created,
        counts: plan.counts,
        verification: { documents_checked: expected.length, problems: [] },
      };
    } catch (e) {
      const cleanup = tracker.length ? await this.deps.rollbackCreated(tracker.splice(0)) : null;
      return {
        success: false,
        mode,
        changed: !!cleanup?.failed.length,
        module_id: moduleId,
        adventure_id: adventureId,
        error: `Install failed: ${errText(e)}. ${
          cleanup
            ? cleanup.failed.length
              ? `Rollback could NOT delete ${cleanup.failed.length} document(s); see cleanup.failed.`
              : 'Every document this call created was deleted again.'
            : 'Nothing was created.'
        }`,
        ...(cleanup ? { cleanup } : {}),
      };
    }
  }

  // ---- aidm-module-update -------------------------------------------------------------------

  async update(data: {
    module_id?: string;
    adventure_id?: string;
    target?: any;
    target_build?: number;
    base?: any;
    base_build?: number;
    play_began_scene_ids?: string[];
    accept_base_mismatch?: boolean;
    apply?: boolean;
    plan_id?: string;
    call_id?: string;
  }): Promise<any> {
    if (!this.deps.isGM()) return accessDenied();
    const moduleId = data?.module_id;
    const apply = data?.apply === true;
    const mode = apply ? 'apply' : 'dry-run';
    if (!isAidmModuleId(moduleId)) return badModuleId(mode);
    const adventureId =
      typeof data?.adventure_id === 'string' && data.adventure_id ? data.adventure_id : null;
    if (!adventureId) {
      return {
        success: false,
        mode,
        changed: false,
        error: 'adventure_id is required: an update works on one Adventure per call.',
      };
    }
    if (!apply) {
      try {
        const built = await this.buildUpdatePlan(moduleId, adventureId, data);
        if ('error' in built)
          return {
            success: false,
            mode,
            changed: false,
            module_id: moduleId,
            adventure_id: adventureId,
            error: built.error,
          };
        return this.updateDryRunReply(built.plan);
      } catch (e) {
        return { success: false, mode, changed: false, error: errText(e) };
      }
    }
    if (typeof data?.plan_id !== 'string' || !data.plan_id) {
      return {
        success: false,
        mode,
        changed: false,
        error:
          'Refused: apply needs the plan_id from a dry run of this same update. Nothing was changed.',
      };
    }
    return await this.journaled('aidm-module-update', data, moduleId, adventureId, async () => {
      const built = await this.buildUpdatePlan(moduleId, adventureId, data);
      if ('error' in built)
        return {
          success: false,
          mode,
          changed: false,
          module_id: moduleId,
          adventure_id: adventureId,
          error: `Refused: ${built.error}`,
        };
      if (built.plan.plan_id !== data.plan_id) {
        return {
          success: false,
          mode,
          changed: false,
          module_id: moduleId,
          adventure_id: adventureId,
          summary: built.plan.summary,
          error:
            'Refused: the plan_id does not match the plan built from the world now (or no dry run was run). Nothing ' +
            'was changed. Run the dry run again, read it, then apply with the plan_id it returns.',
        };
      }
      return await this.executeUpdate(built.plan);
    });
  }

  private async buildUpdatePlan(
    moduleId: string,
    adventureId: string,
    data: any
  ): Promise<{ plan: UpdatePlan } | { error: string }> {
    const tagged = taggedDocuments(moduleId, adventureId).filter(d => !d.copy);
    if (!tagged.length) {
      return {
        error: `the world has no document of ${moduleId} Adventure ${adventureId}. Install it with aidm-module-install.`,
      };
    }
    const worldBuilds = Array.from(new Set(tagged.map(d => d.build))).filter(
      (b): b is number => b !== null
    );
    const mod = moduleInfo(moduleId);
    let packAdventure: any = null;
    const loadPack = async () => {
      if (packAdventure || !mod.active) return packAdventure;
      const entry = (await adventureIndex(moduleId)).find(e => e.id === adventureId);
      packAdventure = entry ? await entry.pack.getDocument(adventureId) : null;
      return packAdventure;
    };

    let target: any;
    let targetBuild: number | null;
    if (data?.target !== undefined && data?.target !== null) {
      targetBuild = asBuild(data?.target_build);
      if (targetBuild === null)
        return { error: 'target_build (a whole number, 1 or more) is required with target.' };
      try {
        target = cleanAdventure(data.target);
      } catch (e) {
        return {
          error: `the target Adventure data does not pass Foundry's data checks: ${errText(e)}`,
        };
      }
    } else {
      const adv = await loadPack();
      if (!adv || mod.build === null) {
        return {
          error:
            'no target given, and the loaded module pack cannot be read (enable the module, or pass target and target_build).',
        };
      }
      targetBuild = mod.build;
      target = toData(adv);
    }
    if (target?._id && target._id !== adventureId) {
      return { error: `the target is Adventure ${target._id}, not ${adventureId}.` };
    }

    let base: any;
    let baseBuild: number | null;
    if (data?.base !== undefined && data?.base !== null) {
      baseBuild = asBuild(data?.base_build);
      if (baseBuild === null)
        return { error: 'base_build (a whole number, 1 or more) is required with base.' };
      try {
        base = cleanAdventure(data.base);
      } catch (e) {
        return {
          error: `the base Adventure data does not pass Foundry's data checks: ${errText(e)}`,
        };
      }
    } else {
      const older = worldBuilds.filter(b => b !== targetBuild);
      const candidate =
        older.length === 1 ? older[0] : worldBuilds.length === 1 ? worldBuilds[0] : null;
      const adv = candidate !== null && mod.build === candidate ? await loadPack() : null;
      if (candidate === null || !adv) {
        return {
          error:
            `the base (the build the world copy was installed from, world builds: ${worldBuilds.join(', ') || 'none'}) ` +
            'is not the loaded module build, so it must be passed as base and base_build (the build record of that build).',
        };
      }
      baseBuild = candidate;
      base = toData(adv);
    }
    if (base?._id && base._id !== adventureId) {
      return { error: `the base is Adventure ${base._id}, not ${adventureId}.` };
    }
    if (baseBuild === targetBuild) {
      return {
        error: `the base build and the target build are both ${baseBuild}; there is nothing to update.`,
      };
    }
    if (
      worldBuilds.length &&
      !worldBuilds.includes(baseBuild) &&
      !worldBuilds.includes(targetBuild)
    ) {
      return {
        error: `the world copy is at build ${worldBuilds.join(', ')}, not the base build ${baseBuild}. Pass the base data of the build the world copy is at.`,
      };
    }

    const world = new Map<string, any>();
    const invalid = new Set<string>();
    const sceneFacts = new Map<string, SceneFacts>();
    for (const src of [base, target]) {
      for (const [field, type] of ADVENTURE_FIELDS) {
        for (const d of Array.isArray(src?.[field]) ? src[field] : []) {
          const key = `${type}:${d?._id}`;
          if (!d?._id || world.has(key) || invalid.has(key)) continue;
          const coll = worldCollection(type);
          const doc = coll?.get?.(d._id);
          if (doc) {
            world.set(key, toData(doc));
            if (type === 'Scene') sceneFacts.set(d._id, readSceneFacts(doc));
          } else if (coll?.invalidDocumentIds?.has?.(d._id)) invalid.add(key);
        }
      }
    }
    const plan = planModuleUpdate({
      moduleId,
      adventureId,
      baseBuild,
      targetBuild,
      base,
      target,
      world,
      invalid,
      sceneFacts,
      forcePlayBegan: new Set(
        Array.isArray(data?.play_began_scene_ids) ? data.play_began_scene_ids.map(String) : []
      ),
      acceptBaseMismatch: data?.accept_base_mismatch === true,
    });
    // Documents at a build that is neither base nor target are skipped per document by planModuleUpdate.
    return { plan };
  }

  private opView(op: UpdateOp): any {
    const base = { action: op.action, type: op.type, id: op.id, parent_id: op.parent?.id ?? null };
    if (op.action === 'update') {
      return {
        ...base,
        paths: [...Object.keys(op.set), ...op.unset.map(p => `-${p}`)],
        build_tag_only: op.bump_only,
      };
    }
    return base;
  }

  private updateDryRunReply(plan: UpdatePlan): any {
    const ops = capList(
      plan.ops.map(op => this.opView(op)),
      300
    );
    const kept = capList(plan.kept, 300);
    const prot = capList(plan.protected, 300);
    const writes =
      plan.summary.create + plan.summary.update + plan.summary.delete + plan.summary.build_tag_only;
    return {
      success: true,
      mode: 'dry-run',
      changed: false,
      module_id: plan.module_id,
      adventure_id: plan.adventure_id,
      base_build: plan.base_build,
      target_build: plan.target_build,
      plan_id: plan.plan_id,
      summary: plan.summary,
      ops: ops.items,
      ...(ops.truncated ? { ops_truncated: ops.truncated } : {}),
      kept_gm_edits: kept.items,
      ...(kept.truncated ? { kept_truncated: kept.truncated } : {}),
      protected_play_state: prot.items,
      ...(prot.truncated ? { protected_truncated: prot.truncated } : {}),
      skipped: plan.skipped,
      in_play: plan.in_play,
      play_began: plan.play_began,
      next_step: writes
        ? `Dry run only: nothing was changed. To apply, call again with the same arguments plus apply: true and plan_id "${plan.plan_id}".`
        : 'Dry run only: nothing was changed, and there is nothing to write.',
    };
  }

  private async executeUpdate(plan: UpdatePlan): Promise<any> {
    const mode = 'apply';
    const tags = { module: plan.module_id, build: plan.target_build, adventure: plan.adventure_id };
    const undo: UndoEntry[] = [];
    const creates = plan.ops.filter(
      (o): o is Extract<UpdateOp, { action: 'create' }> => o.action === 'create'
    );
    const updates = plan.ops.filter(
      (o): o is Extract<UpdateOp, { action: 'update' }> => o.action === 'update'
    );
    const deletes = plan.ops.filter(
      (o): o is Extract<UpdateOp, { action: 'delete' }> => o.action === 'delete'
    );
    const intended = new Map<string, UpdateOp>();
    const opKey = (op: { type: string; id: string; parent: ParentRef | null }) =>
      `${parentKey(op.parent)}|${op.type}:${op.id}`;
    try {
      // 1. top-level creates, in create order
      for (const [, type] of ADVENTURE_FIELDS) {
        const batch = creates.filter(o => !o.parent && o.type === type);
        if (!batch.length) continue;
        const datas = batch.map(o => {
          const d = clone(o.data);
          stampTags(d, type, tags, contentHash(o.data));
          return d;
        });
        const cls = documentClass(type);
        try {
          await cls.createDocuments(datas, { keepId: true });
        } catch (e) {
          for (const o of batch) {
            const where = await this.deps.savedAfterFailedCreate(cls, worldCollection(type), o.id);
            if (where === 'client')
              undo.push({ kind: 'created', type, id: o.id, parent: null, field: null });
          }
          throw e;
        }
        for (const o of batch) {
          undo.push({ kind: 'created', type, id: o.id, parent: null, field: null });
          intended.set(opKey(o), o);
        }
      }
      // 2. embedded creates, grouped by parent and type
      const embeddedGroups = new Map<string, Extract<UpdateOp, { action: 'create' }>[]>();
      for (const o of creates.filter(c => c.parent)) {
        const key = `${parentKey(o.parent)}|${o.type}`;
        embeddedGroups.set(key, [...(embeddedGroups.get(key) ?? []), o]);
      }
      for (const batch of embeddedGroups.values()) {
        const first = batch[0];
        const parentDoc = resolveParent(first.parent!);
        if (!parentDoc)
          throw new Error(
            `the parent ${parentKey(first.parent)} of new ${first.type} documents is gone`
          );
        const datas = batch.map(o => {
          const d = clone(o.data);
          stampTags(d, o.type, tags, null);
          return d;
        });
        await parentDoc.createEmbeddedDocuments(first.type, datas, { keepId: true });
        for (const o of batch) {
          undo.push({ kind: 'created', type: o.type, id: o.id, parent: o.parent, field: o.field });
          intended.set(opKey(o), o);
        }
      }
      // 3. updates, top-level by type, embedded by parent and type
      const updateGroups = new Map<string, Extract<UpdateOp, { action: 'update' }>[]>();
      for (const o of updates) {
        const key = `${parentKey(o.parent)}|${o.type}`;
        updateGroups.set(key, [...(updateGroups.get(key) ?? []), o]);
      }
      for (const batch of updateGroups.values()) {
        const first = batch[0];
        const payloads: any[] = [];
        const befores: UndoEntry[] = [];
        for (const o of batch) {
          const live = liveDocFor(o);
          if (!live) throw new Error(`${o.type} ${o.id} is gone from the world`);
          const now = toData(live);
          const payload = updatePayload(o, { build: plan.target_build });
          const before: Record<string, any> = {};
          for (const path of [
            ...Object.keys(o.set),
            ...o.unset,
            'flags.aidm.build',
            ...(o.hash !== null ? ['flags.aidm.hash'] : []),
          ]) {
            before[path] = clone(getPath(now, path));
          }
          payloads.push(payload);
          befores.push({
            kind: 'updated',
            type: o.type,
            id: o.id,
            parent: o.parent,
            field: o.field,
            before,
          });
          intended.set(opKey(o), o);
        }
        if (first.parent) {
          const parentDoc = resolveParent(first.parent);
          if (!parentDoc) throw new Error(`the parent ${parentKey(first.parent)} is gone`);
          await parentDoc.updateEmbeddedDocuments(first.type, payloads);
        } else {
          await documentClass(first.type).updateDocuments(payloads);
        }
        undo.push(...befores);
      }
      // 4. embedded deletes
      const deleteGroups = new Map<string, Extract<UpdateOp, { action: 'delete' }>[]>();
      for (const o of deletes.filter(d => d.parent)) {
        const key = `${parentKey(o.parent)}|${o.type}`;
        deleteGroups.set(key, [...(deleteGroups.get(key) ?? []), o]);
      }
      for (const batch of deleteGroups.values()) {
        const first = batch[0];
        const parentDoc = resolveParent(first.parent!);
        if (!parentDoc) throw new Error(`the parent ${parentKey(first.parent)} is gone`);
        const snaps = batch.map(o => ({ o, snap: toData(liveDocFor(o)) }));
        await parentDoc.deleteEmbeddedDocuments(
          first.type,
          batch.map(o => o.id)
        );
        for (const { o, snap } of snaps) {
          undo.push({
            kind: 'deleted',
            type: o.type,
            id: o.id,
            parent: o.parent,
            field: o.field,
            snapshot: snap,
          });
          intended.set(opKey(o), o);
        }
      }
      // 5. top-level deletes, reverse create order
      for (const [, type] of ADVENTURE_FIELDS.slice().reverse()) {
        const batch = deletes.filter(o => !o.parent && o.type === type);
        if (!batch.length) continue;
        const snaps = batch.map(o => ({ o, snap: toData(worldCollection(type)?.get?.(o.id)) }));
        await documentClass(type).deleteDocuments(batch.map(o => o.id));
        for (const { o, snap } of snaps) {
          undo.push({ kind: 'deleted', type, id: o.id, parent: null, field: null, snapshot: snap });
          intended.set(opKey(o), o);
        }
      }

      // 6. read back every write
      const problems: string[] = [];
      for (const op of intended.values()) {
        const live = liveDocFor(op);
        const label = `${op.type} ${op.id}${op.parent ? ` in ${parentKey(op.parent)}` : ''}`;
        if (op.action === 'delete') {
          if (live) problems.push(`${label}: still in the world after its delete`);
          continue;
        }
        const coll =
          op.parent && op.field ? resolveParent(op.parent)?.[op.field] : worldCollection(op.type);
        if (coll?.invalidDocumentIds?.has?.(op.id)) {
          problems.push(`${label}: Foundry could not load it after the write (invalidDocumentIds)`);
          continue;
        }
        if (!live) {
          problems.push(`${label}: not in the world after the write`);
          continue;
        }
        if (op.action === 'update') {
          const now = toData(live);
          for (const [path, value] of Object.entries(op.set)) {
            if (!sameValue(getPath(now, path), value))
              problems.push(`${label}: ${path} did not read back as written`);
          }
          for (const path of op.unset) {
            if (getPath(now, path) !== undefined) problems.push(`${label}: ${path} is still set`);
          }
          if (getPath(now, 'flags.aidm.build') !== plan.target_build)
            problems.push(`${label}: build tag not written`);
        }
      }
      if (problems.length) {
        throw Object.assign(
          new Error(`the update failed its read-back check: ${problems.slice(0, 5).join('; ')}`),
          { problems }
        );
      }
      return {
        success: true,
        mode,
        changed: plan.ops.length > 0,
        module_id: plan.module_id,
        adventure_id: plan.adventure_id,
        base_build: plan.base_build,
        target_build: plan.target_build,
        summary: plan.summary,
        kept_gm_edits: capList(plan.kept, 300).items,
        protected_play_state: capList(plan.protected, 300).items,
        skipped: plan.skipped,
        verification: { writes_checked: intended.size, problems: [] },
      };
    } catch (e: any) {
      const undone = await this.undoAll(undo);
      return {
        success: false,
        mode,
        changed: undone.failed.length > 0,
        module_id: plan.module_id,
        adventure_id: plan.adventure_id,
        error: `Update failed: ${String(e?.message ?? e)}. ${
          undo.length
            ? undone.failed.length
              ? `Undo could NOT restore ${undone.failed.length} write(s); see undo.failed.`
              : `Every write this call made (${undone.restored.length}) was undone.`
            : 'Nothing had been written.'
        }`,
        ...(Array.isArray(e?.problems) ? { problems: e.problems } : {}),
        undo: undone,
      };
    }
  }

  private async undoAll(undo: UndoEntry[]): Promise<{
    restored: { kind: string; type: string; id: string }[];
    failed: { kind: string; type: string; id: string; error: string }[];
  }> {
    const restored: { kind: string; type: string; id: string }[] = [];
    const failed: { kind: string; type: string; id: string; error: string }[] = [];
    for (const u of undo.slice().reverse()) {
      try {
        if (u.kind === 'created') {
          if (u.parent) await resolveParent(u.parent).deleteEmbeddedDocuments(u.type, [u.id]);
          else await documentClass(u.type).deleteDocuments([u.id]);
        } else if (u.kind === 'updated') {
          const payload: Record<string, any> = { _id: u.id };
          for (const [path, value] of Object.entries(u.before)) {
            if (value === undefined) {
              const i = path.lastIndexOf('.');
              payload[i < 0 ? `-=${path}` : `${path.slice(0, i)}.-=${path.slice(i + 1)}`] = null;
            } else payload[path] = value;
          }
          if (u.parent) await resolveParent(u.parent).updateEmbeddedDocuments(u.type, [payload]);
          else await documentClass(u.type).updateDocuments([payload]);
        } else {
          if (u.parent)
            await resolveParent(u.parent).createEmbeddedDocuments(u.type, [u.snapshot], {
              keepId: true,
            });
          else await documentClass(u.type).createDocuments([u.snapshot], { keepId: true });
        }
        restored.push({ kind: u.kind, type: u.type, id: u.id });
      } catch (e) {
        failed.push({ kind: u.kind, type: u.type, id: u.id, error: errText(e) });
      }
    }
    return { restored, failed };
  }

  // ---- aidm-module-remove -------------------------------------------------------------------

  async remove(data: {
    module_id?: string;
    adventure_id?: string;
    disable_module?: boolean;
    reload?: boolean;
    reload_delay_ms?: number;
    apply?: boolean;
    plan_id?: string;
    call_id?: string;
  }): Promise<any> {
    if (!this.deps.isGM()) return accessDenied();
    const moduleId = data?.module_id;
    const apply = data?.apply === true;
    const mode = apply ? 'apply' : 'dry-run';
    if (!isAidmModuleId(moduleId)) return badModuleId(mode);
    const adventureId =
      typeof data?.adventure_id === 'string' && data.adventure_id ? data.adventure_id : null;
    const disable = !adventureId && data?.disable_module !== false;
    if (!apply) {
      try {
        const plan = this.removePlan(moduleId, adventureId, disable);
        return {
          success: true,
          mode,
          changed: false,
          ...this.removePlanView(plan),
          next_step: plan.refusal
            ? `Apply would be refused now: ${plan.refusal}`
            : `Dry run only: nothing was changed. To delete the ${plan.total} document(s) listed, call again with apply: true and plan_id "${plan.plan_id}".`,
        };
      } catch (e) {
        return { success: false, mode, changed: false, error: errText(e) };
      }
    }
    if (typeof data?.plan_id !== 'string' || !data.plan_id) {
      return {
        success: false,
        mode,
        changed: false,
        error:
          'Refused: apply needs the plan_id from a dry run of this same remove. Nothing was changed.',
      };
    }
    return await this.journaled('aidm-module-remove', data, moduleId, adventureId, () =>
      this.removeApply(
        moduleId,
        adventureId,
        disable,
        String(data.plan_id),
        data?.reload !== false,
        this.reloadDelay(data)
      )
    );
  }

  private removePlan(moduleId: string, adventureId: string | null, disable: boolean) {
    const tagged = taggedDocuments(moduleId, adventureId);
    const copies = tagged.filter(d => d.copy);
    const doomed = tagged.filter(d => !d.copy);
    const byType: Record<string, { id: string; name: string | null }[]> = {};
    for (const d of doomed) (byType[d.type] ??= []).push({ id: d.id, name: d.name });
    const doomedIds = new Set(doomed.map(d => `${d.type}:${d.id}`));
    // Embedded documents carrying this module's tag inside documents that are NOT removed (a GM pasted
    // them into their own scene, or they sit in a GM copy): never deleted, reported.
    let leftElsewhere = 0;
    for (const type of WORLD_DOCUMENT_NAMES) {
      for (const doc of contentsOf(worldCollection(type))) {
        if (doomedIds.has(`${type}:${doc.id}`)) continue;
        for (const n of Object.values(taggedEmbedded(type, doc, moduleId))) leftElsewhere += n;
      }
    }
    // Tokens on scenes that are NOT removed (a GM placed the module's monsters on their own scene) whose
    // actor this remove deletes: they would be left with no actor. Reported, never deleted.
    const doomedActors = new Set(doomed.filter(d => d.type === 'Actor').map(d => d.id));
    const orphanedTokens: {
      scene_id: string;
      scene_name: string | null;
      token_id: string;
      actor_id: string;
    }[] = [];
    if (doomedActors.size) {
      for (const scene of contentsOf(worldCollection('Scene'))) {
        if (doomedIds.has(`Scene:${scene.id}`)) continue;
        for (const t of contentsOf(scene.tokens)) {
          const actorId = t?.actorId ?? t?._source?.actorId;
          if (actorId && doomedActors.has(actorId)) {
            orphanedTokens.push({
              scene_id: scene.id,
              scene_name: scene.name ?? null,
              token_id: t.id,
              actor_id: actorId,
            });
          }
        }
      }
    }
    const inPlay = doomed
      .filter(d => d.type === 'Scene')
      .map(d => ({
        scene_id: d.id,
        name: d.name,
        reasons: sceneInPlayReasons(readSceneFacts(d.doc)),
      }))
      .filter(s => s.reasons.length);
    const connected = readConnectedOthers();
    let refusal: string | null = null;
    if (inPlay.length) {
      refusal = `${inPlay.length} scene(s) of this module are in play: ${inPlay
        .map(s => `"${s.name}" (${s.reasons.join('; ')})`)
        .join('; ')}`;
    } else {
      refusal = connectedRefusal(connected);
    }
    const lines = [
      `module:${moduleId}`,
      `adventure:${adventureId ?? ''}`,
      `disable:${disable}`,
      ...doomed.map(d => `D:${d.type}:${d.id}`).sort(),
    ];
    const plan_id = `mr-${doomed.length}-${contentHash(lines.join('\n')).slice(0, 8)}`;
    return {
      module_id: moduleId,
      adventure_id: adventureId,
      disable,
      byType,
      total: doomed.length,
      doomed,
      copies: copies.map(c => ({ type: c.type, id: c.id, name: c.name })),
      leftElsewhere,
      orphanedTokens,
      inPlay,
      connected,
      refusal,
      plan_id,
    };
  }

  private removePlanView(plan: ReturnType<AidmModuleHandlers['removePlan']>): any {
    const counts: Record<string, number> = {};
    for (const [type, list] of Object.entries(plan.byType)) counts[type] = list.length;
    return {
      module_id: plan.module_id,
      adventure_id: plan.adventure_id,
      plan_id: plan.plan_id,
      will_delete: Object.fromEntries(
        Object.entries(plan.byType).map(([type, list]) => [type, capList(list, 300).items])
      ),
      counts,
      total: plan.total,
      kept_gm_copies: plan.copies,
      tagged_embedded_left_in_other_documents: plan.leftElsewhere,
      tokens_left_without_their_actor: capList(plan.orphanedTokens, 100).items,
      in_play: plan.inPlay,
      connected: plan.connected === null ? null : plan.connected.length,
      will_disable_module: plan.disable,
    };
  }

  private async removeApply(
    moduleId: string,
    adventureId: string | null,
    disable: boolean,
    planId: string,
    reload: boolean,
    delayMs: number
  ): Promise<any> {
    const mode = 'apply';
    const plan = this.removePlan(moduleId, adventureId, disable);
    const refuse = (error: string, extra: any = {}) => ({
      success: false,
      mode,
      changed: false,
      module_id: moduleId,
      adventure_id: adventureId,
      error,
      ...extra,
    });
    if (plan.total === 0 && !disable) {
      return {
        success: true,
        mode,
        changed: false,
        module_id: moduleId,
        adventure_id: adventureId,
        deleted: {},
        remaining: 0,
        note: 'Nothing tagged with this module is in the world. Nothing was changed.',
      };
    }
    if (plan.plan_id !== planId) {
      return refuse(
        'Refused: the plan_id does not match the plan built from the world now (or no dry run was run). Nothing was ' +
          'changed. Run the dry run again, read it, then apply with the plan_id it returns.',
        { counts: this.removePlanView(plan).counts }
      );
    }
    if (plan.refusal) {
      return refuse(`Refused: ${plan.refusal}. Nothing was deleted.`, { in_play: plan.inPlay });
    }
    if (disable && this.deps.lock.pending() > 1) {
      return refuse(
        'Refused: other bridge write calls are queued, and disabling the module reloads the world. Nothing was deleted.'
      );
    }
    const deleted: Record<string, string[]> = {};
    const failed: { type: string; ids: string[]; error: string }[] = [];
    for (const [, type] of ADVENTURE_FIELDS.slice().reverse()) {
      let docs = plan.doomed.filter(d => d.type === type);
      if (!docs.length) continue;
      if (type === 'Folder') {
        const depth = (d: TaggedDoc) => {
          let n = 0;
          let f = d.doc;
          while (f?.folder && n < 50) {
            f = f.folder;
            n += 1;
          }
          return n;
        };
        docs = docs.slice().sort((a, b) => depth(b) - depth(a));
      }
      const cls = documentClass(type);
      for (let i = 0; i < docs.length; i += DELETE_BATCH) {
        const ids = docs.slice(i, i + DELETE_BATCH).map(d => d.id);
        try {
          await cls.deleteDocuments(ids);
          (deleted[type] ??= []).push(...ids);
        } catch (e) {
          failed.push({ type, ids, error: errText(e) });
        }
      }
    }
    const remaining = taggedDocuments(moduleId, adventureId).filter(d => !d.copy);
    const deletedCounts = Object.fromEntries(
      Object.entries(deleted).map(([t, ids]) => [t, ids.length])
    );
    if (failed.length || remaining.length) {
      return {
        success: false,
        mode,
        changed: Object.keys(deleted).length > 0,
        module_id: moduleId,
        adventure_id: adventureId,
        deleted: deletedCounts,
        failed,
        remaining: remaining.length,
        remaining_documents: capList(
          remaining.map(r => ({ type: r.type, id: r.id, name: r.name })),
          100
        ).items,
        module_disabled: false,
        error:
          `Removed ${Object.values(deletedCounts).reduce((a, b) => a + b, 0)} document(s), but ${remaining.length} ` +
          'tagged document(s) are still in the world, so the module was NOT disabled. Run the dry run again and repeat.',
      };
    }
    let disabled: any = null;
    if (disable) {
      const setting = readModuleSetting();
      if (setting && setting[moduleId] === true) {
        await g().game.settings.set('core', 'moduleConfiguration', {
          ...setting,
          [moduleId]: false,
        });
        const after = readModuleSetting();
        const ok = !!after && after[moduleId] !== true;
        if (ok && reload) this.scheduleReload(delayMs);
        disabled = {
          disabled: ok,
          reload: { scheduled: ok && reload, in_ms: ok && reload ? delayMs : null },
        };
        if (!ok) {
          return {
            success: false,
            mode,
            changed: true,
            module_id: moduleId,
            deleted: deletedCounts,
            remaining: 0,
            module_disabled: false,
            error:
              'Every tagged document was removed, but the module setting did not read back as disabled. Read aidm-module-status.',
          };
        }
      } else {
        disabled = {
          disabled: false,
          reload: { scheduled: false, in_ms: null },
          note: 'the module was not enabled in this world',
        };
      }
    }
    return {
      success: true,
      mode,
      changed: true,
      module_id: moduleId,
      adventure_id: adventureId,
      deleted: deletedCounts,
      remaining: 0,
      kept_gm_copies: plan.copies,
      tagged_embedded_left_in_other_documents: plan.leftElsewhere,
      tokens_left_without_their_actor: capList(plan.orphanedTokens, 100).items,
      module_disabled: !!disabled?.disabled,
      ...(disabled ? { disable: disabled } : {}),
      note:
        'The module folder itself stays on disk: stage a removal for the boot-time swap, which moves it out (kept ' +
        'for rollback) at the next Foundry restart.',
    };
  }
}
