/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import {base64Encode, utf8Encode} from './base64.ts';

export interface Address {
    address: string;
    name?: string;
}

export interface AttachmentInput {
    name: string;
    /** Raw bytes, or a string encoded as UTF-8. */
    content: Uint8Array | string;
    contentType?: string;
    /** A non-empty contentId makes the attachment inline (CID images). */
    contentId?: string;
}

export class Attachment {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly contentId: string;

    constructor(input: AttachmentInput) {
        this.name = input.name;
        this.bytes = typeof input.content === 'string' ? utf8Encode(input.content) : input.content;
        this.contentType = input.contentType ?? 'application/octet-stream';
        this.contentId = input.contentId ?? '';
    }

    get size(): number {
        return this.bytes.length;
    }

    get isInline(): boolean {
        return this.contentId !== '';
    }

    toGraphFileAttachment(): Record<string, unknown> {
        const attachment: Record<string, unknown> = {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: this.name,
            contentType: this.contentType,
            contentBytes: base64Encode(this.bytes)
        };
        if (this.isInline) {
            attachment['isInline'] = true;
            attachment['contentId'] = this.contentId;
        }
        return attachment;
    }
}

export interface MessageInput {
    from?: Address;
    to?: readonly Address[];
    cc?: readonly Address[];
    bcc?: readonly Address[];
    replyTo?: readonly Address[];
    subject?: string;
    html?: string;
    text?: string;
    attachments?: readonly AttachmentInput[];
}

/** A transport-neutral message, mapped to Graph's message resource by `toGraphMessage`. */
export class Message {
    from: Address | undefined;
    readonly to: Address[] = [];
    readonly cc: Address[] = [];
    readonly bcc: Address[] = [];
    readonly replyTo: Address[] = [];
    subject = '';
    html = '';
    text = '';
    readonly attachments: Attachment[] = [];

    constructor(input: MessageInput = {}) {
        if (input.from && input.from.address.trim() !== '') {
            this.from = trimAddress(input.from);
        }
        for (const a of input.to ?? []) {
            this.addRecipient(this.to, a);
        }
        for (const a of input.cc ?? []) {
            this.addRecipient(this.cc, a);
        }
        for (const a of input.bcc ?? []) {
            this.addRecipient(this.bcc, a);
        }
        for (const a of input.replyTo ?? []) {
            this.addRecipient(this.replyTo, a);
        }
        this.subject = input.subject ?? '';
        this.html = input.html ?? '';
        this.text = input.text ?? '';
        for (const a of input.attachments ?? []) {
            this.attachments.push(new Attachment(a));
        }
    }

    hasRecipients(): boolean {
        return this.to.length > 0 || this.cc.length > 0 || this.bcc.length > 0;
    }

    hasReplyTo(): boolean {
        return this.replyTo.length > 0;
    }

    setFrom(address: string, name?: string): void {
        this.from = name !== undefined && name !== '' ? {address, name} : {address};
    }

    addReplyTo(address: string, name?: string): void {
        this.addRecipient(this.replyTo, name !== undefined && name !== '' ? {address, name} : {address});
    }

    /** The Graph `message` resource minus attachments — those differ per send path. */
    toGraphMessage(): Record<string, unknown> {
        const message: Record<string, unknown> = {
            subject: this.subject,
            body: this.html !== ''
                ? {contentType: 'HTML', content: this.html}
                : {contentType: 'Text', content: this.text},
            toRecipients: this.to.map(toGraphRecipient)
        };
        if (this.cc.length > 0) {
            message['ccRecipients'] = this.cc.map(toGraphRecipient);
        }
        if (this.bcc.length > 0) {
            message['bccRecipients'] = this.bcc.map(toGraphRecipient);
        }
        if (this.replyTo.length > 0) {
            message['replyTo'] = this.replyTo.map(toGraphRecipient);
        }
        if (this.from !== undefined) {
            message['from'] = toGraphRecipient(this.from);
        }
        return message;
    }

    private addRecipient(list: Address[], address: Address): void {
        const trimmed = trimAddress(address);
        if (trimmed.address !== '') {
            list.push(trimmed);
        }
    }
}

function trimAddress(a: Address): Address {
    const name = a.name?.trim() ?? '';
    return name !== '' ? {address: a.address.trim(), name} : {address: a.address.trim()};
}

function toGraphRecipient(a: Address): Record<string, unknown> {
    const emailAddress: Record<string, string> = {address: a.address};
    if (a.name !== undefined && a.name !== '') {
        emailAddress['name'] = a.name;
    }
    return {emailAddress};
}
