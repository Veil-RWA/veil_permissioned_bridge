// Pure bridge exit encoding used by the app and offline scripts.
import { stellarExitRecipient, u256Felts } from 'veil-sdk';
export { bridgeExitTail, planBridgeExit } from 'veil-sdk';

/** G-addresses decode to raw key bytes. Hex addresses/keys are never narrowed. */
export function exitRecipientWord(recipient: string): bigint {
  return recipient.startsWith('G') ? stellarExitRecipient(recipient) : BigInt(recipient);
}

export function quoteBridgeBackCalldata(amount: bigint, recipient: string, gasLimit: bigint): string[] {
  const word = exitRecipientWord(recipient);
  if (word <= 0n || word >= 1n << 256n) throw new Error('recipient out of u256 range');
  return [...u256Felts(amount), ...u256Felts(word), '0x' + gasLimit.toString(16)];
}

/** Do not send new low/high calldata to an old felt252 gateway. */
export function gatewayHasU256Exit(abi: unknown): boolean {
  if (!Array.isArray(abi)) return false;
  return abi.some((entry) => {
    if (entry?.type === 'interface') return gatewayHasU256Exit(entry.items);
    const recipient = entry?.inputs?.find((v: { name: string }) => v.name === 'recipient');
    return entry?.name === 'privacy_invoke' && recipient?.type === 'core::integer::u256';
  });
}
