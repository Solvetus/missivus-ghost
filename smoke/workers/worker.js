// Workers compatibility check: the built transport, token call mocked, no Node APIs.
import {createGraphTransport, Message} from '../../packages/graph-transport/dist/index.js';

export default {
    async fetch() {
        const calls = [];
        const mockFetch = (url) => {
            calls.push(url);
            const isToken = url.includes('/oauth2/v2.0/token');
            return Promise.resolve({
                status: isToken ? 200 : 202,
                text: () => Promise.resolve(isToken ? JSON.stringify({access_token: 'MOCK-TOKEN-VALUE', expires_in: 3600}) : '')
            });
        };
        const mailer = createGraphTransport({
            tenantId: 'tenant-placeholder', clientId: 'client-placeholder',
            clientSecret: 'secret-placeholder-value', sender: 'noreply@example.com', fetch: mockFetch
        });
        await mailer.send(new Message({to: [{address: 'user@example.com'}], subject: 'workers check', html: '<p>hi</p>'}));
        return new Response(`missivus graph-transport OK on Workers; calls: ${JSON.stringify(calls)}`);
    }
};
