/**
 * Command-line options for the Vectara setup script.
 *
 * Pure, so the rules that keep a model trial away from production can be
 * tested without a network: a candidate agent gets its own key and must
 * reuse the production search tool, because replacing the tool detaches
 * whichever agent references it.
 */

export const PRODUCTION_AGENT_KEY = 'zameen_property_assistant';
export const PRODUCTION_AGENT_NAME = 'Zameen Property Assistant';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface SetupOptions {
  /** Skip the corpus and the index; only the tool and agent. */
  agentOnly: boolean;
  /** Skip re-indexing the 400 documents. */
  skipIndex: boolean;
  /** Reuse the existing search tool instead of replacing it. Required for a candidate key. */
  keepTool: boolean;
  agentKey: string;
  model: string;
  /** Output cap. On the Responses API this includes reasoning tokens. */
  maxTokens: number;
  reasoningEffort: ReasoningEffort | null;
}

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_MAX_TOKENS = 1500;

function isEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function parseSetupArgs(argv: string[], env: Record<string, string | undefined>): SetupOptions {
  const opts: SetupOptions = {
    agentOnly: false,
    skipIndex: false,
    keepTool: false,
    agentKey: env['VECTARA_AGENT_KEY'] ?? PRODUCTION_AGENT_KEY,
    model: env['VECTARA_AGENT_MODEL'] ?? DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoningEffort: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case '--agent-only':
        opts.agentOnly = true;
        opts.skipIndex = true;
        break;
      case '--skip-index':
        opts.skipIndex = true;
        break;
      case '--keep-tool':
        opts.keepTool = true;
        break;
      case '--agent-key':
        if (!value) throw new Error('--agent-key needs a value');
        opts.agentKey = value;
        i++;
        break;
      case '--model':
        if (!value) throw new Error('--model needs a value');
        opts.model = value;
        i++;
        break;
      case '--max-tokens': {
        const parsed = Number.parseInt(value ?? '', 10);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--max-tokens needs a positive integer');
        opts.maxTokens = parsed;
        i++;
        break;
      }
      case '--reasoning-effort':
        if (!value || !isEffort(value)) {
          throw new Error(`--reasoning-effort must be one of ${REASONING_EFFORTS.join(', ')}`);
        }
        opts.reasoningEffort = value;
        i++;
        break;
      default:
        throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }

  if (opts.agentKey !== PRODUCTION_AGENT_KEY && !opts.keepTool) {
    throw new Error(
      `agent key "${opts.agentKey}" is not the production agent; pass --keep-tool so the ` +
        'production search tool is reused rather than replaced out from under it',
    );
  }

  return opts;
}

/** The agent definition's `model` block. */
export function modelBlock(opts: SetupOptions): { name: string; parameters: Record<string, unknown> } {
  const parameters: Record<string, unknown> = { max_tokens: opts.maxTokens };
  // Vectara forwards these verbatim to the model's API. On OpenAI's Responses
  // API the effort knob is the nested `reasoning.effort`; the flat
  // `reasoning_effort` of the older API is rejected outright.
  if (opts.reasoningEffort) parameters['reasoning'] = { effort: opts.reasoningEffort };
  return { name: opts.model, parameters };
}

/** Agent names are unique per account, so a candidate carries its key. */
export function agentName(opts: SetupOptions): string {
  return opts.agentKey === PRODUCTION_AGENT_KEY
    ? PRODUCTION_AGENT_NAME
    : `${PRODUCTION_AGENT_NAME} [${opts.agentKey}]`;
}
