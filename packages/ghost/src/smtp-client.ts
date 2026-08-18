/**
 * Missivus for Ghost — send Ghost transactional email through the Microsoft Graph API.
 *
 * A minimal SMTP client for the optional fallback passthrough (default OFF): when the operator
 * has explicitly configured a fallback SMTP server, the unmodified MIME message is relayed there
 * after a Graph failure. Supports implicit TLS and AUTH PLAIN; deliberately nothing more.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import net from 'node:net';
import tls from 'node:tls';
import type {FallbackConfig} from './config.ts';
import type {SmtpEnvelope} from './smtp-server.ts';

export async function relayOverSmtp(config: FallbackConfig, envelope: SmtpEnvelope, mime: Uint8Array): Promise<void> {
    const socket: net.Socket = config.secure
        ? tls.connect({host: config.host, port: config.port, servername: config.host})
        : net.connect({host: config.host, port: config.port});

    const reader = new ReplyReader(socket);
    try {
        await reader.expect([220]);
        socket.write(`EHLO missivus\r\n`);
        await reader.expect([250]);
        if (config.user !== '') {
            const blob = Buffer.from(`\u0000${config.user}\u0000${config.pass}`, 'utf8').toString('base64');
            socket.write(`AUTH PLAIN ${blob}\r\n`);
            await reader.expect([235]);
        }
        socket.write(`MAIL FROM:<${envelope.from}>\r\n`);
        await reader.expect([250]);
        for (const rcpt of envelope.to) {
            socket.write(`RCPT TO:<${rcpt}>\r\n`);
            await reader.expect([250, 251]);
        }
        socket.write('DATA\r\n');
        await reader.expect([354]);
        socket.write(dotStuff(Buffer.from(mime)));
        socket.write('\r\n.\r\n');
        await reader.expect([250]);
        socket.write('QUIT\r\n');
    } finally {
        socket.end();
        socket.destroy();
    }
}

function dotStuff(mime: Buffer): Buffer {
    const text = mime.toString('binary');
    const normalised = text.endsWith('\r\n') ? text.slice(0, -2) : text;
    return Buffer.from(normalised.replace(/(^|\r\n)\./g, '$1..'), 'binary');
}

class ReplyReader {
    private buffer = '';
    private waiting: {resolve: (line: string) => void; reject: (err: Error) => void} | null = null;
    private closed: Error | null = null;

    constructor(socket: net.Socket) {
        socket.on('data', (data: Buffer) => {
            this.buffer += data.toString('utf8');
            this.tryFlush();
        });
        socket.on('error', (err) => {
            this.closed = err;
            this.tryFlush();
        });
        socket.on('close', () => {
            this.closed = this.closed ?? new Error('connection closed');
            this.tryFlush();
        });
    }

    async expect(codes: number[]): Promise<void> {
        const line = await this.nextReply();
        const code = parseInt(line.slice(0, 3), 10);
        if (!codes.includes(code)) {
            throw new Error(`fallback SMTP server answered: ${line.trim()}`);
        }
    }

    private nextReply(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.waiting = {resolve, reject};
            this.tryFlush();
        });
    }

    private tryFlush(): void {
        if (!this.waiting) {
            return;
        }
        // A reply ends at the first line whose fourth character is a space (multiline uses "-").
        const lines = this.buffer.split('\r\n');
        let consumed = 0;
        for (const line of lines) {
            consumed += line.length + 2;
            if (line.length >= 4 && line[3] === ' ') {
                this.buffer = this.buffer.slice(consumed);
                const waiting = this.waiting;
                this.waiting = null;
                waiting.resolve(line);
                return;
            }
            if (line.length > 0 && line.length < 4 && /^\d+$/.test(line)) {
                this.buffer = this.buffer.slice(consumed);
                const waiting = this.waiting;
                this.waiting = null;
                waiting.resolve(line);
                return;
            }
        }
        if (this.closed) {
            const waiting = this.waiting;
            this.waiting = null;
            waiting.reject(this.closed);
        }
    }
}
