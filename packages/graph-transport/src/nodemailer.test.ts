import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createNodemailerTransport, toMessage} from './nodemailer.ts';
import {ArrayTokenCache, FakeFetch, RecordingLogger} from './test-support/fakes.ts';

test('the adapter maps Nodemailer mail data with full fidelity', () => {
    const message = toMessage({
        from: '"Example Ltd" <noreply@example.com>',
        to: 'a@example.com, "B Person" <b@example.com>',
        cc: [{name: 'C', address: 'c@example.com'}],
        bcc: 'd@example.com',
        replyTo: 'replies@example.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
        text: 'Hi',
        attachments: [
            {filename: 'a.txt', content: 'text content', contentType: 'text/plain'},
            {filename: 'b.png', content: new Uint8Array([9, 8]), cid: 'img-1'}
        ]
    });

    assert.deepEqual(message.from, {address: 'noreply@example.com', name: 'Example Ltd'});
    assert.deepEqual(message.to, [{address: 'a@example.com'}, {address: 'b@example.com', name: 'B Person'}]);
    assert.deepEqual(message.cc, [{address: 'c@example.com', name: 'C'}]);
    assert.deepEqual(message.bcc, [{address: 'd@example.com'}]);
    assert.deepEqual(message.replyTo, [{address: 'replies@example.com'}]);
    assert.equal(message.html, '<p>Hi</p>');
    assert.equal(message.text, 'Hi');
    assert.equal(message.attachments.length, 2);
    assert.equal(message.attachments[1]?.contentId, 'img-1');
    assert.equal(message.attachments[1]?.isInline, true);
});

test('base64-encoded string attachments are decoded to bytes', () => {
    const message = toMessage({
        to: 'u@example.com',
        subject: 's',
        text: 'x',
        attachments: [{filename: 'bin.dat', content: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64'}]
    });
    assert.deepEqual(Array.from(message.attachments[0]?.bytes ?? []), [1, 2, 3]);
});

test('send() resolves with an envelope on 202 and rejects with the Graph error otherwise', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueRaw(202, '');
    const cache = new ArrayTokenCache();
    const transport = createNodemailerTransport({
        tenantId: 'tenant-id',
        clientId: 'client-id',
        clientSecret: 'hunter2-correct-horse-battery',
        sender: 'noreply@example.com',
        graphBaseUrl: 'https://graph.example.test',
        loginBaseUrl: 'https://login.example.test',
        fetch: fake.fetch,
        tokenCache: cache,
        logger: new RecordingLogger(),
        now: () => cache.now
    });
    assert.equal(transport.name, 'MissivusGraph');

    const info = await new Promise<unknown>((resolve, reject) => {
        transport.send(
            {data: {from: 'noreply@example.com', to: 'u@example.com', subject: 's', html: '<p>x</p>'}},
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result);
                }
            }
        );
    });
    assert.equal((info as {response: string}).response, '202 Accepted by Microsoft Graph');

    // The token from the first send is still cached; only the Graph reply needs scripting.
    fake.queueJson(403, {error: {code: 'ErrorAccessDenied'}});
    await new Promise<void>((resolve) => {
        transport.send(
            {data: {to: 'u@example.com', subject: 's', text: 'x'}},
            (err) => {
                assert.ok(err instanceof Error);
                assert.ok(err.message.includes('ErrorAccessDenied'));
                resolve();
            }
        );
    });
});
