import assert from 'node:assert/strict';
import {constants, createHash, createPublicKey, verify as cryptoVerify, X509Certificate} from 'node:crypto';
import {after, test} from 'node:test';
import {buildClientAssertion} from './client-assertion.ts';
import {Credentials} from './credentials.ts';
import {GraphError} from './errors.ts';
import {loadCertificate} from './node.ts';
import {Redactor} from './redactor.ts';
import {TokenProvider} from './token-provider.ts';
import {ArrayTokenCache, FakeFetch, makeTestCertificate} from './test-support/fakes.ts';

const plain = makeTestCertificate();
const withPassphrase = makeTestCertificate('test-passphrase-value');
after(() => {
    plain.cleanup();
    withPassphrase.cleanup();
});

function decodeSegment(segment: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

test('a PS256 assertion has the right header, claims and signature', async () => {
    const credential = {privateKeyPem: plain.keyPem, certificatePem: plain.certPem};
    const jwt = await buildClientAssertion('tenant-id', 'client-id', credential, 1_700_000_000);
    const [h, c, s] = jwt.split('.');
    assert.ok(h !== undefined && c !== undefined && s !== undefined);

    const header = decodeSegment(h);
    assert.equal(header['alg'], 'PS256');
    assert.equal(header['typ'], 'JWT');
    // x5t#S256 must equal the SHA-256 of the certificate DER.
    const der = new X509Certificate(plain.certPem).raw;
    assert.equal(header['x5t#S256'], createHash('sha256').update(der).digest('base64url'));

    const claims = decodeSegment(c);
    assert.equal(claims['aud'], 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token');
    assert.equal(claims['iss'], 'client-id');
    assert.equal(claims['sub'], 'client-id');
    assert.equal(claims['iat'], 1_700_000_000);
    assert.equal(claims['nbf'], 1_700_000_000);
    assert.equal(claims['exp'], 1_700_000_300);
    assert.ok(typeof claims['jti'] === 'string' && claims['jti'].length >= 36);

    const publicKey = createPublicKey(plain.certPem);
    const ok = cryptoVerify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        {key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32},
        Buffer.from(s, 'base64url')
    );
    assert.equal(ok, true, 'PS256 signature must verify under an independent implementation');
});

test('the RS256 escape hatch signs with the SHA-1 x5t header and verifies', async () => {
    const credential = {privateKeyPem: plain.keyPem, certificatePem: plain.certPem, algorithm: 'RS256' as const};
    const jwt = await buildClientAssertion('tenant-id', 'client-id', credential, 1_700_000_000);
    const [h, c, s] = jwt.split('.');
    assert.ok(h !== undefined && c !== undefined && s !== undefined);

    const header = decodeSegment(h);
    assert.equal(header['alg'], 'RS256');
    const der = new X509Certificate(plain.certPem).raw;
    assert.equal(header['x5t'], createHash('sha1').update(der).digest('base64url'));

    const ok = cryptoVerify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        {key: createPublicKey(plain.certPem), padding: constants.RSA_PKCS1_PADDING},
        Buffer.from(s, 'base64url')
    );
    assert.equal(ok, true);
});

test('each assertion carries a fresh jti', async () => {
    const credential = {privateKeyPem: plain.keyPem, certificatePem: plain.certPem};
    const a = await buildClientAssertion('t', 'c', credential, 1_700_000_000);
    const b = await buildClientAssertion('t', 'c', credential, 1_700_000_000);
    const jtiOf = (jwt: string): unknown => decodeSegment(jwt.split('.')[1] ?? '')['jti'];
    assert.notEqual(jtiOf(a), jtiOf(b));
});

test('certificate auth sends a client_assertion instead of a secret', async () => {
    const fake = new FakeFetch();
    fake.queueToken('TOK-CERT');
    const credentials = new Credentials('tenant-id', 'client-id')
        .withCertificate({privateKeyPem: plain.keyPem, certificatePem: plain.certPem});
    const cache = new ArrayTokenCache();
    const provider = new TokenProvider(credentials, fake.fetch, cache, new Redactor(), 'https://login.example.test', () => cache.now);

    assert.equal(await provider.getToken(), 'TOK-CERT');
    const form = fake.form(0);
    assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    assert.equal(form.get('client_secret'), null);
    assert.match(form.get('client_assertion') ?? '', /^eyJ/);
});

test('a wrong passphrase fails naming only the path', async () => {
    const {writeFileSync} = await import('node:fs');
    const combined = `${withPassphrase.dir}/combined.pem`;
    writeFileSync(combined, withPassphrase.pem);
    assert.throws(
        () => loadCertificate(combined, 'not-the-passphrase'),
        (err: unknown) => {
            assert.ok(err instanceof GraphError);
            assert.ok(err.message.includes(combined));
            assert.ok(!err.message.includes('not-the-passphrase'));
            return true;
        }
    );
});

test('a correct passphrase yields an importable PKCS#8 key', async () => {
    const {writeFileSync} = await import('node:fs');
    const combined = `${withPassphrase.dir}/combined-ok.pem`;
    writeFileSync(combined, withPassphrase.pem);
    const credential = loadCertificate(combined, 'test-passphrase-value');
    assert.ok(credential.privateKeyPem.includes('BEGIN PRIVATE KEY'));
    const jwt = await buildClientAssertion('t', 'c', credential, 1_700_000_000);
    assert.match(jwt, /^eyJ/);
});

test('a missing certificate file names only the path', () => {
    assert.throws(
        () => loadCertificate('/nonexistent/missivus.pem'),
        (err: unknown) => err instanceof GraphError && err.message.includes('/nonexistent/missivus.pem')
    );
});
