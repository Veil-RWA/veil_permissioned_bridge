// Veil Bridge UI.
//
// Layout follows Across: sticky Transfer/History nav, one centred card, a
// vertical From -> To stack, quote details inline above the action button.
//
// Three things a bearer bridge does not need and this does:
//
//   ELIGIBILITY. On an ERC-3643 asset a transfer can be perfectly funded and
//   still refused, so the gates are shown in the order they fail BEFORE gas is
//   spent. "Blocked" and "will arrive held" are different outcomes.
//
//   ASSET. One lockbox and one twin per asset -- never pooled -- so choosing an
//   asset switches the whole contract set, not just a ticker.
//
//   CLAIMS. A transfer that arrives for an ineligible holder is held rather
//   than rejected, on both sides. That balance is invisible unless the UI goes
//   looking for it, so it does, and offers the claim.
//
// ONE WALLET. The holder is their EVM wallet on both chains: it holds the
// asset on Ethereum and, under the same address, the private position in the
// Veil pool. Every Veil action is signed with personal_sign and submitted by
// the prover's relayer, so there is no Starknet wallet to connect, no
// destination address to type, and no STRK to hold.

import {
  isDeployed, deployment, evmLabel, starknetLabel, EXPLORER_EVM, EXPLORER_SN, LZ_SCAN,
  PROVER_ENDPOINT, PROVER_MASTER_ADDRESS, IS_DEMO,
} from './config';
import { assets, defaultAsset, faucetTokens, faucetRouter, isCash, type Asset } from './assets';
import * as cash from './cash';
import { ETHEREUM_DOMAIN, STARKNET_DOMAIN } from './cashCore';
import { short, units, parseUnits, ago, tokenScale, unitsToTokens, type UnitScale } from './format';
import * as evm from './evm';
import * as sn from './starknet';
import { load as loadHistory, record, update, type Kind, type Transfer } from './history';
import { lzStatus, inFlightByWallet, elapsed, type LzStatus } from './lzStatus';
import { recipientGate, mirrorRefusal, mirrorUnreadable, type Gate } from './eligibility';
import {
  deriveNoteContext, findFillableNote, forgetViewingKey, createOpenNote, bridgeBackPrivately,
  hasCachedViewingKey, registeredViewingKey, registerInPool, privateBalances,
  type AssetBalance, type NoteContext, type NoteSlot,
} from './notes';
import {
  checkPool, mainPool, poolFactory, normalisePoolAddress, POOL_PROBLEMS, type PoolCheck,
} from './pools';

type View = 'transfer' | 'history';
type Direction = 'toStarknet' | 'toEvm';

type State = {
  view: View;
  direction: Direction;
  asset: Asset;
  pickerOpen: boolean;
  /// Which Veil pool the transfer is addressed to. 'main' is the gateway's
  /// default; 'custom' is an address the user pasted. A pool is multi-asset, so
  /// this is a real choice and not implied by the asset.
  poolChoice: 'main' | 'custom';
  customPool: string;
  poolCheck?: PoolCheck;
  poolChecking: boolean;
  noteId: string;
  noteClaimedBy?: string;
  noteCtx?: NoteContext;
  noteSlot?: NoteSlot;
  noteSearched: boolean;
  /// Whether the quote breakdown is expanded. Kept in state so a re-render
  /// does not snap it shut while the holder is reading it.
  detailsOpen: boolean;
  /// The holder's wallet: on Ethereum, and under the same address in Veil.
  evmSession?: evm.EvmSession;
  token: { symbol: string; decimals: number };
  /// What a whole token is worth in the twin's units (1:1 but for Securitize
  /// assets, whose twin counts the token's shares).
  scale: UnitScale;
  amount: string;
  /// Always the connected wallet, in both directions. Never typed.
  recipient: string;
  /// Wallets to choose between, when more than one is installed.
  evmPicker?: evm.EvmWallet[];
  evmStatus?: evm.EvmStatus;
  mirror?: sn.MirrorStatus;
  /// Whether the Veil pool holds the viewing key this wallet signs for. Set
  /// only once the signature has run; undefined until then.
  poolVerified?: boolean;
  /// Whether the assets panel is open.
  walletPanel?: boolean;
  /// Public balances on Ethereum and private ones in the Veil pool, per asset
  /// id -- the same wallet, two places. Undefined until read; an undefined
  /// public entry is a read that failed, not a zero.
  publicBalances?: Record<string, AssetBalance | undefined>;
  privateBalances?: Record<string, AssetBalance>;
  balancesBusy: { evm: boolean; veil: boolean };
  balancesError: { evm?: string; veil?: string };
  claimableEvm: bigint;
  /// The selected asset's twin held privately in the pool, in tokens. Read
  /// with the viewing key; undefined until then.
  privateTwin?: bigint;
  /// The message fee: ETH for a bridge-in, and for a bridge back the STRK the
  /// gateway pays (the holder only caps it).
  fee?: bigint;
  busy?: string;
  error?: string;
  notice?: string;
  /// The cash leg (USDC over Circle's CCTP). Fast pays Circle to attest before
  /// finality; Standard is free. Per direction: a Standard exit from Starknet
  /// waits hours for L1 finality, a Standard deposit from Ethereum minutes.
  cashFast: { toStarknet: boolean; toEvm: boolean };
  /// The most Circle may take for a Fast Transfer of the typed amount (USDC units).
  cashFee?: bigint;
  /// USDC the connected Veil wallet holds in the pool, read with its viewing key.
  cashPrivate?: bigint;
  /// A cash deposit or exit on its way.
  cashFlight?: CashFlight;
};

type CashFlight = {
  direction: Direction;
  /// The burn: on Ethereum for a deposit, the pool invoke on Starknet for an exit.
  hash: string;
  historyId?: string;
  /// A deposit's note, which the vault fills.
  noteId?: string;
  stage: 'burned' | 'attested' | 'delivered';
  attestedAt?: number;
  message?: string;
  attestation?: string;
};

const initial = defaultAsset();
const state: State = {
  view: 'transfer',
  direction: 'toStarknet',
  asset: initial,
  pickerOpen: false,
  poolChoice: 'main',
  customPool: '',
  poolChecking: false,
  noteId: '',
  noteSearched: false,
  detailsOpen: false,
  token: { symbol: initial.symbol, decimals: initial.decimals },
  scale: tokenScale(initial.decimals),
  amount: '',
  recipient: '',
  claimableEvm: 0n,
  balancesBusy: { evm: false, veil: false },
  balancesError: {},
  cashFast: { toStarknet: false, toEvm: true },
};

const app = document.getElementById('app')!;
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const tint = (a: Asset): string => `linear-gradient(150deg, ${a.tint[0]}, ${a.tint[1]})`;
const toStarknet = () => state.direction === 'toStarknet';
/// Whether the selected asset's source eligibility is an issuer allowlist rather
/// than an ERC-3643 identity registry. Only the wording differs: the gates, the
/// lockbox and the Starknet side ask the same questions of both.
const allowlisted = () => {
  const kind = state.asset.addresses.evm?.kind;
  return kind === 'allowlist' || kind === 'rules';
};
/// A Securitize DS token: eligibility is its investor registry, the lockbox is
/// a platform wallet, and the twin counts the token's shares.
const securitize = () => state.asset.addresses.evm?.kind === 'securitize';
/// USDC, the cash leg: Circle's CCTP instead of a lockbox, and no twin.
const cashAsset = () => isCash(state.asset);
const cashFast = () => (toStarknet() ? state.cashFast.toStarknet : state.cashFast.toEvm);

/// Starknet amounts arrive in the twin's units; the UI speaks tokens.
function inTokens<T extends { balance: bigint; pending: bigint }>(m: T): T {
  return { ...m, balance: unitsToTokens(m.balance, state.scale), pending: unitsToTokens(m.pending, state.scale) };
}

const sourceLabel = () => (toStarknet() ? evmLabel : starknetLabel);
const destLabel = () => (toStarknet() ? starknetLabel : evmLabel);
const sourceMark = () => (toStarknet() ? 'eth' : 'sn');
const destMark = () => (toStarknet() ? 'sn' : 'eth');

/// The balance the transfer spends from, on whichever chain is the source.
function sourceBalance(): bigint | undefined {
  if (toStarknet()) return state.evmStatus?.balance;
  if (cashAsset()) return state.cashPrivate;
  return state.privateTwin;
}

// --------------------------------------------------------------- eligibility

function gates(): Gate[] {
  if (cashAsset()) return cashGates();
  const s = state.evmStatus;
  const m = state.mirror;
  const out: Gate[] = [];

  if (toStarknet()) {
    out.push({
      ok: s ? s.verified : null,
      label: allowlisted() ? "You are on the issuer's allowlist" : 'You are verified on the source registry',
      detail: s && !s.verified
        ? (allowlisted() ? 'The issuer has not allowlisted this address.' : 'The issuer has not registered this address.')
        : undefined,
    });
    out.push({ ok: s ? !s.frozen : null, label: 'Your address is not frozen' });
    out.push({ ok: s ? !s.paused : null, label: `${state.token.symbol} is not paused` });
    out.push({
      ok: s ? s.lockboxRegistered : null,
      label: 'The bridge is an approved holder',
      detail: s && !s.lockboxRegistered
        ? (securitize()
          ? 'The issuer must register the lockbox as a platform wallet, or the escrow reverts inside the token.'
          : allowlisted()
          ? 'The issuer must add the lockbox to the allowlist, or the escrow reverts inside the token.'
          : 'The issuer must register the lockbox in the identity registry, or the escrow reverts inside the token.')
        : undefined,
    });
    // Registering the wallet in the pool is not a gate: Bridge does it, with one
    // signature, the first time. Only a wallet the pool already holds under a
    // DIFFERENT viewing key cannot receive, and that is said when it happens.
    if (state.poolVerified === false) {
      out.push({
        ok: false,
        label: 'Your wallet is registered in the Veil pool',
        detail: 'It is registered with a different viewing key, so notes cannot be created for it here.',
      });
    }
    if (state.recipient) {
      out.push(recipientGate(m, s, state.evmSession?.address, starknetLabel, IS_DEMO));
    }
  } else {
    out.push({
      ok: !m || !m.readable ? null : m.verified,
      label: `You are eligible on ${starknetLabel}`,
      detail: !m ? undefined
        : !m.readable ? mirrorUnreadable(IS_DEMO)
        : !m.verified ? mirrorRefusal(m, true)
        : undefined,
    });
    out.push({
      // Freshness needs the record AND the window. Without both, "fresh" would
      // be a guess -- and an unread window reads as 0, which means expiry is
      // disabled, which would paint this green for having learned nothing.
      ok: m && m.readable && m.identityKnown && (m.freshnessKnown || m.stalenessWindow === 0)
        ? m.fresh || m.stalenessWindow === 0
        : null,
      label: 'Your mirrored record is fresh',
    });
    if (state.recipient) {
      out.push({
        ok: null,
        label: `Recipient is checked on ${evmLabel} at arrival`,
        detail: 'If they are not verified there, the release is held and stays claimable.',
      });
    }
  }
  return out;
}

function eligibilityCard(): string {
  if (!state.asset.available) {
    return `<div class="eligibility"><div class="eligibility-head">Eligibility</div>
      <p>${esc(state.asset.name)} is not deployed on this route yet.</p></div>`;
  }
  if (!state.evmSession) return '';

  const list = gates();
  const failing = list.filter((g) => g.ok === false);
  // A check that could not be RUN is not a check that passed. Reads fail when
  // an RPC is down or an address is wrong, and answering "eligible" because
  // nothing came back is the one answer a compliance gate must never give.
  const unknown = list.filter((g) => g.ok === null);

  // A PASSING gate has nothing to say. Five green ticks tell the holder only
  // what the one-line verdict already tells them, and bury the single line that
  // matters on the day something fails. So: the verdict, and -- only when
  // something is wrong -- what is wrong and how to fix it.
  if (failing.length === 0 && unknown.length === 0) {
    return `<div class="eligibility is-good"><div class="eligibility-head">Eligible to bridge</div></div>`;
  }

  const onlyRecipient = failing.length > 0 && failing.every((g) => g.label.startsWith('Recipient'));
  const tone = failing.length > 0 ? (onlyRecipient ? 'is-warn' : 'is-bad') : 'is-warn';
  const head = failing.length > 0
    ? (onlyRecipient ? 'Will arrive held' : 'Not eligible')
    : 'Could not check';

  const items = [...failing, ...unknown].map((g) => {
    const mark = g.ok === null ? '<span class="mark idk">·</span>' : '<span class="mark no">✕</span>';
    return `<li>${mark}<span>${esc(g.label)}${g.detail ? `<br><span style="color:var(--faint)">${esc(g.detail)}</span>` : ''}</span></li>`;
  }).join('');

  return `<div class="eligibility ${tone}"><div class="eligibility-head">${head}</div>
    <ul class="checks">${items}</ul></div>`;
}

// ------------------------------------------------------------------- claims

/// A held balance is invisible unless something goes looking, so the card
/// surfaces both sides and offers the release. Claiming is permissionless: the
/// funds can only reach the address the original message named.
function claimsCard(): string {
  if (cashAsset()) return '';
  const pending = state.mirror?.pending ?? 0n;
  const held = state.claimableEvm;
  if (pending === 0n && held === 0n) return '';

  const rows: string[] = [];
  if (pending > 0n) {
    // Released into a pool note, never to a public balance -- which takes a
    // Starknet transaction. Anyone may send it; Veil does, once you are eligible.
    const ready = state.mirror?.verified === true;
    rows.push(`<div class="claim-row">
      <div><strong>${esc(units(pending, state.token.decimals))} ${esc(state.token.symbol)}</strong>
        <span class="claim-where">held on ${esc(starknetLabel)}</span></div>
      <span class="claim-where">${ready ? 'Veil releases it into your note' : 'Not eligible yet'}</span>
    </div>`);
  }
  if (held > 0n) {
    rows.push(`<div class="claim-row">
      <div><strong>${esc(units(held, state.token.decimals))} ${esc(state.token.symbol)}</strong>
        <span class="claim-where">held on ${esc(evmLabel)}</span></div>
      <button id="claim-evm" class="max" ${state.evmSession ? '' : 'disabled'}>
        ${state.evmSession ? 'Claim' : 'Connect wallet'}
      </button>
    </div>`);
  }

  return `<div class="claims">
    <div class="claims-head">Held for you</div>
    ${rows.join('')}
    <p class="claims-note">Arrived while you were not eligible. Nothing is lost — it stays claimable, and anyone can pay the gas to release it.</p>
  </div>`;
}

// ------------------------------------------------------------------ delivery

/// Where a bridge-in lands -- which is always a Veil pool note. There is no
/// wallet delivery and no wallet fallback: the twin is a permissioned asset
/// whose point is to settle privately inside the pool, and a public balance on
/// Starknet is the thing this bridge exists to avoid. A transfer that cannot be
/// filled is held on the gateway and stays claimable into a note.
///
/// So this is not a choice of destination. The only choice is WHICH pool.
function deliveryControls(): string {
  if (cashAsset()) return cashControls();
  if (!toStarknet() || !state.asset.poolReady) return '';
  const claimed = state.noteClaimedBy;
  const mine = claimed && state.evmSession &&
    BigInt(claimed) === BigInt(state.evmSession.address);
  const unclaimed = claimed !== undefined && BigInt(claimed) === 0n;

  return `<div class="delivery">
    <div class="delivery-head">Lands in a Veil pool</div>
    ${poolSection()}
    ${noteSection(claimed, Boolean(mine), Boolean(unclaimed))}
  </div>`;
}

/// WHICH pool. A Veil pool is multi-asset -- one pool carries any number of
/// tokens -- so the asset does not answer this and the user has to.
///
/// Almost everyone wants the main pool. The alternative is for an entity that
/// runs its own, and it means pasting an address, so the address is verified
/// against the factory as it is typed: a pool that does not exist is caught
/// here, before a message is paid for, rather than on the far side.
function poolSection(): string {
  const custom = state.poolChoice === 'custom';
  const canCustom = Boolean(poolFactory());
  const main = mainPool(state.asset);

  const status = !custom
    ? ''
    : state.poolChecking
      ? `<p class="delivery-note">Checking that pool…</p>`
      : state.poolCheck?.ok
        ? `<p class="delivery-note is-ok">Veil pool found. It carries ${esc(state.token.symbol)}.</p>`
        : state.poolCheck
          ? `<p class="delivery-note is-warn">${esc(POOL_PROBLEMS[state.poolCheck.reason])}</p>`
          : `<p class="delivery-note">Paste the pool's address on ${esc(starknetLabel)}.</p>`;

  return `<div class="pool-choice">
    <div class="seg seg-sm" role="radiogroup" aria-label="Which pool">
      <button class="seg-btn${custom ? '' : ' is-on'}" data-pool="main" role="radio" aria-checked="${!custom}">Main Veil pool</button>
      <button class="seg-btn${custom ? ' is-on' : ''}" data-pool="custom" role="radio" aria-checked="${custom}"${canCustom ? '' : ' disabled'}>Another pool</button>
    </div>
    ${custom
      ? `<input id="pool-address" class="pool-input mono" placeholder="0x…" spellcheck="false"
           autocomplete="off" value="${esc(state.customPool)}" />
         ${status}`
      : main
        ? ''
        : `<p class="delivery-note is-warn">No Veil pool is configured for this deployment.</p>`}
  </div>`;
}

/// The pool the transfer should name on the wire. Zero means "the gateway's
/// default", which is what the main pool is, so it is never spelled out.
function selectedPool(): string | undefined {
  if (state.poolChoice !== 'custom') return undefined;
  return state.poolCheck?.ok ? state.poolCheck.pool : undefined;
}

/// The note is DERIVED from the holder's viewing key, never typed. A pasted id
/// cannot be produced by hand, and one that is not yours sends your tokens into
/// somebody else's note.
function noteSection(claimed: string | undefined, mine: boolean, unclaimed: boolean): string {
  // STATUS, not controls. Every step this panel used to offer a button for --
  // sign, create, claim -- now runs inside the one Bridge press, so a button
  // here would be a second way to do the same thing, competing with the CTA and
  // leaving the holder to guess which one is the real one.
  // Nothing to say before there is a note. Bridge sets it up; explaining the
  // mechanism to someone who has not asked is noise on the way to a transfer.
  if (!state.evmSession || !state.noteCtx || !state.noteId) return '';

  const state_line = mine
    ? `<p class="delivery-note is-ok">Claimed by you. Ready to fill.</p>`
    : unclaimed
      ? `<p class="delivery-note">Your bridge-in claims it: it names your wallet as the holder.</p>`
      : claimed !== undefined
        ? `<p class="delivery-note is-warn">Claimed by another address, so it cannot be filled for you.</p>`
        : '';

  return `<div class="note-found">
      <span class="note-label">Your open note</span>
      <span class="note-id mono">${esc(short(state.noteId, 10, 8))}</span>
      <span class="note-index">slot ${state.noteSlot?.index ?? 0}</span>
    </div>
    ${state_line}
    <p class="delivery-note">Derived from your viewing key, so only you can spend it. If it cannot be filled the amount is held on the gateway and stays claimable into a note — never lost, and never a public balance.</p>`;
}

/// A note id must be a non-zero felt. Refusing an empty one saves a message
/// that would silently degrade on the far side.
function validNoteId(): boolean {
  const raw = state.noteId.trim();
  if (!raw) return false;
  try { return BigInt(raw) !== 0n; } catch { return false; }
}

// ------------------------------------------------------------- asset picker

/// Deployed, and its gateway takes EVM wallets as holders (or has not answered
/// yet). An asset whose gateway predates EVM holders needs a Starknet account
/// on the far side, which this app does not have.
const usableAsset = (a: Asset): boolean => a.available && a.evmReady !== false;

function assetPill(): string {
  const a = state.asset;
  return `<button id="asset-pill" class="token-pill" aria-haspopup="listbox" aria-expanded="${state.pickerOpen}">
    <span class="token-mark" style="background:${tint(a)}"></span>${esc(state.token.symbol)}
    <span class="pill-caret">▾</span></button>`;
}

function assetPicker(): string {
  if (!state.pickerOpen) return '';
  const rows = assets.map((a) => {
    const selected = a.id === state.asset.id;
    const usable = usableAsset(a);
    const tag = !a.available ? 'not deployed' : a.evmReady === false ? 'not available' : a.category;
    return `<button class="asset-row${selected ? ' is-selected' : ''}${usable ? '' : ' is-off'}"
        data-asset="${esc(a.id)}" ${usable ? '' : 'disabled'} role="option" aria-selected="${selected}">
      <span class="token-mark" style="background:${tint(a)}"></span>
      <span class="asset-text"><span class="asset-symbol">${esc(a.symbol)}</span>
        <span class="asset-name">${esc(a.name)}</span></span>
      <span class="asset-tag">${esc(tag)}</span></button>`;
  }).join('');
  return `<div class="picker" role="listbox" aria-label="Select an asset">
    <div class="picker-head">Asset</div>${rows}
    <div class="picker-foot">Each asset has its own lockbox and twin. They are never pooled.</div></div>`;
}

// ------------------------------------------------------------------ transfer

/// ONE button, named for the outcome the holder wants. Everything a bridge-in
/// needs on the way -- the viewing key, an empty note, its claim, the ERC-20
/// allowance -- is plumbing, and plumbing does not get its own button. A card
/// that walks someone through four differently-named presses is describing the
/// implementation to a person who asked for a transfer.
function ctaLabel(): { text: string; disabled: boolean; note: string } {
  if (!isDeployed) return { text: 'Not deployed', disabled: true, note: 'No deployment found for this network pair.' };
  if (!state.asset.available) {
    return { text: `${state.asset.symbol} not available`, disabled: true, note: 'Pick an asset this deployment carries.' };
  }
  if (state.asset.evmReady === false) {
    return {
      text: `${state.asset.symbol} not available`, disabled: true,
      note: 'Its bridge gateway predates wallet-only holders. Pick another asset.',
    };
  }
  if (state.busy) return { text: state.busy, disabled: true, note: '' };

  // One wallet, both directions: it is the sender and, under the same address,
  // the holder on the other side.
  if (!state.evmSession) return { text: 'Connect wallet', disabled: false, note: '' };
  // Bridging back spends private notes, which only the viewing key can find.
  if (!toStarknet() && !state.noteCtx) {
    return {
      text: 'Show my Veil balance', disabled: false,
      note: 'One signature in your wallet reads your private balance. It moves nothing.',
    };
  }

  let amount = 0n;
  try { amount = parseUnits(state.amount || '0', state.token.decimals); } catch { /* below */ }
  if (amount <= 0n) return { text: 'Enter an amount', disabled: true, note: '' };

  const balance = sourceBalance();
  if (balance !== undefined && amount > balance) return { text: 'Insufficient balance', disabled: true, note: '' };

  if (cashAsset()) return cashCta(amount);

  if (toStarknet()) {
    const s = state.evmStatus;
    // No status means the eligibility reads did not come back. Bridging anyway
    // spends gas on an escrow the token will revert, and skips the approval
    // step because the allowance is unknown too.
    if (!s) {
      return {
        text: 'Cannot check eligibility',
        disabled: true,
        note: 'The source chain did not answer. Nothing is sent until it does.',
      };
    }
    if (s && !s.verified) return { text: 'Not eligible to bridge', disabled: true, note: allowlisted() ? "Your address is not on the issuer's allowlist." : 'Your address is not verified on the source registry.' };
    if (s && !s.lockboxRegistered) return { text: 'Bridge not approved by issuer', disabled: true, note: allowlisted() ? 'The lockbox must be on the allowlist before any escrow can succeed.' : 'The lockbox must be a registered identity before any escrow can succeed.' };
    {
      // A pool that does not exist would cost a message and land in the wallet
      // anyway, so it is stopped here rather than discovered on the far side.
      if (state.poolChoice === 'custom') {
        if (!normalisePoolAddress(state.customPool)) {
          return { text: 'Enter the pool address', disabled: true, note: 'Paste the Veil pool you want this to land in.' };
        }
        if (state.poolChecking) {
          return { text: 'Checking the pool…', disabled: true, note: 'Confirming a Veil pool exists at that address.' };
        }
        if (!state.poolCheck?.ok) {
          return {
            text: 'Pool cannot be used',
            disabled: true,
            note: state.poolCheck ? POOL_PROBLEMS[state.poolCheck.reason] : 'That pool has not been checked yet.',
          };
        }
      } else if (!mainPool(state.asset)) {
        return { text: 'No Veil pool configured', disabled: true, note: 'This deployment has no pool to deliver into.' };
      }
      // NOTHING about the note appears here. Deriving the viewing key, creating
      // an empty note and claiming it are steps the holder did not ask for and
      // should not have to understand -- they asked to bridge. The button says
      // "Bridge", and `bridgeToStarknet` runs whatever is missing. The only
      // thing that stops the press is a note that cannot be MADE at all.
      if (!validNoteId() && (!PROVER_ENDPOINT || !PROVER_MASTER_ADDRESS)) {
        return {
          text: 'Note creation unavailable', disabled: true,
          note: 'Delivering into a pool needs a Veil prover endpoint, which this deployment has not configured.',
        };
      }
      if (amount >= (1n << 128n)) {
        return { text: 'Amount too large for a note', disabled: true, note: 'A note holds at most 2^128 - 1 base units.' };
      }
    }
    const fee = state.fee !== undefined ? `${units(state.fee, 18, 5)} ETH` : '…';
    // The button is named for what it DOES, not for the first transaction it
    // happens to send. An allowance is plumbing: pressing "Approve" and landing
    // back on an unchanged card looks like nothing happened, and nothing is
    // bridged until a second press nobody told you about. One press bridges;
    // the approval, when one is needed, runs inside it.
    const needsApproval = Boolean(s && s.allowance < amount);
    return {
      text: `Bridge ${state.token.symbol}`,
      disabled: false,
      note: needsApproval
        ? `Two confirmations: approve ${state.token.symbol}, then the transfer. Message fee ${fee}, paid to LayerZero.`
        : `Message fee ${fee}, paid to LayerZero.`,
    };
  }

  const m = state.mirror;
  if (m && !m.verified) return { text: 'Not eligible to bridge', disabled: true, note: 'A frozen or revoked holder cannot move value, cross-chain included.' };
  if (!PROVER_ENDPOINT || !PROVER_MASTER_ADDRESS) {
    return {
      text: 'Bridge back unavailable', disabled: true,
      note: 'Leaving the pool needs a Veil prover endpoint, which this deployment has not configured.',
    };
  }
  // The pool pays the gateway `amount + 1` and gets the 1 back as change.
  if (state.privateTwin !== undefined && amount + 1n > state.privateTwin) {
    return { text: 'Insufficient balance', disabled: true, note: 'Bridging back keeps 1 base unit in the pool as change.' };
  }
  const fee = state.fee !== undefined ? `${units(state.fee, 18, 5)} STRK` : '…';
  return {
    text: 'Bridge back',
    disabled: false,
    note: `One signature in your wallet. The LayerZero fee (${fee}) is paid by the bridge, not by you.`,
  };
}

/// The LayerZero fee: paid in ETH by the wallet on a bridge-in, and in STRK by
/// the bridge gateway on a bridge back.
function msgFeeText(): string {
  if (state.fee === undefined) return '—';
  return toStarknet() ? `${units(state.fee, 18, 6)} ETH` : `${units(state.fee, 18, 6)} STRK, paid by the bridge`;
}

function transferView(): string {
  const cta = ctaLabel();
  const bal = sourceBalance();
  const balance = bal !== undefined ? `${units(bal, state.token.decimals)} ${state.token.symbol}` : '—';
  const other = toStarknet() ? (cashAsset() ? state.cashPrivate : state.privateTwin) : state.evmStatus?.balance;
  const destBalance = other !== undefined ? `${units(other, state.token.decimals)} ${state.token.symbol}` : '—';

  const banner = !isDeployed
    ? `<div class="banner is-bad">No deployment loaded. Run the scripts in <span class="mono">scripts/</span>, then <span class="mono">npm run dev</span> again.</div>`
    : state.error ? `<div class="banner is-bad">${esc(state.error)}</div>`
    : state.notice ? `<div class="banner">${esc(state.notice)}</div>` : '';

  // The destination is the connected wallet, never something typed. On the way
  // in it holds the position inside Veil under its own address; on the way back
  // the release arrives in it on Ethereum.
  const me = state.evmSession?.address;
  const connectDest = me
    ? `<div class="dest-wallet"><span class="dest-mark"></span><span class="mono">${esc(short(me, 10, 8))}</span>
         <span class="dest-note">${toStarknet() ? 'your wallet, inside Veil' : 'your wallet'}</span></div>`
    : `<button id="connect-dest" class="max" style="margin-top:8px">Connect wallet</button>`;

  // A MODAL, not inline content. The previous version rendered the picker as a
  // block above the card, so with the page scrolled at all it sat off-screen --
  // you pressed Connect and nothing appeared to happen. An overlay is what
  // every connect flow uses, and it shows wherever the page happens to be.
  const walletPicker = state.evmPicker?.length
    ? `<div class="modal-backdrop" id="wallet-modal">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Connect a wallet">
          <div class="modal-head">
            <span>Connect an ${esc(evmLabel)} wallet</span>
            <button class="modal-x" id="wallet-modal-close" aria-label="Close">&times;</button>
          </div>
          ${state.evmPicker.map((w) => `
            <button class="wallet-row" data-wallet="${esc(w.rdns)}">
              ${w.icon ? `<img class="wallet-icon" src="${esc(w.icon)}" alt="" />` : '<span class="wallet-icon"></span>'}
              <span>${esc(w.name)}</span>
            </button>`).join('')}
        </div>
      </div>`
    : '';

  return `
  ${banner}
  ${walletPicker}
  <div class="card">
    <div class="leg">
      <div class="leg-head"><span>From</span><span class="leg-balance">${esc(balance)}</span></div>
      <div class="chain"><span class="chain-mark ${sourceMark()}">${toStarknet() ? 'E' : 'S'}</span>${esc(sourceLabel())}</div>
      <div class="amount-row">
        <input id="amount" class="amount" inputmode="decimal" placeholder="0.0" value="${esc(state.amount)}" />
        <button id="max" class="max">MAX</button>
        ${assetPill()}
      </div>
      ${assetPicker()}
    </div>

    <div class="swap-divider"><button id="swap" class="swap-btn" title="Reverse direction" aria-label="Reverse direction">⇅</button></div>

    <div class="leg">
      <div class="leg-head"><span>To</span><span class="leg-balance">${esc(destBalance)}</span></div>
      <div class="chain"><span class="chain-mark ${destMark()}">${toStarknet() ? 'S' : 'E'}</span>${esc(destLabel())}</div>
      ${connectDest}
      ${deliveryControls()}
    </div>

    ${eligibilityCard()}
    ${claimsCard()}

    <details class="details-wrap"${state.detailsOpen ? ' open' : ''}>
      <summary class="details-summary">Details</summary>
    <dl class="details">
      <div class="detail"><dt>Asset</dt><dd>${esc(state.asset.name)}</dd></div>
      <div class="detail"><dt>Route</dt><dd>${esc(sourceLabel())} → ${esc(destLabel())}</dd></div>
      ${toStarknet() && state.asset.poolReady
        ? `<div class="detail"><dt>Lands as</dt><dd>Pool note</dd></div>` : ''}
      ${cashAsset() ? cashDetails() : `<div class="detail"><dt>Message fee</dt><dd id="msg-fee">${msgFeeText()}</dd></div>
      <div class="detail"><dt>Bridge fee</dt><dd>0</dd></div>
      <div class="detail"><dt>Estimated time</dt><dd>~3–10 min</dd></div>`}
    </dl>
    </details>

    <button id="cta" class="cta" ${cta.disabled ? 'disabled' : ''}>${esc(cta.text)}</button>
    ${cta.note ? `<div class="cta-note">${esc(cta.note)}</div>` : ''}
  </div>`;
}

// ------------------------------------------------------------------- history

/// Where each message still on its way is, per source tx hash -- read from
/// LayerZero Scan while History is open.
const lzSeen = new Map<string, LzStatus>();
let historyTimer: number | undefined;

const KIND_TITLE: Record<Kind, string> = {
  transfer: '',
  eligibility: 'Eligibility update',
  rules: 'Issuer rules update',
};

/// Status words for the pill. A message has no "minted": it is delivered.
function pill(t: Transfer): string {
  if (t.status === 'sent') return t.kind && t.kind !== 'transfer' ? 'in flight' : 'sent';
  return t.status;
}

function historyView(): string {
  const items = loadHistory().sort((a, b) => b.at - a.at);
  // Messages sent from another device, or before this browser logged them, are
  // found through the wallet -- so without one, say so rather than look empty.
  const connectHint = state.evmSession ? '' : `<p class="history-hint">Connect your wallet to also see its
    updates and transfers still on their way, wherever they were sent from.</p>`;
  if (!items.length) {
    return `<div class="history"><div class="history-empty">
      <p style="margin:0 0 6px;font-weight:600;color:var(--ink)">No transfers yet</p>
      <p style="margin:0">Bridged transfers from this browser will appear here.</p>${connectHint}</div></div>`;
  }
  const rows = items.map((t: Transfer) => {
    const kind = t.kind ?? 'transfer';
    const explorer = t.direction === 'toStarknet' ? EXPLORER_EVM : EXPLORER_SN;
    const viaLz = t.asset !== 'usdc';
    const lzLink = viaLz ? ` · <a href="${LZ_SCAN}/tx/${esc(t.hash)}" target="_blank" rel="noreferrer">LayerZero</a>` : '';
    const title = kind === 'transfer'
      ? `${esc(t.amount)} ${esc(t.symbol ?? '')}<span style="color:var(--faint);font-weight:500">${t.direction === 'toStarknet'
          ? `${esc(evmLabel)} → ${esc(starknetLabel)}` : `${esc(starknetLabel)} → ${esc(evmLabel)}`}</span>`
      : `${KIND_TITLE[kind]} · ${esc(t.symbol ?? '')}<span style="color:var(--faint);font-weight:500">${esc(evmLabel)} → ${esc(starknetLabel)}</span>`;
    const lz = t.status === 'sent' && viaLz ? lzSeen.get(t.hash) : undefined;
    const where = t.status === 'sent' && viaLz
      ? `<div class="row-lz ${lz?.stage ?? 'unknown'}">${lz
          ? `${esc(lz.text)} ${esc(elapsed(lz.since ?? t.at))}${lz.raw && lz.stage !== 'delivered' ? `<span class="row-lz-raw">LayerZero: ${esc(lz.raw)}</span>` : ''}`
          : 'Checking LayerZero…'}</div>`
      : '';
    return `<div class="row">
      <div class="row-main">${title}</div>
      <span class="status ${t.status}">${pill(t)}</span>
      <div class="row-sub">${esc(ago(t.at))} · ${kind === 'transfer' ? 'to' : 'for'} ${esc(short(t.recipient, 8, 6))} ·
        <a href="${explorer}/tx/${esc(t.hash)}" target="_blank" rel="noreferrer">tx</a>${lzLink}
      </div>${where}</div>`;
  }).join('');
  return `<div class="history">${connectHint}${rows}</div>`;
}

/// Ask LayerZero where every message still on its way is. A message logged
/// before the transfer (eligibility, rules) closes here once delivered; a
/// transfer keeps its own watcher, which knows whether it minted or was held.
async function refreshHistoryStatus(): Promise<void> {
  if (state.evmSession) await adoptInFlight(state.evmSession.address);
  const open = loadHistory().filter((t) => t.status === 'sent' && t.asset !== 'usdc').slice(0, 10);
  await Promise.all(open.map(async (t) => {
    const lz = await lzStatus(t.hash);
    if (!lz) return;
    lzSeen.set(t.hash, lz);
    if (t.kind && t.kind !== 'transfer') {
      if (lz.stage === 'delivered') update(t.id, 'delivered');
      if (lz.stage === 'failed') update(t.id, 'failed');
    }
  }));
  if (state.view === 'history') render();
}

/// The wallet History last looked up, so a wallet connecting (or restoring)
/// while History is open is looked up at once, not on the next tick.
let historyWallet: string | undefined;

/// While History is open, keep its statuses current.
function watchHistory(): void {
  if (state.view !== 'history') {
    if (historyTimer !== undefined) { window.clearInterval(historyTimer); historyTimer = undefined; }
    historyWallet = undefined;
    return;
  }
  const wallet = state.evmSession?.address.toLowerCase();
  if (historyTimer !== undefined && wallet === historyWallet) return;
  historyWallet = wallet;
  void refreshHistoryStatus();
  if (historyTimer === undefined) historyTimer = window.setInterval(() => void refreshHistoryStatus(), 20000);
}

// -------------------------------------------------------------------- render

function render(): void {
  // The whole card is rebuilt on every render, which would drop the caret out
  // of a field being typed into. The pool address is checked AS it is typed, so
  // that render lands mid-keystroke -- remember where the caret was and put it
  // back.
  const active = document.activeElement as HTMLInputElement | null;
  const focusedId = active?.id;
  const caret = active?.selectionStart ?? null;

  app.innerHTML = state.view === 'transfer' ? transferView() : historyView();

  if (focusedId) {
    const restored = document.getElementById(focusedId) as HTMLInputElement | null;
    if (restored) {
      restored.focus();
      if (caret !== null && restored.setSelectionRange) {
        try { restored.setSelectionRange(caret, caret); } catch { /* not a text input */ }
      }
    }
  }

  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.view === state.view);
    tab.onclick = () => { state.view = tab.dataset.view as View; state.pickerOpen = false; render(); };
  });

  paintNavWallets();

  watchHistory();

  const foot = document.getElementById('foot-route');
  if (foot) foot.textContent = isDeployed ? `${sourceLabel()} → ${destLabel()}` : 'not deployed';
  if (state.view !== 'transfer') return;

  const amount = document.getElementById('amount') as HTMLInputElement | null;
  if (amount) amount.oninput = () => { state.amount = amount.value; state.error = undefined; refreshQuote(); paintCta(); };


  const max = document.getElementById('max');
  if (max) max.onclick = () => {
    const bal = sourceBalance();
    if (bal === undefined) return;
    state.amount = units(bal, state.token.decimals, state.token.decimals);
    render(); refreshQuote();
  };

  const swap = document.getElementById('swap');
  if (swap) swap.onclick = () => void reverse();

  const pill = document.getElementById('asset-pill');
  if (pill) pill.onclick = (e) => { e.stopPropagation(); state.pickerOpen = !state.pickerOpen; render(); };

  document.querySelectorAll<HTMLButtonElement>('.asset-row').forEach((row) => {
    row.onclick = () => void selectAsset(row.dataset.asset!);
  });

  document.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) => {
    b.onclick = () => {
      // The same control class serves both segmented pickers, so each button
      // acts on the one it actually belongs to.
      if (b.dataset.speed) {
        const fast = b.dataset.speed === 'fast';
        if (toStarknet()) state.cashFast.toStarknet = fast; else state.cashFast.toEvm = fast;
        state.cashFee = undefined;
        refreshQuote();
      }
      if (b.dataset.pool) {
        state.poolChoice = b.dataset.pool as 'main' | 'custom';
        // A pool the user has moved away from must not stay approved: going
        // back to "another pool" re-checks whatever is in the box.
        state.poolCheck = undefined;
        if (state.poolChoice === 'custom' && state.customPool.trim()) void doCheckPool();
      }
      render();
    };
  });

  const poolInput = document.getElementById('pool-address') as HTMLInputElement | null;
  if (poolInput) {
    poolInput.oninput = () => {
      state.customPool = poolInput.value;
      state.poolCheck = undefined;
      schedulePoolCheck();
      // Re-render for the button state without losing the caret.
      paintCta();
    };
  }

  const connectDest = document.getElementById('connect-dest');
  if (connectDest) connectDest.onclick = () => void doConnectEvm();

  const mint = document.getElementById('cash-mint');
  if (mint) mint.onclick = () => void doCashMint();

  const claimEvm = document.getElementById('claim-evm');
  if (claimEvm) claimEvm.onclick = () => void doClaimEvm();

  const closePicker = (): void => { state.evmPicker = undefined; render(); };
  const backdrop = document.getElementById('wallet-modal');
  if (backdrop) {
    // Click the backdrop itself, not a click that bubbled up from the dialog.
    backdrop.onclick = (e) => { if (e.target === backdrop) closePicker(); };
    document.getElementById('wallet-modal-close')!.onclick = closePicker;
  }

  document.querySelectorAll<HTMLButtonElement>('.wallet-row').forEach((row) => {
    row.onclick = () => {
      state.evmPicker = undefined;
      void doConnectEvm(row.dataset.wallet!);
    };
  });

  const details = document.querySelector('.details-wrap');
  if (details) {
    details.addEventListener('toggle', () => {
      state.detailsOpen = (details as HTMLDetailsElement).open;
    });
  }

  const cta = document.getElementById('cta');
  if (cta) cta.onclick = () => void onCta();
}

let poolCheckTimer: ReturnType<typeof setTimeout> | undefined;
let poolCheckToken = 0;

/// Check as the user types, but not on every keystroke: an address is pasted or
/// typed in bursts, and each check is two RPC reads.
function schedulePoolCheck(): void {
  if (poolCheckTimer) clearTimeout(poolCheckTimer);
  poolCheckTimer = setTimeout(() => void doCheckPool(), 350);
}

async function doCheckPool(): Promise<void> {
  const input = state.customPool;
  if (!normalisePoolAddress(input)) {
    state.poolChecking = false;
    state.poolCheck = undefined;
    render();
    return;
  }
  // Answers can arrive out of order once someone edits mid-flight. Only the
  // newest one is allowed to write.
  const mine = ++poolCheckToken;
  state.poolChecking = true;
  render();
  const result = await checkPool(state.asset, input);
  if (mine !== poolCheckToken || state.customPool !== input) return;
  state.poolChecking = false;
  state.poolCheck = result;
  render();
}

/// The wallet, in the header, connect-or-address -- the shape VeilX uses in its
/// topbar. One wallet serves both chains, so there is one chip.
function paintNavWallets(): void {
  const host = document.getElementById('nav-wallets');
  if (!host) return;

  // Two states, two meanings, and they must not look alike. Connected is a
  // STATUS chip -- muted, because it is reporting, not asking. Not connected is
  // an ACTION, and the muted style read as greyed-out for it: the same grey the
  // CTA uses for `:disabled`, on the one control the page most needs pressed.
  const address = state.evmSession?.address;
  const chip = address
    ? `<button class="nav-chip is-on" id="nav-wallet" title="Your assets">
         <span class="nav-dot"></span><span class="mono">${esc(short(address, 6, 4))}</span>
       </button>`
    : `<button class="nav-chip is-action" id="nav-wallet">Connect wallet</button>`;

  // Only when a wallet is connected and there is something to claim: a faucet
  // button with nowhere to send the tokens is just a dead control.
  const faucet = state.evmSession && faucetTokens().length
    ? `<button class="nav-chip is-action" id="get-faucets" ${state.busy ? 'disabled' : ''}>
         ${state.busy === FAUCET_BUSY ? 'Claiming…' : 'Get faucets'}
       </button>`
    : '';

  host.innerHTML = faucet + chip;

  const getFaucets = document.getElementById('get-faucets');
  if (getFaucets) getFaucets.onclick = () => void doGetFaucets();
  document.getElementById('nav-wallet')!.onclick = () =>
    void (state.evmSession ? openWalletPanel() : doConnectEvm());

  paintWalletPanel();
}

/// The assets behind the wallet, in veilx's balances panel: PUBLIC balances on
/// Ethereum and PRIVATE ones -- the notes this wallet owns in the Veil pool --
/// side by side. The private column needs the viewing key, which costs one
/// signature the first time; it is never asked for just because the panel
/// opened.
function paintWalletPanel(): void {
  const session = state.evmSession;
  let host = document.getElementById('wallet-panel');
  if (!state.walletPanel || !session) {
    if (host) host.innerHTML = '';
    return;
  }
  if (!host) {
    host = document.createElement('div');
    host.id = 'wallet-panel';
    document.body.appendChild(host);
  }

  const busy = state.balancesBusy.evm || state.balancesBusy.veil;
  const list = assets.filter((a) => a.addresses.evm?.token || a.addresses.starknet?.token);
  const cell = (v: AssetBalance | undefined, reading: boolean, locked = false): string =>
    v ? units(v.balance, v.decimals, 4) : locked ? '·' : reading ? '…' : '—';
  const locked = !state.noteCtx;
  const rows = list.map((a) => `<div class="bal-row">
      <span class="bal-sym">${esc(a.symbol)}</span>
      <span class="bal-name">${esc(a.name)}</span>
      <span class="bal-amt">${esc(cell(state.publicBalances?.[a.id], state.balancesBusy.evm))}</span>
      <span class="bal-amt">${esc(a.addresses.starknet?.token ? cell(state.privateBalances?.[a.id], state.balancesBusy.veil, locked) : '—')}</span>
    </div>`).join('');
  const error = state.balancesError.evm ?? state.balancesError.veil;

  host.innerHTML = `
    <div class="bal-backdrop" data-bal="close"></div>
    <div class="bal-panel" role="dialog" aria-label="Your assets">
      <div class="bal-head">
        <strong>Your assets</strong>
        <span class="mono">${esc(short(session.address, 6, 4))}</span>
      </div>
      <div class="bal-row bal-hdr">
        <span class="bal-sym">Asset</span><span class="bal-name"></span>
        <span class="bal-amt">${esc(evmLabel)}</span><span class="bal-amt">In Veil</span>
      </div>
      ${rows || '<div class="bal-row"><span class="bal-name">No assets on this route.</span></div>'}
      ${error ? `<div class="bal-err">${esc(error)}</div>` : ''}
      <div class="bal-foot">
        ${locked ? `<button data-bal="unlock" ${busy ? 'disabled' : ''}>Show Veil balances</button>` : ''}
        <button data-bal="refresh" ${busy ? 'disabled' : ''}>${busy ? 'Loading…' : 'Refresh'}</button>
        <button data-bal="disconnect">Disconnect</button>
      </div>
    </div>`;

  host.querySelector<HTMLElement>('[data-bal="close"]')!.onclick = () => {
    state.walletPanel = false;
    render();
  };
  const unlock = host.querySelector<HTMLButtonElement>('[data-bal="unlock"]');
  if (unlock) unlock.onclick = () => void loadWalletBalances(true);
  host.querySelector<HTMLButtonElement>('[data-bal="refresh"]')!.onclick = () => void loadWalletBalances(false);
  host.querySelector<HTMLButtonElement>('[data-bal="disconnect"]')!.onclick = () => {
    state.walletPanel = false;
    void doDisconnect();
  };
}

function openWalletPanel(): void {
  state.walletPanel = !state.walletPanel;
  render();
  if (state.walletPanel) void loadWalletBalances(false);
}

/// Read the balances for the panel. Public ones always; private ones when the
/// viewing key is at hand, or when `unlock` -- the holder pressing "Show Veil
/// balances" -- asks for the one signature that derives it.
async function loadWalletBalances(unlock: boolean): Promise<void> {
  const session = state.evmSession;
  if (!session || state.balancesBusy.evm || state.balancesBusy.veil) return;
  state.balancesBusy = { evm: true, veil: Boolean(state.noteCtx) || unlock };
  state.balancesError = {};
  render();
  const publicRead = (async () => {
    const list = assets.filter((a) => a.addresses.evm?.token);
    const read = await Promise.all(list.map((a) => evm.publicBalance(a, session.address)));
    // The wallet may have switched account while this was reading.
    if (state.evmSession?.address !== session.address) return;
    state.publicBalances = Object.fromEntries(list.map((a, i) => [a.id, read[i]]));
    if (read.some((r) => r === undefined)) {
      state.balancesError.evm = 'Some balances could not be read. Try Refresh.';
    }
  })().catch((e: any) => { state.balancesError.evm = `Could not read balances: ${String(e?.message ?? e)}`; })
    .finally(() => { state.balancesBusy.evm = false; });

  const privateRead = (async () => {
    if (!state.noteCtx && !unlock) return;
    const pool = mainPool(state.asset);
    if (!pool) {
      state.balancesError.veil = 'No Veil pool is configured for this deployment.';
      return;
    }
    if (!state.noteCtx) state.noteCtx = await deriveNoteContext(session);
    const list = assets.filter((a) => a.addresses.starknet?.token);
    const read = await privateBalances(pool, state.noteCtx, list);
    // Notes of a Securitize twin hold shares; show what they are worth.
    await Promise.all(list.map(async (a) => {
      const row = read[a.id];
      if (!row || a.addresses.evm?.kind !== 'securitize') return;
      const info = await evm.tokenInfo(a);
      const scale = await evm.unitScale(a, info.decimals);
      read[a.id] = { balance: unitsToTokens(row.balance, scale), decimals: info.decimals };
    }));
    if (state.evmSession?.address !== session.address) return;
    state.privateBalances = read;
  })().catch((e: any) => {
    const m = String(e?.message ?? e);
    state.balancesError.veil = /reject|denied|abort|cancel/i.test(m)
      ? 'Sign the message in your wallet to read your private balances.'
      : `Could not read your Veil balances: ${m}`;
  }).finally(() => { state.balancesBusy.veil = false; });

  await Promise.all([publicRead, privateRead]);
  render();
}

const FAUCET_BUSY = 'Claiming test tokens…';

/// Stock the connected wallet with every faucet asset.
///
/// One transaction through the router when there is one. These are TESTNET
/// assets with a public claim, so this mints to the connected address and
/// registers it -- neither of which a real issuer would ever let an app do.
async function doGetFaucets(): Promise<void> {
  if (!state.evmSession) return doConnectEvm();
  const tokens = faucetTokens();
  if (!tokens.length) {
    state.error = 'No faucet assets are deployed on this route.';
    render();
    return;
  }
  state.busy = FAUCET_BUSY; paintCta(); render();
  try {
    const { batched, claimed } = await evm.claimFaucets(state.evmSession, tokens, faucetRouter());
    state.notice = batched
      ? `Claimed test tokens for ${claimed} of ${tokens.length} assets.`
      : 'Claimed test tokens.';
    state.error = undefined;
  } catch (e: any) {
    // A repeat visit hits the cooldown, which is not a failure worth a red banner.
    const message = e?.shortMessage ?? e?.message ?? String(e);
    state.error = /cooldown/i.test(message)
      ? 'Already claimed recently — the faucet has a cooldown.'
      : message;
  } finally {
    state.busy = undefined;
    await refreshAll();
  }
}

function paintCta(): void {
  const button = document.getElementById('cta') as HTMLButtonElement | null;
  if (!button) return;
  const cta = ctaLabel();
  button.textContent = cta.text;
  button.disabled = cta.disabled;
  const note = document.querySelector('.cta-note');
  if (note) note.textContent = cta.note;
}

document.addEventListener('click', () => {
  if (state.pickerOpen) { state.pickerOpen = false; render(); }
});

// Escape closes whatever is open. A modal with no way out but a precise click
// on the backdrop is the other half of "impossible to use".
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.walletPanel) { state.walletPanel = undefined; render(); }
  else if (state.evmPicker) { state.evmPicker = undefined; render(); }
  else if (state.pickerOpen) { state.pickerOpen = false; render(); }
});

// ------------------------------------------------------------------- actions

async function reverse(): Promise<void> {
  state.direction = toStarknet() ? 'toEvm' : 'toStarknet';
  // Same wallet either way: it is the recipient in both directions.
  state.recipient = state.evmSession?.address ?? '';
  state.amount = '';
  state.fee = undefined;
  state.error = undefined;
  state.notice = undefined;
  render();
  await refreshAll();
}

async function selectAsset(id: string): Promise<void> {
  const next = assets.find((a) => a.id === id);
  if (!next || !usableAsset(next) || next.id === state.asset.id) {
    state.pickerOpen = false; render(); return;
  }
  // Switching asset switches the whole contract set, so every cached read is
  // stale. Drop them rather than showing one asset's balance under another's.
  state.asset = next;
  state.pickerOpen = false;
  state.token = { symbol: next.symbol, decimals: next.decimals };
  state.scale = tokenScale(next.decimals);
  state.amount = '';
  state.fee = undefined;
  state.evmStatus = undefined;
  state.mirror = undefined;
  state.claimableEvm = 0n;
  state.error = undefined;
  state.notice = undefined;
  // The note and the pool check both belong to the old asset: a note id is
  // derived per token, and a pool carrying one asset need not carry another.
  state.noteId = '';
  state.noteCtx = undefined;
  state.noteSlot = undefined;
  state.noteClaimedBy = undefined;
  state.noteSearched = false;
  state.poolCheck = undefined;
  state.poolChecking = false;
  state.cashFee = undefined;
  state.cashPrivate = undefined;
  state.privateTwin = undefined;
  state.evmStatus = undefined;
  render();
  try { state.token = await evm.tokenInfo(next); } catch { /* catalogue stands */ }
  // The viewing key is per wallet, not per asset: keep it, so switching to USDC
  // (or away) does not ask for the signature again.
  await restoreNoteContext();
  await refreshAll();
}

let quoteTimer: number | undefined;
function refreshQuote(): void {
  window.clearTimeout(quoteTimer);
  quoteTimer = window.setTimeout(async () => {
    if (!state.asset.available || !state.recipient) return;
    let amount = 0n;
    try { amount = parseUnits(state.amount || '0', state.token.decimals); } catch { return; }
    if (amount <= 0n) return;
    if (cashAsset()) {
      // Circle's fee comes out of the transfer itself, in USDC.
      state.cashFee = cashFast()
        ? await cash.transferParams(
            amount, true,
            toStarknet() ? ETHEREUM_DOMAIN : STARKNET_DOMAIN,
            toStarknet() ? STARKNET_DOMAIN : ETHEREUM_DOMAIN,
          ).then((p) => p.maxFee).catch(() => undefined)
        : 0n;
      paintCta();
      const cell = document.getElementById('cash-fee');
      if (cell) cell.textContent = cashFeeText();
      return;
    }
    try {
      // Bridging back, the fee is STRK the gateway pays; it is shown so the
      // holder knows what they are capping, not because they pay it.
      state.fee = toStarknet()
        ? await evm.quote(state.asset, amount, state.recipient)
        : await sn.quoteBridgeBack(state.asset, await evm.unitsFor(state.asset, amount), state.recipient);
    } catch {
      // Usually an unwired peer; the eligibility panel explains that better.
      state.fee = undefined;
    }
    paintCta();
    const cell = document.getElementById('msg-fee');
    if (cell) cell.textContent = msgFeeText();
  }, 350);
}

/// Re-read everything that depends on the connected wallets and the recipient.
async function refreshAll(): Promise<void> {
  const asset = state.asset;
  if (!asset.available) { render(); return; }
  // A rebase re-prices the twin's units, so the scale is read with everything else.
  state.scale = await evm.unitScale(asset, state.token.decimals).catch(() => state.scale);
  const jobs: Array<Promise<void>> = [];

  if (isCash(asset)) {
    if (state.evmSession) {
      jobs.push(cash.evmStatus(state.evmSession.address).then((s) => { state.evmStatus = s; }).catch(() => {}));
    }
    if (state.noteCtx) jobs.push(loadCashPrivate());
    await Promise.all(jobs);
    render();
    refreshQuote();
    return;
  }

  if (state.evmSession) {
    const me = state.evmSession.address;
    jobs.push(evm.evmStatus(asset, me).then((s) => { state.evmStatus = s; }).catch(() => {}));
    jobs.push(evm.claimableOf(asset, me).then((c) => { state.claimableEvm = c; }).catch(() => {}));
    // The wallet holds as itself on the mirror too, so its own record is the
    // one that decides both directions.
    jobs.push(sn.mirrorStatus(asset, me).then((m) => { state.mirror = inTokens(m); }).catch(() => {}));
    if (state.noteCtx) jobs.push(loadPrivateTwin());
  }
  await Promise.all(jobs);
  render();
  refreshQuote();
}


async function doConnectEvm(rdns?: string): Promise<void> {
  state.busy = 'Connecting…'; paintCta();
  const previous = state.evmSession?.address;
  try {
    state.evmSession = await evm.connectEvm(rdns);
    watchEvm();
    if (previous && previous.toLowerCase() !== state.evmSession.address.toLowerCase()) forgetHolder();
    state.token = await evm.tokenInfo(state.asset);
    // The destination is this wallet, in both directions. Not a choice.
    state.recipient = state.evmSession.address;
    state.error = undefined;
  } catch (e: any) {
    // More than one wallet installed: show the picker instead of guessing.
    if (e?.name === 'PickEvmWalletError') {
      state.evmPicker = e.wallets;
      state.error = undefined;
    } else {
      state.error = e?.message ?? String(e);
    }
  } finally {
    state.busy = undefined;
  }
  // Connecting signs nothing. The viewing key is derived when something needs
  // it -- a bridge, or the holder asking for their Veil balance -- unless this
  // browser already holds it for this wallet.
  await restoreNoteContext();
  await refreshAll();
  await findNoteIfFree();
}

/// The viewing key, when it costs no signature: this browser already derived
/// it for the connected wallet.
async function restoreNoteContext(): Promise<void> {
  const session = state.evmSession;
  if (!session || state.noteCtx) return;
  const chainId = (await sn.snProvider.getChainId().catch(() => '')) as unknown as string;
  if (chainId && hasCachedViewingKey(session.address, chainId)) {
    state.noteCtx = await deriveNoteContext(session).catch(() => undefined);
  }
}

/// Drop everything derived from the previous wallet: its viewing key reads
/// only its own notes, and a note found for it is not this wallet's.
function forgetHolder(): void {
  state.noteCtx = undefined;
  state.noteId = '';
  state.noteSlot = undefined;
  state.noteClaimedBy = undefined;
  state.noteSearched = false;
  state.poolVerified = undefined;
  state.privateBalances = undefined;
  state.privateTwin = undefined;
  state.cashPrivate = undefined;
  state.mirror = undefined;
}

/// Verify the wallet in the Veil pool, registering it first if it is not yet,
/// the way veilx does. Runs only once the viewing key is signed for.
///
/// A wallet the pool has never seen cannot own a note -- the pool refuses to
/// create one (VIEW_KEY_MISSING). And a registered key only counts if it is the
/// one this wallet signs for: the pool derives the note channel from the STORED
/// key, so any other key puts the note where this app cannot find it. Returns
/// false, with the reason in `state.error` when there is one, unless verified.
async function ensureRegistered(): Promise<boolean> {
  if (!state.evmSession || !state.noteCtx || !state.asset.poolReady) return false;
  const pk = await registeredViewingKey(state.asset, state.evmSession.address);
  if (pk === undefined) {
    state.error = 'Could not check your registration in the Veil pool. Try again in a moment.';
    render();
    return false;
  }
  if (pk !== 0n) {
    state.poolVerified = pk === state.noteCtx.publicViewingKey;
    if (!state.poolVerified) {
      state.error = 'This wallet is registered in the Veil pool with a different viewing key, so notes cannot be created for it here.';
    }
    render();
    return state.poolVerified;
  }
  state.busy = 'Registering your wallet…'; paintCta(); render();
  try {
    const r = await registerInPool(state.asset, state.noteCtx, (line) => {
      state.busy = `Registering your wallet — ${line}…`; paintCta();
    });
    state.poolVerified = r.ok;
    if (!r.ok) state.error = r.reason;
    return r.ok;
  } finally {
    state.busy = undefined;
    render();
  }
}

/// Find the note only if that costs NO signature.
///
/// Connecting, or re-attaching on page load, is not a request for anything, so
/// it must never pop a prompt the holder did not ask for. With the viewing key
/// already cached it finds the note and reads the registration; registering, a
/// signed action, waits for Bridge.
async function findNoteIfFree(): Promise<void> {
  if (!state.evmSession || !state.noteCtx || !toStarknet() || !state.asset.poolReady) return;
  await doFindNote();
  const pk = await registeredViewingKey(state.asset, state.evmSession.address);
  if (pk !== undefined && pk !== 0n) state.poolVerified = pk === state.noteCtx?.publicViewingKey;
  render();
}


async function doFindNote(): Promise<void> {
  if (!state.evmSession) return doConnectEvm();
  state.busy = 'Check your wallet…'; paintCta();
  try {
    if (!state.noteCtx) state.noteCtx = await deriveNoteContext(state.evmSession);
    const slot = await findFillableNote(state.asset, state.noteCtx);
    state.noteSlot = slot;
    state.noteId = slot?.noteId ?? '';
    state.noteSearched = true;
    state.error = undefined;
  } catch (e: any) {
    // Declining the prompt is a choice, not a failure. Leave the panel on its
    // "sign to find my note" state rather than colouring it as an error.
    const m = String(e?.message ?? e);
    state.error = /reject|denied|abort|cancel/i.test(m) ? undefined : m;
  } finally {
    state.busy = undefined;
    if (state.noteId) await refreshNoteOwner();
    else if (cashAsset()) await refreshAll();
    else render();
  }
}

async function refreshNoteOwner(): Promise<void> {
  // A USDC note is filled by the cash vault, not claimed on a gateway.
  if (cashAsset()) { void refreshAll(); return; }
  if (!validNoteId() || !state.asset.poolReady) { state.noteClaimedBy = undefined; render(); return; }
  try {
    state.noteClaimedBy = await sn.noteOwner(state.asset, state.noteId);
  } catch {
    state.noteClaimedBy = undefined;
  }
  render();
}


async function doClaimEvm(): Promise<void> {
  if (!state.evmSession) return doConnectEvm();
  state.busy = 'Claiming…'; paintCta();
  try {
    await evm.claimHeld(state.evmSession, state.asset, state.evmSession.address);
    state.notice = 'Released on ' + evmLabel + '.';
  } catch (e: any) {
    state.error = e?.shortMessage ?? e?.message ?? String(e);
  } finally {
    state.busy = undefined;
    await refreshAll();
  }
}

/// How long one Bridge press waits for a LayerZero message before handing the
/// holder over to History to follow it.
const MESSAGE_WAIT_MS = 10 * 60 * 1000;

/// The bridge's LayerZero message kinds for each logged message.
const MESSAGE_KINDS: Record<Exclude<Kind, 'transfer'>, number[]> = { eligibility: [2], rules: [5, 6] };

/// Log in History every eligibility or rules update this wallet has on its way
/// through any of this route's lockboxes, as LayerZero Scan reports them -- so
/// the holder sees them wherever they were sent from.
async function adoptInFlight(address: string): Promise<void> {
  const messages = await inFlightByWallet(address);
  if (!messages.length) return;
  const known = new Set(loadHistory().map((t) => t.hash.toLowerCase()));
  for (const m of messages.reverse()) {
    if (known.has(m.hash.toLowerCase())) continue;
    const asset = assets.find((a) => a.addresses.evm?.lockbox?.toLowerCase() === m.sender);
    const kind = (Object.keys(MESSAGE_KINDS) as Exclude<Kind, 'transfer'>[])
      .find((k) => MESSAGE_KINDS[k].includes(m.kind));
    if (!asset || !kind) continue;
    // Logged when LayerZero first saw it, not now: it was sent earlier.
    record({
      kind, direction: 'toStarknet', asset: asset.id, symbol: asset.symbol,
      amount: '', recipient: address, hash: m.hash, status: 'sent',
    }, m.status.since);
    lzSeen.set(m.hash, m.status);
  }
}

/// The latest message of `kind` for this asset and wallet that is still on its
/// way -- so a second press, a reload or another device waits for it instead
/// of paying for another. LayerZero Scan is asked first, since this browser's
/// History does not see what another device sent; whatever it reports in flight
/// is logged here so the holder can follow it. A message LayerZero reports
/// delivered or failed is closed, and does not count.
async function pendingMessage(
  kind: Exclude<Kind, 'transfer'>, asset: Asset, address: string,
): Promise<Transfer | undefined> {
  await adoptInFlight(address);
  const open = loadHistory().filter((x) => x.kind === kind && x.asset === asset.id && x.status === 'sent'
    && x.recipient.toLowerCase() === address.toLowerCase());
  let latest: Transfer | undefined;
  for (const t of open) {
    const lz = await lzStatus(t.hash);
    if (lz?.stage === 'delivered') { update(t.id, 'delivered'); continue; }
    if (lz?.stage === 'failed') { update(t.id, 'failed'); continue; }
    latest ??= t;
  }
  return latest;
}

/// Wait for a message to land, saying where it is. `arrived` reads the far
/// side: true once it took effect, false while not yet, and a string when it
/// arrived with an answer that stops the bridge.
async function waitForMessage(
  msg: Transfer, what: string, arrived: () => Promise<boolean | string>,
): Promise<boolean> {
  const deadline = Date.now() + MESSAGE_WAIT_MS;
  let lz: LzStatus | undefined;
  for (;;) {
    const result = await arrived().catch(() => false);
    if (result === true) { update(msg.id, 'delivered'); return true; }
    if (typeof result === 'string') { update(msg.id, 'delivered'); state.error = result; return false; }
    lz = await lzStatus(msg.hash);
    if (lz?.stage === 'failed') {
      update(msg.id, 'failed');
      state.error = `LayerZero could not deliver your ${what}${lz.raw ? ` (${lz.raw})` : ''}. Press Bridge to send it again.`;
      return false;
    }
    if (Date.now() >= deadline) break;
    state.busy = `${what[0].toUpperCase()}${what.slice(1)}: ${(lz?.text ?? 'on its way').toLowerCase()} ${elapsed(lz?.since ?? msg.at)}…`;
    paintCta();
    await new Promise((r) => setTimeout(r, 15000));
  }
  state.error = `Your ${what} is still on its way (${(lz?.text ?? 'not delivered yet').toLowerCase()}). `
    + 'Nothing is lost and it will not be sent twice. Follow it under History, and press Bridge again once it shows delivered.';
  return false;
}

/// Make sure the mirror holds a fresh eligibility record for the connected
/// account on this asset.
///
/// The record is a snapshot and the mirror fails closed once it expires, so the
/// pool will not make a note for a holder whose record is missing or stale. The
/// bridge-in itself carries a fresh snapshot, but the note has to exist first.
/// Anyone may push it, so the holder does, and only when it is needed. The push
/// is a LayerZero message, so it is logged in History with where it is.
async function ensureIdentitySynced(): Promise<boolean> {
  const asset = state.asset;
  const source = state.evmSession;
  if (!source) return false;
  const status = await sn.identityFreshness(asset, source.address);
  if (status === undefined) {
    state.error = 'The mirrored registry did not answer, so your eligibility could not be checked. Try again in a moment.';
    return false;
  }
  if (status.verified && status.fresh) return true;

  let msg = await pendingMessage('eligibility', asset, source.address);
  if (!msg) {
    state.busy = `Confirm the eligibility update in your ${evmLabel} wallet…`; paintCta(); render();
    const hash = await evm.syncCompliance(source, asset);
    msg = record({
      kind: 'eligibility', direction: 'toStarknet', asset: asset.id, symbol: state.token.symbol,
      amount: '', recipient: source.address, hash, status: 'sent',
    });
  }
  return waitForMessage(msg, 'eligibility update', async () => {
    const now = await sn.identityFreshness(asset, source.address);
    if (!now || !now.fresh) return false;
    return now.verified ? true : `${evmLabel} says this account is not eligible to hold ${state.token.symbol}.`;
  });
}

/// Make sure the mirror holds fresh issuer rules for the connected account, for
/// an asset whose mirror enforces them (a Securitize token).
///
/// The pool enforces the issuer's locks, caps and whole-balance rules inside its
/// proof, from records the lockbox pushes. The mirror fails closed: with no
/// fresh record the holder's notes read as fully locked and a delivery is
/// refused. Anyone may push the records, so the holder does it here, once, and
/// again only after they expire. Logged in History like the eligibility update.
async function ensureRulesSynced(): Promise<boolean> {
  const asset = state.asset;
  const source = state.evmSession;
  if (!source) return false;
  const status = await sn.rulesFreshness(asset, source.address);
  if (status === undefined) {
    state.error = 'The mirrored registry did not answer, so the issuer rules could not be checked. Try again in a moment.';
    return false;
  }
  if (!status.required || (status.account && status.token)) return true;

  let msg = await pendingMessage('rules', asset, source.address);
  if (!msg) {
    state.busy = `Confirm the rules update in your ${evmLabel} wallet…`; paintCta(); render();
    const hashes = await evm.syncRules(source, asset, !status.token);
    for (const hash of hashes) {
      msg = record({
        kind: 'rules', direction: 'toStarknet', asset: asset.id, symbol: state.token.symbol,
        amount: '', recipient: source.address, hash, status: 'sent',
      });
    }
  }
  return waitForMessage(msg!, 'issuer rules update', async () => {
    const now = await sn.rulesFreshness(asset, source.address);
    return Boolean(now && now.account && now.token);
  });
}

/// Get the destination ready to receive, doing only what is still missing.
///
/// Five things have to be true before a bridge-in can land in a pool note: the
/// wallet's viewing key is derived, that key is registered in the pool, the
/// mirror holds a fresh eligibility record for the wallet (and fresh issuer
/// rules where the asset has them), and an empty note exists for this asset.
/// None of them is something the holder asked for, so none of them gets its
/// own button -- they run inside the one press, and each is skipped when
/// already done. The note needs no separate claim: the bridge-in names the
/// wallet as the holder, and that is its claim on the note.
///
/// Returns false when a step could not complete, having put the reason in
/// `state.error`. The caller must not go on to escrow anything in that case:
/// the tokens would arrive with nowhere to land and quarantine.
async function prepareDestination(): Promise<boolean> {
  const asset = state.asset;
  const session = state.evmSession;
  if (!session) return false;

  // 1. The viewing key: one signature, cached after.
  if (!state.noteCtx) {
    state.busy = 'Sign in your wallet…'; paintCta(); render();
    state.noteCtx = await deriveNoteContext(session);
  }

  // 2. Registration in the pool, through the prover.
  if (!(await ensureRegistered())) {
    state.error = state.error ?? 'Your wallet is not registered in the Veil pool yet.';
    return false;
  }

  // 3. A fresh eligibility record, and the issuer rules where the asset has
  //    them: the pool makes a note only for a holder the mirror vouches for.
  if (!(await ensureIdentitySynced())) return false;
  if (!(await ensureRulesSynced())) return false;

  // 4. A fillable note. Look before making one: a note holds a single deposit,
  //    so an unused one from a previous attempt is the one to use.
  if (!validNoteId()) {
    const found = await findFillableNote(asset, state.noteCtx);
    if (found) { state.noteSlot = found; state.noteId = found.noteId; }
    state.noteSearched = true;
  }
  if (!validNoteId()) {
    state.busy = 'Creating your note…'; paintCta(); render();
    const made = await createOpenNote(asset, state.noteCtx, (line) => {
      state.busy = `Creating your note — ${line}…`; paintCta();
    });
    if (!made.ok) { state.error = made.reason; return false; }
    state.noteSlot = made.slot;
    state.noteId = made.slot.noteId;
    state.noteSearched = true;
  }

  // 5. Nobody else holds a claim on it. `fill_open_note` is one-shot and note
  //    ids are public; an unclaimed note is claimed by the bridge-in itself.
  const owner = await sn.noteOwner(asset, state.noteId).catch(() => undefined);
  state.noteClaimedBy = owner;
  if (owner !== undefined && BigInt(owner || 0) !== 0n && BigInt(owner) !== BigInt(session.address)) {
    state.error = 'Your note is claimed by another address, so it cannot be filled for you.';
    return false;
  }
  return true;
}

async function onCta(): Promise<void> {
  if (!state.evmSession) return doConnectEvm();
  // Bridging back starts from the private balance, so read it first.
  if (!toStarknet() && !state.noteCtx) return doShowVeilBalance();

  let amount: bigint;
  try {
    amount = parseUnits(state.amount, state.token.decimals);
  } catch (e: any) {
    state.error = e.message; render(); return;
  }

  const asset = state.asset;
  if (isCash(asset)) {
    try {
      if (toStarknet()) await cashToVeil(amount);
      else await cashToEvm(amount);
    } catch (e: any) {
      state.error = friendlyError(e);
    } finally {
      state.busy = undefined;
      await refreshAll();
    }
    return;
  }
  try {
    if (toStarknet()) {
      // Everything the delivery needs, in this one press. The holder asked to
      // bridge; the viewing key, the note, its claim and the allowance are ours
      // to arrange. Any of them may already be done, and each is skipped if so.
      if (!(await prepareDestination())) return;

      // `approve` awaits its receipt, so the allowance is on chain before the
      // transfer is built -- returning here instead would leave the tokens
      // unmoved with the card looking unchanged.
      if (state.evmStatus && state.evmStatus.allowance < amount) {
        state.busy = 'Approve in wallet…'; paintCta(); render();
        await evm.approve(state.evmSession!, asset, amount);
      }
      const fee = state.fee ?? (await evm.quote(asset, amount, state.recipient));
      state.busy = 'Confirm in wallet…'; paintCta();
      const { hash, guid } = await evm.bridgeOut(
        state.evmSession!, asset, amount, state.recipient, fee, state.noteId, selectedPool()
      );
      record({
        direction: 'toStarknet', asset: asset.id, symbol: state.token.symbol,
        amount: units(amount, state.token.decimals), recipient: state.recipient,
        hash, guid, status: 'sent',
      });
      state.notice = 'Sent. Delivery takes a few minutes — track it under History.';
      state.amount = '';
      void watchDelivery(asset, hash, state.recipient);
    } else {
      // The twin burns units; the amount typed is tokens.
      const burn = await evm.unitsFor(asset, amount);
      // A fresh quote, with headroom: the gateway pays it and the wallet signs
      // the cap, so a fee that moved a little does not fail the exit.
      const fee = await sn.quoteBridgeBack(asset, burn, state.recipient);
      if (!(await ensureRegistered())) {
        state.error = state.error ?? 'Your wallet is not registered in the Veil pool yet.';
        return;
      }
      state.busy = 'Sign in your wallet…'; paintCta(); render();
      const hash = await bridgeBackPrivately(
        asset, state.noteCtx!, burn, state.recipient, (fee * 13n) / 10n,
        (line) => { state.busy = `Bridging back — ${line}…`; paintCta(); },
      );
      record({
        direction: 'toEvm', asset: asset.id, symbol: state.token.symbol,
        amount: units(amount, state.token.decimals), recipient: state.recipient,
        hash, status: 'sent',
      });
      state.notice = 'Burned in the Veil pool and sent. The lockbox releases it to your wallet on arrival — a few minutes.';
      state.amount = '';
      void watchRelease(asset, hash, state.recipient);
    }
  } catch (e: any) {
    state.error = e?.shortMessage ?? e?.message ?? String(e);
  } finally {
    state.busy = undefined;
    await refreshAll();
  }
}

/// Read the viewing key (one signature) and the private balance behind it.
async function doShowVeilBalance(): Promise<void> {
  if (!state.evmSession) return doConnectEvm();
  state.busy = 'Sign in your wallet…'; paintCta(); render();
  try {
    if (!state.noteCtx) state.noteCtx = await deriveNoteContext(state.evmSession);
    state.error = undefined;
  } catch (e: any) {
    const m = String(e?.message ?? e);
    state.error = /reject|denied|abort|cancel/i.test(m) ? undefined : m;
  } finally {
    state.busy = undefined;
    await refreshAll();
  }
}

/// The selected asset's twin in the holder's private notes, in tokens.
async function loadPrivateTwin(): Promise<void> {
  const pool = state.asset.addresses.starknet?.pool;
  if (!pool || !state.noteCtx || cashAsset()) return;
  const read = await privateBalances(pool, state.noteCtx, [state.asset]).catch(() => undefined);
  if (read) state.privateTwin = unitsToTokens(read[state.asset.id]?.balance ?? 0n, state.scale);
}

/// Poll the far side until the twin supply moves or the amount shows up held.
/// Both are terminal; neither is an error.
async function watchDelivery(asset: Asset, hash: string, recipient: string): Promise<void> {
  const before = await sn.twinSupply(asset).catch(() => 0n);
  const deadline = Date.now() + 15 * 60 * 1000;
  const id = loadHistory().find((t) => t.hash === hash)?.id;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20000));
    try {
      const [supply, mirror] = await Promise.all([sn.twinSupply(asset), sn.mirrorStatus(asset, recipient)]);
      if (supply > before) {
        if (id) update(id, 'minted');
        state.notice = `Delivered and minted on ${starknetLabel}.`;
        await refreshAll(); return;
      }
      if (mirror.pending > 0n) {
        if (id) update(id, 'quarantined');
        state.notice = 'Delivered, but held: the recipient is not eligible yet. It stays claimable.';
        await refreshAll(); return;
      }
    } catch { /* transient RPC, keep polling */ }
  }
}

/// The mirror image: watch the EVM side for the release, or for it being held.
async function watchRelease(asset: Asset, hash: string, recipient: string): Promise<void> {
  const deadline = Date.now() + 15 * 60 * 1000;
  const id = loadHistory().find((t) => t.hash === hash)?.id;
  const before = await evm.claimableOf(asset, recipient).catch(() => 0n);
  const balanceBefore = state.evmStatus?.balance ?? 0n;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20000));
    try {
      const held = await evm.claimableOf(asset, recipient);
      if (held > before) {
        if (id) update(id, 'quarantined');
        state.notice = 'Arrived, but held: the recipient is not verified on ' + evmLabel + '. It stays claimable.';
        await refreshAll(); return;
      }
      if (state.evmSession) {
        const s = await evm.evmStatus(asset, state.evmSession.address);
        if (s.balance > balanceBefore) {
          if (id) update(id, 'minted');
          state.notice = `Released on ${evmLabel}.`;
          await refreshAll(); return;
        }
      }
    } catch { /* transient RPC, keep polling */ }
  }
}

// ------------------------------------------------------------------ cash leg
//
// USDC over Circle's CCTP V2. No lockbox, no twin, no LayerZero:
//   in  -- the Ethereum wallet burns into the holder's empty USDC note, naming
//          Veil's cash vault as mint recipient and sole relayer; once Circle
//          attests, Veil's relayer delivers it and the vault fills the note.
//   out -- a proven pool invoke (the prover's relayer submits it) pays Veil's
//          cash exit, which burns to the Ethereum wallet; once Circle attests,
//          the wallet confirms the mint.
// The holder's wallet signs both; it never sends a Starknet transaction.

/// How long after Circle's attestation before saying Veil's relayer is late.
const RELAY_GRACE_MS = 3 * 60 * 1000;
/// The pool's side of the route, as the rest of this card names it.
const veilLabel = starknetLabel;
const friendlyError = (e: any): string => String(e?.shortMessage ?? e?.message ?? e);

function cashGates(): Gate[] {
  const s = state.evmStatus;
  const out: Gate[] = [];
  if (state.evmSession) {
    out.push({ ok: s ? !s.frozen : null, label: `Circle has not blocklisted your ${evmLabel} address` });
    out.push({ ok: s ? !s.paused : null, label: 'USDC is not paused' });
  }
  if (state.poolVerified === false) {
    out.push({
      ok: false,
      label: 'Your wallet is registered in the Veil pool',
      detail: 'It is registered with a different viewing key, so notes cannot be created for it here.',
    });
  }
  return out;
}

function cashFeeText(): string {
  if (!cashFast()) return '0 (Standard)';
  return state.cashFee !== undefined ? `up to ${units(state.cashFee, state.token.decimals)} USDC` : '…';
}

function cashDetails(): string {
  const time = cashFast() ? '~20 seconds for Circle to attest'
    : toStarknet() ? '~15–19 min (Ethereum finality)' : '~2–4 hours (Starknet finality on Ethereum)';
  return `<div class="detail"><dt>Circle fee</dt><dd id="cash-fee">${esc(cashFeeText())}</dd></div>
      <div class="detail"><dt>Carried by</dt><dd>Circle CCTP V2</dd></div>
      <div class="detail"><dt>Estimated time</dt><dd>${esc(time)}</dd></div>`;
}

function cashControls(): string {
  const fast = cashFast();
  const standardTime = toStarknet() ? '~15–19 min' : '~2–4 h';
  const toggle = `<div class="pool-choice">
    <div class="seg seg-sm" role="radiogroup" aria-label="Transfer speed">
      <button class="seg-btn${fast ? '' : ' is-on'}" data-speed="standard" role="radio" aria-checked="${!fast}">Standard · free · ${standardTime}</button>
      <button class="seg-btn${fast ? ' is-on' : ''}" data-speed="fast" role="radio" aria-checked="${fast}">Fast · ~20 s · Circle fee</button>
    </div></div>`;
  const head = toStarknet() ? 'Lands in the Veil pool' : `Arrives on ${evmLabel}`;
  const note = toStarknet()
    ? `<p class="delivery-note">Burned through Circle's CCTP into your private USDC note in the Veil pool. Veil's cash vault fills it; nothing to sign on ${veilLabel}.</p>`
    : `<p class="delivery-note">Leaves the pool privately through Veil's cash exit. After Circle attests, one confirmation in your ${evmLabel} wallet mints it to you.</p>`;
  const noteLine = toStarknet() && state.evmSession && state.noteId
    ? `<div class="note-found"><span class="note-label">Your USDC note</span>
         <span class="note-id mono">${esc(short(state.noteId, 10, 8))}</span>
         <span class="note-index">slot ${state.noteSlot?.index ?? 0}</span></div>`
    : '';
  const faucet = toStarknet() && (deployment.evmNetwork ?? '').includes('sepolia')
    ? `<p class="delivery-note">Test USDC: <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">Circle's faucet</a> (${esc(evmLabel)}).</p>`
    : '';
  return `<div class="delivery">
    <div class="delivery-head">${head}</div>
    ${toggle}${noteLine}${note}${faucet}${flightCard()}
  </div>`;
}

/// Where the last USDC transfer in this direction is, and what (if anything)
/// the holder can do about it.
function flightCard(): string {
  const f = state.cashFlight;
  if (!f || f.direction !== state.direction) return '';
  const burnLink = f.direction === 'toStarknet' ? `${EXPLORER_EVM}/tx/${f.hash}` : `${EXPLORER_SN}/tx/${f.hash}`;
  const link = `<a href="${esc(burnLink)}" target="_blank" rel="noreferrer">burn</a>`;
  let line: string;
  let action = '';
  if (f.stage === 'delivered') {
    line = f.direction === 'toStarknet'
      ? `Delivered into your private Veil note.`
      : `Minted on ${evmLabel}.`;
  } else if (f.stage === 'burned') {
    line = `Burned (${link}). Waiting for Circle to attest…`;
  } else if (f.direction === 'toStarknet') {
    const late = f.attestedAt !== undefined && Date.now() - f.attestedAt > RELAY_GRACE_MS;
    line = late
      ? `Circle attested, but Veil's relayer has not delivered it yet. Nothing is lost: it retries until your note is filled.`
      : `Circle attested. Veil's relayer is delivering it into your note…`;
  } else {
    line = `Circle attested. Confirm the mint in your ${evmLabel} wallet.`;
    action = `<button id="cash-mint" class="max" ${state.busy ? 'disabled' : ''}>Mint on ${esc(evmLabel)}</button>`;
  }
  return `<div class="note-found"><span class="note-label">USDC on its way</span></div>
    <p class="delivery-note${f.stage === 'delivered' ? ' is-ok' : ''}">${line}</p>${action}`;
}

function cashCta(amount: bigint): { text: string; disabled: boolean; note: string } {
  const sym = state.token.symbol;
  if (!PROVER_ENDPOINT || !PROVER_MASTER_ADDRESS) {
    return {
      text: toStarknet() ? 'Note creation unavailable' : 'Exit unavailable', disabled: true,
      note: 'Moving USDC in or out of the pool needs a Veil prover endpoint, which this deployment has not configured.',
    };
  }
  if (amount >= (1n << 128n)) {
    return { text: 'Amount too large for a note', disabled: true, note: 'A note holds at most 2^128 - 1 base units.' };
  }
  const fee = cashFast()
    ? `Circle fee ${cashFeeText()}, taken from the amount`
    : 'No Circle fee (Standard Transfer)';
  const s = state.evmStatus;
  if (toStarknet()) {
    if (!s) {
      return { text: 'Cannot check USDC', disabled: true, note: `${evmLabel} did not answer. Nothing is sent until it does.` };
    }
    if (s.frozen) return { text: 'Blocklisted by Circle', disabled: true, note: 'Circle does not let this address move USDC.' };
    if (s.paused) return { text: 'USDC is paused', disabled: true, note: 'Circle has paused USDC.' };
    const needsApproval = s.allowance < amount;
    return {
      text: `Move ${sym} into Veil`,
      disabled: false,
      note: needsApproval
        ? `Two wallet confirmations: approve ${sym}, then burn through Circle's CCTP. ${fee}.`
        : `${fee}. Lands in your private Veil note.`,
    };
  }
  if (state.cashPrivate === undefined) {
    return { text: `Reading your ${veilLabel} USDC…`, disabled: true, note: 'Your notes are read with your viewing key.' };
  }
  if (amount + 1n > state.cashPrivate) {
    return { text: 'Insufficient balance', disabled: true, note: 'The exit keeps 1 unit (0.000001 USDC) back in the pool as change.' };
  }
  if (s?.frozen) {
    return { text: 'Recipient blocklisted by Circle', disabled: true, note: 'Circle does not mint USDC to a blocklisted address.' };
  }
  return {
    text: `Move ${sym} to ${evmLabel}`,
    disabled: false,
    note: `${fee}. Proven in ${veilLabel}; then you confirm the mint on ${evmLabel}.`,
  };
}

async function loadCashPrivate(): Promise<void> {
  const pool = state.asset.addresses.starknet?.pool;
  if (!pool || !state.noteCtx) return;
  const read = await privateBalances(pool, state.noteCtx, [state.asset]).catch(() => undefined);
  if (read) state.cashPrivate = read[state.asset.id]?.balance ?? 0n;
}

/// The destination note for a deposit: registered, empty, and not already the
/// target of a burn on its way.
async function prepareCashNote(): Promise<boolean> {
  if (!state.evmSession) return false;
  if (!state.noteCtx) {
    state.busy = 'Sign in your wallet…'; paintCta(); render();
    state.noteCtx = await deriveNoteContext(state.evmSession);
  }
  if (!(await ensureRegistered())) {
    state.error = state.error ?? 'Your wallet is not registered in the Veil pool yet.';
    return false;
  }
  const busy = cash.inFlightNotes();
  if (validNoteId() && !busy.has(BigInt(state.noteId))) return true;

  let slot = await cash.findFreeNote(state.noteCtx, busy);
  if (!slot) {
    state.busy = 'Creating your USDC note…'; paintCta(); render();
    const made = await createOpenNote(state.asset, state.noteCtx, (line) => {
      state.busy = `Creating your USDC note — ${line}…`; paintCta();
    });
    if (!made.ok) { state.error = made.reason; return false; }
    // `createOpenNote` reports the FIRST empty note, which may be one a burn is
    // already on its way to. Look again, skipping those, until the new one shows.
    for (let attempt = 0; attempt < 20 && !slot; attempt++) {
      slot = await cash.findFreeNote(state.noteCtx, busy);
      if (!slot) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!slot) {
      state.error = 'Your note was created, but this RPC cannot see it yet. It is not lost: press the button again in a moment.';
      return false;
    }
  }
  state.noteSlot = slot;
  state.noteId = slot.noteId;
  state.noteSearched = true;
  return true;
}

async function cashToVeil(amount: bigint): Promise<void> {
  if (!(await prepareCashNote())) return;
  const session = state.evmSession!;
  if (!state.evmStatus || state.evmStatus.allowance < amount) {
    state.busy = 'Approve USDC in wallet…'; paintCta(); render();
    await cash.approve(session, amount);
  }
  const noteId = state.noteId;
  state.busy = 'Confirm the burn in wallet…'; paintCta(); render();
  const hash = await cash.burnToVeil(session, amount, noteId, state.cashFast.toStarknet);
  cash.markInFlight(noteId);
  const item = record({
    direction: 'toStarknet', asset: state.asset.id, symbol: state.token.symbol,
    amount: units(amount, state.token.decimals), recipient: state.recipient, hash, note: noteId, status: 'sent',
  });
  const flight: CashFlight = { direction: 'toStarknet', hash, historyId: item.id, noteId, stage: 'burned' };
  state.cashFlight = flight;
  state.notice = `Burned on ${evmLabel}. Once Circle attests, Veil's relayer fills your note — nothing to sign on ${veilLabel}.`;
  state.amount = '';
  // The note is spoken for until the vault fills it; the next deposit gets another.
  state.noteId = '';
  state.noteSlot = undefined;
  void watchCashIn(flight);
}

async function cashToEvm(amount: bigint): Promise<void> {
  if (!state.evmSession) return doConnectEvm();
  if (!state.noteCtx) {
    state.busy = 'Sign in your wallet…'; paintCta(); render();
    state.noteCtx = await deriveNoteContext(state.evmSession);
  }
  if (!(await ensureRegistered())) {
    state.error = state.error ?? 'Your wallet is not registered in the Veil pool yet.';
    return;
  }
  const recipient = state.evmSession.address;
  state.busy = 'Leaving the pool…'; paintCta(); render();
  const hash = await cash.exitToEvm(state.noteCtx, amount, recipient, state.cashFast.toEvm, (line) => {
    state.busy = `Leaving the pool — ${line}…`; paintCta();
  });
  const item = record({
    direction: 'toEvm', asset: state.asset.id, symbol: state.token.symbol,
    amount: units(amount, state.token.decimals), recipient, hash, status: 'sent',
  });
  const flight: CashFlight = { direction: 'toEvm', hash, historyId: item.id, stage: 'burned' };
  state.cashFlight = flight;
  state.notice = state.cashFast.toEvm
    ? `Burned in the Veil pool. Circle attests in about 20 seconds; then confirm the mint.`
    : `Burned in the Veil pool. Circle attests a Standard Transfer from Starknet in about 2 to 4 hours; then confirm the mint.`;
  state.amount = '';
  void watchCashOut(flight);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WATCH_MS = 6 * 60 * 60 * 1000;

async function watchCashIn(f: CashFlight): Promise<void> {
  const deadline = Date.now() + WATCH_MS;
  while (Date.now() < deadline && state.cashFlight === f && f.stage !== 'delivered') {
    await sleep(15000);
    try {
      if (f.stage === 'burned') {
        const m = await cash.irisMessage(ETHEREUM_DOMAIN, f.hash);
        if (m?.attested) {
          f.stage = 'attested'; f.message = m.message; f.attestation = m.attestation; f.attestedAt = Date.now();
        }
      }
      if (f.noteId && cash.isFilled(await cash.noteValue(f.noteId))) {
        f.stage = 'delivered';
        cash.forgetInFlight(f.noteId);
        if (f.historyId) update(f.historyId, 'minted');
        state.notice = `Delivered into your private Veil note.`;
        await refreshAll();
        return;
      }
      render();
    } catch { /* transient: keep watching */ }
  }
}

async function watchCashOut(f: CashFlight): Promise<void> {
  const deadline = Date.now() + WATCH_MS;
  while (Date.now() < deadline && state.cashFlight === f && f.stage === 'burned') {
    await sleep(15000);
    try {
      const m = await cash.irisMessage(STARKNET_DOMAIN, f.hash);
      if (m?.attested) {
        f.stage = 'attested'; f.message = m.message; f.attestation = m.attestation; f.attestedAt = Date.now();
        state.notice = `Circle attested. Confirm the mint in your ${evmLabel} wallet.`;
        render();
        return;
      }
    } catch { /* transient: keep watching */ }
  }
}

async function doCashMint(): Promise<void> {
  const f = state.cashFlight;
  if (!f?.message || !f.attestation) return;
  if (!state.evmSession) return doConnectEvm();
  state.busy = 'Confirm the mint in wallet…'; paintCta(); render();
  try {
    await cash.mintOnEvm(state.evmSession, f.message, f.attestation);
    f.stage = 'delivered';
    if (f.historyId) update(f.historyId, 'minted');
    state.notice = `Minted on ${evmLabel}.`;
  } catch (e: any) {
    state.error = friendlyError(e);
  } finally {
    state.busy = undefined;
    await refreshAll();
  }
}

/// A USDC transfer outlives the page: an exit's Standard attestation takes
/// hours. Pick the newest unfinished one back up from the history.
function resumeCashFlight(): void {
  const t = loadHistory().find((x) => x.asset === 'usdc' && x.status === 'sent');
  if (!t) return;
  const f: CashFlight = { direction: t.direction, hash: t.hash, historyId: t.id, noteId: t.note, stage: 'burned' };
  state.cashFlight = f;
  if (t.direction === 'toStarknet') void watchCashIn(f); else void watchCashOut(f);
}

// ---------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  render();
  if (state.asset.available) {
    try { state.token = await evm.tokenInfo(state.asset); } catch { /* catalogue stands */ }
    render();
  }

  // Only the gateways on the current class take EVM wallets as holders. Ask
  // each once; an asset whose gateway says no is shown, but cannot be picked.
  await Promise.all(assets.map(async (a) => {
    if (!a.available || isCash(a)) return;
    const ok = await sn.supportsEvmHolders(a);
    if (ok !== undefined) a.evmReady = ok;
  }));
  if (!usableAsset(state.asset)) {
    const next = assets.find(usableAsset);
    if (next) {
      state.asset = next;
      state.token = { symbol: next.symbol, decimals: next.decimals };
      state.scale = tokenScale(next.decimals);
      try { state.token = await evm.tokenInfo(next); } catch { /* catalogue stands */ }
    }
  }
  render();

  // Re-attach the wallet the user already authorised HERE, without prompting,
  // so a reload keeps the session instead of looking like a disconnect.
  //
  // Runs even when no asset is deployed: whether a wallet is connected has
  // nothing to do with whether this route carries an asset, and returning early
  // was leaving the header showing "Connect" for an already-connected wallet.
  const session = await evm.restoreEvm();
  resumeCashFlight();
  if (!session) return;
  state.evmSession = session;
  state.recipient = session.address;
  watchEvm();

  await restoreNoteContext();
  await refreshAll();
  await findNoteIfFree();
}

async function doDisconnect(): Promise<void> {
  const previous = state.evmSession?.address;
  unwatchEvm?.();
  unwatchEvm = undefined;
  evm.disconnectEvm();
  // The viewing key decrypts every note this wallet owns, so it must not
  // outlive the session -- especially on a shared machine.
  if (previous) {
    const chainId = (await sn.snProvider.getChainId().catch(() => '')) as unknown as string;
    if (chainId) forgetViewingKey(previous, chainId);
  }
  forgetHolder();
  state.evmSession = undefined;
  state.evmStatus = undefined;
  state.claimableEvm = 0n;
  state.publicBalances = undefined;
  state.walletPanel = false;
  state.recipient = '';
  state.error = undefined;
  await refreshAll();
}

/// The wallet can change account or network under the page. Without this the
/// UI keeps showing the old address while the next signature comes from the new
/// one -- which on a bridge means escrowing from an account the checks were
/// never run against.
let unwatchEvm: (() => void) | undefined;
function watchEvm(): void {
  unwatchEvm?.();
  if (!state.evmSession) return;
  unwatchEvm = evm.watchEvmWallet(state.evmSession, () => {
    void (async () => {
      const before = state.evmSession?.address;
      const next = await evm.restoreEvm();
      // Another account holds other notes: nothing derived for the old one may
      // be used for it.
      if (!next || next.address.toLowerCase() !== before?.toLowerCase()) forgetHolder();
      state.evmSession = next;
      state.recipient = next?.address ?? '';
      if (!next) state.notice = 'Wallet disconnected.';
      await restoreNoteContext();
      await refreshAll();
    })();
  });
}

void boot();
