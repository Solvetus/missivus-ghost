/**
 * Missivus — test doubles. Nothing here ships.
 *
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {FetchLike, Logger, TokenCache} from '../contracts.ts';

export interface RecordedRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | Uint8Array | undefined;
}

/**
 * The mocked Graph endpoint. Records every request and answers from a scripted queue, so a test
 * asserts on the exact bytes Missivus would have put on the wire. An unscripted call throws —
 * an unexpected request is a failure, not a silent pass.
 */
export class FakeFetch {
    readonly requests: RecordedRequest[] = [];
    private readonly queue: ({status: number; body: string} | Error)[] = [];

    queueJson(status: number, json: unknown): void {
        this.queue.push({status, body: JSON.stringify(json)});
    }

    queueRaw(status: number, body: string): void {
        this.queue.push({status, body});
    }

    queueToken(token = 'TOKEN-VALUE-FOR-TESTS-ONLY', expiresIn = 3600): void {
        this.queueJson(200, {access_token: token, expires_in: expiresIn});
    }

    /** Simulate a dead network: the next call throws instead of answering. */
    failTransport(message: string): void {
        this.queue.push(new Error(message));
    }

    get fetch(): FetchLike {
        return (url, init) => {
            this.requests.push({method: init.method, url, headers: init.headers, body: init.body});
            const scripted = this.queue.shift();
            if (scripted === undefined) {
                throw new Error(`FakeFetch has no scripted response for ${init.method} ${url}`);
            }
            if (scripted instanceof Error) {
                return Promise.reject(scripted);
            }
            return Promise.resolve({
                status: scripted.status,
                text: () => Promise.resolve(scripted.body)
            });
        };
    }

    urls(): string[] {
        return this.requests.map(r => r.url);
    }

    bodyText(i: number): string {
        const body = this.requests[i]?.body;
        if (body === undefined) {
            return '';
        }
        return typeof body === 'string' ? body : new TextDecoder().decode(body);
    }

    bodyJson(i: number): Record<string, unknown> {
        return JSON.parse(this.bodyText(i)) as Record<string, unknown>;
    }

    form(i: number): URLSearchParams {
        return new URLSearchParams(this.bodyText(i));
    }
}

/** In-memory token cache with an injectable clock and a write counter. */
export class ArrayTokenCache implements TokenCache {
    now = 1_000_000_000;
    writes = 0;
    private readonly entries = new Map<string, {value: string; expiresAt: number}>();

    advance(seconds: number): void {
        this.now += seconds * 1000;
    }

    get(key: string): string | undefined {
        const entry = this.entries.get(key);
        if (!entry || entry.expiresAt <= this.now) {
            return undefined;
        }
        return entry.value;
    }

    set(key: string, value: string, ttlSeconds: number): void {
        this.writes += 1;
        this.entries.set(key, {value, expiresAt: this.now + ttlSeconds * 1000});
    }

    delete(key: string): void {
        this.entries.delete(key);
    }

    ttlOf(key: string): number {
        const entry = this.entries.get(key);
        return entry ? (entry.expiresAt - this.now) / 1000 : -1;
    }
}

export class RecordingLogger implements Logger {
    readonly errors: string[] = [];
    readonly warnings: string[] = [];
    readonly infos: string[] = [];

    error(message: string): void {
        this.errors.push(message);
    }

    warning(message: string): void {
        this.warnings.push(message);
    }

    info(message: string): void {
        this.infos.push(message);
    }

    /** Everything logged, for a single "does this leak?" assertion. */
    everything(): string {
        return [...this.errors, ...this.warnings, ...this.infos].join('\n');
    }
}

/**
 * A throwaway 2048-bit RSA key + self-signed certificate, via the openssl CLI (an independent
 * implementation, which is the point of verifying our signatures against it). Nothing here is or
 * ever becomes a real credential.
 */
export function makeTestCertificate(passphrase = ''): {pem: string; keyPem: string; certPem: string; dir: string; cleanup: () => void} {
    const dir = mkdtempSync(join(tmpdir(), 'missivus-test-'));
    const keyFile = join(dir, 'test.key');
    const certFile = join(dir, 'test.crt');
    const args = ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyFile, '-out', certFile,
        '-days', '2', '-subj', '/CN=missivus-test'];
    if (passphrase !== '') {
        args.push('-passout', `pass:${passphrase}`);
    } else {
        args.push('-nodes');
    }
    execFileSync('openssl', args, {stdio: 'ignore'});
    const keyPem = readFileSync(keyFile, 'utf8');
    const certPem = readFileSync(certFile, 'utf8');
    return {
        pem: `${keyPem}${certPem}`,
        keyPem,
        certPem,
        dir,
        cleanup: () => {
            rmSync(dir, {recursive: true, force: true});
        }
    };
}
