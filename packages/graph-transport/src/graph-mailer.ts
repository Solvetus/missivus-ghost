/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import {base64Encode} from './base64.ts';
import type {FetchLike, Logger} from './contracts.ts';
import {nullLogger} from './contracts.ts';
import {normaliseEndpoint} from './endpoint.ts';
import {GraphError} from './errors.ts';
import {forceFrom} from './mime.ts';
import type {Attachment, Message} from './message.ts';
import {Redactor} from './redactor.ts';
import type {TokenProvider} from './token-provider.ts';
import {errorText} from './token-provider.ts';

/** A single fileAttachment must be under 3 MB; above that Graph requires an upload session. */
export const LARGE_ATTACHMENT_THRESHOLD = 3145728;

/** The whole sendMail request is bounded at 4 MB, so the total matters too. */
export const TOTAL_INLINE_BUDGET = 3145728;

/** Under 4 MB as Microsoft advises, and an exact multiple of 320 KiB. */
export const UPLOAD_CHUNK_BYTES = 3276800;

export const API_VERSION = 'v1.0';

interface HttpReply {
    status: number;
    body: string;
}

export interface GraphMailerOptions {
    sender: string;
    saveToSentItems?: boolean;
    graphBaseUrl?: string;
    logger?: Logger;
    redactor?: Redactor;
}

/**
 * Two send paths, chosen automatically per message:
 *
 *  - Direct: POST /users/{sender}/sendMail with attachments inline as base64. Graph accepts
 *    inline fileAttachments below 3 MB, and bounds the whole request at 4 MB.
 *  - Draft: for anything larger, create a draft, push each big file through an upload session in
 *    chunks, then send the draft. Large attachments must never fail on size, so this choice is
 *    automatic and total-aware — there is no setting that can route a large file down the inline
 *    path.
 *
 * A third entry point, sendMime, carries a raw RFC 5322 message verbatim (the Ghost shim's path):
 * same URL, base64 body, text/plain content type.
 */
export class GraphMailer {
    private readonly tokens: TokenProvider;
    private readonly fetchFn: FetchLike;
    private readonly redactor: Redactor;
    private readonly sender: string;
    private readonly saveToSentItems: boolean;
    private readonly graphBaseUrl: string;
    private readonly logger: Logger;

    constructor(tokens: TokenProvider, fetchFn: FetchLike, options: GraphMailerOptions) {
        this.tokens = tokens;
        this.fetchFn = fetchFn;
        this.redactor = options.redactor ?? new Redactor();
        this.sender = options.sender.trim();
        this.saveToSentItems = options.saveToSentItems === true;
        // A bearer token goes to this host. It is refused unless it is a bare https origin.
        this.graphBaseUrl = normaliseEndpoint(options.graphBaseUrl ?? 'https://graph.microsoft.com', 'graph_base_url');
        this.logger = options.logger ?? nullLogger;
    }

    /** @throws GraphError on any failure. Never returns false, never fails quietly. */
    async send(message: Message): Promise<void> {
        this.requireSender();
        if (!message.hasRecipients()) {
            throw new GraphError('Missivus: refusing to send a message with no recipients');
        }
        this.applyForcedFrom(message);
        if (this.needsDraftPath(message.attachments)) {
            await this.sendViaDraft(message);
        } else {
            await this.sendDirect(message);
        }
    }

    /**
     * Send a raw MIME message verbatim. From is forced to the sender at header level (the
     * requested address is preserved as Reply-To unless one exists). The raw-MIME call shares
     * the request ceiling of the JSON path, so oversized messages are refused loudly — large
     * attachments belong on the structured send() path.
     */
    async sendMime(mime: Uint8Array): Promise<void> {
        this.requireSender();
        if (mime.length >= TOTAL_INLINE_BUDGET) {
            throw new GraphError(
                'Missivus: the MIME message is 3 MB or larger, which the raw-MIME path cannot'
                + ' carry. Send large attachments through the structured API instead.'
            );
        }
        const forced = forceFrom(mime, this.sender);
        if (forced.changed && forced.requestedFrom !== '') {
            this.logger.warning(this.redactor.redact(
                `Missivus: forcing From to ${this.sender}; the message asked for ${forced.requestedFrom}.`
                + ' Set the application\'s from address to the shared mailbox to silence this.'
            ));
        }
        const url = this.userUrl(`/sendMail${this.saveToSentItems ? '' : '?saveToSentItems=false'}`);
        const response = await this.authorisedRequest(url, base64Encode(forced.mime), 'text/plain');
        if (response.status !== 202) {
            throw this.failure('Missivus: Graph rejected the message', response);
        }
    }

    private needsDraftPath(attachments: readonly Attachment[]): boolean {
        let total = 0;
        for (const attachment of attachments) {
            if (attachment.size >= LARGE_ATTACHMENT_THRESHOLD) {
                return true;
            }
            total += attachment.size;
        }
        return total >= TOTAL_INLINE_BUDGET;
    }

    private async sendDirect(message: Message): Promise<void> {
        const graphMessage = message.toGraphMessage();
        if (message.attachments.length > 0) {
            graphMessage['attachments'] = message.attachments.map(a => a.toGraphFileAttachment());
        }
        const payload = {message: graphMessage, saveToSentItems: this.saveToSentItems};
        const response = await this.authorisedRequest(this.userUrl('/sendMail'), JSON.stringify(payload), 'application/json');
        if (response.status !== 202) {
            throw this.failure('Missivus: Graph rejected the message', response);
        }
    }

    private async sendViaDraft(message: Message): Promise<void> {
        const large: Attachment[] = [];
        const small: Attachment[] = [];
        for (const attachment of message.attachments) {
            (attachment.size >= LARGE_ATTACHMENT_THRESHOLD ? large : small).push(attachment);
        }

        const draftMessage = message.toGraphMessage();
        if (small.length > 0) {
            // Small and inline attachments ride along in the draft, which keeps CID images working.
            draftMessage['attachments'] = small.map(a => a.toGraphFileAttachment());
        }

        const created = await this.authorisedRequest(this.userUrl('/messages'), JSON.stringify(draftMessage), 'application/json');
        if (created.status !== 201) {
            throw this.failure(
                'Missivus: Graph refused to create the draft message. This step needs the'
                + ' Mail.ReadWrite application permission in addition to Mail.Send',
                created
            );
        }
        const draftId = stringField(created.body, 'id');
        if (draftId === '') {
            throw new GraphError('Missivus: the created draft had no id');
        }

        try {
            for (const attachment of large) {
                await this.uploadLargeAttachment(draftId, attachment);
            }
            const sent = await this.authorisedRequest(this.userUrl(`/messages/${encodeURIComponent(draftId)}/send`), '', 'application/json');
            if (sent.status !== 202) {
                throw this.failure('Missivus: Graph rejected the draft send', sent);
            }
        } catch (err) {
            // The HTTP seam is deliberately small, and a silent orphan in the shared mailbox
            // would be worse than a noisy log line: name the draft so an operator can remove it.
            this.logger.error(this.redactor.redact(
                'Missivus: sending failed after the draft was created. An unsent draft may remain'
                + ` in ${this.sender} with id ${draftId}`
            ));
            throw err;
        }
    }

    private async uploadLargeAttachment(draftId: string, attachment: Attachment): Promise<void> {
        const sessionResponse = await this.authorisedRequest(
            this.userUrl(`/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`),
            JSON.stringify({
                AttachmentItem: {
                    attachmentType: 'file',
                    name: attachment.name,
                    size: attachment.size,
                    contentType: attachment.contentType,
                    isInline: attachment.isInline
                }
            }),
            'application/json'
        );
        if (sessionResponse.status !== 201) {
            throw this.failure(`Missivus: Graph refused an upload session for "${attachment.name}"`, sessionResponse);
        }
        const uploadUrl = stringField(sessionResponse.body, 'uploadUrl');
        if (uploadUrl === '') {
            throw new GraphError('Missivus: the upload session had no uploadUrl');
        }

        const total = attachment.size;
        for (let offset = 0; offset < total; offset += UPLOAD_CHUNK_BYTES) {
            const chunk = attachment.bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES);
            const end = offset + chunk.length - 1;
            const isFinalChunk = end + 1 >= total;

            let chunkResponse: HttpReply;
            try {
                // No Authorization header: uploadUrl is pre-authenticated for Microsoft's upload
                // host, and attaching our Graph bearer token to a different host would leak it.
                const raw = await this.fetchFn(uploadUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': String(chunk.length),
                        'Content-Range': `bytes ${String(offset)}-${String(end)}/${String(total)}`
                    },
                    body: chunk
                });
                chunkResponse = {status: raw.status, body: await raw.text()};
            } catch (err) {
                // The upload URL is itself a credential — anyone holding it can write to that
                // draft — so it is masked out of the message rather than left for a log to keep.
                throw new GraphError(
                    'Missivus: could not reach the attachment upload endpoint: '
                    + this.redactor.redact(errorText(err).split(uploadUrl).join(Redactor.MASK))
                );
            }

            // Intermediate chunks answer 200; the last one answers 201.
            const expected = isFinalChunk ? 201 : 200;
            if (chunkResponse.status !== expected) {
                throw this.failure(
                    `Missivus: uploading "${attachment.name}" failed at bytes ${String(offset)}-${String(end)} of ${String(total)}`,
                    chunkResponse
                );
            }
        }
    }

    /**
     * App-only Graph sends as /users/{sender} and Exchange rejects a mismatched From, so the
     * configured mailbox always wins. When the message asked for something else, say so loudly
     * and keep the requested address reachable as a Reply-To rather than dropping it.
     */
    private applyForcedFrom(message: Message): void {
        const requested = message.from?.address.trim() ?? '';
        const name = message.from?.name;
        message.setFrom(this.sender, name);

        if (requested === '' || requested.toLowerCase() === this.sender.toLowerCase()) {
            return;
        }
        this.logger.warning(this.redactor.redact(
            `Missivus: forcing From to ${this.sender}; the message asked for ${requested}.`
            + ' Set the application\'s from address to the shared mailbox to silence this.'
        ));
        // Only when nothing else claimed Reply-To, so an explicit one is never clobbered.
        if (!message.hasReplyTo()) {
            message.addReplyTo(requested, name);
        }
    }

    private async authorisedRequest(url: string, body: string, contentType: string): Promise<HttpReply> {
        let response = await this.post(url, body, contentType, await this.tokens.getToken());
        if (response.status === 401) {
            // A token can be revoked mid-life. One retry with a fresh one, then give up — a loop
            // here would hammer Entra on a genuinely broken app registration.
            this.logger.warning('Missivus: Graph returned 401; refreshing the token and retrying once');
            await this.tokens.invalidate();
            response = await this.post(url, body, contentType, await this.tokens.getToken());
        }
        return response;
    }

    private async post(url: string, body: string, contentType: string, token: string): Promise<HttpReply> {
        try {
            const response = await this.fetchFn(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': contentType
                },
                body
            });
            return {status: response.status, body: await response.text()};
        } catch (err) {
            // A transport failure must surface as a GraphError like every other failure, or it
            // would sail past a host's catch and skip its failure policy entirely.
            throw new GraphError(
                `Missivus: could not reach the Microsoft Graph API: ${this.redactor.redact(errorText(err))}`
            );
        }
    }

    private userUrl(suffix: string): string {
        return `${this.graphBaseUrl}/${API_VERSION}/users/${encodeURIComponent(this.sender)}${suffix}`;
    }

    private requireSender(): void {
        if (this.sender === '') {
            throw new GraphError('Missivus is not configured: missing sender mailbox');
        }
    }

    private failure(summary: string, response: HttpReply): GraphError {
        return new GraphError(
            `${summary} (HTTP ${String(response.status)})`,
            response.status,
            this.redactor.redactBody(response.body)
        );
    }
}

function stringField(body: string, field: string): string {
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null) {
            const value = (parsed as Record<string, unknown>)[field];
            return typeof value === 'string' ? value : '';
        }
    } catch {
        // fall through
    }
    return '';
}
