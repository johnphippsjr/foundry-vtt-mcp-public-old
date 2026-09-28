import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

interface CombatToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

/**
 * D&D 5E combat tools (Phase 1). The LLM decides intent ("goblin attacks Tulkas with its
 * scimitar"); Midi-QOL in Foundry rolls the attack, checks the hit, rolls + applies damage.
 * These call module handlers registered in foundry-module/src/queries.ts.
 */
export class CombatTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor(options: CombatToolsOptions) {
    this.foundryClient = options.foundryClient;
    this.logger = options.logger;
  }

  private wrap(result: any) {
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  async handleDiagEval(args: { js: string }) {
    return this.wrap(
      await this.foundryClient.query('foundry-mcp-bridge.diagEval', { js: args?.js })
    );
  }

  getToolDefinitions() {
    return [
      {
        name: 'diag-eval',
        description: 'INTERNAL diagnostic: run JS in the GM browser and return the JSON result.',
        inputSchema: { type: 'object', properties: { js: { type: 'string' } }, required: ['js'] },
      },
      {
        name: 'start-combat',
        description:
          "Begin a combat encounter on the active scene. Adds the given tokens (by name or id) as combatants and rolls initiative. If no tokens are given, adds the party (character-type actors, or the tokens named in 'party') plus hostile, non-hidden tokens that share a Scene Region with the party, or, when the party is not standing inside any region, are within unobstructed line of sight of the party (Foundry's own wall-collision test) -- never all tokens on the scene, so a monster pre-placed in another room never joins by default. Returns the initiative order, and for the automatic case, a scoping report of which tokens were admitted and which hostiles were excluded and why (hidden, out of room, or no line of sight).",
        inputSchema: {
          type: 'object',
          properties: {
            tokens: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Token names or ids to add to combat. Omit to use the automatic party-plus-nearby-hostiles scope.',
            },
            party: {
              type: 'array',
              items: { type: 'string' },
              description:
                "Token names or ids to treat as the party when computing the automatic scope (only used when 'tokens' is omitted). Omit to auto-detect the party as every character-type actor's token.",
            },
          },
        },
      },
      {
        name: 'end-combat',
        description: 'End the active combat encounter.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'next-turn',
        description: 'Advance the active combat to the next turn. Returns the current combatant.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get-combat-state',
        description:
          "Get the current combat state: round, whose turn it is, and the initiative order with each combatant's HP.",
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'execute-attack',
        description:
          "Resolve an attack. The Foundry engine (Midi-QOL's own attack workflow) rolls the attack vs the target's AC, decides hit, critical, advantage and disadvantage, rolls damage on a hit, and applies it with the target's resistances. Provide the attacker token (name or id), the weapon/attack item name on that attacker, and the target token(s) (name or id). Returns what the engine decided and each target's HP before/after.",
        inputSchema: {
          type: 'object',
          properties: {
            attacker: {
              type: 'string',
              description: 'Attacker token name or id on the active scene.',
            },
            item: {
              type: 'string',
              description: 'Name of the weapon/attack item on the attacker (e.g. "Scimitar").',
            },
            itemId: {
              type: 'string',
              description:
                'Optional: the id of the exact item to use when the attacker holds several items with that name (e.g. an empty Javelin stack and a full one).',
            },
            targets: {
              type: 'array',
              items: { type: 'string' },
              description: 'Target token name(s) or id(s).',
            },
            // Board #1887 (bridge 0.10.8 round 4, review S1): the rules say the caster chooses ONE effect.
            effect: {
              type: 'string',
              description: `Only when the spell or ability puts ONE effect of the caster's choice on its target (Blindness/Deafness: "Blindness" or "Deafness"; Hex or Bestow Curse: the ability, e.g. "Strength"; Enlarge/Reduce: "Enlarged" or "Reduced"): the one chosen (the monster's choice, or what the player said). A condition name works too ("blinded"). When a choice is needed and none is named, nothing is used and the answer lists the choices (effectChoices).`,
            },
          },
          required: ['attacker', 'item', 'targets'],
        },
      },
    ];
  }

  async handleStartCombat(args: any) {
    return this.wrap(
      await this.foundryClient.query('foundry-mcp-bridge.startCombat', {
        tokens: args?.tokens,
        party: args?.party,
      })
    );
  }
  async handleEndCombat(_args: any) {
    return this.wrap(await this.foundryClient.query('foundry-mcp-bridge.endCombat', {}));
  }
  async handleNextTurn(_args: any) {
    return this.wrap(await this.foundryClient.query('foundry-mcp-bridge.nextTurn', {}));
  }
  async handleGetCombatState(_args: any) {
    return this.wrap(await this.foundryClient.query('foundry-mcp-bridge.getCombatState', {}));
  }
  async handleExecuteAttack(args: any) {
    return this.wrap(
      await this.foundryClient.query('foundry-mcp-bridge.executeAttack', {
        attacker: args?.attacker,
        item: args?.item,
        targets: args?.targets || [],
        ...(args?.itemId ? { itemId: args.itemId } : {}),
        // Board #1887 (round 4, review S1): the caster's one chosen effect, when the activity offers a choice.
        ...(args?.effect ? { effect: String(args.effect) } : {}),
        // Board #1887 (round 3, operator popup "With the chooser"): reactions stay OFF until the aidm-rules reaction
        // chooser exists; the model is not offered them and cannot pass them (the add-on's handler keeps the switch).
      })
    );
  }
}
