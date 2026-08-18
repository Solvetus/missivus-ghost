/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import {buildClientAssertion} from './client-assertion.ts';
import type {FetchLike, TokenCache} from './contracts.ts';
import type {Credentials} from './credentials.ts';
import {normaliseEndpoint} from './endpoint.ts';
import {GraphError} from './errors.ts';
import type {Redactor} from './redactor.ts';

/**
 * OAuth2 client-credentials tokens, cached and refreshed.
 *
 * There is no refresh token in this grant — expiry simply means asking again. The cache TTL is
 * set five minutes short of the real expiry so a token is never presented to Graph in its last
 * moments, the same margin the PHP sibling uses.
 */
export const SCOPE = 'https://graph.microsoft.com/.default';

/** Renew this many seconds before Microsoft's stated expiry. */
export const EXPIRY_MARGIN_SECONDS = 300;

export const CACHE_PREFIX = 'missivus.token.';

export class TokenProvider {
    private readonly credentials: Credentials;
    private readonly fetchFn: FetchLike;
    private readonly cache: TokenCache;
    private readonly redactor: Redactor;
    private readonly loginBaseUrl: string;
    private readonly now: () => number;

    constructor(
        credentials: Credentials,
        fetchFn: FetchLike,
        cache: TokenCache,
        redactor: Redactor,
        loginBaseUrl = 'https://login.microsoftonline.com',
        now: () => number = () => Date.now()
    ) {
        this.credentials = credentials;
        this.fetchFn = fetchFn;
        this.cache = cache;
        this.redactor = redactor;
        // A client secret goes to this host. It is refused unless it is a bare https origin.
        this.loginBaseUrl = normaliseEndpoint(loginBaseUrl, 'login_base_url');
        this.now = now;
    }

    async getToken(): Promise<string> {
        this.credentials.validate();

        const key = this.cacheKey();
        const cached = await this.cache.get(key);
        if (cached !== undefined && cached !== '') {
            return cached;
        }

        const url = `${this.loginBaseUrl}/${encodeURIComponent(this.credentials.tenantId)}/oauth2/v2.0/token`;
        const parameters = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.credentials.clientId,
            scope: SCOPE
        });
        if (this.credentials.method === 'certificate' && this.credentials.certificate) {
            parameters.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
            parameters.set('client_assertion', await buildClientAssertion(
                this.credentials.tenantId,
                this.credentials.clientId,
                this.credentials.certificate,
                Math.floor(this.now() / 1000)
            ));
        } else {
            parameters.set('client_secret', this.credentials.clientSecret);
        }

        let response;
        try {
            response = await this.fetchFn(url, {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: parameters.toString()
            });
        } catch (err) {
            throw new GraphError(
                `Missivus: could not reach the Microsoft token endpoint: ${this.redactor.redact(errorText(err))}`
            );
        }

        const body = await response.text();
        if (response.status < 200 || response.status >= 300) {
            // The Entra error body is the single most useful thing for diagnosing a broken app
            // registration, so it is kept — after redaction.
            throw new GraphError(
                'Missivus: Microsoft rejected the token request',
                response.status,
                this.redactor.redactBody(body)
            );
        }

        const payload = parseJson(body);
        const token = typeof payload['access_token'] === 'string' ? payload['access_token'] : '';
        if (token === '') {
            throw new GraphError('Missivus: the token response contained no access_token', response.status);
        }

        const expiresIn = typeof payload['expires_in'] === 'number'
            ? payload['expires_in']
            : parseInt(String(payload['expires_in'] ?? '3600'), 10) || 3600;
        const ttl = expiresIn - EXPIRY_MARGIN_SECONDS;
        // A token shorter-lived than the margin is not worth caching, but it is still usable now.
        if (ttl > 0) {
            await this.cache.set(key, token, ttl);
        }
        return token;
    }

    /** Called after a 401: a token can be revoked mid-life. */
    async invalidate(): Promise<void> {
        await this.cache.delete(this.cacheKey());
    }

    private cacheKey(): string {
        return CACHE_PREFIX + this.credentials.cacheDiscriminator();
    }
}

function parseJson(body: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(body);
        return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
