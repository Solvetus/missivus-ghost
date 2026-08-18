/**
 * Missivus — send email through the Microsoft Graph API with application permissions and a
 * shared mailbox. No SMTP, no user login. Free, GPLv3.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import type {FetchLike, Logger, TokenCache} from './contracts.ts';
import {MemoryTokenCache} from './contracts.ts';
import type {AssertionAlgorithm, CertificateCredential} from './credentials.ts';
import {Credentials} from './credentials.ts';
import type {GraphMailerOptions} from './graph-mailer.ts';
import {GraphMailer} from './graph-mailer.ts';
import {Redactor} from './redactor.ts';
import {TokenProvider} from './token-provider.ts';

export {base64Encode, base64UrlEncode, base64Decode} from './base64.ts';
export {Redactor} from './redactor.ts';
export {GraphError} from './errors.ts';
export {normaliseEndpoint} from './endpoint.ts';
export {Credentials} from './credentials.ts';
export type {CertificateCredential, AssertionAlgorithm} from './credentials.ts';
export {buildClientAssertion, ASSERTION_LIFETIME_SECONDS} from './client-assertion.ts';
export {TokenProvider, SCOPE, EXPIRY_MARGIN_SECONDS, CACHE_PREFIX} from './token-provider.ts';
export {Message, Attachment} from './message.ts';
export type {Address, AttachmentInput, MessageInput} from './message.ts';
export {
    GraphMailer,
    LARGE_ATTACHMENT_THRESHOLD,
    TOTAL_INLINE_BUDGET,
    UPLOAD_CHUNK_BYTES,
    API_VERSION
} from './graph-mailer.ts';
export type {GraphMailerOptions} from './graph-mailer.ts';
export {forceFrom} from './mime.ts';
export type {ForcedFromResult} from './mime.ts';
export {MemoryTokenCache, nullLogger} from './contracts.ts';
export type {FetchLike, TokenCache, Logger} from './contracts.ts';

export interface GraphTransportOptions {
    tenantId: string;
    clientId: string;
    /** Client-secret auth (the default method). */
    clientSecret?: string;
    /** Certificate auth; wins over the secret when provided. */
    certificate?: CertificateCredential;
    certificateAlgorithm?: AssertionAlgorithm;
    /** The shared mailbox every message is sent as. */
    sender: string;
    /** Graph's default is true; the family default is false. */
    saveToSentItems?: boolean;
    graphBaseUrl?: string;
    loginBaseUrl?: string;
    /** Injectable for tests and platforms with their own fetch. Defaults to globalThis.fetch. */
    fetch?: FetchLike;
    /** Injectable token cache; in-memory by default. */
    tokenCache?: TokenCache;
    logger?: Logger;
    /** Injectable clock (milliseconds), for tests. */
    now?: () => number;
}

/** The one-call construction path: flat options in, a ready GraphMailer out. */
export function createGraphTransport(options: GraphTransportOptions): GraphMailer {
    let credentials = new Credentials(options.tenantId, options.clientId);
    if (options.certificate) {
        const algorithm = options.certificate.algorithm ?? options.certificateAlgorithm;
        credentials = credentials.withCertificate(
            algorithm !== undefined ? {...options.certificate, algorithm} : options.certificate
        );
    } else {
        credentials = credentials.withClientSecret(options.clientSecret ?? '');
    }

    const redactor = new Redactor(credentials.secretLiterals());
    const fetchFn: FetchLike = options.fetch
        ?? (globalThis.fetch.bind(globalThis));
    const now = options.now ?? (() => Date.now());
    const tokens = new TokenProvider(
        credentials,
        fetchFn,
        options.tokenCache ?? new MemoryTokenCache(now),
        redactor,
        options.loginBaseUrl ?? 'https://login.microsoftonline.com',
        now
    );

    const mailerOptions: GraphMailerOptions = {sender: options.sender, redactor};
    if (options.saveToSentItems !== undefined) {
        mailerOptions.saveToSentItems = options.saveToSentItems;
    }
    if (options.graphBaseUrl !== undefined) {
        mailerOptions.graphBaseUrl = options.graphBaseUrl;
    }
    if (options.logger !== undefined) {
        mailerOptions.logger = options.logger;
    }
    return new GraphMailer(tokens, fetchFn, mailerOptions);
}
