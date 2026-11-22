# AI-assisted development

I defined the scheduling rules and supplied examples with expected assignments and vacancies. Codex implemented the scheduler and the browser app. I used the repository's `roster_ready_partner` agent to work through those two parts separately, so I could compare the scheduler's output with my examples before building the event workflow.

## Design decisions

- I chose one shared event link so the organizer could post it to the whole group. Anyone with the link can sign up while availability is open.
- I found the separate draft and reopening controls confusing. I asked Codex to combine generation and publication into one action. **Unpublish roster** reopens availability and shift editing and keeps the saved responses.
- I noticed that a volunteer who selected **Teacher** and **Presentation** received only one assignment even though the shifts did not overlap. I asked Codex to allow multiple compatible assignments. The sample now fills **2 of 18 slots**.

## Testing and fixes

I tested the shared link on a physical phone over the same Wi-Fi and confirmed that a volunteer could use it through publication. Codex ran the [Node and Chrome test suites](../README.md#testing). They compare the scheduler with exhaustive search, verify organizer and volunteer access, and cover the sample at phone width. Codex also built the app in Docker and verified that the roster and volunteer access persisted after container recreation.

When a two-tab test showed that an old availability form could overwrite a newer save, I approved a fix. I also approved a fix for slow scheduling when older responses contained overlapping choices. Codex implemented both fixes and added regression tests.

## Time spent

The development logs for November 19–22, 2026 recorded about **3 hours 10 minutes** of Codex elapsed time across 98 completed turns, including tool runs and waits. Planning accounted for about 31 minutes. Implementation, code review, testing, and documentation accounted for about 2 hours 39 minutes. My personal active time remains unestimated.
