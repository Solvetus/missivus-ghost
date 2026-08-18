/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * Node-only helpers, kept out of the portable core: WebCrypto cannot import an encrypted or
 * PKCS#1 private key, so the file-plus-passphrase shape the install guide produces is converted
 * here with node:crypto and handed to the core as clean PEM strings.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import {createPrivateKey} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {CertificateCredential} from './credentials.ts';
import {GraphError} from './errors.ts';

/**
 * Read a PEM file containing both the private key and the certificate (as the install guide
 * builds with `cat missivus.key missivus.crt > missivus.pem`), decrypt the key when a passphrase
 * is given, and return the shape the portable core imports. Error messages name the path only,
 * never file contents and never the passphrase.
 */
export function loadCertificate(path: string, passphrase = ''): CertificateCredential {
    let pem: string;
    try {
        pem = readFileSync(path, 'utf8');
    } catch {
        throw new GraphError(`Missivus: certificate file is not readable at ${path}`);
    }

    if (!/-----BEGIN CERTIFICATE-----/.test(pem)) {
        throw new GraphError(
            `Missivus: no certificate found in ${path}. The file must contain the CERTIFICATE`
            + ' block as well as the private key.'
        );
    }
    const certificatePem = extractCertificate(pem, path);

    let privateKeyPem: string;
    try {
        // Never echo the underlying error: with a wrong passphrase it can quote input.
        const key = passphrase !== ''
            ? createPrivateKey({key: pem, passphrase})
            : createPrivateKey({key: pem});
        if (key.asymmetricKeyType !== 'rsa') {
            throw new GraphError(
                `Missivus: the key at ${path} is not an RSA key. Microsoft Entra client assertions require RSA.`
            );
        }
        privateKeyPem = key.export({type: 'pkcs8', format: 'pem'}).toString();
    } catch (err) {
        if (err instanceof GraphError) {
            throw err;
        }
        throw new GraphError(
            `Missivus: the private key at ${path} could not be loaded. Check the file contains a`
            + ' PRIVATE KEY block and that the passphrase is correct.'
        );
    }

    return {privateKeyPem, certificatePem};
}

function extractCertificate(pem: string, path: string): string {
    const m = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/.exec(pem);
    if (!m) {
        throw new GraphError(`Missivus: the certificate in ${path} could not be re-encoded.`);
    }
    return m[0];
}
