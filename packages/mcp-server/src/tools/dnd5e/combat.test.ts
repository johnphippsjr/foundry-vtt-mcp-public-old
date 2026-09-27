/**
 * dnd5e combat MCP tool layer tests (start-combat room scoping, board #1311, bridge fix 0006).
 *
 * The real default-scoping logic runs browser-side (foundry-module/src/queries.ts,
 * combat-scoping-utils.ts -- see that package's own vitest suite), so these cover only the MCP
 * tool layer: start-combat is advertised with the new 'party' field and a description that no
 * longer promises "all tokens on the scene", and a call forwards tokens/party unchanged to the
 * bridge query.
 */

import { describe, it, expect, vi } from 'vitest';
import { CombatTools } from './combat.js';

function makeTools(queryImpl?: (method: string, data: any) => unknown) {
  const query = vi.fn(queryImpl ?? (async () => ({ success: true })));
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => logger };
  const foundryClient: any = { query };
  const tools = new CombatTools({ foundryClient, logger });
  return { tools, query };
}

describe('start-combat tool definition', () => {
  it('is advertised with an optional tokens field and an optional party field', () => {
    const { tools } = makeTools();
    const def = tools.getToolDefinitions().find(d => d.name === 'start-combat');
    expect(def).toBeDefined();
    expect(def!.inputSchema.properties).toHaveProperty('tokens');
    expect(def!.inputSchema.properties).toHaveProperty('party');
  });

  it('description no longer promises "all tokens on the scene" as the default', () => {
    const { tools } = makeTools();
    const def = tools.getToolDefinitions().find(d => d.name === 'start-combat');
    expect(def!.description.toLowerCase()).not.toContain('adds all tokens on the scene');
  });

  it('description documents the room/line-of-sight scoping and the exclusion reasons', () => {
    const { tools } = makeTools();
    const def = tools.getToolDefinitions().find(d => d.name === 'start-combat');
    const desc = def!.description.toLowerCase();
    expect(desc).toContain('region');
    expect(desc).toContain('line of sight');
    expect(desc).toContain('hidden');
  });
});

describe('start-combat tool call', () => {
  it('forwards an explicit tokens list unchanged to the bridge query', async () => {
    const { tools, query } = makeTools();
    await tools.handleStartCombat({ tokens: ['goblin1', 'goblin2'] });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.startCombat', {
      tokens: ['goblin1', 'goblin2'],
      party: undefined,
    });
  });

  it('forwards an explicit party list unchanged when tokens is omitted', async () => {
    const { tools, query } = makeTools();
    await tools.handleStartCombat({ party: ['Tulkas', 'Ravenna'] });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.startCombat', {
      tokens: undefined,
      party: ['Tulkas', 'Ravenna'],
    });
  });

  it('calls with tokens and party both undefined when neither is given, for the fully automatic scope', async () => {
    const { tools, query } = makeTools();
    await tools.handleStartCombat({});
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.startCombat', {
      tokens: undefined,
      party: undefined,
    });
  });

  it('returns whatever the bridge query returns, unmodified, including the new scoping field', async () => {
    const shape = {
      success: true,
      round: 1,
      combatants: [
        { name: 'Tulkas', initiative: 18 },
        { name: 'Skeleton', initiative: 9 },
      ],
      scoping: {
        mode: 'region',
        party: [{ id: 'p1', name: 'Tulkas' }],
        admitted: [{ id: 'm1', name: 'Skeleton' }],
        excluded: [{ id: 'm2', name: 'Animated Armor', reason: 'out-of-room' }],
      },
    };
    const { tools } = makeTools(async () => shape);
    const result = await tools.handleStartCombat({});
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(shape) }] });
  });
});

// Board #1887, independent review of bridge 0.10.7, finding 2: the brain names the exact item stack by id.
describe('execute-attack tool: the exact item by id', () => {
  it('is advertised with an optional itemId field', () => {
    const { tools } = makeTools();
    const def = tools.getToolDefinitions().find(d => d.name === 'execute-attack');
    expect(def!.inputSchema.properties).toHaveProperty('itemId');
    expect(def!.inputSchema.required).toEqual(['attacker', 'item', 'targets']);
  });

  it('forwards itemId to the bridge query when given', async () => {
    const { tools, query } = makeTools();
    await tools.handleExecuteAttack({
      attacker: 'k1',
      item: 'Javelin',
      targets: ['b1'],
      itemId: 'jv2',
    });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.executeAttack', {
      attacker: 'k1',
      item: 'Javelin',
      targets: ['b1'],
      itemId: 'jv2',
    });
  });

  it('guard: without itemId the query is exactly as before', async () => {
    const { tools, query } = makeTools();
    await tools.handleExecuteAttack({ attacker: 'k1', item: 'Dagger', targets: ['b1'] });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.executeAttack', {
      attacker: 'k1',
      item: 'Dagger',
      targets: ['b1'],
    });
  });
});

// Board #1887 (bridge 0.10.8, engine map M07): the attack runs through Midi-QOL's own workflow, whose reactions stay off
// unless the caller asks (Midi-QOL 14.0.12 needs DAE for them; measured on the test stack 2026-09-27).
describe('execute-attack tool: Midi-QOL reactions', () => {
  it('is advertised with an optional reactions switch', () => {
    const { tools } = makeTools();
    const def = tools.getToolDefinitions().find(d => d.name === 'execute-attack');
    expect(def!.inputSchema.properties).toHaveProperty('reactions');
    expect((def!.inputSchema.properties as any).reactions.type).toBe('boolean');
    expect(def!.inputSchema.required).toEqual(['attacker', 'item', 'targets']);
  });

  it('forwards reactions: true to the bridge query', async () => {
    const { tools, query } = makeTools();
    await tools.handleExecuteAttack({
      attacker: 'k1',
      item: 'Dagger',
      targets: ['b1'],
      reactions: true,
    });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.executeAttack', {
      attacker: 'k1',
      item: 'Dagger',
      targets: ['b1'],
      reactions: true,
    });
  });

  it('guard: reactions false or anything else is not forwarded (the query is exactly as before)', async () => {
    const { tools, query } = makeTools();
    await tools.handleExecuteAttack({
      attacker: 'k1',
      item: 'Dagger',
      targets: ['b1'],
      reactions: 'yes',
    });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.executeAttack', {
      attacker: 'k1',
      item: 'Dagger',
      targets: ['b1'],
    });
  });
});
