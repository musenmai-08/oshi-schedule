/**
 * SHA-256 fingerprints of public staging identifiers that must never be reused by production.
 *
 * These values are not credentials. Keeping only fingerprints lets synth reject accidental
 * cross-environment reuse without embedding the browser-visible identifiers themselves here.
 * Update the relevant fingerprint whenever an approved staging public identifier rotates.
 */
export const stagingPublicIdentifierFingerprints = Object.freeze({
  webDomainName: 'sha256:7517969b0edc9fba31a387fe3a2222d525e6a6a46bbc5505d717e29cfcf00975',
  apiDomainName: 'sha256:a5d4c569f7ec9fa61ef8e1d38fc1badaf52ccad22f4c2cdd0f646271fa2b56f6',
  certificateArn: 'sha256:f27e545aa7f014a1093cccbecdca8ae1b710f58a7a07dc62765bb86bdcac94b6',
  nextPublicSupabaseUrl: 'sha256:b92378290739ff2dbf130dd2c990a07fab16da0c1d3c497adf4aeb46edce5f59',
  nextPublicSupabasePublishableKey:
    'sha256:579840eefccc02f4ae2b140f1c3320ada02294e17ac6c2dcc029d2dc7d39e4b5',
  googleClientId: 'sha256:f2e7eeef4494e93037dc3eaa3f44085959ba652a25522b2d015f2051b39915eb',
});

export type StagingPublicIdentifierFingerprints = typeof stagingPublicIdentifierFingerprints;
