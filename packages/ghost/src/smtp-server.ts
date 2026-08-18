/**
 * Missivus for Ghost — send Ghost transactional email through the Microsoft Graph API.
 *
 * A deliberately minimal SMTP server: just enough of RFC 5321 for a Ghost instance on the same
 * host (or Docker network) to hand us its transactional mail. Ghost speaks to it through
 * Nodemailer's SMTP transport; we hand the raw MIME message to a deliver callback (the Graph
 * transport).
 *
 * Failure policy: a deliver() rejection becomes a 554 reply whose text is the (already redacted)
 * error message, so the Microsoft error lands verbatim in Ghost's own log — loud, never silent.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import net from 'node:net';

export interface SmtpEnvelope {
    from: string;
    to: string[];
}

export type DeliverFn = (envelope: SmtpEnvelope, mime: Uint8Array) => Promise<void>;

export interface SmtpShimServerOptions {
    deliver: DeliverFn;
    /** Advertised and enforced maximum message size in bytes. */
    maxMessageBytes?: number;
    /** Name used in the banner and EHLO reply. */
    hostname?: string;
    log?: (line: string) => void;
}

const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const CRLF = Buffer.from('\r\n');

/** An SMTP reply must stay one line per RFC 5321; fold whitespace and clamp. */
export function smtpSafeLine(text: string, max = 900): string {
    const folded = text.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').trim();
    return folded.length > max ? `${folded.slice(0, max - 3)}...` : folded;
}

export class SmtpShimServer {
    private readonly server: net.Server;
    private readonly deliver: DeliverFn;
    private readonly maxMessageBytes: number;
    private readonly hostname: string;
    private readonly log: (line: string) => void;

    constructor(options: SmtpShimServerOptions) {
        this.deliver = options.deliver;
        this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
        this.hostname = options.hostname ?? 'missivus';
        this.log = options.log ?? (() => undefined);
        this.server = net.createServer((socket) => {
            this.handleConnection(socket);
        });
    }

    async listen(port: number, host = '127.0.0.1'): Promise<{port: number; host: string}> {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(port, host, () => {
                this.server.removeListener('error', reject);
                resolve();
            });
        });
        const address = this.server.address() as net.AddressInfo;
        return {port: address.port, host: address.address};
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.server.close(err => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    private handleConnection(socket: net.Socket): void {
        const session = new Session(socket, this.deliver, this.maxMessageBytes, this.hostname, this.log);
        session.start();
    }
}

class Session {
    private buffer: Buffer = Buffer.alloc(0);
    private envelopeFrom: string | null = null;
    private recipients: string[] = [];
    private inData = false;
    private dataChunks: Buffer[] = [];
    private dataBytes = 0;
    private overSize = false;
    /** 0 = no exchange, 1 = AUTH PLAIN continuation, 2 = LOGIN username, 3 = LOGIN password. */
    private authExchange = 0;
    private busy = false;

    private readonly socket: net.Socket;
    private readonly deliver: DeliverFn;
    private readonly maxMessageBytes: number;
    private readonly hostname: string;
    private readonly log: (line: string) => void;

    constructor(socket: net.Socket, deliver: DeliverFn, maxMessageBytes: number, hostname: string, log: (line: string) => void) {
        this.socket = socket;
        this.deliver = deliver;
        this.maxMessageBytes = maxMessageBytes;
        this.hostname = hostname;
        this.log = log;
    }

    start(): void {
        this.socket.on('error', () => {
            this.socket.destroy();
        });
        this.socket.on('data', (data: Buffer) => {
            this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
            this.drain();
        });
        this.write(`220 ${this.hostname} ESMTP Missivus for Ghost`);
    }

    private write(reply: string): void {
        if (this.socket.writable) {
            this.socket.write(`${reply}\r\n`);
        }
    }

    private drain(): void {
        while (!this.busy) {
            const nl = this.buffer.indexOf(CRLF);
            if (nl === -1) {
                if (this.buffer.length > 8 * 1024 && !this.inData) {
                    this.write('500 5.5.2 line too long');
                    this.socket.destroy();
                }
                return;
            }
            const line = this.buffer.subarray(0, nl);
            this.buffer = this.buffer.subarray(nl + 2);
            if (this.inData) {
                this.handleDataLine(line);
            } else if (this.authExchange > 0) {
                this.handleAuthLine(line);
            } else {
                this.handleCommand(line.toString('utf8'));
            }
        }
    }

    private resetEnvelope(): void {
        this.envelopeFrom = null;
        this.recipients = [];
        this.inData = false;
        this.dataChunks = [];
        this.dataBytes = 0;
        this.overSize = false;
    }

    private handleDataLine(line: Buffer): void {
        if (line.length === 1 && line[0] === 0x2e) {
            this.endOfData();
            return;
        }
        this.dataBytes += line.length + 2;
        if (this.dataBytes > this.maxMessageBytes) {
            this.overSize = true;
            this.dataChunks = [];
            return;
        }
        // Undo SMTP dot-stuffing: a line starting ".." carried a literal ".".
        const unstuffed = line.length >= 2 && line[0] === 0x2e && line[1] === 0x2e ? line.subarray(1) : line;
        this.dataChunks.push(Buffer.concat([unstuffed, CRLF]));
    }

    private endOfData(): void {
        this.inData = false;
        if (this.overSize) {
            this.resetEnvelope();
            this.write('552 5.3.4 message exceeds the maximum size the Missivus shim accepts');
            return;
        }
        const mime = Buffer.concat(this.dataChunks);
        const envelope: SmtpEnvelope = {from: this.envelopeFrom ?? '', to: [...this.recipients]};
        this.busy = true;
        this.deliver(envelope, mime).then(() => {
            this.busy = false;
            this.resetEnvelope();
            this.write('250 2.0.0 accepted by Microsoft Graph');
            this.drain();
        }, (err: unknown) => {
            this.busy = false;
            this.resetEnvelope();
            const message = err instanceof Error ? err.message : String(err);
            this.write(`554 5.0.0 Missivus: ${smtpSafeLine(message)}`);
            this.log(`delivery failed: ${message}`);
            this.drain();
        });
    }

    private handleAuthLine(line: Buffer): void {
        // The credential lines are swallowed without being looked at: the shim trusts its bind
        // interface, and Ghost's configured SMTP credentials are never parsed, never logged.
        if (this.authExchange === 2 && line.length > 0) {
            this.write('334 UGFzc3dvcmQ6'); // "Password:"
            this.authExchange = 3;
            return;
        }
        this.write('235 2.7.0 accepted');
        this.authExchange = 0;
    }

    private handleCommand(line: string): void {
        const upper = line.toUpperCase();
        if (upper === 'QUIT') {
            this.write(`221 2.0.0 ${this.hostname} closing`);
            this.socket.end();
            return;
        }
        if (upper.startsWith('HELO')) {
            this.write(`250 ${this.hostname}`);
            return;
        }
        if (upper.startsWith('EHLO')) {
            this.write(`250-${this.hostname}`);
            this.write(`250-SIZE ${String(this.maxMessageBytes)}`);
            this.write('250-8BITMIME');
            this.write('250-AUTH PLAIN LOGIN');
            this.write('250 ENHANCEDSTATUSCODES');
            return;
        }
        if (upper.startsWith('AUTH')) {
            if (upper === 'AUTH LOGIN') {
                this.write('334 VXNlcm5hbWU6'); // "Username:"
                this.authExchange = 2;
            } else if (upper === 'AUTH PLAIN') {
                this.write('334 ');
                this.authExchange = 1;
            } else {
                // AUTH PLAIN <blob> in one line — accepted unseen.
                this.write('235 2.7.0 accepted');
            }
            return;
        }
        if (upper.startsWith('MAIL FROM:')) {
            const path = parsePath(line.slice(10));
            if (path === null) {
                this.write('501 5.5.4 malformed MAIL FROM');
                return;
            }
            this.envelopeFrom = path;
            this.recipients = [];
            this.write('250 2.1.0 sender ok');
            return;
        }
        if (upper.startsWith('RCPT TO:')) {
            const path = parsePath(line.slice(8));
            if (path === null || path === '') {
                this.write('501 5.5.4 malformed RCPT TO');
                return;
            }
            this.recipients.push(path);
            this.write('250 2.1.5 recipient ok');
            return;
        }
        if (upper === 'DATA') {
            if (this.recipients.length === 0) {
                this.write('503 5.5.1 RCPT TO first');
                return;
            }
            this.inData = true;
            this.write('354 end data with <CRLF>.<CRLF>');
            return;
        }
        if (upper === 'RSET') {
            this.resetEnvelope();
            this.write('250 2.0.0 reset');
            return;
        }
        if (upper === 'NOOP') {
            this.write('250 2.0.0 ok');
            return;
        }
        if (upper === 'STARTTLS') {
            this.write('454 4.7.0 TLS not offered; the shim binds to a trusted interface');
            return;
        }
        this.write('502 5.5.2 command not implemented');
    }
}

function parsePath(rest: string): string | null {
    // MAIL FROM:<a@b> [params] / RCPT TO:<a@b> — angle brackets required by the grammar,
    // tolerated absent because real clients vary.
    const m = /^<([^>]*)>/.exec(rest.trim()) ?? /^(\S+)/.exec(rest.trim());
    return m ? (m[1] ?? '') : null;
}
