export type Guarantee = "detect" | "external-immutable" | "witnessed";

/** Rank used by the report to license the "tamper-evident" claim only at >= external-immutable. */
export const GUARANTEE_RANK: Record<Guarantee, number> = { detect: 0, "external-immutable": 1, witnessed: 2 };

export interface Signature { alg: string; bytes: Uint8Array; keyRef?: string; }
export interface AnchorReceipt { anchorId: string; epochId: string; guarantee: Guarantee; at: number; locator?: string; }
export interface AnchoredRoot { epochId: string; root: Uint8Array; signature?: Signature; receipt: AnchorReceipt; }

export interface Signer { sign(rootHash: Uint8Array): Promise<Signature>; readonly keyRef?: string; }

export interface AuditAnchor {
  readonly id: string;
  readonly guarantee: Guarantee;
  anchor(epoch: { epochId: string; root: Uint8Array; signature?: Signature }): Promise<AnchorReceipt>;
  fetch(range: { epochId?: string; since?: string }): Promise<AnchoredRoot[]>;
}
