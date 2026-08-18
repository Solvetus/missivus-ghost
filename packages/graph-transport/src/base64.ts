/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */

/** Encode bytes to base64 without Buffer, so the core runs on Workers. */
export function base64Encode(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

export function base64UrlEncode(bytes: Uint8Array): string {
    return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64Decode(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function utf8Encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}
