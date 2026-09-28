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
 *   attack with, so execute-attack refuses instead. (HOUSE RULE, board #1887 bridge 0.10.8: neither
 *   dnd5e 5.3.3 nor Midi-QOL 14.0.12 has a setting that refuses it; dnd5e's `rollAttack` only warns,
 *   attack.mjs line 88. It moves to the aidm-rules add-on, orchestrator 2026-09-27.)
 *
 * Bridge 0.10.8 (board #1887, engine map M07, operator 2026-09-27 "let Foundry handle the rules"):
 * the attack itself is no longer rolled here. `execute-attack` runs Midi-QOL's OWN attack workflow
 * (`MidiQOL.completeActivityUse`) and only READS BACK what the engine decided: the hit, the critical,
 * the advantage and its reasons, the AC it compared with, the damage after resistances. The helpers
 * that did the rules by hand (0.10.7's `rangeRollAdvantage`, `midiIgnoresNearbyFoes`, `appliedDamage`,
 * and the hand-rolled critical dice in queries.ts) are gone; `midiAttackOptions`, `readMidiAttack` and
 * `midiCriticalDamageProblem` below replace them.
 *
 * These functions carry no dependency on Foundry's browser globals (the same discipline as
 * combat-scoping-utils.ts), so they can be unit tested with plain vitest. queries.ts asks
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

/** True when a weapon has none left to attack with: dnd5e's own quantity is 0 (a thrown weapon that
 * was used up). Only weapons count; an item without a numeric quantity is never refused here. */
export function weaponUsedUp(item: { type?: string; quantity?: unknown }): boolean {
  return item?.type === 'weapon' && typeof item.quantity === 'number' && item.quantity <= 0;
}

/**
 * How many of a weapon one attack REALLY used up (board #1887, re-review of fork 876a95d): the item's quantity read
 * before the roll minus after it, never below 0. dnd5e 5.3.3 takes one off a thrown weapon's quantity unless it has the
 * Returning property (`AttackActivity#rollAttack`), and a roll that failed takes nothing, so "the mode was thrown" is
 * not "one was used up" (the reviewer's probe: a Javelin of Returning thrown three times came back 1 -> 4 after the
 * fight). null when the item is not a weapon or a quantity could not be read.
 */
export function usedUpCount(itemType: unknown, before: unknown, after: unknown): number | null {
  if (itemType !== 'weapon') return null;
  if (typeof before !== 'number' || typeof after !== 'number') return null;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return Math.max(0, before - after);
}

export interface NamedItemLike {
  name?: string | null;
  type?: string;
  system?: { quantity?: unknown; activities?: { size?: number } | null } | null;
}

/**
 * Which of an actor's items an attack by NAME means (board #1887, independent review of bridge 0.10.7, finding 2).
 * An actor can hold several stacks with one name: a character who threw every Javelin of one stack (quantity 0, the
 * item is kept, dnd5e's way) and then picked up a new stack of Javelins. Taking the first name match refused the
 * attack ("has no Javelin left") while the new stack sat in the pack. Among the items whose name matches (ignoring
 * case), the first one that can attack and is not used up; else the first that can attack; else the first match;
 * null when nothing has the name.
 */
export function pickItemByName<T extends NamedItemLike>(
  items: Iterable<T>,
  name: string
): T | null {
  const want = String(name ?? '').toLowerCase();
  const matches = [...items].filter(i => (i?.name ?? '').toLowerCase() === want);
  const canAttack = (i: T) => !!i?.system?.activities?.size;
  const notUsedUp = (i: T) => !weaponUsedUp({ type: i?.type ?? '', quantity: i?.system?.quantity });
  return (
    matches.find(i => canAttack(i) && notUsedUp(i)) ??
    matches.find(i => canAttack(i)) ??
    matches[0] ??
    null
  );
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

// ================================================================================================
// Bridge 0.10.8 (board #1887, engine map M07): the attack runs through Midi-QOL's OWN workflow, and
// execute-attack reads back what the engine decided.
// ================================================================================================

export interface MidiAttackOptionsInput {
  /** The dnd5e attack mode (chooseAttackMode). Midi-QOL 14.0.12 opens its roll dialog for any weapon with the Thrown
   * property unless a mode is named in `workflowOptions.attackMode` (AttackActivity.ts, `rollAttack`); nobody can
   * answer a dialog in the headless GM browser, so the workflow waits for ever (measured on the test stack
   * 2026-09-27: 20 s and still waiting in WaitForAttackRoll, an AttackRollConfigurationDialog open). */
  attackMode?: string | undefined;
  /** Let Midi-QOL run reactions (Shield, Parry). Off unless the caller asks; see midiAttackOptions. */
  reactions?: boolean | undefined;
  /** Midi-QOL does not show (and so does not wait for) Dice So Nice's 3D dice for this attack's attack and damage
   * rolls (its own per-call `workflowOptions.attackRollDSN` / `damageRollDSN`); see midiAttackOptions. */
  skipDiceAnimation?: boolean | undefined;
}

/**
 * The `usage.midiOptions` execute-attack hands to `MidiQOL.completeActivityUse` (the caller adds `targetsToUse`).
 * Only automation for a GM with no hands; nothing here changes a rule:
 * - autoRollAttack, fastForwardAttack, autoRollDamage 'onHit', fastForwardDamage: no chat-card button and no roll
 *   dialog waits for a click. Midi-QOL 14.0.12 reads the GM's fast-forward from `gmAutoFastForward` (an array); the
 *   test world holds [] there (gmhost writes Midi 13's keys), so without these a GM roll would open a dialog.
 * - workflowOptions.attackMode: see MidiAttackOptionsInput.
 * - workflowOptions.targetConfirmation 'none': Midi's target confirmation dialog never opens; the target is given.
 * - workflowOptions.noProvokeReaction (unless `reactions` is true): Midi-QOL's own switch for "no reactions for this
 *   attack". Measured 2026-09-27 on the test stack: Midi-QOL 14.0.12 REQUIRES the DAE add-on (its module.json) and our
 *   worlds do not run DAE. When a target has a usable reaction (a Knight's Parry, on a hit), Midi asks the robot GM,
 *   waits its reactionTimeout (10 s), then crashes in `doReactions` (`globalThis.DAE.actionQueue` of an undefined DAE)
 *   and never applies the damage. 0.10.7 never ran reactions either, so this keeps today's game; turning them on is
 *   the operator's decision. (2026-09-28: with DAE the crash is gone; the operator ruled reactions stay OFF until the
 *   aidm-rules reaction chooser exists, popup "With the chooser".)
 * - workflowOptions.attackRollDSN / damageRollDSN false (when `skipDiceAnimation`): Midi-QOL's own per-call switches
 *   (AttackActivity.ts 562, MidiActivityMixin.ts 1316-1328). Midi then neither WAITS for Dice So Nice's animation on
 *   the rolling client (the headless GM browser, where it takes seconds or never ends) nor marks the dice as already
 *   shown (its displayDSNForRoll ends with DSNMarkDiceDisplayed), so Dice So Nice shows them from the chat message.
 */
export function midiAttackOptions(input: MidiAttackOptionsInput): {
  autoRollAttack: true;
  fastForwardAttack: true;
  autoRollDamage: 'onHit';
  fastForwardDamage: true;
  workflowOptions: Record<string, unknown>;
} {
  const workflowOptions: Record<string, unknown> = { targetConfirmation: 'none' };
  if (input.attackMode) workflowOptions.attackMode = input.attackMode;
  if (!input.reactions) workflowOptions.noProvokeReaction = true;
  if (input.skipDiceAnimation) {
    workflowOptions.attackRollDSN = false;
    workflowOptions.damageRollDSN = false;
  }
  return {
    autoRollAttack: true,
    fastForwardAttack: true,
    autoRollDamage: 'onHit',
    fastForwardDamage: true,
    workflowOptions,
  };
}

/** Midi-QOL 14.0.12's critical damage choices (settings.ts, `criticalDamageChoices`). */
export const MIDI_CRITICAL_DAMAGE_CHOICES: readonly string[] = [
  'default',
  'maxDamage',
  'maxCrit',
  'maxCritRoll',
  'maxAll',
  'doubleDice',
  'explode',
  'maxDamageExplode',
  'explodeCharacter',
  'explodeNPC',
  'baseDamage',
  'maxBaseRollCrit',
  'bestOfTwo',
];

/**
 * Plain words when Midi-QOL's critical damage setting for the GM is a value Midi does not handle; null otherwise.
 * Midi-QOL 14.0.12 uses `criticalDamageGM` for every roll the GM makes (every roll execute-attack makes), and its own
 * shipped default is 'none', which is not one of its choices: its critical switch (patching.ts, configureDamage) then
 * adds NO critical dice and never calls dnd5e's own critical doubling. Measured 2026-09-27 on the test stack: a forced
 * natural 20 with a Dagger rolled '1d4 + 2'. This is reported, not worked around: the fix is a world setting.
 */
export function midiCriticalDamageProblem(value: unknown): string | null {
  if (typeof value === 'string' && MIDI_CRITICAL_DAMAGE_CHOICES.includes(value)) return null;
  return (
    `Midi-QOL's critical damage setting for the GM is '${String(value)}', which Midi-QOL does not handle: ` +
    `a critical hit it rolls adds no critical dice (dnd5e's own rule doubles the damage dice). ` +
    `It is a world setting (Midi-QOL, Workflow, Damage: critical damage for the GM)`
  );
}

/** Which token a Midi-QOL workflow result is about: the token document's uuid (Midi keys its damage list and its hit
 * display by it) and the token id. */
export interface MidiTargetRef {
  uuid?: string | null | undefined;
  id?: string | null | undefined;
}

export interface MidiAttackReadback {
  /** Midi-QOL's workflow finished and made an attack roll. */
  ran: boolean;
  /** The workflow state it ended in (`WorkflowState_Cleanup` for a finished attack). */
  state: string | null;
  hit: boolean;
  crit: boolean;
  fumble: boolean;
  attackTotal: number | null;
  formula: string | null;
  attackMode: string | null;
  /** The AC Midi-QOL compared the attack with (cover, reactions and its AC flags in); null for total cover or when
   * Midi recorded none. */
  targetAC: number | null;
  /** The target's own AC before those (Midi's `baseAc`). */
  targetBaseAC: number | null;
  totalCover: boolean;
  /** Midi-QOL's own words for how it got the AC (its hit card tooltip), when it has them. */
  acDetail: string | null;
  advantage: boolean;
  disadvantage: boolean;
  rollMode: 'advantage' | 'disadvantage' | 'normal';
  /** Midi-QOL's reasons for the advantage the roll was made with (empty when it was not). */
  advantageReasons: string[];
  /** Midi-QOL's reasons for the disadvantage the roll was made with (empty when it was not). */
  disadvantageReasons: string[];
  /** Every source Midi-QOL recorded, by kind (ADV, DIS, NOADV, NODIS, CRIT, NOCRIT, FUMBLE, ...), even when they
   * cancelled out. */
  rollModifiers: Record<string, string[]>;
  /** The damage rolls' totals added up, before resistances (may be below 0). 0 when no damage was rolled. */
  damageRolled: number;
  damageRolls: Array<{ formula: string | null; total: number | null; type: string | null }>;
  damageType: string | null;
  /** The damage Midi-QOL dealt this target: its damage list's total after the target's resistances, immunities and
   * vulnerabilities, never below 0 (Midi's own floor). 0 on a miss. */
  damageApplied: number;
  /** That damage by type, after resistances. */
  damageDetail: Array<{ type: string | null; value: number | null }>;
  /** Temporary hit points it took. */
  tempDamage: number;
  /** The hit points Midi-QOL worked out for the target (its damage list's newHP), null when it dealt none. */
  engineHpAfter: number | null;
  error: string | null;
}

function tokenMatches(tok: any, ref: MidiTargetRef): boolean {
  if (!tok) return false;
  const uuid = tok?.document?.uuid ?? tok?.uuid;
  const id = tok?.id ?? tok?.document?.id;
  return (!!ref.uuid && uuid === ref.uuid) || (!!ref.id && id === ref.id);
}

function setHas(set: any, ref: MidiTargetRef): boolean {
  if (!set) return false;
  for (const t of set as Iterable<any>) if (tokenMatches(t, ref)) return true;
  return false;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function stateName(wf: any): string | null {
  const a = wf?.currentAction;
  if (!a) return null;
  const n = typeof a?.name === 'string' ? a.name : String(a);
  return n ? String(n).replace(/^bound /, '') : null;
}

/**
 * What Midi-QOL's attack workflow decided for one target, read from the workflow `completeActivityUse` returned. The
 * fields are Midi-QOL 14.0.12's own (Workflow.ts): `hitTargets` / `hitTargetsEC` (checkHits), `isCritical`,
 * `isFumble`, `attackRoll` (dnd5e's D20Roll, with `options.advantageMode` and `options.attackMode`), `attackTotal`,
 * `attackRollModifierTracker.attribution` (every advantage and disadvantage source by kind), `hitDisplayData[token
 * uuid]` (the AC it compared with, `ac`, and the target's own, `baseAc`), `damageRolls`, `damageList` (per target:
 * `totalDamage` after resistances and floored at 0, `hpDamage`, `tempDamage`, `newHP`, `damageDetail`).
 * No rule is worked out here: a missing field is reported as missing, never guessed.
 */
export function readMidiAttack(wf: any, ref: MidiTargetRef): MidiAttackReadback {
  const out: MidiAttackReadback = {
    ran: false,
    state: stateName(wf),
    hit: false,
    crit: false,
    fumble: false,
    attackTotal: null,
    formula: null,
    attackMode: null,
    targetAC: null,
    targetBaseAC: null,
    totalCover: false,
    acDetail: null,
    advantage: false,
    disadvantage: false,
    rollMode: 'normal',
    advantageReasons: [],
    disadvantageReasons: [],
    rollModifiers: {},
    damageRolled: 0,
    damageRolls: [],
    damageType: null,
    damageApplied: 0,
    damageDetail: [],
    tempDamage: 0,
    engineHpAfter: null,
    error: null,
  };
  if (!wf || typeof wf !== 'object') {
    out.error =
      "Midi-QOL's attack workflow gave nothing back, so no attack was made (the item could not be used, or the workflow did not start)";
    return out;
  }
  const roll = wf.attackRoll ?? null;
  if (wf.aborted) {
    out.error = `Midi-QOL stopped the attack (its workflow was aborted${out.state ? ` at ${out.state}` : ''})`;
    return out;
  }
  if (!roll) {
    out.error = `Midi-QOL's attack workflow ended with no attack roll${out.state ? ` (at ${out.state})` : ''}: its own checks stopped it`;
    return out;
  }
  out.ran = true;
  out.formula = typeof roll.formula === 'string' ? roll.formula : null;
  out.attackMode = roll.options?.attackMode ?? wf.attackMode ?? null;
  out.crit = !!wf.isCritical;
  out.fumble = !!wf.isFumble;
  out.hit = setHas(wf.hitTargets, ref) || setHas(wf.hitTargetsEC, ref);
  const hd = (ref.uuid && wf.hitDisplayData?.[ref.uuid]) || null;
  out.attackTotal = num(hd?.attackTotal) ?? num(wf.attackTotal) ?? num(roll.total);
  if (hd) {
    const ac = hd.ac;
    if ((typeof ac === 'number' && !Number.isFinite(ac)) || hd.acDisplay === '∞')
      out.totalCover = true;
    out.targetAC = num(ac);
    out.targetBaseAC = num(hd.baseAc);
    out.acDetail = typeof hd.acTooltip === 'string' && hd.acTooltip ? hd.acTooltip : null;
  }
  // The roll itself says how it was made: dnd5e's D20Roll advantageMode (1 advantage, -1 disadvantage, 0 normal).
  const mode = num(roll.options?.advantageMode);
  const adv = mode !== null ? mode > 0 : !!roll.hasAdvantage;
  const dis = mode !== null ? mode < 0 : !!roll.hasDisadvantage;
  out.advantage = adv;
  out.disadvantage = dis;
  out.rollMode = adv ? 'advantage' : dis ? 'disadvantage' : 'normal';
  const attribution = wf.attackRollModifierTracker?.attribution ?? {};
  for (const [kind, sources] of Object.entries(
    attribution as Record<string, Record<string, string>>
  )) {
    const names = Object.values(sources ?? {}).map(s => String(s));
    if (names.length) out.rollModifiers[kind] = names;
  }
  if (adv) out.advantageReasons = out.rollModifiers.ADV ?? [];
  if (dis) out.disadvantageReasons = out.rollModifiers.DIS ?? [];
  const rolls = [
    ...(Array.isArray(wf.damageRolls) ? wf.damageRolls : []),
    ...(Array.isArray(wf.bonusDamageRolls) ? wf.bonusDamageRolls : []),
  ].filter(Boolean);
  out.damageRolls = rolls.map((r: any) => ({
    formula: typeof r?.formula === 'string' ? r.formula : null,
    total: num(r?.total),
    type: r?.options?.type ?? null,
  }));
  out.damageRolled = out.damageRolls.reduce((s, r) => s + (r.total ?? 0), 0);
  out.damageType = out.damageRolls[0]?.type ?? null;
  if (out.hit) {
    const entry = (Array.isArray(wf.damageList) ? wf.damageList : []).find(
      (d: any) =>
        (!!ref.uuid && d?.targetUuid === ref.uuid) ||
        (!!ref.id && String(d?.targetUuid ?? '').endsWith(`.${ref.id}`))
    );
    if (entry) {
      out.damageApplied = Math.max(0, num(entry.totalDamage) ?? 0);
      out.tempDamage = Math.max(0, num(entry.tempDamage) ?? 0);
      out.engineHpAfter = num(entry.newHP);
      out.damageDetail = (Array.isArray(entry.damageDetail) ? entry.damageDetail : []).map(
        (x: any) => ({
          type: x?.type ?? null,
          value: num(x?.value),
        })
      );
    }
  }
  return out;
}

// ================================================================================================
// Bridge 0.10.8 review (board #1887): what an attack spends when its activity is USED, and the call's deadline.
// ================================================================================================

/** How close to the whole call's deadline a Midi run may end (the call still has to answer), and the least time worth
 * starting a run with. The MCP side waits 60 s for the whole execute-attack call. */
export const MIDI_DEADLINE_MARGIN_MS = 3000;
export const MIDI_MIN_RUN_MS = 3000;

/**
 * Does using this activity spend something that must be spent ONCE, however many targets it has? dnd5e's
 * `activity.use` spends a levelled spell's slot, and any consumption target the activity lists (the item's or the
 * activity's limited uses, a resource); a weapon attack's ammunition and a thrown weapon are spent by the ROLL, not by
 * `use`. Such an activity is used once for all its targets (one Midi-QOL workflow); anything else is one workflow per
 * target, one attack each, as before. Measured on the test stack 2026-09-27 before this fix: Guiding Bolt at two
 * targets through one workflow per target spent two slots.
 */
export function activitySpendsOnUse(_item: any, activity: any, spellLevel: number): boolean {
  if (spellLevel > 0) return true;
  const targets = activity?.consumption?.targets;
  const n = Array.isArray(targets) ? targets.length : Number(targets?.size ?? targets?.length ?? 0);
  if (n > 0) return true;
  const uses = activity?.uses?.max;
  if (uses !== undefined && uses !== null && uses !== '' && Number(uses) !== 0) return true;
  return false;
}

export interface SpendState {
  slot: number | null;
  itemUses: number | null;
  activityUses: number | null;
}

/** What was spent between two readings of a spell slot, the item's uses and the activity's uses, in plain words. */
export function spentOnUse(before: SpendState, after: SpendState): { any: boolean; words: string } {
  const parts: string[] = [];
  const dropped = (a: number | null, b: number | null) =>
    typeof a === 'number' && typeof b === 'number' && b < a ? a - b : 0;
  const s = dropped(before.slot, after.slot);
  if (s) parts.push(s === 1 ? 'a spell slot' : `${s} spell slots`);
  const i = dropped(before.itemUses, after.itemUses);
  if (i) parts.push(i === 1 ? 'a use of the item' : `${i} uses of the item`);
  const a = dropped(before.activityUses, after.activityUses);
  if (a) parts.push(a === 1 ? 'a use of the action' : `${a} uses of the action`);
  return { any: parts.length > 0, words: parts.join(' and ') };
}

// ================================================================================================
// Bridge 0.10.8 round 3 (board #1887): a workflow the bridge stopped must not go on to apply damage later.
// ================================================================================================

/**
 * The Midi-QOL 14.0.12 workflow states that roll or apply something after the attack roll. When execute-attack stops a
 * stuck workflow it calls `performState(WorkflowState_Abort)`, but the workflow's OWN state loop may still be waiting
 * inside a state (a reaction prompt of 10 s, a Dice So Nice animation). When that wait ends, Midi's loop runs the next
 * state it was handed even though `aborted` is set (Workflow.ts `performState`: while aborting it skips only the hooks)
 * and `WorkflowState_AllRollsComplete` has no abort check, so the damage would land after the answer said "stopped".
 */
export const MIDI_STATES_AFTER_STOP: readonly string[] = [
  'WorkflowState_AttackRollComplete',
  'WorkflowState_WaitForDamageRoll',
  'WorkflowState_ConfirmRoll',
  'WorkflowState_DamageRollComplete',
  'WorkflowState_WaitForSaves',
  'WorkflowState_SavesComplete',
  'WorkflowState_AllRollsComplete',
  'WorkflowState_ApplyDynamicEffects',
  'WorkflowState_RollFinished',
];

/**
 * Make a stopped Midi-QOL workflow go to its own Abort state from any state it would enter next. Midi's states hand
 * over the next state as `this.WorkflowState_X`, read from the workflow object, so an own property on this one
 * workflow object replaces each later state with one that answers "abort" (Midi's Abort then runs Cleanup and
 * Completed, which are left alone). Nothing else, and no other workflow, is touched. Returns the states replaced.
 */
export function guardStoppedWorkflow(wf: any): string[] {
  const done: string[] = [];
  if (!wf || typeof wf !== 'object') return done;
  for (const name of MIDI_STATES_AFTER_STOP) {
    if (typeof wf[name] !== 'function') continue;
    const toAbort = async function (this: any) {
      return (this ?? wf).WorkflowState_Abort;
    };
    try {
      Object.defineProperty(wf, name, { value: toAbort, configurable: true, writable: true });
      done.push(name);
    } catch (e) {
      /* a frozen workflow object: nothing to guard */
    }
  }
  wf.aidmStoppedByBridge = true;
  return done;
}
