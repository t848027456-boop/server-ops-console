export interface BootstrapRequestInput {
  preflightId: string;
  id?: string;
  name: string;
  region?: string;
  address: string;
  sshPort: number;
  sshUsername: string;
  password: string;
  hostKeyFingerprint: string;
  controlPlaneUrl: string;
}

export function bootstrapRequestBody(input: BootstrapRequestInput) {
  const id = input.id?.trim();
  return {
    preflightId: input.preflightId,
    ...(id ? { id } : {}),
    name: input.name,
    region: input.region,
    address: input.address,
    sshPort: input.sshPort,
    sshUsername: input.sshUsername,
    password: input.password,
    hostKeyFingerprint: input.hostKeyFingerprint,
    controlPlaneUrl: input.controlPlaneUrl,
  };
}
