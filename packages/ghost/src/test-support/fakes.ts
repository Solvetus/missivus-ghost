/**
 * Missivus for Ghost — test doubles. Nothing here ships.
 *
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import type {Logger} from '@missivus/graph-transport';
import type {ShimConfig} from '../config.ts';

type FetchLike = (url: string, init: {method: string; headers: Record<string, string>; body?: string | Uint8Array}) =>
    Promise<{status: number; text(): Promise<string>}>;

export class FakeFetch {
    readonly requests: {method: string; url: string; headers: Record<string, string>; body: string | Uint8Array | undefined}[] = [];
    private readonly queue: {status: number; body: string}[] = [];

    queueJson(status: number, json: unknown): void {
        this.queue.push({status, body: JSON.stringify(json)});
    }

    queueToken(): void {
        this.queueJson(200, {access_token: 'TOKEN-VALUE-FOR-TESTS-ONLY', expires_in: 3600});
    }

    queueRaw(status: number, body: string): void {
        this.queue.push({status, body});
    }

    get fetch(): FetchLike {
        return (url, init) => {
            this.requests.push({method: init.method, url, headers: init.headers, body: init.body});
            const scripted = this.queue.shift();
            if (scripted === undefined) {
                throw new Error(`FakeFetch has no scripted response for ${init.method} ${url}`);
            }
            return Promise.resolve({status: scripted.status, text: () => Promise.resolve(scripted.body)});
        };
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

    everything(): string {
        return [...this.errors, ...this.warnings, ...this.infos].join('\n');
    }
}

export function testConfig(overrides: Partial<ShimConfig> = {}): ShimConfig {
    return {
        listenHost: '127.0.0.1',
        listenPort: 0,
        tenantId: 'tenant-id',
        clientId: 'client-id',
        clientSecret: 'hunter2-correct-horse-battery',
        certificatePath: '',
        certificatePassphrase: '',
        certificateAlgorithm: 'PS256',
        sender: 'noreply@example.com',
        saveToSentItems: false,
        graphBaseUrl: 'https://graph.example.test',
        loginBaseUrl: 'https://login.example.test',
        fallback: {host: '', port: 587, secure: false, user: '', pass: ''},
        ...overrides
    };
}
