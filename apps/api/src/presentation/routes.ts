import { Router, type Router as ExpressRouter } from 'express';
import type { z } from 'zod';
import {
  createChannelSchema,
  deleteAccountSchema,
  onboardingSchema,
  reconnectSchema,
  resolveChannelSchema,
  updateSubscriptionSchema,
  entityIdSchema,
} from '@oshi-schedule/shared';
import type { Container } from '../container.js';
import { AppError } from '../domain/errors.js';
import { asyncRoute, success } from './http.js';

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', '入力内容を確認してください', 400);
  return result.data;
};

export function createApiRouter(container: Container): ExpressRouter {
  const router = Router();
  router.get(
    '/me',
    asyncRoute(async (_request, response) => {
      const user = await container.service.me(response.locals.identity);
      success(response, {
        id: user.id,
        email: user.email,
        onboardingCompleted: user.onboardingCompleted,
        reauthRequired: user.reauthRequired,
        calendarStatus: user.calendarId ? 'ACTIVE' : 'NOT_CONNECTED',
      });
    }),
  );
  router.post(
    '/onboarding',
    asyncRoute(async (request, response) => {
      const body = parse(onboardingSchema, request.body);
      const user = await container.service.onboard(
        response.locals.identity,
        body.providerRefreshToken,
      );
      success(response, {
        onboardingCompleted: user.onboardingCompleted,
        calendarStatus: user.calendarId ? 'ACTIVE' : 'NOT_CONNECTED',
      });
    }),
  );
  router.get(
    '/channels',
    asyncRoute(async (_request, response) => {
      const rows = await container.service.list(response.locals.identity);
      success(
        response,
        rows.map(({ subscription, channel }) => ({
          subscriptionId: subscription.id,
          status: subscription.status,
          ...channel,
          lastFetchedAt: channel.lastFetchedAt?.toISOString() ?? null,
          lastCalendarSyncAt: subscription.lastCalendarSyncAt?.toISOString() ?? null,
          lastSyncStatus: subscription.lastSyncStatus,
          lastErrorMessage: subscription.lastErrorMessage,
        })),
      );
    }),
  );
  router.post(
    '/channels/resolve',
    asyncRoute(async (request, response) => {
      success(
        response,
        await container.service.resolve(
          response.locals.identity,
          parse(resolveChannelSchema, request.body).handle,
        ),
      );
    }),
  );
  router.post(
    '/channels',
    asyncRoute(async (request, response) => {
      success(
        response,
        await container.service.registerAndSync(
          response.locals.identity,
          parse(createChannelSchema, request.body).youtubeChannelId,
        ),
        201,
      );
    }),
  );
  router.patch(
    '/channels/:subscriptionId',
    asyncRoute(async (request, response) => {
      const id = parse(entityIdSchema, request.params.subscriptionId);
      success(
        response,
        await container.service.setStatus(
          response.locals.identity,
          id,
          parse(updateSubscriptionSchema, request.body).status,
        ),
      );
    }),
  );
  router.delete(
    '/channels/:subscriptionId',
    asyncRoute(async (request, response) => {
      const id = parse(entityIdSchema, request.params.subscriptionId);
      await container.service.remove(response.locals.identity, id);
      response.status(204).end();
    }),
  );
  router.post(
    '/channels/:subscriptionId/sync',
    asyncRoute(async (request, response) => {
      const user = await container.service.me(response.locals.identity);
      const result = await container.service.sync.syncSubscription(
        user.id,
        parse(entityIdSchema, request.params.subscriptionId),
      );
      success(response, result, 202);
    }),
  );
  router.get(
    '/sync-status',
    asyncRoute(async (_request, response) => {
      const rows = await container.service.list(response.locals.identity);
      success(
        response,
        rows.map(({ subscription }) => ({
          subscriptionId: subscription.id,
          status: subscription.lastSyncStatus,
          syncedAt: subscription.lastCalendarSyncAt?.toISOString() ?? null,
          message: subscription.lastErrorMessage,
        })),
      );
    }),
  );
  router.post(
    '/google/reconnect',
    asyncRoute(async (request, response) => {
      const body = parse(reconnectSchema, request.body);
      const user = await container.service.reconnect(
        response.locals.identity,
        body.providerRefreshToken,
      );
      success(response, { reauthRequired: user.reauthRequired });
    }),
  );
  router.delete(
    '/account',
    asyncRoute(async (request, response) => {
      parse(deleteAccountSchema, request.body);
      await container.service.deleteAccount(response.locals.identity);
      response.status(204).end();
    }),
  );
  return router;
}
