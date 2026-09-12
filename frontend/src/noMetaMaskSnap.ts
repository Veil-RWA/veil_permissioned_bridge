// Keep MetaMask out of Starknet wallet discovery.
//
// get-starknet registers MetaMask as a "virtual" Starknet wallet (the Starknet
// Snap) whenever MetaMask is installed, at `window.starknet_metamask`. Every
// connect and every silent restore then asks each wallet for its permissions,
// and asking the virtual one loads the Snap -- so MetaMask pops "connect with
// Starknet" on each page load, for a holder who only uses it on the EVM side.
// `exclude` does not prevent it: the permissions check runs before the filter.
//
// get-starknet only installs the virtual wallet when the key is absent, and a
// non-wallet value there is skipped by its scan. So the key is claimed here,
// before get-starknet evaluates. This must stay the first import in starknet.ts.

if (typeof window !== 'undefined' && !('starknet_metamask' in window)) {
  Object.defineProperty(window, 'starknet_metamask', {
    value: undefined,
    writable: false,
    configurable: true,
  });
}

export {};
