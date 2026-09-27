/**
 * Pure helpers for execute-attack's engine rules (board #1887, plan F.4(b), bridge 0.10.7, dnd-dm
 * KNOWN-ISSUES row 221).
 *
 * What was wrong (measured on the dnd-dm test stack, Foundry 14.367, dnd5e 5.3.3, Midi-QOL 14.0.12):
 * execute-attack asked Midi-QOL's own `checkActivityRange` whether an attack was legal, treated its
 * `dis` answer (the target is beyond normal range, inside long range) as plain "allowed", and then
 * rolled `activity.rollAttack({}, ...)` with no advantage mode and no attack mode. So a Dagger thrown
 * at 45 ft rolled `1d20`: Midi applies `dis` only inside its own workflow, which this path bypasses,
 * and dnd5e 5.3.3 applies no range rule of its own. A refusal Midi gave because a WALL blocks the
 * attack was worded "X is 10ft away, beyond the range of Dagger", with a distance measured as if
 * there were no walls.
 *
 * What dnd5e 5.3.3 does with an attack mode (its `AttackActivity#rollAttack`, read from the running
 * system and measured the same day on unlinked throwaway tokens):
 * - `{attackMode: 'thrown', disadvantage: true}` rolls `2d20dis` ("Attack Roll (Disadvantage)").
 * - A THROWN attack uses the weapon up: its quantity goes down by one (a Dagger 1 -> 0) unless the
 *   weapon has the Returning property. The item is NOT deleted and nothing is placed on the scene.
 * - It remembers the last mode in `flags.dnd5e.last.<activity id>.attackMode`, and an attack with no
 *   mode given uses that remembered mode: after one throw, a plain `rollAttack({})` is rolled as a
 *   throw again. So the mode is always passed explicitly here.
 * - At quantity 0 it only shows a warning and still rolls. By the rules there is no weapon left to
 *   attack with, so execute-attack refuses instead.
 *
 * These functions carry no dependency on Foundry's browser globals (the same discipline as
 * combat-scoping-utils.ts), so the rules can be unit tested with plain vitest. queries.ts asks
 * Midi-QOL and dnd5e and hands the answers in as plain data.
 */

/** Midi-QOL's `checkActivityRange(...).result`: `normal`, `dis` (long range) or `fail`. */
export type RangeVerdict = string;

export interface AttackModeInput {
  /** The weapon's `system.attackModes` values in dnd5e's own order. dnd5e puts separator rows with
   * no value between groups; those are ignored. */
  modes: Array<string | null | undefined>;
  /** The weapon has the Thrown property (`system.properties.has('thr')`). */
  thrownProperty: boolean;
  /** Midi-QOL's distance to the target in feet with walls ignored (`getDistance(.., {wallsBlock:
   * false})`, what Midi's own close-combat rule compares with the reach), or null/negative when it
   * could not be measured. */
  distanceFt: number | null | undefined;
  /** The weapon's reach in feet (`system.range.reach`, else one grid square). */
  reachFt: number;
  /** Midi-QOL's range verdict for this target. */
  verdict?: RangeVerdict | undefined;
}

export interface AttackModeChoice {
  /** The attack mode to pass to dnd5e, or undefined when the item has none (a spell, say). */
  mode: string | undefined;
  /** The weapon is thrown (dnd5e will use one up unless it returns). */
  thrown: boolean;
}

function usableModes(modes: Array<string | null | undefined>): string[] {
  return (modes || []).filter((m): m is string => typeof m === 'string' && m.length > 0);
}

/**
 * Which dnd5e attack mode an attack uses.
 *
 * Rules (PHB 2024, "Thrown"): a weapon with the Thrown property can be thrown to make a ranged
 * attack. A melee weapon's reach is the only way to hit without throwing it, so a target beyond the
 * weapon's reach is attacked by throwing it, and a target within reach is attacked in melee (the
 * weapon is kept). This is the same test Midi-QOL's own workflow uses to decide whether a thrown
 * weapon is being used in melee: distance with walls ignored, compared with `range.reach ?? 5`.
 *
 * When the distance could not be measured, a `dis` verdict still proves the target is beyond reach
 * (it is past normal range); otherwise the melee mode (dnd5e's own first choice) is used.
 * A weapon whose only modes are throws (a Dart) is always thrown.
 */
export function chooseAttackMode(input: AttackModeInput): AttackModeChoice {
  const values = usableModes(input.modes);
  if (!values.length) return { mode: undefined, thrown: false };
  const canThrow = !!input.thrownProperty && values.includes('thrown');
  const meleeMode = values.find(v => !v.startsWith('thrown') && v !== 'ranged');
  const d = input.distanceFt;
  const measured = typeof d === 'number' && Number.isFinite(d) && d >= 0;
  const beyondReach = measured ? d > input.reachFt : input.verdict === 'dis';
  if (canThrow && (beyondReach || !meleeMode)) return { mode: 'thrown', thrown: true };
  if (meleeMode) return { mode: meleeMode, thrown: false };
  const first = values[0] ?? '';
  return { mode: first, thrown: first.startsWith('thrown') };
}

export interface RollAdvantageInput {
  /** Midi-QOL's range verdict for the target. */
  verdict?: RangeVerdict | undefined;
  /** The attack is a ranged attack roll: a ranged weapon or spell attack, or a thrown weapon. */
  rangedAttack: boolean;
  /** Midi-QOL's `checkNearby` answer: an enemy who can see the attacker stands within Midi's
   * "nearby foe" distance (its optional rule, 5 ft on our worlds; 0 = the rule is off). */
  foeNearby: boolean;
}

export interface RollAdvantage {
  disadvantage: boolean;
  /** Plain words, one per reason, for the result and the log. */
  reasons: string[];
}

/**
 * The disadvantage the range rules give an attack roll (PHB 2024, "Ranged Attacks"): beyond normal
 * range ("Long Range"), and a ranged attack roll made within 5 feet of an enemy who can see you
 * ("Ranged Attacks in Close Combat"). Both answers are Midi-QOL's own; its workflow applies them the
 * same way (`longRangeAttack` and its `nearbyFoe` rule), and execute-attack bypasses that workflow.
 */
export function rangeRollAdvantage(input: RollAdvantageInput): RollAdvantage {
  const reasons: string[] = [];
  if (input.verdict === 'dis') reasons.push('long range');
  if (input.rangedAttack && input.foeNearby)
    reasons.push('an enemy within 5 ft can see the attacker');
  return { disadvantage: reasons.length > 0, reasons };
}

/** True when a weapon has none left to attack with: dnd5e's own quantity is 0 (a thrown weapon that
 * was used up). Only weapons count; an item without a numeric quantity is never refused here. */
export function weaponUsedUp(item: { type?: string; quantity?: unknown }): boolean {
  return item?.type === 'weapon' && typeof item.quantity === 'number' && item.quantity <= 0;
}

/**
 * dnd5e 5.3.3's OWN Unarmed Strike items, in the compendia the system ships (board #1887, operator decision
 * 2026-09-27 "Unarmed Strike": a monster with no weapon left makes an Unarmed Strike).
 *
 * The rules (PHB 2024, "Unarmed Strike"): every creature can make one; the attack roll adds the Strength modifier and
 * the Proficiency Bonus, and a hit deals Bludgeoning damage equal to 1 plus the Strength modifier. dnd5e 5.3.3 models
 * exactly that as a weapon item: `equipment24` `phbUnarmedStrike` (SRD 5.2, the 2024 rules; type `natural`,
 * `proficient: 1`, an attack activity with `ability: 'str'`, damage bonus `1 + @mod` bludgeoning), and the 2014 one in
 * the SRD 5.1 `items` pack (damage `1 + @mod`). The 2024 character premades get it by an ItemGrant of that uuid. A
 * monster's stat block never includes it, so execute-attack uses the system's own item, never a formula of ours.
 * Measured on the dnd-dm test stack (Kobold Warrior, Str 7, PB 2): attack `1d20 - 2 + 2`, damage `1 - 2`.
 */
export const UNARMED_STRIKE_UUID = {
  modern: 'Compendium.dnd5e.equipment24.Item.phbUnarmedStrike',
  legacy: 'Compendium.dnd5e.items.Item.GsuvwoekKZatfKwF',
} as const;

/** Is this the name of the Unarmed Strike every creature can make? */
export function isUnarmedStrike(name: unknown): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === 'unarmed strike';
}

/** Which of dnd5e's own Unarmed Strike items a world uses: its `dnd5e.rulesVersion` setting (`modern` is dnd5e's
 * default; `legacy` is the 2014 rules). */
export function unarmedStrikeUuid(rulesVersion: unknown): string {
  return rulesVersion === 'legacy' ? UNARMED_STRIKE_UUID.legacy : UNARMED_STRIKE_UUID.modern;
}

export interface DamagePart {
  total: number | null | undefined;
  type?: string | null | undefined;
}

/**
 * The damage dnd5e applies for a set of damage rolls: the rolls summed per damage type, and a type whose total is
 * below 0 counts as 0. That is dnd5e 5.3.3's own rule when it applies damage from its chat card
 * (`ChatMessage5e#applyChatCardDamage` and the card's damage application: `Math.max(0, roll.total)` per aggregated
 * roll). `Actor5e#applyDamage` itself has no floor: handed a negative number it HEALS. Measured on the test stack: a
 * Kobold Warrior's Unarmed Strike (Str 7) rolls `1 - 2` = -1, which must apply as 0, not heal the target by 1.
 */
export function appliedDamage(parts: DamagePart[]): number {
  const byType = new Map<string, number>();
  for (const p of parts || []) {
    const k = String(p?.type ?? '');
    byType.set(k, (byType.get(k) ?? 0) + (Number(p?.total) || 0));
  }
  let sum = 0;
  for (const v of byType.values()) sum += Math.max(0, v);
  return sum;
}

export interface RangeRefusalInput {
  targetName: string;
  itemName: string;
  /** Midi-QOL measured the distance with its wall rule and got "blocked" (a negative distance). */
  wallBlocked: boolean;
  /** The distance Midi-QOL measured with its wall rule, in feet (when not blocked). */
  measuredFt: number | null | undefined;
  /** Normal and long range Midi-QOL used (`checkActivityRange(...).range` / `.longRange`). */
  normalFt?: number | null | undefined;
  longFt?: number | null | undefined;
}

export interface RangeRefusal {
  note: string;
  blockedByWall?: true;
  outOfRange?: true;
  distanceFt?: number;
}

/**
 * The words for an attack Midi-QOL refused (`fail`). A wall between the two says so; a target that is
 * too far is given the distance Midi-QOL itself measured and the weapon's own range.
 */
export function describeRangeRefusal(input: RangeRefusalInput): RangeRefusal {
  if (input.wallBlocked) {
    return {
      note: `a wall is in the way: ${input.itemName} cannot reach ${input.targetName}`,
      blockedByWall: true,
    };
  }
  const d = input.measuredFt;
  const rng =
    typeof input.normalFt === 'number' && input.normalFt > 0
      ? typeof input.longFt === 'number' && input.longFt > input.normalFt
        ? ` (range ${input.normalFt}/${input.longFt} ft)`
        : ` (range ${input.normalFt} ft)`
      : '';
  if (typeof d === 'number' && Number.isFinite(d) && d >= 0) {
    const ft = Math.round(d);
    return {
      note: `${input.targetName} is ${ft} ft away, beyond the range of ${input.itemName}${rng}`,
      outOfRange: true,
      distanceFt: ft,
    };
  }
  return {
    note: `${input.targetName} is out of the range of ${input.itemName}${rng}`,
    outOfRange: true,
  };
}
