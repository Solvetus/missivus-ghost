import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Credentials} from './credentials.ts';
import {GraphError} from './errors.ts';
import {Redactor} from './redactor.ts';
import {EXPIRY_MARGIN_SECONDS, TokenProvider} from './token-provider.ts';
import {ArrayTokenCache, FakeFetch} from './test-support/fakes.ts';

const SECRET = 'hunter2-correct-horse-battery';

function makeProvider(fake: FakeFetch, cache: ArrayTokenCache, loginBaseUrl = 'https://login.example.test'): TokenProvider {
    const credentials = new Credentials('tenant-id', 'client-id').withClientSecret(SECRET);
    return new TokenProvider(credentials, fake.fetch, cache, new Redactor([SECRET]), loginBaseUrl, () => cache.now);
}

test('the token request carries the client-credentials grant to the tenant URL', async () => {
    const fake = new FakeFetch();
    fake.queueToken('TOK-1');
    const provider = makeProvider(fake, new ArrayTokenCache());

    assert.equal(await provider.getToken(), 'TOK-1');
    assert.equal(fake.urls()[0], 'https://login.example.test/tenant-id/oauth2/v2.0/token');
    const form = fake.form(0);
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(form.get('client_id'), 'client-id');
    assert.equal(form.get('scope'), 'https://graph.microsoft.com/.default');
    assert.equal(form.get('client_secret'), SECRET);
    assert.equal(fake.requests[0]?.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('a cached token expires five minutes early and is then refreshed', async () => {
    const fake = new FakeFetch();
    fake.queueToken('TOK-1', 3600);
    fake.queueToken('TOK-2', 3600);
    const cache = new ArrayTokenCache();
    const provider = makeProvider(fake, cache);

    assert.equal(await provider.getToken(), 'TOK-1');
    assert.equal(cache.writes, 1);
    // TTL is exactly expires_in minus the 300-second margin.
    const key = `missivus.token.tenant-id|client-id|secret`;
    assert.equal(cache.ttlOf(key), 3600 - EXPIRY_MARGIN_SECONDS);

    cache.advance(3299);
    assert.equal(await provider.getToken(), 'TOK-1');
    assert.equal(fake.requests.length, 1);

    cache.advance(2);
    assert.equal(await provider.getToken(), 'TOK-2');
    assert.equal(fake.requests.length, 2);
});

test('a very short-lived token is used but not cached', async () => {
    const fake = new FakeFetch();
    fake.queueToken('TOK-SHORT', 60);
    const cache = new ArrayTokenCache();
    const provider = makeProvider(fake, cache);

    assert.equal(await provider.getToken(), 'TOK-SHORT');
    assert.equal(cache.writes, 0);
});

test('invalidate drops the cached token', async () => {
    const fake = new FakeFetch();
    fake.queueToken('TOK-1');
    fake.queueToken('TOK-2');
    const cache = new ArrayTokenCache();
    const provider = makeProvider(fake, cache);

    await provider.getToken();
    await provider.invalidate();
    assert.equal(await provider.getToken(), 'TOK-2');
    assert.equal(fake.requests.length, 2);
});

test('a rejected token request keeps the redacted Entra body', async () => {
    const fake = new FakeFetch();
    fake.queueRaw(401, `{"error":"invalid_client","error_description":"AADSTS7000215 secret ${SECRET}"}`);
    const provider = makeProvider(fake, new ArrayTokenCache());

    await assert.rejects(provider.getToken(), (err: unknown) => {
        assert.ok(err instanceof GraphError);
        assert.ok(err.message.includes('Microsoft rejected the token request'));
        assert.ok(err.message.includes('invalid_client'));
        assert.ok(!err.message.includes(SECRET));
        return true;
    });
});

test('an unreachable token endpoint fails loudly without leaking', async () => {
    const fake = new FakeFetch();
    fake.failTransport(`connect failed to https://user:${SECRET}@somewhere.test`);
    const provider = makeProvider(fake, new ArrayTokenCache());

    await assert.rejects(provider.getToken(), (err: unknown) => {
        assert.ok(err instanceof GraphError);
        assert.ok(err.message.includes('could not reach the Microsoft token endpoint'));
        assert.ok(!err.message.includes(SECRET));
        return true;
    });
});

test('a token response with no access_token is refused', async () => {
    const fake = new FakeFetch();
    fake.queueJson(200, {token_type: 'Bearer'});
    const provider = makeProvider(fake, new ArrayTokenCache());
    await assert.rejects(provider.getToken(), /contained no access_token/);
});

test('a non-https login base URL is refused with nothing leaving the process', () => {
    const fake = new FakeFetch();
    assert.throws(
        () => makeProvider(fake, new ArrayTokenCache(), 'http://login.evil.test'),
        (err: unknown) => err instanceof GraphError && err.message.includes('login_base_url')
    );
    assert.equal(fake.requests.length, 0);
});

test('missing configuration is collected into one loud error', async () => {
    const fake = new FakeFetch();
    const credentials = new Credentials('', '');
    const provider = new TokenProvider(credentials, fake.fetch, new ArrayTokenCache(), new Redactor());
    await assert.rejects(provider.getToken(), /missing tenant ID, client ID, client secret/);
});
