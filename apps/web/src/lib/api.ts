import type {
  ApiFailure,
  ApiSuccess,
  ChannelRegistrationResult,
  ChannelSummary,
  MeView,
  SubscriptionView,
} from '@oshi-schedule/shared';
import { publicEnv } from './env';

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function sessionToken() {
  if (publicEnv.demoMode) return 'demo-token';
  const { createSupabaseBrowserClient } = await import('./supabase/client');
  const { data } = await createSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await sessionToken();
  const response = await fetch(`${publicEnv.apiUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json()) as ApiFailure;
    throw new ApiClientError(body.error.code, body.error.message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return ((await response.json()) as ApiSuccess<T>).data;
}
export const apiClient = {
  me: () => api<MeView>('/api/v1/me'),
  channels: () => api<SubscriptionView[]>('/api/v1/channels'),
  resolve: (handle: string) =>
    api<ChannelSummary>('/api/v1/channels/resolve', {
      method: 'POST',
      body: JSON.stringify({ handle }),
    }),
  register: (youtubeChannelId: string) =>
    api<ChannelRegistrationResult>('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({ youtubeChannelId }),
    }),
  status: (id: string, status: 'ACTIVE' | 'PAUSED') =>
    api(`/api/v1/channels/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  remove: (id: string) => api<void>(`/api/v1/channels/${id}`, { method: 'DELETE' }),
  sync: (id: string) => api(`/api/v1/channels/${id}/sync`, { method: 'POST' }),
  deleteAccount: () =>
    api<void>('/api/v1/account', {
      method: 'DELETE',
      body: JSON.stringify({ confirmation: 'DELETE' }),
    }),
};
