/**
 * Board #1887 (plan F.4(b), bridge 0.10.7, dnd-dm KNOWN-ISSUES row 221): handler-level tests for
 * execute-attack's range rules.
 *
 * These run the REAL QueryHandlers#handleExecuteAttack from queries.ts against a small in-memory
 * Foundry stand-in:
 * - The attack activity's `rollAttack` follows dnd5e 5.3.3's own `AttackActivity#rollAttack`
 *   (dnd5e.mjs lines 28450-28580 of the system the test stack runs), reduced to the parts that
 *   decide the result here: the remembered attack mode (`flags.dnd5e.last.<activity>.attackMode`)
 *   used when none is given, the mode checked against the item's `attackModes` (falling back to the
 *   first), `D20Roll.applyKeybindings` turning `advantage`/`disadvantage` into the roll's mode
 *   (lines 78836-78857), a THROWN mode using the weapon up (quantity - 1, never below 0, not for a
 *   Returning weapon), and a quantity of 0 giving only a warning. The roll formulas are the ones the
 *   test stack printed on 2026-09-27 ("1d20 + 2 + 2", "2d20dis + 2 + 2").
 * - MidiQOL's `checkActivityRange` follows Midi-QOL 14.0.12's own rules (utils.ts
 *   checkRangeFunction): a wall under `wallsBlockRange` (negative distance) fails, beyond long range
 *   fails (`checkRange: longFail`, the live and test setting), beyond normal range is `dis`.
 *   `getDistance` / `computeDistance` / `checkNearby` / `canSee` answer from the positions below.
 *
 * What this proves: which mode and advantage the handler asks dnd5e for, what it refuses, and the
 * words it uses. What it does NOT prove: that the live dnd5e and Midi-QOL answer the same way. That
 * is FS-07 on the test stack (dnd-dm-modtest/README.md).
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
      level: 0,
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
    type: 'attack',
    actionType: opts.actionType ?? 'mwak',
    attack: {},
    item,
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
      if (!attackModeOptions?.find((m: any) => m.value === rollConfig.attackMode)) {
        rollConfig.attackMode = attackModeOptions?.[0]?.value;
      }
      // D20Roll.applyKeybindings with no key pressed.
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
    async rollDamage(config: any = {}) {
      damageCalls.push({ ...config });
      return [{ total: 4, options: { type: 'piercing' }, terms: [] }];
    },
  };
  item.system.activities = new ValueCollection([activity]);
  if (opts.remembered)
    setProperty(item.flags, `dnd5e.last.${activity.id}.attackMode`, opts.remembered);
  return item;
}

function makeDagger(
  quantity = 1,
  extra: Partial<{ properties: string[]; remembered: string }> = {}
) {
  return makeWeapon({
    name: 'Dagger',
    quantity,
    range: { value: 20, long: 60, reach: 5 },
    properties: extra.properties ?? ['fin', 'lgt', 'thr'],
    attackModes: DAGGER_MODES,
    ...(extra.remembered ? { remembered: extra.remembered } : {}),
  });
}

function makeActor(name: string, items: any[], hp = 20, ac = 12, flags: any = {}) {
  const actor: any = {
    name,
    items: new ValueCollection(items),
    flags,
    effects: [],
    system: { attributes: { ac: { value: ac }, hp: { value: hp, max: hp } }, spells: {} },
    async applyDamage(parts: any[]) {
      for (const p of parts) actor.system.attributes.hp.value -= p.value;
    },
    async update() {},
  };
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
}

let tokens: ValueCollection<any>;
let walls: Set<string>; // "idA|idB" pairs a wall stands between (either order)
let wallsOnFt: Map<string, number>; // a walls-on distance that differs from the open measure
let midiRules: any;
// Board #1887 review finding 5: which Midi-QOL calls the stand-in makes throw, and whether its condition evaluator
// is missing.
let midiThrows: Record<string, boolean> = {};
let midiNoEvaluator = false;

function key(a: any, b: any) {
  return [a.id, b.id].sort().join('|');
}

function openFeet(a: any, b: any) {
  return (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / GRID) * FT;
}

function install(toks: Tok[]) {
  const docs = toks.map(t => {
    const doc: any = {
      id: t.id,
      name: t.name,
      x: t.sq * GRID,
      y: (t.sy ?? 0) * GRID,
      disposition: t.disposition,
      actor: t.actor,
      seesAttacker: t.seesAttacker ?? true,
      async update(ch: any) {
        Object.assign(doc, ch);
      },
    };
    doc.object = {
      id: t.id,
      document: doc,
      get center() {
        return { x: doc.x + GRID / 2, y: doc.y + GRID / 2 };
      },
      setTarget() {},
      control() {},
    };
    return doc;
  });
  tokens = new ValueCollection(docs);
  const scene = { id: 'scene1', grid: { size: GRID }, tokens };
  const g: any = globalThis;
  g.game = {
    user: { isGM: true },
    scenes: { active: scene, contents: [scene] },
    settings: {
      get(scope: string, name: string) {
        if (scope === 'midi-qol' && name === 'ConfigSettings') {
          if (midiThrows.settings) throw new Error('settings exploded');
          return { optionalRules: midiRules };
        }
        throw new Error(`unknown setting ${scope}.${name}`);
      },
    },
  };
  g.canvas = { dimensions: { distance: FT } };
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
  g.MidiQOL = {
    getDistance: (a: any, b: any, opts: any = {}) => {
      maybeThrow(opts.wallsBlock ? 'distanceWallsOn' : 'distanceWallsOff');
      return distance(a, b, opts);
    },
    computeDistance: distance,
    canSee: () => {
      maybeThrow('canSee');
      return true;
    },
    // Midi-QOL 14.0.12 evalAllConditions / createConditionData, reduced: the actor's own flag is a condition
    // expression, evaluated (here with plain JavaScript) to a truthy or falsy answer.
    ...(midiNoEvaluator
      ? {}
      : {
          createConditionData: (d: any) => ({ actorName: d?.actor?.name, target: d?.target }),
          evalAllConditions: (actor: any, flag: string) => {
            maybeThrow('evalAllConditions');
            const v = getProperty(actor, flag);
            if (v === undefined || v === null || v === '') return false;
            if (typeof v === 'boolean') return v;
            return !!new Function(`return (${String(v)});`)();
          },
        }),
    // Midi-QOL 14.0.12 checkRangeFunction, reduced (checkRange 'longFail').
    checkActivityRange(activity: any, tokenObj: any, targets: Set<any>) {
      maybeThrow('checkActivityRange');
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
    },
    // Midi-QOL findNearby/checkNearby, reduced: a token of the opposite disposition within
    // `dist` feet (walls on) that can see the attacker.
    checkNearby(disposition: number, tokenObj: any, dist: number, opts: any = {}) {
      maybeThrow('checkNearby');
      const me = docOf(tokenObj);
      const want = me.disposition * disposition;
      return tokens.contents.some(
        (t: any) =>
          t.id !== me.id &&
          t.disposition === want &&
          (t.actor?.system?.attributes?.hp?.value ?? 1) > 0 &&
          distance(t, me, { wallsBlock: true }) >= 0 &&
          distance(t, me, { wallsBlock: true }) <= dist &&
          (!opts.canSee || t.seesAttacker)
      );
    },
  };
}

function world(opts: {
  targetFeet: number;
  dagger?: any;
  extraTokens?: Tok[];
  attackerItems?: any[];
  attackerFlags?: any;
}) {
  const dagger = opts.dagger ?? makeDagger(1);
  const kobold = makeActor(
    'Kobold Warrior',
    opts.attackerItems ?? [dagger],
    7,
    14,
    opts.attackerFlags
  );
  const brakka = makeActor('Brakka', [], 20, 16);
  install([
    { id: 'kobold', name: 'Kobold Warrior', sq: 0, disposition: -1, actor: kobold },
    { id: 'brakka', name: 'Brakka', sq: opts.targetFeet / FT, disposition: 1, actor: brakka },
    ...(opts.extraTokens ?? []),
  ]);
  return { dagger, kobold, brakka };
}

async function attack(item = 'Dagger', targets = ['brakka'], itemId?: string) {
  const h = new QueryHandlers() as any;
  return h.handleExecuteAttack({
    attacker: 'kobold',
    item,
    targets,
    ...(itemId ? { itemId } : {}),
  });
}

beforeEach(() => {
  rollCalls = [];
  damageCalls = [];
  warnings = [];
  d20Queue = [];
  walls = new Set();
  wallsOnFt = new Map();
  midiRules = { wallsBlockRange: 'center', nearbyFoe: 5, checkRange: 'longFail' };
  midiThrows = {};
  midiNoEvaluator = false;
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

  it('45 ft: thrown WITH disadvantage (long range), and the roll shows it', async () => {
    world({ targetFeet: 45 });
    const res = await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown', disadvantage: true });
    expect(rollCalls[0].advantageMode).toBe(-1);
    const r = res.results[0];
    expect(r.formula).toBe('2d20dis + 2 + 2');
    expect(r.disadvantage).toBe(true);
    expect(r.disadvantageReasons).toEqual(['long range']);
    expect(r.rangeVerdict).toBe('dis');
  });

  it('70 ft: refused with the distance Midi-QOL measured and the weapon range; nothing rolled', async () => {
    const { dagger } = world({ targetFeet: 70 });
    const res = await attack();
    expect(res.refused).toBe(true);
    expect(rollCalls).toHaveLength(0);
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

describe('the attack mode is always the one the rules give', () => {
  it('adjacent (5 ft): a melee stab, the Dagger is kept, even when dnd5e remembers a throw', async () => {
    const dagger = makeDagger(2, { remembered: 'thrown' });
    world({ targetFeet: 5, dagger });
    d20Queue = [15]; // a hit, so damage is rolled too
    const res = await attack();
    expect(rollCalls[0].config.attackMode).toBe('oneHanded');
    expect(rollCalls[0].mode).toBe('oneHanded');
    expect(res.results[0].thrown).toBe(false);
    expect(dagger.system.quantity).toBe(2);
    expect(damageCalls[0]).toEqual({ attackMode: 'oneHanded' });
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

describe('a used-up weapon is never used again', () => {
  it('quantity 0: refused, says so, and dnd5e is never asked to roll', async () => {
    world({ targetFeet: 10, dagger: makeDagger(0) });
    const res = await attack();
    expect(res.refused).toBe(true);
    expect(res.results[0].noWeaponLeft).toBe(true);
    expect(res.results[0].note).toBe(
      'Kobold Warrior has no Dagger left to attack with (all of them were used up)'
    );
    expect(rollCalls).toHaveLength(0);
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

describe('ranged attacks in close combat (Midi-QOL nearbyFoe)', () => {
  it('a throw with an enemy standing next to the thrower who can see it: disadvantage', async () => {
    world({
      targetFeet: 15,
      extraTokens: [
        { id: 'oren', name: 'Oren', sq: 0, sy: 1, disposition: 1, actor: makeActor('Oren', []) },
      ],
    });
    const res = await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown', disadvantage: true });
    expect(res.results[0].disadvantageReasons).toEqual([
      'an enemy within 5 ft can see the attacker',
    ]);
  });

  it('an enemy next to the thrower that cannot see it: no disadvantage', async () => {
    world({
      targetFeet: 15,
      extraTokens: [
        {
          id: 'oren',
          name: 'Oren',
          sq: 0,
          sy: 1,
          disposition: 1,
          actor: makeActor('Oren', []),
          seesAttacker: false,
        },
      ],
    });
    await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown' });
  });

  it("Midi-QOL's own opt-out on the thrower (ignoreNearbyFoes): no disadvantage", async () => {
    const dagger = makeDagger(1);
    world({
      targetFeet: 15,
      dagger,
      attackerItems: [dagger],
      attackerFlags: { 'midi-qol': { ignoreNearbyFoes: '1' } },
      extraTokens: [
        { id: 'oren', name: 'Oren', sq: 0, sy: 1, disposition: 1, actor: makeActor('Oren', []) },
      ],
    });
    await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown' });
  });

  it('the rule switched off in Midi-QOL (nearbyFoe 0): no disadvantage', async () => {
    midiRules.nearbyFoe = 0;
    world({
      targetFeet: 15,
      extraTokens: [
        { id: 'oren', name: 'Oren', sq: 0, sy: 1, disposition: 1, actor: makeActor('Oren', []) },
      ],
    });
    await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown' });
  });

  it('a melee stab with an enemy next to the attacker: no disadvantage (unchanged)', async () => {
    world({
      targetFeet: 5,
      extraTokens: [
        { id: 'oren', name: 'Oren', sq: 0, sy: 1, disposition: 1, actor: makeActor('Oren', []) },
      ],
    });
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
// bludgeoning. dnd5e only remembers the last attack mode on an item its actor holds.
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
      type: 'attack',
      actionType: 'mwak',
      attack: { ability: 'str' },
      item,
      async rollAttack(config: any = {}) {
        const die = d20Queue.length ? d20Queue.shift()! : 10;
        const prof = item.prepared ? 2 : 0;
        const roll = {
          formula: item.prepared ? '1d20 - 2 + 2' : '1d20 - 2',
          total: die - 2 + prof,
          isCritical: die === 20,
          isFumble: die === 1,
          options: { attackMode: config.attackMode ?? 'oneHanded' },
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

  it("uses dnd5e's own 2024 Unarmed Strike, fully prepared, and adds nothing to the monster", async () => {
    const { kobold } = world({ targetFeet: 5, dagger: makeDagger(0) });
    withDnd5eUnarmedStrike();
    d20Queue = [18]; // 18 - 2 + 2 = 18 hits AC 16
    const res = await attack('Unarmed Strike');
    expect(uuidAsked).toEqual(['Compendium.dnd5e.equipment24.Item.phbUnarmedStrike']);
    expect(res.success).toBe(true);
    expect(res.item).toBe('Unarmed Strike');
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

  it('a hit whose damage roll is below 0 deals 0 and never heals the target', async () => {
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

describe("damage below 0 deals 0 for every weapon (dnd5e's own rule when it applies damage)", () => {
  it('a Dagger damage roll of -1 leaves the target untouched (it used to heal 1)', async () => {
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

const orenNextToTheThrower = () => ({
  id: 'oren',
  name: 'Oren',
  sq: 0,
  sy: 1,
  disposition: 1,
  actor: makeActor('Oren', []),
});

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

describe('finding 5: a rule the engine could not apply is reported, never dropped quietly', () => {
  it("Midi-QOL's settings cannot be read: the attack goes on and the answer says the defaults were used", async () => {
    midiThrows.settings = true;
    world({ targetFeet: 10 });
    const res = await attack();
    expect(res.success).toBe(true);
    expect(res.ruleWarnings?.join(' ')).toMatch(/settings could not be read/);
  });

  it('the close-combat check throws: reported (it used to drop the disadvantage silently)', async () => {
    midiThrows.checkNearby = true;
    world({ targetFeet: 15, extraTokens: [orenNextToTheThrower()] });
    const res = await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown' });
    expect(res.ruleWarnings?.join(' ')).toMatch(/close-combat check failed/);
  });

  it('the range check throws: reported (no long-range disadvantage could be applied)', async () => {
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

  it('the sight check throws: reported', async () => {
    midiThrows.canSee = true;
    world({ targetFeet: 10 });
    const res = await attack();
    expect(res.ruleWarnings?.join(' ')).toMatch(/sight check for Brakka failed/);
  });

  it('guard: a normal attack carries no warnings at all', async () => {
    world({ targetFeet: 10 });
    const res = await attack();
    expect(res.ruleWarnings).toBeUndefined();
  });
});

describe("finding 5: Midi-QOL's ignoreNearbyFoes is a condition, evaluated the way Midi does", () => {
  it('a condition that evaluates FALSE does not switch the rule off: disadvantage applies', async () => {
    const dagger = makeDagger(1);
    world({
      targetFeet: 15,
      dagger,
      attackerItems: [dagger],
      attackerFlags: { 'midi-qol': { ignoreNearbyFoes: 'false' } },
      extraTokens: [orenNextToTheThrower()],
    });
    const res = await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown', disadvantage: true });
    expect(res.ruleWarnings).toBeUndefined();
  });

  it("Midi's evaluator is missing: the flag counts as set, and the answer says it could not be evaluated", async () => {
    midiNoEvaluator = true;
    const dagger = makeDagger(1);
    world({
      targetFeet: 15,
      dagger,
      attackerItems: [dagger],
      attackerFlags: { 'midi-qol': { ignoreNearbyFoes: 'false' } },
      extraTokens: [orenNextToTheThrower()],
    });
    const res = await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown' });
    expect(res.ruleWarnings?.join(' ')).toMatch(/evaluator \(evalAllConditions\) is not available/);
  });

  it('the evaluator throws: the flag counts as set, and the answer says so', async () => {
    midiThrows.evalAllConditions = true;
    const dagger = makeDagger(1);
    world({
      targetFeet: 15,
      dagger,
      attackerItems: [dagger],
      attackerFlags: { 'midi-qol': { ignoreNearbyFoes: 'true' } },
      extraTokens: [orenNextToTheThrower()],
    });
    const res = await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown' });
    expect(res.ruleWarnings?.join(' ')).toMatch(/could not evaluate/);
  });

  it('guard: no flag at all, nothing is evaluated and nothing is reported', async () => {
    midiNoEvaluator = true;
    world({ targetFeet: 15, extraTokens: [orenNextToTheThrower()] });
    const res = await attack();
    expect(rollCalls[0].config).toEqual({ attackMode: 'thrown', disadvantage: true });
    expect(res.ruleWarnings).toBeUndefined();
  });
});
