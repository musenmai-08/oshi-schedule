import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { RuntimeKind } from '../env.js';

type SecretTarget =
  | 'DATABASE_URL'
  | 'SUPABASE_SERVICE_ROLE_KEY'
  | 'GOOGLE_CLIENT_SECRET'
  | 'YOUTUBE_API_KEY'
  | 'TOKEN_ENCRYPTION_KEYS';

const secretReferences: ReadonlyArray<{
  target: SecretTarget;
  reference: `${SecretTarget}_SECRET_ARN`;
  apiOnly?: boolean;
}> = [
  { target: 'DATABASE_URL', reference: 'DATABASE_URL_SECRET_ARN' },
  {
    target: 'SUPABASE_SERVICE_ROLE_KEY',
    reference: 'SUPABASE_SERVICE_ROLE_KEY_SECRET_ARN',
    apiOnly: true,
  },
  { target: 'GOOGLE_CLIENT_SECRET', reference: 'GOOGLE_CLIENT_SECRET_SECRET_ARN' },
  { target: 'YOUTUBE_API_KEY', reference: 'YOUTUBE_API_KEY_SECRET_ARN' },
  { target: 'TOKEN_ENCRYPTION_KEYS', reference: 'TOKEN_ENCRYPTION_KEYS_SECRET_ARN' },
];

export interface LambdaEnvironmentClients {
  getSecret(secretId: string): Promise<string>;
  getParameter(name: string): Promise<string>;
}

const defaultClients = (): LambdaEnvironmentClients => {
  const secrets = new SecretsManagerClient({});
  const parameters = new SSMClient({});
  return {
    async getSecret(secretId) {
      const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (!response.SecretString) throw new Error('Lambda secret value is missing');
      return response.SecretString;
    },
    async getParameter(name) {
      const response = await parameters.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
      );
      if (!response.Parameter?.Value) throw new Error('Lambda parameter value is missing');
      return response.Parameter.Value;
    },
  };
};

let loaded: Promise<void> | undefined;

export const loadLambdaRuntimeEnvironment = async (
  runtime: RuntimeKind,
  source: NodeJS.ProcessEnv = process.env,
  clients: LambdaEnvironmentClients = defaultClients(),
): Promise<void> => {
  const load = async () => {
    for (const { target, reference, apiOnly } of secretReferences) {
      if ((apiOnly && runtime !== 'api') || source[target]?.trim()) continue;
      const arn = source[reference]?.trim();
      if (!arn) throw new Error(`Missing Lambda secret reference: ${reference}`);
      source[target] = await clients.getSecret(arn);
    }

    if (runtime === 'api' && !source.ALLOWED_EMAILS?.trim()) {
      const name = source.ALLOWED_EMAILS_PARAMETER_NAME?.trim();
      if (!name) throw new Error('Missing Lambda parameter reference: ALLOWED_EMAILS_PARAMETER_NAME');
      source.ALLOWED_EMAILS = await clients.getParameter(name);
    }
  };

  if (source === process.env) {
    loaded ??= load();
    try {
      await loaded;
    } catch (error) {
      loaded = undefined;
      throw error;
    }
    return;
  }
  await load();
};

export const resetLambdaEnvironmentCacheForTest = () => {
  loaded = undefined;
};
