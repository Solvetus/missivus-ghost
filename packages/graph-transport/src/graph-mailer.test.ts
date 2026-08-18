import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GraphError} from './errors.ts';
import {LARGE_ATTACHMENT_THRESHOLD, UPLOAD_CHUNK_BYTES} from './graph-mailer.ts';
import {createGraphTransport} from './index.ts';
import {Message} from './message.ts';
import {ArrayTokenCache, FakeFetch, RecordingLogger} from './test-support/fakes.ts';

const SECRET = 'hunter2-correct-horse-battery';
const GRAPH = 'https://graph.example.test';

function makeMailer(fake: FakeFetch, logger: RecordingLogger, overrides: Partial<Parameters<typeof createGraphTransport>[0]> = {}) {
    const cache = new ArrayTokenCache();
    return createGraphTransport({
        tenantId: 'tenant-id',
        clientId: 'client-id',
        clientSecret: SECRET,
        sender: 'noreply@example.com',
        graphBaseUrl: GRAPH,
        loginBaseUrl: 'https://login.example.test',
        fetch: fake.fetch,
        tokenCache: cache,
        logger,
        now: () => cache.now,
        ...overrides
    });
}

function simpleMessage(): Message {
    return new Message({
        from: {address: 'noreply@example.com', name: 'Example Ltd'},
        to: [{address: 'user@example.com', name: 'A User'}],
        subject: 'Hello',
        html: '<p>Hi</p>',
        text: 'Hi'
    });
}

test('the happy path posts sendMail with full fidelity and expects 202', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueRaw(202, '');
    const logger = new RecordingLogger();
    const mailer = makeMailer(fake, logger);

    const message = new Message({
        from: {address: 'noreply@example.com', name: 'Example Ltd'},
        to: [{address: 'to@example.com', name: 'To Person'}],
        cc: [{address: 'cc@example.com'}],
        bcc: [{address: 'bcc@example.com'}],
        replyTo: [{address: 'replies@example.com'}],
        subject: 'Subject line',
        html: '<p>HTML body</p>',
        text: 'text body'
    });
    await mailer.send(message);

    // The sender mailbox is URL-encoded in the path.
    assert.equal(fake.urls()[1], `${GRAPH}/v1.0/users/noreply%40example.com/sendMail`);
    const payload = fake.bodyJson(1);
    assert.equal(payload['saveToSentItems'], false);
    const graphMessage = payload['message'] as Record<string, unknown>;
    assert.equal(graphMessage['subject'], 'Subject line');
    assert.deepEqual(graphMessage['body'], {contentType: 'HTML', content: '<p>HTML body</p>'});
    assert.deepEqual(graphMessage['toRecipients'], [{emailAddress: {address: 'to@example.com', name: 'To Person'}}]);
    assert.deepEqual(graphMessage['ccRecipients'], [{emailAddress: {address: 'cc@example.com'}}]);
    assert.deepEqual(graphMessage['bccRecipients'], [{emailAddress: {address: 'bcc@example.com'}}]);
    assert.deepEqual(graphMessage['replyTo'], [{emailAddress: {address: 'replies@example.com'}}]);
    assert.deepEqual(graphMessage['from'], {emailAddress: {address: 'noreply@example.com', name: 'Example Ltd'}});
    assert.equal(fake.requests[1]?.headers['Authorization'], 'Bearer TOKEN-VALUE-FOR-TESTS-ONLY');
    assert.equal(logger.warnings.length, 0);
});

test('a plaintext-only message sends a Text body', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueRaw(202, '');
    const mailer = makeMailer(fake, new RecordingLogger());
    await mailer.send(new Message({to: [{address: 'u@example.com'}], subject: 's', text: 'plain'}));
    const graphMessage = fake.bodyJson(1)['message'] as Record<string, unknown>;
    assert.deepEqual(graphMessage['body'], {contentType: 'Text', content: 'plain'});
});

test('saveToSentItems is honoured', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueRaw(202, '');
    const mailer = makeMailer(fake, new RecordingLogger(), {saveToSentItems: true});
    await mailer.send(simpleMessage());
    assert.equal(fake.bodyJson(1)['saveToSentItems'], true);
});

test('a differing From is forced with a warning and kept as Reply-To', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueRaw(202, '');
    const logger = new RecordingLogger();
    const mailer = makeMailer(fake, logger);

    await mailer.send(new Message({
        from: {address: 'ghost@blog.example.com', name: 'My Blog'},
        to: [{address: 'u@example.com'}],
        subject: 's',
        text: 'x'
    }));

    const graphMessage = fake.bodyJson(1)['message'] as Record<string, unknown>;
    assert.deepEqual(graphMessage['from'], {emailAddress: {address: 'noreply@example.com', name: 'My Blog'}});
    assert.deepEqual(graphMessage['replyTo'], [{emailAddress: {address: 'ghost@blog.example.com', name: 'My Blog'}}]);
    assert.equal(logger.warnings.length, 1);
    assert.ok(logger.warnings[0]?.includes('noreply@example.com'));
    assert.ok(logger.warnings[0]?.includes('ghost@blog.example.com'));
});

test('a matching From, compared case-insensitively, produces no warning', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueRaw(202, '');
    const logger = new RecordingLogger();
    const mailer = makeMailer(fake, logger);
    await mailer.send(new Message({from: {address: 'NoReply@Example.com'}, to: [{address: 'u@example.com'}], subject: 's', text: 'x'}));
    assert.equal(logger.warnings.length, 0);
});

test('an explicit Reply-To is never clobbered by the forced From', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueRaw(202, '');
    const mailer = makeMailer(fake, new RecordingLogger());
    await mailer.send(new Message({
        from: {address: 'other@example.com'},
        replyTo: [{address: 'keep-me@example.com'}],
        to: [{address: 'u@example.com'}],
        subject: 's',
        text: 'x'
    }));
    const graphMessage = fake.bodyJson(1)['message'] as Record<string, unknown>;
    assert.deepEqual(graphMessage['replyTo'], [{emailAddress: {address: 'keep-me@example.com'}}]);
});

test('a message with no recipients is refused', async () => {
    const mailer = makeMailer(new FakeFetch(), new RecordingLogger());
    await assert.rejects(mailer.send(new Message({subject: 's', text: 'x'})), /no recipients/);
});

test('an empty sender is refused before any network call', async () => {
    const fake = new FakeFetch();
    const mailer = makeMailer(fake, new RecordingLogger(), {sender: ''});
    await assert.rejects(mailer.send(simpleMessage()), /missing sender mailbox/);
    assert.equal(fake.requests.length, 0);
});

test('a small attachment rides inline in the one sendMail request', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueRaw(202, '');
    const mailer = makeMailer(fake, new RecordingLogger());
    await mailer.send(new Message({
        to: [{address: 'u@example.com'}],
        subject: 's',
        text: 'x',
        attachments: [{name: 'inline.png', content: new Uint8Array([1, 2, 3]), contentType: 'image/png', contentId: 'cid-1'}]
    }));
    assert.equal(fake.requests.length, 2);
    const attachments = (fake.bodyJson(1)['message'] as Record<string, unknown>)['attachments'] as Record<string, unknown>[];
    assert.equal(attachments[0]?.['name'], 'inline.png');
    assert.equal(attachments[0]?.['isInline'], true);
    assert.equal(attachments[0]?.['contentId'], 'cid-1');
    assert.equal(attachments[0]?.['contentBytes'], Buffer.from([1, 2, 3]).toString('base64'));
});

test('a large attachment goes through draft, upload session and send', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueJson(201, {id: 'DRAFT-1'});
    fake.queueJson(201, {uploadUrl: 'https://outlook.example.test/upload/session-1'});
    fake.queueJson(200, {nextExpectedRanges: ['3276800']});
    fake.queueJson(201, {});
    fake.queueRaw(202, '');
    const mailer = makeMailer(fake, new RecordingLogger());

    const total = 4 * 1024 * 1024;
    await mailer.send(new Message({
        to: [{address: 'u@example.com'}],
        subject: 'big',
        text: 'x',
        attachments: [{name: 'big.pdf', content: new Uint8Array(total), contentType: 'application/pdf'}]
    }));

    assert.deepEqual(fake.urls(), [
        'https://login.example.test/tenant-id/oauth2/v2.0/token',
        `${GRAPH}/v1.0/users/noreply%40example.com/messages`,
        `${GRAPH}/v1.0/users/noreply%40example.com/messages/DRAFT-1/attachments/createUploadSession`,
        'https://outlook.example.test/upload/session-1',
        'https://outlook.example.test/upload/session-1',
        `${GRAPH}/v1.0/users/noreply%40example.com/messages/DRAFT-1/send`
    ]);

    // The draft itself must not carry the large file inline.
    assert.ok(!('attachments' in fake.bodyJson(1)));

    const first = fake.requests[3];
    assert.equal(first?.headers['Content-Range'], `bytes 0-3276799/${String(total)}`);
    assert.equal(first?.headers['Content-Type'], 'application/octet-stream');
    assert.equal(first?.headers['Content-Length'], String(UPLOAD_CHUNK_BYTES));
    assert.ok(
        !('Authorization' in (first?.headers ?? {})),
        'The upload URL is pre-authenticated; sending our Graph token to another host would leak it'
    );

    const second = fake.requests[4];
    assert.equal(second?.headers['Content-Range'], `bytes 3276800-${String(total - 1)}/${String(total)}`);
    assert.equal((second?.body as Uint8Array).length, total - UPLOAD_CHUNK_BYTES);

    assert.equal(fake.bodyText(5), '', 'The send call takes no body');
});

test('several sub-ceiling files that blow the budget together also take the draft path', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueJson(201, {id: 'DRAFT-2'});
    fake.queueRaw(202, '');
    const mailer = makeMailer(fake, new RecordingLogger());

    const size = 1_200_000;
    await mailer.send(new Message({
        to: [{address: 'u@example.com'}],
        subject: 's',
        text: 'x',
        attachments: [0, 1, 2].map(i => ({name: `f${String(i)}.bin`, content: new Uint8Array(size)}))
    }));
    // Each file is below the per-file ceiling, so all three ride inline in the draft.
    assert.ok(fake.urls()[1]?.endsWith('/messages'));
    assert.ok(fake.urls()[2]?.endsWith('/messages/DRAFT-2/send'));
    const draftAttachments = fake.bodyJson(1)['attachments'] as unknown[];
    assert.equal(draftAttachments.length, 3);
});

test('a refused draft names the Mail.ReadWrite permission', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueJson(403, {error: {code: 'ErrorAccessDenied'}});
    const mailer = makeMailer(fake, new RecordingLogger());
    await assert.rejects(
        mailer.send(new Message({
            to: [{address: 'u@example.com'}], subject: 's', text: 'x',
            attachments: [{name: 'big.bin', content: new Uint8Array(LARGE_ATTACHMENT_THRESHOLD)}]
        })),
        /Mail\.ReadWrite/
    );
});

test('a failed upload names the orphaned draft and rethrows', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueJson(201, {id: 'DRAFT-ORPHAN'});
    fake.queueJson(500, {error: {code: 'Boom'}});
    const logger = new RecordingLogger();
    const mailer = makeMailer(fake, logger);
    await assert.rejects(mailer.send(new Message({
        to: [{address: 'u@example.com'}], subject: 's', text: 'x',
        attachments: [{name: 'big.bin', content: new Uint8Array(LARGE_ATTACHMENT_THRESHOLD)}]
    })));
    assert.ok(logger.errors.some(e => e.includes('DRAFT-ORPHAN')));
});

test('a 401 refreshes the token and retries exactly once', async () => {
    const fake = new FakeFetch();
    fake.queueToken('TOK-STALE');
    fake.queueRaw(401, '');
    fake.queueToken('TOK-FRESH');
    fake.queueRaw(202, '');
    const logger = new RecordingLogger();
    const mailer = makeMailer(fake, logger);
    await mailer.send(simpleMessage());
    assert.equal(fake.requests.length, 4);
    assert.equal(fake.requests[3]?.headers['Authorization'], 'Bearer TOK-FRESH');
    assert.ok(logger.warnings.some(w => w.includes('retrying once')));
});

test('a second 401 fails with the Graph error body kept, redacted', async () => {
    const fake = new FakeFetch();
    fake.queueToken('TOK-1');
    fake.queueRaw(401, '');
    fake.queueToken('TOK-2');
    fake.queueRaw(401, `{"error":{"code":"InvalidAuthenticationToken","message":"token ${SECRET}"}}`);
    const mailer = makeMailer(fake, new RecordingLogger());
    await assert.rejects(mailer.send(simpleMessage()), (err: unknown) => {
        assert.ok(err instanceof GraphError);
        assert.equal(err.httpStatus, 401);
        assert.ok(err.message.includes('InvalidAuthenticationToken'));
        assert.ok(!err.message.includes(SECRET));
        return true;
    });
});

test('a transport failure becomes a GraphError, not a bare exception', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.failTransport('socket hang up');
    const mailer = makeMailer(fake, new RecordingLogger());
    await assert.rejects(mailer.send(simpleMessage()), (err: unknown) => {
        assert.ok(err instanceof GraphError);
        assert.ok(err.message.includes('could not reach the Microsoft Graph API'));
        return true;
    });
});

test('a poisoned graph base URL never leaks its credentials', () => {
    assert.throws(
        () => makeMailer(new FakeFetch(), new RecordingLogger(), {graphBaseUrl: `https://user:${SECRET}@evil.test`}),
        (err: unknown) => {
            assert.ok(err instanceof GraphError);
            assert.ok(!err.message.includes(SECRET));
            assert.ok(err.message.includes('graph_base_url'));
            return true;
        }
    );
});

test('a poisoned login base URL never leaks its credentials', async () => {
    const logger = new RecordingLogger();
    assert.throws(
        () => makeMailer(new FakeFetch(), logger, {loginBaseUrl: `https://host.test?access_token=${SECRET}`}),
        (err: unknown) => {
            assert.ok(err instanceof GraphError);
            assert.ok(!err.message.includes(SECRET));
            return true;
        }
    );
    assert.ok(!logger.everything().includes(SECRET));
});

test('the raw MIME path base64-encodes, forces From and warns', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueRaw(202, '');
    const logger = new RecordingLogger();
    const mailer = makeMailer(fake, logger);

    const mime = 'From: Ghost <ghost@blog.example.com>\r\nTo: user@example.com\r\nSubject: Magic link\r\n\r\nBody here\r\n';
    await mailer.sendMime(new TextEncoder().encode(mime));

    assert.equal(fake.urls()[1], `${GRAPH}/v1.0/users/noreply%40example.com/sendMail?saveToSentItems=false`);
    assert.equal(fake.requests[1]?.headers['Content-Type'], 'text/plain');
    const decoded = Buffer.from(fake.bodyText(1), 'base64').toString('utf8');
    assert.ok(decoded.includes('From: Ghost <noreply@example.com>'));
    assert.ok(decoded.includes('Reply-To: ghost@blog.example.com'));
    assert.ok(decoded.includes('Body here'));
    assert.ok(logger.warnings[0]?.includes('ghost@blog.example.com'));
});

test('an oversized MIME message is refused loudly, naming the limit', async () => {
    const mailer = makeMailer(new FakeFetch(), new RecordingLogger());
    await assert.rejects(mailer.sendMime(new Uint8Array(3_200_000)), /3 MB/);
});

test('a Graph rejection of MIME carries the redacted error body', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueJson(400, {error: {code: 'ErrorMimeContentInvalidBase64String', message: 'Invalid base64 string for MIME content.'}});
    const mailer = makeMailer(fake, new RecordingLogger());
    await assert.rejects(
        mailer.sendMime(new TextEncoder().encode('From: a@b\r\nTo: c@d\r\n\r\nx')),
        /ErrorMimeContentInvalidBase64String/
    );
});
