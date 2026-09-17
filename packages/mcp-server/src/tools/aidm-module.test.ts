/**
 * Board #1724: the aidm-module-* MCP tool layer. The logic runs browser-side
 * (foundry-module/src/aidm-module-handlers.ts, with its own tests); this covers what the MCP side
 * owns: the six tools are advertised with the names the importer gate probes for, each says it is an
 * operator tool the DM model must never be offered, and every call forwards the caller's arguments
 * to the bridge query without changing them (apply only when exactly true).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AidmModuleTools, AIDM_MODULE_TOOL_NAMES } from './aidm-module.js';

function makeTools() {
  const query = vi.fn(async () => ({ success: true }));
  const logger: any = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  const tools = new AidmModuleTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

// The names dnd-dm/eval/ingest_gate.py and gate_foundry_window.py (INSTALL_TOOLS) look for.
const GATE_INSTALL_TOOLS = [
  'aidm-module-status',
  'aidm-module-enable',
  'aidm-module-install',
  'aidm-module-remove',
];

describe('aidm-module tools', () => {
  it('advertises exactly the six tools, including every name the importer gate probes for', () => {
    const { tools } = makeTools();
    const names = tools.getToolDefinitions().map(d => d.name);
    expect(names).toEqual([...AIDM_MODULE_TOOL_NAMES]);
    for (const n of GATE_INSTALL_TOOLS) expect(names).toContain(n);
  });

  it('every tool says it is an operator tool never offered to the DM model, and needs module_id', () => {
    const { tools } = makeTools();
    for (const d of tools.getToolDefinitions()) {
      expect(d.description.startsWith('OPERATOR TOOL')).toBe(true);
      expect(d.description).toContain('never offer it to the DM model');
      expect(d.inputSchema.type).toBe('object');
      expect(d.inputSchema.required).toContain('module_id');
    }
  });

  it('the write tools describe their safety rules', () => {
    const { tools } = makeTools();
    const desc = Object.fromEntries(tools.getToolDefinitions().map(d => [d.name, d.description]));
    expect(desc['aidm-module-install']).toContain('NEVER OVERWRITES');
    expect(desc['aidm-module-install']).toContain('invalidDocumentIds');
    expect(desc['aidm-module-install']).toContain('DRY RUN BY DEFAULT');
    expect(desc['aidm-module-update']).toContain('THREE-WAY MERGE');
    expect(desc['aidm-module-update']).toContain('Play state is never written');
    expect(desc['aidm-module-remove']).toContain('in play or any other user is connected');
    expect(desc['aidm-module-enable']).toContain('other than this GM client is connected');
  });

  it('forwards status, enable and disable arguments unchanged', async () => {
    const { tools, query } = makeTools();
    await tools.handleToolCall('aidm-module-status', { module_id: 'aidm-a-12345678', extra: 1 });
    await tools.handleToolCall('aidm-module-enable', {
      module_id: 'aidm-a-12345678',
      reload: false,
      reload_delay_ms: 500,
      call_id: 'c1',
    });
    await tools.handleToolCall('aidm-module-disable', { module_id: 'aidm-a-12345678' });
    expect(query.mock.calls).toEqual([
      ['foundry-mcp-bridge.aidm-module-status', { module_id: 'aidm-a-12345678' }],
      [
        'foundry-mcp-bridge.aidm-module-enable',
        { module_id: 'aidm-a-12345678', reload: false, reload_delay_ms: 500, call_id: 'c1' },
      ],
      [
        'foundry-mcp-bridge.aidm-module-disable',
        {
          module_id: 'aidm-a-12345678',
          reload: undefined,
          reload_delay_ms: undefined,
          call_id: undefined,
        },
      ],
    ]);
  });

  it('install, update and remove are dry runs unless apply is exactly true', async () => {
    const { tools, query } = makeTools();
    await tools.handleInstall({ module_id: 'm', adventure_id: 'a', apply: 'true', plan_id: 'p' });
    await tools.handleUpdate({ module_id: 'm', adventure_id: 'a', apply: 1 });
    await tools.handleRemove({ module_id: 'm', apply: 'yes' });
    for (const call of query.mock.calls as any[]) expect(call[1].apply).toBe(false);
    await tools.handleInstall({
      module_id: 'm',
      adventure_id: 'a',
      apply: true,
      plan_id: 'mi-1-00000000',
      call_id: 'x',
    });
    expect(query.mock.calls[3]).toEqual([
      'foundry-mcp-bridge.aidm-module-install',
      { module_id: 'm', adventure_id: 'a', apply: true, plan_id: 'mi-1-00000000', call_id: 'x' },
    ]);
  });

  it('update forwards the build data and options untouched', async () => {
    const { tools, query } = makeTools();
    const target = { _id: 'a', scenes: [{ _id: 's' }] };
    const base = { _id: 'a', scenes: [] };
    await tools.handleUpdate({
      module_id: 'm',
      adventure_id: 'a',
      target,
      target_build: 2,
      base,
      base_build: 1,
      play_began_scene_ids: ['s'],
      accept_base_mismatch: true,
      apply: true,
      plan_id: 'mu-1-00000000',
    });
    const sent: any = (query.mock.calls as any[])[0][1];
    expect(sent.target).toBe(target);
    expect(sent.base).toBe(base);
    expect(sent).toMatchObject({
      target_build: 2,
      base_build: 1,
      play_began_scene_ids: ['s'],
      accept_base_mismatch: true,
      apply: true,
      plan_id: 'mu-1-00000000',
    });
  });

  it('an unknown name is an error, not a silent no-op', async () => {
    const { tools } = makeTools();
    await expect(tools.handleToolCall('aidm-module-nope', {})).rejects.toThrow(
      'Unknown aidm-module tool'
    );
  });

  it('backend.ts registers the definitions and routes every tool name', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const backend = readFileSync(join(here, '..', 'backend.ts'), 'utf8');
    expect(backend).toContain('...aidmModuleTools.getToolDefinitions()');
    for (const name of AIDM_MODULE_TOOL_NAMES) expect(backend).toContain(`case '${name}':`);
  });
});
