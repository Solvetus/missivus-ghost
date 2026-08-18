/**
 * A deliberately minimal SMTP server: just enough of RFC 5321 for a Ghost
 * instance on the same host (or Docker network) to hand us its transactional
 * mail. Ghost speaks to it through Nodemailer's SMTP transport; we hand the
 * raw MIME message to a deliver callback (the Graph transport).
 *
 * Failure policy: a deliver() rejection becomes a 554 reply whose text is the
 * (already redacted) error message, so the Microsoft error lands verbatim in
 * Ghost's own log — loud, never silent.
 */
import net from 'node:net';

export interface SmtpEnvelope {
    from: string;
    to: string[];
}

export type DeliverFn = (envelope: SmtpEnvelope, mime: Buffer) => Promise<void>;

export interface SmtpShimServerOptions {
    deliver: DeliverFn;
    /** Advertised and enforced maximum message size in bytes. */
    maxMessageBytes?: number;
    /** Name used in the banner and EHLO reply. */
    hostname?: string;
    log?: (line: string) => void;
}

const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/** An SMTP reply must stay one line per 5321; fold whitespace and clamp. */
export function smtpSafeLine(text: string, max = 900): string {
    const folded = text.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').trim();
    return folded.length > max ? `${folded.slice(0, max - 1)}…`.replace(/[^\x20-\x7e]$/, '') : folded;
}

function parsePath(rest: string): string | null {
    // MAIL FROM:<a@b> [params] / RCPT TO:<a@b> — angle brackets required by
    // the grammar, tolerated absent because real clients vary.
    const m = /^<([^>]*)>/.exec(rest.trim()) ?? /^([^\s]+)/.exec(rest.trim());
    return m ? (m[1] ?? '') : null;
}

interface SessionState {
    envelopeFrom: string | null;
    recipients: string[];
    inData: boolean;
    chunks: Buffer[];
    bytes: number;
    overSize: boolean;
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
        this.server = net.createServer((socket) => { this.handleConnection(socket); });
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
            this.server.close(err => (err ? reject(err) : resolve()));
        });
    }

    private handleConnection(socket: net.Socket): void {
        const state: SessionState = {envelopeFrom: null, recipients: [], inData: false, chunks: [], bytes: 0, overSize: false};
        let lineBuffer = Buffer.alloc(0);
        let busy = false;

        const write = (reply: string): void => {
            if (socket.writable) {
                socket.write(`${reply}\r\n`);
            }
        };

        const resetEnvelope = (): void => {
            state.envelopeFrom = null;
            state.recipients = [];
            state.inData = false;
            state.chunks = [];
            state.bytes = 0;
            state.overSize = false;
        };

        socket.on('error', () => { socket.destroy(); });
        write(`220 ${this.hostname} ESMTP Missivus for Ghost`);

        const endOfData = (): void => {
            state.inData = false;
            const raw = Buffer.concat(state.chunks);
            state.chunks = [];
            if (state.overSize) {
                resetEnvelope();
                write('552 5.3.4 message exceeds the maximum size the Missivus shim accepts');
                return;
            }
            // Undo SMTP dot-stuffing.
            const mime = Buffer.from(raw.toString('binary').replace(/(^|\r\n)\.\./g, '$1.'), 'binary');
            const envelope: SmtpEnvelope = {from: state.envelopeFrom ?? '', to: [...state.recipients]};
            busy = true;
            this.deliver(envelope, mime).then(() => {
                busy = false;
                resetEnvelope();
                write('250 2.0.0 accepted by Microsoft Graph');
            }, (err: unknown) => {
                busy = false;
                resetEnvelope();
                const message = err instanceof Error ? err.message : String(err);
                write(`554 5.0.0 Missivus: ${smtpSafeLine(message)}`);
                this.log(`delivery failed: ${message}`);
            });
        };

        const handleLine = (line: string): void => {
            const upper = line.toUpperCase();
            if (upper === 'QUIT') {
                write(`221 2.0.0 ${this.hostname} closing`);
                socket.end();
                return;
            }
            if (upper.startsWith('HELO')) {
                write(`250 ${this.hostname}`);
                return;
            }
            if (upper.startsWith('EHLO')) {
                write(`250-${this.hostname}`);
                write(`250-SIZE ${String(this.maxMessageBytes)}`);
                write('250-8BITMIME');
                write('250-AUTH PLAIN LOGIN');
                write('250 ENHANCEDSTATUSCODES');
                return;
            }
            if (upper.startsWith('AUTH')) {
                // The shim trusts its network (localhost / the Docker
                // network). Credentials Ghost was configured with are
                // accepted unseen: never parsed, never logged.
                if (upper === 'AUTH LOGIN' || upper.startsWith('AUTH LOGIN ')) {
                    write('334 VXNlcm5hbWU6');
                    authExchange = 2;
                    return;
                }
                if (upper === 'AUTH PLAIN') {
                    write('334 ');
                    authExchange = 1;
                    return;
                }
                write('235 2.7.0 accepted');
                return;
            }
            if (upper.startsWith('MAIL FROM:')) {
                const path = parsePath(line.slice(10));
                if (path === null) {
                    write('501 5.5.4 malformed MAIL FROM');
                    return;
                }
                state.envelopeFrom = path;
                state.recipients = [];
                write('250 2.1.0 sender ok');
                return;
            }
            if (upper.startsWith('RCPT TO:')) {
                const path = parsePath(line.slice(8));
                if (path === null || path === '') {
                    write('501 5.5.4 malformed RCPT TO');
                    return;
                }
                state.recipients.push(path);
                write('250 2.1.5 recipient ok');
                return;
            }
            if (upper === 'DATA') {
                if (state.recipients.length === 0) {
                    write('503 5.5.1 RCPT TO first');
                    return;
                }
                state.inData = true;
                write('354 end data with <CRLF>.<CRLF>');
                return;
            }
            if (upper === 'RSET') {
                resetEnvelope();
                write('250 2.0.0 reset');
                return;
            }
            if (upper === 'NOOP') {
                write('250 2.0.0 ok');
                return;
            }
            if (upper === 'STARTTLS') {
                write('454 4.7.0 TLS not offered; the shim binds to a trusted interface');
                return;
            }
            write('502 5.5.2 command not implemented');
        };

        let authExchange = 0;

        socket.on('data', (data: Buffer) => {
            lineBuffer = lineBuffer.length === 0 ? data : Buffer.concat([lineBuffer, data]);
            for (;;) {
                if (busy) {
                    // A reply is pending for DATA; buffer anything further.
                    return;
                }
                const nl = lineBuffer.indexOf('\r\n');
                if (nl === -1) {
                    if (lineBuffer.length > 8 * 1024 && !state.inData) {
                        write('500 5.5.2 line too long');
                        socket.destroy();
                    }
                    return;
                }
                const line = lineBuffer.subarray(0, nl);
                lineBuffer = lineBuffer.subarray(nl + 2);
                if (state.inData) {
                    if (line.length === 1 && line[0] === 0x2e) {
                        endOfData();
                        continue;
                    }
                    state.bytes += line.length + 2;
                    if (state.bytes > this.maxMessageBytes) {
                        state.overSize = true;
                        state.chunks = [];
                    } else if (!state.overSize) {
                        state.chunks.push(Buffer.concat([line, Buffer.from('\r\n')]));
                    }
                    continue;
                }
                if (authExchange > 0) {
                    // Swallow the base64 credential lines without looking.
                    if (authExchange === 2 && line.length > 0) {
                        write('334 UGFzc3dvcmQ6');
                        authExchange = 3;
                    } else {
                        write('235 2.7.0 accepted');
                        authExchange = 0;
                    }
                    continue;
                }
                handleLine(line.toString('utf8'));
            }
        });
    }
}
