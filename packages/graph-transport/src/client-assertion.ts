/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import {base64Decode, base64UrlEncode, utf8Encode} from './base64.ts';
import type {CertificateCredential} from './credentials.ts';
import {GraphError} from './errors.ts';

/**
 * Builds the signed JWT that stands in for a client secret in the client-credentials grant
 * (OpenID Connect's private_key_jwt).
 *
 * Microsoft's current certificate-credentials reference specifies alg = PS256 (RSASSA-PSS,
 * SHA-256) with an x5t#S256 header, which WebCrypto signs natively — RSA-PSS with a 32-byte
 * salt — so the core stays portable to Workers. RS256 is retained as a config-only escape
 * hatch: Entra still accepts it and it is what most SDKs sent historically; it carries the
 * older SHA-1 x5t header, as the PHP sibling does.
 */
export const ASSERTION_LIFETIME_SECONDS = 300; // Microsoft's guidance is 5–10 minutes at most.

export async function buildClientAssertion(
    tenantId: string,
    clientId: string,
    certificate: CertificateCredential,
    nowSeconds: number
): Promise<string> {
    const algorithm = certificate.algorithm === 'RS256' ? 'RS256' : 'PS256';
    const der = certificateDer(certificate.certificatePem);

    const header = algorithm === 'PS256'
        ? {
            alg: 'PS256',
            typ: 'JWT',
            // x5t#S256 is the SHA-256 thumbprint Microsoft's current reference asks for; x5t is
            // the older SHA-1 form, kept alongside RS256 for the escape-hatch path.
            'x5t#S256': base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', der.buffer as ArrayBuffer)))
        }
        : {
            alg: 'RS256',
            typ: 'JWT',
            x5t: base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-1', der.buffer as ArrayBuffer)))
        };

    const claims = {
        // Hard-coded to the public login host, matching the rest of the family: the assertion
        // audience is part of what Entra validates, not a routing decision.
        aud: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        iss: clientId,
        sub: clientId,
        jti: crypto.randomUUID(),
        iat: nowSeconds,
        nbf: nowSeconds,
        exp: nowSeconds + ASSERTION_LIFETIME_SECONDS
    };

    const signingInput = `${base64UrlEncode(utf8Encode(JSON.stringify(header)))}.${base64UrlEncode(utf8Encode(JSON.stringify(claims)))}`;
    const key = await importPrivateKey(certificate.privateKeyPem, algorithm);

    let signature: ArrayBuffer;
    try {
        signature = algorithm === 'PS256'
            ? await crypto.subtle.sign({name: 'RSA-PSS', saltLength: 32}, key, utf8Encode(signingInput))
            : await crypto.subtle.sign({name: 'RSASSA-PKCS1-v1_5'}, key, utf8Encode(signingInput));
    } catch {
        throw new GraphError(`Missivus: ${algorithm} signing of the client assertion failed.`);
    }

    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

type ImportedKey = Parameters<typeof crypto.subtle.sign>[1];

async function importPrivateKey(pem: string, algorithm: 'PS256' | 'RS256'): Promise<ImportedKey> {
    const der = pemBlock(pem, 'PRIVATE KEY');
    if (der === null) {
        // PKCS#1 ("BEGIN RSA PRIVATE KEY") and encrypted keys cannot be imported by WebCrypto;
        // the Node helper converts them. Never echo key material in the message.
        throw new GraphError(
            'Missivus: the private key could not be loaded. The portable core needs an unencrypted'
            + ' PKCS#8 PEM ("BEGIN PRIVATE KEY"); use loadCertificate() from'
            + ' @missivus/graph-transport/node for encrypted or PKCS#1 keys.'
        );
    }
    const params = algorithm === 'PS256'
        ? {name: 'RSA-PSS', hash: 'SHA-256'}
        : {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'};
    try {
        return await crypto.subtle.importKey('pkcs8', der.buffer as ArrayBuffer, params, false, ['sign']);
    } catch {
        throw new GraphError(
            'Missivus: the private key could not be loaded. Check the file contains a PRIVATE KEY'
            + ' block and that the key is RSA — Microsoft Entra client assertions require RSA.'
        );
    }
}

function certificateDer(pem: string): Uint8Array {
    const der = pemBlock(pem, 'CERTIFICATE');
    if (der === null) {
        throw new GraphError(
            'Missivus: no certificate found. The PEM must contain the CERTIFICATE block as well as'
            + ' the private key.'
        );
    }
    return der;
}

function pemBlock(pem: string, label: string): Uint8Array | null {
    const m = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`).exec(pem);
    if (!m || m[1] === undefined) {
        return null;
    }
    try {
        return base64Decode(m[1].replace(/\s+/g, ''));
    } catch {
        return null;
    }
}
