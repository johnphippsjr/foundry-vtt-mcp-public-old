/** Board #1887 (bridge 0.10.7): the pure range-rule helpers behind execute-attack. */

import { describe, it, expect } from 'vitest';
import {
  chooseAttackMode,
  rangeRollAdvantage,
  weaponUsedUp,
  describeRangeRefusal,
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
