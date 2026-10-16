export declare const VAPID_PUBLIC_KEY_HELP: string;
export declare function validateVapidPublicKey(key: string | undefined): string | null;
export declare function hasVapidPublicKey(key: string | undefined): boolean;
export declare function decodeVapidPublicKey(key: string | undefined): Uint8Array<ArrayBuffer>;
export declare function isPushEndpoint(value: string | undefined): boolean;
