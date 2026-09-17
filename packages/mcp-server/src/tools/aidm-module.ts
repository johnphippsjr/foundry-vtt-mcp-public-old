import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface AidmModuleToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

/**
 * Board #1724 (design order item 9, bridge part): the tools that install, update and remove an
 * imported book's own Foundry adventure module ("aidm-<name>-<8 hex>", packed offline by the
 * importer). The logic runs in the GM browser (foundry-module/src/aidm-module-handlers.ts); this
 * layer only advertises the tools and forwards the caller's arguments unchanged.
 *
 * OPERATOR TOOLS: the DM brain must hide every name in AIDM_MODULE_TOOL_NAMES from the DM model
 * (brain/app.py _HIDE_TOOLS), the same way adventure-import and adventure-source-backfill are
 * hidden. Every description says so, so a new consumer sees it too.
 */
export const AIDM_MODULE_TOOL_NAMES = [
  'aidm-module-status',
  'aidm-module-enable',
  'aidm-module-disable',
  'aidm-module-install',
  'aidm-module-update',
  'aidm-module-remove',
] as const;

const OPERATOR_ONLY =
  'OPERATOR TOOL for the importer and the brain orchestration: never offer it to the DM model. GM-only. ';

const MODULE_ID = {
  type: 'string',
  description:
    'The importer module id from module.json: "aidm-<name>-<8 hex digits>". Any other module id is refused.',
};

const CALL_ID = {
  type: 'string',
  description:
    'Optional. A caller-chosen id for this write. The bridge gives up waiting after 60 s but the call still runs in the GM client; aidm-module-status lists recent calls by call_id, and a repeat call with the same call_id is never run twice.',
};

export class AidmModuleTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: AidmModuleToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'AidmModuleTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'aidm-module-status',
        description: `${
          OPERATOR_ONLY
        }Read-only. For one importer module: is it registered with Foundry (the folder was there when Foundry started), is it enabled in this world, which build Foundry loaded, which build is on disk (module.json read over HTTP; a different build means a restart is needed), which builds the world copy is at (from flags.aidm.build on tagged documents), counts of tagged documents by type and of tagged embedded documents, the Adventures in its pack with how many of their documents are in the world, scenes of the module in play, how many other users are connected, whether a write is queued or running, and the recent write calls with their outcomes (use this to settle a call that timed out). Returns {success, mode:"status", module_id, module:{registered, enabled, enabled_setting, reload_pending, loaded_build, loaded_version, disk_read:"ok"|"missing"|"unreadable", disk_build, disk_version, restart_needed}, pack:{available, adventures:[{id,name,part,sort,world_documents,world_builds}], error?, note?}, world:{build, builds, mixed_builds, untagged_build_documents, documents:{Type:n}, embedded:{Type:n}, total, gm_copies, adventures_in_world:[{id,documents,builds}]}, in_play:[{scene_id,name,reasons}], connected, busy, queued_calls, recent_calls:[{call_id,tool,module_id,adventure_id,state,queued_at,started_at,finished_at,result}]}.`,
        inputSchema: {
          type: 'object',
          properties: { module_id: MODULE_ID },
          required: ['module_id'],
        },
      },
      {
        name: 'aidm-module-enable',
        description: `${
          OPERATOR_ONLY
        }Switch an importer module ON in this world (core.moduleConfiguration), then reload the world for every client. Refused, with nothing changed, when Foundry does not know the module (a new module folder needs a Foundry restart first), when any user other than this GM client is connected (or that cannot be read), when a scene tagged with the module is in play (the active scene, a player-character token on it, a combat on it, a connected user looking at it, or any of those unreadable), when a module it requires is not enabled, or when other bridge write calls are queued. Already enabled: success with changed:false. The reply is sent before the reload starts (reload_delay_ms, default 2000); the bridge connection then drops while the GM client reloads. Returns {success, mode:"enable", changed, module_id, enabled_setting, reload:{scheduled,in_ms}, note, call_id, error?, in_play?}.`,
        inputSchema: {
          type: 'object',
          properties: {
            module_id: MODULE_ID,
            reload: {
              type: 'boolean',
              description:
                'Default true. false saves the setting without a reload (it takes effect at the next reload or restart).',
            },
            reload_delay_ms: {
              type: 'number',
              description: 'Milliseconds to wait before the reload (250 to 30000, default 2000).',
            },
            call_id: CALL_ID,
          },
          required: ['module_id'],
        },
      },
      {
        name: 'aidm-module-disable',
        description: `${
          OPERATOR_ONLY
        }Switch an importer module OFF in this world, then reload the world for every client. Same refusals as aidm-module-enable (other users connected, a tagged scene in play, queued write calls). It does not delete documents (use aidm-module-remove, which also disables); tagged_documents_remain says how many are still in the world. Returns {success, mode:"disable", changed, module_id, enabled_setting, reload:{scheduled,in_ms}, tagged_documents_remain?, note, call_id, error?}.`,
        inputSchema: {
          type: 'object',
          properties: {
            module_id: MODULE_ID,
            reload: { type: 'boolean', description: 'Default true.' },
            reload_delay_ms: { type: 'number', description: '250 to 30000, default 2000.' },
            call_id: CALL_ID,
          },
          required: ['module_id'],
        },
      },
      {
        name: 'aidm-module-install',
        description: `${
          OPERATOR_ONLY
        }Install an enabled importer module's Adventures into this world, ONE Adventure per call. DRY RUN BY DEFAULT. Without adventure_id: the Adventures in install order (core first, then maps, then text) with how many of each one's documents are already in the world, and next_adventure. With adventure_id: the full plan: every document it would create (with embedded counts), every document already installed, every conflict, the state (not_installed, installed, installed_other_build, partial, conflicts), whether the order is right (the core Adventure must be installed first), and plan_id. Apply (apply:true, adventure_id, plan_id) imports every Adventure field (folders, actors, items, journal, tables, macros, cards, playlists, scenes, combats) through Foundry's own Adventure prepareImport/importContent with ids kept, and tags every created document and every embedded document with flags.aidm.module, flags.aidm.build (the loaded module build) and flags.aidm.adventure (top-level documents also get flags.aidm.hash). NEVER OVERWRITES: any id the world already uses for another document (untagged, another module's, another Adventure's, or a stored document Foundry could not load) refuses the whole call, and nothing is written. It then reads everything back: every document present and tagged, nothing in invalidDocumentIds, every embedded count equal to the Adventure's, token actors present, region references resolved. Any problem deletes everything the call created (reverse order) and reports it. A repeat apply of an Adventure that is already installed at this build returns success with changed:false (so a call that timed out can simply be settled with aidm-module-status or repeated). A stale or missing plan_id is refused without revealing the live plan. Runs one at a time with the other bridge writes. Returns dry run {success, mode:"dry-run", changed:false, module_id, adventure_id, adventure_name, part, build, state, plan_id, counts:{documents,embedded}, create:[{type,id,name,embedded}], already_installed, conflicts:[{type,id,name,reason,tagged_module}], order_ok, connected, next_step}; apply {success, mode:"apply", changed, module_id, adventure_id, build, state, created:{Type:n}, counts, verification:{documents_checked, problems}, reused?, problems?, cleanup?:{deleted,failed}, conflicts?, call_id, error?}.`,
        inputSchema: {
          type: 'object',
          properties: {
            module_id: MODULE_ID,
            adventure_id: {
              type: 'string',
              description:
                'The Adventure (in the module pack) to plan or install. Omit for the install-order overview.',
            },
            apply: { type: 'boolean', description: 'Default false (dry run).' },
            plan_id: {
              type: 'string',
              description:
                'Required with apply:true. The plan_id from a dry run of the same Adventure.',
            },
            call_id: CALL_ID,
          },
          required: ['module_id'],
        },
      },
      {
        name: 'aidm-module-update',
        description: `${
          OPERATOR_ONLY
        }Apply a new build of one Adventure onto its world copy with a THREE-WAY MERGE. DRY RUN BY DEFAULT. Inputs: the new build (target + target_build: the Adventure source JSON as packed, or omit to use the loaded pack when Foundry already loaded the newer build) and the build the world copy was installed from (base + base_build, from the build record; may be omitted only when that build is the one Foundry has loaded). Both are checked by Foundry's own data model first. For every document and field: a field the new build did not change is left alone; a field still holding what the importer wrote last time takes the new value; a field someone changed since is KEPT and listed (kept_gm_edits). Play state is never written: flags.aidm.itemsTaken and lastArea, Scene.active, token delta and actor hit points always; door state (Wall ds), token position/elevation/rotation/hidden and light or sound hidden once play began on that scene (it is or was in play, or an encounter started, a trap sprung, an item was taken, or a token moved); started/sprung records are kept as they are. A scene in play right now is skipped whole (run again later). Documents the new build adds are created and tagged; documents it drops are deleted only when unchanged since the import (never tokens or scenes where play began); documents a GM deleted stay deleted; documents a GM added are never touched; a document whose recorded content hash does not match the base given is skipped unless accept_base_mismatch. Touched top-level documents are re-tagged with target_build. Apply (apply:true + plan_id) writes in batches, reads every write back, and undoes every write of the call if anything fails. Returns dry run {success, mode:"dry-run", changed:false, module_id, adventure_id, base_build, target_build, plan_id, summary:{create,update,fields_written,delete,build_tag_only,kept_changes,protected_play_state,skipped}, ops:[{action,type,id,parent_id,paths?,build_tag_only?}], kept_gm_edits:[{type,id,parent_id,path,reason}], protected_play_state, skipped, in_play, play_began, next_step}; apply {success, mode:"apply", changed, summary, kept_gm_edits, protected_play_state, skipped, verification:{writes_checked,problems}, undo?:{restored,failed}, problems?, call_id, error?}.`,
        inputSchema: {
          type: 'object',
          properties: {
            module_id: MODULE_ID,
            adventure_id: { type: 'string', description: 'The Adventure to update.' },
            target: {
              type: 'object',
              description:
                'The new build of this Adventure: its pack source object (module_pack.py <module>.pack-src/adventure/<id>.json).',
            },
            target_build: {
              type: 'number',
              description: 'Required with target: its build number.',
            },
            base: {
              type: 'object',
              description:
                'The build the world copy was installed from (or last updated to): its pack source object.',
            },
            base_build: { type: 'number', description: 'Required with base: its build number.' },
            play_began_scene_ids: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Optional. Scene ids to treat as "play began" even without play-state flags.',
            },
            accept_base_mismatch: {
              type: 'boolean',
              description:
                "Default false. true merges documents whose recorded content hash differs from the base given (only if Foundry's cleaning changes the hash).",
            },
            apply: { type: 'boolean', description: 'Default false (dry run).' },
            plan_id: { type: 'string', description: 'Required with apply:true.' },
            call_id: CALL_ID,
          },
          required: ['module_id', 'adventure_id'],
        },
      },
      {
        name: 'aidm-module-remove',
        description: `${
          OPERATOR_ONLY
        }Remove an importer module from this world as one unit: delete every world document tagged flags.aidm.module = module_id (scenes, journals, actors, items, tables, macros, cards, playlists, then folders), then disable the module (a world reload). DRY RUN BY DEFAULT: lists what it would delete, GM copies it keeps (documents made with Duplicate carry the tags but are never deleted), tagged embedded documents inside other documents (never deleted), tokens on scenes that are not removed whose actor it would delete (reported, never deleted), scenes in play, and plan_id. With adventure_id only that Adventure's documents are removed and the module stays enabled. Apply (apply:true + plan_id) is refused, with nothing deleted, while a tagged scene is in play or any other user is connected (or either cannot be read). It reads the world back: the module is disabled only when no tagged document remains. The module folder is not touched: the boot-time swap moves it out at the next Foundry restart. Returns dry run {success, mode:"dry-run", changed:false, module_id, adventure_id, plan_id, will_delete:{Type:[{id,name}]}, counts, total, kept_gm_copies, tagged_embedded_left_in_other_documents, tokens_left_without_their_actor:[{scene_id,scene_name,token_id,actor_id}], in_play, connected, will_disable_module, next_step}; apply {success, mode:"apply", changed, deleted:{Type:n}, failed?, remaining, remaining_documents?, kept_gm_copies, tagged_embedded_left_in_other_documents, tokens_left_without_their_actor, module_disabled, disable?:{disabled, reload:{scheduled,in_ms}}, note, call_id, error?}.`,
        inputSchema: {
          type: 'object',
          properties: {
            module_id: MODULE_ID,
            adventure_id: {
              type: 'string',
              description: 'Optional. Remove only this Adventure (the module stays enabled).',
            },
            disable_module: {
              type: 'boolean',
              description: 'Default true when removing the whole module. false leaves it enabled.',
            },
            reload: { type: 'boolean', description: 'Default true (reload after disabling).' },
            reload_delay_ms: { type: 'number', description: '250 to 30000, default 2000.' },
            apply: { type: 'boolean', description: 'Default false (dry run).' },
            plan_id: { type: 'string', description: 'Required with apply:true.' },
            call_id: CALL_ID,
          },
          required: ['module_id'],
        },
      },
    ];
  }

  private forward(tool: string, args: any): Promise<any> {
    return this.foundryClient.query(`foundry-mcp-bridge.${tool}`, args);
  }

  async handleStatus(args: any): Promise<any> {
    return await this.forward('aidm-module-status', { module_id: args?.module_id });
  }

  async handleEnable(args: any): Promise<any> {
    return await this.forward('aidm-module-enable', {
      module_id: args?.module_id,
      reload: args?.reload,
      reload_delay_ms: args?.reload_delay_ms,
      call_id: args?.call_id,
    });
  }

  async handleDisable(args: any): Promise<any> {
    return await this.forward('aidm-module-disable', {
      module_id: args?.module_id,
      reload: args?.reload,
      reload_delay_ms: args?.reload_delay_ms,
      call_id: args?.call_id,
    });
  }

  // Dry run unless apply === true exactly; plan_id is forwarded untouched.
  async handleInstall(args: any): Promise<any> {
    return await this.forward('aidm-module-install', {
      module_id: args?.module_id,
      adventure_id: args?.adventure_id,
      apply: args?.apply === true,
      plan_id: args?.plan_id,
      call_id: args?.call_id,
    });
  }

  async handleUpdate(args: any): Promise<any> {
    return await this.forward('aidm-module-update', {
      module_id: args?.module_id,
      adventure_id: args?.adventure_id,
      target: args?.target,
      target_build: args?.target_build,
      base: args?.base,
      base_build: args?.base_build,
      play_began_scene_ids: Array.isArray(args?.play_began_scene_ids)
        ? args.play_began_scene_ids
        : undefined,
      accept_base_mismatch: args?.accept_base_mismatch === true,
      apply: args?.apply === true,
      plan_id: args?.plan_id,
      call_id: args?.call_id,
    });
  }

  async handleRemove(args: any): Promise<any> {
    return await this.forward('aidm-module-remove', {
      module_id: args?.module_id,
      adventure_id: args?.adventure_id,
      disable_module: args?.disable_module,
      reload: args?.reload,
      reload_delay_ms: args?.reload_delay_ms,
      apply: args?.apply === true,
      plan_id: args?.plan_id,
      call_id: args?.call_id,
    });
  }

  /** Dispatch by tool name (backend.ts). */
  async handleToolCall(name: string, args: any): Promise<any> {
    this.logger.debug?.('aidm-module tool call', { name });
    switch (name) {
      case 'aidm-module-status':
        return await this.handleStatus(args);
      case 'aidm-module-enable':
        return await this.handleEnable(args);
      case 'aidm-module-disable':
        return await this.handleDisable(args);
      case 'aidm-module-install':
        return await this.handleInstall(args);
      case 'aidm-module-update':
        return await this.handleUpdate(args);
      case 'aidm-module-remove':
        return await this.handleRemove(args);
      default:
        throw new Error(`Unknown aidm-module tool: ${name}`);
    }
  }
}
