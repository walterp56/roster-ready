import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildServer } from '../src/server.ts';
import type { Page, Route } from '@playwright/test';
import type { EventDetail, EventShift, InvitationDetail } from '../src/event.ts';

const eventName = 'Community Volunteer Day';
const shifts = [
  { name: 'Setup', capacity: '2', startTime: '08:00', endTime: '09:00' },
  { name: 'Welcome', capacity: '1', startTime: '09:00', endTime: '11:00' },
  { name: 'Cleanup', capacity: '1', startTime: '11:00', endTime: '12:00' },
];
const volunteers = [
  { name: 'Ivy', available: ['Setup', 'Welcome'], firstAssignments: ['Setup', 'Welcome'], finalAssignments: ['Welcome'] },
  { name: 'Ken', available: ['Setup'], firstAssignments: ['Setup'], finalAssignments: ['Setup'] },
  { name: 'Lena', available: ['Welcome', 'Cleanup'], firstAssignments: ['Cleanup'], finalAssignments: ['Cleanup'] },
  { name: 'Omar', available: ['Setup'], firstAssignments: [], finalAssignments: ['Setup'] },
];

async function registerOrganizer(page: Page, username: string, password: string) {
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create organizer account' }).click();
  await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();
}

test('creates, fills and publishes a roster across separate sessions', async ({ browser, page: organizer }) => {
  const directory = await mkdtemp(join(tmpdir(), 'roster-ready-browser-'));
  const password = randomBytes(24).toString('base64url');
  const app = buildServer({ databasePath: join(directory, 'roster.sqlite') });

  try {
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const event = await test.step('Organizer creates an account, creates the event and adds four slots', async () => {
      await organizer.goto(url);
      await registerOrganizer(organizer, 'event-owner', password);
      await organizer.getByLabel('Event name').fill(eventName);
      await organizer.getByLabel('Event date').fill('2026-12-05');
      const created = organizer.waitForResponse((response) => response.url() === `${url}/api/events` && response.request().method() === 'POST');
      await organizer.getByRole('button', { name: 'Create event' }).click();
      const eventResponse = await created;
      expect(eventResponse.status()).toBe(201);
      await expect(organizer.getByRole('heading', { name: eventName })).toBeVisible();
      await expect(organizer.getByRole('button', { name: 'Publish roster' })).toBeDisabled();
      await expect(organizer.getByText('Add a shift before publishing.')).toBeVisible();
      for (const shift of shifts) {
        await organizer.getByLabel('Shift name').fill(shift.name);
        await organizer.getByLabel('Start time').fill(shift.startTime);
        await organizer.getByLabel('End time').fill(shift.endTime);
        await organizer.getByLabel('Volunteers needed').fill(shift.capacity);
        await organizer.getByRole('button', { name: 'Add shift' }).click();
        await expect(organizer.getByRole('region', { name: 'Shifts' }).getByText(shift.name, { exact: true })).toBeVisible();
      }
      await expect(organizer.getByText('4 slots', { exact: true })).toBeVisible();
      return await eventResponse.json() as EventDetail;
    });

    const eventPath = `${url}/api/events/${event.id}`;
    const rosterPanel = organizer.getByRole('region', { name: 'Roster', exact: true });
    const shiftList = organizer.getByRole('region', { name: 'Shifts', exact: true });
    const volunteerList = organizer.getByRole('region', { name: 'Volunteers', exact: true });
    const setupShift = shiftList.getByRole('listitem').filter({ hasText: 'Setup' });
    const publishButton = rosterPanel.getByRole('button', { name: 'Publish roster', exact: true });
    const unpublishButton = rosterPanel.getByRole('button', { name: 'Unpublish roster', exact: true });
    const publishDialog = organizer.getByRole('dialog', { name: 'Publish this roster?' });
    const unpublishDialog = organizer.getByRole('dialog', { name: 'Unpublish this roster?' });
    await expect(setupShift).toContainText('0 volunteers available');
    await test.step('Another organizer can sign in and manage only their own events', async () => {
      const other = await browser.newContext();
      try {
        const page = await other.newPage();
        await page.goto(url);
        await registerOrganizer(page, 'other-organizer', password);
        await expect(page.getByRole('heading', { name: 'Create your first event' })).toBeVisible();
        expect(await (await other.request.get(`${url}/api/events`)).json()).toEqual({ events: [] });
        expect((await other.request.get(eventPath)).status()).toBe(404);
        for (const route of ['reopen', 'publish', 'shifts']) {
          const response = await other.request.post(`${eventPath}/${route}`, {
            data: route === 'shifts' ? { ...shifts[0], capacity: 2 } : { revision: 'other-roster' },
          });
          expect(response.status()).toBe(404);
        }
        expect((await other.request.put(`${eventPath}/volunteers/other-volunteer/withdrawal`, { data: { withdrawn: true } })).status()).toBe(404);
        const otherSession = await (await other.request.get(`${url}/api/organizer/session`)).json();
        const created = await other.request.post(`${url}/api/events`, { data: { organizerId: otherSession.account.id, name: 'Other event', date: event.date } });
        expect(created.status()).toBe(201);
        const otherEvent = await created.json() as EventDetail;
        expect((await organizer.request.get(`${url}/api/events/${otherEvent.id}`)).status()).toBe(404);
        await page.getByRole('button', { name: 'Sign out' }).click();
        await expect(page.getByRole('heading', { name: 'Organizer sign-in' })).toBeVisible();
        expect((await other.request.get(`${url}/api/events`)).status()).toBe(401);
        await page.getByLabel('Username').fill('OTHER-ORGANIZER');
        await page.getByLabel('Password', { exact: true }).fill(password);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(page.getByRole('heading', { name: otherEvent.name })).toBeVisible();
        await expect(page.getByRole('heading', { name: eventName })).toHaveCount(0);
      } finally {
        await other.close();
      }
    });
    const invitation = await organizer.getByRole('textbox', { name: 'Shared event link' }).inputValue();
    const signupPath = invitation.replace('/join/', '/api/join/');
    const invitations = await test.step('Four separate browsers use the same event link to sign up and respond', async () => {
      const sessions = [];
      for (const volunteer of volunteers) {
        const apiPath = `${signupPath}/volunteer`;
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        if (volunteer.name === 'Ivy') {
          await page.route(signupPath, (route) => route.fulfill({
            status: 503, json: { error: 'The event could not be loaded.' },
          }), { times: 1 });
        }
        await page.goto(invitation);
        if (volunteer.name === 'Ivy') {
          await expect(page.getByRole('alert')).toHaveText('The event could not be loaded.');
          await page.getByRole('button', { name: 'Try again' }).click();
        }
        await page.getByLabel('Your name').fill(volunteer.name);
        await page.getByRole('button', { name: 'Sign up', exact: true }).click();
        await expect(page.getByText(`Invitation for ${volunteer.name}`)).toBeVisible();
        const recoveryCode = await page.getByRole('textbox', { name: 'Your recovery code' }).inputValue();
        if (volunteer.name === 'Ivy') {
          const ivyResponse = volunteerList.getByRole('listitem').filter({ hasText: 'Ivy' });
          await organizer.getByRole('button', { name: 'Refresh responses' }).click();
          await expect(ivyResponse).toContainText('Awaiting response');
          await page.getByRole('button', { name: 'Save as unavailable' }).click();
          await expect(page.getByText('Saved as unavailable.')).toBeVisible();
          await organizer.getByRole('button', { name: 'Refresh responses' }).click();
          await expect(ivyResponse).toContainText('Unavailable');
          await expect(setupShift).toContainText('0 volunteers available');
        }
        for (const shift of volunteer.available) await page.getByRole('checkbox', { name: new RegExp(shift) }).check();
        await page.getByRole('button', { name: 'Save availability' }).click();
        await expect(page.getByText('Availability saved.')).toBeVisible();
        const response = await context.request.get(apiPath);
        expect(response.status()).toBe(200);
        const detail = await response.json() as InvitationDetail;
        expect(detail.assignments).toEqual([]);
        expect(detail.volunteer.name).toBe(volunteer.name);
        expect((await context.request.get(eventPath)).status()).toBe(401);
        expect(page.url()).toBe(invitation);
        sessions.push({ volunteer, volunteerId: detail.volunteer.id, recoveryCode, apiPath, context, page });
      }
      expect(new Set(sessions.map(({ recoveryCode }) => recoveryCode)).size).toBe(4);
      await organizer.getByRole('button', { name: 'Refresh responses' }).click();
      await expect(organizer.getByText('4 of 4 responded')).toBeVisible();
      await expect(volunteerList.getByRole('listitem').filter({ hasText: 'Ivy' }))
        .toContainText('Available for Setup (08:00–09:00), Welcome (09:00–11:00)');
      await expect(volunteerList.getByRole('listitem').filter({ hasText: 'Ken' }))
        .toContainText('Available for Setup (08:00–09:00)');
      await expect(setupShift).toContainText('3 volunteers available');
      await expect(setupShift).toContainText('2 needed');
      await expect(shiftList.getByRole('listitem').filter({ hasText: 'Welcome' })).toContainText('2 volunteers available');
      await expect(shiftList.getByRole('listitem').filter({ hasText: 'Cleanup' })).toContainText('1 volunteer available');
      return sessions;
    });

    await test.step('An older availability tab cannot overwrite a newer save', async () => {
      const { page: older, context, apiPath } = invitations[0];
      const newer = await context.newPage();
      await newer.goto(invitation);
      const setup = (page: Page) => page.getByRole('checkbox', { name: /Setup/ });
      const welcome = (page: Page) => page.getByRole('checkbox', { name: /Welcome/ });
      await expect(setup(newer)).toBeChecked();
      await setup(newer).uncheck();
      await newer.getByRole('button', { name: 'Save availability' }).click();
      await expect(newer.getByText('Availability saved.')).toBeVisible();
      const saved = await (await context.request.get(apiPath)).json() as InvitationDetail;

      await welcome(older).uncheck();
      const response = older.waitForResponse((result) => result.url() === `${apiPath}/availability` && result.request().method() === 'PUT');
      await older.getByRole('button', { name: 'Save availability' }).click();
      expect((await response).status()).toBe(409);
      await expect(older.getByRole('alert')).toHaveText('Your availability changed. Review the saved choices before trying again.');
      await expect(setup(older)).not.toBeChecked();
      await expect(welcome(older)).toBeChecked();
      expect(await (await context.request.get(apiPath)).json()).toEqual(saved);
      await setup(older).check();
      await older.getByRole('button', { name: 'Save availability' }).click();
      await expect(older.getByText('Availability saved.')).toBeVisible();
      await newer.close();
    });

    const previousRevision = await test.step('Volunteers can cancel edits and a withdrawal can be corrected before publishing', async () => {
      const { page: ivy } = invitations[0];
      await ivy.reload();
      await expect(ivy.getByText('Availability saved.')).toBeVisible();
      const welcome = ivy.getByRole('checkbox', { name: /Welcome/ });
      await welcome.uncheck();
      await expect(ivy.getByText('Changes haven’t been saved.')).toBeVisible();
      await ivy.getByRole('button', { name: 'Cancel changes' }).click();
      await expect(welcome).toBeChecked();

      const { page: omar } = invitations[3];
      await omar.getByRole('button', { name: 'Withdraw from event' }).click();
      await omar.getByRole('dialog').getByRole('button', { name: 'Withdraw from event' }).click();
      await expect(omar.getByRole('heading', { name: 'You’ve withdrawn' })).toBeVisible();
      await organizer.getByRole('button', { name: 'Refresh responses' }).click();
      await expect(volunteerList.getByText('3 of 3 responded')).toBeVisible();
      await expect(volunteerList.getByText('Omar', { exact: true })).toHaveCount(0);
      await expect(setupShift).toContainText('2 volunteers available');
      await publishButton.click();
      await publishDialog.getByRole('button', { name: 'Publish roster' }).click();
      await expect(organizer.getByText('4 of 4 slots filled')).toBeVisible();
      const earlier = await (await organizer.request.get(eventPath)).json() as EventDetail;
      expect(earlier.rosterRevision).not.toBeNull();

      await unpublishButton.click();
      await expect(unpublishDialog).toContainText('This clears the roster and hides assignments.');
      await unpublishDialog.getByRole('button', { name: 'Unpublish roster' }).click();
      await expect(organizer.getByText('Unpublished', { exact: true })).toBeVisible();
      await expect(organizer.getByRole('button', { name: 'Add shift' })).toBeEnabled();
      await expect(rosterPanel.getByRole('heading', { name: 'Roster' })).toBeFocused();
      const reopened = await (await organizer.request.get(eventPath)).json() as EventDetail;
      expect(reopened.roster).toBeNull();
      expect(reopened.volunteers.find(({ name }) => name === 'Ivy')?.availableShiftIds).toHaveLength(2);
      await omar.getByRole('button', { name: 'Return to availability' }).click();
      await expect(omar.getByRole('checkbox', { name: /Setup/ })).toBeChecked();
      await omar.getByRole('button', { name: 'Save availability' }).click();
      await expect(omar.getByText('Availability saved.')).toBeVisible();
      return earlier.rosterRevision;
    });

    const published = await test.step('Publish fills all four slots and closes availability in one step', async () => {
      await expect(organizer.getByText('Unpublished', { exact: true })).toBeVisible();
      await expect(unpublishButton).toHaveCount(0);
      await publishButton.click();
      await publishDialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(organizer.getByText('Unpublished', { exact: true })).toBeVisible();
      await expect(organizer.getByRole('button', { name: 'Add shift' })).toBeEnabled();
      await publishButton.click();
      await publishDialog.getByRole('button', { name: 'Publish roster' }).click();
      await expect(organizer.getByText('Published', { exact: true })).toBeVisible();
      await expect(publishButton).toHaveCount(0);
      await expect(organizer.getByRole('button', { name: 'Add shift' })).toHaveCount(0);
      await expect(organizer.getByText('4 of 4 slots filled')).toBeVisible();
      await expect(organizer.getByText('0 vacancies')).toBeVisible();
      const setup = organizer.getByRole('row', { name: /^Setup/ });
      await expect(setup).toContainText('Ken');
      await expect(setup).toContainText('Ivy');
      await expect(organizer.getByRole('row', { name: /^Welcome/ })).toContainText('Ivy');
      await expect(organizer.getByRole('row', { name: /^Cleanup/ })).toContainText('Lena');
      expect((await organizer.request.post(`${eventPath}/publish`)).status()).toBe(409);
      expect((await organizer.request.post(`${eventPath}/reopen`, { data: { revision: previousRevision } })).status()).toBe(409);

      const response = await organizer.request.get(eventPath);
      expect(response.status()).toBe(200);
      return await response.json() as EventDetail;
    });

    await test.step('A late browser submission gets HTTP 409 and leaves the published roster unchanged', async () => {
      const { page, apiPath } = invitations[0];
      await page.getByRole('checkbox', { name: /Welcome/ }).uncheck();
      const late = page.waitForResponse((response) => response.url() === `${apiPath}/availability` && response.request().method() === 'PUT');
      await page.getByRole('button', { name: 'Save availability' }).click();
      expect((await late).status()).toBe(409);
      await expect(page.getByRole('alert')).toHaveText('Availability collection is closed.');
      await expect(page.getByRole('region', { name: 'Your shifts' }).getByRole('heading', { name: 'Welcome' })).toBeVisible();
      const response = await organizer.request.get(eventPath);
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual(published);
    });

    await test.step('The published link shows all and only the signed-in volunteer’s shifts', async () => {
      for (const { volunteer, apiPath, context, page } of invitations) {
        await page.goto(invitation);
        const schedule = page.getByRole('region', { name: 'Your shifts' });
        await expect(schedule).toBeVisible();
        await expect(schedule.getByRole('heading', { level: 3 })).toHaveText(volunteer.firstAssignments);
        for (const other of volunteers.filter(({ name }) => name !== volunteer.name)) {
          await expect(page.getByText(other.name, { exact: true })).toHaveCount(0);
        }
        const response = await context.request.get(apiPath);
        expect(response.status()).toBe(200);
        const detail = await response.json() as InvitationDetail;
        expect(detail.volunteer.name).toBe(volunteer.name);
        expect(detail.assignments.map(({ name }) => name)).toEqual(volunteer.firstAssignments);
        expect(detail).not.toHaveProperty('roster');
        expect(detail).not.toHaveProperty('volunteers');
      }
    });

    await test.step('The volunteer page can still open a roster served by the previous backend', async () => {
      const ken = invitations[1];
      await ken.page.route(ken.apiPath, async (route) => {
        const response = await route.fetch();
        const { assignments, rosterRevision, ...previous } = await response.json();
        await route.fulfill({ response, json: previous });
      }, { times: 1 });
      await ken.page.reload();
      await expect(ken.page.getByRole('region', { name: 'Your shifts' }).getByRole('heading', { level: 3 })).toHaveText(['Setup']);
    });

    await test.step('The shared link reveals no assignment without a browser session or a valid recovery code', async () => {
      const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
      try {
        const page = await guest.newPage();
        await page.goto(invitation);
        await expect(page.getByRole('heading', { name: 'Sign-ups are closed' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Your shifts' })).toHaveCount(0);
        const publicPage = await guest.request.get(signupPath);
        expect(await publicPage.json()).toEqual({ event: { id: event.id, name: eventName, date: event.date, status: 'published' }, signedIn: false });
        expect((await guest.request.get(`${signupPath}/volunteer`)).status()).toBe(401);
        expect((await guest.request.post(`${signupPath}/volunteer/restore`, { data: { volunteerId: invitations[0].volunteerId } })).status()).toBe(401);
        expect((await guest.request.post(signupPath, { data: { name: 'Late signup' } })).status()).toBe(409);

        await page.getByRole('button', { name: 'Use recovery code' }).click();
        await page.getByLabel('Recovery code').fill('incorrect-code');
        await page.getByRole('button', { name: 'Open my response' }).click();
        await expect(page.getByRole('alert')).toHaveText('That recovery code does not match this event.');
        await page.getByLabel('Recovery code').fill(invitations[0].recoveryCode);
        await page.getByRole('button', { name: 'Open my response' }).click();
        await expect(page.getByText('Invitation for Ivy')).toBeVisible();
        await expect(page.getByRole('region', { name: 'Your shifts' }).getByRole('heading', { level: 3 })).toHaveText(['Setup', 'Welcome']);
        await page.getByRole('button', { name: 'Switch volunteer' }).click();
        await expect(page.getByRole('heading', { name: 'Open your response' })).toBeVisible();
        expect((await guest.request.get(`${signupPath}/volunteer`)).status()).toBe(401);
        await page.getByLabel('Recovery code').fill(invitations[1].recoveryCode);
        await page.getByRole('button', { name: 'Open my response' }).click();
        await expect(page.getByText('Invitation for Ken')).toBeVisible();
        const staleTab = await guest.request.post(`${signupPath}/volunteer/withdraw`, {
          data: { volunteerId: invitations[0].volunteerId, revision: published.rosterRevision },
        });
        expect(staleTab.status()).toBe(409);
        expect(await (await guest.request.get(`${signupPath}/volunteer`)).json()).toMatchObject({ withdrawn: false, assignments: [{ name: 'Setup' }] });
      } finally {
        await guest.close();
      }
    });

    const republished = await test.step('Unpublish opens shift editing and volunteer availability immediately', async () => {
      const ivy = invitations[0];
      await organizer.setViewportSize({ width: 390, height: 844 });
      const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await guest.goto(invitation);
      await expect(guest.getByRole('heading', { name: 'Sign-ups are closed' })).toBeVisible();
      const stalePage = await ivy.context.newPage();
      await stalePage.goto(invitation);
      const staleSchedule = stalePage.getByRole('region', { name: 'Your shifts' });
      await expect(staleSchedule.getByRole('heading', { level: 3 })).toHaveText(['Setup', 'Welcome']);
      await expect(guest.getByRole('button', { name: 'Check for updates' })).toHaveCount(0);
      await expect(ivy.page.getByRole('region', { name: 'Your shifts' })).toBeVisible();
      await expect(ivy.page.getByRole('button', { name: 'Check for updates' })).toHaveCount(0);
      expect((await ivy.context.request.post(`${eventPath}/reopen`, { data: { revision: published.rosterRevision } })).status()).toBe(401);
      await expect(unpublishButton).toHaveCount(1);
      await expect(publishButton).toHaveCount(0);
      expect(await organizer.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await unpublishButton.click();
      await expect(unpublishDialog).toContainText('This clears the roster and hides assignments.');
      await expect(unpublishDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      await unpublishDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(organizer.getByText('Published', { exact: true })).toBeVisible();
      await expect(unpublishButton).toBeFocused();
      await unpublishButton.click();
      await unpublishDialog.getByRole('button', { name: 'Unpublish roster' }).click();
      await expect(organizer.getByText('Unpublished', { exact: true })).toBeVisible();
      await expect(organizer.getByRole('button', { name: 'Add shift' })).toBeEnabled();
      await expect(publishButton).toBeEnabled();
      await expect(rosterPanel).toContainText('Publishing closes availability.');
      await expect(rosterPanel.getByRole('heading', { name: 'Roster' })).toBeFocused();
      const reopened = await (await organizer.request.get(eventPath)).json() as EventDetail;
      expect(reopened).toEqual({ ...published, status: 'collecting', roster: null, rosterRevision: null });

      expect((await organizer.request.post(`${eventPath}/reopen`, { data: { revision: published.rosterRevision } })).status()).toBe(409);
      for (const { context, apiPath } of invitations) {
        expect(await (await context.request.get(apiPath)).json()).toMatchObject({ event: { status: 'collecting' }, assignments: [] });
      }
      await guest.reload();
      await expect(guest.getByRole('heading', { name: 'Sign up to volunteer' })).toBeVisible();
      await guest.close();
      await ivy.page.reload();
      await expect(ivy.page.getByRole('heading', { name: 'Your availability' })).toBeVisible();
      await expect(ivy.page.getByRole('heading', { name: 'Your shifts' })).toHaveCount(0);
      const setup = ivy.page.getByRole('checkbox', { name: /Setup/ });
      const welcome = ivy.page.getByRole('checkbox', { name: /Welcome/ });
      await expect(setup).toBeChecked();
      await expect(welcome).toBeChecked();
      await setup.uncheck();
      await ivy.page.getByRole('button', { name: 'Save availability' }).click();
      await expect(ivy.page.getByText('Availability saved.')).toBeVisible();
      expect(await (await ivy.context.request.get(ivy.apiPath)).json()).toMatchObject({
        availableShiftIds: [reopened.shifts.find(({ name }) => name === 'Welcome')?.id],
      });

      await organizer.getByLabel('Shift name').fill('Pack equipment');
      await organizer.getByLabel('Start time').fill('12:00');
      await organizer.getByLabel('End time').fill('13:00');
      await organizer.getByRole('button', { name: 'Add shift' }).click();
      await expect(shiftList.getByRole('listitem').filter({ hasText: 'Pack equipment' })).toContainText('0 volunteers available');
      await expect(volunteerList.getByRole('listitem').filter({ hasText: 'Ivy' })).toContainText('Available for Welcome (09:00–11:00)');
      await expect(setupShift).toContainText('2 volunteers available');
      await ivy.page.reload();
      await expect(ivy.page.getByRole('checkbox', { name: /Pack equipment/ })).toBeVisible();

      await publishButton.click();
      await publishDialog.getByRole('button', { name: 'Publish roster' }).click();
      await expect(organizer.getByText('4 of 5 slots filled')).toBeVisible();
      await expect(organizer.getByText('1 vacancy')).toBeVisible();
      await expect(organizer.getByText('Published', { exact: true })).toBeVisible();
      await ivy.page.reload();
      await expect(ivy.page.getByRole('region', { name: 'Your shifts' }).getByRole('heading', { name: 'Welcome' })).toBeVisible();
      const result = await (await organizer.request.get(eventPath)).json() as EventDetail;
      expect(result.status).toBe('published');
      expect(result.rosterRevision).not.toBe(published.rosterRevision);
      await stalePage.getByRole('button', { name: 'Withdraw from event' }).click();
      await stalePage.getByRole('dialog').getByRole('button', { name: 'Withdraw from event' }).click();
      await expect(stalePage.getByRole('alert')).toHaveText('The roster changed. Review the latest roster before updating participation.');
      await expect(staleSchedule.getByRole('heading', { level: 3 })).toHaveText(['Welcome']);
      expect(await (await ivy.context.request.get(ivy.apiPath)).json()).toMatchObject({ withdrawn: false, rosterRevision: result.rosterRevision });
      await stalePage.close();
      return result;
    });

    await test.step('A volunteer reopens the shared link and restores their original published assignment', async () => {
      const { page: ivy, context, apiPath, volunteerId } = invitations[0];
      const oldResponse = await (await context.request.get(apiPath)).json() as InvitationDetail;
      await ivy.getByRole('button', { name: 'Withdraw from event' }).click();
      await ivy.getByRole('dialog').getByRole('button', { name: 'Withdraw from event' }).click();
      await expect(ivy.getByRole('heading', { name: 'You’ve withdrawn' })).toBeVisible();
      await expect(ivy.getByRole('heading', { name: 'You’ve withdrawn' })).toBeFocused();
      await expect(ivy.getByRole('heading', { name: 'Your shifts' })).toHaveCount(0);
      expect(await (await context.request.get(apiPath)).json()).toMatchObject({ withdrawn: true, canRestoreAssignment: true, assignments: [] });

      await organizer.getByRole('button', { name: 'Refresh roster' }).click();
      await expect(organizer.getByText('3 of 5 slots filled')).toBeVisible();
      await expect(organizer.getByText('2 vacancies')).toBeVisible();
      const listedVolunteers = organizer.getByRole('region', { name: 'Volunteers' });
      await expect(listedVolunteers.getByText('3 of 3 responded')).toBeVisible();
      await expect(listedVolunteers.getByText('Ivy', { exact: true })).toHaveCount(0);
      const welcome = organizer.getByRole('row', { name: /^Welcome/ });
      await expect(welcome).not.toContainText('Ivy');
      await expect(welcome.getByRole('cell').last()).toHaveText('1');
      const afterDropout = await (await organizer.request.get(eventPath)).json() as EventDetail;
      expect(afterDropout.roster).toEqual(republished.roster);
      expect(afterDropout.rosterRevision).toBe(republished.rosterRevision);
      for (const { volunteer, context, apiPath } of invitations.slice(1)) {
        const detail = await (await context.request.get(apiPath)).json() as InvitationDetail;
        expect(detail.assignments.map(({ name }) => name)).toEqual(volunteer.finalAssignments);
      }

      await expect(organizer.getByRole('button', { name: /restore/i })).toHaveCount(0);
      const organizerRestore = await organizer.request.put(`${eventPath}/volunteers/${volunteerId}/withdrawal`, { data: { withdrawn: false } });
      expect(organizerRestore.status()).toBe(403);
      const otherVolunteer = await invitations[1].context.request.post(`${apiPath}/restore`, { data: { volunteerId, revision: republished.rosterRevision } });
      expect(otherVolunteer.status()).toBe(409);
      const staleRestore = await context.request.post(`${apiPath}/restore`, { data: { volunteerId, revision: published.rosterRevision } });
      expect(staleRestore.status()).toBe(409);
      expect(await (await context.request.get(apiPath)).json()).toMatchObject({ withdrawn: true, assignments: [] });

      await ivy.goto(invitation);
      await ivy.getByRole('button', { name: 'Restore my shifts' }).click();
      await expect(ivy.getByRole('region', { name: 'Your shifts' }).getByRole('heading', { name: 'Welcome' })).toBeVisible();
      await expect(ivy.getByRole('heading', { name: 'Your shifts' })).toBeFocused();
      await expect(ivy.getByRole('button', { name: 'Withdraw from event' })).toBeVisible();
      const staleWithdrawal = await context.request.post(apiPath + '/withdraw', {
        data: { volunteerId, revision: oldResponse.rosterRevision, availabilityRevision: oldResponse.availabilityRevision },
      });
      expect(staleWithdrawal.status()).toBe(409);
      await organizer.getByRole('button', { name: 'Refresh roster' }).click();
      await expect(organizer.getByText('4 of 5 slots filled')).toBeVisible();
      await expect(listedVolunteers.getByText('Ivy', { exact: true })).toBeVisible();
      const restored = await (await organizer.request.get(eventPath)).json() as EventDetail;
      expect(restored.roster).toEqual(republished.roster);
      expect(restored.rosterRevision).toBe(republished.rosterRevision);
      expect(await ivy.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    });
    for (const { context } of invitations) await context.close();
  } finally {
    await app.close();
    await rm(directory, { recursive: true });
  }
});

test('organizer recovers from connection errors and stale workspace edits', async ({ page: organizer }) => {
  const app = buildServer({ databasePath: ':memory:' });
  try {
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const password = randomBytes(24).toString('base64url');
    await organizer.route('**/api/organizer/session', (route) => route.abort(), { times: 1 });
    await organizer.goto(url);
    await expect(organizer.getByRole('alert')).toBeVisible();
    await organizer.getByRole('button', { name: 'Try again' }).click();
    await registerOrganizer(organizer, 'first-reviewer', password);
    await organizer.getByLabel('Event name').fill('Shift editing example');
    await organizer.getByLabel('Event date').fill('2026-12-05');
    await organizer.getByRole('button', { name: 'Create event' }).click();
    const link = await organizer.getByRole('textbox', { name: 'Shared event link' }).inputValue();
    const eventPath = link.replace('/join/', '/api/events/');
    let refreshRequests = 0;
    const failRefresh = async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue();
      refreshRequests++;
      await route.abort();
    };
    await organizer.route(eventPath, failRefresh);
    await organizer.route(`${eventPath}/shifts`, async (route) => {
      const saved = await route.fetch();
      expect(saved.status()).toBe(201);
      await route.abort();
    }, { times: 1 });
    await organizer.getByLabel('Shift name').fill('Setup');
    await organizer.getByLabel('Start time').fill('08:00');
    await organizer.getByLabel('End time').fill('09:00');
    await organizer.getByRole('button', { name: 'Add shift' }).click();
    await expect(organizer.getByRole('alert')).toBeVisible();
    await organizer.getByRole('button', { name: 'Add shift' }).click();
    const edit = organizer.getByRole('button', { name: /^Edit Setup,/ });
    await expect(edit).toBeVisible();
    await expect(edit).toHaveCount(1);
    await expect(organizer.getByLabel('Shift name')).toBeEmpty();
    expect(refreshRequests).toBe(0);
    await organizer.unroute(eventPath, failRefresh);

    const other = await organizer.context().newPage();
    await other.goto(url);
    await other.getByRole('button', { name: /^Edit Setup,/ }).click();
    await edit.press('Enter');
    await organizer.getByLabel('Volunteers needed').fill('2');
    await organizer.getByRole('button', { name: 'Save shift' }).press('Enter');
    await expect(edit).toBeFocused();
    await other.getByLabel('Shift name').fill('Stale rename');
    await other.getByRole('button', { name: 'Save shift' }).click();
    await expect(other.getByRole('alert')).toContainText('This shift changed.');
    await expect(other.getByRole('region', { name: 'Shifts' })).toContainText('2 needed');
    expect((await (await organizer.request.get(eventPath)).json() as EventDetail).shifts)
      .toMatchObject([{ name: 'Setup', capacity: 2 }]);

    await other.getByRole('button', { name: 'Sign out' }).click();
    await registerOrganizer(other, 'second-reviewer', password);
    await organizer.getByRole('button', { name: 'New event' }).click();
    await organizer.getByLabel('Event name').fill('Event from stale tab');
    await organizer.getByLabel('Event date').fill('2026-12-05');
    await organizer.getByRole('button', { name: 'Create event' }).click();
    await expect(organizer.getByRole('alert')).toContainText('The organizer account changed.');
    await expect(organizer.getByText('Signed in as second-reviewer')).toBeVisible();
    expect(await (await other.request.get(url + '/api/events')).json()).toEqual({ events: [] });
    await other.close();

    await test.step('Retrying a lost Create Event response keeps the original event and link', async () => {
      const eventsUrl = url + '/api/events';
      const name = 'Event creation retry';
      const date = '2026-12-05';
      let savedId: string | undefined;
      const loseResponse = async (route: Route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const saved = await route.fetch();
        expect(saved.status()).toBe(201);
        savedId = (await saved.json() as EventDetail).id;
        await route.abort();
      };
      await organizer.route(eventsUrl, loseResponse);
      await organizer.getByLabel('Event name').fill(name);
      await organizer.getByLabel('Event date').fill(date);
      await organizer.getByRole('button', { name: 'Create event' }).click();
      await expect(organizer.getByRole('alert')).toBeVisible();
      expect(savedId).toBeDefined();
      await organizer.unroute(eventsUrl, loseResponse);

      await organizer.getByRole('button', { name: 'Create event' }).click();
      const eventLink = organizer.getByRole('textbox', { name: 'Shared event link' });
      await expect(eventLink).toHaveValue(`${url}/join/${savedId}`);
      expect((await (await organizer.request.get(eventsUrl)).json()).events).toMatchObject([{ id: savedId, name, date }]);

      await organizer.getByRole('button', { name: 'New event' }).click();
      await organizer.getByLabel('Event name').fill(name);
      await organizer.getByLabel('Event date').fill(date);
      await organizer.getByRole('button', { name: 'Create event' }).click();
      await expect(eventLink).not.toHaveValue(`${url}/join/${savedId}`);
      const savedEvents = (await (await organizer.request.get(eventsUrl)).json()).events as EventDetail[];
      expect(savedEvents).toMatchObject([{ name, date }, { id: savedId, name, date }]);
      expect(savedEvents[0].id).not.toBe(savedId);
    });
  } finally {
    await app.close();
  }
});

test('a phone-sized volunteer can recover from a lost signup response after reloading', async ({ browser, page: organizer }) => {
  const app = buildServer({ databasePath: ':memory:' });
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  const volunteer = await browser.newContext(phone);
  try {
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    await organizer.goto(url);
    await registerOrganizer(organizer, 'signup-reviewer', randomBytes(24).toString('base64url'));
    await organizer.getByLabel('Event name').fill('Signup example');
    await organizer.getByLabel('Event date').fill('2026-12-05');
    await organizer.getByRole('button', { name: 'Create event' }).click();
    const link = await organizer.getByRole('textbox', { name: 'Shared event link' }).inputValue();
    const signupPath = link.replace('/join/', '/api/join/');
    const signupRoute = new URL(signupPath).pathname;
    const eventPath = link.replace('/join/', '/api/events/');

    async function interruptSignup(page: Page, name: string, saveOnServer: boolean) {
      await page.route(signupPath, async (route) => {
        if (saveOnServer) {
          const saved = await app.inject({ method: 'POST', url: signupRoute, payload: route.request().postDataJSON() });
          expect(saved.statusCode).toBe(201);
        }
        await route.abort();
      }, { times: 1 });
      await page.getByLabel('Your name').fill(name);
      await page.getByRole('button', { name: 'Sign up', exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible();
    }

    const page = await volunteer.newPage();
    await page.goto(link);
    await page.getByRole('button', { name: 'Use recovery code' }).press('Enter');
    await expect(page.getByLabel('Recovery code')).toBeFocused();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const name = 'W'.repeat(120);
    await interruptSignup(page, name, true);
    expect(await (await volunteer.request.get(signupPath)).json()).toMatchObject({ signedIn: false });
    await page.reload();
    await page.getByLabel('Your name').fill(name);
    await page.getByRole('button', { name: 'Sign up', exact: true }).press('Enter');
    await expect(page.getByRole('heading', { name: 'Your availability' })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await organizer.getByRole('button', { name: 'Refresh responses' }).click();
    const responses = organizer.getByRole('region', { name: 'Volunteers', exact: true });
    await expect(responses.getByText(name, { exact: true })).toBeVisible();
    await expect(responses.getByRole('listitem')).toHaveCount(1);

    await test.step('A volunteer can retry a saved signup after publication, while unsaved attempts stay closed', async () => {
      const returning = await browser.newPage(phone);
      const unsaved = await browser.newPage(phone);
      try {
        await returning.goto(link);
        await unsaved.goto(link);
        await interruptSignup(returning, 'Returning volunteer', true);
        await interruptSignup(unsaved, 'Unsaved volunteer', false);
        await organizer.getByLabel('Shift name').fill('Setup');
        await organizer.getByLabel('Start time').fill('08:00');
        await organizer.getByLabel('End time').fill('09:00');
        await organizer.getByRole('button', { name: 'Add shift' }).click();
        await organizer.getByRole('button', { name: 'Publish roster' }).click();
        await organizer.getByRole('dialog').getByRole('button', { name: 'Publish roster' }).click();
        await expect(organizer.getByText('Published', { exact: true })).toBeVisible();

        await returning.reload();
        await expect(returning.getByRole('heading', { name: 'Sign-ups are closed' })).toBeVisible();
        await returning.getByLabel('Your name').fill('Returning volunteer');
        await returning.getByRole('button', { name: 'Retry signup' }).press('Enter');
        await expect(returning.getByRole('heading', { name: 'Your shifts' })).toBeFocused();
        await expect(returning.getByRole('textbox', { name: 'Your recovery code' })).toHaveValue(/\S+/);

        await unsaved.reload();
        await unsaved.getByLabel('Your name').fill('Unsaved volunteer');
        await unsaved.getByRole('button', { name: 'Retry signup' }).click();
        await expect(unsaved.getByRole('alert')).toHaveText('Sign-ups are closed for this event.');
        await expect(unsaved.getByRole('button', { name: 'Retry signup' })).toHaveCount(0);
        expect(await (await unsaved.request.get(signupPath)).json()).toMatchObject({ signedIn: false });
        const saved = (await (await organizer.request.get(eventPath)).json() as EventDetail).volunteers;
        expect(saved.map(({ name }) => name)).toEqual([name, 'Returning volunteer']);
      } finally {
        await returning.close();
        await unsaved.close();
      }
    });
  } finally {
    await volunteer.close();
    await app.close();
  }
});

test('organizers can edit overlapping shifts and volunteers can save compatible current times only', async ({ browser, page: organizer }) => {
  const password = randomBytes(24).toString('base64url');
  const directory = await mkdtemp(join(tmpdir(), 'roster-ready-overlap-'));
  const databasePath = join(directory, 'roster.sqlite');
  const app = buildServer({ databasePath });
  const volunteer = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    await organizer.goto(url);
    await registerOrganizer(organizer, 'overlap-organizer', password);
    await organizer.getByLabel('Event name').fill('Shift overlap example');
    await organizer.getByLabel('Event date').fill('2026-12-05');
    await organizer.getByRole('button', { name: 'Create event' }).click();
    await expect(organizer.getByRole('heading', { name: 'Shift overlap example' })).toBeVisible();

    const example = [
      { name: 'Buy', start: '20:53', end: '22:53' },
      { name: 'Cook', start: '20:56', end: '21:57' },
      { name: 'Close', start: '22:53', end: '23:30' },
    ];
    for (const shift of example) {
      await organizer.getByLabel('Shift name').fill(shift.name);
      await organizer.getByLabel('Start time').fill(shift.start);
      await organizer.getByLabel('End time').fill(shift.end);
      await organizer.getByRole('button', { name: 'Add shift' }).click();
      await expect(organizer.getByRole('region', { name: 'Shifts' }).getByText(shift.name, { exact: true })).toBeVisible();
    }
    await expect(organizer.getByText('These shifts include overlapping times.', { exact: false })).toBeVisible();

    const link = await organizer.getByRole('textbox', { name: 'Shared event link' }).inputValue();
    const path = `${link.replace('/join/', '/api/join/')}/volunteer`;
    const page = await volunteer.newPage();
    await page.goto(link);
    await page.getByLabel('Your name').fill('Sample volunteer');
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await expect(page.getByText('If two shifts overlap, choose one of them.')).toBeVisible();
    const buy = page.getByRole('checkbox', { name: /^Buy/ });
    const cook = page.getByRole('checkbox', { name: /^Cook/ });
    const close = page.getByRole('checkbox', { name: /^Close/ });
    await buy.check();
    await expect(cook).toBeDisabled();
    await expect(cook).toHaveAccessibleDescription('Overlaps with Buy');
    await close.check();
    await page.getByRole('button', { name: 'Save availability' }).click();
    await expect(page.getByText('Availability saved.')).toBeVisible();

    const saved = await (await volunteer.request.get(path)).json() as InvitationDetail;
    const byName = new Map(saved.shifts.map((shift) => [shift.name, shift.id]));
    expect(saved.availableShiftIds).toEqual([byName.get('Buy'), byName.get('Close')]);
    const rejected = await volunteer.request.put(`${path}/availability`, {
      data: { volunteerId: saved.volunteer.id, revision: saved.availabilityRevision, shiftIds: [byName.get('Buy'), byName.get('Cook')] },
    });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).error).toBe('Buy and Cook overlap. Choose only one of them.');
    expect(await (await volunteer.request.get(path)).json()).toEqual(saved);

    // A response written before overlap validation may already contain both shifts.
    const previousDatabase = new DatabaseSync(databasePath);
    try {
      previousDatabase.prepare('INSERT INTO availability (event_id, volunteer_id, shift_id) VALUES (?, ?, ?)')
        .run(saved.event.id, saved.volunteer.id, byName.get('Cook')!);
    } finally {
      previousDatabase.close();
    }
    await page.reload();
    await expect(page.getByText('Uncheck Buy or Cook before saving.')).toBeVisible();
    await expect(buy).toBeChecked();
    await expect(cook).toBeChecked();
    await buy.uncheck();
    await page.getByRole('button', { name: 'Save availability' }).click();
    await expect(page.getByText('Availability saved.')).toBeVisible();
    const updated = await (await volunteer.request.get(path)).json() as InvitationDetail;
    expect(updated.availableShiftIds).toEqual([byName.get('Cook'), byName.get('Close')]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await organizer.setViewportSize({ width: 390, height: 844 });
    const editCook = organizer.getByRole('button', { name: /^Edit Cook,/ });
    await editCook.click();
    await expect(organizer.getByLabel('Shift name')).toBeFocused();
    await organizer.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
    await expect(editCook).toBeFocused();
    await editCook.click();
    await expect(organizer.getByLabel('Start time')).toHaveValue('20:56');
    await organizer.getByLabel('Shift name').fill('Prepare meal');
    await organizer.getByLabel('Volunteers needed').fill('2');
    await organizer.getByRole('button', { name: 'Save shift' }).click();
    const meal = organizer.getByRole('region', { name: 'Shifts' }).getByRole('listitem').filter({ hasText: 'Prepare meal' });
    await expect(meal).toContainText('2 needed');
    await expect(meal).toContainText('1 volunteer available');
    expect((await (await volunteer.request.get(path)).json()).availableShiftIds).toEqual(updated.availableShiftIds);

    await meal.getByRole('button', { name: /^Edit Prepare meal,/ }).click();
    await organizer.getByLabel('Start time').fill('21:06');
    const saveShift = organizer.getByRole('button', { name: 'Save shift' });
    await saveShift.click();
    const changeTime = organizer.getByRole('dialog', { name: 'Change the shift time?' });
    await changeTime.getByRole('button', { name: 'Cancel' }).click();
    await expect(meal).toContainText('20:56–21:57');
    await saveShift.click();
    await changeTime.getByRole('button', { name: 'Save new time' }).click();
    await expect(meal).toContainText('21:06–21:57');
    await expect(meal).toContainText('0 volunteers available');
    expect(await organizer.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    // This tab still has the previous time selected.
    await close.uncheck();
    await page.getByRole('button', { name: 'Save availability' }).click();
    await expect(page.getByRole('alert')).toHaveText('Shift options changed. Review the current times and save again.');
    const newMeal = page.getByRole('checkbox', { name: /Prepare meal 21:06/ });
    await expect(newMeal).not.toBeChecked();
    await expect(close).toBeChecked();
    await newMeal.check();
    await page.getByRole('button', { name: 'Save availability' }).click();
    await expect(page.getByText('Availability saved.')).toBeVisible();

    const eventPath = path.replace('/api/join/', '/api/events/').replace(/\/volunteer$/, '');
    const current = await (await volunteer.request.get(path)).json() as InvitationDetail;
    const newMealId = current.shifts.find(({ name }) => name === 'Prepare meal')?.id;
    expect(current.availableShiftIds).toEqual([newMealId, byName.get('Close')]);
    const editPath = `${eventPath}/shifts/${newMealId}`;
    const details = { name: 'Prepare meal', capacity: 2, startTime: '21:06', endTime: '21:57' };
    expect((await volunteer.request.put(editPath, { data: details })).status()).toBe(401);
    await organizer.getByRole('button', { name: 'Publish roster' }).click();
    await organizer.getByRole('dialog').getByRole('button', { name: 'Publish roster' }).click();
    await expect(organizer.getByText('Published', { exact: true })).toBeVisible();
    await expect(meal.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
    expect((await organizer.request.put(editPath, { data: { ...details, previous: details } })).status()).toBe(409);
  } finally {
    await volunteer.close();
    await app.close();
    await rm(directory, { recursive: true });
  }
});

test('the sample publishes both compatible shifts to a phone-sized volunteer session', async ({ browser, page: organizer }) => {
  const sample = JSON.parse(await readFile(new URL('../examples/sample-event.json', import.meta.url), 'utf8')) as {
    name: string;
    date: string;
    shifts: Omit<EventShift, 'id'>[];
    volunteer: { name: string; availableShifts: string[] };
    expected: { filled: number; total: number; vacancies: number };
  };
  const app = buildServer({ databasePath: ':memory:' });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    await organizer.goto(url);
    await registerOrganizer(organizer, 'sample-organizer', randomBytes(24).toString('base64url'));
    await organizer.getByLabel('Event name').fill(sample.name);
    await organizer.getByLabel('Event date').fill(sample.date);
    await organizer.getByRole('button', { name: 'Create event' }).click();
    await expect(organizer.getByRole('heading', { name: sample.name })).toBeVisible();
    for (const shift of sample.shifts) {
      await organizer.getByLabel('Shift name').fill(shift.name);
      await organizer.getByLabel('Start time').fill(shift.startTime);
      await organizer.getByLabel('End time').fill(shift.endTime);
      await organizer.getByLabel('Volunteers needed').fill(String(shift.capacity));
      await organizer.getByRole('button', { name: 'Add shift' }).click();
      await expect(organizer.getByRole('region', { name: 'Shifts' }).getByText(shift.name, { exact: true })).toBeVisible();
    }

    const link = await organizer.getByRole('textbox', { name: 'Shared event link' }).inputValue();
    const volunteer = await mobile.newPage();
    await volunteer.goto(link);
    await volunteer.getByLabel('Your name').fill(sample.volunteer.name);
    await volunteer.getByRole('button', { name: 'Sign up', exact: true }).click();
    for (const name of sample.volunteer.availableShifts) {
      await volunteer.getByRole('checkbox', { name: new RegExp(`^${name} `) }).check();
    }
    await expect(volunteer.getByRole('checkbox', { name: /^Setup / })).toBeDisabled();
    await volunteer.getByRole('button', { name: 'Save availability' }).click();
    await expect(volunteer.getByText('Availability saved.')).toBeVisible();
    await expect(volunteer.getByRole('heading', { name: 'Your shifts' })).toHaveCount(0);

    await organizer.getByRole('button', { name: 'Publish roster' }).click();
    await organizer.getByRole('dialog').getByRole('button', { name: 'Publish roster' }).click();
    const { filled, total, vacancies } = sample.expected;
    await expect(organizer.getByText(`${filled} of ${total} slots filled`)).toBeVisible();
    await expect(organizer.getByText(`${vacancies} vacancies`)).toBeVisible();
    await volunteer.reload();
    const schedule = volunteer.getByRole('region', { name: 'Your shifts' });
    await expect(schedule.getByRole('heading', { level: 3 })).toHaveText(sample.volunteer.availableShifts);
    expect(await volunteer.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  } finally {
    await mobile.close();
    await app.close();
  }
});

test('unowned local events stay out of organizer accounts', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'roster-ready-organizers-'));
  const databasePath = join(directory, 'legacy.sqlite');
  const password = randomBytes(24).toString('base64url');
  const seed = new DatabaseSync(databasePath);
  seed.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'collecting'
    ) STRICT;
    INSERT INTO events (id, name, date) VALUES ('legacy-event', 'Existing event', '2026-12-05');
  `);
  seed.close();
  const app = buildServer({ databasePath });

  try {
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    await page.goto(url);
    await registerOrganizer(page, 'event-owner', password);
    await expect(page.getByRole('heading', { name: 'Create your first event' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Existing events', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Import existing events' })).toHaveCount(0);
    expect((await page.request.get(`${url}/api/events/legacy-event`)).status()).toBe(404);
    expect(await (await page.request.get(`${url}/api/events`)).json()).toEqual({ events: [] });
    expect((await page.request.post(`${url}/api/organizer/import-events`, { data: {} })).status()).toBe(404);
    const stored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const existing = stored.prepare('SELECT organizer_id FROM events WHERE id = ?').get('legacy-event');
      expect(existing?.organizer_id).toBeNull();
      const organizer = stored.prepare('SELECT password_salt, password_hash FROM organizers').get();
      expect(organizer?.password_salt).toMatch(/^[0-9a-f]{32}$/);
      expect(organizer?.password_hash).toMatch(/^[0-9a-f]{128}$/);
      expect(organizer?.password_hash).not.toBe(password);
    } finally {
      stored.close();
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true });
  }
});
