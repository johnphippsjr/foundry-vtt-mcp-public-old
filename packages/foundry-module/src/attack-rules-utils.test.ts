/** Board #1887 (bridge 0.10.7): the pure range-rule helpers behind execute-attack. */

import { describe, it, expect } from 'vitest';
import {
  chooseAttackMode,
  rangeRollAdvantage,
  weaponUsedUp,
  describeRangeRefusal,
  isUnarmedStrike,
  unarmedStrikeUuid,
  appliedDamage,
  UNARMED_STRIKE_UUID,
  pickItemByName,
  usedUpCount,
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

describe('rangeRollAdvantage', () => {
  it('long range gives disadvantage', () => {
    expect(rangeRollAdvantage({ verdict: 'dis', rangedAttack: true, foeNearby: false })).toEqual({
      disadvantage: true,
      reasons: ['long range'],
    });
  });
  it('an enemy close by gives disadvantage to a ranged attack only', () => {
    expect(rangeRollAdvantage({ verdict: 'normal', rangedAttack: true, foeNearby: true })).toEqual({
      disadvantage: true,
      reasons: ['an enemy within 5 ft can see the attacker'],
    });
    expect(
      rangeRollAdvantage({ verdict: 'normal', rangedAttack: false, foeNearby: true }).disadvantage
    ).toBe(false);
  });
  it('both reasons are listed; normal range and nobody close: none', () => {
    expect(
      rangeRollAdvantage({ verdict: 'dis', rangedAttack: true, foeNearby: true }).reasons
    ).toHaveLength(2);
    expect(rangeRollAdvantage({ verdict: 'normal', rangedAttack: true, foeNearby: false })).toEqual(
      {
        disadvantage: false,
        reasons: [],
      }
    );
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

describe('appliedDamage: below 0 deals 0, per damage type (dnd5e 5.3.3 chat-card rule)', () => {
  it("a kobold's Unarmed Strike, 1 - 2 = -1, applies 0", () => {
    expect(appliedDamage([{ total: -1, type: 'bludgeoning' }])).toBe(0);
  });
  it('positive rolls are summed as before', () => {
    expect(
      appliedDamage([
        { total: 4, type: 'piercing' },
        { total: 3, type: 'fire' },
      ])
    ).toBe(7);
  });
  it('the floor is per type: a negative part of the same type is summed first', () => {
    expect(
      appliedDamage([
        { total: 5, type: 'slashing' },
        { total: -2, type: 'slashing' },
      ])
    ).toBe(3);
    expect(
      appliedDamage([
        { total: 5, type: 'slashing' },
        { total: -2, type: 'fire' },
      ])
    ).toBe(5);
  });
  it('nothing rolled is 0', () => {
    expect(appliedDamage([])).toBe(0);
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
