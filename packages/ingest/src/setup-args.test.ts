import { describe, it, expect } from 'vitest';
import {
  agentName,
  agentsReferencingTool,
  agentsWithoutToolInfo,
  modelBlock,
  parseSetupArgs,
  PRODUCTION_AGENT_KEY,
  type AgentToolRefs,
} from './setup-args.js';

describe('parseSetupArgs', () => {
  it('defaults to the production agent on gpt-5.5 with a 1500-token cap', () => {
    expect(parseSetupArgs([], {})).toEqual({
      agentOnly: false,
      skipIndex: false,
      keepTool: false,
      agentKey: PRODUCTION_AGENT_KEY,
      model: 'gpt-5.5',
      maxTokens: 1500,
      reasoningEffort: null,
    });
  });

  it('reads the agent key and model from the environment', () => {
    const opts = parseSetupArgs(['--keep-tool'], { VECTARA_AGENT_KEY: 'k', VECTARA_AGENT_MODEL: 'gpt-5.4' });
    expect(opts.agentKey).toBe('k');
    expect(opts.model).toBe('gpt-5.4');
  });

  it('requires --keep-tool for a non-production key from the environment too', () => {
    expect(() => parseSetupArgs([], { VECTARA_AGENT_KEY: 'k' })).toThrow(/--keep-tool/);
  });

  it('parses the flags', () => {
    expect(
      parseSetupArgs(['--agent-only', '--keep-tool', '--agent-key', 'zameen_eval_mini', '--model', 'gpt-5-mini', '--max-tokens', '4000', '--reasoning-effort', 'low'], {}),
    ).toEqual({
      agentOnly: true,
      skipIndex: true,
      keepTool: true,
      agentKey: 'zameen_eval_mini',
      model: 'gpt-5-mini',
      maxTokens: 4000,
      reasoningEffort: 'low',
    });
  });

  it('refuses a candidate key that would replace the production tool', () => {
    expect(() => parseSetupArgs(['--agent-key', 'zameen_eval_x'], {})).toThrow(/--keep-tool/);
  });

  it('rejects an unknown reasoning effort, a bad token count and an unknown flag', () => {
    expect(() => parseSetupArgs(['--reasoning-effort', 'max'], {})).toThrow(/reasoning-effort/);
    expect(() => parseSetupArgs(['--max-tokens', 'lots'], {})).toThrow(/max-tokens/);
    expect(() => parseSetupArgs(['--bogus'], {})).toThrow(/unknown argument: --bogus/);
  });
});

describe('modelBlock', () => {
  it('omits reasoning unless asked', () => {
    expect(modelBlock(parseSetupArgs([], {}))).toEqual({ name: 'gpt-5.5', parameters: { max_tokens: 1500 } });
    expect(modelBlock(parseSetupArgs([], {})).parameters).not.toHaveProperty('reasoning');
  });

  it('sends reasoning effort in the Responses API shape', () => {
    expect(modelBlock(parseSetupArgs(['--model', 'gpt-5.4', '--max-tokens', '4000', '--reasoning-effort', 'low'], {}))).toEqual({
      name: 'gpt-5.4',
      parameters: { max_tokens: 4000, reasoning: { effort: 'low' } },
    });
  });
});

describe('agentName', () => {
  it('keeps the production name for the production key', () => {
    expect(agentName(parseSetupArgs([], {}))).toBe('Zameen Property Assistant');
  });

  it('suffixes a candidate with its key, because names are unique per account', () => {
    expect(agentName(parseSetupArgs(['--keep-tool', '--agent-key', 'zameen_eval_gpt54'], {}))).toBe(
      'Zameen Property Assistant [zameen_eval_gpt54]',
    );
  });
});

describe('agentsReferencingTool', () => {
  // Annotated so TS contextually types each element against AgentToolRefs's
  // index signature, rather than inferring a per-element union that a bare
  // literal array would produce (and that union then fails that check).
  const agents: AgentToolRefs[] = [
    { key: 'zameen_property_assistant', tool_configurations: { search_properties: { tool_id: 'tol_1' } } },
    { key: 'zameen_eval_gpt5mini', tool_configurations: { search_properties: { tool_id: 'tol_1' } } },
    { key: 'zameen_eval_gpt54', tool_configurations: { search_properties: { tool_id: 'tol_1' } } },
    { key: 'other_agent', tool_configurations: { web: { tool_id: null }, docs: { tool_id: 'tol_9' } } },
    { key: 'bare_agent' },
  ];

  it('names every other agent that references the tool, sorted', () => {
    expect(agentsReferencingTool(agents, 'tol_1', 'zameen_property_assistant')).toEqual([
      'zameen_eval_gpt54',
      'zameen_eval_gpt5mini',
    ]);
  });

  it('is empty when only the agent itself references the tool', () => {
    expect(agentsReferencingTool(agents, 'tol_9', 'other_agent')).toEqual([]);
    expect(agentsReferencingTool(agents, 'tol_missing', 'zameen_property_assistant')).toEqual([]);
  });

  it('reports agents whose listing carried no tool information at all', () => {
    expect(agentsWithoutToolInfo(agents, 'zameen_property_assistant')).toEqual(['bare_agent']);
    expect(agentsWithoutToolInfo(agents, 'bare_agent')).toEqual([]);
  });
});
