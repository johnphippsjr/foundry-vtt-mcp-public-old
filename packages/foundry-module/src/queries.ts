import { MODULE_ID } from './constants.js';
import { FoundryDataAccess } from './data-access.js';
import { ComfyUIManager } from './comfyui-manager.js';
import {
  walkForSceneUuids,
  packModuleId,
  moduleSearchScope,
  summarizeUnresolved,
  isAdoptedFrom,
  aidmTagUpdatePayload,
  collectCreatedDocuments,
  summarizeCleanup,
  readAidmFlag,
  sceneOnlyImportOptions,
  nonSceneDocumentNames,
  findAdoptedScenes,
  planAdventureSceneImport,
  summarizeSceneConflicts,
  MISSING_ACTORS_HINT,
  collectionHasId,
  createSerialLock,
  type CreatedDocRef,
  type CleanupReport,
  type SceneImportConflict,
} from './adventure-import-utils.js';
import {
  planSourceTagBackfill,
  backfillUpdatePayload,
  parsePackArg,
  type BackfillPackScene,
  type BackfillWorldScene,
} from './adventure-source-backfill-utils.js';
import {
  selectDefaultCombatants,
  formatScopingSummary,
  type CombatToken,
} from './combat-scoping-utils.js';
import { staleCombatIdsToDelete } from './combat-cleanup-utils.js';
import { AidmModuleHandlers } from './aidm-module-handlers.js';
import {
  chooseAttackMode,
  weaponUsedUp,
  describeRangeRefusal,
  isUnarmedStrike,
  unarmedStrikeUuid,
  pickItemByName,
  usedUpCount,
  midiAttackOptions,
  midiCriticalDamageProblem,
  readMidiAttack,
  activitySpendsOnUse,
  spentOnUse,
  guardStoppedWorkflow,
  engineTargetCount,
  wrongNumberTargetsWords,
  isMidiRefusalText,
  usageCostErrors,
  consumedDeltas,
  midiSaveOptions,
  activityEffectChoices,
  itemEffectChoices,
  pickEffectChoice,
  effectChoiceWords,
  keepChosenEffect,
  type EffectChoice,
  MIDI_DEADLINE_MARGIN_MS,
  MIDI_MIN_RUN_MS,
} from './attack-rules-utils.js';

/** Board #1887 (round 3): execute-attack's default for Midi-QOL's per-call Dice So Nice switches (see
 * QueryHandlers#midiSkipDiceAnimation). Off: the operator chose "Fast, no robot dice" (2026-09-28); the robot GM's own
 * 3D dice are off in every world (gmhost 0.4.13), so Midi does not wait for them anyway. */
const SKIP_DICE_DEFAULT = false;

// Board #1714 review: adventure-import and adventure-source-backfill apply both plan from live
// state and then write. This module-level lock makes those calls run one at a time INSIDE THIS ONE
// Foundry client (the GM browser this module runs in). It does nothing about another GM client, or
// a person in the Foundry UI, creating a document with the same id at the same moment. Queued calls
// cannot be cancelled: a call the MCP side already gave up on (its 60 s query timeout) still runs
// when its turn comes. If a queued call's Foundry request never settles, later calls wait behind it
// until the page is reloaded.
// Board #1724: the aidm-module-* tools (install, update, remove, enable, disable) share this lock.
const adventureWriteLock = createSerialLock();

export class QueryHandlers {
  public dataAccess: FoundryDataAccess;
  private comfyuiManager: ComfyUIManager;
  private aidmModules: AidmModuleHandlers;

  constructor() {
    this.dataAccess = new FoundryDataAccess();
    this.comfyuiManager = new ComfyUIManager();
    // Board #1724: install, update and remove an imported book's Foundry module (aidm-module-*).
    this.aidmModules = new AidmModuleHandlers({
      lock: adventureWriteLock,
      isGM: () => this.validateGMAccess().allowed,
      rollbackCreated: created => this._rollbackCreatedDocuments(created),
      savedAfterFailedCreate: (cls, collection, id) =>
        this._savedAfterFailedCreate(cls, collection, id),
      resolveSceneRefs: scenes => this._resolveSceneRefs(scenes),
      missingActorIds: scenes => this._missingActorIds(scenes),
    });
  }

  /**
   * SECURITY: Validate GM access - returns silent failure for non-GM users
   */
  private validateGMAccess(): { allowed: boolean; error?: any } {
    if (!game.user?.isGM) {
      // Silent failure - no error message for non-GM users
      return { allowed: false };
    }
    return { allowed: true };
  }

  /**
   * Register all query handlers in CONFIG.queries
   */
  registerHandlers(): void {
    const modulePrefix = MODULE_ID;

    // Character/Actor queries
    CONFIG.queries[`${modulePrefix}.getCharacterInfo`] = this.handleGetCharacterInfo.bind(this);
    CONFIG.queries[`${modulePrefix}.listActors`] = this.handleListActors.bind(this);

    // Compendium queries
    CONFIG.queries[`${modulePrefix}.searchCompendium`] = this.handleSearchCompendium.bind(this);
    CONFIG.queries[`${modulePrefix}.listCreaturesByCriteria`] =
      this.handleListCreaturesByCriteria.bind(this);
    CONFIG.queries[`${modulePrefix}.getAvailablePacks`] = this.handleGetAvailablePacks.bind(this);
    CONFIG.queries[`${modulePrefix}.getPackIndex`] = this.handleGetPackIndex.bind(this);

    // Scene queries
    CONFIG.queries[`${modulePrefix}.getActiveScene`] = this.handleGetActiveScene.bind(this);
    CONFIG.queries[`${modulePrefix}.list-scenes`] = this.handleListScenes.bind(this);
    CONFIG.queries[`${modulePrefix}.switch-scene`] = this.handleSwitchScene.bind(this);
    CONFIG.queries[`${modulePrefix}.scene-create`] = this.handleSceneCreate.bind(this);
    CONFIG.queries[`${modulePrefix}.scene-update`] = this.handleSceneUpdate.bind(this);
    CONFIG.queries[`${modulePrefix}.list-installed-packages`] =
      this.handleListInstalledPackages.bind(this);
    CONFIG.queries[`${modulePrefix}.adventure-import`] = this.handleAdventureImport.bind(this);
    CONFIG.queries[`${modulePrefix}.scene-integrity`] = this.handleSceneIntegrity.bind(this);
    CONFIG.queries[`${modulePrefix}.adventure-source-backfill`] =
      this.handleAdventureSourceBackfill.bind(this);

    // Board #1724: an imported book's own Foundry module (install / update / remove). GM-only,
    // one write at a time (adventureWriteLock), hidden from the DM model by the brain.
    CONFIG.queries[`${modulePrefix}.aidm-module-status`] = this.handleAidmModuleStatus.bind(this);
    CONFIG.queries[`${modulePrefix}.aidm-module-enable`] = this.handleAidmModuleEnable.bind(this);
    CONFIG.queries[`${modulePrefix}.aidm-module-disable`] = this.handleAidmModuleDisable.bind(this);
    CONFIG.queries[`${modulePrefix}.aidm-module-install`] = this.handleAidmModuleInstall.bind(this);
    CONFIG.queries[`${modulePrefix}.aidm-module-update`] = this.handleAidmModuleUpdate.bind(this);
    CONFIG.queries[`${modulePrefix}.aidm-module-remove`] = this.handleAidmModuleRemove.bind(this);

    // Phase E wall/lighting queries (audited gap: no wall/light tools existed anywhere in the
    // fork before this). Same batched-embedded-document pattern as addActorsToScene/createTokens.
    CONFIG.queries[`${modulePrefix}.walls-create`] = this.handleWallsCreate.bind(this);
    CONFIG.queries[`${modulePrefix}.walls-delete`] = this.handleWallsDelete.bind(this);
    CONFIG.queries[`${modulePrefix}.list-walls`] = this.handleListWalls.bind(this);
    CONFIG.queries[`${modulePrefix}.lights-create`] = this.handleLightsCreate.bind(this);
    CONFIG.queries[`${modulePrefix}.lights-delete`] = this.handleLightsDelete.bind(this);
    CONFIG.queries[`${modulePrefix}.list-lights`] = this.handleListLights.bind(this);

    // Phase D user provisioning queries (join flow; PLAYER/TRUSTED only, never ASSISTANT/GM)
    CONFIG.queries[`${modulePrefix}.user-create`] = this.handleUserCreate.bind(this);
    CONFIG.queries[`${modulePrefix}.user-update`] = this.handleUserUpdate.bind(this);
    CONFIG.queries[`${modulePrefix}.list-users`] = this.handleListUsers.bind(this);
    CONFIG.queries[`${modulePrefix}.user-delete`] = this.handleUserDelete.bind(this);

    // World queries
    CONFIG.queries[`${modulePrefix}.getWorldInfo`] = this.handleGetWorldInfo.bind(this);

    // Utility queries
    CONFIG.queries[`${modulePrefix}.ping`] = this.handlePing.bind(this);
    CONFIG.queries[`${modulePrefix}.startCombat`] = this.handleStartCombat.bind(this);
    CONFIG.queries[`${modulePrefix}.endCombat`] = this.handleEndCombat.bind(this);
    CONFIG.queries[`${modulePrefix}.nextTurn`] = this.handleNextTurn.bind(this);
    CONFIG.queries[`${modulePrefix}.getCombatState`] = this.handleGetCombatState.bind(this);
    CONFIG.queries[`${modulePrefix}.executeAttack`] = this.handleExecuteAttack.bind(this);
    CONFIG.queries[`${modulePrefix}.diagEval`] = this.handleDiagEval.bind(this);

    // Phase 2 & 3: Write operation queries
    CONFIG.queries[`${modulePrefix}.createActorFromCompendium`] =
      this.handleCreateActorFromCompendium.bind(this);
    CONFIG.queries[`${modulePrefix}.getCompendiumDocumentFull`] =
      this.handleGetCompendiumDocumentFull.bind(this);
    CONFIG.queries[`${modulePrefix}.addActorsToScene`] = this.handleAddActorsToScene.bind(this);
    CONFIG.queries[`${modulePrefix}.validateWritePermissions`] =
      this.handleValidateWritePermissions.bind(this);
    CONFIG.queries[`${modulePrefix}.createJournalEntry`] = this.handleCreateJournalEntry.bind(this);
    CONFIG.queries[`${modulePrefix}.listJournals`] = this.handleListJournals.bind(this);
    CONFIG.queries[`${modulePrefix}.getJournalContent`] = this.handleGetJournalContent.bind(this);
    CONFIG.queries[`${modulePrefix}.getJournalPageContent`] =
      this.handleGetJournalPageContent.bind(this);
    CONFIG.queries[`${modulePrefix}.updateJournalContent`] =
      this.handleUpdateJournalContent.bind(this);

    // Phase 4: Dice roll queries
    CONFIG.queries[`${modulePrefix}.request-player-rolls`] =
      this.handleRequestPlayerRolls.bind(this);

    // Enhanced creature index for campaign analysis
    CONFIG.queries[`${modulePrefix}.getEnhancedCreatureIndex`] =
      this.handleGetEnhancedCreatureIndex.bind(this);

    // Campaign management queries
    CONFIG.queries[`${modulePrefix}.updateCampaignProgress`] =
      this.handleUpdateCampaignProgress.bind(this);

    // Phase 6: Actor ownership management
    CONFIG.queries[`${modulePrefix}.setActorOwnership`] = this.handleSetActorOwnership.bind(this);
    CONFIG.queries[`${modulePrefix}.getActorOwnership`] = this.handleGetActorOwnership.bind(this);
    CONFIG.queries[`${modulePrefix}.getFriendlyNPCs`] = this.handleGetFriendlyNPCs.bind(this);
    CONFIG.queries[`${modulePrefix}.getPartyCharacters`] = this.handleGetPartyCharacters.bind(this);
    CONFIG.queries[`${modulePrefix}.getConnectedPlayers`] =
      this.handleGetConnectedPlayers.bind(this);
    CONFIG.queries[`${modulePrefix}.findPlayers`] = this.handleFindPlayers.bind(this);
    CONFIG.queries[`${modulePrefix}.findActor`] = this.handleFindActor.bind(this);

    // WFRP4e actor stat-block update
    CONFIG.queries[`${modulePrefix}.updateWfrp4eActor`] = this.handleUpdateWfrp4eActor.bind(this);
    CONFIG.queries[`${modulePrefix}.addWfrp4eItems`] = this.handleAddWfrp4eItems.bind(this);

    // Token manipulation queries
    CONFIG.queries[`${modulePrefix}.moveToken`] = this.handleMoveToken.bind(this);
    CONFIG.queries[`${modulePrefix}.updateToken`] = this.handleUpdateToken.bind(this);
    CONFIG.queries[`${modulePrefix}.deleteTokens`] = this.handleDeleteTokens.bind(this);
    CONFIG.queries[`${modulePrefix}.getTokenDetails`] = this.handleGetTokenDetails.bind(this);
    CONFIG.queries[`${modulePrefix}.toggleTokenCondition`] =
      this.handleToggleTokenCondition.bind(this);
    CONFIG.queries[`${modulePrefix}.getAvailableConditions`] =
      this.handleGetAvailableConditions.bind(this);

    // Map generation queries (hybrid architecture)
    CONFIG.queries[`${modulePrefix}.generate-map`] = this.handleGenerateMap.bind(this);
    CONFIG.queries[`${modulePrefix}.check-map-status`] = this.handleCheckMapStatus.bind(this);
    CONFIG.queries[`${modulePrefix}.cancel-map-job`] = this.handleCancelMapJob.bind(this);
    CONFIG.queries[`${modulePrefix}.upload-generated-map`] =
      this.handleUploadGeneratedMap.bind(this);

    // Item usage queries
    CONFIG.queries[`${modulePrefix}.useItem`] = this.handleUseItem.bind(this);

    // Character search queries
    CONFIG.queries[`${modulePrefix}.searchCharacterItems`] =
      this.handleSearchCharacterItems.bind(this);

    // Item authoring on actor sheets
    CONFIG.queries[`${modulePrefix}.addActorItems`] = this.handleAddActorItems.bind(this);
    CONFIG.queries[`${modulePrefix}.removeActorItems`] = this.handleRemoveActorItems.bind(this);

    // World-level item CRUD
    CONFIG.queries[`${modulePrefix}.createWorldItems`] = this.handleCreateWorldItems.bind(this);
    CONFIG.queries[`${modulePrefix}.listWorldItems`] = this.handleListWorldItems.bind(this);
    CONFIG.queries[`${modulePrefix}.updateWorldItems`] = this.handleUpdateWorldItems.bind(this);
    CONFIG.queries[`${modulePrefix}.getSystemSchema`] = this.handleGetSystemSchema.bind(this);

    // Generic actor CRUD (any system, any type)
    CONFIG.queries[`${modulePrefix}.createActors`] = this.handleCreateActors.bind(this);
    CONFIG.queries[`${modulePrefix}.updateActors`] = this.handleUpdateActors.bind(this);
    CONFIG.queries[`${modulePrefix}.deleteActors`] = this.handleDeleteActors.bind(this);
    CONFIG.queries[`${modulePrefix}.updateActorItems`] = this.handleUpdateActorItems.bind(this);
    CONFIG.queries[`${modulePrefix}.deleteActorItems`] = this.handleDeleteActorItems.bind(this);

    // Phase 7: Token manipulation queries
    CONFIG.queries[`${modulePrefix}.move-token`] = this.handleMoveToken.bind(this);
    CONFIG.queries[`${modulePrefix}.update-token`] = this.handleUpdateToken.bind(this);
    CONFIG.queries[`${modulePrefix}.delete-tokens`] = this.handleDeleteTokens.bind(this);
    CONFIG.queries[`${modulePrefix}.get-token-details`] = this.handleGetTokenDetails.bind(this);
    CONFIG.queries[`${modulePrefix}.toggle-token-condition`] =
      this.handleToggleTokenCondition.bind(this);
    CONFIG.queries[`${modulePrefix}.get-available-conditions`] =
      this.handleGetAvailableConditions.bind(this);

    // D&D 5e queries
    CONFIG.queries[`${modulePrefix}.addSaveFeatureToActor`] =
      this.handleAddSaveFeatureToActor.bind(this);
    CONFIG.queries[`${modulePrefix}.createNpcActor`] = this.handleCreateNpcActor.bind(this);
    CONFIG.queries[`${modulePrefix}.addAttackToActor`] = this.handleAddAttackToActor.bind(this);
    CONFIG.queries[`${modulePrefix}.addAuraToActor`] = this.handleAddAuraToActor.bind(this);
    CONFIG.queries[`${modulePrefix}.addPassiveFeatureToActor`] =
      this.handleAddPassiveFeatureToActor.bind(this);
    CONFIG.queries[`${modulePrefix}.addAttackWithSaveToActor`] =
      this.handleAddAttackWithSaveToActor.bind(this);
    CONFIG.queries[`${modulePrefix}.setActorSpellcasting`] =
      this.handleSetActorSpellcasting.bind(this);
    CONFIG.queries[`${modulePrefix}.addSpellsToActor`] = this.handleAddSpellsToActor.bind(this);
    CONFIG.queries[`${modulePrefix}.addFeaturesFromCompendium`] =
      this.handleAddFeaturesFromCompendium.bind(this);
  }

  /**
   * Unregister all query handlers
   */
  unregisterHandlers(): void {
    const modulePrefix = MODULE_ID;
    const keysToRemove = Object.keys(CONFIG.queries).filter(key => key.startsWith(modulePrefix));

    for (const key of keysToRemove) {
      delete CONFIG.queries[key];
    }
  }

  /**
   * Handle query requests from other parts of the module
   */
  async handleQuery(queryName: string, data: any): Promise<any> {
    try {
      const handler = CONFIG.queries[queryName];
      if (!handler || typeof handler !== 'function') {
        throw new Error(`Query handler not found: ${queryName}`);
      }

      return await handler(data);
    } catch (error) {
      console.error(`[${MODULE_ID}] Query failed: ${queryName}`, error);
      return {
        error: error instanceof Error ? error.message : 'Unknown error',
        success: false,
      };
    }
  }

  /**
   * Handle character information request
   */
  private async handleGetCharacterInfo(data: {
    characterName?: string;
    characterId?: string;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      const identifier = data.characterName || data.characterId;
      if (!identifier) {
        throw new Error('characterName or characterId is required');
      }

      return await this.dataAccess.getCharacterInfo(identifier);
    } catch (error) {
      throw new Error(
        `Failed to get character info: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle list actors request
   */
  private async handleListActors(data: { type?: string }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      const actors = await this.dataAccess.listActors();

      // Filter by type if specified
      if (data.type) {
        return actors.filter(actor => actor.type === data.type);
      }

      return actors;
    } catch (error) {
      throw new Error(
        `Failed to list actors: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle compendium search request
   */
  private async handleSearchCompendium(data: {
    query: string;
    packType?: string;
    filters?: {
      challengeRating?: number | { min?: number; max?: number };
      creatureType?: string;
      size?: string;
      alignment?: string;
      hasLegendaryActions?: boolean;
      spellcaster?: boolean;
    };
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      // Add better parameter validation
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid data parameter structure');
      }

      if (!data.query || typeof data.query !== 'string') {
        throw new Error('query parameter is required and must be a string');
      }

      return await this.dataAccess.searchCompendium(data.query, data.packType, data.filters);
    } catch (error) {
      throw new Error(
        `Failed to search compendium: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle list creatures by criteria request
   */
  private async handleListCreaturesByCriteria(data: {
    challengeRating?: number | { min?: number; max?: number };
    creatureType?: string;
    size?: string;
    hasSpells?: boolean;
    hasLegendaryActions?: boolean;
    limit?: number;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      const result = await this.dataAccess.listCreaturesByCriteria(data);

      // Handle the new format with search summary
      return {
        response: result,
      };
    } catch (error) {
      throw new Error(
        `Failed to list creatures by criteria: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get available packs request
   */
  private async handleGetAvailablePacks(): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();
      return await this.dataAccess.getAvailablePacks();
    } catch (error) {
      throw new Error(
        `Failed to get available packs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get pack index request. Returns a compendium pack's index entries,
   * optionally including extra system fields (e.g. dsa5 species/career) so callers
   * can filter without loading every full document. Used by list-dsa5-archetypes.
   */
  private async handleGetPackIndex(data: { packId: string; fields?: string[] }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();
      if (!data?.packId) {
        throw new Error('packId is required');
      }
      return await this.dataAccess.getPackIndex(data.packId, data.fields);
    } catch (error) {
      throw new Error(
        `Failed to get pack index: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get active scene request
   */
  private async handleGetActiveScene(): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();
      const sceneData = await this.dataAccess.getActiveScene();
      return this._withGridAndFlags(sceneData);
    } catch (error) {
      throw new Error(
        `Failed to get active scene: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // ---- Phase B board-prep additions: grid detail + flags on scene reads (Section 4f audit gap). ----
  // Additive only: existing fields (e.g. list-scenes' gridSize) are untouched; this merges in a
  // richer "grid" object and the scene's "flags" (report-card + B5 idempotency read theirs from
  // flags.aidm.pipeline) without changing any previously-shipped field's shape or meaning.
  private _withGridAndFlags(sceneData: any): any {
    if (!sceneData || !sceneData.id) return sceneData;
    try {
      const scene: any = (game as any).scenes?.get(sceneData.id);
      if (!scene) return sceneData;
      const g = scene.grid || {};
      let flags: any = {};
      try {
        flags = JSON.parse(JSON.stringify(scene.flags || {}));
      } catch (e) {
        flags = {};
      }
      return {
        ...sceneData,
        grid: {
          type: g.type,
          size: g.size,
          offsetX: g.offsetX ?? 0,
          offsetY: g.offsetY ?? 0,
        },
        flags,
      };
    } catch (e) {
      return sceneData;
    }
  }

  /**
   * Handle get world info request
   */
  private async handleGetWorldInfo(): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();
      return await this.dataAccess.getWorldInfo();
    } catch (error) {
      throw new Error(
        `Failed to get world info: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle ping request
   */
  private async handlePing(): Promise<any> {
    return {
      status: 'ok',
      timestamp: Date.now(),
      module: MODULE_ID,
      foundryVersion: game.version,
      worldId: game.world?.id,
      userId: game.user?.id,
    };
  }

  /**
   * Get list of all registered query methods
   */
  getRegisteredMethods(): string[] {
    const modulePrefix = MODULE_ID;
    return Object.keys(CONFIG.queries)
      .filter(key => key.startsWith(modulePrefix))
      .map(key => key.replace(`${modulePrefix}.`, ''));
  }

  /**
   * Test if a specific query handler is registered
   */
  isMethodRegistered(method: string): boolean {
    const queryKey = `${MODULE_ID}.${method}`;
    return queryKey in CONFIG.queries && typeof CONFIG.queries[queryKey] === 'function';
  }

  // ===== PHASE 2: WRITE OPERATION HANDLERS =====

  /**
   * Handle actor creation from specific compendium entry
   */
  private async handleCreateActorFromCompendium(data: {
    packId: string;
    itemId: string;
    customNames?: string[] | undefined;
    quantity?: number | undefined;
    addToScene?: boolean | undefined;
    placement?:
      | {
          type: 'random' | 'grid' | 'center' | 'coordinates';
          coordinates?: { x: number; y: number }[];
        }
      | undefined;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      // Clean interface - direct pack/item reference only
      const requestData: any = {
        packId: data.packId,
        itemId: data.itemId,
        customNames: data.customNames || [],
        quantity: data.quantity || 1,
        addToScene: data.addToScene || false,
      };

      if (data.placement) {
        requestData.placement = data.placement;
      }

      return await this.dataAccess.createActorFromCompendiumEntry(requestData);
    } catch (error) {
      throw new Error(
        `Failed to create actor from compendium: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get compendium document full request
   */
  private async handleGetCompendiumDocumentFull(data: {
    packId: string;
    documentId: string;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.packId) {
        throw new Error('packId is required');
      }

      if (!data.documentId) {
        throw new Error('documentId is required');
      }

      return await this.dataAccess.getCompendiumDocumentFull(data.packId, data.documentId);
    } catch (error) {
      throw new Error(
        `Failed to get compendium document: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle add actors to scene request
   */
  private async handleAddActorsToScene(data: {
    actorIds: string[];
    placement?: 'random' | 'grid' | 'center';
    hidden?: boolean;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.actorIds || !Array.isArray(data.actorIds) || data.actorIds.length === 0) {
        throw new Error('actorIds array is required and must not be empty');
      }

      return await this.dataAccess.addActorsToScene({
        actorIds: data.actorIds,
        placement: data.placement || 'random',
        hidden: data.hidden || false,
      });
    } catch (error) {
      throw new Error(
        `Failed to add actors to scene: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle validate write permissions request
   */
  private async handleValidateWritePermissions(data: {
    operation: 'createActor' | 'modifyScene';
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.operation) {
        throw new Error('operation is required');
      }

      return await this.dataAccess.validateWritePermissions(data.operation);
    } catch (error) {
      throw new Error(
        `Failed to validate write permissions: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle journal entry creation
   */
  async handleCreateJournalEntry(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      if (!data.name) {
        throw new Error('name is required');
      }
      if (!data.content) {
        throw new Error('content is required');
      }

      return await this.dataAccess.createJournalEntry({
        name: data.name,
        content: data.content,
        additionalPages: data.additionalPages,
        folderName: data.folderName,
      });
    } catch (error) {
      throw new Error(
        `Failed to create journal entry: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle list journals request
   */
  async handleListJournals(): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();
      return await this.dataAccess.listJournals();
    } catch (error) {
      throw new Error(
        `Failed to list journals: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get journal content request
   */
  async handleGetJournalContent(data: { journalId: string }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.journalId) {
        throw new Error('journalId is required');
      }

      return await this.dataAccess.getJournalContent(data.journalId);
    } catch (error) {
      throw new Error(
        `Failed to get journal content: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get specific journal page content request
   */
  async handleGetJournalPageContent(data: { journalId: string; pageId: string }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.journalId) {
        throw new Error('journalId is required');
      }
      if (!data.pageId) {
        throw new Error('pageId is required');
      }

      return await this.dataAccess.getJournalPageContent(data.journalId, data.pageId);
    } catch (error) {
      throw new Error(
        `Failed to get journal page content: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle update journal content request
   */
  async handleUpdateJournalContent(data: {
    journalId: string;
    content: string;
    pageId?: string;
    newPageName?: string;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.journalId) {
        throw new Error('journalId is required');
      }
      if (!data.content) {
        throw new Error('content is required');
      }

      const updateRequest: {
        journalId: string;
        content: string;
        pageId?: string | undefined;
        newPageName?: string | undefined;
      } = {
        journalId: data.journalId,
        content: data.content,
      };
      if (data.pageId) updateRequest.pageId = data.pageId;
      if (data.newPageName) updateRequest.newPageName = data.newPageName;

      return await this.dataAccess.updateJournalContent(updateRequest);
    } catch (error) {
      throw new Error(
        `Failed to update journal content: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle request player rolls - creates interactive roll buttons in chat
   */
  async handleRequestPlayerRolls(data: {
    rollType: string;
    rollTarget: string;
    targetPlayer: string;
    isPublic: boolean;
    rollModifier: string;
    flavor: string;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.rollType || !data.rollTarget || !data.targetPlayer) {
        throw new Error('rollType, rollTarget, and targetPlayer are required');
      }

      return await this.dataAccess.requestPlayerRolls(data);
    } catch (error) {
      throw new Error(
        `Failed to request player rolls: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get enhanced creature index request
   */
  async handleGetEnhancedCreatureIndex(): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      return await this.dataAccess.getEnhancedCreatureIndex();
    } catch (error) {
      throw new Error(
        `Failed to get enhanced creature index: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle campaign progress update request
   */
  async handleUpdateCampaignProgress(data: {
    campaignId: string;
    partId: string;
    newStatus: string;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      // For now, this is a pass-through to the MCP server
      // In the future, campaign data might be stored in Foundry world flags
      // Currently, the campaign dashboard regeneration happens server-side

      return {
        success: true,
        message: `Campaign progress updated: ${data.partId} is now ${data.newStatus}`,
        campaignId: data.campaignId,
        partId: data.partId,
        newStatus: data.newStatus,
      };
    } catch (error) {
      throw new Error(
        `Failed to update campaign progress: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle set actor ownership request
   */
  async handleSetActorOwnership(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.actorId || !data.userId || data.permission === undefined) {
        throw new Error('actorId, userId, and permission are required');
      }

      return await this.dataAccess.setActorOwnership(data);
    } catch (error) {
      throw new Error(
        `Failed to set actor ownership: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle WFRP4e actor stat-block update request
   */
  async handleUpdateWfrp4eActor(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.actor) {
        throw new Error('actor (name or id) is required');
      }

      return await this.dataAccess.updateWfrp4eActor(data);
    } catch (error) {
      throw new Error(
        `Failed to update WFRP4e actor: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Add items (skills, talents, careers, trappings, …) to a WFRP4e actor,
   * resolved from the installed compendiums. GM-only.
   */
  async handleAddWfrp4eItems(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.actor) {
        throw new Error('actor (name or id) is required');
      }
      if (!Array.isArray(data.items) || data.items.length === 0) {
        throw new Error('items array is required and must contain at least one entry');
      }

      return await this.dataAccess.addWfrp4eItems(data);
    } catch (error) {
      throw new Error(
        `Failed to add WFRP4e items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get actor ownership request
   */
  async handleGetActorOwnership(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      return await this.dataAccess.getActorOwnership(data);
    } catch (error) {
      throw new Error(
        `Failed to get actor ownership: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get friendly NPCs request
   */
  async handleGetFriendlyNPCs(): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      return await this.dataAccess.getFriendlyNPCs();
    } catch (error) {
      throw new Error(
        `Failed to get friendly NPCs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get party characters request
   */
  async handleGetPartyCharacters(): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      return await this.dataAccess.getPartyCharacters();
    } catch (error) {
      throw new Error(
        `Failed to get party characters: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get connected players request
   */
  async handleGetConnectedPlayers(): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      return await this.dataAccess.getConnectedPlayers();
    } catch (error) {
      throw new Error(
        `Failed to get connected players: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle find players request
   */
  async handleFindPlayers(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.identifier) {
        throw new Error('identifier is required');
      }

      return await this.dataAccess.findPlayers(data);
    } catch (error) {
      throw new Error(
        `Failed to find players: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle find actor request
   */
  async handleFindActor(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.identifier) {
        throw new Error('identifier is required');
      }

      return await this.dataAccess.findActor(data);
    } catch (error) {
      throw new Error(
        `Failed to find actor: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle list scenes request
   */
  private async handleListScenes(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();
      const scenes = await this.dataAccess.listScenes(data);
      return (Array.isArray(scenes) ? scenes : []).map((s: any) => this._withGridAndFlags(s));
    } catch (error) {
      throw new Error(
        `Failed to list scenes: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle switch scene request
   */
  private async handleSwitchScene(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.scene_identifier) {
        throw new Error('scene_identifier is required');
      }

      return await this.dataAccess.switchScene(data);
    } catch (error) {
      throw new Error(
        `Failed to switch scene: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle map generation request - uses hybrid architecture
   */
  private async handleGenerateMap(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      if (!data.prompt || typeof data.prompt !== 'string') {
        throw new Error('Prompt is required and must be a string');
      }

      if (!data.scene_name || typeof data.scene_name !== 'string') {
        throw new Error('Scene name is required and must be a string');
      }

      // Get quality setting from module settings
      const quality = game.settings.get(MODULE_ID, 'mapGenQuality') || 'low';

      const params = {
        prompt: data.prompt.trim(),
        scene_name: data.scene_name.trim(),
        size: data.size || 'medium',
        grid_size: data.grid_size || 70,
        quality,
      };

      // Use ComfyUIManager to communicate with backend via WebSocket
      const response = await this.comfyuiManager.generateMap(params);
      const isSuccess =
        typeof response?.success === 'boolean' ? response.success : response?.status === 'success';

      if (!isSuccess) {
        const errorMessage = response?.error || response?.message || 'Map generation failed';
        return {
          error: errorMessage,
          success: false,
          status: response?.status ?? 'error',
        };
      }

      return {
        success: true,
        status: response?.status ?? 'success',
        jobId: response.jobId,
        message: response.message || 'Map generation started',
        estimatedTime: response.estimatedTime || '30-90 seconds',
      };
    } catch (error: any) {
      return {
        error: error.message,
        success: false,
      };
    }
  }

  /**
   * Handle map status check request - uses hybrid architecture
   */
  private async handleCheckMapStatus(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      if (!data.job_id) {
        throw new Error('Job ID is required');
      }

      // Use ComfyUIManager to communicate with backend via WebSocket
      const response = await this.comfyuiManager.checkMapStatus(data);
      const isSuccess =
        typeof response?.success === 'boolean' ? response.success : response?.status === 'success';

      if (!isSuccess) {
        const errorMessage = response?.error || response?.message || 'Status check failed';
        return {
          error: errorMessage,
          success: false,
          status: response?.status ?? 'error',
        };
      }

      return {
        success: true,
        status: response?.status ?? 'success',
        job: response.job,
      };
    } catch (error: any) {
      return {
        error: error.message,
        success: false,
      };
    }
  }

  /**
   * Handle map job cancellation request - uses hybrid architecture
   */
  private async handleCancelMapJob(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      if (!data.job_id) {
        throw new Error('Job ID is required');
      }

      // Use ComfyUIManager to communicate with backend via WebSocket
      const response = await this.comfyuiManager.cancelMapJob(data);
      const isSuccess =
        typeof response?.success === 'boolean' ? response.success : response?.status === 'success';

      if (!isSuccess) {
        const errorMessage = response?.error || response?.message || 'Job cancellation failed';
        return {
          error: errorMessage,
          success: false,
          status: response?.status ?? 'error',
        };
      }

      return {
        success: true,
        status: response?.status ?? 'success',
        message: response.message || 'Job cancelled successfully',
      };
    } catch (error: any) {
      return {
        error: error.message,
        success: false,
      };
    }
  }

  /**
   * Handle upload of generated map image (for remote Foundry instances)
   * Receives base64-encoded image data and saves it to generated-maps folder
   */
  private async handleUploadGeneratedMap(data: any): Promise<any> {
    console.log(`[${MODULE_ID}] Upload generated map request received`, {
      hasFilename: !!data.filename,
      hasImageData: !!data.imageData,
      imageDataLength: data.imageData?.length,
    });

    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        console.error(`[${MODULE_ID}] Upload denied - not GM`);
        return { error: 'Access denied', success: false };
      }

      if (!data.filename || typeof data.filename !== 'string') {
        console.error(`[${MODULE_ID}] Upload failed - invalid filename`);
        throw new Error('Filename is required and must be a string');
      }

      if (!data.imageData || typeof data.imageData !== 'string') {
        console.error(`[${MODULE_ID}] Upload failed - invalid image data`);
        throw new Error('Image data is required and must be a base64 string');
      }

      console.log(`[${MODULE_ID}] Validating filename...`);
      // Validate filename for security (prevent path traversal)
      const safeFilename = data.filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      if (
        !safeFilename.endsWith('.png') &&
        !safeFilename.endsWith('.jpg') &&
        !safeFilename.endsWith('.jpeg')
      ) {
        throw new Error('Only PNG and JPEG images are supported');
      }

      console.log(`[${MODULE_ID}] Converting base64 to blob...`, {
        base64Length: data.imageData.length,
        estimatedSizeMB: (data.imageData.length / 1024 / 1024).toFixed(2),
      });

      // Convert base64 to Blob
      const byteCharacters = atob(data.imageData);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'image/png' });

      console.log(`[${MODULE_ID}] Creating file object...`, {
        filename: safeFilename,
        blobSize: blob.size,
      });

      // Create a File object from the Blob
      const file = new File([blob], safeFilename, { type: 'image/png' });

      console.log(`[${MODULE_ID}] Ensuring upload directory exists...`);

      // Upload to world-specific folder so maps persist even if module is deleted
      // This also keeps maps organized per world
      const worldId = (game as any).world?.id || 'unknown-world';
      const uploadPath = `worlds/${worldId}/ai-generated-maps`;
      try {
        // Use the modern Foundry API (v13+) with fallback for older versions
        const FilePickerAPI =
          (globalThis as any).foundry?.applications?.apps?.FilePicker?.implementation ||
          (globalThis as any).FilePicker;

        await FilePickerAPI.createDirectory('data', uploadPath, { bucket: null });
        console.log(`[${MODULE_ID}] Directory created/verified: ${uploadPath}`);
      } catch (dirError: any) {
        // Directory might already exist, that's okay
        if (
          !dirError.message?.includes('EEXIST') &&
          !dirError.message?.includes('already exists')
        ) {
          console.warn(`[${MODULE_ID}] Directory creation warning:`, dirError.message);
        }
      }

      console.log(`[${MODULE_ID}] Uploading to FilePicker...`);
      // Upload using Foundry's FilePicker.upload method with modern API
      const FilePickerAPI =
        (globalThis as any).foundry?.applications?.apps?.FilePicker?.implementation ||
        (globalThis as any).FilePicker;
      const response = await FilePickerAPI.upload('data', uploadPath, file, {}, { notify: false });

      console.log(`[${MODULE_ID}] FilePicker.upload response:`, JSON.stringify(response, null, 2));
      console.log(`[${MODULE_ID}] Response keys:`, Object.keys(response || {}));
      console.log(`[${MODULE_ID}] Uploaded generated map to:`, response.path);

      return {
        success: true,
        path: response.path,
        filename: safeFilename,
        message: `Map uploaded successfully to ${response.path}`,
      };
    } catch (error: any) {
      console.error(`[${MODULE_ID}] Failed to upload generated map:`, error);
      return {
        error: error.message || 'Failed to upload generated map',
        success: false,
      };
    }
  }

  // ===== PHASE 7: TOKEN MANIPULATION HANDLERS =====

  /**
   * Handle move token request
   */
  private async handleMoveToken(data: {
    tokenId: string;
    x: number;
    y: number;
    animate?: boolean;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.tokenId) {
        throw new Error('tokenId is required');
      }
      if (typeof data.x !== 'number' || typeof data.y !== 'number') {
        throw new Error('x and y coordinates are required and must be numbers');
      }

      return await this.dataAccess.moveToken(data);
    } catch (error) {
      throw new Error(
        `Failed to move token: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle update token request
   */
  private async handleUpdateToken(data: {
    tokenId: string;
    updates: Record<string, any>;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.tokenId) {
        throw new Error('tokenId is required');
      }
      if (!data.updates || typeof data.updates !== 'object') {
        throw new Error('updates object is required');
      }

      return await this.dataAccess.updateToken(data);
    } catch (error) {
      throw new Error(
        `Failed to update token: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle delete tokens request
   */
  private async handleDeleteTokens(data: { tokenIds: string[] }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.tokenIds || !Array.isArray(data.tokenIds) || data.tokenIds.length === 0) {
        throw new Error('tokenIds array is required and must not be empty');
      }

      return await this.dataAccess.deleteTokens(data);
    } catch (error) {
      throw new Error(
        `Failed to delete tokens: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get token details request
   */
  private async handleGetTokenDetails(data: { tokenId: string }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.tokenId) {
        throw new Error('tokenId is required');
      }

      return await this.dataAccess.getTokenDetails(data);
    } catch (error) {
      throw new Error(
        `Failed to get token details: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle toggle token condition request
   */
  private async handleToggleTokenCondition(data: {
    tokenId: string;
    conditionId: string;
    active: boolean;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.tokenId) {
        throw new Error('tokenId is required');
      }
      if (!data.conditionId) {
        throw new Error('conditionId is required');
      }
      if (typeof data.active !== 'boolean') {
        throw new Error('active must be a boolean');
      }

      return await this.dataAccess.toggleTokenCondition(data);
    } catch (error) {
      throw new Error(
        `Failed to toggle token condition: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle get available conditions request
   */
  private async handleGetAvailableConditions(): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      return await this.dataAccess.getAvailableConditions();
    } catch (error) {
      throw new Error(
        `Failed to get available conditions: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle use item request (cast spell, use ability, consume item, etc.)
   */
  private async handleUseItem(data: {
    actorIdentifier: string;
    itemIdentifier: string;
    targets?: string[];
    options?: {
      consume?: boolean;
      configureDialog?: boolean;
      spellLevel?: number;
      versatile?: boolean;
    };
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.actorIdentifier) {
        throw new Error('actorIdentifier is required');
      }
      if (!data.itemIdentifier) {
        throw new Error('itemIdentifier is required');
      }

      return await this.dataAccess.useItem({
        actorIdentifier: data.actorIdentifier,
        itemIdentifier: data.itemIdentifier,
        targets: data.targets,
        options: data.options,
      });
    } catch (error) {
      throw new Error(
        `Failed to use item: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle search character items request
   */
  private async handleSearchCharacterItems(data: {
    characterIdentifier: string;
    query?: string;
    type?: string;
    category?: string;
    limit?: number;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.characterIdentifier) {
        throw new Error('characterIdentifier is required');
      }

      return await this.dataAccess.searchCharacterItems({
        characterIdentifier: data.characterIdentifier,
        query: data.query,
        type: data.type,
        category: data.category,
        limit: data.limit,
      });
    } catch (error) {
      throw new Error(
        `Failed to search character items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleAddActorItems(data: {
    actorIdentifier: string;
    items: Array<{
      name: string;
      type: string;
      img?: string;
      system?: Record<string, any>;
    }>;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation - writes to actor sheets are GM-only
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data?.actorIdentifier) {
        throw new Error('actorIdentifier is required');
      }
      if (!Array.isArray(data?.items) || data.items.length === 0) {
        throw new Error('items array is required and must contain at least one entry');
      }

      return await this.dataAccess.addActorItems({
        actorIdentifier: data.actorIdentifier,
        items: data.items,
      });
    } catch (error) {
      throw new Error(
        `Failed to add actor items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleRemoveActorItems(data: {
    actorIdentifier: string;
    itemIds?: string[];
    itemNames?: string[];
    type?: string;
  }): Promise<any> {
    try {
      // SECURITY: Silent GM validation - writes to actor sheets are GM-only
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data?.actorIdentifier) {
        throw new Error('actorIdentifier is required');
      }
      const hasIds = Array.isArray(data?.itemIds) && data.itemIds.length > 0;
      const hasNames = Array.isArray(data?.itemNames) && data.itemNames.length > 0;
      if (!hasIds && !hasNames) {
        throw new Error('Provide itemIds and/or itemNames identifying the items to remove');
      }

      return await this.dataAccess.removeActorItems({
        actorIdentifier: data.actorIdentifier,
        ...(data.itemIds !== undefined ? { itemIds: data.itemIds } : {}),
        ...(data.itemNames !== undefined ? { itemNames: data.itemNames } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
      });
    } catch (error) {
      throw new Error(
        `Failed to remove actor items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleUpdateWorldItems(data: {
    updates: Array<{
      id: string;
      name?: string;
      img?: string;
      system?: Record<string, any>;
      folder?: string;
    }>;
  }): Promise<any> {
    try {
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!Array.isArray(data?.updates) || data.updates.length === 0) {
        throw new Error('updates array is required and must contain at least one entry');
      }

      return await this.dataAccess.updateWorldItems({ updates: data.updates });
    } catch (error) {
      throw new Error(
        `Failed to update world items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleListWorldItems(data: {
    type?: string;
    folder?: string;
    nameFilter?: string;
  }): Promise<any> {
    try {
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      return await this.dataAccess.listWorldItems({
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.folder !== undefined ? { folder: data.folder } : {}),
        ...(data.nameFilter !== undefined ? { nameFilter: data.nameFilter } : {}),
      });
    } catch (error) {
      throw new Error(
        `Failed to list world items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleCreateWorldItems(data: {
    items: Array<{
      name: string;
      type: string;
      img?: string;
      system?: Record<string, any>;
    }>;
    folder?: string;
  }): Promise<any> {
    try {
      // SECURITY: World item creation is GM-only
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!Array.isArray(data?.items) || data.items.length === 0) {
        throw new Error('items array is required and must contain at least one entry');
      }

      return await this.dataAccess.createWorldItems({
        items: data.items,
        ...(data.folder !== undefined ? { folder: data.folder } : {}),
      });
    } catch (error) {
      throw new Error(
        `Failed to create world items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // ===== D&D 5E HANDLERS =====

  /**
   * Handle add save feature to actor request (D&D 5e only)
   */
  private async handleAddSaveFeatureToActor(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.actorIdentifier) {
        throw new Error('actorIdentifier is required');
      }
      if (!data.featureName) {
        throw new Error('featureName is required');
      }

      return await this.dataAccess.addSaveFeatureToActor(data);
    } catch (error) {
      throw new Error(
        `Failed to add save feature to actor: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle create NPC actor request (D&D 5e only)
   */
  private async handleCreateNpcActor(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.name) {
        throw new Error('name is required');
      }
      if (data.cr === undefined || data.cr === null) {
        throw new Error('cr is required');
      }
      if (!data.creatureType) {
        throw new Error('creatureType is required');
      }
      if (!data.size) {
        throw new Error('size is required');
      }
      if (!data.abilities || typeof data.abilities !== 'object') {
        throw new Error('abilities is required and must be an object');
      }
      if (data.hpAverage === undefined || data.hpAverage === null) {
        throw new Error('hpAverage is required');
      }
      if (!data.hpFormula) {
        throw new Error('hpFormula is required');
      }
      if (!data.acMode) {
        throw new Error('acMode is required');
      }

      return await this.dataAccess.createNpcActor(data);
    } catch (error) {
      throw new Error(
        `Failed to create NPC actor: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle add attack feature to actor request (D&D 5e only)
   */
  private async handleAddAttackToActor(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.actorIdentifier) {
        throw new Error('actorIdentifier is required');
      }
      if (!data.featureName) {
        throw new Error('featureName is required');
      }
      if (!data.attackType) {
        throw new Error('attackType is required');
      }
      if (!Array.isArray(data.damageParts) || data.damageParts.length === 0) {
        throw new Error('damageParts is required and must contain at least one element');
      }

      return await this.dataAccess.addAttackToActor(data);
    } catch (error) {
      throw new Error(
        `Failed to add attack to actor: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle add aura feature to actor request (D&D 5e only)
   */
  private async handleAddAuraToActor(data: any): Promise<any> {
    try {
      // SECURITY: Silent GM validation
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.actorIdentifier) {
        throw new Error('actorIdentifier is required');
      }
      if (!data.featureName) {
        throw new Error('featureName is required');
      }
      if (!Array.isArray(data.damageParts) || data.damageParts.length === 0) {
        throw new Error('damageParts is required and must contain at least one element');
      }
      if (!data.areaType) {
        throw new Error('areaType is required');
      }
      if (data.areaSize === undefined || data.areaSize === null) {
        throw new Error('areaSize is required');
      }

      return await this.dataAccess.addAuraToActor(data);
    } catch (error) {
      throw new Error(
        `Failed to add aura to actor: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle add passive feature to actor request (D&D 5e only)
   */
  private async handleAddPassiveFeatureToActor(data: any): Promise<any> {
    try {
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.actorIdentifier) {
        throw new Error('actorIdentifier is required');
      }
      if (!data.featureName) {
        throw new Error('featureName is required');
      }

      return await this.dataAccess.addPassiveFeatureToActor(data);
    } catch (error) {
      throw new Error(
        `Failed to add passive feature to actor: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle add attack+save feature to actor request (D&D 5e only)
   */
  private async handleAddAttackWithSaveToActor(data: any): Promise<any> {
    try {
      const gmCheck = this.validateGMAccess();
      if (!gmCheck.allowed) {
        return { error: 'Access denied', success: false };
      }

      this.dataAccess.validateFoundryState();

      if (!data.actorIdentifier) throw new Error('actorIdentifier is required');
      if (!data.featureName) throw new Error('featureName is required');
      if (!data.attackType) throw new Error('attackType is required');
      if (!Array.isArray(data.damageParts) || data.damageParts.length === 0) {
        throw new Error('damageParts is required and must contain at least one element');
      }
      if (!data.saveAbility) throw new Error('saveAbility is required');
      if (!data.saveDC) throw new Error('saveDC is required');
      if (!Array.isArray(data.saveDamageParts) || data.saveDamageParts.length === 0) {
        throw new Error('saveDamageParts is required and must contain at least one element');
      }

      return await this.dataAccess.addAttackWithSaveToActor(data);
    } catch (error) {
      throw new Error(
        `Failed to add attack+save to actor: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleSetActorSpellcasting(data: any): Promise<any> {
    try {
      if (!data.actorIdentifier) {
        throw new Error('actorIdentifier is required');
      }
      if (!data.spellcastingClass) {
        throw new Error('spellcastingClass is required');
      }
      if (
        typeof data.spellcastingLevel !== 'number' ||
        data.spellcastingLevel < 1 ||
        data.spellcastingLevel > 20
      ) {
        throw new Error('spellcastingLevel must be a number between 1 and 20');
      }
      if (!data.effectiveAbility) {
        throw new Error('effectiveAbility is required');
      }

      return await this.dataAccess.setActorSpellcasting(data);
    } catch (error) {
      throw new Error(
        `Failed to set actor spellcasting: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleAddSpellsToActor(data: any): Promise<any> {
    try {
      if (!data.actorIdentifier) {
        throw new Error('actorIdentifier is required');
      }
      if (!Array.isArray(data.spellNames) || data.spellNames.length === 0) {
        throw new Error('spellNames is required and must contain at least one element');
      }
      if (data.spellNames.length > 50) {
        throw new Error('spellNames cannot contain more than 50 elements');
      }

      return await this.dataAccess.addSpellsToActor(data);
    } catch (error) {
      throw new Error(
        `Failed to add spells to actor: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleAddFeaturesFromCompendium(data: any): Promise<any> {
    try {
      if (!data.actorIdentifier) {
        throw new Error('actorIdentifier is required');
      }
      if (!Array.isArray(data.featureNames) || data.featureNames.length === 0) {
        throw new Error('featureNames is required and must contain at least one element');
      }
      if (data.featureNames.length > 50) {
        throw new Error('featureNames cannot contain more than 50 elements');
      }

      return await this.dataAccess.addFeaturesFromCompendium(data);
    } catch (error) {
      throw new Error(
        `Failed to add features from compendium: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleGetSystemSchema(_data: any): Promise<any> {
    try {
      return this.dataAccess.getSystemSchema();
    } catch (error) {
      throw new Error(
        `Failed to get system schema: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // ─── Generic actor CRUD ─────────────────────────────────────────────────────

  private async handleCreateActors(data: {
    actors: Array<{
      name: string;
      type: string;
      img?: string;
      system?: Record<string, any>;
    }>;
    folder?: string;
  }): Promise<any> {
    const gmCheck = this.validateGMAccess();
    if (!gmCheck.allowed) return { error: 'Access denied', success: false };
    this.dataAccess.validateFoundryState();
    if (!Array.isArray(data?.actors) || data.actors.length === 0) {
      throw new Error('actors array is required and must contain at least one entry');
    }
    return this.dataAccess.createActors(data);
  }

  private async handleUpdateActors(data: {
    updates: Array<{
      id: string;
      name?: string;
      img?: string;
      system?: Record<string, any>;
    }>;
  }): Promise<any> {
    const gmCheck = this.validateGMAccess();
    if (!gmCheck.allowed) return { error: 'Access denied', success: false };
    this.dataAccess.validateFoundryState();
    if (!Array.isArray(data?.updates) || data.updates.length === 0) {
      throw new Error('updates array is required');
    }
    return this.dataAccess.updateActors(data.updates);
  }

  private async handleDeleteActors(data: { ids: string[] }): Promise<any> {
    const gmCheck = this.validateGMAccess();
    if (!gmCheck.allowed) return { error: 'Access denied', success: false };
    this.dataAccess.validateFoundryState();
    if (!Array.isArray(data?.ids) || data.ids.length === 0) {
      throw new Error('ids array is required');
    }
    return this.dataAccess.deleteActors(data.ids);
  }

  private async handleUpdateActorItems(data: {
    actorIdentifier: string;
    itemUpdates: Array<{ id: string; name?: string; img?: string; system?: Record<string, any> }>;
  }): Promise<any> {
    const gmCheck = this.validateGMAccess();
    if (!gmCheck.allowed) return { error: 'Access denied', success: false };
    this.dataAccess.validateFoundryState();
    return this.dataAccess.updateActorItems(data.actorIdentifier, data.itemUpdates);
  }

  private async handleDeleteActorItems(data: {
    actorIdentifier: string;
    itemIds: string[];
  }): Promise<any> {
    const gmCheck = this.validateGMAccess();
    if (!gmCheck.allowed) return { error: 'Access denied', success: false };
    this.dataAccess.validateFoundryState();
    return this.dataAccess.deleteActorItems(data.actorIdentifier, data.itemIds);
  }

  // ---- Combat tools (Phase 1, Step 8). LLM decides intent; Midi-QOL does the 5e math. ----
  private _activeScene(): any {
    const scene = (game as any).scenes?.active || (game as any).scenes?.contents?.[0];
    if (!scene) throw new Error('No active scene');
    return scene;
  }
  private _findToken(scene: any, ref: string): any {
    const byId = scene.tokens.get(ref);
    if (byId) return byId;
    const lower = String(ref).toLowerCase();
    return scene.tokens.find((t: any) => t.name?.toLowerCase() === lower);
  }
  /**
   * Converts a live placed token into the plain, Foundry-global-free shape
   * combat-scoping-utils.ts's pure selector operates on (board #1311 bridge fix 0006).
   */
  private _asCombatToken(t: any): CombatToken {
    return {
      id: t.id,
      name: t.name,
      actorId: t.actorId,
      actorType: t.actor?.type,
      disposition: typeof t.disposition === 'number' ? t.disposition : t.document?.disposition,
      hidden: !!t.hidden,
    };
  }

  /**
   * The default start-combat scope (board #1311 bridge fix 0006): never "every token on the
   * scene". Computes party + admitted-hostile live tokens plus a plain scoping summary, by
   * handing the pure selectDefaultCombatants() the scene's own Region containment
   * (Region#testPoint, the same API _resolveSceneRefs already reads scene.regions with) and
   * Foundry's own wall-collision sight test (CONFIG.Canvas.polygonBackends.sight.testCollision --
   * canvas.walls has no checkCollision method in v13.351) as injected accessor functions.
   * Assumptions this rests on, and their failure modes for an adventure nobody has tested yet:
   *  - Party tokens are Actor.type "character" (or explicitly named via `partyRefs`) -- an
   *    adventure whose PCs use a non-"character" actor type would need the `party` field passed.
   *  - Hostile intent is expressed as TOKEN_DISPOSITIONS.HOSTILE (-1) on the token, the same field
   *    the adventure/module author already sets -- an author who leaves monsters at NEUTRAL (0)
   *    gets none of them auto-added (they are simply never candidates; explicit `tokens` still
   *    works for that case).
   *  - Region-mode requires the scene to actually have Region documents the party stands inside;
   *    a scene authored without Regions (or where the party is in an untagged corridor) falls back
   *    to line-of-sight automatically -- never silently misapplies room-scoping to a roomless map.
   *  - If CONFIG.Canvas.polygonBackends.sight.testCollision is ever renamed/removed in a future
   *    Foundry version, hasLineOfSight fails closed (returns false) rather than throwing or
   *    silently reverting to "everything on the scene" -- the visible symptom would be zero
   *    hostiles auto-joining on a roomless map, never the old over-inclusion bug.
   */
  private _defaultCombatScope(
    scene: any,
    partyRefs?: string[]
  ): { liveTokens: any[]; summary: ReturnType<typeof formatScopingSummary> } {
    const allTokens: any[] = scene.tokens.contents;
    const combatTokens = allTokens.map((t: any) => this._asCombatToken(t));
    const byId = new Map(allTokens.map((t: any) => [t.id, t]));

    const regionsArr: any[] = Array.from((scene?.regions as any) ?? []);
    const regionsExistOnScene = regionsArr.length > 0;

    const placeableFor = (id: string): any =>
      (canvas as any)?.tokens?.get?.(id) ??
      (canvas as any)?.tokens?.placeables?.find((p: any) => p.id === id);

    const pointFor = (id: string): { x: number; y: number; elevation: number } | null => {
      const p = placeableFor(id);
      if (!p) return null;
      const c = p.center || { x: p.x, y: p.y };
      return { x: c.x, y: c.y, elevation: p.document?.elevation ?? 0 };
    };

    const tokenRegionIds = (t: CombatToken): string[] => {
      if (!regionsExistOnScene) return [];
      const pt = pointFor(t.id);
      if (!pt) return [];
      const ids: string[] = [];
      for (const region of regionsArr) {
        try {
          if ((region as any).testPoint?.(pt)) ids.push(region.id);
        } catch (e) {
          // A malformed region shape must not fail the whole scope; skip just that region.
        }
      }
      return ids;
    };

    const hasLineOfSight = (a: CombatToken, b: CombatToken): boolean => {
      const pa = pointFor(a.id);
      const pb = pointFor(b.id);
      if (!pa || !pb) return false;
      try {
        const backend = (CONFIG as any).Canvas?.polygonBackends?.sight;
        if (!backend?.testCollision) return false; // API unavailable: fail closed, never over-include
        const blocked = backend.testCollision(pa, pb, { type: 'sight', mode: 'any' });
        return !blocked;
      } catch (e) {
        return false; // collision test errored: fail closed, never over-include
      }
    };

    const resolveRef = (ref: string): string | undefined => {
      const byIdMatch = combatTokens.find((t: CombatToken) => t.id === ref);
      if (byIdMatch) return byIdMatch.id;
      const lower = ref.toLowerCase();
      return combatTokens.find((t: CombatToken) => t.name?.toLowerCase() === lower)?.id;
    };

    const result = selectDefaultCombatants(combatTokens, {
      ...(partyRefs !== undefined ? { explicitPartyRefs: partyRefs } : {}),
      resolveRef,
      regionsExistOnScene,
      tokenRegionIds,
      hasLineOfSight,
    });

    const liveTokens = [...result.party, ...result.admitted]
      .map((t: CombatToken) => byId.get(t.id))
      .filter(Boolean);

    return { liveTokens, summary: formatScopingSummary(result) };
  }

  private async handleStartCombat(data: { tokens?: string[]; party?: string[] }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    const scene = this._activeScene();
    let combat = (game as any).combat;
    if (!combat) {
      // Board #1652: this app's model never runs more than one live fight at a time, so any
      // Combat document still sitting in the world when none is active is a stale leftover from
      // an earlier fight that ended without going through handleEndCombat (a crashed run, a
      // turn-budget cutoff, a party that fled the scene). Once a combat goes inactive it can
      // never be reached via game.combat again, so handleEndCombat's own cleanup can never
      // delete it -- sweep every existing Combat document before starting the new one, so
      // orphans cannot accumulate. staleCombatIdsToDelete is the pure, unit-tested rule; this is
      // just the Foundry-touching call site (same injection pattern as combat-scoping-utils).
      // Best-effort: a failed sweep must never block starting the fight the caller asked for.
      const toDelete = staleCombatIdsToDelete(
        (game as any).combats.contents.map((c: any) => c.id),
        null
      );
      if (toDelete.length) {
        try {
          await (game as any).combats.documentClass.deleteDocuments(toDelete);
        } catch (e) {
          // best-effort, see comment above
        }
      }
      combat = await (game as any).combats.documentClass.create({ scene: scene.id, active: true });
    }
    let toks: any[];
    let scoping: ReturnType<typeof formatScopingSummary> | undefined;
    if (data.tokens && data.tokens.length) {
      toks = data.tokens.map((r: string) => this._findToken(scene, r)).filter(Boolean);
    } else {
      const scoped = this._defaultCombatScope(scene, data.party);
      toks = scoped.liveTokens;
      scoping = scoped.summary;
    }
    const toAdd = toks
      .filter((t: any) => !combat.combatants.find((c: any) => c.tokenId === t.id))
      .map((t: any) => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId }));
    if (toAdd.length) await combat.createEmbeddedDocuments('Combatant', toAdd);
    await combat.rollAll();
    if (!combat.started) await combat.startCombat();
    return {
      success: true,
      round: combat.round,
      combatants: combat.turns.map((c: any) => ({ name: c.name, initiative: c.initiative })),
      ...(scoping ? { scoping } : {}),
    };
  }
  private async handleEndCombat(): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    const combat = (game as any).combat;
    if (combat) await combat.delete();
    // Board #1652: this app's model never runs more than one live fight at a time, so ANY Combat
    // document remaining at this point is a stale orphan -- one that already ended without going
    // through this handler (see handleStartCombat's matching comment), or leftovers from before
    // this fix shipped. Sweep them all every time this is called, even when there was nothing
    // active to end, so a world that already has orphans self-heals the next time anything calls
    // end-combat. Same pure rule + best-effort call-site pattern as handleStartCombat.
    const toDelete = staleCombatIdsToDelete(
      (game as any).combats.contents.map((c: any) => c.id),
      null
    );
    if (toDelete.length) {
      try {
        await (game as any).combats.documentClass.deleteDocuments(toDelete);
      } catch (e) {
        // best-effort, see comment above
      }
    }
    return combat ? { success: true } : { success: true, note: 'no active combat' };
  }
  private async handleNextTurn(): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    const combat = (game as any).combat;
    if (!combat) throw new Error('No active combat');
    await combat.nextTurn();
    return {
      success: true,
      round: combat.round,
      turn: combat.turn,
      current: combat.combatant ? combat.combatant.name : null,
    };
  }
  private async handleGetCombatState(): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    const combat = (game as any).combat;
    if (!combat) return { active: false };
    return {
      active: true,
      round: combat.round,
      turn: combat.turn,
      current: combat.combatant ? combat.combatant.name : null,
      order: combat.turns.map((c: any) => ({
        name: c.name,
        initiative: c.initiative,
        hp: c.actor?.system?.attributes?.hp?.value,
        maxHp: c.actor?.system?.attributes?.hp?.max,
        defeated: c.isDefeated,
      })),
    };
  }
  private async handleDiagEval(data: { js: string }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      const fn = new Function('return (async () => { ' + data.js + ' })()');
      const out = await fn();
      let safe;
      try {
        safe = JSON.parse(JSON.stringify(out));
      } catch (e) {
        safe = String(out);
      }
      return { success: true, result: safe };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e) };
    }
  }

  /**
   * Board #1887 (bridge 0.10.8): how long one attack may take inside Midi-QOL's workflow before execute-attack gives up
   * on it, stops it and says so. A normal attack takes 1 to 2 s (measured on the test stack). The MCP side waits 60 s
   * for the whole call, so this stays well under that. Tests shorten it.
   */
  public midiAttackTimeoutMs = 25000;

  /**
   * Board #1887 (bridge 0.10.8 review): one deadline for the WHOLE execute-attack call, under the MCP side's 60 s wait.
   * Attacks on several targets must not add up past it, so damage never lands after the brain was told "Query
   * timeout": a target whose attack could not start in time is not attacked, and says so. Tests shorten it.
   */
  public midiCallBudgetMs = 50000;
  /** How close to that deadline a Midi run may end, and the least time left worth starting one (tests shorten both). */
  public midiDeadlineMarginMs = MIDI_DEADLINE_MARGIN_MS;
  public midiMinRunMs = MIDI_MIN_RUN_MS;
  /**
   * Board #1887 (bridge 0.10.8 round 3, operator popup "Test the option first"): Midi-QOL's own per-call switches
   * `workflowOptions.attackRollDSN` / `damageRollDSN` false, so Midi neither waits for Dice So Nice's 3D dice in the
   * headless GM browser nor marks them as already shown (players then get them from the chat message). The value is
   * the one the test stack's player-browser matrix chose (bridge/README.md, "0019").
   */
  public midiSkipDiceAnimation = SKIP_DICE_DEFAULT;
  /**
   * Board #1887 (round 3): a workflow execute-attack stopped is guarded so that its own state loop, still waiting in a
   * reaction prompt or a dice animation, cannot go on to apply damage after the answer said "stopped"
   * (guardStoppedWorkflow). Only a test turns it off, to show the late damage it prevents.
   */
  public midiGuardStoppedWorkflows = true;

  private async handleExecuteAttack(data: {
    attacker: string;
    item: string;
    targets: string[];
    itemId?: string;
    reactions?: boolean;
    /** Board #1887 (round 4): the one effect the caster chose, when the activity offers a choice (Hex: "Strength"). */
    effect?: string;
  }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    const callDeadline = Date.now() + this.midiCallBudgetMs;
    // The time one Midi run may take: its own limit, and never past the whole call's deadline (round 4: the save path
    // too).
    const timeLeft = () => callDeadline - Date.now() - this.midiDeadlineMarginMs;
    const runBudget = () => Math.min(this.midiAttackTimeoutMs, timeLeft());
    const noTime =
      'no time was left in this call (the MCP side waits 60 s for the whole call), so it was not started';
    const MidiQOL = (globalThis as any).MidiQOL;
    if (!MidiQOL) throw new Error('MidiQOL not available');
    const scene = this._activeScene();
    const attTok = this._findToken(scene, data.attacker);
    if (!attTok) throw new Error('Attacker token not found: ' + data.attacker);
    const actor = attTok.actor;
    if (!actor) throw new Error('Attacker has no actor');
    // Board #1887 (independent review of 0.10.7, finding 5): a rule the bridge could not apply because Midi-QOL or
    // dnd5e threw is never dropped quietly. Each such case is said here, and the caller logs it.
    const ruleWarnings: string[] = [];
    const warnRule = (what: string, e: any) =>
      ruleWarnings.push(`${what}: ${String((e && (e.message || e)) || 'unknown error')}`);
    // Board #1887 (review finding 2): the exact item when the caller names its id (the brain does, from the combat
    // snapshot); by name, the first stack that can still attack (a used-up Javelin stack next to a new one is skipped).
    let item: any = null;
    if (data.itemId) {
      item = actor.items.get?.(data.itemId) ?? null;
      if (!item)
        ruleWarnings.push(
          `no item with id ${data.itemId} on ${attTok.name}: the item was looked up by its name, ${data.item}`
        );
    }
    if (!item) item = pickItemByName(actor.items, String(data.item));
    // Board #1887 (operator decision 2026-09-27 "Unarmed Strike"): every creature can make an Unarmed Strike, but a
    // monster's stat block never carries the item. When the attacker has none of its own, the attack uses dnd5e's
    // OWN Unarmed Strike (its compendium item for the world's rules version) as a temporary copy owned by the
    // attacker: dnd5e's roll machinery works out the numbers (Str + proficiency to hit, 1 + Str bludgeoning), and
    // nothing is added to the monster.
    let unarmed = false;
    if (!item && isUnarmedStrike(data.item)) {
      item = await this._unarmedStrikeFor(actor);
      if (!item)
        throw new Error(
          `Item not found on attacker: ${data.item} (dnd5e's own Unarmed Strike could not be loaded from its compendium)`
        );
      unarmed = true;
    }
    if (!item) throw new Error('Item not found on attacker: ' + data.item);
    // Board #1887 (review findings 2 and 5): every answer names the attacker's token and the exact item used (so the
    // brain records a character's throw against that stack), and carries any rule the engine could not apply.
    const finish = (o: any) => ({
      ...o,
      attackerId: attTok.id,
      itemId: unarmed ? null : (item.id ?? null),
      ...(ruleWarnings.length ? { ruleWarnings: [...ruleWarnings] } : {}),
    });
    const activities = [...((item.system.activities as any) || [])];
    const activity = activities.find((a: any) => a.type === 'attack') || activities[0];
    if (!activity) throw new Error('No usable activity on item: ' + data.item);
    // Spell slots: a leveled spell (not a cantrip) must have a slot to cast, and casting spends one
    // (in 5e the slot is consumed whether it hits, misses, or the target saves).
    const spellLevel =
      item.type === 'spell' && (item.system.level || 0) > 0 ? item.system.level : 0;
    if (spellLevel > 0) {
      const slot = actor.system.spells?.['spell' + spellLevel];
      if (!slot || (slot.value || 0) <= 0)
        return finish({
          success: false,
          error: 'No level-' + spellLevel + ' spell slots remaining',
          attacker: attTok.name,
          item: item.name,
        });
    }
    const consumeSlot = async () => {
      if (spellLevel > 0) {
        const s: any = actor.system.spells['spell' + spellLevel];
        await actor.update({
          ['system.spells.spell' + spellLevel + '.value']: Math.max(0, (s.value || 0) - 1),
        });
      }
    };

    // What a use spends, read before and after a Midi run (said when a stopped use still spent it; given back with
    // dnd5e's own refund when Midi-QOL refused the use after paying for it).
    const _spendNow = () => ({
      slot: spellLevel > 0 ? (actor.system?.spells?.[`spell${spellLevel}`]?.value ?? null) : null,
      itemUses: item.system?.uses?.value ?? null,
      activityUses: activity.uses?.value ?? null,
    });
    const _hpNow = (t: any) => t.actor?.system?.attributes?.hp?.value ?? 0;
    // Board #1887 (round 4): Midi-QOL refused a use AFTER paying for it (its formula target count, checked late):
    // dnd5e's own refund gives back exactly what the readings show was spent. Returns the words, or null.
    const refundIfSpent = async (spend0: any): Promise<string | null> => {
      const spent = spentOnUse(spend0, _spendNow());
      if (!spent.any) return null;
      try {
        const consumed = consumedDeltas(spend0, _spendNow(), {
          spellLevel,
          itemId: item.id ?? null,
          activityId: activity.id ?? null,
        });
        if (typeof activity.refund !== 'function') throw new Error('dnd5e has no refund');
        await activity.refund(consumed);
        const left = spentOnUse(spend0, _spendNow());
        if (left.any) {
          warnRule(
            `${item.name} was refused but still spent ${left.words}`,
            'the refund did not restore it'
          );
          return null;
        }
        return spent.words;
      } catch (e) {
        warnRule(
          `${item.name} was refused but spent ${spent.words}, and it could not be given back`,
          e
        );
        return null;
      }
    };

    const isAttack = activity.type === 'attack' || !!(activity as any).attack;
    const isHeal = activity.type === 'heal';
    const spellEffects = [...((item.effects as any) || [])].filter((e: any) => !e.transfer);
    const isSave = activity.type === 'save' || !!(activity as any).save;
    const isBuff =
      !isAttack && !isHeal && !isSave && (activity.type === 'utility' || spellEffects.length > 0);

    let targetToks = (data.targets || [])
      .map((r: string) => this._findToken(scene, r))
      .filter(Boolean);
    // Heals and buffs default to the caster (self) when no target is named ("I cast Bless").
    if (!targetToks.length && (isHeal || isBuff)) targetToks = [attTok];
    if (!targetToks.length) throw new Error('No valid targets');
    const results: any[] = [];
    // Board #1887 (bridge 0.10.7): a weapon whose quantity is 0 has been used up (a thrown weapon that
    // was thrown). dnd5e 5.3.3 only warns and still rolls; by the rules there is nothing left to
    // attack with, so the attack is refused and says why.
    if (weaponUsedUp({ type: item.type, quantity: item.system?.quantity })) {
      for (const t of targetToks)
        results.push({
          target: t.name,
          hit: false,
          noWeaponLeft: true,
          note: `${attTok.name} has no ${item.name} left to attack with (all of them were used up)`,
        });
      return finish({
        success: false,
        attacker: attTok.name,
        item: item.name,
        results,
        refused: true,
      });
    }
    // Midi-QOL's own settings, read once: its wall rule for range (`wallsBlockRange`, for the distance a refusal
    // reports) and, for the attack workflow, its critical damage setting for the GM (only reported, never changed).
    const _midiConfig: any = (() => {
      try {
        return (game as any).settings.get('midi-qol', 'ConfigSettings') || {};
      } catch (e) {
        warnRule(
          "Midi-QOL's settings could not be read, so its wall rule for range used its default",
          e
        );
        return null;
      }
    })();
    const _midiRules: any = _midiConfig?.optionalRules || {};
    // Per target: Midi-QOL's range verdict (normal / dis / fail) and its range numbers, kept for the roll.
    const _verdicts = new Map<string, any>();
    // ============ ENGINE RULE GATE: let Foundry/Midi-QOL decide legality ============
    // The DM/LLM cannot bypass rules. Midi's own checkActivityRange enforces the item's range/reach
    // AND any feats/effects that modify it (e.g. Spell Sniper doubling range); canSee enforces line
    // of sight (walls). Melee that is out of reach walks into reach first (5e move+attack).
    {
      const _M: any = (globalThis as any).MidiQOL;
      const _rng: any = item.system.range || {};
      const _isSelfSpell = _rng.units === 'self';
      const _isRangedWeapon = item.type === 'weapon' && (_rng.value || 0) > 5;
      const _needsAdjacent = (item.type === 'weapon' && !_isRangedWeapon) || _rng.units === 'touch';
      const _gs = scene.grid?.size || 100;
      const _G = (v: number) => Math.round(v / _gs);
      const _inRange = (tgt: any) => {
        try {
          const rr = _M?.checkActivityRange(activity, attTok.object, new Set([tgt.object]), false);
          _verdicts.set(tgt.id, rr || null);
          return !rr || rr.result !== 'fail';
        } catch (e) {
          _verdicts.delete(tgt.id);
          warnRule(
            `Midi-QOL's range check failed for ${tgt.name}, so the attack was allowed with no range rule (no long-range disadvantage)`,
            e
          );
          return true;
        }
      };
      // Board #1887: the distance Midi-QOL itself measured for its range check (its wall rule on), so
      // a refusal reports what the engine measured; negative when a wall blocks the attack.
      const _measured = (tgt: any) => {
        try {
          const wallsBlock =
            (_midiRules.wallsBlockRange ?? 'center') !== 'none' &&
            !activity?.midiProperties?.ignoreFullCover;
          const f = typeof _M?.getDistance === 'function' ? _M.getDistance : _M?.computeDistance;
          const d = f ? f(attTok.object, tgt.object, { wallsBlock, includeCover: true }) : null;
          return typeof d === 'number' && Number.isFinite(d) ? d : null;
        } catch (e) {
          warnRule(
            `Midi-QOL's distance to ${tgt.name} (walls on) could not be measured, so the refusal gives no distance`,
            e
          );
          return null;
        }
      };
      const _canSee = (tgt: any) => {
        try {
          return _M?.canSee ? _M.canSee(attTok.object, tgt.object) : true;
        } catch (e) {
          warnRule(
            `Midi-QOL's sight check for ${tgt.name} failed, so the attack was allowed as if it could see`,
            e
          );
          return true;
        }
      };
      const _valid: any[] = [];
      for (const t of targetToks) {
        const _isSelf = t.id === attTok.id;
        if (_isSelfSpell && !_isSelf) {
          results.push({
            target: t.name,
            hit: false,
            error: item.name + ' can only affect the caster',
          });
          continue;
        }
        if (_isSelf) {
          _valid.push(t);
          continue;
        }
        // Board #1887 (bridge 0.10.8 review): an ATTACK on a target the attacker cannot see is not refused here. The 2024
        // rules allow it with Disadvantage, and Midi-QOL's own workflow decides that (its invisAdvantage rule, RAW2024 on
        // our worlds); a wall in the way is still refused by Midi's range check below. Heals, buffs and save spells keep
        // the old sight refusal (their spells say "a creature you can see"; engine map M08/M09, unchanged).
        if (!isAttack && !_canSee(t)) {
          results.push({
            target: t.name,
            hit: false,
            outOfSight: true,
            note: 'no line of sight to ' + t.name,
          });
          continue;
        }
        if (!_inRange(t)) {
          if (_needsAdjacent) {
            const _spd = attTok.actor?.system?.attributes?.movement?.walk || 30;
            const _gridSpeed = Math.max(0, Math.floor(_spd / 5));
            let _cx = _G(attTok.x),
              _cy = _G(attTok.y);
            const _tx = _G(t.x),
              _ty = _G(t.y);
            let _steps = 0;
            while (_steps < _gridSpeed && Math.max(Math.abs(_cx - _tx), Math.abs(_cy - _ty)) > 1) {
              if (_cx < _tx) _cx++;
              else if (_cx > _tx) _cx--;
              if (_cy < _ty) _cy++;
              else if (_cy > _ty) _cy--;
              _steps++;
            }
            if (_steps > 0) {
              await attTok.update({ x: _cx * _gs, y: _cy * _gs });
              await new Promise(r => setTimeout(r, 400));
            }
            if (!_inRange(t)) {
              results.push({
                target: t.name,
                hit: false,
                outOfReach: true,
                movedFeet: _steps * 5,
                note: 'moved ' + _steps * 5 + 'ft but ' + t.name + ' is still out of reach',
              });
              continue;
            }
          } else {
            // Board #1887 (KNOWN-ISSUES row 221): say WHY Midi-QOL refused. Its range check fails when
            // its own distance (walls on) is negative, which means a wall is in the way, or beyond the
            // long range. The old words gave a no-walls distance and always said "beyond the range".
            const _df = _measured(t);
            const _vr = _verdicts.get(t.id) || {};
            results.push({
              target: t.name,
              hit: false,
              ...describeRangeRefusal({
                targetName: t.name,
                itemName: item.name,
                wallBlocked: typeof _df === 'number' && _df < 0,
                measuredFt: _df,
                normalFt: _vr.range,
                longFt: _vr.longRange,
              }),
            });
            continue;
          }
        }
        _valid.push(t);
      }
      targetToks = _valid;
    }
    if (!targetToks.length)
      return finish({
        success: false,
        attacker: attTok.name,
        item: item.name,
        results,
        refused: true,
      });
    // Board #1887 (bridge 0.10.8 round 4): ask the ENGINE, before anything is spent, whether this use can happen.
    // (1) The activity's own target count (dnd5e's evaluated `target.affects.count`), for a use that covers every
    // target at once (a spell or anything that spends on use, a save, a damage activity, a heal, a buff): Midi-QOL checks
    // a formula count only after the cost is paid (Hold Person, Bless, Magic Missile, Charm Person lost their slot), and
    // the heal and buff paths never ran Midi (Cure Wounds healed three for one slot). A weapon at several targets is one attack per
    // target and is not counted. (2) What dnd5e says it cannot pay (a Recharge ability not recharged, a used-up 1/Day,
    // no legendary actions left, no charges): with Midi's gmConsumeResource 'both' Midi opens dnd5e's usage dialog
    // instead of refusing, and nobody can answer it here. Both refusals are in the engine's own words.
    // (3) Round 4, review S1: an activity that puts ONE effect of the caster's choice on its target (Blindness/Deafness,
    // Hex, Bestow Curse, Contagion, Enlarge/Reduce, Protection from Energy): Midi-QOL (and the bridge's own buff path)
    // applied every effect listed. The caller names the effect (the model for a monster, or what the player said); with
    // several and none named, the use is refused and the choices listed. With one effect nothing changes.
    let chosenEffect: EffectChoice | null = null;
    {
      // every path but a weapon attack that spends nothing covers all its targets in ONE use (the heal and buff paths,
      // and the Midi path for a save or a plain damage activity such as Magic Missile)
      const coversAll = !isAttack || activitySpendsOnUse(item, activity, spellLevel);
      const allowed = engineTargetCount(activity);
      const distinct = new Set(targetToks.map((t: any) => t.id)).size;
      let refusal: { by: string; words: string; choices?: string[] } | null = null;
      if (coversAll && allowed !== null && distinct > allowed) {
        const fmt = (k: string, d: Record<string, unknown>) =>
          (game as any)?.i18n?.format ? (game as any).i18n.format(k, d) : '';
        refusal = { by: 'midi-qol', words: wrongNumberTargetsWords(allowed, fmt) };
      } else if (!unarmed) {
        try {
          const costErrors = await usageCostErrors(activity);
          if (costErrors?.length) refusal = { by: 'dnd5e', words: costErrors.join('; ') };
        } catch (e) {
          warnRule(
            `dnd5e's own check of what ${item.name} costs could not run, so it was not checked before the use`,
            e
          );
        }
      }
      if (!refusal) {
        // what this path would put on each target: the buff path its own list (the item's effects); Midi's paths the
        // activity's list, unless Midi-QOL applies no effects in this world (autoItemEffects 'off'); the heal path none
        const midiApplies = _midiConfig ? _midiConfig.autoItemEffects !== 'off' : true;
        const choices = isHeal
          ? []
          : isBuff
            ? itemEffectChoices(spellEffects)
            : midiApplies
              ? activityEffectChoices(activity, item.type === 'spell' ? spellLevel : null)
              : [];
        if (choices.length > 1) {
          const pick = pickEffectChoice(choices, data.effect);
          if (pick.chosen) chosenEffect = pick.chosen;
          else
            refusal = {
              by: 'rules',
              words: effectChoiceWords(item.name, choices, pick.problem!, data.effect),
              choices: choices.map(c => c.name),
            };
        } else if (choices.length === 1 && activity?.midiProperties?.chooseEffects) {
          // the item asks Midi to offer a choice (a dialog nobody here can answer) of a single effect: that one
          chosenEffect = choices[0];
        }
      }
      if (refusal) {
        for (const t of targetToks)
          results.push({
            target: t.name,
            hpBefore: _hpNow(t),
            hpAfter: _hpNow(t),
            damage: 0,
            hit: false,
            via: isHeal ? 'heal' : isBuff ? 'buff' : isAttack ? 'attack' : 'save',
            ...(refusal.by === 'rules' ? { needsChoice: true } : { engineRefused: true }),
            refusedBy: refusal.by,
            ...(refusal.choices ? { effectChoices: refusal.choices } : {}),
            note: `${item.name} was not used: ${refusal.words}`,
          });
        return finish({
          success: false,
          attacker: attTok.name,
          item: item.name,
          results,
          refused: true,
        });
      }
    }

    attTok.object?.control({ releaseOthers: true });

    // ---- HEAL (Cure Wounds, Healing Word): Midi's cast no-ops headless, so roll + apply HP. ----
    if (isHeal) {
      let healed = 0,
        error: string | null = null;
      try {
        const dr = await (activity as any).rollDamage({}, { configure: false }, {});
        const rolls = Array.isArray(dr) ? dr : [dr];
        healed = rolls.reduce((s: number, r: any) => s + (r?.total || 0), 0);
      } catch (e: any) {
        error = String((e && e.message) || e);
      }
      for (const t of targetToks) {
        const hp = t.actor?.system?.attributes?.hp;
        const before = hp?.value ?? 0,
          max = hp?.max ?? before;
        const after = Math.min(max, before + healed);
        if (after !== before) await t.actor.update({ 'system.attributes.hp.value': after });
        if (before <= 0 && after > 0) {
          const conds = (t.actor.effects || [])
            .filter((e: any) => e.statuses && e.statuses.size > 0)
            .map((e: any) => e.id);
          if (conds.length) await t.actor.deleteEmbeddedDocuments('ActiveEffect', conds);
        }
        results.push({
          target: t.name,
          hpBefore: before,
          hpAfter: after,
          healed: after - before,
          via: 'heal',
          error,
        });
      }
      await consumeSlot();
      return finish({ success: true, attacker: attTok.name, item: item.name, results });
    }

    // ---- BUFF / UTILITY (Bless, etc.): apply the spell's active effect(s) to the targets. ----
    if (isBuff) {
      // Board #1887 (round 4, review S1): with a choice, only the caster's chosen effect goes on the targets.
      const ce = chosenEffect;
      const buffEffects = ce
        ? spellEffects.filter(
            (e: any) => (ce.uuid && e.uuid === ce.uuid) || (ce.id && e.id === ce.id)
          )
        : spellEffects;
      const aes = buffEffects.map((e: any) => {
        const o = e.toObject();
        o.origin = item.uuid;
        o.disabled = false;
        delete o._id;
        return o;
      });
      for (const t of targetToks) {
        let applied: string[] = [];
        try {
          // avoid stacking the same-named effect on recast
          const dupes = (t.actor.effects || [])
            .filter((e: any) => aes.some((n: any) => n.name === e.name))
            .map((e: any) => e.id);
          if (dupes.length) await t.actor.deleteEmbeddedDocuments('ActiveEffect', dupes);
          const created = await t.actor.createEmbeddedDocuments('ActiveEffect', aes);
          applied = created.map((x: any) => x.name);
        } catch (e) {
          /* ignore */
        }
        results.push({
          target: t.name,
          effectsApplied: applied,
          via: 'buff',
          ...(chosenEffect ? { effectChosen: chosenEffect.name } : {}),
        });
      }
      await consumeSlot();
      return finish({ success: true, attacker: attTok.name, item: item.name, results });
    }

    // ---- ATTACK-ROLL actions (weapons + spell attacks): Midi-QOL's OWN attack workflow decides. ----
    // Board #1887 (bridge 0.10.8, engine map M07, operator 2026-09-27: "let Foundry handle the rules"). Until 0.10.7
    // this path rolled dnd5e's rollAttack itself, decided a hit as total >= AC, added critical dice by hand and applied
    // the damage itself, because "Midi's use() no-ops headless" (2026-08-30, Midi-QOL 13.0.64). Measured on the test
    // stack 2026-09-27 with Midi-QOL 14.0.12: its workflow runs in the headless GM browser in 1 to 2 s. What made it
    // hang was a roll DIALOG nobody can answer (a Thrown weapon with no attack mode named, and GM rolls not
    // fast-forwarded), so every such choice is given up front (midiAttackOptions). Midi-QOL now decides the hit, the
    // critical and its dice, advantage and disadvantage (long range, its optional rules, its flags), the AC it compares
    // with, the damage after resistances (never below 0) and applies it; this code only reads that back.
    if (isAttack) {
      const _M2: any = (globalThis as any).MidiQOL;
      const reactions = data.reactions === true;
      const critProblem = _midiConfig
        ? midiCriticalDamageProblem(_midiConfig.criticalDamageGM)
        : null;
      // Board #1887 (bridge 0.10.8 review, BLOCKER): an activity that spends something when it is USED (a spell slot, the
      // item's or the activity's limited uses) is used ONCE for all its targets, as dnd5e and Midi-QOL do it: one
      // completeActivityUse with every target, each target's result read from that one workflow. Until this fix a
      // levelled spell attack at two targets spent two slots. A weapon attack stays one Midi workflow per target: each is
      // its own attack (a thrown weapon's use-up and an arrow's ammunition are spent by the roll, not by use()).
      const oneUse = activitySpendsOnUse(item, activity, spellLevel);
      const _sys: any = item.system || {};
      // An unlinked token's actor can hand back a new item object after an update, so the
      // quantity is read fresh from the actor each time.
      const _qtyNow = () =>
        attTok.actor?.items?.get?.(item.id)?.system?.quantity ?? item.system?.quantity;
      const _thrProp = !!_sys.properties?.has?.('thr');
      const _modes = ((_sys.attackModes as any[]) || []).map((m: any) => m?.value);
      const _reachFt =
        Number(_sys.range?.reach) || Number((globalThis as any).canvas?.dimensions?.distance) || 5;
      interface Prep {
        t: any;
        AC: number;
        hpBefore: number;
        vr: any;
        choice: { mode: string | undefined; thrown: boolean };
        noWallsFt: number | null;
      }
      const preps: Prep[] = [];
      for (const t of targetToks) {
        // Board #1887 (bridge 0.10.7): the attack MODE is always named, thrown for a thrown weapon beyond its reach
        // (the same test Midi-QOL's workflow makes), otherwise the weapon's melee mode. dnd5e otherwise reuses the mode
        // it remembers from the last attack, and Midi-QOL 14.0.12 opens a roll dialog for a Thrown weapon when no
        // mode is named (workflowOptions.attackMode).
        const _vr: any = _verdicts.get(t.id) || null;
        let _noWallsFt: number | null = null;
        try {
          const f = typeof _M2?.getDistance === 'function' ? _M2.getDistance : _M2?.computeDistance;
          const d = f ? f(attTok.object, t.object, { wallsBlock: false }) : null;
          _noWallsFt = typeof d === 'number' && Number.isFinite(d) ? d : null;
        } catch (e) {
          _noWallsFt = null;
          warnRule(
            `Midi-QOL's distance to ${t.name} (walls off) could not be measured, so the throw-or-melee choice fell back to its range verdict`,
            e
          );
        }
        const _choice = chooseAttackMode({
          modes: _modes,
          thrownProperty: _thrProp,
          distanceFt: _noWallsFt,
          reachFt: _reachFt,
          verdict: _vr?.result,
        });
        preps.push({
          t,
          AC: t.actor?.system?.attributes?.ac?.value ?? 10,
          hpBefore: t.actor?.system?.attributes?.hp?.value ?? 0,
          vr: _vr,
          choice: _choice,
          noWallsFt: _noWallsFt,
        });
      }
      let engineStuck: string | null = null;
      // Board #1887 (round 3): hit points read just before the Midi run that decides the target (as 618a313 did), so a
      // target named twice starts its second result from the hit points the first left (_hpNow, above).
      const engineRefusal = (p: Prep, run: any, refunded: string | null) => ({
        target: p.t.name,
        hpBefore: p.hpBefore,
        hpAfter: _hpNow(p.t),
        damage: 0,
        hit: false,
        via: 'attack',
        engine: 'midi-qol',
        engineRefused: true,
        refusedBy: 'midi-qol',
        note: `Midi-QOL did not make the attack: ${run.refusedByEngine}`,
        ...(refunded ? { refunded } : {}),
        engineNotes: run.notes,
      });
      // One result row per target, the same fields as before (brain 0.65.138 reads them), from one Midi run.
      const rowFor = (p: Prep, run: any, spend0: any, qtyBefore: any, stuckMsg: string | null) => {
        const t = p.t;
        const out = readMidiAttack(run.wf, { uuid: t.uuid ?? t.document?.uuid ?? null, id: t.id });
        let error: string | null = run.error ?? (run.timedOut ? null : out.error);
        if (stuckMsg) error = stuckMsg;
        if (error)
          warnRule(`the attack on ${t.name} did not go through Midi-QOL's workflow`, error);
        const hpAfter = t.actor?.system?.attributes?.hp?.value ?? p.hpBefore;
        if (out.hit && out.crit && critProblem)
          warnRule(`the critical hit on ${t.name}`, critProblem);
        if (
          out.hit &&
          out.engineHpAfter !== null &&
          out.engineHpAfter < p.hpBefore &&
          hpAfter === p.hpBefore
        )
          warnRule(
            `Midi-QOL worked out ${out.damageApplied} damage for ${t.name} but its hit points did not change`,
            'check its "auto apply damage" setting'
          );
        const spent = spentOnUse(spend0, _spendNow());
        const stoppedButSpent = !!error && spent.any;
        if (stoppedButSpent)
          warnRule(
            `the attack on ${t.name} was stopped, but ${item.name} still spent ${spent.words}`,
            'dnd5e spent it when the item was used'
          );
        return {
          target: t.name,
          hpBefore: p.hpBefore,
          hpAfter,
          damage: p.hpBefore - hpAfter,
          hit: out.hit,
          crit: out.crit,
          fumble: out.fumble,
          attackTotal: out.attackTotal,
          damageRolled: out.damageRolled,
          damageApplied: out.damageApplied,
          damageType: out.damageType,
          // the AC Midi-QOL compared with (its cover and AC flags in); a number as before, the target's own AC when Midi
          // recorded none or the target had total cover (then `totalCover: true`)
          targetAC: out.targetAC ?? p.AC,
          via: 'attack',
          error,
          // Board #1887: how the engine rolled it.
          formula: out.formula,
          // as before: the weapon's mode, null for an item with none (a spell; Midi's roll still says 'oneHanded')
          attackMode: p.choice.mode ? (out.attackMode ?? p.choice.mode) : null,
          thrown: p.choice.thrown,
          ...(p.choice.thrown ? { remaining: _qtyNow() ?? null } : {}),
          usedUp: usedUpCount(item.type, qtyBefore, _qtyNow()),
          disadvantage: out.disadvantage,
          disadvantageReasons: out.disadvantageReasons,
          rangeVerdict: p.vr?.result ?? null,
          distanceFt: p.noWallsFt,
          ...(unarmed ? { unarmed: true } : {}),
          // Board #1887 (bridge 0.10.8): what Midi-QOL's own workflow decided, beyond the fields above.
          engine: 'midi-qol',
          advantage: out.advantage,
          advantageReasons: out.advantageReasons,
          rollMode: out.rollMode,
          rollModifiers: out.rollModifiers,
          targetBaseAC: out.targetBaseAC ?? p.AC,
          ...(out.totalCover ? { totalCover: true } : {}),
          ...(out.acDetail ? { acDetail: out.acDetail } : {}),
          damageRolls: out.damageRolls,
          damageDetail: out.damageDetail,
          tempDamage: out.tempDamage,
          reactions: reactions ? 'on' : 'off',
          midiState: out.state,
          midiMs: run.ms,
          ...(oneUse ? { oneUseForAllTargets: true } : {}),
          ...(stoppedButSpent ? { spentAlthoughStopped: spent.words } : {}),
          ...(run.guarded?.length ? { guardedAfterStop: true } : {}),
          ...(run.templateNotPlaced ? { templateNotPlaced: true } : {}),
          ...(run.effectChosen ? { effectChosen: run.effectChosen } : {}),
          ...(run.notes.length ? { engineNotes: run.notes } : {}),
        };
      };
      const stuckWords = (run: any, secs: number) => {
        const at = run.stuckAt ? ` (it stopped at ${run.stuckAt})` : '';
        const dialogs = run.dialogs.length
          ? `; a window nobody here can answer was open and was closed (${run.dialogs.join(', ')})`
          : '';
        return `Midi-QOL's attack workflow did not finish within ${secs} s${at}${dialogs}; the attack was stopped`;
      };
      const notAttacked = (p: Prep, why: string) => ({
        target: p.t.name,
        hpBefore: _hpNow(p.t),
        hpAfter: _hpNow(p.t),
        damage: 0,
        hit: false,
        via: 'attack',
        engine: 'midi-qol',
        error: `not attacked: ${why}`,
      });
      if (oneUse) {
        const seen = new Set<string>();
        const early = new Map<Prep, any>();
        const ready = preps.filter(p => {
          // Board #1887 (round 3): one use attacks each target once (Midi-QOL rolls one attack per target in a use);
          // a target named again is said, not attacked again and not counted twice.
          const key = String(p.t.id ?? p.t.uuid ?? p.t.name);
          if (seen.has(key)) {
            early.set(p, {
              target: p.t.name,
              hit: false,
              damage: 0,
              via: 'attack',
              engine: 'midi-qol',
              sameTargetAgain: true,
              note: `${p.t.name} was named more than once; one use of ${item.name} attacks each target once (Midi-QOL rolls one attack per target), so it was attacked once`,
            });
            return false;
          }
          seen.add(key);
          // a used-up weapon is still refused (house rule below) even on the one-use path
          if (p.choice.thrown && weaponUsedUp({ type: item.type, quantity: _qtyNow() })) {
            early.set(p, {
              target: p.t.name,
              hit: false,
              noWeaponLeft: true,
              note: `${attTok.name} has no ${item.name} left to throw (all of them were used up)`,
            });
            return false;
          }
          return true;
        });
        const made = new Map<Prep, any>();
        if (ready.length) {
          const budget = runBudget();
          if (timeLeft() < this.midiMinRunMs) {
            for (const p of ready) made.set(p, notAttacked(p, noTime));
          } else {
            const spend0 = _spendNow();
            const qty0 = _qtyNow();
            for (const p of ready) p.hpBefore = _hpNow(p.t);
            const run = await this._runMidiAttack(
              _M2,
              activity,
              attTok,
              ready.map(p => p.t),
              {
                attackMode: ready[0]?.choice.mode,
                reactions,
                timeoutMs: budget,
                kind: 'attack',
                chosenEffect,
              }
            );
            const stuck = run.timedOut ? stuckWords(run, Math.round(budget / 1000)) : null;
            const refunded = run.refusedByEngine ? await refundIfSpent(spend0) : null;
            for (const p of ready)
              made.set(
                p,
                run.refusedByEngine
                  ? engineRefusal(p, run, refunded)
                  : rowFor(p, run, spend0, qty0, stuck)
              );
          }
        }
        // the rows in the order the targets were named; a target named again comes after its own row
        for (const p of preps) {
          if (made.has(p)) results.push(made.get(p));
          else if (early.has(p) && !early.get(p).sameTargetAgain) results.push(early.get(p));
        }
        for (const p of preps)
          if (early.has(p) && early.get(p).sameTargetAgain) results.push(early.get(p));
      } else {
        for (const p of preps) {
          // HOUSE RULE (board #1887, bridge 0.10.7; moves to the aidm-rules add-on): a used-up weapon is not thrown.
          // dnd5e 5.3.3 only warns at quantity 0 and still rolls, and neither dnd5e nor Midi-QOL has a setting that
          // refuses it.
          if (p.choice.thrown && weaponUsedUp({ type: item.type, quantity: _qtyNow() })) {
            results.push({
              target: p.t.name,
              hit: false,
              noWeaponLeft: true,
              note: `${attTok.name} has no ${item.name} left to throw (all of them were used up)`,
            });
            continue;
          }
          if (engineStuck) {
            // The engine's workflow for an earlier target never finished; another attack would only wait again.
            results.push(notAttacked(p, engineStuck));
            continue;
          }
          const budget = runBudget();
          if (timeLeft() < this.midiMinRunMs) {
            results.push(notAttacked(p, noTime));
            continue;
          }
          // Board #1887 (re-review of 876a95d): how many the roll REALLY used up, read from the item before and after:
          // a Returning weapon is thrown but dnd5e keeps its quantity, and a roll that failed uses nothing up.
          const qty0 = _qtyNow();
          const spend0 = _spendNow();
          p.hpBefore = _hpNow(p.t);
          const run = await this._runMidiAttack(_M2, activity, attTok, [p.t], {
            attackMode: p.choice.mode,
            reactions,
            timeoutMs: budget,
            kind: 'attack',
            chosenEffect,
          });
          const stuck = run.timedOut ? stuckWords(run, Math.round(budget / 1000)) : null;
          if (stuck) engineStuck = stuck;
          const refunded = run.refusedByEngine ? await refundIfSpent(spend0) : null;
          results.push(
            run.refusedByEngine
              ? engineRefusal(p, run, refunded)
              : rowFor(p, run, spend0, qty0, stuck)
          );
        }
      }
      // A spell attack's slot: dnd5e's own activity.use (inside Midi-QOL's workflow) spends it once, so it is not spent
      // again here (0.10.7 lowered it by hand after its own roll).
      // Board #1887 (round 3): when Midi-QOL itself refused every attack (nothing was rolled), the call is refused, as
      // the range refusals above are.
      const attempted = results.filter((r: any) => r.via === 'attack' && !r.sameTargetAgain);
      if (attempted.length && attempted.every((r: any) => r.engineRefused))
        return finish({
          success: false,
          attacker: attTok.name,
          item: item.name,
          results,
          refused: true,
        });
      return finish({ success: true, attacker: attTok.name, item: item.name, results });
    }

    // ---- SAVE / other (Sacred Flame, Fireball, a breath weapon): Midi resolves the save + half/none damage. ----
    // Board #1887 (bridge 0.10.8 round 4): the save path goes through the same runner as attacks: the call's deadline,
    // every dialog it left closed, the stop guard, Midi's own refusal in its words (and dnd5e's refund when Midi refused
    // after paying), and no reactions (Midi's own noProvokeReaction; operator "With the chooser"). Before, it waited for
    // Midi's own 90 s (past the MCP side's 60 s) and left any dialog open.
    targetToks.forEach((t: any) =>
      t.object?.setTarget(true, { user: (game as any).user, releaseOthers: false })
    );
    const before = targetToks.map((t: any) => ({ hp: _hpNow(t) }));
    if (timeLeft() < this.midiMinRunMs) {
      for (const t of targetToks)
        results.push({
          target: t.name,
          hpBefore: _hpNow(t),
          hpAfter: _hpNow(t),
          damage: 0,
          via: 'save',
          engine: 'midi-qol',
          error: `not cast: ${noTime}`,
        });
      return finish({ success: false, attacker: attTok.name, item: item.name, results });
    }
    const saveBudget = runBudget();
    const saveSpend0 = _spendNow();
    const saveRun = await this._runMidiAttack(MidiQOL, activity, attTok, targetToks, {
      attackMode: undefined,
      reactions: data.reactions === true,
      timeoutMs: saveBudget,
      kind: 'save',
      chosenEffect,
    });
    if (saveRun.refusedByEngine) {
      const refunded = await refundIfSpent(saveSpend0);
      for (let i = 0; i < targetToks.length; i++)
        results.push({
          target: targetToks[i].name,
          hpBefore: before[i].hp,
          hpAfter: _hpNow(targetToks[i]),
          damage: 0,
          via: 'save',
          engine: 'midi-qol',
          engineRefused: true,
          refusedBy: 'midi-qol',
          note: `Midi-QOL did not cast it: ${saveRun.refusedByEngine}`,
          ...(refunded ? { refunded } : {}),
          engineNotes: saveRun.notes,
        });
      return finish({
        success: false,
        attacker: attTok.name,
        item: item.name,
        results,
        refused: true,
      });
    }
    let saveError: string | null = saveRun.error;
    if (saveRun.timedOut) {
      const at = saveRun.stuckAt ? ` (it stopped at ${saveRun.stuckAt})` : '';
      const dialogs = saveRun.dialogs.length
        ? `; a window nobody here can answer was open and was closed (${saveRun.dialogs.join(', ')})`
        : '';
      saveError = `Midi-QOL's workflow did not finish within ${Math.round(saveBudget / 1000)} s${at}${dialogs}; the spell was stopped`;
    } else if (!saveRun.wf && !saveError) {
      saveError =
        "Midi-QOL's workflow gave nothing back, so nothing was cast (the item could not be used, or the workflow did not start)";
    }
    if (saveRun.error && !saveRun.timedOut) {
      // A late throw from the headless page after Midi applied the save's damage (the old path swallowed these): the
      // spell counts as cast when the hit points moved; the throw is still said.
      for (let w = 0; w < 7; w++) {
        if (targetToks.some((t: any, i: number) => _hpNow(t) !== before[i].hp)) break;
        await new Promise(r => setTimeout(r, 300));
      }
      if (targetToks.some((t: any, i: number) => _hpNow(t) !== before[i].hp)) {
        warnRule(`Midi-QOL threw after ${item.name} was cast`, saveRun.error);
        saveError = null;
      }
    }
    if (saveError) warnRule(`${item.name} did not go through Midi-QOL's workflow`, saveError);
    const spent = spentOnUse(saveSpend0, _spendNow());
    const stoppedButSpent = !!saveError && spent.any;
    if (stoppedButSpent)
      warnRule(
        `${item.name} was stopped, but it still spent ${spent.words}`,
        'dnd5e spent it when the item was used'
      );
    if (!saveError && !saveRun.wf) {
      // No workflow came back (a thrown page, above): a short wait for the hit points to arrive. A finished workflow
      // has already applied them (completeActivityUse answers after Midi's cleanup).
      for (let w = 0; w < 7; w++) {
        if (targetToks.some((t: any, i: number) => _hpNow(t) !== before[i].hp)) break;
        await new Promise(r => setTimeout(r, 300));
      }
    }
    for (let i = 0; i < targetToks.length; i++) {
      const t = targetToks[i];
      const hpAfter = _hpNow(t);
      results.push({
        target: t.name,
        hpBefore: before[i].hp,
        hpAfter,
        damage: (before[i].hp ?? 0) - (hpAfter ?? 0),
        via: 'save',
        engine: 'midi-qol',
        error: saveError,
        midiState: saveRun.wf?.currentAction?.name ?? null,
        midiMs: saveRun.ms,
        reactions: data.reactions === true ? 'on' : 'off',
        ...(stoppedButSpent ? { spentAlthoughStopped: spent.words } : {}),
        ...(saveRun.guarded?.length ? { guardedAfterStop: true } : {}),
        ...(saveRun.templateNotPlaced ? { templateNotPlaced: true } : {}),
        ...(saveRun.effectChosen ? { effectChosen: saveRun.effectChosen } : {}),
        ...(saveRun.notes.length ? { engineNotes: saveRun.notes } : {}),
      });
    }
    // Board #1887 (bridge 0.10.8): no slot is spent here. dnd5e's own activity.use, inside Midi-QOL's workflow above,
    // already spends it; measured on the test stack 2026-09-27, a level 1 save spell (Dissonant Whispers) through this
    // path took TWO slots (2 -> 0) until this line went.
    return finish({ success: !saveError, attacker: attTok.name, item: item.name, results });
  }

  /**
   * Board #1887 (bridge 0.10.8, engine map M07): one use through Midi-QOL's OWN workflow, `MidiQOL.completeActivityUse`
   * (the call the save path already used), against the given targets (one for a weapon attack; all of them for an
   * activity that spends a slot or uses). Returns the workflow Midi hands back when it finishes, or says that it did not:
   * `completeActivityUse` itself waits up to 90 s before giving up, longer than the MCP side waits for the whole call
   * (60 s), so this waits `opts.timeoutMs` (never past the call's deadline). When the workflow is stuck (a window nobody
   * can answer in the headless GM browser, or Midi-QOL crashing inside it), the stuck workflow is aborted and EVERY
   * window opened while it ran (a roll dialog, the other activity's usage dialog, a reaction prompt) is closed, so the
   * next attack does not find them, and the answer says where it stopped.
   * What dnd5e and Midi-QOL tell the GM while it runs (ui.notifications, e.g. dnd5e's "no quantity" warning) is kept
   * and returned as `notes`.
   */
  /**
   * Board #1887: keep what dnd5e and Midi-QOL tell the GM (ui.notifications warn, error and info) in `notes` until the
   * returned function is called, which puts the GM's own notifications back. Each message still reaches the GM.
   */
  private _captureNotes(notes: string[]): () => void {
    const g: any = globalThis as any;
    const ui = g.ui?.notifications;
    const saved: Record<string, any> = {};
    const say = (msg: any, o: any) => {
      try {
        const text =
          o?.localize && typeof g.game?.i18n?.localize === 'function'
            ? g.game.i18n.localize(String(msg))
            : String(msg);
        if (text) notes.push(text);
      } catch (e) {
        /* a note that cannot be read is not worth failing the attack for */
      }
    };
    for (const k of ['warn', 'error', 'info']) {
      if (ui && typeof ui[k] === 'function') {
        saved[k] = ui[k];
        ui[k] = function (msg: any, o: any) {
          say(msg, o);
          return saved[k].call(ui, msg, o);
        };
      }
    }
    return () => {
      for (const k of Object.keys(saved)) ui[k] = saved[k];
    };
  }

  private async _runMidiAttack(
    MidiQOL: any,
    activity: any,
    attTok: any,
    targets: any[],
    opts: {
      attackMode: string | undefined;
      reactions: boolean;
      timeoutMs: number;
      kind?: 'attack' | 'save';
      chosenEffect?: EffectChoice | null;
    }
  ): Promise<{
    wf: any;
    timedOut: boolean;
    error: string | null;
    notes: string[];
    stuckAt: string | null;
    dialogs: string[];
    guarded: string[];
    refusedByEngine: string | null;
    templateNotPlaced: boolean;
    effectChosen: string | null;
    ms: number;
  }> {
    const g: any = globalThis as any;
    const started = Date.now();
    const notes: string[] = [];
    const res = {
      wf: null as any,
      timedOut: false,
      error: null as string | null,
      notes,
      stuckAt: null as string | null,
      dialogs: [] as string[],
      guarded: [] as string[],
      refusedByEngine: null as string | null,
      templateNotPlaced: false,
      effectChosen: null as string | null,
      ms: 0,
    };
    if (typeof MidiQOL?.completeActivityUse !== 'function') {
      res.error =
        "Midi-QOL's completeActivityUse is not available, so the attack could not be made";
      return res;
    }
    const undrawn = targets.filter((t: any) => !t.object);
    if (undrawn.length) {
      res.error = `${undrawn.map((t: any) => t.name).join(', ')} is not drawn on the map in the GM's browser, so Midi-QOL cannot target it`;
      return res;
    }
    // The windows already open before this use (the GM browser's own UI), so only the ones this use opens are closed.
    const appsBefore = new Set<any>([...(g.foundry?.applications?.instances?.values?.() ?? [])]);
    const v1Before = new Set<any>(Object.values(g.ui?.windows ?? {}));
    const restoreNotes = this._captureNotes(notes);
    const usage: any = {
      midiOptions: {
        ...(opts.kind === 'save'
          ? midiSaveOptions({
              reactions: opts.reactions,
              skipDiceAnimation: this.midiSkipDiceAnimation,
            })
          : midiAttackOptions({
              attackMode: opts.attackMode,
              reactions: opts.reactions,
              skipDiceAnimation: this.midiSkipDiceAnimation,
            })),
        targetsToUse: new Set(targets.map((t: any) => t.object)),
      },
      // Board #1887 (round 4): never place a measured template. An area activity (a breath weapon's line or cone)
      // otherwise makes dnd5e wait for a mouse click on the canvas (its template placement), which nobody gives in the
      // headless GM browser: measured on the test stack, a recharged Fire Breath stopped at 25 s with the placement
      // still waiting. The targets are the ones named in the call.
      create: { measuredTemplate: false },
    };
    const TIMEOUT = Symbol('timeout');
    let timer: any;
    let areaWatch: any;
    // Board #1887 (round 4, review S1): the caster's ONE chosen effect. Midi-QOL 14.0.12 applies every effect the
    // activity lists unless the activity's midiProperties.chooseEffects is on, and then asks in a dialog nobody can
    // answer here (Workflow.ts 2667, chooseEffects 7590). Its own pre-state hook for THIS use's workflow (by sequence
    // id), `midi-qol.preApplyDynamicEffects`, turns that switch on for this workflow only and answers the choice itself
    // with the caster's effect (the caster's own effects stay); the switch is put back as soon as Midi has read it.
    let effectHook: number | null = null;
    let effectRestore: (() => void) | null = null;
    const hooks: any = g.Hooks;
    if (opts.chosenEffect && typeof hooks?.on === 'function') {
      const chosen = opts.chosenEffect;
      effectHook = hooks.on('midi-qol.preApplyDynamicEffects', (w: any) => {
        try {
          const seq = usage.sequenceId;
          if (!w || (seq ? w.sequenceId !== seq : w.activity?.uuid !== activity.uuid)) return;
          const act = w.activity ?? activity;
          act.midiProperties ??= {};
          const mp = act.midiProperties;
          const old = mp.chooseEffects;
          mp.chooseEffects = true;
          effectRestore = () => {
            mp.chooseEffects = old;
          };
          w.chooseEffects = async (effects: any[]) => {
            effectRestore?.();
            effectRestore = null;
            const kept = keepChosenEffect(effects, chosen);
            res.effectChosen = chosen.name;
            if (!kept.some((ef: any) => ef?.uuid === chosen.uuid || ef?.id === chosen.id))
              notes.push(
                `Midi-QOL did not offer ${chosen.name}, so no effect of the choice was applied`
              );
            return kept;
          };
        } catch (e: any) {
          notes.push(
            `the caster's chosen effect could not be given to Midi-QOL: ${String(e?.message ?? e)}`
          );
        }
      });
    }
    try {
      const run = Promise.resolve().then(() =>
        MidiQOL.completeActivityUse(activity, usage, { configure: false }, {})
      );
      // With no template placed, Midi-QOL 14.0.12 still expects one for an area activity (Workflow.ts,
      // expectedTemplateCount) and suspends in WorkflowState_AwaitTemplate after the use. Its own way on is
      // unSuspend({itemUseComplete: true}) (Workflow.ts 1961: then AoETargetConfirmation with the targets given); it is
      // said once, only to THIS use's workflow (its sequence id), only while it waits there with no template.
      areaWatch = setInterval(() => {
        try {
          const seq = usage.sequenceId;
          if (!seq) return;
          const w = [...(MidiQOL.Workflow?.workflows?.values?.() ?? [])]
            .map((x: any) => (typeof x?.deref === 'function' ? x.deref() : x))
            .find((x: any) => x?.sequenceId === seq);
          if (
            w &&
            !res.templateNotPlaced &&
            w.suspended &&
            /AwaitTemplate/.test(String(w.currentAction?.name ?? '')) &&
            !(w.templateUuids?.length > 0) &&
            typeof w.unSuspend === 'function'
          ) {
            res.templateNotPlaced = true;
            Promise.resolve(w.unSuspend({ itemUseComplete: true })).catch((e: any) =>
              notes.push(`Midi-QOL did not go on without a template: ${String(e?.message ?? e)}`)
            );
          }
        } catch (e) {
          /* the next tick looks again */
        }
      }, 200);
      const got = await Promise.race([
        run,
        new Promise(r => {
          timer = setTimeout(() => r(TIMEOUT), Math.max(0, opts.timeoutMs));
        }),
      ]);
      if (got === TIMEOUT) res.timedOut = true;
      else res.wf = got ?? null;
    } catch (e: any) {
      res.error = `Midi-QOL's attack workflow failed: ${String((e && (e.message || e)) || e)}`;
    } finally {
      clearTimeout(timer);
      clearInterval(areaWatch);
      if (effectHook !== null) hooks.off('midi-qol.preApplyDynamicEffects', effectHook);
      (effectRestore as (() => void) | null)?.();
      restoreNotes();
    }
    if (res.timedOut) {
      // Stop what is stuck: the workflow for this activity that has not finished, and any roll or reaction window.
      try {
        const all = [...(MidiQOL.Workflow?.workflows?.values?.() ?? [])]
          .map((w: any) => (typeof w?.deref === 'function' ? w.deref() : w))
          .filter(Boolean);
        const done = /Completed|Cleanup|Abort|RollFinished/;
        // Board #1887 (round 4): THIS use's workflow, by the sequence id Midi-QOL puts on the bridge's own usage object
        // (utils.ts completeActivityUse, MidiActivityMixin.ts 673), never another use of the same item that happens to
        // be running; the item's activity only when Midi set no id.
        const seq = usage.sequenceId;
        const mine = all.filter(
          (w: any) =>
            (seq
              ? w.sequenceId === seq
              : w.activity?.uuid === activity.uuid ||
                (w.actor === attTok.actor && w.item?.name === activity.item?.name)) &&
            !done.test(String(w.currentAction?.name ?? ''))
        );
        for (const w of mine) {
          res.stuckAt = String(w.currentAction?.name ?? '').replace(/^bound /, '') || res.stuckAt;
          // Board #1887 (round 3): its own state loop may still be waiting (a reaction prompt, a save, a dice
          // animation); from any state it enters next it goes to Abort, so no damage lands after this answer says
          // "stopped". Every workflow stopped is reported (guardedAfterStop).
          if (this.midiGuardStoppedWorkflows) res.guarded.push(...guardStoppedWorkflow(w));
          try {
            w.aborted = true;
            if (typeof w.performState === 'function') await w.performState(w.WorkflowState_Abort);
          } catch (e) {
            /* already broken; it is reported below */
          }
        }
      } catch (e) {
        /* nothing more can be stopped; the timeout is still reported */
      }
      try {
        // Every dialog this use opened and left open (a roll dialog, dnd5e's ActivityUsageDialog for the item or its
        // other activity, a Midi reaction or target prompt): nobody in the headless GM browser can answer it.
        const apps = [
          ...[...(g.foundry?.applications?.instances?.values?.() ?? [])].filter(
            a => !appsBefore.has(a)
          ),
          ...Object.values(g.ui?.windows ?? {}).filter((a: any) => !v1Before.has(a)),
        ];
        for (const a of apps) {
          const name = String(a?.constructor?.name ?? '');
          if (/Dialog|Configuration|Reaction|Prompt|Confirm/i.test(name)) {
            res.dialogs.push(name);
            try {
              await a.close();
            } catch (e) {
              /* closing failed; it was named */
            }
          }
        }
      } catch (e) {
        /* no window list; nothing to close */
      }
    }
    // Board #1887 (round 3, 4): Midi-QOL refused the use itself: no workflow (its requiresTargets check, before the
    // cost) or a workflow it aborted (its formula target count, after the cost: WorkflowState_AoETargetConfirmation).
    // Only Midi-QOL's own refusal texts count as the reason; any other notice shown meanwhile stays an engine note.
    if (!res.timedOut && !res.error && (!res.wf || res.wf.aborted === true)) {
      const localize = (k: string) =>
        g.game?.i18n?.localize ? String(g.game.i18n.localize(k)) : '';
      const why = notes.filter(n => isMidiRefusalText(n, localize));
      if (why.length) res.refusedByEngine = why.join('; ');
    }
    res.ms = Date.now() - started;
    return res;
  }

  /**
   * Board #1887: dnd5e's own Unarmed Strike, as a temporary item owned by `actor` and never saved to it. The item is
   * the system's compendium copy for the world's rules version (`unarmedStrikeUuid`). dnd5e prepares an owned item's
   * final data (proficiency, to-hit, damage) only after its actor's own preparation, so the copy is given that
   * preparation the way dnd5e's own `Item5e#clone` does for an owned clone (`prepareFinalAttributes`). Without it the
   * roll missed the proficiency bonus (measured: `1d20 - 2` instead of `1d20 - 2 + 2`) and no damage was rolled.
   * dnd5e's `rollAttack` itself only remembers the last attack mode on an item its actor holds, so nothing is
   * written to the monster. Returns null when the compendium item cannot be loaded.
   */
  private async _unarmedStrikeFor(actor: any): Promise<any> {
    let rules: unknown = 'modern';
    try {
      rules = (game as any).settings.get('dnd5e', 'rulesVersion');
    } catch (e) {
      rules = 'modern'; // dnd5e's own default
    }
    const g: any = globalThis as any;
    let src: any = null;
    try {
      src = typeof g.fromUuid === 'function' ? await g.fromUuid(unarmedStrikeUuid(rules)) : null;
    } catch (e) {
      src = null;
    }
    const ItemCls: any = g.CONFIG?.Item?.documentClass;
    if (!src || !ItemCls) return null;
    const data = typeof src.toObject === 'function' ? src.toObject() : src;
    const tmp: any = new ItemCls(data, { parent: actor });
    if (typeof tmp.prepareFinalAttributes === 'function') tmp.prepareFinalAttributes();
    return tmp;
  }

  // ---- Scene provisioning tools (Phase B board-prep, B5/P6 report card; Section 4f audit gap). ----
  // Adventure-agnostic: caller supplies name/grid/flags/package data; nothing here names a module.
  private _findSceneByIdOrName(idOrName: string): any {
    const scenes = (game as any).scenes?.contents || [];
    let scene = (game as any).scenes?.get(idOrName);
    if (!scene) {
      const lower = String(idOrName).toLowerCase();
      scene = scenes.find((s: any) => s.name?.toLowerCase() === lower);
    }
    return scene || null;
  }

  private _gridUpdatePayload(grid?: {
    type?: number;
    size?: number;
    offsetX?: number;
    offsetY?: number;
  }): any {
    if (!grid) return undefined;
    const g: any = {};
    if (grid.type !== undefined) g.type = grid.type;
    if (grid.size !== undefined) g.size = grid.size;
    if (grid.offsetX !== undefined) g.offsetX = grid.offsetX;
    if (grid.offsetY !== undefined) g.offsetY = grid.offsetY;
    return Object.keys(g).length ? g : undefined;
  }

  private async handleSceneCreate(data: {
    name?: string;
    background?: string;
    flags?: any;
    grid?: { type?: number; size?: number; offsetX?: number; offsetY?: number };
  }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      if (!data?.name || typeof data.name !== 'string' || !data.name.trim()) {
        throw new Error('name is required');
      }
      const sceneData: any = { name: data.name.trim() };
      if (data.background) sceneData.background = { src: data.background };
      const grid = this._gridUpdatePayload(data.grid);
      if (grid) sceneData.grid = grid;
      if (data.flags) sceneData.flags = data.flags;

      const SceneCls: any = (globalThis as any).Scene;
      if (!SceneCls?.create) throw new Error('Scene document class unavailable');
      const created = await SceneCls.create(sceneData);
      if (!created) throw new Error('Scene.create returned no document');
      return { success: true, id: created.id, name: created.name };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e) };
    }
  }

  private async handleSceneUpdate(data: {
    id?: string;
    scene_identifier?: string;
    name?: string;
    background?: string;
    flags?: any;
    grid?: { type?: number; size?: number; offsetX?: number; offsetY?: number };
    // Phase E addition: fog/vision fields. Field names verified against the v13 SceneData
    // schema (https://foundryvtt.com/api/v13/interfaces/foundry.documents.types.SceneData.html)
    // -- see bridge/README.md's 0004 entry for the full citation trail. "globalLight" and
    // "darkness" are NOT flat Scene fields in v13 (that was pre-v12 shape); they live under
    // scene.environment, which is why this is nested rather than flat like grid/flags above.
    tokenVision?: boolean;
    environment?: {
      darknessLevel?: number;
      darknessLevelLock?: boolean;
      cycle?: boolean;
      globalLight?: { enabled?: boolean; bright?: boolean; alpha?: number; color?: string | null };
    };
    fog?: {
      exploration?: boolean;
      overlay?: string | null;
      reset?: number | null;
      colors?: { explored?: string | null; unexplored?: string | null };
    };
  }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      const locator = data?.id || data?.scene_identifier;
      if (!locator) throw new Error('id or scene_identifier is required to locate the scene');
      const scene = this._findSceneByIdOrName(locator);
      if (!scene) throw new Error(`Scene not found: "${locator}"`);

      const update: any = {};
      if (data.name && typeof data.name === 'string' && data.name.trim()) {
        update.name = data.name.trim();
      }
      if (data.background) update.background = { src: data.background };
      const grid = this._gridUpdatePayload(data.grid);
      if (grid) update.grid = grid;
      if (data.flags && typeof data.flags === 'object') {
        // Merge-safe: set flags.<namespace>.<key> individually so a partial flags object never
        // clobbers sibling keys already stored under the same namespace (e.g. another module's
        // flags, or other keys under flags.aidm the caller did not mention this call).
        for (const [ns, nsVal] of Object.entries(data.flags)) {
          if (nsVal && typeof nsVal === 'object' && !Array.isArray(nsVal)) {
            for (const [k, v] of Object.entries(nsVal as any)) {
              update[`flags.${ns}.${k}`] = v;
            }
          } else {
            update[`flags.${ns}`] = nsVal;
          }
        }
      }

      // Phase E: fog-of-war / vision fields, dotted-path so a partial payload never clobbers
      // sibling keys under scene.environment or scene.fog it did not mention.
      if (data.tokenVision !== undefined) update.tokenVision = data.tokenVision;
      if (data.environment && typeof data.environment === 'object') {
        const env = data.environment;
        if (env.darknessLevel !== undefined)
          update['environment.darknessLevel'] = env.darknessLevel;
        if (env.darknessLevelLock !== undefined)
          update['environment.darknessLevelLock'] = env.darknessLevelLock;
        if (env.cycle !== undefined) update['environment.cycle'] = env.cycle;
        if (env.globalLight && typeof env.globalLight === 'object') {
          for (const [k, v] of Object.entries(env.globalLight)) {
            update[`environment.globalLight.${k}`] = v;
          }
        }
      }
      if (data.fog && typeof data.fog === 'object') {
        const fog = data.fog;
        if (fog.exploration !== undefined) update['fog.exploration'] = fog.exploration;
        if (fog.overlay !== undefined) update['fog.overlay'] = fog.overlay;
        if (fog.reset !== undefined) update['fog.reset'] = fog.reset;
        if (fog.colors && typeof fog.colors === 'object') {
          for (const [k, v] of Object.entries(fog.colors)) {
            update[`fog.colors.${k}`] = v;
          }
        }
      }

      if (Object.keys(update).length === 0) {
        throw new Error(
          'No fields to update: provide name, background, grid, flags, tokenVision, environment, and/or fog'
        );
      }

      await scene.update(update);
      return { success: true, id: scene.id, name: scene.name };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e) };
    }
  }

  private async handleListInstalledPackages(_data: any): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      const packages: any[] = [];
      const packs: any[] = Array.from((game as any).packs?.values?.() || []);
      for (const pack of packs) {
        const meta = pack.metadata || {};
        try {
          if (meta.type === 'Adventure') {
            const index = await pack.getIndex({ fields: ['name'] });
            for (const entry of index) {
              try {
                const adv: any = await pack.getDocument(entry._id);
                const sceneList = (adv?.scenes?.contents || adv?.scenes || []) as any[];
                const scenes = sceneList.map((s: any) => ({
                  name: s.name,
                  ref: `${pack.collection}.${entry._id}.${s._id || s.id}`,
                }));
                packages.push({
                  id: `${pack.collection}:${entry._id}`,
                  name: entry.name || adv?.name || meta.label || pack.collection,
                  scenes,
                });
              } catch (innerErr) {
                // one bad Adventure document must not fail the whole listing
                continue;
              }
            }
          } else if (meta.type === 'Scene') {
            const index = await pack.getIndex({ fields: ['name'] });
            const scenes = (index as any[]).map((entry: any) => ({
              name: entry.name,
              ref: `${pack.collection}.${entry._id}`,
            }));
            if (scenes.length) {
              packages.push({ id: pack.collection, name: meta.label || pack.collection, scenes });
            }
          }
        } catch (packErr) {
          // one unreadable pack must not fail the whole listing
          continue;
        }
      }
      return { success: true, packages };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e), packages: [] };
    }
  }

  // ---- adventure-import v2 (board #1311 root-cause fix, generic by construction). ----
  //
  // What was wrong (proven on the Death House sample, but the defect is generic): the old code
  // called adv.prepareImport({documentTypes:['Scene']}) and then FILTERED toCreate.Scene down to
  // just the one requested scene id before calling importContent(). Two consequences, for ANY
  // adventure, not just this one: (1) sibling scenes in the same Adventure entry never get
  // created, so any reference inside the imported scene that points at a sibling (a region
  // behavior's teleport destination, at least) dangles forever; (2) Actors were never imported at
  // all (documentTypes was hardcoded to ['Scene']), and nothing looked past the one Adventure
  // entry that was asked for, so a module that ships its tokens' actors in a *different* Adventure
  // entry (a shared "core resources" style entry) left every token with no world actor.
  //
  // The fix, in three parts, none of which name a specific module or adventure:
  //  A. Import the WHOLE Adventure entry's Scene set in one prepareImport/importContent batch
  //     (never filtered), so whatever id/consistency handling Foundry does across that batch
  //     actually runs. Every created/matched scene is tagged flags.aidm.{sourcePack,
  //     sourceSceneId,adoptedFor} so a later call can find it (idempotent: see _findAdoptedScene).
  //  B. After import, walk every touched scene's regions[].behaviors[] for ANY string field that
  //     looks like a document UUID rooted at "Scene.<16-char-id>" (not just a hardcoded
  //     "destination" key -- see _walkForSceneUuids) and resolve it with Foundry's own
  //     fromUuidSync, so a brand-new behavior type with its own uuid-bearing field is still
  //     checked without this code needing to know its name.
  //  C. Collect every actorId referenced by a token on the imported scenes, diff against
  //     game.actors, and for anything still missing search every Adventure document in every pack
  //     belonging to the same module OR any module listed in that module's OWN manifest
  //     relationships.requires (read live off game.modules.get(id) -- never a hardcoded id) and
  //     import matches with keepId:true.
  // success is false whenever anything above is still unresolved, with error naming what -- this
  // handler must fail loudly rather than report success on a partially-broken import.
  //
  // CORRECTION, board #1714: point (2) above is wrong about why. Foundry 13.351 never read the
  // `documentTypes` option, so that call imported EVERY document type in the Adventure entry and
  // replaced any same-id world document. The Death House entry simply ships no actors (they live
  // in a different entry), which is why its tokens had none. Since #1714 the import really is
  // Scene-only, never overwrites, and creates missing actors (C) only when the caller passes
  // import_missing_actors:true. See _importAdventureScene and adventure-import-utils.ts.

  // Walks regions[].behaviors[] on every given scene and resolves every Scene-rooted uuid found
  // in a behavior's data via Foundry's own fromUuidSync -- this is what makes "Scene.<id>.Region.
  // <id>" validation generic: fromUuidSync itself does scene.regions.get(regionId) internally, so
  // this code never has to parse or assume the uuid's internal shape.
  private async _resolveSceneRefs(
    scenes: any[]
  ): Promise<
    { scene_id: string; region_id: string | null; behavior_id: string | null; target: string }[]
  > {
    const unresolved: {
      scene_id: string;
      region_id: string | null;
      behavior_id: string | null;
      target: string;
    }[] = [];
    const fromUuidSyncFn: any = (globalThis as any).fromUuidSync;
    for (const scene of scenes || []) {
      const regions: any[] = Array.from((scene?.regions as any) ?? []);
      for (const region of regions) {
        const behaviors: any[] = Array.from((region?.behaviors as any) ?? []);
        for (const behavior of behaviors) {
          let data: any;
          try {
            data = behavior.toObject ? behavior.toObject() : behavior;
          } catch (e) {
            data = behavior;
          }
          const found: { path: string; value: string }[] = [];
          walkForSceneUuids(data, 'behavior', new Set(), found);
          for (const f of found) {
            let resolved: any = null;
            try {
              resolved = fromUuidSyncFn ? fromUuidSyncFn(f.value) : null;
            } catch (e) {
              resolved = null;
            }
            if (!resolved) {
              unresolved.push({
                scene_id: scene.id,
                region_id: region?.id ?? null,
                behavior_id: behavior?.id ?? null,
                target: f.value,
              });
            }
          }
        }
      }
    }
    return unresolved;
  }

  private _missingActorIds(scenes: any[]): string[] {
    const needed = new Set<string>();
    for (const scene of scenes || []) {
      const tokens: any[] = Array.from((scene?.tokens as any) ?? []);
      for (const t of tokens) {
        const actorId = t?.actorId || t?.actor?.id;
        if (actorId) needed.add(actorId);
      }
    }
    // Board #1714 review: an actor whose stored data failed Foundry's validation is left out of
    // game.actors (DocumentCollection#_initialize, foundry.mjs lines 23909-23925) but still exists
    // in the database. It is NOT missing: treating it as missing would make adventure-import
    // create it with keepId, and the 13.351 server silently replaces a top-level record with the
    // same id. So invalid ids count as present here; _invalidActorIds reports them separately.
    // invalidDocumentIds is only filled when this client loads the world, so this is only as fresh
    // as the last page load of the GM client.
    return Array.from(needed).filter(id => !collectionHasId((game as any).actors, id));
  }

  // Board #1714 review 2: token actor ids that point at a stored actor Foundry could not load
  // (game.actors.invalidDocumentIds). They are not "missing" (see _missingActorIds) and are never
  // created over, but the token still has no usable actor, so they are reported separately under
  // invalid_actor_ids. They do not make the call fail.
  private _invalidActorIds(scenes: any[]): string[] {
    const invalid: any = (game as any).actors?.invalidDocumentIds;
    const out = new Set<string>();
    for (const scene of scenes || []) {
      const tokens: any[] = Array.from(scene?.tokens ?? []);
      for (const t of tokens) {
        const actorId = t?.actorId || t?.actor?.id;
        if (actorId && invalid?.has?.(actorId) && !(game as any).actors?.get(actorId)) {
          out.add(actorId);
        }
      }
    }
    return Array.from(out);
  }

  // Board #1714 review 2: a create call can fail AFTER the server saved the document. The 13.351
  // server writes the batch first and runs _onCreate afterwards (dist/database/backend/
  // server-backend.mjs _createDocuments), and the client adds the document to its collection before
  // running its own _onCreate (foundry.mjs lines 58658-58668, #handleCreateDocuments). So after a
  // failed create this checks, for an id that was free just before: is it now in this client's
  // collection ("client"), or saved on the server only because the server-side failure stopped the
  // broadcast ("server-only", found with a read-only database get)? Either way the caller must track
  // it for rollback. Returns null when it cannot find it.
  private async _savedAfterFailedCreate(
    cls: any,
    collection: any,
    id: string
  ): Promise<'client' | 'server-only' | null> {
    if (collectionHasId(collection, id)) return 'client';
    try {
      const impl = cls?.implementation ?? cls;
      const found = await impl?.database?.get?.(impl, { query: { _id: id } }, (game as any).user);
      if (Array.isArray(found) && found.length) return 'server-only';
    } catch (e) {
      // cannot tell; report nothing rather than guess
    }
    return null;
  }

  // Pushes a document found by _savedAfterFailedCreate onto the rollback list.
  private _trackSavedAfterFailure(
    tracker: CreatedDocRef[],
    type: string,
    id: string,
    where: 'client' | 'server-only' | null
  ): void {
    if (!where || tracker.some(d => d.type === type && d.id === id)) return;
    tracker.push(where === 'client' ? { type, id } : { type, id, loadedInClient: false });
  }

  // Searches every Adventure document in every pack in scope for actors matching the still-
  // missing ids and imports matches with keepId:true so token.actorId keeps pointing at them.
  // Each actor it creates is pushed onto `tracker` the moment it exists, so a later failure
  // anywhere in the call can still roll it back.
  private async _resolveActors(
    scenes: any[],
    primaryPack: any,
    tracker: CreatedDocRef[]
  ): Promise<{ importedActorIds: string[]; unresolvedActorIds: string[] }> {
    const missing = this._missingActorIds(scenes);
    if (!missing.length) return { importedActorIds: [], unresolvedActorIds: [] };

    // Generic search scope: the module that owns the pack we imported from, plus every module
    // that module's OWN manifest declares under relationships.requires. This is how a module
    // that ships its shared actors in a separate "requires" module (or a separate Adventure
    // entry in its own pack) still resolves, without this code ever naming that module.
    const scope = moduleSearchScope(primaryPack, id => (game as any).modules?.get(id));
    const advPacks: any[] = [];
    const packs: any[] = Array.from((game as any).packs?.values?.() || []);
    for (const pack of packs) {
      if (pack?.metadata?.type !== 'Adventure') continue;
      const owner = packModuleId(pack);
      if (owner && scope.has(owner)) advPacks.push(pack);
    }
    if (primaryPack && !advPacks.includes(primaryPack)) advPacks.push(primaryPack);

    const stillMissing = new Set(missing);
    const importedActorIds: string[] = [];
    const ActorCls: any = (globalThis as any).Actor;
    for (const pack of advPacks) {
      if (!stillMissing.size) break;
      let index: any[];
      try {
        index = Array.from((await pack.getIndex({ fields: ['name'] })) ?? []);
      } catch (e) {
        continue;
      }
      for (const entry of index) {
        if (!stillMissing.size) break;
        let adv: any;
        try {
          adv = await pack.getDocument(entry._id);
        } catch (e) {
          continue;
        }
        const actorList: any[] = Array.from((adv?.actors as any) ?? []);
        for (const a of actorList) {
          const srcId = a?._id || a?.id;
          if (!srcId || !stillMissing.has(srcId)) continue;
          // Board #1714: create-only. Re-check right before writing so an actor that exists in
          // the world (valid, or stored but invalid) is never overwritten, even if it appeared
          // after the missing list was built.
          if (collectionHasId((game as any).actors, srcId)) {
            stillMissing.delete(srcId);
            continue;
          }
          try {
            const actorData = JSON.parse(JSON.stringify(a.toObject ? a.toObject() : a));
            // Folders are never imported (board #1714), so drop a folder id the world lacks.
            if (actorData.folder && !(game as any).folders?.get(actorData.folder)) {
              actorData.folder = null;
            }
            const created = ActorCls?.implementation
              ? await ActorCls.implementation.createDocuments([actorData], { keepId: true })
              : await ActorCls.createDocuments([actorData], { keepId: true });
            if (created && created.length) {
              tracker.push({ type: 'Actor', id: srcId });
              importedActorIds.push(srcId);
              stillMissing.delete(srcId);
            }
          } catch (actorErr) {
            // Board #1714 review 2: the create may have failed after the actor was saved. It was
            // not in the world just above, so if it exists now this call made it: track it so
            // rollback removes it. It stays in stillMissing, so the call reports failure.
            this._trackSavedAfterFailure(
              tracker,
              'Actor',
              srcId,
              await this._savedAfterFailedCreate(ActorCls, (game as any).actors, srcId)
            );
          }
        }
      }
    }
    return { importedActorIds, unresolvedActorIds: Array.from(stillMissing) };
  }

  private _emptyAdventureImportResult(error: string): any {
    return {
      success: false,
      scene_id: null,
      scene_name: null,
      reused: false,
      imported: { scenes: [], actors: [] },
      unresolved: { scene_refs: [], actor_ids: [] },
      error,
    };
  }

  // Idempotency lookup: a world scene already tagged as having come from this exact pack+source
  // scene id. Used both to short-circuit a repeat request for the same scene, and to let a later
  // request for a SIBLING scene (already created and tagged by an earlier adventure-import call
  // for a different scene in the same Adventure entry) bind to it without re-importing anything.
  // Board #1714: returns EVERY tagged match, so a caller can refuse when more than one world scene
  // claims the same source instead of silently picking the first. Scenes adopted before the tags
  // were written carry no tags and are not found here; adventure-source-backfill tags them.
  private _findAdoptedScenes(sourcePack: string, sourceSceneId: string): any[] {
    return findAdoptedScenes(
      Array.from(((game as any).scenes as any) ?? []),
      sourcePack,
      sourceSceneId
    );
  }

  // Refusal reply when more than one world scene is tagged as adopted from the same source.
  private _ambiguousAdoptionResult(sourcePack: string, sourceSceneId: string, found: any[]): any {
    return this._conflictResult([
      {
        scene_id: sourceSceneId,
        scene_name: found[0]?.name ?? null,
        reason: 'ambiguous-adopted-copies',
        tagged_source: { sourcePack, sourceSceneId },
        world_scene_ids: found.map((s: any) => s.id),
      },
    ]);
  }

  // Deletes every document in `created` in REVERSE order of creation (board #1311): when
  // adventure-import is about to report success:false, it is the only party that knows precisely
  // which documents it made during THIS call, so it is the one responsible for leaving nothing
  // half-imported behind for a user to clean up by hand. Never touches a reused/already-adopted
  // document -- `created` only ever holds ids this same call actually created (see
  // _importAdventureScene / _importStandaloneScene / _resolveActors), never anything found via
  // _findAdoptedScene. One document at a time, each independently try/caught, so a failure
  // deleting one document never stops the rest from being attempted, and every outcome -- deleted
  // or not -- is reported by id rather than collapsed into a single pass/fail flag.
  private async _rollbackCreatedDocuments(created: CreatedDocRef[]): Promise<CleanupReport> {
    const attempts: { type: string; id: string; ok: boolean; error?: string }[] = [];
    for (const doc of created.slice().reverse()) {
      try {
        const Cls: any = (globalThis as any)[doc.type];
        if (!Cls) {
          throw new Error(`No document class "${doc.type}" available to delete it with`);
        }
        const impl = Cls.implementation ?? Cls;
        await impl.deleteDocuments([doc.id]);
        attempts.push({ type: doc.type, id: doc.id, ok: true });
      } catch (e: any) {
        const reason = String((e && (e.stack || e.message)) || e);
        attempts.push({
          type: doc.type,
          id: doc.id,
          ok: false,
          error:
            doc.loadedInClient === false
              ? `saved on the Foundry server but never loaded in this client (its create call failed), ` +
                `so it cannot be deleted from here: reload the world and delete it by hand. ${reason}`
              : reason,
        });
      }
    }
    return summarizeCleanup(attempts);
  }

  // Board #1714 review: every document this call creates is pushed onto one `tracker` list the
  // moment it exists (scenes from importContent or Scene.create, actors from _resolveActors). The
  // whole import runs inside this guard, so if ANY step throws after a create, exactly what is on
  // that list is rolled back (0008's all-or-nothing rule), whichever path or step threw.
  private async _runTrackedImport(run: (tracker: CreatedDocRef[]) => Promise<any>): Promise<any> {
    const tracker: CreatedDocRef[] = [];
    try {
      return await run(tracker);
    } catch (e: any) {
      const result: any = this._emptyAdventureImportResult(
        `adventure-import failed: ${String(e?.stack ?? e?.message ?? e)}`
      );
      if (tracker.length) {
        result.imported = {
          scenes: tracker.filter(d => d.type === 'Scene').map(d => d.id),
          actors: tracker.filter(d => d.type === 'Actor').map(d => d.id),
        };
        result.cleanup = await this._rollbackCreatedDocuments(tracker.splice(0));
      }
      return result;
    }
  }

  private async _finalizeAdventureImportResult(opts: {
    targetScene: any;
    allScenes: any[];
    reused: boolean;
    importedSceneIds: string[];
    pack: any;
    tracker: CreatedDocRef[];
    importMissingActors: boolean;
  }): Promise<any> {
    const unresolvedSceneRefs = await this._resolveSceneRefs(opts.allScenes);
    // Board #1714: creating actors is opt-in. By default adventure-import creates Scene documents
    // only, so missing actors are reported as unresolved (and anything created is rolled back)
    // instead of being created. With import_missing_actors:true, _resolveActors creates only the
    // actors whose ids are not in the world at all (not even as an invalid stored record); it never
    // updates an existing actor. Note: that also means it re-creates an actor the DM deleted on
    // purpose, if a token still points at it.
    const actorResult = opts.importMissingActors
      ? await this._resolveActors(opts.allScenes, opts.pack, opts.tracker)
      : {
          importedActorIds: [] as string[],
          unresolvedActorIds: this._missingActorIds(opts.allScenes),
        };
    const success = unresolvedSceneRefs.length === 0 && actorResult.unresolvedActorIds.length === 0;
    let error = summarizeUnresolved(unresolvedSceneRefs, actorResult.unresolvedActorIds);
    if (error && actorResult.unresolvedActorIds.length && !opts.importMissingActors) {
      error = `${error} | ${MISSING_ACTORS_HINT}`;
    }
    const result: any = {
      success,
      scene_id: opts.targetScene.id,
      scene_name: opts.targetScene.name,
      reused: opts.reused,
      imported: { scenes: opts.importedSceneIds, actors: actorResult.importedActorIds },
      unresolved: { scene_refs: unresolvedSceneRefs, actor_ids: actorResult.unresolvedActorIds },
      invalid_actor_ids: this._invalidActorIds(opts.allScenes),
      error,
    };
    // splice(0) empties the tracker, so the outer guard can never delete the same documents twice.
    if (!success && opts.tracker.length) {
      result.cleanup = await this._rollbackCreatedDocuments(opts.tracker.splice(0));
    }
    return result;
  }

  // Refusal reply for a plan with conflicts: nothing was written.
  private _conflictResult(conflicts: SceneImportConflict[]): any {
    return {
      ...this._emptyAdventureImportResult(summarizeSceneConflicts(conflicts)),
      conflicts,
    };
  }

  // Single-scene path (3-part ref from a Scene compendium pack). It creates the scene under a NEW
  // random id that is checked to be free first, so it does not overwrite by id. Board #1714 review: it still refuses when a world scene (valid or
  // invalid) already holds the pack scene's id without matching tags, because that is an earlier
  // adoption made with the same id and importing again would duplicate it. Known limit: an earlier
  // adoption made under a different id WITHOUT source tags cannot be recognised here, so this path
  // can still duplicate it; adventure-source-backfill only handles Adventure packs.
  private async _importStandaloneScene(
    parts: string[],
    importMissingActors: boolean,
    tracker: CreatedDocRef[]
  ): Promise<any> {
    const [packType, packName, sceneId] = parts;
    const packCollection = `${packType}.${packName}`;
    const pack: any = (game as any).packs?.get(packCollection);
    if (!pack) return this._emptyAdventureImportResult(`Pack not found: ${packCollection}`);

    const found = this._findAdoptedScenes(packCollection, sceneId);
    if (found.length > 1) return this._ambiguousAdoptionResult(packCollection, sceneId, found);
    if (found.length === 1) {
      return await this._finalizeAdventureImportResult({
        targetScene: found[0],
        allScenes: [found[0]],
        reused: true,
        importedSceneIds: [],
        pack,
        tracker,
        importMissingActors,
      });
    }

    const sourceScene: any = await pack.getDocument(sceneId);
    if (!sourceScene)
      return this._emptyAdventureImportResult(`Scene not found in pack: ${sceneId}`);

    const worldCollection: any = (game as any).scenes;
    const check = planAdventureSceneImport({
      packCollection,
      targetSceneId: sceneId,
      preparedScenes: [{ _id: sceneId, name: sourceScene.name ?? null }],
      getWorldScene: id => worldCollection?.get(id),
      worldScenes: Array.from(worldCollection ?? []),
      folderExists: () => true,
      isInvalidId: id => !!worldCollection?.invalidDocumentIds?.has?.(id),
    });
    if (check.conflicts.length) return this._conflictResult(check.conflicts);

    const SceneCls: any = (globalThis as any).Scene;
    if (!SceneCls?.create)
      return this._emptyAdventureImportResult('Scene document class unavailable');
    const sceneObj: any = sourceScene.toObject();
    sceneObj.flags = sceneObj.flags || {};
    sceneObj.flags.aidm = {
      ...(sceneObj.flags.aidm || {}),
      sourcePack: packCollection,
      sourceSceneId: sceneId,
      adoptedFor: sceneId,
    };
    // Folders are never imported (board #1714), so drop a folder id the world does not have.
    if (sceneObj.folder && !(game as any).folders?.get(sceneObj.folder)) sceneObj.folder = null;
    // Board #1714 review 2: pick the new id here (a fresh random id that is free in this client,
    // valid or invalid) and create with keepId, so that if the create call fails after the server
    // saved the scene, this call still knows which id to look for and roll back.
    const randomID: () => string = (globalThis as any).foundry?.utils?.randomID;
    if (typeof randomID !== 'function') {
      return this._emptyAdventureImportResult('foundry.utils.randomID unavailable');
    }
    let newId = randomID();
    for (let i = 0; i < 5 && collectionHasId(worldCollection, newId); i++) newId = randomID();
    if (collectionHasId(worldCollection, newId)) {
      return this._emptyAdventureImportResult('Could not pick a free scene id');
    }
    sceneObj._id = newId;
    let created: any;
    try {
      created = await SceneCls.create(sceneObj, { keepId: true });
    } catch (e) {
      this._trackSavedAfterFailure(
        tracker,
        'Scene',
        newId,
        await this._savedAfterFailedCreate(SceneCls, worldCollection, newId)
      );
      throw e;
    }
    if (!created) return this._emptyAdventureImportResult('Scene.create returned no document');
    tracker.push({ type: 'Scene', id: created.id });
    return await this._finalizeAdventureImportResult({
      targetScene: created,
      allScenes: [created],
      reused: false,
      importedSceneIds: [sceneId],
      pack,
      tracker,
      importMissingActors,
    });
  }

  // Board #1714 rewrite of the Adventure-document path. Rules, each enforced before any write:
  //  1. Scenes only. prepareImport gets importFields:['scenes'] (the option Foundry 13.351 really
  //     reads, see sceneOnlyImportOptions), and the prepared data is checked: if it holds any other
  //     document type, the call is refused and nothing is written.
  //  2. Never overwrite. Every scene the Adventure entry would import is planned with
  //     planAdventureSceneImport: an id already used by a world scene is REUSED only when that
  //     scene carries matching source tags; an id used by an untagged scene, a scene tagged from
  //     elsewhere, or a stored-but-invalid scene is REFUSED with a plain error naming it, and
  //     nothing is written. importContent is then called with a toCreate that holds only new
  //     scenes and an EMPTY toUpdate, so its update loop (foundry.mjs lines 42019-42031) has
  //     nothing to run.
  //  3. Always tagged. Each created scene carries flags.aidm.sourcePack / sourceSceneId /
  //     adoptedFor inside its create data, so the next call can find and reuse it.
  // The whole Adventure entry's scene set is still handled in one batch (the board #1311 fix for
  // sibling scenes), and rollback still deletes, on failure, only what this call created.
  private async _importAdventureScene(
    parts: string[],
    importMissingActors: boolean,
    tracker: CreatedDocRef[]
  ): Promise<any> {
    const [packType, packName, advId, sceneId] = parts;
    const packCollection = `${packType}.${packName}`;

    // Fast path: this exact scene was already adopted by an earlier call (either as the primary
    // target or as a sibling pulled in alongside one) -- return it, touch no scene in Foundry.
    const found = this._findAdoptedScenes(packCollection, sceneId);
    if (found.length > 1) return this._ambiguousAdoptionResult(packCollection, sceneId, found);
    if (found.length === 1) {
      const pack: any = (game as any).packs?.get(packCollection);
      return await this._finalizeAdventureImportResult({
        targetScene: found[0],
        allScenes: [found[0]],
        reused: true,
        importedSceneIds: [],
        pack,
        tracker,
        importMissingActors,
      });
    }

    const pack: any = (game as any).packs?.get(packCollection);
    if (!pack) return this._emptyAdventureImportResult(`Pack not found: ${packCollection}`);
    const adv: any = await pack.getDocument(advId);
    if (!adv) return this._emptyAdventureImportResult(`Adventure not found: ${advId}`);

    if (!(typeof adv.prepareImport === 'function' && typeof adv.importContent === 'function')) {
      // Board #1714: the old fallback here called adv.import(), which imports every document type
      // in the Adventure and overwrites same-id world documents. It is gone on purpose.
      return this._emptyAdventureImportResult(
        'Refused: this Foundry version has no Adventure prepareImport/importContent, and ' +
          'adventure-import will not fall back to Adventure import(), because that imports every ' +
          'document type and can overwrite existing world documents. Nothing was imported.'
      );
    }

    const toImport = await adv.prepareImport(sceneOnlyImportOptions());
    const otherTypes = nonSceneDocumentNames(toImport);
    if (otherTypes.length) {
      return this._emptyAdventureImportResult(
        `Refused: asked Foundry to prepare scenes only, but it also prepared ${otherTypes.join(', ')} ` +
          'documents. This Foundry version may not honour the importFields option. Nothing was imported.'
      );
    }
    const preparedScenes: any[] = [
      ...(toImport?.toCreate?.Scene ?? []),
      ...(toImport?.toUpdate?.Scene ?? []),
    ];
    if (!preparedScenes.some((s: any) => (s?._id || s?.id) === sceneId)) {
      return this._emptyAdventureImportResult(
        `Scene ${sceneId} not found in Adventure ${advId}'s scene set`
      );
    }

    const worldCollection: any = (game as any).scenes;
    const plan = planAdventureSceneImport({
      packCollection,
      targetSceneId: sceneId,
      preparedScenes,
      getWorldScene: id => worldCollection?.get(id),
      worldScenes: Array.from(worldCollection ?? []),
      folderExists: id => collectionHasId((game as any).folders, id),
      isInvalidId: id => !!worldCollection?.invalidDocumentIds?.has?.(id),
    });
    if (plan.conflicts.length) return this._conflictResult(plan.conflicts);

    // importContent's own AdventureImportResult ({created, updated}, each Record<documentName,
    // Document[]> -- foundry.documents.types.AdventureImportResult) is this call's OWN record of
    // exactly what it made. If importContent throws after its create step instead, a planned id
    // that now exists (in this client, or saved on the server only) is taken to be this call's: each
    // one was free (not even an invalid stored record) when planned, and the write lock keeps other
    // adventure-import calls IN THIS CLIENT out. It does not stop another GM client creating the same
    // id at the same moment (Scene#_preCreate awaits a thumbnail first, foundry.mjs lines
    // 46391-46406); in that rare case rollback could delete that other client's scene.
    if (plan.create.length) {
      let importResult: any;
      try {
        importResult = await adv.importContent({
          toCreate: { Scene: plan.create },
          toUpdate: {},
          documentCount: plan.create.length,
        });
      } catch (e) {
        for (const data of plan.create) {
          this._trackSavedAfterFailure(
            tracker,
            'Scene',
            data._id,
            await this._savedAfterFailedCreate((globalThis as any).Scene, worldCollection, data._id)
          );
        }
        throw e;
      }
      tracker.push(...collectCreatedDocuments(importResult?.created));
    }

    // Tag fix-up and the scene list work only from what this call actually created (the tracker),
    // never from the plan, so no scene that existed before this call can be touched here.
    const createdSceneIds = tracker.filter(d => d.type === 'Scene').map(d => d.id);
    const worldScenes: any[] = [];
    const importedSceneIds: string[] = [];
    let targetScene: any = null;
    for (const id of createdSceneIds) {
      const ws = worldCollection?.get(id);
      if (!ws) continue; // not in the client collection -- surfaces as a dangling reference if needed
      worldScenes.push(ws);
      importedSceneIds.push(id);
      if (id === sceneId) targetScene = ws;
      // The tags were in the create data. Only if Foundry dropped them, write them onto this
      // newly created scene.
      if (!isAdoptedFrom(ws, packCollection, id)) {
        await ws.update(
          aidmTagUpdatePayload({
            sourcePack: packCollection,
            sourceSceneId: id,
            adoptedFor: sceneId,
          })
        );
      }
    }
    for (const r of plan.reuse) {
      const ws = worldCollection?.get(r.world_scene_id);
      if (!ws) continue;
      worldScenes.push(ws);
      if (r.source_scene_id === sceneId) targetScene = ws;
    }

    if (!targetScene) {
      throw new Error(
        `Adventure import ran but the requested scene ${sceneId} could not be located afterward`
      );
    }

    return await this._finalizeAdventureImportResult({
      targetScene,
      allScenes: worldScenes,
      reused: false,
      importedSceneIds,
      pack,
      tracker,
      importMissingActors,
    });
  }

  private async handleAdventureImport(data: {
    package?: string;
    scene_ref?: string;
    import_missing_actors?: boolean;
  }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    // One import (or back-fill apply) at a time in this client, so planning and writing cannot
    // interleave with another call (board #1714 review).
    return await adventureWriteLock(() =>
      this._runTrackedImport(async tracker => {
        if (!data?.scene_ref) throw new Error('scene_ref is required');
        const importMissingActors = data?.import_missing_actors === true;
        const parts = String(data.scene_ref).split('.');
        if (parts.length === 3) {
          return await this._importStandaloneScene(parts, importMissingActors, tracker);
        }
        if (parts.length === 4) {
          return await this._importAdventureScene(parts, importMissingActors, tracker);
        }
        throw new Error(`Unrecognized scene_ref shape: "${data.scene_ref}"`);
      })
    );
  }

  // ---- adventure-source-backfill (board #1714). ----
  // Finds world scenes that came from a scene in one installed Adventure pack but carry no
  // flags.aidm source tags (scenes adopted before the tags were reliable), and tags them so
  // adventure-import can reuse them instead of refusing. DRY RUN BY DEFAULT: without apply:true it
  // only reads and reports. apply:true also needs the plan_id from a dry run of the same request,
  // and the plan is rebuilt from live state and must still produce that same plan_id, so apply can
  // only ever write exactly what a dry run showed. It writes only flags.aidm keys, which does not
  // redraw the canvas even on the active scene (Scene#_onUpdate redraw list, foundry.mjs lines
  // 46626-46632). The matching rule lives in adventure-source-backfill-utils.ts.
  private async handleAdventureSourceBackfill(data: {
    pack?: string;
    package?: string;
    scene_ids?: string[];
    apply?: boolean;
    plan_id?: string;
  }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    const apply = data?.apply === true;
    const mode = apply ? 'apply' : 'dry-run';
    try {
      const packs: any[] = Array.from((game as any).packs?.values?.() || []);
      const adventurePacks = packs
        .filter((p: any) => p?.metadata?.type === 'Adventure')
        .map((p: any) => p.collection);
      const parsed = parsePackArg(data?.pack ?? data?.package);
      if (!parsed) {
        return {
          success: false,
          mode,
          changed: false,
          adventure_packs: adventurePacks,
          error:
            'pack is required (an Adventure pack id such as "module.PackName"). ' +
            `Installed Adventure packs: ${adventurePacks.join(', ') || 'none'}.`,
        };
      }
      const pack: any = (game as any).packs?.get(parsed.pack);
      if (!pack || pack?.metadata?.type !== 'Adventure') {
        return {
          success: false,
          mode,
          changed: false,
          adventure_packs: adventurePacks,
          error:
            `No installed Adventure pack "${parsed.pack}". ` +
            `Installed Adventure packs: ${adventurePacks.join(', ') || 'none'}.`,
        };
      }

      // With an Adventure id, load only that entry (one small round trip). Without one, load the
      // whole pack in one getDocuments round trip instead of one getDocument call per entry (the
      // pattern that makes list-installed-packages slow). The Curse of Strahd pack is about 17 MB of
      // JSON across 21 entries, so naming the entry is the faster, safer call.
      let advDocs: any[];
      if (parsed.adventureId) {
        const one: any = await pack.getDocument(parsed.adventureId);
        if (!one) {
          return {
            success: false,
            mode,
            changed: false,
            error: `No Adventure "${parsed.adventureId}" in pack "${parsed.pack}". Nothing was changed.`,
          };
        }
        advDocs = [one];
      } else {
        advDocs = Array.from((await pack.getDocuments()) ?? []);
      }
      const packScenes: BackfillPackScene[] = [];
      for (const adv of advDocs) {
        const obj: any = adv?.toObject ? adv.toObject() : adv;
        const advId: string = adv?.id ?? obj?._id;
        if (parsed.adventureId && advId !== parsed.adventureId) continue;
        for (const s of obj?.scenes ?? []) {
          if (!s?._id) continue;
          packScenes.push({
            adventure_id: advId,
            adventure_name: obj?.name ?? null,
            scene_id: s._id,
            name: s.name ?? null,
            background: s.background?.src ?? s.img ?? null,
          });
        }
      }

      const onlySceneIds = Array.isArray(data?.scene_ids) ? data.scene_ids.map(String) : null;
      const scope = {
        adventure_id: parsed.adventureId,
        scene_ids: onlySceneIds,
      };
      // Reads the world fresh each time it is called, so apply plans inside the write lock.
      const buildPlan = () => {
        const worldCollection: any = (game as any).scenes;
        const worldScenes: BackfillWorldScene[] = Array.from(worldCollection ?? []).map(
          (s: any) => {
            const sourcePack = readAidmFlag(s, 'sourcePack');
            const sourceSceneId = readAidmFlag(s, 'sourceSceneId');
            return {
              id: s.id,
              name: s.name ?? null,
              background: s.background?.src ?? null,
              active: !!s.active,
              token_count: Number(s.tokens?.size ?? 0),
              duplicate_source: s._stats?.duplicateSource ?? null,
              tags:
                sourcePack || sourceSceneId
                  ? { sourcePack: sourcePack ?? null, sourceSceneId: sourceSceneId ?? null }
                  : null,
            };
          }
        );
        return planSourceTagBackfill({
          pack: parsed.pack,
          packScenes,
          worldScenes,
          onlySceneIds,
          partialPack: !!parsed.adventureId,
          invalidWorldIds: Array.from(worldCollection?.invalidDocumentIds ?? []).map(String),
        });
      };

      if (!apply) {
        const plan = buildPlan();
        return {
          success: true,
          mode,
          changed: false,
          scope,
          ...plan,
          next_step: plan.will_tag.length
            ? `Dry run only: nothing was changed. To write the ${plan.will_tag.length} tag set(s) ` +
              'listed under will_tag, call again with the same pack and scene_ids, plus ' +
              `apply: true and plan_id: "${plan.plan_id}".`
            : 'Dry run only: nothing was changed, and there is nothing to tag.',
        };
      }

      // Apply: plan and write inside the same lock adventure-import uses, so nothing can change the
      // world between this plan and these writes from this client.
      return await adventureWriteLock(async () => {
        const plan = buildPlan();
        if (!data?.plan_id || data.plan_id !== plan.plan_id) {
          // Board #1714 review: never echo the live plan_id or the plan here. Otherwise a caller
          // could skip the dry run by calling apply twice.
          return {
            success: false,
            mode,
            changed: false,
            summary: plan.summary,
            error:
              'Refused: apply needs the plan_id returned by a dry run of this same request, and the ' +
              'plan_id given does not match the plan built from the world now. Either no dry run ' +
              'was run, or the world or the request changed since it ran. Nothing was changed. Run ' +
              'the dry run again, check its will_tag list, then apply with the plan_id it returns.',
          };
        }

        const tagged: string[] = [];
        const failed: { scene_id: string; error: string }[] = [];
        for (const entry of plan.will_tag) {
          try {
            const scene: any = (game as any).scenes?.get(entry.scene_id);
            if (!scene) throw new Error('the scene no longer exists');
            if (readAidmFlag(scene, 'sourcePack') || readAidmFlag(scene, 'sourceSceneId')) {
              throw new Error('the scene gained source tags after planning; left unchanged');
            }
            await scene.update(backfillUpdatePayload(entry));
            tagged.push(entry.scene_id);
          } catch (err: any) {
            failed.push({ scene_id: entry.scene_id, error: String(err?.message ?? err) });
          }
        }
        const result: any = {
          success: failed.length === 0,
          mode,
          changed: tagged.length > 0,
          scope,
          ...plan,
          applied: { tagged, failed },
        };
        if (failed.length) {
          result.error = `Tagged ${tagged.length} scene(s); ${failed.length} failed: ${failed
            .map(f => `${f.scene_id} (${f.error})`)
            .join('; ')}`;
        }
        return result;
      });
    } catch (e: any) {
      return {
        success: false,
        mode,
        changed: false,
        error: String((e && (e.stack || e.message)) || e),
      };
    }
  }

  // ---- aidm-module-* (board #1724): see aidm-module-handlers.ts. ----
  private async handleAidmModuleStatus(data: any): Promise<any> {
    return await this.aidmModules.status(data);
  }

  private async handleAidmModuleEnable(data: any): Promise<any> {
    return await this.aidmModules.setEnabled(data, true);
  }

  private async handleAidmModuleDisable(data: any): Promise<any> {
    return await this.aidmModules.setEnabled(data, false);
  }

  private async handleAidmModuleInstall(data: any): Promise<any> {
    return await this.aidmModules.install(data);
  }

  private async handleAidmModuleUpdate(data: any): Promise<any> {
    return await this.aidmModules.update(data);
  }

  private async handleAidmModuleRemove(data: any): Promise<any> {
    return await this.aidmModules.remove(data);
  }

  // Read-only counterpart (item E, board #1311): reports the same {unresolved:{scene_refs,
  // actor_ids}} shape as adventure-import for a scene that already exists in the world, WITHOUT
  // importing or creating anything -- so a gate can check a world that was built by an earlier,
  // pre-fix adventure-import call (or by hand) without touching it.
  private async handleSceneIntegrity(data: {
    scene_id?: string;
    scene_identifier?: string;
  }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      const locator = data?.scene_id || data?.scene_identifier;
      if (!locator) throw new Error('scene_id or scene_identifier is required');
      const scene = this._findSceneByIdOrName(locator);
      if (!scene) throw new Error(`Scene not found: "${locator}"`);

      const unresolvedSceneRefs = await this._resolveSceneRefs([scene]);
      const unresolvedActorIds = this._missingActorIds([scene]);
      const success = unresolvedSceneRefs.length === 0 && unresolvedActorIds.length === 0;
      return {
        success,
        scene_id: scene.id,
        scene_name: scene.name,
        reused: true,
        imported: { scenes: [], actors: [] },
        unresolved: { scene_refs: unresolvedSceneRefs, actor_ids: unresolvedActorIds },
        invalid_actor_ids: this._invalidActorIds([scene]),
        error: summarizeUnresolved(unresolvedSceneRefs, unresolvedActorIds),
      };
    } catch (e: any) {
      return this._emptyAdventureImportResult(String((e && (e.stack || e.message)) || e));
    }
  }

  // ---- Phase E wall/lighting tools (the audited gap: no wall/light tools existed anywhere in
  // the fork before this). Same additive, adventure-agnostic pattern as the Phase B scene tools
  // above: caller supplies raw field data, nothing here names a module or adventure. Field names
  // are the real v13 WallDocument/AmbientLightDocument/Scene schema names, verified against the
  // official v13 API docs (not guessed) -- see bridge/README.md's 0004 entry for the full
  // citation trail:
  //   Wall:   https://foundryvtt.com/api/v13/interfaces/foundry.documents.types.WallData.html
  //   Light:  https://foundryvtt.com/api/v13/interfaces/foundry.documents.types.AmbientLightData.html
  //   Scene:  https://foundryvtt.com/api/v13/interfaces/foundry.documents.types.SceneData.html
  // createEmbeddedDocuments/deleteEmbeddedDocuments are called ONCE per request with the whole
  // batch (matching addActorsToScene's existing batched-create pattern), not once per element.
  // Delete-by-ids is idempotent: ids that no longer exist on the scene are reported back under
  // notFoundIds rather than throwing, the same shape dataAccess.deleteTokens already uses.

  private _wallCreatePayload(w: any): any {
    const validCoords =
      w && Array.isArray(w.c) && w.c.length === 4 && w.c.every((n: any) => typeof n === 'number');
    if (!validCoords) {
      throw new Error('each wall requires c: [x1, y1, x2, y2] (four numbers)');
    }
    const payload: any = { c: w.c };
    // light/move/sight/sound: CONST.WALL_SENSE_TYPES (light/sight/sound) and
    // CONST.WALL_MOVEMENT_TYPES (move) -- NONE:0, LIMITED:10 (sense only), NORMAL:20,
    // PROXIMITY:30 (sense only), DISTANCE:40 (sense only).
    if (w.light !== undefined) payload.light = w.light;
    if (w.move !== undefined) payload.move = w.move;
    if (w.sight !== undefined) payload.sight = w.sight;
    if (w.sound !== undefined) payload.sound = w.sound;
    // dir: CONST.WALL_DIRECTIONS -- BOTH:0, LEFT:1, RIGHT:2.
    if (w.dir !== undefined) payload.dir = w.dir;
    // door: CONST.WALL_DOOR_TYPES -- NONE:0, DOOR:1, SECRET:2.
    if (w.door !== undefined) payload.door = w.door;
    // ds: CONST.WALL_DOOR_STATES -- CLOSED:0, OPEN:1, LOCKED:2. Only meaningful when door != 0.
    if (w.ds !== undefined) payload.ds = w.ds;
    if (w.doorSound !== undefined) payload.doorSound = w.doorSound;
    // threshold: {light?, sight?, sound?: number; attenuation?: boolean} -- passed through as-is.
    if (w.threshold && typeof w.threshold === 'object') payload.threshold = w.threshold;
    return payload;
  }

  private async handleWallsCreate(data: { sceneId?: string; walls?: any[] }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      if (!data?.sceneId) throw new Error('sceneId is required');
      if (!Array.isArray(data.walls) || data.walls.length === 0) {
        throw new Error('walls array is required and must not be empty');
      }
      const scene = this._findSceneByIdOrName(data.sceneId);
      if (!scene) throw new Error(`Scene not found: "${data.sceneId}"`);
      const payload = data.walls.map((w: any) => this._wallCreatePayload(w));
      const created: any[] = (await scene.createEmbeddedDocuments('Wall', payload)) || [];
      return { success: true, count: created.length, ids: created.map((d: any) => d.id) };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e) };
    }
  }

  private async handleWallsDelete(data: { sceneId?: string; ids?: string[] }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      if (!data?.sceneId) throw new Error('sceneId is required');
      if (!Array.isArray(data.ids) || data.ids.length === 0) {
        throw new Error('ids array is required and must not be empty');
      }
      const scene = this._findSceneByIdOrName(data.sceneId);
      if (!scene) throw new Error(`Scene not found: "${data.sceneId}"`);
      const existingIds = data.ids.filter(id => !!scene.walls?.get?.(id));
      const notFoundIds = data.ids.filter(id => !scene.walls?.get?.(id));
      const deleted: any[] = existingIds.length
        ? (await scene.deleteEmbeddedDocuments('Wall', existingIds)) || []
        : [];
      return {
        success: true,
        deletedCount: deleted.length,
        deletedIds: existingIds,
        notFoundIds: notFoundIds.length ? notFoundIds : undefined,
      };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e) };
    }
  }

  private _segmentBounds(
    docs: any[],
    getPoints: (d: any) => number[]
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const d of docs) {
      const pts = getPoints(d) || [];
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const x = pts[i];
        const y = pts[i + 1];
        if (typeof x !== 'number' || typeof y !== 'number') continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return { minX, minY, maxX, maxY };
  }

  private async handleListWalls(data: { sceneId?: string }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      if (!data?.sceneId) throw new Error('sceneId is required');
      const scene = this._findSceneByIdOrName(data.sceneId);
      if (!scene) throw new Error(`Scene not found: "${data.sceneId}"`);
      const wallDocs: any[] = Array.from(scene.walls?.contents || scene.walls?.values?.() || []);
      const walls = wallDocs.map((d: any) => ({
        id: d.id,
        c: d.c,
        door: d.door,
        ds: d.ds,
        move: d.move,
        sight: d.sight,
        sound: d.sound,
        light: d.light,
        dir: d.dir,
      }));
      const bounds = this._segmentBounds(wallDocs, d => d.c);
      return { success: true, count: walls.length, bounds, walls };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e), walls: [] };
    }
  }

  private _lightCreatePayload(l: any): any {
    if (!l || typeof l.x !== 'number' || typeof l.y !== 'number') {
      throw new Error('each light requires numeric x and y');
    }
    const payload: any = { x: l.x, y: l.y };
    if (l.rotation !== undefined) payload.rotation = l.rotation;
    if (l.elevation !== undefined) payload.elevation = l.elevation;
    if (l.hidden !== undefined) payload.hidden = l.hidden;
    // walls/vision: booleans -- is this light blocked by walls, does it grant vision.
    if (l.walls !== undefined) payload.walls = l.walls;
    if (l.vision !== undefined) payload.vision = l.vision;
    // config: LightData subset (bright, dim, angle, color, alpha, luminosity, saturation,
    // contrast, shadows, attenuation, animation, darkness:{min,max}, ...) -- passed through as-is,
    // the same way scene-update passes flags through as-is; Foundry's own schema cleans/validates
    // it on write.
    if (l.config && typeof l.config === 'object') payload.config = l.config;
    return payload;
  }

  private async handleLightsCreate(data: { sceneId?: string; lights?: any[] }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      if (!data?.sceneId) throw new Error('sceneId is required');
      if (!Array.isArray(data.lights) || data.lights.length === 0) {
        throw new Error('lights array is required and must not be empty');
      }
      const scene = this._findSceneByIdOrName(data.sceneId);
      if (!scene) throw new Error(`Scene not found: "${data.sceneId}"`);
      const payload = data.lights.map((l: any) => this._lightCreatePayload(l));
      const created: any[] = (await scene.createEmbeddedDocuments('AmbientLight', payload)) || [];
      return { success: true, count: created.length, ids: created.map((d: any) => d.id) };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e) };
    }
  }

  private async handleLightsDelete(data: { sceneId?: string; ids?: string[] }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      if (!data?.sceneId) throw new Error('sceneId is required');
      if (!Array.isArray(data.ids) || data.ids.length === 0) {
        throw new Error('ids array is required and must not be empty');
      }
      const scene = this._findSceneByIdOrName(data.sceneId);
      if (!scene) throw new Error(`Scene not found: "${data.sceneId}"`);
      const existingIds = data.ids.filter(id => !!scene.lights?.get?.(id));
      const notFoundIds = data.ids.filter(id => !scene.lights?.get?.(id));
      const deleted: any[] = existingIds.length
        ? (await scene.deleteEmbeddedDocuments('AmbientLight', existingIds)) || []
        : [];
      return {
        success: true,
        deletedCount: deleted.length,
        deletedIds: existingIds,
        notFoundIds: notFoundIds.length ? notFoundIds : undefined,
      };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e) };
    }
  }

  private async handleListLights(data: { sceneId?: string }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      if (!data?.sceneId) throw new Error('sceneId is required');
      const scene = this._findSceneByIdOrName(data.sceneId);
      if (!scene) throw new Error(`Scene not found: "${data.sceneId}"`);
      const lightDocs: any[] = Array.from(scene.lights?.contents || scene.lights?.values?.() || []);
      const lights = lightDocs.map((d: any) => ({
        id: d.id,
        x: d.x,
        y: d.y,
        rotation: d.rotation,
        elevation: d.elevation,
        hidden: d.hidden,
        walls: d.walls,
        vision: d.vision,
        config: {
          bright: d.config?.bright,
          dim: d.config?.dim,
          angle: d.config?.angle,
          color: d.config?.color,
        },
      }));
      // Lights are points, not segments -- bounds are the min/max of each light's own [x,y].
      const bounds = this._segmentBounds(lightDocs, d => [d.x, d.y]);
      return { success: true, count: lights.length, bounds, lights };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e), lights: [] };
    }
  }

  // ---- Phase D user provisioning tools (join flow; Section 4f audit gap). ----
  // Deliberately PLAYER(1)/TRUSTED(2) ONLY: these exist so the brain's join flow can seat a
  // player, never to hand out ASSISTANT(3) or GAMEMASTER(4) accounts. Every entry point below
  // (create, and the role gate itself) refuses role 0/3/4 with a clear error.
  private static readonly ROLE_NAMES: Record<number, string> = {
    0: 'NONE',
    1: 'PLAYER',
    2: 'TRUSTED',
    3: 'ASSISTANT',
    4: 'GAMEMASTER',
  };

  private _resolveJoinRole(role: any): { ok: true; value: number } | { ok: false; error: string } {
    const ALLOWED: Record<string, number> = { PLAYER: 1, TRUSTED: 2 };
    let num: number | undefined;
    if (typeof role === 'number' && Number.isFinite(role)) {
      num = role;
    } else if (typeof role === 'string') {
      const upper = role.trim().toUpperCase();
      if (upper in ALLOWED) {
        num = ALLOWED[upper];
      } else if (/^-?\d+$/.test(upper)) {
        num = parseInt(upper, 10);
      }
    }
    if (num === undefined || (num !== 1 && num !== 2)) {
      const label =
        num !== undefined ? QueryHandlers.ROLE_NAMES[num] || `role ${num}` : JSON.stringify(role);
      return {
        ok: false,
        error: `role must be PLAYER(1) or TRUSTED(2); refusing ${label}. This tool cannot create ASSISTANT(3) or GAMEMASTER(4) accounts.`,
      };
    }
    return { ok: true, value: num };
  }

  private async handleUserCreate(data: {
    name?: string;
    password?: string;
    role?: string | number;
  }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      if (!data?.name || typeof data.name !== 'string' || !data.name.trim()) {
        throw new Error('name is required');
      }
      if (!data.password || typeof data.password !== 'string' || !data.password.length) {
        throw new Error('password is required');
      }
      const roleCheck = this._resolveJoinRole(data.role);
      if (!roleCheck.ok) return { success: false, error: roleCheck.error };

      const UserCls: any = (globalThis as any).User;
      if (!UserCls || typeof UserCls.create !== 'function') {
        return {
          success: false,
          error: 'User document class unavailable in this Foundry build (capability check failed)',
        };
      }

      let created: any;
      try {
        // Create with role only, matching core's own "Manage Players" flow (the Create User
        // button never takes a password); the password is set in a second call below via the
        // same user.update({password}) path the "Configure Player" sheet uses, which is the
        // well-established GM-sets-another-user's-password mechanism (server-side hashing on
        // receipt). This is safer than betting on Create() also accepting a raw password field,
        // which is not documented and untested here.
        created = await UserCls.create({ name: data.name.trim(), role: roleCheck.value });
      } catch (coreErr: any) {
        return {
          success: false,
          error: `Foundry refused to create the user: ${String((coreErr && (coreErr.message || coreErr)) || coreErr)}`,
        };
      }
      if (!created) {
        return {
          success: false,
          error: 'User.create returned no document (refused silently by core)',
        };
      }

      try {
        await created.update({ password: data.password });
      } catch (pwErr: any) {
        // The user document now exists but without the intended password; say so plainly rather
        // than reporting a clean success the caller would trust.
        return {
          success: false,
          error: `User "${created.name}" (${created.id}) was created but setting its password failed: ${String((pwErr && (pwErr.message || pwErr)) || pwErr)}. Delete it with user-delete and retry, or set the password by hand.`,
          id: created.id,
          name: created.name,
        };
      }

      return { success: true, id: created.id, name: created.name };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e) };
    }
  }

  private async handleUserUpdate(data: {
    id?: string;
    password?: string;
    character_id?: string | null;
  }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      if (!data?.id) throw new Error('id is required');
      const user: any = (game as any).users?.get(data.id);
      if (!user) throw new Error(`User not found: ${data.id}`);

      const update: any = {};
      if (data.password !== undefined && data.password !== null && String(data.password).length) {
        update.password = data.password;
      }
      if (data.character_id !== undefined) {
        if (data.character_id === null || data.character_id === '') {
          update.character = null;
        } else {
          const actor: any = (game as any).actors?.get(data.character_id);
          if (!actor) throw new Error(`Actor not found: ${data.character_id}`);
          update.character = actor.id;
        }
      }
      if (Object.keys(update).length === 0) {
        throw new Error('No fields to update: provide password and/or character_id');
      }

      await user.update(update);
      return { success: true, id: user.id };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e) };
    }
  }

  private async handleListUsers(_data: any): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      const users: any[] = (game as any).users?.contents || [];
      const list = users.map((u: any) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        roleName: QueryHandlers.ROLE_NAMES[u.role] || 'UNKNOWN',
        active: !!u.active,
        character_id: u.character?.id || null,
      }));
      return { success: true, users: list };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e), users: [] };
    }
  }

  private async handleUserDelete(data: { id?: string }): Promise<any> {
    const gm = this.validateGMAccess();
    if (!gm.allowed) return { error: 'Access denied', success: false };
    try {
      if (!data?.id) throw new Error('id is required');
      const user: any = (game as any).users?.get(data.id);
      if (!user) throw new Error(`User not found: ${data.id}`);
      if (user.role >= 4) {
        return {
          success: false,
          error: 'Refusing to delete a GAMEMASTER-role user through this tool.',
        };
      }
      await user.delete();
      return { success: true, id: data.id };
    } catch (e: any) {
      return { success: false, error: String((e && (e.stack || e.message)) || e) };
    }
  }
}
