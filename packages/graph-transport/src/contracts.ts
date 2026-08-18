/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */

/**
 * The injectable HTTP seam. The global `fetch` satisfies it on Node ≥ 20 and on Workers; tests
 * inject a scripted fake. An HTTP error status is a normal response — implementations throw only
 * when the request could not be made at all (DNS, TLS, timeout).
 */
export type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
}) => Promise<{status: number; text(): Promise<string>}>;

/**
 * Whatever backs it holds a bearer token, so it must not be world-readable and must not be
 * serialised into logs or debug output.
 */
export interface TokenCache {
    get(key: string): Promise<string | undefined> | string | undefined;
    set(key: string, value: string, ttlSeconds: number): Promise<void> | void;
    delete(key: string): Promise<void> | void;
}

/**
 * A PSR-3-shaped subset, declared locally so the portable core needs no package. Implementations
 * receive messages that have already been passed through the Redactor.
 */
export interface Logger {
    error(message: string): void;
    warning(message: string): void;
    info(message: string): void;
}

export const nullLogger: Logger = {
    error: () => undefined,
    warning: () => undefined,
    info: () => undefined
};

/** In-memory token cache with an injectable clock, the default when none is provided. */
export class MemoryTokenCache implements TokenCache {
    private readonly entries = new Map<string, {value: string; expiresAt: number}>();
    private readonly now: () => number;

    constructor(now: () => number = () => Date.now()) {
        this.now = now;
    }

    get(key: string): string | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(key: string, value: string, ttlSeconds: number): void {
        this.entries.set(key, {value, expiresAt: this.now() + ttlSeconds * 1000});
    }

    delete(key: string): void {
        this.entries.delete(key);
    }
}
