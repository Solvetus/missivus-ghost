import assert from 'node:assert/strict';
import net from 'node:net';
import {test} from 'node:test';
import type {SmtpEnvelope} from './smtp-server.ts';
import {SmtpShimServer, smtpSafeLine} from './smtp-server.ts';

class SmtpTestClient {
    private socket!: net.Socket;
    private buffer = '';
    private waiting: ((line: string) => void) | null = null;

    async connect(port: number): Promise<void> {
        this.socket = net.connect({host: '127.0.0.1', port});
        this.socket.on('data', (d: Buffer) => {
            this.buffer += d.toString('utf8');
            this.flush();
        });
        await new Promise<void>(resolve => this.socket.once('connect', resolve));
    }

    private flush(): void {
        if (!this.waiting) {
            return;
        }
        const lines = this.buffer.split('\r\n');
        let consumed = 0;
        for (const line of lines) {
            consumed += line.length + 2;
            if (line.length >= 4 && line[3] === ' ') {
                this.buffer = this.buffer.slice(consumed);
                const w = this.waiting;
                this.waiting = null;
                w(line);
                return;
            }
        }
    }

    reply(): Promise<string> {
        return new Promise<string>(resolve => {
            this.waiting = resolve;
            this.flush();
        });
    }

    async command(line: string): Promise<string> {
        this.socket.write(`${line}\r\n`);
        return this.reply();
    }

    write(raw: string): void {
        this.socket.write(raw);
    }

    end(): void {
        this.socket.destroy();
    }
}

async function withServer(
    deliver: (envelope: SmtpEnvelope, mime: Uint8Array) => Promise<void>,
    run: (client: SmtpTestClient) => Promise<void>,
    maxMessageBytes?: number
): Promise<void> {
    const options: ConstructorParameters<typeof SmtpShimServer>[0] = {deliver};
    if (maxMessageBytes !== undefined) {
        options.maxMessageBytes = maxMessageBytes;
    }
    const server = new SmtpShimServer(options);
    const bound = await server.listen(0);
    const client = new SmtpTestClient();
    await client.connect(bound.port);
    assert.match(await client.reply(), /^220 /);
    try {
        await run(client);
    } finally {
        client.end();
        await server.close();
    }
}

test('a full session delivers the dot-unstuffed MIME with its envelope', async () => {
    let seen: {envelope: SmtpEnvelope; mime: string} | null = null;
    await withServer(
        (envelope, mime) => {
            seen = {envelope, mime: Buffer.from(mime).toString('utf8')};
            return Promise.resolve();
        },
        async (client) => {
            const ehlo = await client.command('EHLO ghost.local');
            assert.match(ehlo, /^250 /);
            assert.match(await client.command('AUTH PLAIN AGdob3N0AHNlY3JldA=='), /^235 /);
            assert.match(await client.command('MAIL FROM:<blog@example.com>'), /^250 /);
            assert.match(await client.command('RCPT TO:<member@example.com>'), /^250 /);
            assert.match(await client.command('DATA'), /^354 /);
            client.write('From: blog@example.com\r\nTo: member@example.com\r\nSubject: hi\r\n\r\nline one\r\n..dot line\r\n');
            assert.match(await client.command('.'), /^250 2\.0\.0 accepted/);
            assert.match(await client.command('QUIT'), /^221 /);
        }
    );
    assert.ok(seen !== null);
    const delivered = seen as unknown as {envelope: SmtpEnvelope; mime: string};
    assert.equal(delivered.envelope.from, 'blog@example.com');
    assert.deepEqual(delivered.envelope.to, ['member@example.com']);
    assert.ok(delivered.mime.includes('\r\n.dot line\r\n'), 'dot-stuffing must be undone');
    assert.ok(delivered.mime.includes('Subject: hi'));
});

test('a deliver failure becomes a 554 carrying the error text for Ghost\'s log', async () => {
    await withServer(
        () => Promise.reject(new Error('Missivus: Microsoft rejected the token request (HTTP 400) — response: AADSTS90002: Tenant not found')),
        async (client) => {
            await client.command('EHLO ghost.local');
            await client.command('MAIL FROM:<a@b.test>');
            await client.command('RCPT TO:<c@d.test>');
            await client.command('DATA');
            client.write('Subject: x\r\n\r\nbody\r\n');
            const reply = await client.command('.');
            assert.match(reply, /^554 5\.0\.0 Missivus: /);
            assert.ok(reply.includes('AADSTS90002'), 'the Microsoft error must reach the SMTP reply');
            // The session stays usable after a failure.
            assert.match(await client.command('NOOP'), /^250 /);
        }
    );
});

test('an oversized message is refused with 552 and never delivered', async () => {
    let delivered = 0;
    await withServer(
        () => {
            delivered += 1;
            return Promise.resolve();
        },
        async (client) => {
            await client.command('EHLO ghost.local');
            await client.command('MAIL FROM:<a@b.test>');
            await client.command('RCPT TO:<c@d.test>');
            await client.command('DATA');
            client.write(`X: ${'y'.repeat(300)}\r\n\r\nbody\r\n`);
            assert.match(await client.command('.'), /^552 /);
        },
        128
    );
    assert.equal(delivered, 0);
});

test('DATA before RCPT is refused and RSET clears the envelope', async () => {
    await withServer(
        () => Promise.resolve(),
        async (client) => {
            await client.command('EHLO ghost.local');
            assert.match(await client.command('DATA'), /^503 /);
            await client.command('MAIL FROM:<a@b.test>');
            await client.command('RCPT TO:<c@d.test>');
            assert.match(await client.command('RSET'), /^250 /);
            assert.match(await client.command('DATA'), /^503 /);
        }
    );
});

test('smtpSafeLine folds newlines and clamps length', () => {
    const folded = smtpSafeLine('a\r\nb\nc\td');
    assert.equal(folded, 'a b c d');
    assert.ok(smtpSafeLine('x'.repeat(2000)).length <= 900);
});
