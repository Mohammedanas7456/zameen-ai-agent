import { describe, it, expect } from 'vitest';
import { modelBlock, parseSetupArgs, PRODUCTION_AGENT_KEY } from './setup-args.js';

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
  it('omits reasoning_effort unless asked', () => {
    expect(modelBlock(parseSetupArgs([], {}))).toEqual({ name: 'gpt-5.5', parameters: { max_tokens: 1500 } });
  });

  it('passes reasoning_effort through', () => {
    expect(modelBlock(parseSetupArgs(['--model', 'gpt-5.4', '--max-tokens', '4000', '--reasoning-effort', 'low'], {}))).toEqual({
      name: 'gpt-5.4',
      parameters: { max_tokens: 4000, reasoning_effort: 'low' },
    });
  });
});
