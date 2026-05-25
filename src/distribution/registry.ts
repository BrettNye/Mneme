import type { DistributionProtocol } from "./protocol.js";
import { betaBinding } from "./beta.js";
import { scalarBinding } from "./scalar.js";

const registry: Record<string, DistributionProtocol<any>> = {
  beta: betaBinding,
  scalar: scalarBinding,
};

export function bindingFor(distribution: string): DistributionProtocol<any> {
  const b = registry[distribution];
  if (!b) throw new Error(`no distribution binding registered for "${distribution}"`);
  return b;
}

export const serializeParams = (distribution: string, params: unknown): string =>
  bindingFor(distribution).serialize(params);

export const deserializeParams = (distribution: string, blob: string): unknown =>
  bindingFor(distribution).deserialize(blob);
