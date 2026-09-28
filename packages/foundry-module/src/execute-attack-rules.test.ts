/**
 * Board #1887 (plan F.4(b) bridge 0.10.7; engine map M07 bridge 0.10.8): handler-level tests for execute-attack.
 *
 * These run the REAL QueryHandlers#handleExecuteAttack from queries.ts against a small in-memory Foundry stand-in:
 * - The attack activity's `rollAttack` follows dnd5e 5.3.3's own `AttackActivity#rollAttack` (dnd5e attack.mjs),
 *   reduced to the parts that decide the result here: the remembered attack mode
 *   (`flags.dnd5e.last.<activity>.attackMode`) used when none is given, the mode checked against the item's
 *   `attackModes` (falling back to the first), `advantage`/`disadvantage` turned into the roll's mode, a THROWN mode
 *   using the weapon up (quantity - 1, never below 0, not for a Returning weapon), and a quantity of 0 giving only a
 *   warning. The roll formulas are the ones the test stack printed on 2026-09-27 ("1d20 + 2 + 2", "2d20dis + 2 + 2").
 * - MidiQOL's `checkActivityRange` follows Midi-QOL 14.0.12's own rules (utils.ts checkRangeFunction): a wall under
 *   `wallsBlockRange` (negative distance) fails, beyond long range fails (`checkRange: longFail`, the live and test
 *   setting), beyond normal range is `dis`. `getDistance` / `computeDistance` / `canSee` answer from the positions.
 * - Bridge 0.10.8: MidiQOL's `completeActivityUse` is a reduced Midi-QOL 14.0.12 attack workflow (Workflow.ts,
 *   AttackActivity.ts, utils.ts), the parts measured on the test stack on 2026-09-27:
 *   - a weapon with the Thrown property and NO `workflowOptions.attackMode`, or a GM roll not fast-forwarded, opens a
 *     roll dialog and the workflow waits for ever (AttackRollConfigurationDialog; the stuck state WaitForAttackRoll);
 *   - its own range check (ValidateRoll: `fail` ends the workflow, `dis` = disadvantage "Long Range");
 *   - advantage and disadvantage from its tracker: Midi flags on the attacker (`flags.midi-qol.advantage.attack.all`,
 *     a condition), its optional nearby-foe rule only when `optionalRulesEnabled` (checkRule), `ignoreNearbyFoes`;
 *   - its hit test (total + bonuses >= the AC it computes, cover included; a natural 20 hits, a natural 1 misses);
 *   - reactions: a target with a usable reaction, on a hit, with reactions not switched off (`noProvokeReaction`),
 *     crashes the workflow the way 14.0.12 does without DAE (doReactions reads `globalThis.DAE.actionQueue`);
 *   - critical damage per its GM setting (`criticalDamageGM`: one of its choices adds dnd5e's critical dice, 'none'
 *     adds none, measured: '1d4 + 2' on a natural 20);
 *   - damage: dnd5e's resistance halves (calculateDamage), the total never below 0 (setupDamageDetails), applied by
 *     Midi itself (its damage card, `autoApplyDamage: yes`), and dnd5e's `activity.use` spending a spell slot.
 *
 * What this proves: what execute-attack asks the engine for, that it takes the engine's answers (and never works a
 * rule out itself), what it refuses, and the words it uses. What it does NOT prove: that the live dnd5e and Midi-QOL
 * answer the same way. That is the test-stack run (dnd-dm-modtest/README.md).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./data-access.js', () => ({ FoundryDataAccess: class {} }));
vi.mock('./comfyui-manager.js', () => ({ ComfyUIManager: class {} }));

import { QueryHandlers } from './queries.js';

const GRID = 100; // pixels per square
const FT = 5; // feet per square

class ValueCollection<V extends { id: string }> extends Map<string, V> {
  constructor(values: V[] = []) {
    super(values.map(v => [v.id, v]));
  }
  get contents() {
    return [...this.values()];
  }
  find(fn: (v: V) => boolean) {
    return this.contents.find(fn);
  }
  filter(fn: (v: V) => boolean) {
    return this.contents.filter(fn);
  }
  override [Symbol.iterator](): any {
    return this.values();
  }
}

let rollCalls: any[] = [];
let damageCalls: any[] = [];
let warnings: string[] = [];
let d20Queue: number[] = [];
let midiCalls: any[] = [];
let applyDamageCalls: any[] = [];
let openApps: Map<string, any>;
let liveWorkflows: Map<string, any>;
let midiConfig: any;
// Board #1887 (bridge 0.10.8 review): pairs "attackerId>targetId" where the attacker cannot see the target (Midi's
// canSee answers false), a delay before Midi's workflow answers, and the dialogs the stuck workflow opens.
let unseen: Set<string>;
let midiDelayMs = 0;
let stuckDialogs: string[] = ['AttackRollConfigurationDialog'];
// Board #1887 (round 3): DAE present (the reaction prompt waits this long, then Midi's own state loop goes ON to the
// damage), and Midi refusing a use with more targets than this (its `requiresTargets` rule; 0 = off).
let lateReactionMs = 0;
let midiRefuseOver = 0;
// Board #1887 (round 4): Midi-QOL's LATE formula target check (WorkflowState_AoETargetConfirmation): the cost is paid,
// then the workflow is aborted and handed back (0 = off); and a notice some other add-on shows during a use.
let midiAbortLateOver = 0;
let otherToast = '';
// round 5: the fake Midi aborts a save workflow with no refusal words; or hands its effect chooser a list without the
// caster's chosen effect
let midiAbortSaveSilently = false;
let midiDropsChosenEffect = false;

function getProperty(obj: any, path: string) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setProperty(obj: any, path: string, value: any) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1] ?? ''] = value;
}

const DAGGER_MODES = [
  { value: 'oneHanded' },
  { value: 'offhand' },
  { rule: true },
  { value: 'thrown' },
  { value: 'thrown-offhand' },
];

function makeWeapon(opts: {
  name: string;
  quantity: number;
  range: { value?: number | null; long?: number | null; reach?: number | null; units?: string };
  properties: string[];
  attackModes: any[];
  actionType?: string;
  type?: string;
  remembered?: string;
  id?: string;
  level?: number;
  midiProperties?: any;
}) {
  const item: any = {
    id: opts.id ?? `item${opts.name.replace(/\W/g, '')}`,
    name: opts.name,
    type: opts.type ?? 'weapon',
    flags: {},
    isOwner: true,
    inCompendium: false,
    effects: [],
    system: {
      quantity: opts.quantity,
      range: { units: 'ft', ...opts.range },
      properties: new Set(opts.properties),
      attackModes: opts.attackModes,
      level: opts.level ?? 0,
    },
    getFlag(scope: string, key: string) {
      return getProperty(this.flags, `${scope}.${key}`);
    },
    async setFlag(scope: string, key: string, value: any) {
      setProperty(this.flags, `${scope}.${key}`, value);
    },
  };
  const activity: any = {
    id: `act${opts.name.replace(/\W/g, '')}`,
    uuid: `Item.${item.id}.Activity.act${opts.name.replace(/\W/g, '')}`,
    type: 'attack',
    actionType: opts.actionType ?? 'mwak',
    attack: {},
    item,
    midiProperties: opts.midiProperties ?? {},
    // dnd5e 5.3.3 AttackActivity#rollAttack, reduced (see the file header).
    async rollAttack(config: any = {}, dialog: any = {}, _message: any = {}) {
      if (this.item.type === 'weapon' && this.item.system.quantity === 0) {
        warnings.push('DND5E.ATTACK.Warning.NoQuantity');
      }
      const rollConfig: any = {
        attackMode: this.item.getFlag('dnd5e', `last.${this.id}.attackMode`),
        ...config,
      };
      const attackModeOptions = this.item.system.attackModes;
      if (
        attackModeOptions?.length &&
        !attackModeOptions.find((m: any) => m.value === rollConfig.attackMode)
      ) {
        rollConfig.attackMode = attackModeOptions[0]?.value;
      }
      const advantage = !!rollConfig.advantage;
      const disadvantage = !!rollConfig.disadvantage;
      const advantageMode = advantage && !disadvantage ? 1 : !advantage && disadvantage ? -1 : 0;
      const die = d20Queue.length ? d20Queue.shift()! : 10;
      const head = advantageMode === -1 ? '2d20dis' : advantageMode === 1 ? '2d20adv' : '1d20';
      const roll = {
        formula: `${head} + 2 + 2`,
        total: die + 4,
        isCritical: die === 20,
        isFumble: die === 1,
        options: { attackMode: rollConfig.attackMode, advantageMode },
      };
      let ammoUpdate: any = null;
      if (
        roll.options.attackMode?.startsWith('thrown') &&
        !this.item.system.properties?.has('ret')
      ) {
        ammoUpdate = { id: this.item.id, quantity: Math.max(0, this.item.system.quantity - 1) };
      }
      const flags: any = {};
      if (roll.options.attackMode) flags.attackMode = roll.options.attackMode;
      if (Object.keys(flags).length) await this.item.setFlag('dnd5e', `last.${this.id}`, flags);
      if (ammoUpdate) this.item.system.quantity = ammoUpdate.quantity;
      rollCalls.push({
        config: { ...config },
        dialog,
        mode: roll.options.attackMode,
        advantageMode,
      });
      return [roll];
    },
    // dnd5e's damage roll, reduced: 1d4 + 2 = 4; a critical with dnd5e's own critical dice adds one more d4 (2).
    async rollDamage(config: any = {}) {
      damageCalls.push({ ...config });
      const extra = config.isCritical && config.criticalDice ? 2 : 0;
      return [
        {
          formula: extra ? '2d4 + 2' : '1d4 + 2',
          total: 4 + extra,
          options: { type: 'piercing' },
          terms: [],
        },
      ];
    },
  };
  item.system.activities = new ValueCollection([activity]);
  if (opts.remembered)
    setProperty(item.flags, `dnd5e.last.${activity.id}.attackMode`, opts.remembered);
  return item;
}

function makeDagger(
  quantity = 1,
  extra: Partial<{ properties: string[]; remembered: string; midiProperties: any }> = {}
) {
  return makeWeapon({
    name: 'Dagger',
    quantity,
    range: { value: 20, long: 60, reach: 5 },
    properties: extra.properties ?? ['fin', 'lgt', 'thr'],
    attackModes: DAGGER_MODES,
    ...(extra.remembered ? { remembered: extra.remembered } : {}),
    ...(extra.midiProperties ? { midiProperties: extra.midiProperties } : {}),
  });
}

function makeActor(
  name: string,
  items: any[],
  hp = 20,
  ac = 12,
  flags: any = {},
  extra: Partial<{ resist: string[]; reactions: string[] }> = {}
) {
  const actor: any = {
    name,
    items: new ValueCollection(items),
    flags,
    effects: [],
    reactions: extra.reactions ?? [],
    system: {
      attributes: { ac: { value: ac }, hp: { value: hp, max: hp, temp: 0 } },
      spells: {},
      traits: { dr: { value: new Set(extra.resist ?? []) } },
    },
    async applyDamage(parts: any[]) {
      applyDamageCalls.push(parts);
      for (const p of parts) actor.system.attributes.hp.value -= p.value;
    },
    async update(changes: any = {}) {
      for (const [k, v] of Object.entries(changes)) setProperty(actor, k, v);
    },
  };
  for (const it of items) it.parent = actor;
  return actor;
}

// Positions are in squares along x (y = 0), so feet = squares * 5.
interface Tok {
  id: string;
  name: string;
  sq: number;
  sy?: number;
  disposition: number;
  actor: any;
  seesAttacker?: boolean;
  cover?: number;
}

let tokens: ValueCollection<any>;
let walls: Set<string>; // "idA|idB" pairs a wall stands between (either order)
let wallsOnFt: Map<string, number>; // a walls-on distance that differs from the open measure
let midiRules: any;
let midiThrows: Record<string, boolean> = {};

function key(a: any, b: any) {
  return [a.id, b.id].sort().join('|');
}

function openFeet(a: any, b: any) {
  return (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / GRID) * FT;
}

const MIDI_CRIT_CHOICES = [
  'default',
  'maxDamage',
  'maxCrit',
  'doubleDice',
  'explode',
  'baseDamage',
];

function install(toks: Tok[]) {
  const docs = toks.map(t => {
    const doc: any = {
      id: t.id,
      uuid: `Scene.scene1.Token.${t.id}`,
      name: t.name,
      x: t.sq * GRID,
      y: (t.sy ?? 0) * GRID,
      disposition: t.disposition,
      actor: t.actor,
      seesAttacker: t.seesAttacker ?? true,
      cover: t.cover ?? 0,
      async update(ch: any) {
        Object.assign(doc, ch);
      },
    };
    doc.object = {
      id: t.id,
      document: doc,
      name: t.name,
      get actor() {
        return doc.actor;
      },
      get center() {
        return { x: doc.x + GRID / 2, y: doc.y + GRID / 2 };
      },
      // Foundry's Token#setTarget: the GM user's own target set
      setTarget(on = true, opts: any = {}) {
        const u = (globalThis as any).game.user;
        if (opts.releaseOthers) u.targets = new Set();
        if (on) u.targets.add(doc.object);
        else u.targets.delete(doc.object);
      },
      control() {},
    };
    return doc;
  });
  tokens = new ValueCollection(docs);
  const scene = { id: 'scene1', grid: { size: GRID }, tokens };
  const g: any = globalThis;
  g.game = {
    user: { isGM: true, targets: new Set() },
    scenes: { active: scene, contents: [scene] },
    settings: {
      get(scope: string, name: string) {
        if (scope === 'midi-qol' && name === 'ConfigSettings') {
          if (midiThrows.settings) throw new Error('settings exploded');
          return { ...midiConfig, optionalRules: midiRules };
        }
        throw new Error(`unknown setting ${scope}.${name}`);
      },
    },
  };
  g.canvas = {
    dimensions: { distance: FT },
    // Foundry 14's TokenLayer#setTargets (the call Midi-QOL's updateUserTargets makes): the GM's targets become
    // exactly these tokens
    tokens: {
      setTargets(ids: string[]) {
        g.game.user.targets = new Set(ids.map(id => tokens.get(id)?.object).filter(Boolean));
      },
    },
  };
  g.ui = {
    notifications: {
      warn: (m: string) => warnings.push(`ui:${m}`),
      error: (m: string) => warnings.push(`ui:${m}`),
      info: () => {},
    },
  };
  g.foundry = { applications: { instances: openApps } };
  // Foundry's Hooks, reduced: Midi-QOL 14.0.12 calls its per-state hooks with the workflow and awaits each
  // (utils.ts asyncHooksCall), e.g. `midi-qol.preApplyDynamicEffects` before it applies an item's effects.
  const hookFns = new Map<number, { name: string; fn: (...a: any[]) => any }>();
  let hookId = 0;
  g.Hooks = {
    on(name: string, fn: (...a: any[]) => any) {
      hookFns.set(++hookId, { name, fn });
      return hookId;
    },
    off(name: string, id: number) {
      if (hookFns.get(id)?.name === name) hookFns.delete(id);
    },
    async midiCall(name: string, w: any) {
      for (const h of [...hookFns.values()]) if (h.name === name) await h.fn(w);
    },
    count: (name: string) => [...hookFns.values()].filter(h => h.name === name).length,
  };
  const docOf = (o: any) => o?.document || o;
  const distance = (a: any, b: any, opts: any = {}) => {
    const A = docOf(a),
      B = docOf(b);
    if (opts.wallsBlock && walls.has(key(A, B))) return -1;
    if (opts.wallsBlock && wallsOnFt.has(key(A, B))) return wallsOnFt.get(key(A, B))!;
    return openFeet(A, B);
  };
  const maybeThrow = (what: string) => {
    if (midiThrows[what]) throw new Error(`${what} exploded`);
  };
  // Midi-QOL 14.0.12 checkRangeFunction, reduced (checkRange 'longFail').
  const rangeVerdict = (activity: any, tokenObj: any, targets: Iterable<any>) => {
    const rng = activity.item.system.range || {};
    let range = Number(rng.value) || Number(rng.reach) || 0;
    let longRange = Number(rng.long) || 0;
    const thr = activity.item.system.properties?.has('thr');
    if (['mwak', 'msak'].includes(activity.actionType) && !thr) {
      longRange = 0;
      range = Number(rng.reach) || 5;
    }
    if (longRange > 0 && longRange < range) longRange = range;
    for (const t of targets) {
      const raw = distance(tokenObj, t, {
        wallsBlock: midiRules.wallsBlockRange !== 'none',
        includeCover: true,
      });
      if (raw < 0) return { result: 'fail', attackingToken: tokenObj, range, longRange };
      const d = Math.max(0, Math.round(raw));
      if ((longRange !== 0 && d > longRange) || (d > range && longRange === 0)) {
        return { result: 'fail', attackingToken: tokenObj, range, longRange };
      }
      if (d > range) return { result: 'dis', attackingToken: tokenObj, range, longRange };
    }
    return { result: 'normal', attackingToken: tokenObj, range, longRange };
  };
  // Midi-QOL findNearby/checkNearby, reduced: a token of the opposite disposition within `dist` feet that sees it.
  const nearbyFoe = (tokenObj: any, dist: number) => {
    const me = docOf(tokenObj);
    const want = me.disposition * -1;
    return tokens.contents.some(
      (t: any) =>
        t.id !== me.id &&
        t.disposition === want &&
        (t.actor?.system?.attributes?.hp?.value ?? 1) > 0 &&
        distance(t, me, { wallsBlock: true }) >= 0 &&
        distance(t, me, { wallsBlock: true }) <= dist &&
        t.seesAttacker
    );
  };
  const evalFlag = (actor: any, flag: string) => {
    const v = getProperty(actor, flag);
    if (v === undefined || v === null || v === '') return false;
    if (typeof v === 'boolean') return v;
    return !!new Function(`return (${String(v)});`)();
  };
  const stuck = (id: string, state: string, dialog?: string, sequenceId?: string) => {
    const w: any = {
      id,
      sequenceId,
      activity: null,
      currentAction: { name: state },
      aborted: false,
      async performState(s: any) {
        w.currentAction = s;
        w.abortedByBridge = true;
      },
      WorkflowState_Abort: { name: 'WorkflowState_Abort' },
    };
    liveWorkflows.set(id, w);
    for (const name of dialog ? [dialog, ...stuckDialogs.filter(n => n !== dialog)] : []) {
      const app: any = {
        constructor: { name },
        closed: false,
        async close() {
          app.closed = true;
          openApps.delete(name);
        },
      };
      openApps.set(name, app);
    }
    return w;
  };
  g.MidiQOL = {
    Workflow: { workflows: liveWorkflows },
    getDistance: (a: any, b: any, opts: any = {}) => {
      maybeThrow(opts.wallsBlock ? 'distanceWallsOn' : 'distanceWallsOff');
      return distance(a, b, opts);
    },
    computeDistance: distance,
    canSee: (a: any, b: any) => {
      maybeThrow('canSee');
      return !unseen.has(`${docOf(a).id}>${docOf(b).id}`);
    },
    checkActivityRange(activity: any, tokenObj: any, targets: Set<any>) {
      maybeThrow('checkActivityRange');
      return rangeVerdict(activity, tokenObj, targets);
    },
    // Midi-QOL's public checkNearby (the bridge no longer calls it: Midi's own workflow does, when its rule is on).
    checkNearby(_disposition: number, tokenObj: any, dist: number) {
      return nearbyFoe(tokenObj, dist);
    },
    // Midi-QOL 14.0.12's attack workflow, reduced (see the file header).
    async completeActivityUse(activity: any, usage: any, dialog: any, _message: any) {
      const mo = usage?.midiOptions ?? {};
      const wo = { ...mo, ...(mo.workflowOptions ?? {}) };
      midiCalls.push({
        activity,
        usage,
        dialog,
        // the GM's targets while Midi-QOL runs (what an AREA activity uses)
        userTargets: [...g.game.user.targets].map((t: any) => t.id),
      });
      // completeActivityUse notes the targets it found and puts them back at its cleanup (utils.ts 2406, 2445)
      const targetsFound = new Set(g.game.user.targets);
      const putBackTargets = () => {
        g.game.user.targets = new Set(targetsFound);
      };
      // Midi-QOL's completeActivityUse tags the caller's own usage object (utils.ts: usage.sequenceId = randomID())
      usage.sequenceId = `seq${midiCalls.length}`;
      if (otherToast) g.ui.notifications.info(otherToast);
      const item = activity.item;
      const actor = item.parent;
      const attDoc = tokens.contents.find((t: any) => t.actor === actor);
      const targets = [...(mo.targetsToUse ?? [])];
      const wfId = `wf${midiCalls.length}`;
      // A roll dialog in a browser nobody sits at: the workflow waits for ever.
      const dialogForced =
        activity.midiProperties?.forceRollDialog === 'always' ||
        !wo.fastForwardAttack ||
        (item.system.properties?.has('thr') && !wo.attackMode);
      if (dialogForced) {
        const w = stuck(
          wfId,
          'WorkflowState_WaitForAttackRoll',
          'AttackRollConfigurationDialog',
          usage.sequenceId
        );
        w.activity = activity;
        return new Promise(() => {});
      }
      if (midiThrows.completeActivityUse) throw new Error('the roll dialog was closed');
      // Midi-QOL's own target count check (MidiActivityMixin.ts, `requiresTargets` on): a warning, no workflow, and
      // nothing spent (it runs before dnd5e's use).
      if (midiRefuseOver && targets.length > midiRefuseOver) {
        // Midi-QOL 14.0.12's own text (lang/en.json, midi-qol.wrongNumberTargets)
        g.ui.notifications.warn(
          `You must target at most ${midiRefuseOver} token(s) before rolling the attack`
        );
        return undefined;
      }
      // dnd5e activity.use: a levelled spell spends a slot.
      if (item.type === 'spell' && (item.system.level || 0) > 0) {
        const k = `system.spells.spell${item.system.level}.value`;
        setProperty(actor, k, Math.max(0, (getProperty(actor, k) ?? 0) - 1));
      }
      // Midi-QOL's late formula count check: after the cost, a warning, and the ABORTED workflow handed back.
      if (midiAbortLateOver && targets.length > midiAbortLateOver) {
        g.ui.notifications.warn(
          `You must target at most ${midiAbortLateOver} token(s) before rolling the attack`
        );
        return {
          aborted: true,
          currentAction: { name: 'WorkflowState_Abort' },
          attackRoll: null,
          sequenceId: usage.sequenceId,
        };
      }
      // An AREA save activity (a breath weapon's line): dnd5e places a template unless the usage says not to (then it
      // waits for a click for ever); with none placed Midi suspends in WorkflowState_AwaitTemplate until it is told the
      // use is complete (unSuspend({itemUseComplete: true})), then goes on with the targets given.
      if (activity.type === 'save' && activity.target?.template?.type) {
        if (usage.create?.measuredTemplate !== false) return new Promise(() => {});
        const w: any = {
          id: wfId,
          sequenceId: usage.sequenceId,
          activity,
          suspended: true,
          templateUuids: [],
          currentAction: { name: 'WorkflowState_AwaitTemplate' },
          aborted: false,
          WorkflowState_Abort: { name: 'WorkflowState_Abort' },
          async performState(st: any) {
            w.currentAction = st;
          },
        };
        liveWorkflows.set(wfId, w);
        return new Promise(resolve => {
          w.unSuspend = async (ctx: any) => {
            if (!ctx?.itemUseComplete) return;
            w.suspended = false;
            // an AREA activity: Midi-QOL ignores targetsToUse and takes the GM's current targets
            for (const tg of [...g.game.user.targets])
              docOf(tg).actor.system.attributes.hp.value -= 7;
            w.currentAction = { name: 'WorkflowState_Completed' };
            putBackTargets();
            resolve(w);
          };
        });
      }
      // A save activity: Midi rolls the target's save (not modelled here: every target fails) and applies the item's
      // effects (Workflow.ts WorkflowState_ApplyDynamicEffects 2651-2672, autoItemEffects on): EVERY effect the activity
      // lists, unless its midiProperties.chooseEffects is on; then Midi's chooseEffects asks in a DialogV2 that nobody
      // in the headless GM browser answers. Its pre-state hook runs first, with the workflow.
      if (activity.type === 'save') {
        const w: any = {
          id: wfId,
          sequenceId: usage.sequenceId,
          activity,
          currentAction: { name: 'WorkflowState_ApplyDynamicEffects' },
          aborted: false,
          attackRoll: null,
          chooseEffects(_effects: any[]) {
            openApps.set('DialogV2', { constructor: { name: 'DialogV2' }, close: async () => {} });
            return new Promise(() => {});
          },
        };
        const listed = (activity.effects ?? []).filter(
          (ed: any) => ed.effect && ed.onSave !== true
        );
        if (listed.length && midiConfig.autoItemEffects !== 'off') {
          await g.Hooks.midiCall('midi-qol.preApplyDynamicEffects', w);
          let effs = listed.map((ed: any) => ed.effect);
          if (midiDropsChosenEffect) effs = effs.slice(1);
          if (w.activity.midiProperties?.chooseEffects) effs = await w.chooseEffects(effs);
          for (const tg of targets)
            for (const ef of effs) docOf(tg).actor.effects.push({ name: ef.name });
        }
        if (midiAbortSaveSilently) {
          w.aborted = true;
          w.currentAction = { name: 'WorkflowState_Abort' };
          putBackTargets();
          return w;
        }
        w.currentAction = { name: 'WorkflowState_Cleanup' };
        putBackTargets();
        return w;
      }
      if (midiDelayMs) await new Promise(r => setTimeout(r, midiDelayMs));
      // ValidateRoll: Midi's own range check.
      const rv = rangeVerdict(activity, attDoc.object, targets);
      if (rv.result === 'fail')
        return {
          currentAction: { name: 'WorkflowState_RollFinished' },
          attackRoll: null,
          aborted: false,
        };
      const attribution: any = {};
      const add = (kind: string, src: string, name: string) => {
        attribution[kind] ??= {};
        attribution[kind][src] = name;
      };
      if (rv.result === 'dis') add('DIS', 'range', 'Long Range');
      if (evalFlag(actor, 'flags.midi-qol.advantage.attack.all'))
        add('ADV', 'attack.all', 'Pack Tactics - Advantage Attack (All)');
      const optional = !!midiConfig.optionalRulesEnabled;
      // checkAttackAdvantage reads the FIRST target (Workflow.ts `this.targets.first()`)
      const first = docOf(targets[0]);
      const ranged =
        ['rwak', 'rsak'].includes(activity.actionType) ||
        (item.system.properties?.has('thr') &&
          distance(attDoc, first) > (Number(item.system.range?.reach) || 5));
      if (
        optional &&
        midiRules.nearbyFoe &&
        ranged &&
        !evalFlag(actor, 'flags.midi-qol.ignoreNearbyFoes') &&
        nearbyFoe(attDoc.object, midiRules.nearbyFoe)
      )
        add('DIS', 'nearbyFoe', 'Nearby foe');
      // invisAdvantage RAW2024 (an optional rule): an attacker that cannot see its target has Disadvantage.
      if (optional && unseen.has(`${attDoc.id}>${first.id}`))
        add('DIS', 'Defender not detected', 'Defender not detected');
      const adv = !!attribution.ADV;
      const dis = !!attribution.DIS;
      const rolls = await activity.rollAttack(
        {
          // Midi's AttackActivity.rollAttack: config.attackMode ??= this.attackMode ?? 'oneHanded'
          attackMode: wo.attackMode ?? 'oneHanded',
          ...(adv ? { advantage: true } : {}),
          ...(dis ? { disadvantage: true } : {}),
        },
        { configure: false },
        {}
      );
      const roll = rolls[0];
      const crit = !!roll.isCritical;
      const fumble = !!roll.isFumble;
      // checkHits: the one roll against each target's AC (attackPerTarget off, the worlds' setting)
      const hits: any[] = [];
      const hitDisplayData: any = {};
      for (const tgt of targets) {
        const tDoc = docOf(tgt);
        const baseAc = tDoc.actor.system.attributes.ac.value;
        const ac = baseAc + (tDoc.cover === Infinity ? Infinity : tDoc.cover || 0);
        const hit = Number.isFinite(ac) && (crit || (!fumble && roll.total >= ac));
        // reactions: without DAE, a reaction prompt crashes the workflow (doReactions).
        if (hit && tDoc.actor.reactions?.length && !wo.noProvokeReaction && lateReactionMs) {
          // WITH DAE, the path the re-review named: the workflow is inside WaitForSaves (waiting, here on the reaction),
          // and leaves by an EARLY exit (Workflow.ts 2315 to 2327 or 2340), handing over SavesComplete, which hands over
          // AllRollsComplete, which applies the damage with no abort check. Midi's loop reads each next state from the
          // workflow object (`return this.WorkflowState_X`) and runs it while aborting (performState).
          const w = stuck(wfId, 'WorkflowState_WaitForSaves', undefined, usage.sequenceId);
          w.activity = activity;
          w.WorkflowState_SavesComplete = async function (this: any) {
            return this.WorkflowState_AllRollsComplete;
          };
          w.WorkflowState_AllRollsComplete = async function (this: any) {
            tDoc.actor.system.attributes.hp.value -= 5;
            return this.WorkflowState_Cleanup;
          };
          w.WorkflowState_Cleanup = { name: 'WorkflowState_Cleanup' };
          return new Promise(resolve => {
            setTimeout(async () => {
              // the early exit of WaitForSaves, then Midi's loop: run each state it is handed
              let next: any = w.WorkflowState_SavesComplete;
              for (let i = 0; i < 5 && typeof next === 'function'; i++) next = await next.call(w);
              resolve(w);
            }, lateReactionMs);
          });
        }
        if (hit && tDoc.actor.reactions?.length && !wo.noProvokeReaction) {
          const w = stuck(wfId, 'WorkflowState_AttackRollComplete', undefined, usage.sequenceId);
          w.activity = activity;
          return new Promise(() => {});
        }
        if (hit) hits.push(tgt);
        hitDisplayData[tDoc.uuid] = {
          ac,
          acDisplay: Number.isFinite(ac) ? String(ac) : 'infinite',
          baseAc,
          attackTotal: roll.total,
        };
      }
      const wf: any = {
        currentAction: { name: 'WorkflowState_Cleanup' },
        aborted: false,
        attackRoll: roll,
        attackTotal: roll.total,
        isCritical: crit,
        isFumble: fumble,
        hitTargets: new Set(hits),
        hitTargetsEC: new Set(),
        attackRollModifierTracker: { attribution },
        hitDisplayData,
        damageRolls: [],
        damageList: [],
      };
      if (hits.length) {
        // one damage roll for the whole workflow, applied to each target hit
        const dr = await activity.rollDamage({
          isCritical: crit,
          criticalDice: MIDI_CRIT_CHOICES.includes(midiConfig.criticalDamageGM),
          attackMode: wo.attackMode,
        });
        wf.damageRolls = dr ?? [];
        for (const tgt of hits) {
          const tDoc = docOf(tgt);
          const byType = new Map<string, number>();
          for (const r of wf.damageRolls)
            byType.set(r.options?.type, (byType.get(r.options?.type) ?? 0) + r.total);
          let total = 0;
          const detail: any[] = [];
          for (const [type, v] of byType) {
            const val = tDoc.actor.system.traits?.dr?.value?.has(type) ? Math.floor(v / 2) : v;
            detail.push({ type, value: val });
            total += val;
          }
          total = Math.max(0, total);
          const hp = tDoc.actor.system.attributes.hp;
          const hpDamage = Math.min(total, hp.value);
          wf.damageList.push({
            targetUuid: tDoc.uuid,
            oldHP: hp.value,
            newHP: hp.value - hpDamage,
            hpDamage,
            tempDamage: 0,
            totalDamage: total,
            damageDetail: detail,
          });
          if (midiConfig.autoApplyDamage === 'yes') hp.value -= hpDamage;
        }
      }
      return wf;
    },
  };
}

function world(opts: {
  targetFeet: number;
  dagger?: any;
  extraTokens?: Tok[];
  attackerItems?: any[];
  attackerFlags?: any;
  target?: any;
  targetCover?: number;
}) {
  const dagger = opts.dagger ?? makeDagger(1);
  const kobold = makeActor(
    'Kobold Warrior',
    opts.attackerItems ?? [dagger],
    7,
    14,
    opts.attackerFlags
  );
  const brakka = opts.target ?? makeActor('Brakka', [], 20, 16);
  install([
    { id: 'kobold', name: 'Kobold Warrior', sq: 0, disposition: -1, actor: kobold },
    {
      id: 'brakka',
      name: 'Brakka',
      sq: opts.targetFeet / FT,
      disposition: 1,
      actor: brakka,
      ...(opts.targetCover !== undefined ? { cover: opts.targetCover } : {}),
    },
    ...(opts.extraTokens ?? []),
  ]);
  return { dagger, kobold, brakka };
}

async function attack(item = 'Dagger', targets = ['brakka'], itemId?: string, more: any = {}) {
  const h = new QueryHandlers() as any;
  h.midiAttackTimeoutMs = 60;
  return h.handleExecuteAttack({
    attacker: 'kobold',
    item,
    targets,
    ...(itemId ? { itemId } : {}),
    ...more,
  });
}

beforeEach(() => {
  rollCalls = [];
  damageCalls = [];
  warnings = [];
  d20Queue = [];
  midiCalls = [];
  applyDamageCalls = [];
  openApps = new Map();
  liveWorkflows = new Map();
  walls = new Set();
  wallsOnFt = new Map();
  midiRules = { wallsBlockRange: 'center', nearbyFoe: 5, checkRange: 'longFail' };
  // The test world's own Midi-QOL settings (read 2026-09-27): optional rules off, GM critical damage 'default' here
  // (the world holds 'none'; that case has its own tests), damage applied automatically.
  midiConfig = { optionalRulesEnabled: false, criticalDamageGM: 'default', autoApplyDamage: 'yes' };
  midiThrows = {};
  unseen = new Set();
  midiDelayMs = 0;
  stuckDialogs = ['AttackRollConfigurationDialog'];
  lateReactionMs = 0;
  midiRefuseOver = 0;
  midiAbortLateOver = 0;
  otherToast = '';
  midiAbortSaveSilently = false;
  midiDropsChosenEffect = false;
});

describe("bridge 0.10.8: the attack is Midi-QOL's own workflow (engine map M07)", () => {
  it('asks Midi-QOL once per target, naming the attack mode, with no dialog and reactions off', async () => {
    world({ targetFeet: 5 });
    await attack();
    expect(midiCalls).toHaveLength(1);
    const mo = midiCalls[0].usage.midiOptions;
    expect([...mo.targetsToUse].map((t: any) => t.id)).toEqual(['brakka']);
    expect(mo).toMatchObject({
      autoRollAttack: true,
      fastForwardAttack: true,
      autoRollDamage: 'onHit',
      fastForwardDamage: true,
      workflowOptions: {
        attackMode: 'oneHanded',
        targetConfirmation: 'none',
        noProvokeReaction: true,
      },
    });
    expect(midiCalls[0].dialog).toEqual({ configure: false });
  });

  it("the hit is Midi's: a total above the target's own AC misses when Midi's AC (cover) is higher", async () => {
    world({ targetFeet: 5, targetCover: 5 });
    d20Queue = [14]; // 14 + 4 = 18: at least the target's own AC 16, below Midi's 16 + 5 = 21
    const res = await attack();
    const r = res.results[0];
    expect(r.attackTotal).toBe(18);
    expect(r.hit).toBe(false);
    expect(r.targetAC).toBe(21);
    expect(r.targetBaseAC).toBe(16);
    expect(r.damage).toBe(0);
  });

  it('total cover: a miss, and the answer says total cover', async () => {
    world({ targetFeet: 5, targetCover: Infinity });
    d20Queue = [19];
    const res = await attack();
    expect(res.results[0].hit).toBe(false);
    expect(res.results[0].totalCover).toBe(true);
    expect(res.results[0].targetAC).toBe(16); // a number, as the brain has always read it: the target's own AC
  });

  it("advantage is Midi's (a Midi flag, Pack Tactics as data), with Midi's own reason", async () => {
    const dagger = makeDagger(1);
    world({
      targetFeet: 5,
      dagger,
      attackerItems: [dagger],
      attackerFlags: { 'midi-qol': { advantage: { attack: { all: 'true' } } } },
    });
    const res = await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'oneHanded', advantage: true });
    const r = res.results[0];
    expect(r.formula).toBe('2d20adv + 2 + 2');
    expect(r.advantage).toBe(true);
    expect(r.rollMode).toBe('advantage');
    expect(r.advantageReasons).toEqual(['Pack Tactics - Advantage Attack (All)']);
    expect(r.disadvantage).toBe(false);
  });

  it("a critical hit's damage dice are the engine's: the bridge rolls no dice of its own", async () => {
    world({ targetFeet: 5 });
    d20Queue = [20];
    const res = await attack();
    const r = res.results[0];
    expect(r.crit).toBe(true);
    expect(r.hit).toBe(true);
    expect(damageCalls).toHaveLength(1);
    expect(damageCalls[0]).toMatchObject({ isCritical: true });
    expect(r.damageRolled).toBe(6); // 2d4 + 2 from the engine, not 1d4 + 2 plus dice of our own
    expect(r.damageRolls).toEqual([{ formula: '2d4 + 2', total: 6, type: 'piercing' }]);
    expect(res.ruleWarnings).toBeUndefined();
  });

  it("Midi's GM critical setting 'none' (it adds no dice): the critical is reported, not patched", async () => {
    midiConfig.criticalDamageGM = 'none';
    world({ targetFeet: 5 });
    d20Queue = [20];
    const res = await attack();
    expect(res.results[0].damageRolled).toBe(4);
    expect(res.ruleWarnings?.join(' ')).toMatch(/critical damage setting for the GM is 'none'/);
  });

  it("the damage is Midi's damage list, applied by Midi: resistance halves it, the bridge applies nothing", async () => {
    const brakka = makeActor('Brakka', [], 20, 16, {}, { resist: ['piercing'] });
    world({ targetFeet: 5, target: brakka });
    d20Queue = [15];
    const res = await attack();
    const r = res.results[0];
    expect(r.hit).toBe(true);
    expect(r.damageRolled).toBe(4);
    expect(r.damageApplied).toBe(2);
    expect(r.damageDetail).toEqual([{ type: 'piercing', value: 2 }]);
    expect(brakka.system.attributes.hp.value).toBe(18);
    expect(r.hpAfter).toBe(18);
    expect(r.damage).toBe(2);
    expect(applyDamageCalls).toHaveLength(0);
  });

  it('Midi worked out damage but did not apply it (its setting): said, never hidden', async () => {
    midiConfig.autoApplyDamage = 'no';
    world({ targetFeet: 5 });
    d20Queue = [15];
    const res = await attack();
    expect(res.results[0].hit).toBe(true);
    expect(res.results[0].damage).toBe(0);
    expect(res.ruleWarnings?.join(' ')).toMatch(/hit points did not change/);
  });

  it('a spell attack: dnd5e spends the slot inside the workflow; the bridge spends none of its own', async () => {
    const bolt = makeWeapon({
      name: 'Guiding Bolt',
      type: 'spell',
      quantity: 1,
      level: 1,
      range: { value: 120, long: null, units: 'ft' },
      properties: [],
      attackModes: [],
      actionType: 'rsak',
    });
    const { kobold } = world({ targetFeet: 30, dagger: bolt, attackerItems: [bolt] });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    d20Queue = [15];
    const res = await attack('Guiding Bolt');
    expect(res.success).toBe(true);
    expect(midiCalls).toHaveLength(1);
    expect(midiCalls[0].usage.midiOptions.workflowOptions.attackMode).toBeUndefined();
    expect(kobold.system.spells.spell1.value).toBe(1);
  });

  it("a spell attack's answer has no attack mode (as before), though Midi's roll carries 'oneHanded'", async () => {
    const bolt = makeWeapon({
      name: 'Fire Bolt',
      type: 'spell',
      quantity: 1,
      range: { value: 120, long: null, units: 'ft' },
      properties: [],
      attackModes: [],
      actionType: 'rsak',
    });
    world({ targetFeet: 30, dagger: bolt, attackerItems: [bolt] });
    const res = await attack('Fire Bolt');
    expect(rollCalls[0].mode).toBe('oneHanded'); // what dnd5e/Midi put on the roll
    expect(res.results[0].attackMode).toBeNull();
    expect(res.results[0].thrown).toBe(false);
  });

  it('a levelled SAVE spell: dnd5e spends its slot inside the workflow; the bridge spends no second one', async () => {
    const whispers = makeWeapon({
      name: 'Dissonant Whispers',
      type: 'spell',
      quantity: 1,
      level: 1,
      range: { value: 60, long: null, units: 'ft' },
      properties: [],
      attackModes: [],
      actionType: 'save',
    });
    const act = whispers.system.activities.contents[0];
    act.type = 'save';
    delete act.attack;
    act.save = {};
    const { kobold } = world({ targetFeet: 30, dagger: whispers, attackerItems: [whispers] });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    const res = await attack('Dissonant Whispers');
    expect(res.success).toBe(true);
    expect(res.results[0].via).toBe('save');
    expect(midiCalls).toHaveLength(1);
    expect(kobold.system.spells.spell1.value).toBe(1);
  });

  it('every field the live brain reads is still there, plus what Midi decided', async () => {
    world({ targetFeet: 10 });
    const res = await attack();
    const r = res.results[0];
    for (const k of [
      'target',
      'hpBefore',
      'hpAfter',
      'damage',
      'hit',
      'crit',
      'fumble',
      'attackTotal',
      'damageRolled',
      'damageApplied',
      'damageType',
      'targetAC',
      'via',
      'error',
      'formula',
      'attackMode',
      'thrown',
      'remaining',
      'usedUp',
      'disadvantage',
      'disadvantageReasons',
      'rangeVerdict',
      'distanceFt',
    ])
      expect(r).toHaveProperty(k);
    expect(r.via).toBe('attack');
    expect(r.engine).toBe('midi-qol');
    expect(r.reactions).toBe('off');
    expect(r.midiState).toBe('WorkflowState_Cleanup');
    expect(res.attackerId).toBe('kobold');
    expect(res.itemId).toBe('itemDagger');
  });
});

describe('a Midi-QOL workflow that never finishes is stopped and said, never a hung fight', () => {
  it('a roll dialog nobody can answer: stopped after the wait, the dialog closed, the workflow aborted', async () => {
    const dagger = makeDagger(2, { midiProperties: { forceRollDialog: 'always' } });
    world({
      targetFeet: 5,
      dagger,
      attackerItems: [dagger],
      extraTokens: [
        {
          id: 'nim',
          name: 'Nim',
          sq: 1,
          sy: 1,
          disposition: 1,
          actor: makeActor('Nim', [], 10, 13),
        },
      ],
    });
    const res = await attack('Dagger', ['brakka', 'nim']);
    const [a, b] = res.results;
    expect(a.hit).toBe(false);
    expect(a.error).toMatch(/did not finish within/);
    expect(a.error).toMatch(/stopped at WorkflowState_WaitForAttackRoll/);
    expect(a.error).toMatch(/AttackRollConfigurationDialog/);
    expect(openApps.size).toBe(0);
    expect([...liveWorkflows.values()][0].abortedByBridge).toBe(true);
    // the second target is not attacked into the same stuck engine
    expect(midiCalls).toHaveLength(1);
    expect(b.error).toMatch(/^not attacked: /);
    expect(res.ruleWarnings?.join(' ')).toMatch(/did not go through Midi-QOL's workflow/);
  });

  it("reactions switched on (the caller asks) and a target with one: Midi's crash without DAE is stopped and said", async () => {
    const knight = makeActor('Brakka', [], 20, 16, {}, { reactions: ['Parry'] });
    world({ targetFeet: 5, target: knight });
    d20Queue = [15];
    const res = await attack('Dagger', ['brakka'], undefined, { reactions: true });
    expect(midiCalls[0].usage.midiOptions.workflowOptions.noProvokeReaction).toBeUndefined();
    expect(res.results[0].error).toMatch(/stopped at WorkflowState_AttackRollComplete/);
    expect(res.results[0].reactions).toBe('on');
    expect(knight.system.attributes.hp.value).toBe(20);
  });

  it('reactions off (the default): the same hit on the same target goes through', async () => {
    const knight = makeActor('Brakka', [], 20, 16, {}, { reactions: ['Parry'] });
    world({ targetFeet: 5, target: knight });
    d20Queue = [15];
    const res = await attack();
    expect(res.results[0].hit).toBe(true);
    expect(res.results[0].error).toBeNull();
    expect(knight.system.attributes.hp.value).toBe(16);
  });
});

describe('FS-07: a Dagger kobold at 10, 45 and 70 ft', () => {
  it('10 ft: thrown (beyond its 5 ft reach), NO disadvantage, and the Dagger is used up', async () => {
    const { dagger } = world({ targetFeet: 10 });
    const res = await attack();
    expect(res.success).toBe(true);
    expect(rollCalls).toHaveLength(1);
    expect(rollCalls[0].config.attackMode).toBe('thrown');
    expect(rollCalls[0].config.disadvantage).toBeUndefined();
    expect(rollCalls[0].advantageMode).toBe(0);
    const r = res.results[0];
    expect(r.attackMode).toBe('thrown');
    expect(r.thrown).toBe(true);
    expect(r.disadvantage).toBe(false);
    expect(r.rangeVerdict).toBe('normal');
    expect(r.formula).toBe('1d20 + 2 + 2');
    expect(dagger.system.quantity).toBe(0);
    expect(r.remaining).toBe(0);
  });

  it("45 ft: thrown WITH disadvantage, decided by Midi-QOL's workflow, with Midi's reason", async () => {
    world({ targetFeet: 45 });
    const res = await attack();
    expect(midiCalls[0].usage.midiOptions.workflowOptions.attackMode).toBe('thrown');
    expect(midiCalls[0].usage.midiOptions.disadvantage).toBeUndefined();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown', disadvantage: true });
    const r = res.results[0];
    expect(r.formula).toBe('2d20dis + 2 + 2');
    expect(r.disadvantage).toBe(true);
    expect(r.disadvantageReasons).toEqual(['Long Range']);
    expect(r.rangeVerdict).toBe('dis');
  });

  it('70 ft: refused with the distance Midi-QOL measured and the weapon range; Midi is not asked to roll', async () => {
    const { dagger } = world({ targetFeet: 70 });
    const res = await attack();
    expect(res.refused).toBe(true);
    expect(rollCalls).toHaveLength(0);
    expect(midiCalls).toHaveLength(0);
    const r = res.results[0];
    expect(r.outOfRange).toBe(true);
    expect(r.distanceFt).toBe(70);
    expect(r.note).toBe('Brakka is 70 ft away, beyond the range of Dagger (range 20/60 ft)');
    expect(r.blockedByWall).toBeUndefined();
    expect(dagger.system.quantity).toBe(1);
  });
});

describe('a refusal says why (#1761)', () => {
  it('a wall between them: "a wall is in the way", never "beyond the range"', async () => {
    world({ targetFeet: 10 });
    walls.add(key({ id: 'kobold' }, { id: 'brakka' }));
    const res = await attack();
    expect(res.refused).toBe(true);
    const r = res.results[0];
    expect(r.blockedByWall).toBe(true);
    expect(r.outOfRange).toBeUndefined();
    expect(r.note).toBe('a wall is in the way: Dagger cannot reach Brakka');
    expect(r.note).not.toMatch(/beyond the range/);
    expect(rollCalls).toHaveLength(0);
  });

  it('the distance reported is the one Midi-QOL measured with its wall rule, not a walls-off one', async () => {
    world({ targetFeet: 55 });
    // With walls on, the only open line is longer (65 ft, past long range 60); walls off it is 55.
    wallsOnFt.set(key({ id: 'kobold' }, { id: 'brakka' }), 65);
    const res = await attack();
    expect(res.refused).toBe(true);
    expect(res.results[0].distanceFt).toBe(65);
    expect(res.results[0].note).toMatch(/^Brakka is 65 ft away/);
  });
});

describe('the attack mode is always named', () => {
  it('adjacent (5 ft): a melee stab, the Dagger is kept, even when dnd5e remembers a throw', async () => {
    const dagger = makeDagger(2, { remembered: 'thrown' });
    world({ targetFeet: 5, dagger });
    d20Queue = [15]; // a hit, so damage is rolled too
    const res = await attack();
    expect(rollCalls[0].config.attackMode).toBe('oneHanded');
    expect(rollCalls[0].mode).toBe('oneHanded');
    expect(res.results[0].thrown).toBe(false);
    expect(dagger.system.quantity).toBe(2);
    expect(damageCalls[0]).toMatchObject({ attackMode: 'oneHanded' });
  });

  it('a Returning weapon is thrown and dnd5e keeps its quantity', async () => {
    const dagger = makeDagger(1, { properties: ['fin', 'lgt', 'thr', 'ret'] });
    world({ targetFeet: 15, dagger });
    const res = await attack();
    expect(rollCalls[0].config.attackMode).toBe('thrown');
    expect(dagger.system.quantity).toBe(1);
    expect(res.results[0].remaining).toBe(1);
  });

  it('a weapon that can only be thrown (a Dart) is thrown even at 5 ft (unchanged: dnd5e picks it too)', async () => {
    const dart = makeWeapon({
      name: 'Dart',
      quantity: 10,
      range: { value: 20, long: 60, reach: null },
      properties: ['fin', 'thr'],
      attackModes: [{ value: 'thrown' }],
      actionType: 'rwak',
    });
    world({ targetFeet: 5, dagger: dart, attackerItems: [dart] });
    await attack('Dart');
    expect(rollCalls[0].mode).toBe('thrown');
    expect(dart.system.quantity).toBe(9);
  });
});

describe('a used-up weapon is never used again (HOUSE RULE, moves to the aidm-rules add-on)', () => {
  it('quantity 0: refused, says so, and the engine is never asked', async () => {
    world({ targetFeet: 10, dagger: makeDagger(0) });
    const res = await attack();
    expect(res.refused).toBe(true);
    expect(res.results[0].noWeaponLeft).toBe(true);
    expect(res.results[0].note).toBe(
      'Kobold Warrior has no Dagger left to attack with (all of them were used up)'
    );
    expect(rollCalls).toHaveLength(0);
    expect(midiCalls).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('two targets and one Dagger: the first is thrown, the second is refused', async () => {
    const { dagger } = world({
      targetFeet: 10,
      extraTokens: [
        { id: 'nim', name: 'Nim', sq: 3, disposition: 1, actor: makeActor('Nim', [], 10, 13) },
      ],
    });
    const res = await attack('Dagger', ['brakka', 'nim']);
    expect(rollCalls).toHaveLength(1);
    expect(res.results[0].thrown).toBe(true);
    expect(res.results[1].noWeaponLeft).toBe(true);
    expect(dagger.system.quantity).toBe(0);
  });
});

describe("ranged attacks in close combat: Midi-QOL's own rule, as the world has it set", () => {
  const orenNextToTheThrower = () => ({
    id: 'oren',
    name: 'Oren',
    sq: 0,
    sy: 1,
    disposition: 1,
    actor: makeActor('Oren', []),
  });

  it("Midi's optional rules OFF (both worlds today): no close-combat disadvantage, and the bridge adds none", async () => {
    world({ targetFeet: 15, extraTokens: [orenNextToTheThrower()] });
    const res = await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown' });
    expect(res.results[0].disadvantage).toBe(false);
    expect(res.results[0].disadvantageReasons).toEqual([]);
  });

  it("Midi's optional rules ON: Midi gives the disadvantage and its reason is passed on", async () => {
    midiConfig.optionalRulesEnabled = true;
    world({ targetFeet: 15, extraTokens: [orenNextToTheThrower()] });
    const res = await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown', disadvantage: true });
    expect(res.results[0].disadvantageReasons).toEqual(['Nearby foe']);
  });

  it("optional rules ON and Midi's own opt-out on the thrower (ignoreNearbyFoes): no disadvantage", async () => {
    midiConfig.optionalRulesEnabled = true;
    const dagger = makeDagger(1);
    world({
      targetFeet: 15,
      dagger,
      attackerItems: [dagger],
      attackerFlags: { 'midi-qol': { ignoreNearbyFoes: 'true' } },
      extraTokens: [orenNextToTheThrower()],
    });
    await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown' });
  });

  it('guard: a melee stab with an enemy next to the attacker, no disadvantage', async () => {
    midiConfig.optionalRulesEnabled = true;
    world({ targetFeet: 5, extraTokens: [orenNextToTheThrower()] });
    await attack();
    expect(rollCalls[0].config.disadvantage).toBeUndefined();
    expect(rollCalls[0].advantageMode).toBe(0);
  });
});

describe('unchanged behaviour (guards)', () => {
  it('a hit still rolls damage and applies it to the target', async () => {
    const { brakka } = world({ targetFeet: 5 });
    d20Queue = [15];
    const res = await attack();
    expect(res.results[0].hit).toBe(true);
    expect(brakka.system.attributes.hp.value).toBe(16);
    expect(res.results[0].damage).toBe(4);
  });

  it('a melee-only weapon out of reach walks in first and then swings', async () => {
    const club = makeWeapon({
      name: 'Club',
      quantity: 1,
      range: { value: null, long: null, reach: 5 },
      properties: ['lgt'],
      attackModes: [{ value: 'oneHanded' }, { value: 'offhand' }],
    });
    world({ targetFeet: 20, dagger: club, attackerItems: [club] });
    const res = await attack('Club');
    expect(res.success).toBe(true);
    expect(tokens.get('kobold').x).toBe(300);
    expect(rollCalls).toHaveLength(1);
  });
});

// ================================================================================================
// Board #1887, operator decision 2026-09-27 "Unarmed Strike": a monster with no weapon left makes an
// Unarmed Strike, rolled with dnd5e's OWN item (Compendium.dnd5e.equipment24.Item.phbUnarmedStrike for
// the 2024 rules), never added to the monster. The stand-in below follows what the test stack measured
// on 2026-09-27 for a Kobold Warrior (Str 7, PB 2): before dnd5e's final item preparation the attack
// was `1d20 - 2` (no proficiency) and no damage was rolled; after it, `1d20 - 2 + 2` and `1 - 2`
// bludgeoning. dnd5e only remembers the last attack mode on an item its actor holds. Bridge 0.10.8: the
// temporary item goes through Midi-QOL's workflow like any weapon (measured on the test stack: it does).
// ================================================================================================
let uuidAsked: string[] = [];
let unarmedLoads = true;

class FakeItem5e {
  id: string;
  name: string;
  type: string;
  flags: any = {};
  isOwner = true;
  inCompendium = false;
  effects: any[] = [];
  parent: any;
  prepared = false;
  system: any;
  constructor(data: any, opts: any = {}) {
    this.id = data._id;
    this.name = data.name;
    this.type = data.type;
    this.parent = opts.parent;
    const item = this;
    const activity: any = {
      id: 'X96HnXRaVti0SXqJ',
      uuid: 'temp.Activity.X96HnXRaVti0SXqJ',
      type: 'attack',
      actionType: 'mwak',
      attack: { ability: 'str' },
      item,
      midiProperties: {},
      async rollAttack(config: any = {}) {
        const die = d20Queue.length ? d20Queue.shift()! : 10;
        const prof = item.prepared ? 2 : 0;
        const roll = {
          formula: item.prepared ? '1d20 - 2 + 2' : '1d20 - 2',
          total: die - 2 + prof,
          isCritical: die === 20,
          isFumble: die === 1,
          options: { attackMode: config.attackMode ?? 'oneHanded', advantageMode: 0 },
        };
        // dnd5e 5.3.3: `this.actor.items.has(this.item.id)` guards the remembered-mode write.
        if (item.parent?.items?.has?.(item.id))
          setProperty(item.flags, `dnd5e.last.${activity.id}.attackMode`, roll.options.attackMode);
        rollCalls.push({
          config: { ...config },
          mode: roll.options.attackMode,
          prepared: item.prepared,
        });
        return [roll];
      },
      async rollDamage(config: any = {}) {
        damageCalls.push({ ...config });
        if (!item.prepared) return null;
        return [{ total: -1, formula: '1 - 2', options: { type: 'bludgeoning' }, terms: [] }];
      },
    };
    this.system = {
      quantity: 1,
      range: { value: null, long: null, reach: null, units: 'ft' },
      properties: new Set(),
      attackModes: [{ value: 'oneHanded' }],
      type: { value: 'natural' },
      level: 0,
      activities: new ValueCollection([activity]),
    };
  }
  getFlag(scope: string, key: string) {
    return getProperty(this.flags, `${scope}.${key}`);
  }
  prepareFinalAttributes() {
    this.prepared = true;
  }
}

function withDnd5eUnarmedStrike() {
  const g: any = globalThis;
  g.fromUuid = async (uuid: string) => {
    uuidAsked.push(uuid);
    if (!unarmedLoads) return null;
    return {
      toObject: () => ({
        _id: uuid.endsWith('phbUnarmedStrike') ? 'phbUnarmedStrike' : 'GsuvwoekKZatfKwF',
        name: 'Unarmed Strike',
        type: 'weapon',
      }),
    };
  };
  g.CONFIG = { Item: { documentClass: FakeItem5e } };
}

describe('no weapon left: an Unarmed Strike, the dnd5e way (operator "Unarmed Strike")', () => {
  beforeEach(() => {
    uuidAsked = [];
    unarmedLoads = true;
    const g: any = globalThis;
    delete g.fromUuid;
    delete g.CONFIG;
  });

  it("uses dnd5e's own 2024 Unarmed Strike, fully prepared, through Midi, and adds nothing to the monster", async () => {
    const { kobold } = world({ targetFeet: 5, dagger: makeDagger(0) });
    withDnd5eUnarmedStrike();
    d20Queue = [18]; // 18 - 2 + 2 = 18 hits AC 16
    const res = await attack('Unarmed Strike');
    expect(uuidAsked).toEqual(['Compendium.dnd5e.equipment24.Item.phbUnarmedStrike']);
    expect(res.success).toBe(true);
    expect(res.item).toBe('Unarmed Strike');
    expect(midiCalls).toHaveLength(1);
    expect(rollCalls).toHaveLength(1);
    expect(rollCalls[0].prepared).toBe(true); // Str + proficiency, as dnd5e prepares it
    expect(rollCalls[0].config.attackMode).toBe('oneHanded');
    const r = res.results[0];
    expect(r.unarmed).toBe(true);
    expect(r.formula).toBe('1d20 - 2 + 2');
    expect(r.hit).toBe(true);
    expect(r.thrown).toBe(false);
    // the monster keeps exactly what it had: one used-up Dagger, no new item, no remembered mode written
    expect([...kobold.items.keys()]).toEqual(['itemDagger']);
    expect(kobold.items.get('itemDagger').system.quantity).toBe(0);
  });

  it("a hit whose damage roll is below 0 deals 0 (Midi's own floor) and never heals the target", async () => {
    const { brakka } = world({ targetFeet: 5, dagger: makeDagger(0) });
    withDnd5eUnarmedStrike();
    d20Queue = [18]; // 18 - 2 + 2 = 18 hits AC 16
    const res = await attack('Unarmed Strike');
    const r = res.results[0];
    expect(r.hit).toBe(true);
    expect(r.damageRolled).toBe(-1);
    expect(r.damageApplied).toBe(0);
    expect(r.damage).toBe(0);
    expect(brakka.system.attributes.hp.value).toBe(20);
  });

  it("a 2014-rules world uses dnd5e's 2014 Unarmed Strike", async () => {
    world({ targetFeet: 5, dagger: makeDagger(0) });
    withDnd5eUnarmedStrike();
    const g: any = globalThis;
    const midiGet = g.game.settings.get;
    g.game.settings.get = (scope: string, name: string) =>
      scope === 'dnd5e' && name === 'rulesVersion' ? 'legacy' : midiGet(scope, name);
    const res = await attack('Unarmed Strike');
    expect(uuidAsked).toEqual(['Compendium.dnd5e.items.Item.GsuvwoekKZatfKwF']);
    expect(res.results[0].unarmed).toBe(true);
  });

  it("dnd5e's item cannot be loaded: an error that says so, and nothing is rolled", async () => {
    world({ targetFeet: 5, dagger: makeDagger(0) });
    withDnd5eUnarmedStrike();
    unarmedLoads = false;
    await expect(attack('Unarmed Strike')).rejects.toThrow(
      /Item not found on attacker: Unarmed Strike \(dnd5e's own Unarmed Strike could not be loaded/
    );
    expect(rollCalls).toHaveLength(0);
  });

  it('guard (unchanged): a creature with its own Unarmed Strike item uses that item', async () => {
    const own = makeWeapon({
      name: 'Unarmed Strike',
      quantity: 1,
      range: { value: null, long: null, reach: 5 },
      properties: [],
      attackModes: [{ value: 'oneHanded' }],
    });
    world({ targetFeet: 5, dagger: own, attackerItems: [own] });
    withDnd5eUnarmedStrike();
    const res = await attack('Unarmed Strike');
    expect(uuidAsked).toEqual([]);
    expect(res.results[0].unarmed).toBeUndefined();
    expect(rollCalls[0].config.attackMode).toBe('oneHanded');
  });

  it('guard (unchanged): any other missing item is still "Item not found"', async () => {
    world({ targetFeet: 5 });
    withDnd5eUnarmedStrike();
    await expect(attack('Longsword')).rejects.toThrow('Item not found on attacker: Longsword');
    expect(uuidAsked).toEqual([]);
  });
});

describe("damage below 0 deals 0 for every weapon (Midi-QOL's own floor)", () => {
  it('a Dagger damage roll of -1 leaves the target untouched', async () => {
    const dagger = makeDagger(1);
    dagger.system.activities.contents[0].rollDamage = async (config: any = {}) => {
      damageCalls.push({ ...config });
      return [{ total: -1, options: { type: 'piercing' }, terms: [] }];
    };
    const { brakka } = world({ targetFeet: 5, dagger });
    d20Queue = [15];
    const res = await attack();
    expect(res.results[0].hit).toBe(true);
    expect(res.results[0].damageApplied).toBe(0);
    expect(brakka.system.attributes.hp.value).toBe(20);
  });
});

// ================================================================================================
// Board #1887, independent review of bridge 0.10.7 (dfd2d515 + 6d6441be + fork 63d553c), findings 2 and 5.
// ================================================================================================
function javelin(id: string, quantity: number) {
  return makeWeapon({
    id,
    name: 'Javelin',
    quantity,
    range: { value: 30, long: 120, reach: 5 },
    properties: ['thr'],
    attackModes: [{ value: 'oneHanded' }, { rule: true }, { value: 'thrown' }],
  });
}

describe('finding 2: which item an attack by name means', () => {
  it('an empty Javelin stack next to a new one: the new stack is thrown, not refused', async () => {
    const empty = javelin('jvEmpty000000000', 0);
    const fresh = javelin('jvFresh000000000', 3);
    world({ targetFeet: 20, attackerItems: [empty, fresh] });
    const res = await attack('Javelin');
    expect(res.refused).toBeUndefined();
    expect(res.success).toBe(true);
    expect(res.itemId).toBe('jvFresh000000000');
    expect(fresh.system.quantity).toBe(2);
    expect(empty.system.quantity).toBe(0);
  });

  it('the caller names the exact stack by id: that one is used', async () => {
    const a = javelin('jvA0000000000000', 2);
    const b = javelin('jvB0000000000000', 2);
    world({ targetFeet: 20, attackerItems: [a, b] });
    const res = await attack('Javelin', ['brakka'], 'jvB0000000000000');
    expect(res.itemId).toBe('jvB0000000000000');
    expect(b.system.quantity).toBe(1);
    expect(a.system.quantity).toBe(2);
    expect(res.ruleWarnings).toBeUndefined();
  });

  it('an id the attacker does not hold: looked up by name, and the answer says so', async () => {
    const a = javelin('jvA0000000000000', 2);
    world({ targetFeet: 20, attackerItems: [a] });
    const res = await attack('Javelin', ['brakka'], 'nope000000000000');
    expect(res.itemId).toBe('jvA0000000000000');
    expect(res.ruleWarnings?.[0]).toMatch(/no item with id nope000000000000/);
  });

  it("every answer names the attacker's token and the item used (a refusal too)", async () => {
    world({ targetFeet: 70 });
    const res = await attack();
    expect(res.refused).toBe(true);
    expect(res.attackerId).toBe('kobold');
    expect(res.itemId).toBe('itemDagger');
  });
});

describe('finding 5: a check the engine could not make is reported, never dropped quietly', () => {
  it("Midi-QOL's settings cannot be read: the attack goes on and the answer says the default was used", async () => {
    midiThrows.settings = true;
    world({ targetFeet: 10 });
    const res = await attack();
    expect(res.success).toBe(true);
    expect(res.ruleWarnings?.join(' ')).toMatch(/settings could not be read/);
  });

  it('the range check throws: reported', async () => {
    midiThrows.checkActivityRange = true;
    world({ targetFeet: 45 });
    const res = await attack();
    expect(res.ruleWarnings?.join(' ')).toMatch(/range check failed for Brakka/);
  });

  it('the walls-off distance throws: reported', async () => {
    midiThrows.distanceWallsOff = true;
    world({ targetFeet: 10 });
    const res = await attack();
    expect(res.ruleWarnings?.join(' ')).toMatch(/walls off\) could not be measured/);
  });

  it('the walls-on distance throws while refusing: reported, and the refusal gives no distance', async () => {
    midiThrows.distanceWallsOn = true;
    world({ targetFeet: 70 });
    const res = await attack();
    expect(res.refused).toBe(true);
    expect(res.results[0].distanceFt).toBeUndefined();
    expect(res.ruleWarnings?.join(' ')).toMatch(/walls on\) could not be measured/);
  });

  it('an attack no longer asks the sight check at all, so it cannot fail on it (Midi decides unseen targets)', async () => {
    midiThrows.canSee = true;
    world({ targetFeet: 10 });
    const res = await attack();
    expect(res.success).toBe(true);
    expect(res.ruleWarnings).toBeUndefined();
  });

  it('guard: a normal attack carries no warnings at all', async () => {
    world({ targetFeet: 10 });
    const res = await attack();
    expect(res.ruleWarnings).toBeUndefined();
  });
});

// ================================================================================================
// Board #1887, re-review of fork 876a95d (HOLD): the brain gives a character back what it threw after a fight, so the
// answer must say how many the roll REALLY used up (quantity before minus after), not "the mode was thrown".
// ================================================================================================
describe('usedUp: how many the roll really used up', () => {
  it('a normal throw uses one up', async () => {
    const dagger = makeDagger(2);
    world({ targetFeet: 10, dagger, attackerItems: [dagger] });
    const res = await attack();
    expect(res.results[0].thrown).toBe(true);
    expect(res.results[0].usedUp).toBe(1);
    expect(dagger.system.quantity).toBe(1);
  });

  it('a Returning weapon is thrown three times and nothing is used up (the reviewer case: 1 came back as 4)', async () => {
    const dagger = makeDagger(1, { properties: ['thr', 'ret'] });
    world({ targetFeet: 10, dagger, attackerItems: [dagger] });
    for (let i = 0; i < 3; i++) {
      const res = await attack();
      expect(res.results[0].thrown).toBe(true);
      expect(res.results[0].usedUp).toBe(0);
    }
    expect(dagger.system.quantity).toBe(1);
  });

  it('a workflow that failed uses nothing up, and says why', async () => {
    const dagger = makeDagger(1);
    world({ targetFeet: 10, dagger, attackerItems: [dagger] });
    midiThrows.completeActivityUse = true;
    const res = await attack();
    expect(res.results[0].thrown).toBe(true);
    expect(res.results[0].usedUp).toBe(0);
    expect(res.results[0].error).toMatch(/dialog was closed/);
    expect(dagger.system.quantity).toBe(1);
  });

  it('a melee stab uses nothing up', async () => {
    world({ targetFeet: 5 });
    const res = await attack();
    expect(res.results[0].thrown).toBe(false);
    expect(res.results[0].usedUp).toBe(0);
  });
});

// ================================================================================================
// Board #1887, independent review of bridge 0.10.8 (618a313, HOLD): the blocker and the non-blocking fixes.
// ================================================================================================
function levelledSpell(name: string, level = 1) {
  return makeWeapon({
    name,
    type: 'spell',
    quantity: 1,
    level,
    range: { value: 120, long: null, units: 'ft' },
    properties: [],
    attackModes: [],
    actionType: 'rsak',
  });
}

const nimAt = (sq: number, sy = 0) => ({
  id: 'nim',
  name: 'Nim',
  sq,
  sy,
  disposition: 1,
  actor: makeActor('Nim', [], 10, 13),
});

describe('BLOCKER: a spell that spends a slot is cast ONCE for all its targets', () => {
  it('a levelled spell attack at two targets: one Midi workflow with both targets, exactly one slot spent', async () => {
    const bolt = levelledSpell('Scorching Ray', 2);
    const { kobold } = world({
      targetFeet: 30,
      dagger: bolt,
      attackerItems: [bolt],
      extraTokens: [nimAt(8)],
    });
    kobold.system.spells = { spell2: { value: 2, max: 2 } };
    d20Queue = [15]; // one roll for the one workflow: 19 hits AC 16 (Brakka) and AC 13 (Nim)
    const res = await attack('Scorching Ray', ['brakka', 'nim']);
    expect(midiCalls).toHaveLength(1);
    expect([...midiCalls[0].usage.midiOptions.targetsToUse].map((t: any) => t.id)).toEqual([
      'brakka',
      'nim',
    ]);
    expect(kobold.system.spells.spell2.value).toBe(1);
    expect(res.results.map((r: any) => [r.target, r.hit, r.damage])).toEqual([
      ['Brakka', true, 4],
      ['Nim', true, 4],
    ]);
    expect(res.results.every((r: any) => r.oneUseForAllTargets === true)).toBe(true);
  });

  it('each target keeps its own result from the one workflow (one hit, one miss)', async () => {
    const bolt = levelledSpell('Guiding Bolt');
    const { kobold } = world({
      targetFeet: 30,
      dagger: bolt,
      attackerItems: [bolt],
      extraTokens: [nimAt(8)],
    });
    kobold.system.spells = { spell1: { value: 1, max: 1 } };
    d20Queue = [10]; // 14: misses Brakka (AC 16), hits Nim (AC 13)
    const res = await attack('Guiding Bolt', ['brakka', 'nim']);
    expect(res.results.map((r: any) => [r.target, r.hit, r.targetAC])).toEqual([
      ['Brakka', false, 16],
      ['Nim', true, 13],
    ]);
    expect(kobold.system.spells.spell1.value).toBe(0);
  });

  it('guard: a weapon at two targets is still two attacks, one Midi workflow each', async () => {
    const club = makeWeapon({
      name: 'Club',
      quantity: 1,
      range: { value: null, long: null, reach: 5 },
      properties: ['lgt'],
      attackModes: [{ value: 'oneHanded' }],
    });
    world({ targetFeet: 5, dagger: club, attackerItems: [club], extraTokens: [nimAt(1, 1)] });
    await attack('Club', ['brakka', 'nim']);
    expect(midiCalls).toHaveLength(2);
  });

  it('a stopped spell attack that already spent its slot says so', async () => {
    const bolt = levelledSpell('Guiding Bolt');
    const knight = makeActor('Brakka', [], 20, 16, {}, { reactions: ['Parry'] });
    const { kobold } = world({
      targetFeet: 30,
      dagger: bolt,
      attackerItems: [bolt],
      target: knight,
    });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    d20Queue = [15];
    const res = await attack('Guiding Bolt', ['brakka'], undefined, { reactions: true });
    const r = res.results[0];
    expect(r.error).toMatch(/did not finish/);
    expect(r.spentAlthoughStopped).toBe('a spell slot');
    expect(kobold.system.spells.spell1.value).toBe(1);
    expect(res.ruleWarnings?.join(' ')).toMatch(
      /was stopped, but Guiding Bolt still spent a spell slot/
    );
  });
});

describe("a stuck workflow: every dialog it opened is closed, the GM browser's own windows are not", () => {
  it("the roll dialog AND dnd5e's usage dialog for the other activity are closed; a window open before stays", async () => {
    stuckDialogs = ['AttackRollConfigurationDialog', 'ActivityUsageDialog'];
    const chat: any = {
      constructor: { name: 'ChatLog5e' },
      async close() {
        throw new Error('must not close');
      },
    };
    const dagger = makeDagger(2, { midiProperties: { forceRollDialog: 'always' } });
    world({ targetFeet: 5, dagger, attackerItems: [dagger] });
    openApps.set('ChatLog5e', chat);
    const res = await attack();
    expect(res.results[0].error).toMatch(/AttackRollConfigurationDialog, ActivityUsageDialog/);
    expect([...openApps.keys()]).toEqual(['ChatLog5e']);
  });
});

describe('one deadline for the whole call (the MCP side waits 60 s)', () => {
  it('slow targets do not add up: a target whose attack cannot start in time is not attacked, and says so', async () => {
    const club = makeWeapon({
      name: 'Club',
      quantity: 1,
      range: { value: null, long: null, reach: 5 },
      properties: ['lgt'],
      attackModes: [{ value: 'oneHanded' }],
    });
    world({ targetFeet: 5, dagger: club, attackerItems: [club], extraTokens: [nimAt(1, 1)] });
    midiDelayMs = 150; // each Midi workflow answers after 150 ms
    const h = new QueryHandlers() as any;
    h.midiAttackTimeoutMs = 1000;
    h.midiCallBudgetMs = 250;
    h.midiDeadlineMarginMs = 20;
    h.midiMinRunMs = 100;
    const res = await h.handleExecuteAttack({
      attacker: 'kobold',
      item: 'Club',
      targets: ['brakka', 'nim'],
    });
    expect(midiCalls).toHaveLength(1);
    expect(res.results[0].error).toBeNull();
    expect(res.results[1].error).toMatch(/^not attacked: no time was left in this call/);
  });

  it("a run is never given more than the call's time left", async () => {
    world({ targetFeet: 5 });
    midiDelayMs = 400; // longer than the call has left
    const h = new QueryHandlers() as any;
    h.midiAttackTimeoutMs = 5000;
    h.midiCallBudgetMs = 300;
    h.midiDeadlineMarginMs = 50;
    h.midiMinRunMs = 50;
    const t0 = Date.now();
    const res = await h.handleExecuteAttack({
      attacker: 'kobold',
      item: 'Dagger',
      targets: ['brakka'],
    });
    expect(Date.now() - t0).toBeLessThan(380);
    expect(res.results[0].error).toMatch(/did not finish within/);
  });
});

describe('an unseen target: the engine decides, the bridge no longer refuses (2024 rules)', () => {
  it('an attack on a target the attacker cannot see is made, not refused', async () => {
    world({ targetFeet: 5 });
    unseen.add('kobold>brakka');
    const res = await attack();
    expect(res.refused).toBeUndefined();
    expect(res.results[0].outOfSight).toBeUndefined();
    expect(midiCalls).toHaveLength(1);
  });

  it("with Midi's rules on, Midi gives the Disadvantage and its reason is passed on", async () => {
    midiConfig.optionalRulesEnabled = true;
    world({ targetFeet: 5 });
    unseen.add('kobold>brakka');
    const res = await attack();
    expect(res.results[0].disadvantage).toBe(true);
    expect(res.results[0].disadvantageReasons).toEqual(['Defender not detected']);
  });

  it("a wall in the way is still refused (Midi's own range check), with the same words", async () => {
    world({ targetFeet: 10 });
    unseen.add('kobold>brakka');
    walls.add(key({ id: 'kobold' }, { id: 'brakka' }));
    const res = await attack();
    expect(res.refused).toBe(true);
    expect(res.results[0].note).toBe('a wall is in the way: Dagger cannot reach Brakka');
  });
});

// ================================================================================================
// Board #1887 (bridge 0.10.8 round 3): the re-review of f30cdc7
// ================================================================================================

async function attackWith(
  setup: (h: any) => void,
  item: string,
  targets: string[],
  more: any = {}
) {
  const h = new QueryHandlers() as any;
  h.midiAttackTimeoutMs = 60;
  setup(h);
  return h.handleExecuteAttack({ attacker: 'kobold', item, targets, ...more });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('a stopped workflow never applies damage later (reactions stay off until the chooser; fixed before)', () => {
  it('reactions on WITH DAE: the bridge stops the attack, and the prompt ending later does not damage the target', async () => {
    const knight = makeActor('Brakka', [], 20, 16, {}, { reactions: ['Parry'] });
    world({ targetFeet: 5, target: knight });
    d20Queue = [15];
    lateReactionMs = 150; // the prompt waits 150 ms; the bridge gives up at 60 ms
    const res = await attack('Dagger', ['brakka'], undefined, { reactions: true });
    expect(res.results[0].error).toMatch(/did not finish/);
    await sleep(300);
    expect(knight.system.attributes.hp.value).toBe(20);
  });

  it('guard: the same case with the guard off shows the late damage it prevents', async () => {
    const knight = makeActor('Brakka', [], 20, 16, {}, { reactions: ['Parry'] });
    world({ targetFeet: 5, target: knight });
    d20Queue = [15];
    lateReactionMs = 150;
    await attackWith(h => (h.midiGuardStoppedWorkflows = false), 'Dagger', ['brakka'], {
      reactions: true,
    });
    await sleep(300);
    expect(knight.system.attributes.hp.value).toBe(15);
  });
});

describe("Midi-QOL's per-call Dice So Nice switches", () => {
  it('when set, Midi is told not to show (so not to wait for) the 3D dice of the attack and damage rolls', async () => {
    world({ targetFeet: 5 });
    await attackWith(h => (h.midiSkipDiceAnimation = true), 'Dagger', ['brakka']);
    expect(midiCalls[0].usage.midiOptions.workflowOptions).toMatchObject({
      attackRollDSN: false,
      damageRollDSN: false,
    });
  });

  it('when not set, neither switch is sent (Midi shows the dice as it always did)', async () => {
    world({ targetFeet: 5 });
    await attackWith(h => (h.midiSkipDiceAnimation = false), 'Dagger', ['brakka']);
    const wo = midiCalls[0].usage.midiOptions.workflowOptions;
    expect(wo.attackRollDSN).toBeUndefined();
    expect(wo.damageRollDSN).toBeUndefined();
  });
});

describe('the same target named twice', () => {
  it('two weapon attacks at one target: the second starts from the hit points the first left', async () => {
    world({ targetFeet: 5, dagger: makeDagger(2) });
    d20Queue = [15, 15];
    const res = await attack('Dagger', ['brakka', 'brakka']);
    expect(midiCalls).toHaveLength(2);
    const [a, b] = res.results;
    expect(a.hpBefore).toBe(20);
    expect(b.hpBefore).toBe(a.hpAfter);
    expect(b.damage).toBe(b.hpBefore - b.hpAfter);
  });

  it('a spell used once at a target named twice: attacked once, the second said, never counted twice', async () => {
    const bolt = levelledSpell('Guiding Bolt');
    const { kobold } = world({ targetFeet: 30, dagger: bolt, attackerItems: [bolt] });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    d20Queue = [15];
    const res = await attack('Guiding Bolt', ['brakka', 'brakka']);
    expect(midiCalls).toHaveLength(1);
    expect(kobold.system.spells.spell1.value).toBe(1);
    const again = res.results.filter((r: any) => r.sameTargetAgain);
    expect(again).toHaveLength(1);
    expect(again[0].damage).toBe(0);
    expect(res.results.filter((r: any) => !r.sameTargetAgain)).toHaveLength(1);
    // the attack's own row comes first (a caller reading the first row reads the attack), the repeat after it
    expect(res.results[0].sameTargetAgain).toBeUndefined();
    expect(res.results[1].sameTargetAgain).toBe(true);
  });
});

describe("Midi-QOL refuses the use itself (its target count rule): a refusal in Midi's words", () => {
  it('a one-target spell at two targets: refused, nothing rolled, no slot spent, Midi says why', async () => {
    midiRefuseOver = 1;
    const bolt = levelledSpell('Guiding Bolt');
    const { kobold } = world({
      targetFeet: 30,
      dagger: bolt,
      attackerItems: [bolt],
      extraTokens: [nimAt(8)],
    });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    const res = await attack('Guiding Bolt', ['brakka', 'nim']);
    expect(res.success).toBe(false);
    expect(res.refused).toBe(true);
    expect(kobold.system.spells.spell1.value).toBe(2);
    expect(res.results).toHaveLength(2);
    for (const r of res.results) {
      expect(r.engineRefused).toBe(true);
      expect(r.hit).toBe(false);
      expect(r.note).toMatch(
        /^Midi-QOL did not make the attack: You must target at most 1 token\(s\)/
      );
    }
  });

  it("a SAVE spell at more targets than it takes: refused in Midi's words, never read as 'no damage'", async () => {
    midiRefuseOver = 1;
    const whispers = makeWeapon({
      name: 'Dissonant Whispers',
      type: 'spell',
      quantity: 1,
      level: 1,
      range: { value: 60, long: null, units: 'ft' },
      properties: [],
      attackModes: [],
      actionType: 'save',
    });
    const act = whispers.system.activities.contents[0];
    act.type = 'save';
    delete act.attack;
    act.save = {};
    const { kobold } = world({
      targetFeet: 30,
      dagger: whispers,
      attackerItems: [whispers],
      extraTokens: [nimAt(8)],
    });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    const res = await attack('Dissonant Whispers', ['brakka', 'nim']);
    expect(res.success).toBe(false);
    expect(res.refused).toBe(true);
    expect(kobold.system.spells.spell1.value).toBe(2);
    for (const r of res.results) {
      expect(r.via).toBe('save');
      expect(r.engineRefused).toBe(true);
      expect(r.note).toMatch(/^Midi-QOL did not cast it: You must target at most 1 token\(s\)/);
    }
  });

  it('guard: the same spell at one target is made', async () => {
    midiRefuseOver = 1;
    const bolt = levelledSpell('Guiding Bolt');
    const { kobold } = world({ targetFeet: 30, dagger: bolt, attackerItems: [bolt] });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    d20Queue = [15];
    const res = await attack('Guiding Bolt', ['brakka']);
    expect(res.success).toBe(true);
    expect(res.refused).toBeUndefined();
    expect(kobold.system.spells.spell1.value).toBe(1);
  });
});

// ================================================================================================
// Board #1887 (bridge 0.10.8 round 4): the re-review of d7f62a6
// ================================================================================================

// dnd5e 5.3.3's own cost check on a fake activity: `_prepareUsageUpdates(config, {returnErrors: true})` hands back its
// ConsumptionErrors, or the updates when the cost can be paid.
function withCost(act: any, errors: string[]) {
  act._prepareUsageConfig = (c: any) => ({ ...c, consume: { resources: [0] } });
  act._prepareUsageUpdates = async (_c: any, o: any) =>
    errors.length && o?.returnErrors ? errors.map(m => ({ message: m })) : { actor: {}, item: [] };
}
// dnd5e 5.3.3's own refund: each actor row's value gives back its delta (value = current - delta).
function withRefund(act: any, actor: any) {
  act.refund = async (consumed: any) => {
    for (const { keyPath, delta } of consumed.actor ?? [])
      setProperty(actor, keyPath, (getProperty(actor, keyPath) ?? 0) - delta);
  };
}
function saveSpell(name: string, level = 1) {
  const sp = makeWeapon({
    name,
    type: 'spell',
    quantity: 1,
    level,
    range: { value: 60, long: null, units: 'ft' },
    properties: [],
    attackModes: [],
    actionType: 'save',
  });
  const act = sp.system.activities.contents[0];
  act.type = 'save';
  delete act.attack;
  act.save = {};
  return { sp, act };
}

describe("round 4: what the ENGINE would refuse is asked before the use, in the engine's words", () => {
  it("a cost dnd5e cannot pay (a Recharge not recharged): refused in dnd5e's words, Midi never asked", async () => {
    const bolt = levelledSpell('Fire Bolt Recharge', 0);
    withCost(bolt.system.activities.contents[0], [
      'No uses on Fire Bolt Recharge available to spend, 1 required.',
    ]);
    bolt.system.activities.contents[0].uses = { max: 1, value: 0 };
    world({ targetFeet: 30, dagger: bolt, attackerItems: [bolt] });
    const res = await attack('Fire Bolt Recharge');
    expect(midiCalls).toHaveLength(0);
    expect(res.success).toBe(false);
    expect(res.refused).toBe(true);
    expect(res.results[0].refusedBy).toBe('dnd5e');
    expect(res.results[0].note).toBe(
      'Fire Bolt Recharge was not used: No uses on Fire Bolt Recharge available to spend, 1 required.'
    );
  });

  it('the same on the SAVE path (a breath weapon used up for the day)', async () => {
    const { sp, act } = saveSpell('Fire Breath', 0);
    withCost(act, ['No uses on Fire Breath available to spend, 1 required.']);
    world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    const res = await attack('Fire Breath');
    expect(midiCalls).toHaveLength(0);
    expect(res.refused).toBe(true);
    expect(res.results[0].via).toBe('save');
    expect(res.results[0].note).toMatch(/^Fire Breath was not used: No uses on Fire Breath/);
  });

  it('guard: a cost dnd5e can pay is used as before', async () => {
    const { sp, act } = saveSpell('Fire Breath', 0);
    withCost(act, []);
    world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    const res = await attack('Fire Breath');
    expect(midiCalls).toHaveLength(1);
    expect(res.success).toBe(true);
  });

  it('a formula target count (Hold Person at level 2 takes 1): refused before the use, no slot spent', async () => {
    const { sp, act } = saveSpell('Hold Person', 2);
    act.target = { affects: { count: 1 } }; // dnd5e's evaluated "@item.level - 1"
    const { kobold } = world({
      targetFeet: 30,
      dagger: sp,
      attackerItems: [sp],
      extraTokens: [nimAt(8)],
    });
    kobold.system.spells = { spell2: { value: 2, max: 2 } };
    const res = await attack('Hold Person', ['brakka', 'nim']);
    expect(midiCalls).toHaveLength(0);
    expect(kobold.system.spells.spell2.value).toBe(2);
    expect(res.refused).toBe(true);
    expect(res.results.map((r: any) => r.note)).toEqual([
      'Hold Person was not used: You must target at most 1 token(s) before rolling the attack',
      'Hold Person was not used: You must target at most 1 token(s) before rolling the attack',
    ]);
  });

  it('the heal path (never runs Midi): Cure Wounds (1 target) at three targets is refused, nobody healed', async () => {
    const cure = makeWeapon({
      name: 'Cure Wounds',
      type: 'spell',
      quantity: 1,
      level: 1,
      range: { value: 30, long: null, units: 'ft' },
      properties: [],
      attackModes: [],
      actionType: 'heal',
    });
    const act = cure.system.activities.contents[0];
    act.type = 'heal';
    delete act.attack;
    act.target = { affects: { count: 1 } };
    const hurt = makeActor('Brakka', [], 20, 16);
    hurt.system.attributes.hp.value = 5;
    const { kobold } = world({
      targetFeet: 5,
      dagger: cure,
      attackerItems: [cure],
      target: hurt,
      extraTokens: [nimAt(1, 1)],
    });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    const res = await attack('Cure Wounds', ['brakka', 'nim', 'kobold']);
    expect(res.refused).toBe(true);
    expect(kobold.system.spells.spell1.value).toBe(2);
    expect(hurt.system.attributes.hp.value).toBe(5);
    expect(res.results.every((r: any) => r.via === 'heal' && r.engineRefused)).toBe(true);
  });

  it('a plain damage activity through Midi (Magic Missile, 2 + level darts) at four targets: refused, no slot spent', async () => {
    const mm = makeWeapon({
      name: 'Magic Missile',
      type: 'spell',
      quantity: 1,
      level: 1,
      range: { value: 120, long: null, units: 'ft' },
      properties: [],
      attackModes: [],
      actionType: 'other',
    });
    const act = mm.system.activities.contents[0];
    act.type = 'damage';
    delete act.attack;
    act.target = { affects: { count: 3 } }; // dnd5e's evaluated "2 + @item.level"
    const { kobold } = world({
      targetFeet: 30,
      dagger: mm,
      attackerItems: [mm],
      extraTokens: [
        nimAt(8),
        { ...nimAt(9), id: 'orc', name: 'Orc', actor: makeActor('Orc', [], 15, 13) },
        { ...nimAt(10), id: 'elf', name: 'Elf', actor: makeActor('Elf', [], 15, 13) },
      ],
    });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    const res = await attack('Magic Missile', ['brakka', 'nim', 'orc', 'elf']);
    expect(midiCalls).toHaveLength(0);
    expect(kobold.system.spells.spell1.value).toBe(2);
    expect(res.refused).toBe(true);
    expect(res.results[0].note).toBe(
      'Magic Missile was not used: You must target at most 3 token(s) before rolling the attack'
    );
    // the row names the path the call would have taken (Midi's save and damage path), never 'attack'
    expect(res.results[0].via).toBe('save');
  });

  it('guard: a weapon at two targets is two attacks, never refused by the one-target count', async () => {
    const club = makeWeapon({
      name: 'Club',
      quantity: 1,
      range: { value: null, long: null, reach: 5 },
      properties: ['lgt'],
      attackModes: [{ value: 'oneHanded' }],
    });
    club.system.activities.contents[0].target = { affects: { count: 1 } };
    world({ targetFeet: 5, dagger: club, attackerItems: [club], extraTokens: [nimAt(1, 1)] });
    const res = await attack('Club', ['brakka', 'nim']);
    expect(midiCalls).toHaveLength(2);
    expect(res.refused).toBeUndefined();
  });

  it("Midi-QOL refusing AFTER the cost (its late formula check): said in Midi's words, and dnd5e's refund gives the slot back", async () => {
    midiAbortLateOver = 1;
    const bolt = levelledSpell('Guiding Bolt');
    const { kobold } = world({
      targetFeet: 30,
      dagger: bolt,
      attackerItems: [bolt],
      extraTokens: [nimAt(8)],
    });
    withRefund(bolt.system.activities.contents[0], kobold);
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    const res = await attack('Guiding Bolt', ['brakka', 'nim']);
    expect(midiCalls).toHaveLength(1);
    expect(res.refused).toBe(true);
    expect(kobold.system.spells.spell1.value).toBe(2);
    for (const r of res.results) {
      expect(r.engineRefused).toBe(true);
      expect(r.refunded).toBe('a spell slot');
      expect(r.note).toBe(
        'Midi-QOL did not make the attack: You must target at most 1 token(s) before rolling the attack'
      );
    }
  });

  it('the same late refusal on the SAVE path gives the slot back too', async () => {
    midiAbortLateOver = 1;
    const { sp, act } = saveSpell('Hold Person', 2);
    const { kobold } = world({
      targetFeet: 30,
      dagger: sp,
      attackerItems: [sp],
      extraTokens: [nimAt(8)],
    });
    withRefund(act, kobold);
    kobold.system.spells = { spell2: { value: 2, max: 2 } };
    const res = await attack('Hold Person', ['brakka', 'nim']);
    expect(res.refused).toBe(true);
    expect(kobold.system.spells.spell2.value).toBe(2);
    expect(res.results[0].refunded).toBe('a spell slot');
  });

  it('only Midi-QOL\'s own refusal text counts: another add-on\'s notice is a note, never "the reason"', async () => {
    midiRefuseOver = 1;
    otherToast = 'Some add-on says hello';
    const bolt = levelledSpell('Guiding Bolt');
    const { kobold } = world({
      targetFeet: 30,
      dagger: bolt,
      attackerItems: [bolt],
      extraTokens: [nimAt(8)],
    });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    const res = await attack('Guiding Bolt', ['brakka', 'nim']);
    expect(res.results[0].note).toBe(
      'Midi-QOL did not make the attack: You must target at most 1 token(s) before rolling the attack'
    );
    expect(res.results[0].engineNotes).toContain('Some add-on says hello');
  });

  it('a notice with no Midi refusal and no workflow is an error, not a refusal', async () => {
    otherToast = 'Some add-on says hello';
    midiThrows.completeActivityUse = false;
    const bolt = levelledSpell('Guiding Bolt');
    const { kobold } = world({ targetFeet: 30, dagger: bolt, attackerItems: [bolt] });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    const h = new QueryHandlers() as any;
    h.midiAttackTimeoutMs = 60;
    (globalThis as any).MidiQOL.completeActivityUse = async (_a: any, usage: any) => {
      usage.sequenceId = 'seqX';
      (globalThis as any).ui.notifications.info('Some add-on says hello');
      return undefined;
    };
    const res = await h.handleExecuteAttack({
      attacker: 'kobold',
      item: 'Guiding Bolt',
      targets: ['brakka'],
    });
    expect(res.results[0].engineRefused).toBeUndefined();
    expect(res.results[0].error).toMatch(/gave nothing back/);
  });
});

describe('round 4: the SAVE path runs like the attack path', () => {
  it('no reactions and no target dialog are asked of Midi on a save (operator "With the chooser")', async () => {
    const { sp } = saveSpell('Sacred Flame', 0);
    world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    await attack('Sacred Flame');
    expect(midiCalls[0].usage.midiOptions.workflowOptions).toMatchObject({
      noProvokeReaction: true,
      targetConfirmation: 'none',
    });
  });

  it("a save stuck in a dialog is stopped within the call, the dialog closed, never Midi's own 90 s", async () => {
    const { sp, act } = saveSpell('Fire Breath', 0);
    act.midiProperties = { forceRollDialog: 'always' };
    world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    const t0 = Date.now();
    const res = await attack('Fire Breath');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(res.results[0].error).toMatch(/did not finish within/);
    expect(openApps.size).toBe(0);
    expect(res.success).toBe(false);
  }, 3000);

  it('a finished save that changes no hit points (Hold Person) answers at once, with no 2 s hit-point wait', async () => {
    const { sp } = saveSpell('Hold Person', 2);
    const { kobold } = world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell2: { value: 2, max: 2 } };
    const t0 = Date.now();
    const res = await attack('Hold Person');
    expect(res.success).toBe(true);
    // Midi's workflow came back finished, so its damage (none here) is already applied: nothing to wait for
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 5000);
});

describe('round 4: stopping picks THIS use by its sequence id, and says it guarded it', () => {
  it('another running use of the same item is left alone', async () => {
    const knight = makeActor('Brakka', [], 20, 16, {}, { reactions: ['Parry'] });
    world({ targetFeet: 5, target: knight });
    // a workflow of another use of the same Dagger, already running (another sequence id)
    const other: any = {
      id: 'wfOther',
      sequenceId: 'seqOther',
      activity: null,
      currentAction: { name: 'WorkflowState_WaitForDamageRoll' },
      aborted: false,
      async performState() {
        other.abortedByBridge = true;
      },
      WorkflowState_Abort: { name: 'WorkflowState_Abort' },
    };
    d20Queue = [15, 15];
    const res = await attack('Dagger', ['brakka'], undefined, { reactions: true });
    other.activity = midiCalls[0].activity;
    liveWorkflows.set('wfOther', other);
    expect(res.results[0].error).toMatch(/did not finish/);
    // the stuck use (seq1) was stopped; a second call must not touch seqOther
    const res2 = await attack('Dagger', ['brakka'], undefined, { reactions: true });
    expect(res2.results[0].error).toMatch(/did not finish/);
    expect(other.abortedByBridge).toBeUndefined();
  });

  it('the answer says when a stopped workflow was guarded against late damage', async () => {
    const knight = makeActor('Brakka', [], 20, 16, {}, { reactions: ['Parry'] });
    world({ targetFeet: 5, target: knight });
    d20Queue = [15];
    lateReactionMs = 150;
    const res = await attack('Dagger', ['brakka'], undefined, { reactions: true });
    expect(res.results[0].guardedAfterStop).toBe(true);
  });
});

describe('round 4: a row for a target that was not attacked shows its hit points NOW', () => {
  it('a target named twice, the second not attacked for lack of time: it starts from what the first left', async () => {
    world({ targetFeet: 5, dagger: makeDagger(2) });
    d20Queue = [15, 15];
    midiDelayMs = 150;
    const h = new QueryHandlers() as any;
    h.midiAttackTimeoutMs = 1000;
    h.midiCallBudgetMs = 250;
    h.midiDeadlineMarginMs = 20;
    h.midiMinRunMs = 100;
    const res = await h.handleExecuteAttack({
      attacker: 'kobold',
      item: 'Dagger',
      targets: ['brakka', 'brakka'],
    });
    const [a, b] = res.results;
    expect(a.hpAfter).toBeLessThan(20);
    expect(b.error).toMatch(/^not attacked: no time was left/);
    expect(b.hpBefore).toBe(a.hpAfter);
  });
});

describe('round 4: an area activity (a breath weapon) never waits for a template placement', () => {
  it('no template is placed, Midi is told the use is complete, and the named target takes the damage', async () => {
    const { sp, act } = saveSpell('Fire Breath', 0);
    act.target = { template: { type: 'line', size: 15 }, affects: {} };
    const { brakka } = world({ targetFeet: 10, dagger: sp, attackerItems: [sp] });
    const res = await attackWith(h => (h.midiAttackTimeoutMs = 2000), 'Fire Breath', ['brakka']);
    expect(midiCalls[0].usage.create).toEqual({ measuredTemplate: false });
    expect(res.success).toBe(true);
    expect(res.results[0].templateNotPlaced).toBe(true);
    expect(brakka.system.attributes.hp.value).toBe(13);
  });
});

// Board #1887 (bridge 0.10.8 round 4, review S1): with autoItemEffects on, Midi-QOL applies EVERY effect an activity
// lists (chooseEffects defaults to false): Blindness/Deafness gave blinded AND deafened, Hex all six. The rules say the
// caster chooses ONE; the call names it (effect) and only that one is applied.
function effectOf(itemId: string, id: string, name: string, statuses: string[] = []) {
  return {
    id,
    uuid: `Item.${itemId}.ActiveEffect.${id}`,
    name,
    statuses: new Set(statuses),
    transfer: false,
    type: 'base',
    flags: {},
    toObject() {
      return { _id: id, name, statuses, transfer: false };
    },
  };
}
function choiceSpell(
  name: string,
  level: number,
  effects: [string, string, string[]][],
  type = 'save',
  // round 5: a choice only where the data says so (Midi-QOL's own chooseEffects on the activity)
  choose = true
) {
  const { sp, act } = saveSpell(name, level);
  act.midiProperties = { ...(act.midiProperties ?? {}), chooseEffects: choose };
  const efs = effects.map(([id, n, st]) => effectOf(sp.id, id, n, st));
  sp.effects = efs;
  act.effects = efs.map(ef => ({
    _id: ef.id,
    effect: ef,
    onSave: false,
    level: { min: null, max: null },
  }));
  if (type !== 'save') {
    act.type = type;
    delete act.save;
  }
  return { sp, act, efs };
}
const BLIND_DEAF: [string, string, string[]][] = [
  ['eBlind', 'Blindness', ['blinded']],
  ['eDeaf', 'Deafness', ['deafened']],
];

describe("round 4: an activity that puts ONE effect of the caster's choice applies only the one chosen", () => {
  it('Blindness/Deafness choosing "blinded": only Blindness lands, and Midi never asks in a dialog', async () => {
    const { sp, act } = choiceSpell('Blindness/Deafness', 2, BLIND_DEAF);
    const { kobold, brakka } = world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell2: { value: 2, max: 2 } };
    const res = await attack('Blindness/Deafness', ['brakka'], undefined, { effect: 'blinded' });
    expect(res.success).toBe(true);
    expect(brakka.effects.map((e: any) => e.name)).toEqual(['Blindness']);
    expect(res.results[0].effectChosen).toBe('Blindness');
    expect(openApps.size).toBe(0);
    // the item is as it was (its data's own switch) and the hook is removed
    expect(act.midiProperties.chooseEffects).toBe(true);
    expect((globalThis as any).Hooks.count('midi-qol.preApplyDynamicEffects')).toBe(0);
  });

  it('no effect named: nothing is used, nothing spent, and the answer lists the choices', async () => {
    const { sp } = choiceSpell('Blindness/Deafness', 2, BLIND_DEAF);
    const { kobold, brakka } = world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell2: { value: 2, max: 2 } };
    const res = await attack('Blindness/Deafness');
    expect(midiCalls).toHaveLength(0);
    expect(kobold.system.spells.spell2.value).toBe(2);
    expect(brakka.effects).toEqual([]);
    expect(res.refused).toBe(true);
    expect(res.results[0]).toMatchObject({
      needsChoice: true,
      refusedBy: 'rules',
      effectChoices: ['Blindness', 'Deafness'],
    });
    expect(res.results[0].note).toMatch(/choose one of Blindness, Deafness/);
  });

  it('a choice the spell does not offer is refused the same way, the choices listed', async () => {
    const { sp } = choiceSpell('Blindness/Deafness', 2, BLIND_DEAF);
    const { kobold } = world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell2: { value: 2, max: 2 } };
    const res = await attack('Blindness/Deafness', ['brakka'], undefined, { effect: 'Charmed' });
    expect(midiCalls).toHaveLength(0);
    expect(res.results[0].effectChoices).toEqual(['Blindness', 'Deafness']);
    expect(res.results[0].note).toMatch(/has no effect "Charmed"/);
  });

  it('guard: an activity with ONE effect (Hold Person) needs no choice and applies it as before', async () => {
    const { sp } = choiceSpell(
      'Hold Person',
      2,
      [['ePar', 'Paralyzed', ['paralyzed']]],
      'save',
      false
    );
    const { kobold, brakka } = world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell2: { value: 2, max: 2 } };
    const res = await attack('Hold Person');
    expect(res.success).toBe(true);
    expect(brakka.effects.map((e: any) => e.name)).toEqual(['Paralyzed']);
    expect(res.results[0].effectChosen).toBeUndefined();
  });

  it("guard: with Midi-QOL's autoItemEffects off (Midi applies no effects) no choice is asked", async () => {
    const { sp } = choiceSpell('Blindness/Deafness', 2, BLIND_DEAF);
    const { kobold, brakka } = world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    midiConfig.autoItemEffects = 'off';
    kobold.system.spells = { spell2: { value: 2, max: 2 } };
    const res = await attack('Blindness/Deafness');
    expect(res.success).toBe(true);
    expect(brakka.effects).toEqual([]);
  });

  it('Hex on the buff path (a utility activity, the bridge applies it): "strength" puts only Hexed Strength on', async () => {
    const six = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'].map(
      (a): [string, string, string[]] => ['e' + a.slice(0, 3), 'Hexed ' + a, ['cursed']]
    );
    const { sp, act } = choiceSpell('Hex', 1, six, 'utility');
    // round 5 (re-review nit 10): Hex as dnd5e 5.3.3's data has it on the test world (in this order): "Place Curse"
    // (utility, the six curses), "Bonus Hex Damage" (damage, no effect), "Curse New Creature" (utility, the six)
    act.name = 'Place Curse';
    const rider: any = {
      ...act,
      id: 'actBonusHex',
      name: 'Bonus Hex Damage',
      type: 'damage',
      effects: [],
    };
    const moveTo: any = { ...act, id: 'actCurseNew', name: 'Curse New Creature' };
    sp.system.activities = new ValueCollection([act, rider, moveTo]);
    const { kobold, brakka } = world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell1: { value: 2, max: 2 } };
    brakka.createEmbeddedDocuments = async (_t: string, docs: any[]) => {
      const made = docs.map(d => ({ ...d, id: d.name }));
      brakka.effects.push(...made);
      return made;
    };
    brakka.deleteEmbeddedDocuments = async () => [];
    const none = await attack('Hex');
    expect(none.refused).toBe(true);
    expect(none.results[0].effectChoices).toHaveLength(6);
    expect(brakka.effects).toEqual([]);
    const res = await attack('Hex', ['brakka'], undefined, { effect: 'strength' });
    expect(res.success).toBe(true);
    expect(brakka.effects.map((e: any) => e.name)).toEqual(['Hexed Strength']);
    expect(res.results[0].effectChosen).toBe('Hexed Strength');
  });
});

// ================================================================================================
// Board #1887 (bridge 0.10.8 round 5): the re-review of 9a24c90
// ================================================================================================

describe('round 5, BLOCKER 1: every use targets EXACTLY the named creatures (an area activity uses the GM targets)', () => {
  it('a save spell at Nim, then Fire Breath (an area) at Brakka: Nim takes no damage from the breath', async () => {
    const { sp: flame } = saveSpell('Sacred Flame', 0);
    const { sp: breath, act } = saveSpell('Fire Breath', 0);
    act.target = { template: { type: 'line', size: 15 }, affects: {} };
    const { brakka } = world({
      targetFeet: 10,
      dagger: flame,
      attackerItems: [flame, breath],
      extraTokens: [nimAt(3)],
    });
    const nim = tokens.get('nim').actor;
    const h = new QueryHandlers() as any;
    h.midiAttackTimeoutMs = 2000;
    await h.handleExecuteAttack({ attacker: 'kobold', item: 'Sacred Flame', targets: ['nim'] });
    const nimBefore = nim.system.attributes.hp.value;
    const res = await h.handleExecuteAttack({
      attacker: 'kobold',
      item: 'Fire Breath',
      targets: ['brakka'],
    });
    expect(res.success).toBe(true);
    expect(midiCalls[1].userTargets).toEqual(['brakka']);
    expect(brakka.system.attributes.hp.value).toBe(13);
    expect(nim.system.attributes.hp.value).toBe(nimBefore);
  });

  it("the attack path sets the GM's targets too, gives Midi the snapshot, and puts the old targets back after", async () => {
    world({ targetFeet: 5, extraTokens: [nimAt(3)] });
    tokens.get('nim').object.setTarget(true, { releaseOthers: true });
    await attack();
    expect(midiCalls[0].userTargets).toEqual(['brakka']);
    expect(midiCalls[0].usage.midiOptions.workflowOptions.preSelectedTargetUuids).toEqual([
      'Scene.scene1.Token.brakka',
    ]);
    expect([...(globalThis as any).game.user.targets].map((t: any) => t.id)).toEqual(['nim']);
  });
});

describe('round 5, item 5: a save workflow Midi-QOL aborted without saying why is an error', () => {
  it('no success with no damage: the answer says Midi stopped it', async () => {
    midiAbortSaveSilently = true;
    const { sp } = saveSpell('Sacred Flame', 0);
    world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    const res = await attack('Sacred Flame');
    expect(res.success).toBe(false);
    expect(res.results[0].error).toMatch(
      /Midi-QOL stopped Sacred Flame \(its workflow was aborted/
    );
  });
});

describe('round 5, item 4: several effects are a choice ONLY where the data says so; never all of them', () => {
  it('Blindness/Deafness whose data does not mark a choice: refused even with an effect named, nothing spent', async () => {
    const { sp } = choiceSpell('Blindness/Deafness', 2, BLIND_DEAF, 'save', false);
    const { kobold, brakka } = world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell2: { value: 2, max: 2 } };
    const res = await attack('Blindness/Deafness', ['brakka'], undefined, { effect: 'blinded' });
    expect(midiCalls).toHaveLength(0);
    expect(kobold.system.spells.spell2.value).toBe(2);
    expect(brakka.effects).toEqual([]);
    expect(res.refused).toBe(true);
    expect(res.results[0]).toMatchObject({
      needsData: true,
      refusedBy: 'rules',
      effectsListed: ['Blindness', 'Deafness'],
    });
    expect(res.results[0].note).toMatch(/its data does not say how they apply/);
  });

  it("Mirror Image (range self, three duplicates): the caster's own effects, all three on the caster", async () => {
    const { sp } = choiceSpell(
      'Mirror Image',
      2,
      [
        ['dA', 'Duplicate A', []],
        ['dB', 'Duplicate B', []],
        ['dC', 'Duplicate C', []],
      ],
      'utility',
      false
    );
    sp.system.range = { units: 'self' };
    const { kobold } = world({ targetFeet: 5, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell2: { value: 1, max: 1 } };
    kobold.createEmbeddedDocuments = async (_t: string, docs: any[]) => {
      const made = docs.map(d => ({ ...d, id: d.name }));
      kobold.effects.push(...made);
      return made;
    };
    kobold.deleteEmbeddedDocuments = async () => [];
    const res = await attack('Mirror Image', ['kobold']);
    expect(res.success).toBe(true);
    expect(kobold.effects.map((e: any) => e.name)).toEqual([
      'Duplicate A',
      'Duplicate B',
      'Duplicate C',
    ]);
    expect(kobold.system.spells.spell2.value).toBe(0);
  });

  it('several effects at ANOTHER creature with no choice in the data (Power Word Stun, by hit points): refused, never all', async () => {
    const { sp } = choiceSpell(
      'Power Word Stun',
      8,
      [
        ['st', 'Stunned', ['stunned']],
        ['nm', 'No Movement', []],
      ],
      'utility',
      false
    );
    const { kobold, brakka } = world({ targetFeet: 5, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell8: { value: 1, max: 1 } };
    const res = await attack('Power Word Stun');
    expect(res.refused).toBe(true);
    expect(res.results[0].effectsListed).toEqual(['Stunned', 'No Movement']);
    expect(brakka.effects).toEqual([]);
    expect(kobold.system.spells.spell8.value).toBe(1);
  });

  it("the buff path applies the ACTIVITY's own effects: Haste gives Hasted, never its other activity's Lethargy", async () => {
    const { sp, act, efs } = choiceSpell('Haste', 3, [['eHaste', 'Hasted', []]], 'utility', false);
    const lethargy = effectOf(sp.id, 'eLeth', 'Lethargy');
    sp.effects = [...efs, lethargy];
    const other: any = {
      ...act,
      id: 'actLethargy',
      name: 'Apply Lethargy',
      effects: [{ _id: 'eLeth', effect: lethargy, onSave: false, level: { min: null, max: null } }],
    };
    sp.system.activities = new ValueCollection([act, other]);
    const { kobold, brakka } = world({ targetFeet: 5, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell3: { value: 1, max: 1 } };
    brakka.createEmbeddedDocuments = async (_t: string, docs: any[]) => {
      const made = docs.map(d => ({ ...d, id: d.name }));
      brakka.effects.push(...made);
      return made;
    };
    brakka.deleteEmbeddedDocuments = async () => [];
    const res = await attack('Haste');
    expect(res.success).toBe(true);
    expect(brakka.effects.map((e: any) => e.name)).toEqual(['Hasted']);
  });

  it('the buff path keeps to the level cast: an effect meant for higher levels is not applied', async () => {
    const { sp, act } = choiceSpell(
      'Warding Word',
      1,
      [
        ['eL1', 'Ward +1', []],
        ['eL3', 'Ward +3', []],
      ],
      'utility',
      false
    );
    act.effects[0].level = { min: 1, max: 2 };
    act.effects[1].level = { min: 3, max: null };
    const { kobold, brakka } = world({ targetFeet: 5, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell1: { value: 1, max: 1 } };
    brakka.createEmbeddedDocuments = async (_t: string, docs: any[]) => {
      const made = docs.map(d => ({ ...d, id: d.name }));
      brakka.effects.push(...made);
      return made;
    };
    brakka.deleteEmbeddedDocuments = async () => [];
    const res = await attack('Warding Word');
    expect(res.success).toBe(true);
    expect(brakka.effects.map((e: any) => e.name)).toEqual(['Ward +1']);
  });

  it('an enchantment (Magic Weapon) is refused before anything is spent: it goes on an item, not a creature', async () => {
    const { sp, act } = choiceSpell(
      'Magic Weapon',
      2,
      [['mw1', 'Magic Weapon +1', []]],
      'enchant',
      false
    );
    act.effects[0].effect.type = 'enchantment';
    const { kobold, brakka } = world({ targetFeet: 5, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell2: { value: 1, max: 1 } };
    const res = await attack('Magic Weapon');
    expect(res.refused).toBe(true);
    expect(res.results[0].note).toMatch(/enchants an item/);
    expect(kobold.system.spells.spell2.value).toBe(1);
    expect(brakka.effects).toEqual([]);
  });

  it('item 8: Midi-QOL not offering the chosen effect is a rule warning, not only an engine note', async () => {
    midiDropsChosenEffect = true;
    const { sp } = choiceSpell('Blindness/Deafness', 2, BLIND_DEAF);
    const { kobold } = world({ targetFeet: 30, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell2: { value: 2, max: 2 } };
    const res = await attack('Blindness/Deafness', ['brakka'], undefined, { effect: 'blinded' });
    expect(res.ruleWarnings).toContain(
      'Midi-QOL did not offer Blindness, so no effect of the choice was applied'
    );
  });
});

describe("round 5, item 7: the slot a spell spends is dnd5e's (a warlock's pact slot; an at-will spell spends none)", () => {
  const pactConfig = (slot: string | null) => () =>
    slot ? { consume: { spellSlot: true }, spell: { slot } } : { consume: { spellSlot: false } };

  it('a pact caster with no level-1 slot but a pact slot casts, and the PACT slot is spent', async () => {
    const { sp, act } = choiceSpell(
      'Armor of Agathys',
      1,
      [['aoa', 'Armor of Agathys', []]],
      'utility',
      false
    );
    act._prepareUsageConfig = pactConfig('pact');
    const { kobold } = world({ targetFeet: 5, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell1: { value: 0, max: 0 }, pact: { value: 1, max: 1, level: 1 } };
    kobold.createEmbeddedDocuments = async (_t: string, docs: any[]) => docs;
    kobold.deleteEmbeddedDocuments = async () => [];
    const res = await attack('Armor of Agathys', ['kobold']);
    expect(res.success).toBe(true);
    expect(kobold.system.spells.pact.value).toBe(0);
    expect(kobold.system.spells.spell1.value).toBe(0);
  });

  it("an at-will spell (no slot in dnd5e's own config) casts with no slot left and spends none", async () => {
    const { sp, act } = choiceSpell(
      'Disguise Self',
      1,
      [['ds', 'Disguised', []]],
      'utility',
      false
    );
    act._prepareUsageConfig = pactConfig(null);
    const { kobold } = world({ targetFeet: 5, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell1: { value: 0, max: 0 } };
    kobold.createEmbeddedDocuments = async (_t: string, docs: any[]) => docs;
    kobold.deleteEmbeddedDocuments = async () => [];
    const res = await attack('Disguise Self', ['kobold']);
    expect(res.success).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it('guard: a wizard with no level-1 slot is still refused', async () => {
    const { sp } = choiceSpell(
      'Shield of Faith',
      1,
      [['sof', 'Shimmering Field', []]],
      'utility',
      false
    );
    const { kobold } = world({ targetFeet: 5, dagger: sp, attackerItems: [sp] });
    kobold.system.spells = { spell1: { value: 0, max: 2 } };
    const res = await attack('Shield of Faith', ['kobold']);
    expect(res.success).toBe(false);
    expect(res.error).toBe('No level-1 spell slots remaining');
  });
});
