declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };
export type ClaimId = Branded<string, "ClaimId">;
export type CorpusId = Branded<string, "CorpusId">;
export type ProfileId = Branded<string, "ProfileId">;
export type WorkspaceId = Branded<string, "WorkspaceId">;
export const asCorpusId = (s: string): CorpusId => s as CorpusId;
export const newClaimId = (): ClaimId => crypto.randomUUID() as ClaimId;
