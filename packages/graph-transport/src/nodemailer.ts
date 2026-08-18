/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * The Nodemailer transport adapter. It implements Nodemailer's transport contract structurally
 * ({name, version, send}), so this module has no runtime dependency on nodemailer itself — the
 * host application supplies nodemailer and calls `nodemailer.createTransport(...)` with it.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import type {GraphMailer} from './graph-mailer.ts';
import type {Address, AttachmentInput, MessageInput} from './message.ts';
import {Message} from './message.ts';
import type {GraphTransportOptions} from './index.ts';
import {createGraphTransport} from './index.ts';

/** The slice of Nodemailer's mail object the adapter reads. */
export interface NodemailerMailData {
    from?: string | NodemailerAddress;
    to?: NodemailerAddressList;
    cc?: NodemailerAddressList;
    bcc?: NodemailerAddressList;
    replyTo?: string | NodemailerAddress;
    subject?: string;
    html?: string | {toString(): string};
    text?: string | {toString(): string};
    attachments?: readonly NodemailerAttachment[];
}

export interface NodemailerAddress {
    name?: string;
    address?: string;
}

export type NodemailerAddressList =
    string | NodemailerAddress | readonly (string | NodemailerAddress)[];

export interface NodemailerAttachment {
    filename?: string | false;
    content?: string | Uint8Array | {toString(): string};
    contentType?: string;
    cid?: string;
    encoding?: string;
}

export interface NodemailerMail {
    data: NodemailerMailData;
}

export interface NodemailerTransport {
    name: string;
    version: string;
    send(mail: NodemailerMail, done: (err: Error | null, info?: unknown) => void): void;
}

/** Build a Nodemailer transport backed by an existing GraphMailer. */
export function nodemailerTransport(mailer: GraphMailer): NodemailerTransport {
    return {
        name: 'MissivusGraph',
        version: '0.1.0',
        send(mail, done) {
            Promise.resolve()
                .then(() => mailer.send(toMessage(mail.data)))
                .then(() => {
                    const envelope = {
                        from: firstAddress(mail.data.from)?.address ?? '',
                        to: addressList(mail.data.to).map(a => a.address)
                    };
                    done(null, {envelope, messageId: '', accepted: envelope.to, rejected: [], response: '202 Accepted by Microsoft Graph'});
                })
                .catch((err: unknown) => {
                    done(err instanceof Error ? err : new Error(String(err)));
                });
        }
    };
}

/** One call from flat options to a Nodemailer-ready transport. */
export function createNodemailerTransport(options: GraphTransportOptions): NodemailerTransport {
    return nodemailerTransport(createGraphTransport(options));
}

export function toMessage(data: NodemailerMailData): Message {
    const input: MessageInput = {
        to: addressList(data.to),
        cc: addressList(data.cc),
        bcc: addressList(data.bcc),
        replyTo: addressList(data.replyTo),
        subject: data.subject ?? '',
        html: contentToString(data.html),
        text: contentToString(data.text),
        attachments: (data.attachments ?? []).map(toAttachment)
    };
    const from = firstAddress(data.from);
    if (from) {
        input.from = from;
    }
    return new Message(input);
}

function toAttachment(a: NodemailerAttachment): AttachmentInput {
    let content: Uint8Array | string;
    if (a.content instanceof Uint8Array) {
        content = a.content;
    } else if (typeof a.content === 'string') {
        content = a.encoding === 'base64' ? decodeBase64(a.content) : a.content;
    } else {
        content = a.content !== undefined ? String(a.content as unknown as string) : '';
    }
    const input: AttachmentInput = {
        name: typeof a.filename === 'string' ? a.filename : 'attachment',
        content
    };
    if (a.contentType !== undefined) {
        input.contentType = a.contentType;
    }
    if (a.cid !== undefined) {
        input.contentId = a.cid;
    }
    return input;
}

function decodeBase64(text: string): Uint8Array {
    const binary = atob(text.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function contentToString(value: string | {toString(): string} | undefined): string {
    if (value === undefined) {
        return '';
    }
    return typeof value === 'string' ? value : value.toString();
}

function firstAddress(value: string | NodemailerAddress | undefined): Address | undefined {
    const list = addressList(value);
    return list[0];
}

function addressList(value: NodemailerAddressList | undefined): Address[] {
    if (value === undefined) {
        return [];
    }
    const items = Array.isArray(value) ? value : [value];
    const out: Address[] = [];
    for (const item of items as readonly (string | NodemailerAddress)[]) {
        if (typeof item === 'string') {
            for (const parsed of parseAddressString(item)) {
                out.push(parsed);
            }
        } else if (item.address !== undefined && item.address.trim() !== '') {
            out.push(item.name !== undefined && item.name !== ''
                ? {address: item.address.trim(), name: item.name}
                : {address: item.address.trim()});
        }
    }
    return out;
}

/** "Name <a@b>, c@d" → addresses. Deliberately simple; Ghost sends simple headers. */
function parseAddressString(value: string): Address[] {
    const out: Address[] = [];
    for (const part of splitAddresses(value)) {
        const angled = /^(.*?)<([^<>]+)>\s*$/.exec(part.trim());
        if (angled) {
            const name = (angled[1] ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
            const address = (angled[2] ?? '').trim();
            if (address !== '') {
                out.push(name !== '' ? {address, name} : {address});
            }
        } else if (part.trim() !== '') {
            out.push({address: part.trim()});
        }
    }
    return out;
}

function splitAddresses(value: string): string[] {
    // Split on commas outside double quotes.
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of value) {
        if (ch === '"') {
            inQuotes = !inQuotes;
        }
        if (ch === ',' && !inQuotes) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    parts.push(current);
    return parts;
}
