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
