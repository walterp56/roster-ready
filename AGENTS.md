# RosterReady

The first release is a usable app for a one-day volunteer event. The organizer creates shifts and headcounts, shares one event link with the group, collects availability, generates a roster, and publishes it. Anyone with the event link can sign up while collection is open. Each volunteer returns through the same event link and can see their own assignment after publishing.

## First release

- Publishing generates the roster, closes collection, and shares assignments in one step. Show assignments and vacancies to the organizer. Unpublishing clears the roster and reopens collection and shift editing, preserving saved responses.
- Maximize filled slots while respecting declared availability and shift capacity. Volunteers can work multiple shifts when none of their assignments overlap.
- Use React, TypeScript, Vite, Fastify on Node.js 24 LTS, SQLite, and one Docker Compose service with a persistent database volume. See the [README](README.md) for startup, the [design and usage guide](<docs/RosterReady Design and Usage.docx>) for the architecture, and the [test cases](docs/test-cases.md) for verification.
- Authorize organizer operations and scope each private volunteer session and recovery code to its event and volunteer. Keep real volunteer data, recovery codes, and secrets out of version control. Include a synthetic sample event.

## Build and evidence

1. Implement and verify the scheduler against cases the candidate has reviewed.
2. Complete one browser flow from event creation to a volunteer viewing a published assignment.
3. Verify the sample from a clean Linux or Docker checkout. Prepare a short README with run commands, a diagram or demo, and a factual AI-workflow account.

Keep planning and review read-only. Build only the milestone requested by the candidate. Record actual prompt decisions and observed results. Distinguish candidate checks from agent checks, and distinguish measured time from estimates. Use `roster_ready_partner` when the candidate requests it. Keep the repository and deployment local until the candidate authorizes sharing.
