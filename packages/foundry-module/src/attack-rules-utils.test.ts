/** Board #1887 (bridge 0.10.7, 0.10.8): the pure helpers behind execute-attack. 0.10.8 removed the helpers that did the
 * rules by hand (rangeRollAdvantage, appliedDamage, midiIgnoresNearbyFoes); Midi-QOL's own workflow decides now. */

import { describe, it, expect } from 'vitest';
import {
  chooseAttackMode,
  weaponUsedUp,
  describeRangeRefusal,
  isUnarmedStrike,
  unarmedStrikeUuid,
  UNARMED_STRIKE_UUID,
  pickItemByName,
  usedUpCount,
  midiAttackOptions,
  midiCriticalDamageProblem,
  MIDI_CRITICAL_DAMAGE_CHOICES,
  readMidiAttack,
  activitySpendsOnUse,
  spentOnUse,
  guardStoppedWorkflow,
  MIDI_STATES_AFTER_STOP,
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
  activityEffectDocs,
  effectsNeedChoice,
  effectsUnclearWords,
  spellSlotKey,
  consumedDeltas as consumedDeltas5,
  activitySpendsOnUse as spendsOnUse5,
  effectsAllApply,
} from './attack-rules-utils.js';

const DAGGER = ['oneHanded', 'offhand', null, 'thrown', 'thrown-offhand'];

describe('chooseAttackMode', () => {
  it('a thrown weapon beyond its reach is thrown', () => {
    expect(
      chooseAttackMode({ modes: DAGGER, thrownProperty: true, distanceFt: 10, reachFt: 5 })
    ).toEqual({ mode: 'thrown', thrown: true });
  });
  it('within reach it is used in melee (the weapon is kept)', () => {
    expect(
      chooseAttackMode({ modes: DAGGER, thrownProperty: true, distanceFt: 5, reachFt: 5 })
    ).toEqual({ mode: 'oneHanded', thrown: false });
  });
  it('a 10 ft reach weapon with the thrown property is not thrown at 10 ft', () => {
    expect(
      chooseAttackMode({ modes: DAGGER, thrownProperty: true, distanceFt: 10, reachFt: 10 }).thrown
    ).toBe(false);
  });
  it('distance unknown: a long-range verdict still means beyond reach', () => {
    expect(
      chooseAttackMode({
        modes: DAGGER,
        thrownProperty: true,
        distanceFt: null,
        reachFt: 5,
        verdict: 'dis',
      }).mode
    ).toBe('thrown');
    expect(
      chooseAttackMode({
        modes: DAGGER,
        thrownProperty: true,
        distanceFt: -1,
        reachFt: 5,
        verdict: 'normal',
      }).mode
    ).toBe('oneHanded');
  });
  it('a weapon without the thrown property is never thrown', () => {
    expect(
      chooseAttackMode({ modes: ['oneHanded'], thrownProperty: false, distanceFt: 30, reachFt: 5 })
    ).toEqual({ mode: 'oneHanded', thrown: false });
  });
  it('only throw modes (a Dart): always thrown', () => {
    expect(
      chooseAttackMode({ modes: ['thrown'], thrownProperty: true, distanceFt: 5, reachFt: 5 })
    ).toEqual({ mode: 'thrown', thrown: true });
  });
  it('a two-handed-only weapon keeps its only mode', () => {
    expect(
      chooseAttackMode({ modes: ['twoHanded'], thrownProperty: false, distanceFt: 5, reachFt: 5 })
    ).toEqual({ mode: 'twoHanded', thrown: false });
  });
  it('no modes (a spell): no mode is passed', () => {
    expect(
      chooseAttackMode({ modes: [], thrownProperty: false, distanceFt: 30, reachFt: 5 })
    ).toEqual({ mode: undefined, thrown: false });
  });
});

describe('weaponUsedUp', () => {
  it('a weapon at quantity 0 is used up; 1 or more, or no number, is not', () => {
    expect(weaponUsedUp({ type: 'weapon', quantity: 0 })).toBe(true);
    expect(weaponUsedUp({ type: 'weapon', quantity: 1 })).toBe(false);
    expect(weaponUsedUp({ type: 'weapon', quantity: undefined })).toBe(false);
    expect(weaponUsedUp({ type: 'spell', quantity: 0 })).toBe(false);
  });
});

describe('describeRangeRefusal', () => {
  it('a wall says so', () => {
    expect(
      describeRangeRefusal({
        targetName: 'Brakka',
        itemName: 'Dagger',
        wallBlocked: true,
        measuredFt: -1,
      })
    ).toEqual({ note: 'a wall is in the way: Dagger cannot reach Brakka', blockedByWall: true });
  });
  it('too far gives the measured distance and the range', () => {
    expect(
      describeRangeRefusal({
        targetName: 'Nim',
        itemName: 'Dagger',
        wallBlocked: false,
        measuredFt: 70.2,
        normalFt: 20,
        longFt: 60,
      })
    ).toEqual({
      note: 'Nim is 70 ft away, beyond the range of Dagger (range 20/60 ft)',
      outOfRange: true,
      distanceFt: 70,
    });
  });
  it('no long range and no measurement', () => {
    expect(
      describeRangeRefusal({
        targetName: 'Nim',
        itemName: 'Fire Bolt',
        wallBlocked: false,
        measuredFt: null,
        normalFt: 120,
      })
    ).toEqual({ note: 'Nim is out of the range of Fire Bolt (range 120 ft)', outOfRange: true });
  });
});

describe('Unarmed Strike (board #1887, operator "Unarmed Strike")', () => {
  it('the name, in any case and spacing', () => {
    expect(isUnarmedStrike('Unarmed Strike')).toBe(true);
    expect(isUnarmedStrike('  unarmed strike ')).toBe(true);
    expect(isUnarmedStrike('Dagger')).toBe(false);
    expect(isUnarmedStrike(undefined)).toBe(false);
  });
  it("dnd5e's own item for the world's rules: 2024 by default, 2014 for legacy worlds", () => {
    expect(unarmedStrikeUuid('modern')).toBe('Compendium.dnd5e.equipment24.Item.phbUnarmedStrike');
    expect(unarmedStrikeUuid(undefined)).toBe(UNARMED_STRIKE_UUID.modern);
    expect(unarmedStrikeUuid('legacy')).toBe('Compendium.dnd5e.items.Item.GsuvwoekKZatfKwF');
  });
});

// Board #1887, independent review of bridge 0.10.7, finding 2: which stack an attack by name means.
describe('pickItemByName', () => {
  const stack = (id: string, quantity: number, activities = 1, type = 'weapon') => ({
    id,
    name: 'Javelin',
    type,
    system: { quantity, activities: { size: activities } },
  });

  it('skips a used-up stack for one that can still attack', () => {
    expect(pickItemByName([stack('a', 0), stack('b', 2)], 'javelin')?.id).toBe('b');
  });

  it('all stacks used up: the first that can attack (execute-attack then refuses it, as before)', () => {
    expect(pickItemByName([stack('a', 0, 0), stack('b', 0), stack('c', 0)], 'Javelin')?.id).toBe(
      'b'
    );
  });

  it('nothing can attack: the first match; nothing matches: null', () => {
    expect(pickItemByName([stack('a', 1, 0)], 'Javelin')?.id).toBe('a');
    expect(pickItemByName([stack('a', 1)], 'Spear')).toBeNull();
  });

  it('a non-weapon with no quantity is never "used up" (a spell, say)', () => {
    const spell = {
      id: 's',
      name: 'Fire Bolt',
      type: 'spell',
      system: { activities: { size: 1 } },
    };
    expect(pickItemByName([spell], 'fire bolt')?.id).toBe('s');
  });
});

// Board #1887, re-review of fork 876a95d: the count the brain gives back after a fight.
describe('usedUpCount', () => {
  it('before minus after, never below 0', () => {
    expect(usedUpCount('weapon', 3, 2)).toBe(1);
    expect(usedUpCount('weapon', 1, 1)).toBe(0);
    expect(usedUpCount('weapon', 1, 3)).toBe(0);
  });

  it('null when it is not a weapon or a quantity is unknown', () => {
    expect(usedUpCount('spell', 1, 0)).toBeNull();
    expect(usedUpCount('weapon', undefined, 0)).toBeNull();
    expect(usedUpCount('weapon', 1, Number.NaN)).toBeNull();
  });
});

// ================================================================================================
// Board #1887 (bridge 0.10.8, engine map M07): Midi-QOL's own attack workflow decides; these read it back.
// ================================================================================================
describe('midiAttackOptions: only automation for a GM with no hands', () => {
  it('names the attack mode, auto-rolls and fast-forwards, never asks to confirm targets, reactions off', () => {
    expect(midiAttackOptions({ attackMode: 'thrown' })).toEqual({
      autoRollAttack: true,
      fastForwardAttack: true,
      autoRollDamage: 'onHit',
      fastForwardDamage: true,
      workflowOptions: {
        targetConfirmation: 'none',
        attackMode: 'thrown',
        noProvokeReaction: true,
      },
    });
  });
  it('reactions on: Midi-QOL is left to offer them', () => {
    expect(midiAttackOptions({ attackMode: 'oneHanded', reactions: true }).workflowOptions).toEqual(
      { targetConfirmation: 'none', attackMode: 'oneHanded' }
    );
  });
  it('no mode (a spell attack): none is named', () => {
    expect(midiAttackOptions({ attackMode: undefined }).workflowOptions).toEqual({
      targetConfirmation: 'none',
      noProvokeReaction: true,
    });
  });
  it("never sets advantage, disadvantage or a critical (those are the engine's)", () => {
    const o: any = midiAttackOptions({ attackMode: 'thrown' });
    for (const k of ['advantage', 'disadvantage', 'isCritical', 'critical'])
      expect(o[k] ?? o.workflowOptions[k]).toBeUndefined();
  });
});

describe("midiCriticalDamageProblem: Midi-QOL's GM critical damage setting", () => {
  it("'none' (Midi's own default for the GM, which it does not handle) is reported", () => {
    expect(midiCriticalDamageProblem('none')).toMatch(/is 'none'.*adds no critical dice/);
  });
  it('a missing value is reported too', () => {
    expect(midiCriticalDamageProblem(undefined)).toMatch(/is 'undefined'/);
  });
  it("every one of Midi-QOL 14.0.12's own choices is fine", () => {
    expect(MIDI_CRITICAL_DAMAGE_CHOICES).toContain('default');
    for (const c of MIDI_CRITICAL_DAMAGE_CHOICES) expect(midiCriticalDamageProblem(c)).toBeNull();
  });
});

// A workflow shaped the way Midi-QOL 14.0.12 left it on the test stack (2026-09-27): a 45 ft Dagger throw that hit.
const TARGET = { uuid: 'Scene.s1.Token.hero', id: 'hero' };
function wf(extra: any = {}) {
  const heroTok = { id: 'hero', document: { uuid: 'Scene.s1.Token.hero' } };
  return {
    currentAction: { name: 'bound WorkflowState_Cleanup' },
    aborted: false,
    attackRoll: {
      formula: '2d20dis + 2 + 2',
      total: 12,
      options: { advantageMode: -1, attackMode: 'thrown' },
    },
    attackTotal: 12,
    isCritical: false,
    isFumble: false,
    hitTargets: new Set([heroTok]),
    hitTargetsEC: new Set(),
    attackRollModifierTracker: {
      attribution: { DIS: { range: 'Long Range' }, NOCRIT: { direct: 'Direct assignment' } },
    },
    hitDisplayData: {
      'Scene.s1.Token.hero': { ac: 11, baseAc: 11, acTooltip: '11', attackTotal: 12 },
    },
    damageRolls: [{ formula: '1d4 + 2', total: 3, options: { type: 'piercing' } }],
    damageList: [
      {
        targetUuid: 'Scene.s1.Token.hero',
        oldHP: 17,
        newHP: 14,
        hpDamage: 3,
        tempDamage: 0,
        totalDamage: 3,
        damageDetail: [{ type: 'piercing', value: 3 }],
      },
    ],
    ...extra,
  };
}

describe("readMidiAttack: what Midi-QOL's workflow decided", () => {
  it('the measured 45 ft throw: hit, at disadvantage for Long Range, 3 piercing applied', () => {
    const r = readMidiAttack(wf(), TARGET);
    expect(r).toMatchObject({
      ran: true,
      state: 'WorkflowState_Cleanup',
      hit: true,
      crit: false,
      attackTotal: 12,
      formula: '2d20dis + 2 + 2',
      attackMode: 'thrown',
      targetAC: 11,
      disadvantage: true,
      advantage: false,
      rollMode: 'disadvantage',
      disadvantageReasons: ['Long Range'],
      advantageReasons: [],
      damageRolled: 3,
      damageApplied: 3,
      damageType: 'piercing',
      engineHpAfter: 14,
      error: null,
    });
    expect(r.rollModifiers).toEqual({ DIS: ['Long Range'], NOCRIT: ['Direct assignment'] });
  });

  it('a miss: no damage is counted even if a damage list exists', () => {
    const r = readMidiAttack(wf({ hitTargets: new Set() }), TARGET);
    expect(r.hit).toBe(false);
    expect(r.damageApplied).toBe(0);
    expect(r.engineHpAfter).toBeNull();
  });

  it('advantage and disadvantage that cancel: a normal roll, both sources kept in rollModifiers', () => {
    const r = readMidiAttack(
      wf({
        attackRoll: { formula: '1d20 + 4', total: 14, options: { advantageMode: 0 } },
        attackRollModifierTracker: {
          attribution: { ADV: { 'attack.all': 'Pack Tactics' }, DIS: { range: 'Long Range' } },
        },
      }),
      TARGET
    );
    expect(r.rollMode).toBe('normal');
    expect(r.advantageReasons).toEqual([]);
    expect(r.disadvantageReasons).toEqual([]);
    expect(r.rollModifiers).toEqual({ ADV: ['Pack Tactics'], DIS: ['Long Range'] });
  });

  it("Midi's damage floor: a -1 roll (a Str 7 Unarmed Strike) is rolled -1 and applied 0", () => {
    const r = readMidiAttack(
      wf({
        damageRolls: [{ formula: '1 - 2', total: -1, options: { type: 'bludgeoning' } }],
        damageList: [
          {
            targetUuid: 'Scene.s1.Token.hero',
            newHP: 14,
            hpDamage: 0,
            tempDamage: 0,
            totalDamage: 0,
          },
        ],
      }),
      TARGET
    );
    expect(r.damageRolled).toBe(-1);
    expect(r.damageApplied).toBe(0);
  });

  it('resistance: the applied damage is the damage list total after it, the roll before it', () => {
    const r = readMidiAttack(
      wf({
        damageRolls: [{ formula: '1d4 + 2', total: 6, options: { type: 'piercing' } }],
        damageList: [
          {
            targetUuid: 'Scene.s1.Token.hero',
            newHP: 14,
            hpDamage: 3,
            totalDamage: 3,
            damageDetail: [{ type: 'piercing', value: 3 }],
          },
        ],
      }),
      TARGET
    );
    expect(r.damageRolled).toBe(6);
    expect(r.damageApplied).toBe(3);
    expect(r.damageDetail).toEqual([{ type: 'piercing', value: 3 }]);
  });

  it('total cover: no AC number, and it says so', () => {
    const r = readMidiAttack(
      wf({
        hitTargets: new Set(),
        hitDisplayData: { 'Scene.s1.Token.hero': { ac: Infinity, acDisplay: '∞', baseAc: 11 } },
      }),
      TARGET
    );
    expect(r.totalCover).toBe(true);
    expect(r.targetAC).toBeNull();
    expect(r.targetBaseAC).toBe(11);
  });

  it('nothing back, aborted, or no attack roll: not run, and the error says which', () => {
    expect(readMidiAttack(undefined, TARGET)).toMatchObject({ ran: false, hit: false });
    expect(readMidiAttack(undefined, TARGET).error).toMatch(/gave nothing back/);
    expect(readMidiAttack(wf({ aborted: true }), TARGET).error).toMatch(
      /aborted at WorkflowState_Cleanup/
    );
    expect(
      readMidiAttack(
        wf({ attackRoll: null, currentAction: { name: 'WorkflowState_RollFinished' } }),
        TARGET
      ).error
    ).toMatch(/no attack roll \(at WorkflowState_RollFinished\)/);
  });

  it('the hit is matched by token id when the uuid differs (an unlinked token)', () => {
    const r = readMidiAttack(wf(), { uuid: 'Scene.s1.Token.other', id: 'hero' });
    expect(r.hit).toBe(true);
  });
});

// Board #1887, review of bridge 0.10.8 (618a313): what a use spends, once for all targets.
describe('activitySpendsOnUse: used once for all targets', () => {
  it('a levelled spell, or an activity with consumption targets or limited uses', () => {
    expect(activitySpendsOnUse({ type: 'spell' }, {}, 1)).toBe(true);
    expect(activitySpendsOnUse({}, { consumption: { targets: [{ type: 'itemUses' }] } }, 0)).toBe(
      true
    );
    expect(activitySpendsOnUse({}, { uses: { max: '3' } }, 0)).toBe(true);
  });
  it('a cantrip or a plain weapon attack: no (one attack per target, as before)', () => {
    expect(activitySpendsOnUse({ type: 'spell' }, { consumption: { targets: [] } }, 0)).toBe(false);
    expect(activitySpendsOnUse({ type: 'weapon' }, { uses: { max: '' } }, 0)).toBe(false);
    expect(activitySpendsOnUse({ type: 'weapon' }, {}, 0)).toBe(false);
  });
});

describe('spentOnUse: what a use spent, in plain words', () => {
  it('a slot, uses, or nothing', () => {
    const n = { slot: null, itemUses: null, activityUses: null };
    expect(spentOnUse({ ...n, slot: 2 }, { ...n, slot: 1 })).toEqual({
      any: true,
      words: 'a spell slot',
    });
    expect(spentOnUse({ ...n, itemUses: 3 }, { ...n, itemUses: 1 })).toEqual({
      any: true,
      words: '2 uses of the item',
    });
    expect(spentOnUse({ ...n, slot: 1 }, { ...n, slot: 1 })).toEqual({ any: false, words: '' });
    expect(spentOnUse(n, n).any).toBe(false);
  });
});

// Board #1887 (bridge 0.10.8 round 3)
describe('midiAttackOptions: the per-call Dice So Nice switches', () => {
  it('skipDiceAnimation sends attackRollDSN and damageRollDSN false', () => {
    const wo = midiAttackOptions({
      attackMode: 'oneHanded',
      skipDiceAnimation: true,
    }).workflowOptions;
    expect(wo.attackRollDSN).toBe(false);
    expect(wo.damageRollDSN).toBe(false);
  });
  it('without it neither switch is sent', () => {
    const wo = midiAttackOptions({ attackMode: 'oneHanded' }).workflowOptions;
    expect('attackRollDSN' in wo).toBe(false);
    expect('damageRollDSN' in wo).toBe(false);
  });
});

describe('guardStoppedWorkflow: a stopped workflow goes to Abort from any later state', () => {
  it('every later state of THIS workflow answers Abort; Abort, Cleanup and other workflows are untouched', async () => {
    class Wf {
      WorkflowState_Abort = { name: 'abort' };
      async WorkflowState_AllRollsComplete() {
        return 'applied damage';
      }
      async WorkflowState_Cleanup() {
        return 'cleanup';
      }
    }
    const a: any = new Wf();
    const b: any = new Wf();
    const guarded = guardStoppedWorkflow(a);
    expect(guarded).toContain('WorkflowState_AllRollsComplete');
    expect(await a.WorkflowState_AllRollsComplete.call(a)).toBe(a.WorkflowState_Abort);
    expect(await a.WorkflowState_Cleanup()).toBe('cleanup');
    expect(await b.WorkflowState_AllRollsComplete()).toBe('applied damage');
    expect(a.aidmStoppedByBridge).toBe(true);
  });
  it('lists the states that roll or apply something, and never Abort, Cleanup or Completed', () => {
    expect(MIDI_STATES_AFTER_STOP).toContain('WorkflowState_AllRollsComplete');
    expect(MIDI_STATES_AFTER_STOP).toContain('WorkflowState_ApplyDynamicEffects');
    for (const s of ['WorkflowState_Abort', 'WorkflowState_Cleanup', 'WorkflowState_Completed'])
      expect(MIDI_STATES_AFTER_STOP).not.toContain(s);
  });
  it('nothing to guard on a missing workflow', () => {
    expect(guardStoppedWorkflow(null)).toEqual([]);
  });
});

// Board #1887 (bridge 0.10.8 round 4)
describe("engineTargetCount: the activity's own evaluated target count", () => {
  it('a number, a numeric string, and none', () => {
    expect(engineTargetCount({ target: { affects: { count: 1 } } })).toBe(1);
    expect(engineTargetCount({ target: { affects: { count: '3' } } })).toBe(3);
    expect(engineTargetCount({ target: { affects: { count: '' } } })).toBeNull();
    expect(engineTargetCount({ target: { affects: {} } })).toBeNull();
    expect(engineTargetCount({ target: { affects: { count: 0 } } })).toBeNull();
    expect(engineTargetCount(null)).toBeNull();
  });
});

describe("Midi-QOL's own refusal words", () => {
  it('the too-many-targets text, from the world or in English', () => {
    expect(wrongNumberTargetsWords(1)).toBe(
      'You must target at most 1 token(s) before rolling the attack'
    );
    expect(wrongNumberTargetsWords(2, (_k, d) => `Au plus ${d.allowedTargets} cibles`)).toBe(
      'Au plus 2 cibles'
    );
    expect(wrongNumberTargetsWords(2, k => k)).toBe(
      'You must target at most 2 token(s) before rolling the attack'
    );
  });
  it("only Midi's refusal texts count as a refusal", () => {
    expect(isMidiRefusalText('You must target at most 3 token(s) before rolling the attack')).toBe(
      true
    );
    expect(isMidiRefusalText('You must target a token before rolling the attack')).toBe(true);
    expect(isMidiRefusalText('Some add-on says hello')).toBe(false);
    expect(isMidiRefusalText('')).toBe(false);
    const fr = (k: string) =>
      k === 'midi-qol.wrongNumberTargets' ? 'Au plus {allowedTargets} cibles' : k;
    expect(isMidiRefusalText('Au plus 2 cibles', fr)).toBe(true);
  });
});

describe("usageCostErrors: dnd5e's own check of what a use costs", () => {
  it("dnd5e's messages when it cannot pay, none when it can, null when it cannot check", async () => {
    const act = (errors: string[]) => ({
      _prepareUsageConfig: (c: any) => c,
      _prepareUsageUpdates: async (_c: any, o: any) =>
        errors.length && o.returnErrors ? errors.map(m => ({ message: m })) : {},
    });
    expect(await usageCostErrors(act(['No uses on X available to spend, 1 required.']))).toEqual([
      'No uses on X available to spend, 1 required.',
    ]);
    expect(await usageCostErrors(act([]))).toEqual([]);
    expect(await usageCostErrors({})).toBeNull();
  });
});

describe("consumedDeltas: dnd5e's own refund record from two readings", () => {
  it('a slot and a use of the item and of the activity', () => {
    const d = consumedDeltas(
      { slot: 3, itemUses: 2, activityUses: 1 },
      { slot: 2, itemUses: 1, activityUses: 0 },
      { spellLevel: 1, itemId: 'i1', activityId: 'a1' }
    );
    expect(d.actor).toEqual([{ keyPath: 'system.spells.spell1.value', delta: -1 }]);
    expect(d.item).toEqual({
      i1: [
        { keyPath: 'system.uses.spent', delta: 1 },
        { keyPath: 'system.activities.a1.uses.spent', delta: 1 },
      ],
    });
  });
  it('nothing spent, nothing to give back', () => {
    const d = consumedDeltas(
      { slot: 2, itemUses: null, activityUses: null },
      { slot: 2, itemUses: null, activityUses: null },
      { spellLevel: 1, itemId: 'i1', activityId: 'a1' }
    );
    expect(d).toEqual({ actor: [], item: {} });
  });
});

describe('midiSaveOptions: the save path asks for no reactions and no dialog', () => {
  it('reactions off by default, the target given, damage rolled', () => {
    const o = midiSaveOptions({});
    expect(o.workflowOptions).toEqual({ targetConfirmation: 'none', noProvokeReaction: true });
    expect(o.autoRollDamage).toBe('always');
    expect(midiSaveOptions({ reactions: true }).workflowOptions.noProvokeReaction).toBeUndefined();
  });
});

describe("round 4 (review S1): one effect of the caster's choice", () => {
  const ef = (id: string, name: string, statuses: string[] = [], extra: any = {}) => ({
    id,
    uuid: `Item.i.ActiveEffect.${id}`,
    name,
    statuses: new Set(statuses),
    transfer: false,
    type: 'base',
    flags: {},
    ...extra,
  });
  const ed = (e: any, more: any = {}) => ({
    _id: e.id,
    effect: e,
    onSave: false,
    level: { min: null, max: null },
    ...more,
  });

  it("the choices are Midi-QOL's own applicable list: no transfer, enchantment, on-save, wrong-level or caster's own effect", () => {
    const act = {
      relevantLevel: 3,
      effects: [
        ed(ef('a', 'Blindness', ['blinded'])),
        ed(ef('b', 'Deafness', ['deafened'])),
        ed(ef('c', 'Passive', [], { transfer: true })),
        ed(ef('d', 'Enchant', [], { type: 'enchantment' })),
        ed(ef('e', 'On a save'), { onSave: true }),
        ed(ef('f', 'Upcast only'), { level: { min: 5, max: null } }),
        ed(ef('g', 'Concentrating mark', [], { flags: { dae: { selfTarget: true } } })),
        { _id: 'h', effect: null },
      ],
    };
    expect(activityEffectChoices(act, 2).map(c => c.name)).toEqual(['Blindness', 'Deafness']);
    expect(activityEffectChoices(act, 5).map(c => c.name)).toContain('Upcast only');
    expect(activityEffectChoices(act).map(c => c.name)).toEqual(['Blindness', 'Deafness']);
    expect(
      itemEffectChoices([
        ef('x', 'Hexed Strength'),
        ef('y', 'Self', [], { flags: { dae: { selfTargetAlways: true } } }),
      ]).map(c => c.name)
    ).toEqual(['Hexed Strength']);
  });

  it('a named choice matches by name, then by the condition it gives, then by the one name that contains it', () => {
    const choices = activityEffectChoices({
      effects: [ed(ef('a', 'Blindness', ['blinded'])), ed(ef('b', 'Deafness', ['deafened']))],
    });
    expect(pickEffectChoice(choices, 'blindness').chosen?.name).toBe('Blindness');
    expect(pickEffectChoice(choices, 'Deafened').chosen?.name).toBe('Deafness');
    expect(pickEffectChoice(choices, 'deaf').chosen?.name).toBe('Deafness');
    expect(pickEffectChoice(choices, '').problem).toBe('missing');
    expect(pickEffectChoice(choices, undefined).problem).toBe('missing');
    expect(pickEffectChoice(choices, 'charmed').problem).toBe('unknown');
    expect(pickEffectChoice(choices, 'ness').problem).toBe('ambiguous');
    expect(effectChoiceWords('Blindness/Deafness', choices, 'missing')).toMatch(
      /choose one of Blindness, Deafness/
    );
  });

  it("Midi's list is cut to the chosen effect; the caster's own effects stay", () => {
    const a = ef('a', 'Hexed Strength');
    const b = ef('b', 'Hexed Wisdom');
    const self = ef('s', 'Hex (caster)', [], { flags: { dae: { selfTarget: true } } });
    const chosen = itemEffectChoices([a, b])[1];
    expect(keepChosenEffect([a, b, self], chosen).map(e => e.name)).toEqual([
      'Hexed Wisdom',
      'Hex (caster)',
    ]);
    // the same item's effect by id when Midi hands a copy with another uuid
    expect(
      keepChosenEffect([{ ...b, uuid: 'Scene.s.Token.t.Actor.x.Item.i.ActiveEffect.b' }], chosen)
    ).toHaveLength(1);
  });
});

describe('round 5: the activity list, the data-marked choice, the slot a use spends', () => {
  const ef = (id: string, name: string, extra: any = {}) => ({
    id,
    uuid: `Item.i.ActiveEffect.${id}`,
    name,
    statuses: new Set(),
    transfer: false,
    type: 'base',
    flags: {},
    ...extra,
  });
  it("the activity's own effects at the level cast, the caster's own ones apart", () => {
    const act = {
      effects: [
        { _id: 'a', effect: ef('a', 'Ward +1'), level: { min: 1, max: 2 } },
        { _id: 'b', effect: ef('b', 'Ward +3'), level: { min: 3, max: null } },
        { _id: 'c', effect: ef('c', 'Mark', { flags: { dae: { selfTarget: true } } }), level: {} },
      ],
    };
    const d = activityEffectDocs(act, 1);
    expect(d.target.map((e: any) => e.name)).toEqual(['Ward +1']);
    expect(d.self.map((e: any) => e.name)).toEqual(['Mark']);
    expect(activityEffectDocs(act, 3).target.map((e: any) => e.name)).toEqual(['Ward +3']);
  });

  it("a choice only where Midi-QOL's own chooseEffects says so", () => {
    expect(effectsNeedChoice({ midiProperties: { chooseEffects: true } })).toBe(true);
    expect(effectsNeedChoice({ midiProperties: { chooseEffects: false } })).toBe(false);
    expect(effectsNeedChoice({})).toBe(false);
    expect(
      effectsUnclearWords('Mirror Image', [
        { name: 'Duplicate A', id: 'a', uuid: null, statuses: [] },
        { name: 'Duplicate B', id: 'b', uuid: null, statuses: [] },
      ])
    ).toMatch(
      /Mirror Image lists several effects \(Duplicate A, Duplicate B\).*never all of them at once/
    );
  });

  it("the slot is dnd5e's own choice: pact, none, or spell<level> when dnd5e cannot be asked", () => {
    const spell = { type: 'spell', system: { level: 2 } };
    expect(
      spellSlotKey(
        { _prepareUsageConfig: () => ({ consume: { spellSlot: true }, spell: { slot: 'pact' } }) },
        spell
      )
    ).toBe('pact');
    expect(
      spellSlotKey({ _prepareUsageConfig: () => ({ consume: { spellSlot: false } }) }, spell)
    ).toBe(null);
    expect(spellSlotKey({}, spell)).toBe('spell2');
    expect(spellSlotKey({}, { type: 'spell', system: { level: 0 } })).toBe(null);
    expect(
      spellSlotKey(
        {
          _prepareUsageConfig: () => {
            throw new Error('x');
          },
        },
        spell
      )
    ).toBe('spell2');
  });

  it("a pact slot's refund row names the pact slot; spending a slot is spending on use", () => {
    const d = consumedDeltas5(
      { slot: 1, itemUses: null, activityUses: null },
      { slot: 0, itemUses: null, activityUses: null },
      { spellLevel: 1, itemId: 'i', activityId: 'a', slotKey: 'pact' }
    );
    expect(d.actor).toEqual([{ keyPath: 'system.spells.pact.value', delta: -1 }]);
    expect(spendsOnUse5({}, {}, true)).toBe(true);
    expect(spendsOnUse5({}, {}, false)).toBe(false);
  });
});

describe("round 6: all of several effects apply only where the item's data lists the activity", () => {
  it('flags.aidm-rules.allEffects lists the activity id', () => {
    const act = { id: 'a1' };
    expect(effectsAllApply({ flags: { 'aidm-rules': { allEffects: ['a1'] } } }, act)).toBe(true);
    expect(effectsAllApply({ flags: { 'aidm-rules': { allEffects: ['a2'] } } }, act)).toBe(false);
    expect(effectsAllApply({ flags: {} }, act)).toBe(false);
    expect(effectsAllApply({}, {})).toBe(false);
  });
});
