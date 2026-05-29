import {
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  zeroOutUint8Array,
  type ClientState,
  type CiphersuiteImpl,
  type Credential,
  type KeyPackage,
  type PrivateKeyPackage,
} from 'ts-mls';
import { b64decode, b64encode, type PlaintextPayload } from './crypto';

const CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let ciphersuitePromise: Promise<CiphersuiteImpl> | null = null;

export interface MlsIdentity {
  publicPackage: KeyPackage;
  privatePackage: PrivateKeyPackage;
  encodedKeyPackage: string;
  identity: string;
}

export interface MlsJoinBundle {
  welcome: string;
  commit: string;
}

export interface MlsAppMessage {
  kind: 'app';
  payload: PlaintextPayload;
}

export interface MlsStateUpdate {
  kind: 'state';
}

export type MlsProcessResult = MlsAppMessage | MlsStateUpdate | null;

export async function createMlsIdentity(memberHint: string): Promise<MlsIdentity> {
  const impl = await getImpl();
  const credential: Credential = {
    credentialType: 'basic',
    identity: encoder.encode(memberHint),
  };
  const kp = await generateKeyPackage(
    credential,
    defaultCapabilities(),
    defaultLifetime,
    [],
    impl,
  );
  const encodedKeyPackage = b64encode(
    encodeMlsMessage({
      keyPackage: kp.publicPackage,
      wireformat: 'mls_key_package',
      version: 'mls10',
    }),
  );
  return { ...kp, encodedKeyPackage, identity: memberHint };
}

export function decodeKeyPackage(encoded: string): KeyPackage | null {
  try {
    const msg = decodeMlsMessage(b64decode(encoded), 0)?.[0];
    return msg?.wireformat === 'mls_key_package' ? msg.keyPackage : null;
  } catch (e) {
    console.warn('decodeKeyPackage failed', e);
    return null;
  }
}

export function identityForKeyPackage(keyPackage: KeyPackage): string {
  const credential = keyPackage.leafNode.credential;
  return credential.credentialType === 'basic'
    ? decoder.decode(credential.identity)
    : '';
}

export async function createInitialGroup(
  roomId: string,
  identity: MlsIdentity,
): Promise<ClientState> {
  return createGroup(
    encoder.encode(`crypt-chat:${roomId}`),
    identity.publicPackage,
    identity.privatePackage,
    [],
    await getImpl(),
  );
}

export async function addMember(
  state: ClientState,
  keyPackage: KeyPackage,
): Promise<{ state: ClientState; bundle: MlsJoinBundle }> {
  const impl = await getImpl();
  const result = await createCommit(
    { state, cipherSuite: impl },
    {
      extraProposals: [{ proposalType: 'add', add: { keyPackage } }],
      ratchetTreeExtension: true,
    },
  );
  result.consumed.forEach(zeroOutUint8Array);
  if (!result.welcome) throw new Error('MLS add commit did not produce welcome');
  return {
    state: result.newState,
    bundle: {
      welcome: b64encode(
        encodeMlsMessage({
          welcome: result.welcome,
          wireformat: 'mls_welcome',
          version: 'mls10',
        }),
      ),
      commit: b64encode(encodeMlsMessage(result.commit)),
    },
  };
}

export async function removeMember(
  state: ClientState,
  leafIndex: number,
): Promise<{ state: ClientState; commit: string }> {
  const impl = await getImpl();
  const result = await createCommit(
    { state, cipherSuite: impl },
    {
      extraProposals: [{ proposalType: 'remove', remove: { removed: leafIndex } }],
      ratchetTreeExtension: true,
    },
  );
  result.consumed.forEach(zeroOutUint8Array);
  return { state: result.newState, commit: b64encode(encodeMlsMessage(result.commit)) };
}

export async function joinFromWelcome(
  encodedWelcome: string,
  identity: MlsIdentity,
): Promise<ClientState | null> {
  try {
    const msg = decodeMlsMessage(b64decode(encodedWelcome), 0)?.[0];
    if (msg?.wireformat !== 'mls_welcome') return null;
    return await joinGroup(
      msg.welcome,
      identity.publicPackage,
      identity.privatePackage,
      emptyPskIndex,
      await getImpl(),
    );
  } catch (e) {
    console.warn('joinFromWelcome failed', e);
    return null;
  }
}

export async function encryptPayload(
  state: ClientState,
  payload: PlaintextPayload,
): Promise<{ state: ClientState; envelope: string }> {
  const result = await createApplicationMessage(
    state,
    encoder.encode(JSON.stringify(payload)),
    await getImpl(),
  );
  result.consumed.forEach(zeroOutUint8Array);
  return {
    state: result.newState,
    envelope: b64encode(
      encodeMlsMessage({
        privateMessage: result.privateMessage,
        wireformat: 'mls_private_message',
        version: 'mls10',
      }),
    ),
  };
}

export async function processEnvelope(
  state: ClientState,
  envelope: string,
): Promise<{ state: ClientState; result: MlsProcessResult }> {
  const msg = decodeMlsMessage(b64decode(envelope), 0)?.[0];
  if (!msg) return { state, result: null };
  if (
    msg.wireformat === 'mls_welcome' ||
    msg.wireformat === 'mls_key_package' ||
    msg.wireformat === 'mls_group_info'
  ) {
    return { state, result: null };
  }
  const processed = await processMessage(msg, state, emptyPskIndex, () => 'accept', await getImpl());
  processed.consumed.forEach(zeroOutUint8Array);
  if (processed.kind === 'applicationMessage') {
    try {
      const payload = JSON.parse(decoder.decode(processed.message)) as PlaintextPayload;
      return { state: processed.newState, result: { kind: 'app', payload } };
    } catch {
      return { state: processed.newState, result: null };
    }
  }
  return { state: processed.newState, result: { kind: 'state' } };
}

export function leafIndexForIdentity(state: ClientState, identity: string): number | null {
  for (let nodeIndex = 0; nodeIndex < state.ratchetTree.length; nodeIndex += 2) {
    const node = state.ratchetTree[nodeIndex];
    if (!node || node.nodeType !== 'leaf') continue;
    const credential = node.leaf.credential;
    if (
      credential.credentialType === 'basic' &&
      decoder.decode(credential.identity) === identity
    ) {
      return nodeIndex / 2;
    }
  }
  return null;
}

async function getImpl(): Promise<CiphersuiteImpl> {
  if (!ciphersuitePromise) {
    ciphersuitePromise = getCiphersuiteImpl(getCiphersuiteFromName(CIPHERSUITE));
  }
  return ciphersuitePromise;
}
