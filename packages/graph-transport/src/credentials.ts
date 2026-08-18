/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import {GraphError} from './errors.ts';

export type AssertionAlgorithm = 'PS256' | 'RS256';

export interface CertificateCredential {
    /** The private key, unencrypted, PKCS#8 or PKCS#1 PEM. Use `loadCertificate` from
     *  `@missivus/graph-transport/node` to turn a file path + passphrase into this shape. */
    privateKeyPem: string;
    /** The certificate whose thumbprint was uploaded to Entra, PEM. */
    certificatePem: string;
    /** PS256 is what Microsoft's current reference specifies; RS256 is the escape hatch. */
    algorithm?: AssertionAlgorithm;
}

/**
 * Tenant, client and one credential — either a secret or a certificate. Immutable; the `with*`
 * methods return copies. `toString`, `toJSON` and the Node inspect hook are all overridden so a
 * stray `console.log`, `JSON.stringify` or error dump cannot spill the secret — in JS,
 * `JSON.stringify` of a config object is the commonest accidental leak.
 */
export class Credentials {
    readonly tenantId: string;
    readonly clientId: string;
    readonly method: 'secret' | 'certificate';
    readonly clientSecret: string;
    readonly certificate: CertificateCredential | undefined;

    constructor(tenantId: string, clientId: string) {
        this.tenantId = tenantId.trim();
        this.clientId = clientId.trim();
        this.method = 'secret';
        this.clientSecret = '';
        this.certificate = undefined;
    }

    withClientSecret(secret: string): Credentials {
        const copy = Object.create(Credentials.prototype) as {-readonly [K in keyof Credentials]: Credentials[K]};
        Object.assign(copy, this, {method: 'secret', clientSecret: secret, certificate: undefined});
        return copy as Credentials;
    }

    withCertificate(certificate: CertificateCredential): Credentials {
        const copy = Object.create(Credentials.prototype) as {-readonly [K in keyof Credentials]: Credentials[K]};
        Object.assign(copy, this, {
            method: 'certificate',
            clientSecret: '',
            certificate: {
                privateKeyPem: certificate.privateKeyPem,
                certificatePem: certificate.certificatePem,
                // Coerced, never trusted: anything that is not exactly RS256 signs as PS256.
                algorithm: certificate.algorithm === 'RS256' ? 'RS256' as const : 'PS256' as const
            }
        });
        return copy as Credentials;
    }

    /** Collects every missing piece and throws once, so the operator fixes one error, not four. */
    validate(): void {
        const missing: string[] = [];
        if (this.tenantId === '') {
            missing.push('tenant ID');
        }
        if (this.clientId === '') {
            missing.push('client ID');
        }
        if (this.method === 'certificate') {
            if (!this.certificate || this.certificate.privateKeyPem === '') {
                missing.push('certificate private key');
            }
            if (!this.certificate || this.certificate.certificatePem === '') {
                missing.push('certificate');
            }
        } else if (this.clientSecret === '') {
            missing.push('client secret');
        }
        if (missing.length > 0) {
            throw new GraphError(`Missivus is not configured: missing ${missing.join(', ')}`);
        }
    }

    /** What the Redactor blanks by literal. The key PEM is caught by shape if it ever leaks. */
    secretLiterals(): string[] {
        return [this.clientSecret, this.certificate?.privateKeyPem ?? ''].filter(v => v !== '');
    }

    /** Non-secret discriminator for the token cache key. */
    cacheDiscriminator(): string {
        return `${this.tenantId}|${this.clientId}|${this.method}`;
    }

    toString(): string {
        return `Missivus/Credentials(tenant=${this.tenantId}, client=${this.clientId}, method=${this.method}, credential=redacted)`;
    }

    toJSON(): Record<string, string> {
        return {
            tenantId: this.tenantId,
            clientId: this.clientId,
            method: this.method,
            credential: this.hasCredential() ? '(set, redacted)' : '(unset)'
        };
    }

    /** Node's util.inspect hook — covers console.log(credentials). */
    [Symbol.for('nodejs.util.inspect.custom')](): string {
        return this.toString();
    }

    private hasCredential(): boolean {
        return this.method === 'certificate' ? this.certificate !== undefined : this.clientSecret !== '';
    }
}
