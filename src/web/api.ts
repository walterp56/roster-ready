import type { EventSummary } from '../event.ts';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error ?? 'The request could not be completed.', response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

export function eventDate(date: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(date));
}

export const statusLabel: Record<EventSummary['status'], string> = {
  collecting: 'Unpublished',
  published: 'Published',
};
