import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { IncrementResponse, Options, Store } from 'express-rate-limit';

interface RateLimitDocumentClient {
  send(command: UpdateCommand | DeleteCommand): Promise<unknown>;
}

export class DynamoDbRateLimitStore implements Store {
  readonly localKeys = false;
  readonly prefix = 'api:';
  private windowMs = 15 * 60_000;

  constructor(
    private readonly tableName: string,
    private readonly client: RateLimitDocumentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({}),
    ),
  ) {}

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  private window(key: string, now = Date.now()) {
    const number = Math.floor(now / this.windowMs);
    return {
      id: `${this.prefix}${number}:${key}`,
      resetTime: new Date((number + 1) * this.windowMs),
    };
  }

  async increment(key: string): Promise<IncrementResponse> {
    const { id, resetTime } = this.window(key);
    const response = (await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id },
        UpdateExpression:
          'ADD #totalHits :one SET #expiresAt = if_not_exists(#expiresAt, :expiresAt)',
        ExpressionAttributeNames: { '#totalHits': 'totalHits', '#expiresAt': 'expiresAt' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':expiresAt': Math.ceil(resetTime.getTime() / 1_000) + 60,
        },
        ReturnValues: 'ALL_NEW',
      }),
    )) as { Attributes?: { totalHits?: number } };
    return { totalHits: response.Attributes?.totalHits ?? 1, resetTime };
  }

  async decrement(key: string) {
    const { id } = this.window(key);
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id },
        UpdateExpression: 'ADD #totalHits :minusOne',
        ConditionExpression: '#totalHits > :zero',
        ExpressionAttributeNames: { '#totalHits': 'totalHits' },
        ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 },
      }),
    );
  }

  async resetKey(key: string) {
    await this.client.send(
      new DeleteCommand({ TableName: this.tableName, Key: { id: this.window(key).id } }),
    );
  }
}
