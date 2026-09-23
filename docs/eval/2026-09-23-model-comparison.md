# Model and parameter comparison — 2026-09-23

Which model, output cap and reasoning effort should the production agent
(`zameen_property_assistant`) run? Measured with `npm run eval` (the ten cases in
`apps/server/src/eval/cases.ts`) against production and four candidate agents that
share the production search tool (`tol_35252`) and carry production's exact
instructions. Raw runs are in `runs/`; each JSON records `agentKey`, per-case
usage and every reply.

Models available to this account (`GET /v2/llms`) are OpenAI's platform models
only: gpt-5.5, gpt-5.4, gpt-5.2, gpt-5, gpt-5-mini, gpt-5-nano. Claude is not
registered; see "Comparing models" in the README for how to add it.

## Results

| Agent | Model | Cap | Effort | Pass | Seconds | Input (cached) | Output (reasoning) | Run |
|---|---|---|---|---|---|---|---|---|
| zameen_property_assistant | gpt-5.5 | 1500 | default | 10/10 | 103.0 | 99,930 (71,680) | 3,618 (611) | `prod-gpt55-1500` |
| zameen_property_assistant | gpt-5.5 | 1500 | default | 10/10 | 84.3 | 99,878 (74,240) | 3,467 (581) | `prod-gpt55-1500-run2` |
| zameen_eval_gpt55_4k | gpt-5.5 | 4000 | default | 10/10 | 90.9 | 99,957 (76,800) | 3,783 (595) | `zameen_eval_gpt55_4k` |
| zameen_eval_gpt55_4k | gpt-5.5 | 4000 | default | 10/10 | 98.8 | 99,924 (76,800) | 4,000 (888) | `zameen_eval_gpt55_4k-run2` |
| zameen_eval_gpt55_low | gpt-5.5 | 4000 | low | 10/10 | 81.9 | 99,607 (68,096) | 3,193 (214) | `zameen_eval_gpt55_low` |
| zameen_eval_gpt55_low | gpt-5.5 | 4000 | low | 10/10 | 80.8 | 99,680 (76,800) | 3,224 (284) | `zameen_eval_gpt55_low-run2` |
| zameen_eval_gpt54 | gpt-5.4 | 4000 | default | 7/10 (8/10 adjudicated) | 68.3 | 85,862 (57,344) | 3,239 (0) | `zameen_eval_gpt54` |
| zameen_eval_gpt5mini | gpt-5-mini | 4000 | default | 8/10 (10/10 adjudicated) | 248.7 | 102,794 (81,024) | 17,567 (12,736) | `zameen_eval_gpt5mini` |

All runs are 30 model turns (the same ten scripted conversations) except gpt-5.4,
which stopped two conversations early by asking a question instead of searching.
Seconds are wall-clock model time summed over the cases; the same configuration
varies by ±10 s between runs, so differences under that are noise.

"Adjudicated" scores correct for grader false positives found during this study
and fixed in the same branch (commits `f0b35d4` and `1fed1f9`): a bold marker
between a threshold word and its number (`under **1 lakh**`), a bare `L` as a
lakh unit (`PKR 1–1.7L`), and a `+` after a size (`2,000+ sqft`). Every run before
the last one used the old grader; the JSONs keep the verdicts as they were
recorded.

## How each candidate behaved

**gpt-5.5 at 4000, default effort** — the production model with a higher output
cap. Same pass rate, same speed within noise, and a little more output (up to
+13 % output tokens and +50 % reasoning tokens in one run): the higher cap lets the model think and
write slightly longer on the comparison case, where replies run to 700 tokens.
No case in the eval gets near the old 1500 cap, so the cap does not change
*these* results; it removes the truncation risk on a long comparison, where the
Responses API counts reasoning against the same cap as the visible reply.

**gpt-5.5 at 4000, reasoning effort low** — the surprise. Both runs pass 10/10,
the fastest runs of the study (81 s, 13 % under the baseline's mean of 94 s), with a
third of the reasoning tokens and the shortest replies of any gpt-5.5
configuration. The intake and search behaviour was identical to the default
effort; the replies were slightly terser (590–610 characters on average against
570–645) and used the same bold-number style. On these ten cases the model's
default reasoning bought nothing.

**gpt-5.4 at 4000** — fails the intake contract twice: on the Roman Urdu request
and on the floor request it asked for a budget ("Aap ka budget kya hai?", "What
budget should I keep in mind?") instead of searching, though area and purpose
were both known. Its two one-line replies also came through the token stream
twice, a quirk not seen in any other model. Its third failure is the grader
false positive above; the comparison reply itself was correct and the most
heavily formatted of the study (19 bold spans per reply). It was the fastest
run and used the fewest input tokens, but it does not follow the
instructions the product depends on.

**gpt-5-mini at 4000** — searches correctly on every case and grounds every
number (both failures were grader gaps), but reasons at length: 12,736 reasoning
tokens against the baseline's 611, three times the wall-clock, and replies that
switch to bullet lists with no bold (4.3 bullets per reply, 0 bold spans). It
also answered the Roman Urdu case in Roman Urdu throughout. On a 1500 cap its
reasoning alone would have exhausted several turns.

## Recommendation

- **Model: stay on gpt-5.5.** gpt-5.4 breaks the intake contract; gpt-5-mini
  passes but at three times the latency and five times the output tokens, and
  the token price gap would have to be large to pay for that. Switching model
  is a cost decision for the account owner; the numbers above are the input.
- **Output cap: 4000.** Recommended for production (see below); it was not
  applied by this study.
- **Reasoning effort: `low` is worth trying in production.** It was faster and
  cheaper with no measured loss. It changes how much the model thinks before
  every reply, so it is presented here as a decision rather than applied:
  `npm run setup:agent -- --max-tokens 4000 --reasoning-effort low --keep-tool`
  turns it on, and the same command without `--reasoning-effort` turns it off.

## Applying the cap to production

Production still runs `max_tokens: 1500`. To apply the recommendation:

```bash
npm run setup:agent -- --max-tokens 4000 --keep-tool
```

This sets production's model block to
`{"name":"gpt-5.5","parameters":{"max_tokens":4000}}` and reuses the tool
rather than replacing it, so open sessions and the candidate agents are
unaffected. Revert with `--max-tokens 1500 --keep-tool`.

## Platform facts learned

- `model.parameters` is forwarded verbatim to the model's API. On OpenAI's
  Responses API the effort knob is the nested `reasoning.effort`; the flat
  `reasoning_effort` is rejected with HTTP 400 at agent creation. The setup
  script now sends the nested form.
- Agent *names* are unique per account, not just keys. Candidates are named
  `Zameen Property Assistant [<key>]`.
- Vectara refuses to delete a tool that any agent references. While candidate
  agents exist, `npm run setup:agent` without `--keep-tool` would detach
  production and then fail on the delete; the script now checks for other
  agents referencing the tool before it touches anything and names them.

## Candidate agents left in place

`zameen_eval_gpt55_4k`, `zameen_eval_gpt55_low`, `zameen_eval_gpt54`,
`zameen_eval_gpt5mini` remain on the account for re-runs
(`VECTARA_AGENT_KEY=<key> npm run eval`). They cost nothing idle. Delete one
with `DELETE /v2/agents/<key>` when it is no longer wanted; delete all of them
before running a tool-replacing setup.
