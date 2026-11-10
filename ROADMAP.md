# Roadmap: Wolf answers questions about Flisk

The service's next job after writing `service.json`: answer questions from the Flisk docs, first in the Ask box on
[flisk.sh/docs](https://flisk.sh/docs/), then as a support chat. Training and scoring the model itself is in the
[flisk-model roadmap](https://github.com/flisk-sh/flisk-model/blob/main/ROADMAP.md). Its Phase 2 says a new job ships only
once it has its own test, and the [test](#the-test) below is that test.

## Where we are (2026-11-10)

| | Status |
| --- | --- |
| Ask on flisk.sh/docs | Live, with no model. [Helpdock](https://helpdock.flisk.si) finds passages in `flisk-sh/flisk` `docs/`, and "Ask your AI" links send them to Claude or ChatGPT. |
| Search quality | Fixed for the misses the test found ([helpdock#16](https://github.com/flisk-sh/helpdock/pull/16)). The one gap in the docs is filled ([flisk#3589](https://github.com/flisk-sh/flisk/pull/3589)). |
| Model | Wolf's base model, `@cf/qwen/qwen2.5-coder-32b-instruct`, with a docs prompt (Wolf's own prompt writes JSON only). **15 of 20 correct, 4 partly right, 1 wrong, 0 made-up commands**, about 1 to 2 s each. Llama 3.3 70B: 12 correct with the older search, and 1 made-up command (`flisk import --language python`) with the fixed search. Llama 3.1 8B: dropped (it looped and garbled answers). |
| Not measured | Pasted error messages, follow-up questions, questions outside the CLI docs, and Workers AI cost per answer. |

## Decisions (Zachman)

| | Decision |
| --- | --- |
| **Why** | Plan the work in priority order (P0, P1, P2) and build what scores best, not everything at once. |
| **Who** | Anyone, with no sign-in. Limited per visitor and per day. |
| **What** (sources) | Picked by ICE score (below). P0 answers from the CLI docs only. |
| **Where** | flisk.sh/docs only, next to the existing Ask. Nothing on other pages until P1's test passes. |
| **When** | P0 this week. P1 after a week of real questions. P2 only if P1's numbers hold. |
| **How** | Helpdock calls Workers AI. Helpdock already has the passages, so every repository's help center can turn the answer on, and inference.flisk.si's API keeps its own limit. |

## ICE scores

Each item is scored 1 to 10 for **I**mpact, **C**onfidence (how sure we are it works) and **E**ase. Score = I × C × E.
Ties go to whatever earns visitors' trust.

### Sources the answer may use

| Source | I | C | E | ICE | Phase |
| --- | --- | --- | --- | --- | --- |
| Flisk CLI docs (`flisk-sh/flisk` `docs/`) | 8 | 9 | 10 | **720** | P0 |
| flisk.sh pages (features, why, migrate, blog) | 6 | 6 | 6 | 216 | P1 |
| Other flisk.si products' docs (Wolf, Pages, Tools, Helpdock, FliskOS) | 5 | 5 | 4 | 100 | P2 |
| Closed GitHub issues | 6 | 3 | 3 | 54 | Later |

### Work

| Item | I | C | E | ICE | Phase |
| --- | --- | --- | --- | --- | --- |
| Drop any answer line that quotes a command not in its passages | 8 | 8 | 8 | **512** | P0 |
| "AI answer (beta)" button in Ask, passages first, passages kept if the model fails | 7 | 8 | 7 | **392** | P0 |
| Hand off what the docs do not cover: Discord or a GitHub issue, with the question filled in | 6 | 8 | 8 | **384** | P0 |
| The 20-question test in Helpdock CI, for search rank (no model) | 6 | 9 | 7 | **378** | P0 |
| Support test: 20 more questions (pasted errors, "is Wolf free?", Windows installs, follow-ups) | 7 | 8 | 6 | 336 | P1 |
| Follow-up questions (Helpdock's chat sessions; the last turns go into the search) | 6 | 6 | 6 | 216 | P1 |
| Chat button in the shared Flisk bar on every flisk.si site | 6 | 5 | 6 | 180 | P2 |
| `flisk ask "<question>"` in the CLI, calling the same endpoint | 5 | 6 | 5 | 150 | P2 |
| Train Wolf on docs questions and answers | 6 | 3 | 2 | 36 | Later |

## P0: AI answer beta in Ask (this week)

**Status 2026-11-10: built, switched off until the token is set.** Helpdock's answer endpoint with the checks, caps and
ranking test ([helpdock#17](https://github.com/flisk-sh/helpdock/pull/17), [#18](https://github.com/flisk-sh/helpdock/pull/18))
and the button with the handoff on flisk.sh/docs ([website#143](https://github.com/flisk-sh/website/pull/143)) are merged.
The button appears once `HELPDOCK_AI_ACCOUNT` and `HELPDOCK_AI_TOKEN` are set on Helpdock's Render service
([DEPLOY.md](https://github.com/flisk-sh/helpdock/blob/main/DEPLOY.md)). The week of real questions starts then.

1. **Helpdock** gets an answer endpoint: question plus the top 6 passages (up to 1,500 characters each) go to
   `@cf/qwen/qwen2.5-coder-32b-instruct` with the docs prompt from the test, at temperature 0. It has its own daily cap
   and a per-visitor limit. Questions are not stored; only counts are.
2. **Checks before the answer is shown:** a line that quotes a command or flag that is not in the passages is dropped, and
   the filler "They do not cover X" line is removed. When nothing is left, Ask shows the passages, as today.
3. **flisk.sh/docs:** an "AI answer (beta)" button under the passages, labelled with the model's name. If the call fails or
   the cap is reached, the button hides and the passages stay.
4. **Handoff:** when the docs do not cover the question, Ask shows "Ask on Discord" and "Open an issue" with the
   question filled in.
5. **Search test in CI:** the 20 questions and the page each should find, run against Helpdock's ranking on every PR.

**Needs from the owner:** a Cloudflare API token limited to Workers AI, set as a secret on Helpdock's Render service.
inference.flisk.si's limit of 100 requests a day is sized to the account's Workers AI free allowance, and Ask would
share that allowance. So P0 first measures Workers AI usage per answer, then splits the allowance between the two caps
or pays for more.

**Test that ends P0:** on the 20 questions, at least 15 correct and **0 made-up commands**. After a week live: the share of
answers people open, and how often the cap or a failure fell back to passages.

## P1: support chat on flisk.sh/docs (after a week of real questions)

- Run the support test first. Ship only at 15 of 20 correct and 0 made-up commands.
- Follow-up questions in the same chat, using Helpdock's existing chat sessions.
- Add flisk.sh pages as a source (ICE 216).
- **Test that ends P1:** the support test passes, and fewer of the docs' questions come back as GitHub issues or on Discord.

## P2: everywhere (only if P1's numbers hold)

- The chat button in the shared Flisk bar, on every flisk.si site.
- Other flisk.si products' docs as sources, each with 10 questions of its own before it goes live.
- `flisk ask` in the CLI.
- **Test that ends P2:** each new place and source passes its own questions with 0 made-up commands.

## The test

20 questions: the 8 starter questions on flisk.sh/docs, 10 questions in users' own words (facts, answers that span pages,
troubleshooting), and 2 the docs should not answer. Each answer is graded by hand against the docs as correct, partly
right, wrong, or made-up command. A made-up command fails the run whatever the score. The questions and grades go in this
repository with P0's first PR, so the next model or prompt is scored the same way.

## Risks

- **A wrong answer costs more than no answer.** That is why passages always come first, unknown commands are dropped,
  and it says "beta".
- **One Cloudflare allowance pays for two products.** Ask must not use up the API's 100 requests a day.
- **The name.** Wolf's own prompt writes `service.json`; Ask uses the same base model with a docs prompt. The label should
  say that, not suggest a model trained on the docs.
- **Privacy.** Visitors paste logs and paths. Questions are not stored, and text that looks like a secret is never sent to
  the model.
