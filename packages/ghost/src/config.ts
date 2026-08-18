/**
 * Missivus for Ghost — send Ghost transactional email through the Microsoft Graph API.
 *
 * Configuration riding Ghost's own `mail.options`: the shim reads the same keys Ghost's config
 * carries, from (highest precedence first) MISSIVUS_* env vars, Ghost's Docker-style
 * `mail__options__*` env vars, or a Ghost config.*.json file. Secrets are never logged; every
 * string leaving the shim passes the transport's Redactor.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import {readFileSync} from 'node:fs';

export interface FallbackConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
}

export interface ShimConfig {
    listenHost: string;
    listenPort: number;
    tenantId: string;
    clientId: string;
    clientSecret: string;
    certificatePath: string;
    certificatePassphrase: string;
    certificateAlgorithm: 'PS256' | 'RS256';
    sender: string;
    saveToSentItems: boolean;
    graphBaseUrl: string;
    loginBaseUrl: string;
    /** Off by default: an empty host means fail loudly, never pass through. */
    fallback: FallbackConfig;
}

type Env = Record<string, string | undefined>;

interface GhostMailOptions {
    [key: string]: unknown;
    certificate?: {path?: unknown; passphrase?: unknown};
    fallback?: {[key: string]: unknown};
}

export function resolveConfig(env: Env, ghostConfigPath?: string): ShimConfig {
    const fileOptions = ghostConfigPath !== undefined ? readGhostMailOptions(ghostConfigPath) : {};

    const str = (missivusKey: string, ghostKey: string, fallback = ''): string => {
        const fromEnv = env[missivusKey] ?? env[`mail__options__${ghostKey}`];
        if (fromEnv !== undefined && fromEnv !== '') {
            return fromEnv;
        }
        const fromFile = lookup(fileOptions, ghostKey);
        return typeof fromFile === 'string' && fromFile !== '' ? fromFile : fallback;
    };
    const bool = (missivusKey: string, ghostKey: string): boolean => {
        const raw = str(missivusKey, ghostKey);
        return raw === 'true' || raw === '1' || (lookup(fileOptions, ghostKey) === true && raw === '');
    };
    const num = (missivusKey: string, ghostKey: string, fallback: number): number => {
        const fromEnv = env[missivusKey] ?? env[`mail__options__${ghostKey}`];
        if (fromEnv !== undefined && fromEnv !== '') {
            const parsed = parseInt(fromEnv, 10);
            return Number.isNaN(parsed) ? fallback : parsed;
        }
        const fromFile = lookup(fileOptions, ghostKey);
        if (typeof fromFile === 'number') {
            return fromFile;
        }
        if (typeof fromFile === 'string' && fromFile !== '') {
            const parsed = parseInt(fromFile, 10);
            return Number.isNaN(parsed) ? fallback : parsed;
        }
        return fallback;
    };

    const algorithm = (env['MISSIVUS_CERTIFICATE_ALGORITHM'] ?? '') === 'RS256' ? 'RS256' : 'PS256';

    return {
        listenHost: env['MISSIVUS_LISTEN_HOST'] ?? '127.0.0.1',
        listenPort: parseInt(env['MISSIVUS_LISTEN_PORT'] ?? '2525', 10) || 2525,
        tenantId: str('MISSIVUS_TENANT_ID', 'tenantId'),
        clientId: str('MISSIVUS_CLIENT_ID', 'clientId'),
        clientSecret: str('MISSIVUS_CLIENT_SECRET', 'clientSecret'),
        certificatePath: str('MISSIVUS_CERTIFICATE_PATH', 'certificate__path'),
        certificatePassphrase: str('MISSIVUS_CERTIFICATE_PASSPHRASE', 'certificate__passphrase'),
        certificateAlgorithm: algorithm,
        sender: str('MISSIVUS_SENDER_MAILBOX', 'sender'),
        saveToSentItems: bool('MISSIVUS_SAVE_TO_SENT_ITEMS', 'saveToSentItems'),
        graphBaseUrl: env['MISSIVUS_GRAPH_BASE_URL'] ?? 'https://graph.microsoft.com',
        loginBaseUrl: env['MISSIVUS_LOGIN_BASE_URL'] ?? 'https://login.microsoftonline.com',
        fallback: {
            host: str('MISSIVUS_FALLBACK_HOST', 'fallback__host'),
            port: num('MISSIVUS_FALLBACK_PORT', 'fallback__port', 587),
            secure: bool('MISSIVUS_FALLBACK_SECURE', 'fallback__secure'),
            user: str('MISSIVUS_FALLBACK_USER', 'fallback__user'),
            pass: str('MISSIVUS_FALLBACK_PASS', 'fallback__pass')
        }
    };
}

/** The one reason the shim could not send right now, or '' when configuration is complete. */
export function configurationProblem(config: ShimConfig): string {
    const missing: string[] = [];
    if (config.tenantId === '') {
        missing.push('tenant ID');
    }
    if (config.clientId === '') {
        missing.push('client ID');
    }
    if (config.clientSecret === '' && config.certificatePath === '') {
        missing.push('client secret or certificate path');
    }
    if (config.sender === '') {
        missing.push('sender mailbox');
    }
    return missing.length > 0 ? `Missivus is not configured: missing ${missing.join(', ')}` : '';
}

/** `certificate__path` style keys address nested objects, mirroring Ghost's env convention. */
function lookup(options: GhostMailOptions, ghostKey: string): unknown {
    const segments = ghostKey.split('__');
    let value: unknown = options;
    for (const segment of segments) {
        if (typeof value !== 'object' || value === null) {
            return undefined;
        }
        value = (value as Record<string, unknown>)[segment];
    }
    return value;
}

function readGhostMailOptions(path: string): GhostMailOptions {
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch {
        throw new Error(`Missivus: the Ghost config file is not readable at ${path}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`Missivus: the Ghost config file at ${path} is not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return {};
    }
    const mail = (parsed as Record<string, unknown>)['mail'];
    if (typeof mail !== 'object' || mail === null) {
        return {};
    }
    const options = (mail as Record<string, unknown>)['options'];
    return typeof options === 'object' && options !== null ? options as GhostMailOptions : {};
}
