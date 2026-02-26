import { createHash, createSign } from 'crypto';

/**
 * Minimal OCI REST API signing config.
 * Ref: https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm
 */
export interface OciSigningConfig {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  /** PEM private key — newlines may be encoded as literal \n in env vars */
  privateKey: string;
  region: string;
}

/**
 * Builds the signed HTTP headers required by all OCI REST API calls.
 *
 * For GET/DELETE: signs (date, host, request-target).
 * For POST/PUT:  additionally signs (content-length, content-type, x-content-sha256).
 */
export function buildOciSignedHeaders(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  host: string,
  path: string,
  body: string | null,
  config: OciSigningConfig,
): Record<string, string> {
  const date = new Date().toUTCString();
  const isWrite = ['POST', 'PUT'].includes(method);

  const bodyStr = body ?? '';
  const bodyHash = createHash('sha256').update(bodyStr, 'utf8').digest('base64');
  const contentLength = Buffer.byteLength(bodyStr, 'utf8').toString();

  const baseHeaders: string[] = ['date', 'host', '(request-target)'];
  const writeHeaders: string[] = ['content-length', 'content-type', 'x-content-sha256'];
  const signingHeaders = isWrite ? [...baseHeaders, ...writeHeaders] : baseHeaders;

  const headerValues: Record<string, string> = {
    date,
    host,
    '(request-target)': `${method.toLowerCase()} ${path}`,
    'content-length': contentLength,
    'content-type': 'application/json',
    'x-content-sha256': bodyHash,
  };

  const signingString = signingHeaders
    .map((h) => `${h}: ${headerValues[h]}`)
    .join('\n');

  const pem = config.privateKey.replace(/\\n/g, '\n');
  const signer = createSign('RSA-SHA256');
  signer.update(signingString);
  const signature = signer.sign(pem, 'base64');

  const keyId = `${config.tenancyOcid}/${config.userOcid}/${config.fingerprint}`;
  const authHeader = [
    `Signature version="1"`,
    `headers="${signingHeaders.join(' ')}"`,
    `keyId="${keyId}"`,
    `algorithm="rsa-sha256"`,
    `signature="${signature}"`,
  ].join(',');

  const result: Record<string, string> = {
    Authorization: authHeader,
    Date: date,
    Host: host,
  };

  if (isWrite) {
    result['Content-Type'] = 'application/json';
    result['Content-Length'] = contentLength;
    result['x-content-sha256'] = bodyHash;
  }

  return result;
}

/** Load base OCI auth config from standard env vars */
export function loadOciSigningConfig(): OciSigningConfig {
  return {
    tenancyOcid: process.env.OCI_TENANCY_OCID ?? '',
    userOcid: process.env.OCI_USER_OCID ?? '',
    fingerprint: process.env.OCI_FINGERPRINT ?? '',
    privateKey: process.env.OCI_PRIVATE_KEY ?? '',
    region: process.env.OCI_REGION ?? '',
  };
}

/** True when all mandatory OCI auth env vars are set */
export function isOciConfigured(): boolean {
  return !!(
    process.env.OCI_TENANCY_OCID &&
    process.env.OCI_USER_OCID &&
    process.env.OCI_FINGERPRINT &&
    process.env.OCI_PRIVATE_KEY &&
    process.env.OCI_REGION
  );
}
