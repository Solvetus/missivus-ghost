import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GraphError} from '@missivus/graph-transport';
import {addMissingBccHeader, buildDeliver} from './deliver.ts';
import type {SmtpEnvelope} from './smtp-server.ts';
import {FakeFetch, RecordingLogger, testConfig} from './test-support/fakes.ts';

const SECRET = 'hunter2-correct-horse-battery';
const MIME = 'From: Ghost <ghost@blog.example.com>\r\nTo: member@example.com\r\nSubject: Magic link\r\n\r\nSign in here\r\n';
const envelope: SmtpEnvelope = {from: 'ghost@blog.example.com', to: ['member@example.com']};

test('a delivery goes to Graph as base64 MIME with the From forced', async () => {
    const fake = new FakeFetch();
    fake.queueToken();
    fake.queueRaw(202, '');
    const logger = new RecordingLogger();
    const deliver = buildDeliver(testConfig(), logger, {fetch: fake.fetch});

    await deliver(envelope, Buffer.from(MIME));

    assert.equal(fake.requests[1]?.url, 'https://graph.example.test/v1.0/users/noreply%40example.com/sendMail?saveToSentItems=false');
    const decoded = Buffer.from(String(fake.requests[1]?.body ?? ''), 'base64').toString('utf8');
    assert.ok(decoded.includes('From: Ghost <noreply@example.com>'));
    assert.ok(decoded.includes('Reply-To: ghost@blog.example.com'));
    assert.ok(logger.warnings.some(w => w.includes('forcing From')));
});

test('with the fallback off a Graph failure is logged and rethrown with the Microsoft error', async () => {
    const fake = new FakeFetch();
    fake.queueRaw(400, `{"error":"invalid_request","error_description":"AADSTS90002: Tenant 'tenant-id' not found. Secret was ${SECRET}"}`);
    const logger = new RecordingLogger();
    const deliver = buildDeliver(testConfig(), logger, {fetch: fake.fetch});

    await assert.rejects(deliver(envelope, Buffer.from(MIME)), (err: unknown) => {
        assert.ok(err instanceof GraphError);
        assert.ok(err.message.includes('AADSTS90002'), 'the Microsoft error must survive to the SMTP reply');
        assert.ok(!err.message.includes(SECRET));
        return true;
    });
    assert.ok(logger.errors.some(e => e.includes('sending over Microsoft Graph failed')));
    assert.ok(!logger.everything().includes(SECRET));
});

test('with the fallback on the message is relayed and the Graph failure still logged at error level', async () => {
    const fake = new FakeFetch();
    fake.queueRaw(400, '{"error":"invalid_request","error_description":"AADSTS90002"}');
    const logger = new RecordingLogger();
    const relayed: {envelope: SmtpEnvelope; mime: Uint8Array}[] = [];
    const deliver = buildDeliver(
        testConfig({fallback: {host: 'smtp.fallback.test', port: 587, secure: false, user: '', pass: ''}}),
        logger,
        {
            fetch: fake.fetch,
            relay: (config, env, mime) => {
                assert.equal(config.host, 'smtp.fallback.test');
                relayed.push({envelope: env, mime});
                return Promise.resolve();
            }
        }
    );

    await deliver(envelope, Buffer.from(MIME));
    assert.equal(relayed.length, 1);
    assert.equal(Buffer.from(relayed[0]?.mime ?? []).toString('utf8'), MIME, 'the fallback relays the unmodified message');
    assert.ok(logger.errors.some(e => e.includes('sending over Microsoft Graph failed')));
    assert.ok(logger.errors.some(e => e.includes('falling back')));
});

test('a failing fallback combines both errors, redacted', async () => {
    const fake = new FakeFetch();
    fake.queueRaw(400, '{"error_description":"AADSTS90002"}');
    const logger = new RecordingLogger();
    const deliver = buildDeliver(
        testConfig({fallback: {host: 'smtp.fallback.test', port: 587, secure: false, user: 'u', pass: 'fallback-password-value'}}),
        logger,
        {fetch: fake.fetch, relay: () => Promise.reject(new Error('connect refused with pass fallback-password-value'))}
    );

    await assert.rejects(deliver(envelope, Buffer.from(MIME)), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('AADSTS90002'));
        assert.ok(err.message.includes('SMTP fallback also failed'));
        assert.ok(!err.message.includes('fallback-password-value'));
        return true;
    });
});

test('an unconfigured shim refuses every message loudly, naming the missing parts', async () => {
    const logger = new RecordingLogger();
    const deliver = buildDeliver(testConfig({tenantId: '', clientSecret: ''}), logger);
    await assert.rejects(deliver(envelope, Buffer.from(MIME)), /missing tenant ID, client secret or certificate path/);
    assert.equal(logger.errors.length, 1);
});

test('envelope recipients missing from the headers are added as Bcc', () => {
    const out = Buffer.from(addMissingBccHeader(
        Buffer.from(MIME),
        {from: 'x@y.test', to: ['member@example.com', 'hidden@example.com']}
    )).toString('utf8');
    assert.ok(out.includes('Bcc: hidden@example.com'));
    assert.ok(!out.includes('Bcc: member@example.com'));

    const untouched = Buffer.from(addMissingBccHeader(Buffer.from(MIME), envelope)).toString('utf8');
    assert.equal(untouched, MIME);
});

test('a poisoned graph base URL fails loudly without leaking its credentials', async () => {
    const logger = new RecordingLogger();
    assert.throws(
        () => buildDeliver(testConfig({graphBaseUrl: `https://user:${SECRET}@evil.test`}), logger),
        (err: unknown) => {
            assert.ok(err instanceof GraphError);
            assert.ok(!err.message.includes(SECRET));
            assert.ok(err.message.includes('graph_base_url'));
            return true;
        }
    );
    assert.ok(!logger.everything().includes(SECRET));
});
