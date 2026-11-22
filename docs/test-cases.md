# RosterReady test cases

Use a disposable database, synthetic names, and separate browser sessions for organizer and volunteer. The [sample event](../examples/sample-event.json) supplies the shift times and headcounts. The [README](../README.md) has the local and Docker startup commands.

## Manual tests

| Case | Steps | Expected result |
| --- | --- | --- |
| Phone volunteer flow | Create Community Workshop on the PC, copy its event link, and open it on a physical phone connected to the same Wi-Fi. Sign up as Demo Volunteer and save **Teacher** and **Presentation**. Publish on the PC and reopen the link on the phone. | The organizer sees **2 of 18 slots filled** and **16 vacancies**. **Your shifts** shows both assignments on the phone. |
| Overlap and capacity | While the event is unpublished, select **Teacher** as the first volunteer and try selecting **Setup**. Have both volunteers select **Presentation** and save their availability before publishing. | **Setup** is disabled while **Teacher** is selected. Only one volunteer gets **Presentation**, which has one slot. |
| Late availability and reopening | Open an availability form before the organizer publishes. Try saving after publication. Then unpublish and revisit the same link. | The late save is rejected and the roster stays intact. Unpublishing hides the roster, reopens sign-ups and shift editing, and shows the volunteer's saved selections. |
| Stale availability | Open the same volunteer response in two tabs. Save an edit in the newer tab, then save a different edit from the older tab. | The older tab shows a conflict and reloads the saved choices. The newer response stays intact. |
| Stale organizer tab | Edit the same shift in two tabs. Save a new headcount in one tab, then submit a rename in the old tab. In the same browser, switch organizer accounts in one tab and submit a new event in the old workspace. | Both stale writes are rejected. The new headcount stays saved, and the old workspace refreshes to the current account. |
| Lost shift response | Let the server save the shift, interrupt the response, and submit the same form again. | The organizer sees one saved shift and the form clears after the retry. |
| Lost event response | Let the server save the event, interrupt the response, and submit the same form again. Then create a separate event with the same name and date. | The retry opens the saved event with its existing link. The new event has a separate link. |
| Lost signup response before publication | Let the server save a sign-up, interrupt the response, and publish the roster. Reload the event link in the same tab, enter the volunteer's name, and choose **Retry signup**. Repeat with a request that never reached the server. | A saved attempt opens the existing response. An unsaved attempt is rejected, and the retry option clears. New sign-ups stay closed. |
| Shift time change | Unpublish, then change the time of a shift a volunteer selected. Confirm the change and reopen the volunteer link. | The moved shift needs a fresh selection. The volunteer's choices for the other shifts stay saved. |
| Withdrawal and restoration | Publish a roster, withdraw from the event using the volunteer link, and refresh the organizer's roster. Reopen the link and select **Restore my shifts**. | The slots open on withdrawal and return to their original assignments after restoration. Focus moves to the heading for the volunteer's new state. |
| Recovery-code isolation | Save the volunteer's recovery code. Open the same event on another browser and enter the code. Try the same code on a different event. | The original event shows the volunteer's response. The second event rejects the code. |
| Organizer isolation | Create an event under one organizer account, then sign in as another organizer in a separate browser session. | The second organizer sees their own events. The first organizer's event stays out of the list and its organizer API rejects access. |
| Docker persistence | Publish the sample in a disposable Compose deployment. Run `docker compose up -d --force-recreate`, sign in again, and reopen the volunteer link. | The organizer account, published roster, and volunteer assignments survive container recreation. |

## Automated tests

| Command | Coverage |
| --- | --- |
| `npm test` | Scheduler validity and maximum coverage, legacy overlapping responses, publish rollback, availability revisions across restart and withdrawal, authentication, and event-scoped recovery. |
| `npm run build` | TypeScript checks the app and tests, and Vite builds the browser assets. |
| `npm run test:browser` | Organizer and volunteer sessions, stale tabs and withdrawals, retries after lost event, shift, and sign-up responses, shift edits, publication and reopening, and the sample at phone width. |
| `docker compose config --quiet` | Compose configuration resolves successfully. |

To run the browser suite with installed Chrome in PowerShell, set `$env:ROSTER_READY_BROWSER = 'chrome'`. The [README](../README.md#testing) lists the Chrome and physical-phone results separately.

## Testing Docker persistence

The following PowerShell commands use a separate Compose project and SQLite volume. The build installs from the lockfile and runs the Node tests and production build in Linux.

```powershell
$env:ROSTER_READY_BIND = '127.0.0.1'
$env:ROSTER_READY_PORT = '3101'
docker compose config --quiet
docker compose -p roster-ready-submission build --no-cache
docker compose -p roster-ready-submission up -d --no-build
```

Open `http://127.0.0.1:3101/` and follow the [sample walkthrough](../README.md#try-the-sample) in separate organizer and volunteer sessions. With the roster published, recreate the container.

```powershell
docker compose -p roster-ready-submission up -d --no-build --force-recreate
```

Sign in again as the organizer and reopen the shared link as the volunteer. The sample still shows **2 of 18 slots filled** and **16 vacancies**. The volunteer still sees **Teacher** and **Presentation**. To remove the disposable deployment and its test data, run `docker compose -p roster-ready-submission down --volumes`.
