/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import {GraphError} from './errors.ts';

/**
 * Both base URLs are overridable, because sovereign clouds and the test suite need them to be.
 * That override is also the one knob that can point a client secret or a bearer token at a host
 * we never meant to talk to, so every base URL is normalised here, once, and anything that is not
 * a bare https origin is refused loudly instead of quietly used.
 *
 * Refused loudly, but never verbatim. The rejected value is the operator's own configuration, and
 * a misconfiguration is exactly the case where it might hold a credential —
 * `https://user:pass@host`, `https://host?access_token=…`. So no message built here ever contains
 * the userinfo, the query string or the fragment: an error names the scheme, host, port and path,
 * and nothing else, or it names only the reason it was refused.
 */
export function normaliseEndpoint(url: string, setting: string): string {
    const trimmed = url.trim().replace(/\/+$/, '');

    if (trimmed === '') {
        throw refusal(setting, 'must not be empty');
    }

    const parts = parseUrl(trimmed);
    if (parts === null || parts.scheme === '' || parts.host === '') {
        throw refusal(setting, 'is not a valid endpoint URL: expected scheme://host');
    }
    // Host charset check before anything is echoed.
    if (!/^[A-Za-z0-9.-]+$/.test(parts.host)) {
        throw refusal(setting, 'has an invalid host name');
    }

    const safe = describe(parts);

    if (parts.scheme.toLowerCase() !== 'https') {
        throw refusal(setting, `must be an https:// URL. Refusing to send credentials to ${safe}`);
    }
    if (parts.userinfo !== '') {
        throw refusal(setting, `must not carry a username or password in the URL: ${safe}`);
    }
    if (parts.query !== '' || parts.fragment !== '') {
        throw refusal(setting, `must be a bare https origin, with no query string or fragment: ${safe}`);
    }

    return safe;
}

function refusal(setting: string, reason: string): GraphError {
    return new GraphError(`Missivus: ${setting} ${reason}`);
}

interface UrlParts {
    scheme: string;
    userinfo: string;
    host: string;
    port: string;
    path: string;
    query: string;
    fragment: string;
}

function parseUrl(url: string): UrlParts | null {
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:([^@/?#]*)@)?([^:/?#]*)(?::(\d+))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(url);
    if (!m) {
        return null;
    }
    return {
        scheme: m[1] ?? '',
        userinfo: m[2] ?? '',
        host: m[3] ?? '',
        port: m[4] ?? '',
        path: m[5] ?? '',
        query: m[6] ?? '',
        fragment: m[7] ?? ''
    };
}

/** The single chokepoint every message is built from: scheme, host, port and path — only. */
function describe(parts: UrlParts): string {
    const port = parts.port !== '' ? `:${String(parseInt(parts.port, 10))}` : '';
    const path = parts.path.replace(/\/+$/, '');
    return `${parts.scheme.toLowerCase()}://${parts.host}${port}${path}`;
}
