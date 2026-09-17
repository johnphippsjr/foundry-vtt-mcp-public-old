/**
 * Pure helpers for adventure-import / scene-integrity (board #1311 root-cause fix).
 *
 * These carry NO dependency on Foundry's browser globals (game, CONFIG, Scene, ...), unlike the
 * rest of queries.ts, specifically so they can be unit tested with plain vitest -- the
 * foundry-module package otherwise has no test harness at all, because the query handlers need a
 * live Foundry client environment to run.
 */

/** A single "field path -> uuid string" hit found while walking a document's data. */
export interface SceneUuidHit {
  path: string;
  value: string;
}

/**
 * True if `v` looks like a Foundry document uuid rooted at a Scene, e.g. "Scene.<id>" or
 * "Scene.<id>.Region.<id>". Foundry document ids are 16-char alphanumeric
 * (foundry.utils.randomID()); requiring that exact shape after "Scene." -- rather than just
 * testing for the literal prefix -- keeps this from flagging incidental strings that happen to
 * start with the word "Scene" (e.g. "Scene Selection") as a false unresolved reference.
 */
export function looksLikeSceneUuid(v: unknown): v is string {
  return typeof v === 'string' && /^Scene\.[A-Za-z0-9]{16}(\.|$)/.test(v);
}

/**
 * Recursively walks any plain-object/array data structure (typically a RegionBehavior's
 * .toObject() output) and collects every string field that looks like a Scene-rooted uuid.
 * Deliberately untyped/unscoped to any known field name (e.g. "destination") so a brand-new
 * behavior type with its own uuid-bearing field is still caught without this code needing to
 * know its name.
 */
export function walkForSceneUuids(
  obj: any,
  path: string,
  seen: Set<any>,
  out: SceneUuidHit[]
): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    if (looksLikeSceneUuid(obj)) out.push({ path, value: obj });
    return;
  }
  if (typeof obj !== 'object') return;
  if (seen.has(obj)) return; // cycle guard
  seen.add(obj);
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walkForSceneUuids(v, `${path}[${i}]`, seen, out));
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    walkForSceneUuids(v, path ? `${path}.${k}` : k, seen, out);
  }
}

/**
 * The module (package) id that owns a compendium pack, read off the pack's own metadata --
 * never a hardcoded module id. `packageName` is the documented v13 CompendiumCollection.Metadata
 * field; `pack.collection` (format "<packageName>.<packName>") is a defensive fallback for any
 * pack object that does not carry it directly.
 */
export function packModuleId(pack: any): string | undefined {
  const meta = pack?.metadata || {};
  if (meta.packageName) return meta.packageName;
  if (typeof pack?.collection === 'string') return pack.collection.split('.')[0];
  return undefined;
}

export interface UnresolvedSceneRef {
  scene_id: string;
  region_id: string | null;
  behavior_id: string | null;
  target: string;
}

/** Builds the human-readable `error` string from the unresolved shape, or undefined if clean. */
export function summarizeUnresolved(
  sceneRefs: UnresolvedSceneRef[],
  actorIds: string[]
): string | undefined {
  if (!sceneRefs.length && !actorIds.length) return undefined;
  const parts: string[] = [];
  if (sceneRefs.length) {
    const shown = sceneRefs
      .slice(0, 5)
      .map(
        r =>
          `${r.target} (scene ${r.scene_id}${r.region_id ? ', region ' + r.region_id : ''}${
            r.behavior_id ? ', behavior ' + r.behavior_id : ''
          })`
      )
      .join('; ');
    parts.push(
      `${sceneRefs.length} unresolved scene/region reference(s): ${shown}` +
        (sceneRefs.length > 5 ? `; +${sceneRefs.length - 5} more` : '')
    );
  }
  if (actorIds.length) {
    const shown = actorIds.slice(0, 10).join(', ');
    parts.push(
      `${actorIds.length} unresolved actor id(s): ${shown}` +
        (actorIds.length > 10 ? `; +${actorIds.length - 10} more` : '')
    );
  }
  return parts.join(' | ');
}

/**
 * The module search scope for actor resolution: the module that owns `primaryPack`, plus every
 * module id listed under that module's own manifest relationships.requires. `readModule` is
 * injected so this stays testable without a live `game.modules` global -- callers in the browser
 * pass `(id) => (game as any).modules?.get(id)`.
 */
export function moduleSearchScope(primaryPack: any, readModule: (id: string) => any): Set<string> {
  const scope = new Set<string>();
  const rootId = packModuleId(primaryPack);
  if (rootId) scope.add(rootId);
  try {
    const mod: any = rootId ? readModule(rootId) : undefined;
    const requires = mod?.relationships?.requires;
    if (requires) {
      const list: any[] = Array.isArray(requires)
        ? requires
        : typeof requires?.values === 'function'
          ? Array.from(requires.values())
          : Object.values(requires);
      for (const dep of list) {
        const depId = dep?.id || dep?.name;
        if (depId) scope.add(depId);
      }
    }
  } catch (e) {
    // Manifest relationship data is optional; best-effort only.
  }
  return scope;
}

/**
 * Read one key out of a document's `flags.aidm` namespace as a plain property -- never through
 * the getFlag flag-accessor method with scope "aidm" (board #1311, bridge/README.md 0007 entry).
 *
 * Foundry's Document flag-accessor methods (common/abstract/document.mjs) look up
 * `this.constructor.database.getFlagScopes()` and throw `Flag scope "<scope>" is not valid or
 * not currently active` for any scope that is not the id of an active package: a module, the
 * game system, "core", or "world". "aidm" is this lane's own flag namespace -- it is not a
 * package -- so calling a flag-accessor method with "aidm" as the scope argument throws
 * unconditionally on every call, on every world, regardless of what is stored under flags.aidm.
 * Foundry does not scope-check a plain property read/write, which is why every other writer in
 * this lane already reads/writes flags.aidm this way (e.g. scene.update({"flags.aidm.sourcePack":
 * ...}) / scene.flags?.aidm?.sourcePack) instead of the flag-accessor methods.
 */
export function readAidmFlag(doc: any, key: string): any {
  return doc?.flags?.aidm?.[key];
}

/**
 * True if `doc` already carries the aidm idempotency tags for this exact pack + source scene id,
 * read via readAidmFlag (never a flag-accessor method). Used to short-circuit a repeat
 * adventure-import call for a scene that was already adopted, and to skip re-tagging a sibling
 * scene that a prior call already tagged.
 */
export function isAdoptedFrom(doc: any, sourcePack: string, sourceSceneId: string): boolean {
  return (
    readAidmFlag(doc, 'sourcePack') === sourcePack &&
    readAidmFlag(doc, 'sourceSceneId') === sourceSceneId
  );
}

/**
 * Builds the dotted-path update payload for writing the aidm idempotency tags
 * (sourcePack/sourceSceneId/adoptedFor), for callers to pass straight to
 * `document.update(aidmTagUpdatePayload(...))` -- never the setFlag flag-accessor method with
 * scope "aidm" (same scope restriction as readAidmFlag above). Foundry's own dotted-path
 * flattening inside `update()` merges these into any existing `flags` object without disturbing
 * sibling keys under other namespaces, matching the merge semantics the setFlag accessor would
 * have provided if it were usable here.
 */
export function aidmTagUpdatePayload(tags: {
  sourcePack: string;
  sourceSceneId: string;
  adoptedFor: string;
}): Record<string, string> {
  return {
    'flags.aidm.sourcePack': tags.sourcePack,
    'flags.aidm.sourceSceneId': tags.sourceSceneId,
    'flags.aidm.adoptedFor': tags.adoptedFor,
  };
}

/** One document `adventure-import` created in the current call, tracked as it happens. */
export interface CreatedDocRef {
  /** Foundry document name, e.g. "Scene", "Actor", "JournalEntry", "Item", "Folder". */
  type: string;
  id: string;
  /**
   * Set to false when a create call failed but the server had already saved the document, and this
   * Foundry client never loaded it (board #1714 review 2). Rollback cannot delete such a document
   * from this client, and says so by id.
   */
  loadedInClient?: boolean;
}

/**
 * Flattens `Adventure#importContent`'s own `created` result (`Record<documentName, Document[]>`,
 * per the official v13 API: foundry.documents.types.AdventureImportResult) into an ordered
 * `{type, id}` list, preserving both the object's key order and each array's order -- this is the
 * import call's OWN record of exactly what it made, not something inferred afterward by diffing
 * world state. Generic over whatever document names `created` carries. Since board #1714,
 * `adventure-import` passes importContent a Scene-only `toCreate` (see planAdventureSceneImport),
 * so only a "Scene" key is present; any other key is still tracked the same way.
 * (Correction, board #1714: an earlier version of this comment said the tool "only requests
 * documentTypes: ['Scene']". Foundry 13.351 never read that option, so the old call really
 * imported every document type in the Adventure.)
 * Entries with no usable id (`id`/`_id` both missing) are skipped rather than pushed as `undefined`.
 */
export function collectCreatedDocuments(
  created: Record<string, Array<{ id?: string; _id?: string }>> | null | undefined
): CreatedDocRef[] {
  const out: CreatedDocRef[] = [];
  for (const [type, docs] of Object.entries(created ?? {})) {
    for (const doc of docs ?? []) {
      const id = doc?.id ?? doc?._id;
      if (id) out.push({ type, id });
    }
  }
  return out;
}

/** The outcome of attempting to delete one previously-created document during rollback. */
export interface CleanupAttempt {
  type: string;
  id: string;
  ok: boolean;
  error?: string;
}

/** `adventure-import`'s `cleanup` reply field: what rollback actually managed to remove. */
export interface CleanupReport {
  deleted: CreatedDocRef[];
  failed: { id: string; type: string; error: string }[];
}

/**
 * Turns a list of individual delete attempts (one per document, already run in reverse creation
 * order by the caller) into the `cleanup` reply shape: every document that deleted cleanly under
 * `deleted`, and every one that did not -- by id, with its own error -- under `failed`, rather
 * than collapsing a partial failure into one generic message. A caller that only sees `deleted`
 * would not know which specific document (if any) a user still has to remove by hand; this keeps
 * that list explicit so a partial cleanup is never reported as if it were a tidy one.
 */
export function summarizeCleanup(attempts: CleanupAttempt[]): CleanupReport {
  const deleted: CreatedDocRef[] = [];
  const failed: { id: string; type: string; error: string }[] = [];
  for (const a of attempts) {
    if (a.ok) {
      deleted.push({ type: a.type, id: a.id });
    } else {
      failed.push({ id: a.id, type: a.type, error: a.error || 'unknown error' });
    }
  }
  return { deleted, failed };
}

// ---- Scene-only, never-overwrite import planning (board #1714). ----
//
// What was wrong: adventure-import called adv.prepareImport({documentTypes: ['Scene']}). Foundry
// 13.351's Adventure#prepareImport (client foundry.mjs lines 41964-41995) never reads a
// `documentTypes` option. It reads `options.importFields`, and when that list is empty it imports
// EVERY content field (`importAll = !importFields.size || importFields.has("all")`, line 41970).
// It then splits each field's documents by whether the world already has that id
// (`collection.has(d._id)`, line 41976): new ids go to toCreate, existing ids go to toUpdate.
// Adventure#importContent (lines 42000-42033) creates toCreate with keepId:true and REPLACES
// every toUpdate document with `updateDocuments(..., {diff: false, recursive: false})`. So the old
// call imported actors, items, journals and folders too, and silently overwrote any world
// document that shared an id with the package, including scenes adopted and hand-edited earlier.
//
// The fix, in pure functions so it can be tested without a live Foundry:
//  1. sceneOnlyImportOptions() passes the option Foundry really reads: importFields ['scenes'].
//  2. nonSceneDocumentNames() checks the prepared data before anything is written, so a Foundry
//     version that ignores or renames importFields is refused instead of importing everything.
//  3. planAdventureSceneImport() decides, for every scene the package would import, whether to
//     create it, reuse an already-adopted world scene, or refuse. It never plans an update.

/**
 * The Adventure#prepareImport options that limit an import to Scene documents only.
 * `importFields` holds Adventure schema field names (BaseAdventure.defineSchema, foundry.mjs
 * lines 14416-14425: actors, combats, items, journal, scenes, tables, macros, cards, playlists,
 * folders). Because only "scenes" is listed, the folders field is skipped too (line 41973).
 * Returns a fresh object each call so no caller can mutate a shared constant.
 */
export function sceneOnlyImportOptions(): { importFields: string[] } {
  return { importFields: ['scenes'] };
}

/**
 * Every document name in prepared import data (`{toCreate, toUpdate}`, each keyed by document
 * name) that is not "Scene". Must be empty before importContent is allowed to run.
 */
export function nonSceneDocumentNames(importData: any): string[] {
  const names = new Set<string>();
  for (const part of [importData?.toCreate, importData?.toUpdate]) {
    for (const [name, docs] of Object.entries(part ?? {})) {
      if (name !== 'Scene' && Array.isArray(docs) && docs.length) names.add(name);
    }
  }
  return Array.from(names);
}

/**
 * True if a Foundry world collection already holds this id, either as a normal document or as a
 * stored document that failed data validation.
 *
 * Why the second part matters (board #1714 review): DocumentCollection#_initialize (foundry.mjs
 * lines 23909-23925) leaves a document whose stored data fails validation OUT of the collection
 * and only records its id in `invalidDocumentIds`, so `get(id)` and `has(id)` say it does not
 * exist (get returns it only with {invalid: true}, line 24014). The 13.351 server does not stop a
 * keepId create that reuses a top-level id (dist/database/backend/server-backend.mjs
 * _createDocuments only rejects duplicate ids for embedded documents), so creating that id would
 * silently replace the stored record. Such an id must be treated as taken.
 */
export function collectionHasId(collection: any, id: string): boolean {
  if (!collection || !id) return false;
  if (collection.get?.(id)) return true;
  return !!collection.invalidDocumentIds?.has?.(id);
}

/** A serial lock (see createSerialLock). */
export interface SerialLock {
  <T>(job: () => Promise<T>): Promise<T>;
  /** How many jobs are queued or running right now (board #1724: a world reload must not cut off queued calls). */
  pending(): number;
}

/**
 * A lock that runs async jobs one at a time, in call order (a promise chain). adventure-import and
 * adventure-source-backfill apply both plan from live state and then write, so two calls handled
 * by the same Foundry client must not interleave between the plan and the write (board #1714
 * review). A job that throws does not block the jobs after it. It does not protect against a
 * second GM client running its own bridge module at the same time. Board #1724: the aidm-module-*
 * tools share this same lock, and pending() counts the jobs queued or running.
 */
export function createSerialLock(): SerialLock {
  let tail: Promise<unknown> = Promise.resolve();
  let count = 0;
  const lock = (<T>(job: () => Promise<T>): Promise<T> => {
    count += 1;
    const run = tail.then(() => job());
    const done = () => {
      count -= 1;
    };
    tail = run.then(done, done);
    return run;
  }) as SerialLock;
  lock.pending = () => count;
  return lock;
}

/** Every world document carrying the aidm source tags for this exact pack + source scene id. */
export function findAdoptedScenes(
  worldScenes: Iterable<any>,
  sourcePack: string,
  sourceSceneId: string
): any[] {
  const out: any[] = [];
  for (const s of worldScenes ?? []) {
    if (isAdoptedFrom(s, sourcePack, sourceSceneId)) out.push(s);
  }
  return out;
}

/** A package scene that adventure-import refused to import, and why. */
export interface SceneImportConflict {
  /** The id the package scene would be imported under (its own id, since import keeps ids). */
  scene_id: string;
  /** The world scene's name when one already holds that id, otherwise the package scene name. */
  scene_name: string | null;
  reason:
    | 'id-taken-untagged'
    | 'id-taken-other-source'
    | 'id-taken-invalid'
    | 'ambiguous-adopted-copies';
  /** The source tags the blocking world scene already carries, when it carries any. */
  tagged_source: { sourcePack: string; sourceSceneId: string } | null;
  /** World scene ids involved (the blocking scene, or every ambiguous tagged copy). */
  world_scene_ids: string[];
}

export interface SceneImportPlan {
  /** Scene source data to create, with the aidm source tags already stamped in. */
  create: any[];
  /** Package scenes that are already adopted in the world and are used as they are. */
  reuse: { source_scene_id: string; world_scene_id: string }[];
  /** Package scenes that block the import. When non-empty, nothing may be written at all. */
  conflicts: SceneImportConflict[];
}

function sourceTagsOf(doc: any): { sourcePack: string; sourceSceneId: string } | null {
  const sourcePack = readAidmFlag(doc, 'sourcePack');
  const sourceSceneId = readAidmFlag(doc, 'sourceSceneId');
  if (typeof sourcePack !== 'string' && typeof sourceSceneId !== 'string') return null;
  return { sourcePack: String(sourcePack ?? ''), sourceSceneId: String(sourceSceneId ?? '') };
}

/**
 * Decides what adventure-import may do with each scene a package would import. The rule:
 *  - A world scene already holds the package scene's id:
 *      - it carries matching source tags (sourcePack + sourceSceneId): REUSE it, untouched;
 *      - it carries no tags, or tags for a different source: CONFLICT. The import is refused and
 *        that scene is never touched. (A same-id import would overwrite it wholesale.)
 *  - The id belongs to a stored world scene that failed data validation (isInvalidId): CONFLICT.
 *    Such a scene is missing from game.scenes, but a keepId create would silently replace it.
 *  - No world scene holds the id:
 *      - exactly one world scene is tagged as adopted from it (for example a copy made under a
 *        new id): REUSE that one, so no duplicate is created;
 *      - more than one is tagged: CONFLICT (ambiguous, refuse rather than guess);
 *      - none: CREATE it, with sourcePack / sourceSceneId / adoptedFor stamped into the create
 *        data so the new scene is findable by the next call, and with a `folder` pointing at a
 *        folder that does not exist in the world cleared to null (folders are never imported).
 * There is no branch that plans an update of an existing document.
 */
export function planAdventureSceneImport(opts: {
  packCollection: string;
  targetSceneId: string;
  /** Every Scene the package would import: prepared toCreate.Scene plus toUpdate.Scene. */
  preparedScenes: any[];
  /** Looks up a world scene by id (game.scenes.get). */
  getWorldScene: (id: string) => any;
  /** All world scenes, for the source-tag lookup. */
  worldScenes: Iterable<any>;
  /** True if a Folder with this id exists in the world (game.folders.has). */
  folderExists: (id: string) => boolean;
  /** True if the world stores a scene with this id that failed validation (invalidDocumentIds). */
  isInvalidId?: (id: string) => boolean;
}): SceneImportPlan {
  const plan: SceneImportPlan = { create: [], reuse: [], conflicts: [] };
  const seen = new Set<string>();
  const worldScenes = Array.from(opts.worldScenes ?? []);
  for (const src of opts.preparedScenes ?? []) {
    const srcId: string | undefined = src?._id ?? src?.id;
    if (!srcId || seen.has(srcId)) continue;
    seen.add(srcId);

    const sameId = opts.getWorldScene(srcId);
    if (sameId) {
      if (isAdoptedFrom(sameId, opts.packCollection, srcId)) {
        plan.reuse.push({ source_scene_id: srcId, world_scene_id: sameId.id ?? srcId });
      } else {
        const tags = sourceTagsOf(sameId);
        plan.conflicts.push({
          scene_id: srcId,
          scene_name: sameId.name ?? src?.name ?? null,
          reason: tags ? 'id-taken-other-source' : 'id-taken-untagged',
          tagged_source: tags,
          world_scene_ids: [sameId.id ?? srcId],
        });
      }
      continue;
    }

    if (opts.isInvalidId?.(srcId)) {
      plan.conflicts.push({
        scene_id: srcId,
        scene_name: src?.name ?? null,
        reason: 'id-taken-invalid',
        tagged_source: null,
        world_scene_ids: [srcId],
      });
      continue;
    }

    const tagged = findAdoptedScenes(worldScenes, opts.packCollection, srcId);
    if (tagged.length === 1) {
      plan.reuse.push({ source_scene_id: srcId, world_scene_id: tagged[0].id });
      continue;
    }
    if (tagged.length > 1) {
      plan.conflicts.push({
        scene_id: srcId,
        scene_name: tagged[0]?.name ?? src?.name ?? null,
        reason: 'ambiguous-adopted-copies',
        tagged_source: { sourcePack: opts.packCollection, sourceSceneId: srcId },
        world_scene_ids: tagged.map(t => t.id),
      });
      continue;
    }

    const data = JSON.parse(JSON.stringify(src));
    data.flags = data.flags && typeof data.flags === 'object' ? data.flags : {};
    data.flags.aidm = {
      ...(data.flags.aidm && typeof data.flags.aidm === 'object' ? data.flags.aidm : {}),
      sourcePack: opts.packCollection,
      sourceSceneId: srcId,
      adoptedFor: opts.targetSceneId,
    };
    if (data.folder && !opts.folderExists(data.folder)) data.folder = null;
    plan.create.push(data);
  }
  return plan;
}

/** The plain-English refusal message for a plan with conflicts. */
export function summarizeSceneConflicts(conflicts: SceneImportConflict[]): string {
  const describe = (c: SceneImportConflict): string => {
    const label = `"${c.scene_name ?? '(unnamed)'}" (${c.scene_id})`;
    if (c.reason === 'id-taken-untagged') {
      return `${label}: a world scene already has this id and is not tagged as adopted from this package`;
    }
    if (c.reason === 'id-taken-invalid') {
      return `${label}: the world stores a scene with this id that failed Foundry's data checks (it is hidden from the scene list), and importing would silently replace it`;
    }
    if (c.reason === 'id-taken-other-source') {
      const t = c.tagged_source;
      return `${label}: a world scene already has this id and is tagged as coming from ${t?.sourcePack} scene ${t?.sourceSceneId}`;
    }
    return `${label}: ${c.world_scene_ids.length} world scenes (${c.world_scene_ids.join(', ')}) are all tagged as adopted from it`;
  };
  return (
    `Refused: importing would overwrite or duplicate ${conflicts.length} existing world scene(s). ` +
    `Nothing was imported or changed. ${conflicts.map(describe).join('; ')}. ` +
    'If these are scenes adopted from this package earlier, run adventure-source-backfill ' +
    '(a dry run first) to tag them, then call adventure-import again.'
  );
}

/**
 * Error hint added when a scene's tokens need actors that are not in the world and the caller did
 * not ask adventure-import to create them (import_missing_actors, board #1714).
 */
export const MISSING_ACTORS_HINT =
  'Missing actors were not created, because adventure-import now creates only scenes by default. ' +
  'Call again with import_missing_actors: true to create them from the same module (it only ' +
  'creates actors whose ids are missing, and never changes an existing actor). Warning: it also ' +
  're-creates an actor the DM deleted on purpose, if a token still points at it.';
