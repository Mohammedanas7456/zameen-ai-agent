/**
 * Bounds on what one chat session may cost.
 *
 * All of this is per process. On Cloud Run that means per instance, and the
 * service scales to zero — so these caps bound a single instance's exposure
 * rather than a caller's global rate. A shared counter would need the
 * datastore this app deliberately does not have; the upstream ceiling is the
 * per-LLM `requests_per_second` limit configured in Vectara.
 */

/** Longest user message accepted. Long enough for any real question; short
 *  enough that the body cannot be used to pad the model's context. */
export const MAX_MESSAGE_CHARS = 2000;

/** Turns one session may take before the client must start a new chat. */
export const MAX_TURNS_PER_SESSION = 60;

export type Admission = 'ok' | 'busy' | 'exhausted';

export class SessionGate {
  private readonly inFlight = new Set<string>();
  /** Turns used per session. Insertion-ordered, so the oldest is first. */
  private readonly turns = new Map<string, number>();
  private readonly maxTurns: number;
  private readonly maxTracked: number;

  constructor(opts: { maxTurns: number; maxTracked?: number }) {
    this.maxTurns = opts.maxTurns;
    this.maxTracked = opts.maxTracked ?? 10_000;
  }

  /**
   * Admit one turn for a session, or say why not. An admitted turn must be
   * `release`d when it ends. A refusal counts nothing.
   */
  admit(sessionKey: string): Admission {
    if (this.inFlight.has(sessionKey)) return 'busy';

    const used = this.turns.get(sessionKey) ?? 0;
    if (used >= this.maxTurns) return 'exhausted';

    // Bound memory: forget the session tracked longest ago. It regains a full
    // budget, which is acceptable — this is a cost cap, not an audit log.
    if (!this.turns.has(sessionKey) && this.turns.size >= this.maxTracked) {
      const oldest = this.turns.keys().next().value;
      if (oldest !== undefined) this.turns.delete(oldest);
    }

    this.turns.set(sessionKey, used + 1);
    this.inFlight.add(sessionKey);
    return 'ok';
  }

  release(sessionKey: string): void {
    this.inFlight.delete(sessionKey);
  }
}
