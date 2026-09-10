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

import {
  isDeployed, evmLabel, starknetLabel, EXPLORER_EVM, EXPLORER_SN, LZ_SCAN, STARKNET_FEE_TOKEN,
  PROVER_ENDPOINT, PROVER_MASTER_ADDRESS,
} from './config';
import { assets, defaultAsset, faucetTokens, faucetRouter, type Asset } from './assets';
import { short, units, parseUnits, duration, ago } from './format';
import * as evm from './evm';
import * as sn from './starknet';
import { load as loadHistory, record, update, type Transfer } from './history';
import {
  deriveNoteContext, findFillableNote, forgetViewingKey, createOpenNote,
  hasCachedViewingKey, type NoteContext, type NoteSlot,
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
  evmSession?: evm.EvmSession;
  snSession?: sn.SnSession;
  token: { symbol: string; decimals: number };
  amount: string;
  recipient: string;
  /// Wallets to choose between, when more than one is installed.
  evmPicker?: evm.EvmWallet[];
  evmStatus?: evm.EvmStatus;
  mirror?: sn.MirrorStatus;
  claimableEvm: bigint;
  feeBalance: bigint;
  fee?: bigint;
  busy?: string;
  error?: string;
  notice?: string;
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
  token: { symbol: initial.symbol, decimals: initial.decimals },
  amount: '',
  recipient: '',
  claimableEvm: 0n,
  feeBalance: 0n,
};

const app = document.getElementById('app')!;
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const tint = (a: Asset): string => `linear-gradient(150deg, ${a.tint[0]}, ${a.tint[1]})`;
const toStarknet = () => state.direction === 'toStarknet';

const sourceLabel = () => (toStarknet() ? evmLabel : starknetLabel);
const destLabel = () => (toStarknet() ? starknetLabel : evmLabel);
const sourceMark = () => (toStarknet() ? 'eth' : 'sn');
const destMark = () => (toStarknet() ? 'sn' : 'eth');

/// The balance the transfer spends from, on whichever chain is the source.
function sourceBalance(): bigint | undefined {
  if (toStarknet()) return state.evmStatus?.balance;
  return state.mirror?.balance;
}

// --------------------------------------------------------------- eligibility

type Gate = { ok: boolean | null; label: string; detail?: string };

function gates(): Gate[] {
  const s = state.evmStatus;
  const m = state.mirror;
  const out: Gate[] = [];

  if (toStarknet()) {
    out.push({
      ok: s ? s.verified : null,
      label: 'You are verified on the source registry',
      detail: s && !s.verified ? 'The issuer has not registered this address.' : undefined,
    });
    out.push({ ok: s ? !s.frozen : null, label: 'Your address is not frozen' });
    out.push({ ok: s ? !s.paused : null, label: `${state.token.symbol} is not paused` });
    out.push({
      ok: s ? s.lockboxRegistered : null,
      label: 'The bridge is an approved holder',
      detail: s && !s.lockboxRegistered
        ? 'The issuer must register the lockbox in the identity registry, or the escrow reverts inside the token.'
        : undefined,
    });
    if (state.recipient) {
      out.push({
        ok: m ? m.verified : null,
        label: `Recipient is eligible on ${starknetLabel}`,
        detail: m && !m.verified
          ? (m.identity === 0n
              ? 'Not yet mirrored. The transfer will be held and claimable once eligibility is pushed.'
              : m.fresh
                ? 'The mirror says this identity is not currently eligible.'
                : 'The mirrored record has gone stale, so it fails closed until refreshed.')
          : undefined,
      });
    }
  } else {
    out.push({
      ok: m ? m.verified : null,
      label: `You are eligible on ${starknetLabel}`,
      detail: m && !m.verified
        ? (m.identity === 0n
            ? 'This wallet is not bound to any source identity, so it cannot hold or move the twin.'
            : m.fresh
              ? 'The mirror says this identity is not currently eligible.'
              : 'The mirrored record has gone stale. Anyone can refresh it with syncCompliance.')
        : undefined,
    });
    out.push({
      ok: m ? m.fresh || m.stalenessWindow === 0 : null,
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
  const connected = toStarknet() ? state.evmSession : state.snSession;
  if (!connected) {
    return `<div class="eligibility"><div class="eligibility-head">Eligibility</div>
      <p>Connect a wallet to check whether this transfer is permitted.</p></div>`;
  }

  const list = gates();
  const failing = list.filter((g) => g.ok === false);
  // A check that could not be RUN is not a check that passed. Reads fail when
  // an RPC is down or an address is wrong, and answering "cleared to bridge"
  // because nothing came back is the one answer a compliance gate must never
  // give. Unknown is its own state.
  const unknown = list.filter((g) => g.ok === null);
  const onlyRecipient = failing.length > 0 && failing.every((g) => g.label.startsWith('Recipient'));
  const tone = failing.length > 0
    ? (onlyRecipient ? 'is-warn' : 'is-bad')
    : unknown.length > 0 ? 'is-warn' : 'is-good';
  const head = failing.length > 0
    ? (onlyRecipient ? 'Will arrive held' : 'Blocked')
    : unknown.length > 0 ? 'Could not check' : 'Cleared to bridge';

  const items = list.map((g) => {
    const mark = g.ok === null ? '<span class="mark idk">·</span>'
      : g.ok ? '<span class="mark ok">✓</span>' : '<span class="mark no">✕</span>';
    return `<li>${mark}<span>${esc(g.label)}${g.detail ? `<br><span style="color:var(--faint)">${esc(g.detail)}</span>` : ''}</span></li>`;
  }).join('');

  const stale = state.mirror && state.mirror.stalenessWindow > 0
    ? `<p style="margin-top:9px">Mirrored eligibility expires after ${duration(state.mirror.stalenessWindow)}. Anyone can refresh it.</p>`
    : '';

  return `<div class="eligibility ${tone}"><div class="eligibility-head">${head}</div>
    <ul class="checks">${items}</ul>${stale}</div>`;
}

// ------------------------------------------------------------------- claims

/// A held balance is invisible unless something goes looking, so the card
/// surfaces both sides and offers the release. Claiming is permissionless: the
/// funds can only reach the address the original message named.
function claimsCard(): string {
  const pending = state.mirror?.pending ?? 0n;
  const held = state.claimableEvm;
  if (pending === 0n && held === 0n) return '';

  const rows: string[] = [];
  if (pending > 0n) {
    const ready = state.mirror?.verified === true;
    rows.push(`<div class="claim-row">
      <div><strong>${esc(units(pending, state.token.decimals))} ${esc(state.token.symbol)}</strong>
        <span class="claim-where">held on ${esc(starknetLabel)}</span></div>
      <button id="claim-sn" class="max" ${ready && state.snSession ? '' : 'disabled'}>
        ${ready ? (state.snSession ? 'Claim' : 'Connect wallet') : 'Not eligible yet'}
      </button>
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
    <p class="claims-note">Arrived while the recipient was not eligible. Nothing is lost — it stays claimable, and anyone can pay the gas to release it.</p>
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
  if (!toStarknet() || !state.asset.poolReady) return '';
  const claimed = state.noteClaimedBy;
  const mine = claimed && state.snSession &&
    BigInt(claimed) === BigInt(state.snSession.address);
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
        ? `<p class="delivery-note">Lands in the main Veil pool <span class="mono">${esc(short(main, 8, 6))}</span>, the one Veil already runs. One pool carries every asset.</p>`
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
  if (!state.snSession) {
    return `<p class="delivery-note">Connect your ${esc(starknetLabel)} wallet to find your open note.</p>`;
  }
  if (!state.noteCtx) {
    // The one signature in the app, and it happens here because the holder
    // asked -- never as a side effect of connecting.
    return `<p class="delivery-note">Your note is derived from your viewing key, which never leaves this device. This asks your wallet to <strong>sign one message</strong> — it is not a transaction and costs nothing.</p>
      <button id="derive-note" class="max" style="margin-top:8px">Sign to find my open note</button>`;
  }
  if (!state.noteId) {
    // The bridge MAKES one. `create_open_note` is proven through the SDK, so
    // there is nothing to go and do in another app.
    const canCreate = Boolean(PROVER_ENDPOINT && PROVER_MASTER_ADDRESS);
    return `<p class="delivery-note">
        You have no empty note for ${esc(state.token.symbol)} yet — a note holds one
        deposit, so each transfer needs a fresh one.
      </p>
      ${canCreate
        ? `<button id="create-note" class="max" style="margin-top:8px">Create my open note</button>
           <p class="delivery-note">Proved and settled for you. No signature, no gas.</p>`
        : `<p class="delivery-note is-warn">Note creation needs a Veil prover endpoint, which this deployment has not configured.</p>
           <button id="derive-note" class="max" style="margin-top:8px">Look again</button>`}`;
  }

  const state_line = mine
    ? `<p class="delivery-note is-ok">Claimed by you. Ready to fill.</p>`
    : unclaimed
      ? `<p class="delivery-note is-warn">Claim it first, or the transfer lands in the wallet above.</p>
         <button id="claim-note" class="max" style="margin-top:8px">Claim this note</button>`
      : claimed !== undefined
        ? `<p class="delivery-note is-warn">Claimed by another address, so it cannot be filled for you.</p>`
        : '';

  return `<div class="note-found">
      <span class="note-label">Your open note</span>
      <span class="note-id mono">${esc(short(state.noteId, 10, 8))}</span>
      <span class="note-index">slot ${state.noteSlot?.index ?? 0}</span>
    </div>
    ${state_line}
    <p class="delivery-note">Derived from your viewing key, so only you can spend it. If it cannot be filled the amount lands in the wallet above — never lost.</p>`;
}

/// A note id must be a non-zero felt. Refusing an empty one saves a message
/// that would silently degrade on the far side.
function validNoteId(): boolean {
  const raw = state.noteId.trim();
  if (!raw) return false;
  try { return BigInt(raw) !== 0n; } catch { return false; }
}

// ------------------------------------------------------------- asset picker

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
    return `<button class="asset-row${selected ? ' is-selected' : ''}${a.available ? '' : ' is-off'}"
        data-asset="${esc(a.id)}" ${a.available ? '' : 'disabled'} role="option" aria-selected="${selected}">
      <span class="token-mark" style="background:${tint(a)}"></span>
      <span class="asset-text"><span class="asset-symbol">${esc(a.symbol)}</span>
        <span class="asset-name">${esc(a.name)}</span></span>
      <span class="asset-tag">${a.available ? esc(a.category) : 'not deployed'}</span></button>`;
  }).join('');
  return `<div class="picker" role="listbox" aria-label="Select an asset">
    <div class="picker-head">Asset</div>${rows}
    <div class="picker-foot">Each asset has its own lockbox and twin. They are never pooled.</div></div>`;
}

// ------------------------------------------------------------------ transfer

function ctaLabel(): { text: string; disabled: boolean; note: string } {
  if (!isDeployed) return { text: 'Not deployed', disabled: true, note: 'No deployment found for this network pair.' };
  if (!state.asset.available) {
    return { text: `${state.asset.symbol} not available`, disabled: true, note: 'Pick an asset this deployment carries.' };
  }
  if (state.busy) return { text: state.busy, disabled: true, note: '' };

  if (toStarknet() && !state.evmSession) return { text: `Connect ${evmLabel} wallet`, disabled: false, note: '' };
  if (!toStarknet() && !state.snSession) return { text: `Connect ${starknetLabel} wallet`, disabled: false, note: '' };
  if (!state.recipient) {
    return {
      text: `Connect your ${destLabel()} wallet`,
      disabled: true,
      note: 'The destination is your own wallet — it is never typed in.',
    };
  }

  let amount = 0n;
  try { amount = parseUnits(state.amount || '0', state.token.decimals); } catch { /* below */ }
  if (amount <= 0n) return { text: 'Enter an amount', disabled: true, note: '' };

  const balance = sourceBalance();
  if (balance !== undefined && amount > balance) return { text: 'Insufficient balance', disabled: true, note: '' };

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
    if (s && !s.verified) return { text: 'Not eligible to bridge', disabled: true, note: 'Your address is not verified on the source registry.' };
    if (s && !s.lockboxRegistered) return { text: 'Bridge not approved by issuer', disabled: true, note: 'The lockbox must be a registered identity before any escrow can succeed.' };
    if (s && s.allowance < amount) return { text: `Approve ${state.token.symbol}`, disabled: false, note: 'One approval, then the transfer.' };
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
      if (!validNoteId()) {
        return { text: 'Enter an open note id', disabled: true, note: 'A pool delivery needs a note to fill.' };
      }
      if (amount >= (1n << 128n)) {
        return { text: 'Amount too large for a note', disabled: true, note: 'A note holds at most 2^128 - 1 base units.' };
      }
    }
    const fee = state.fee !== undefined ? `${units(state.fee, 18, 5)} ETH` : '…';
    return { text: 'Bridge', disabled: false, note: `Message fee ${fee}, paid to LayerZero.` };
  }

  const m = state.mirror;
  if (m && !m.verified) return { text: 'Not eligible to bridge', disabled: true, note: 'A frozen or revoked holder cannot move value, cross-chain included.' };
  if (state.fee !== undefined && state.feeBalance < state.fee) {
    return { text: 'Not enough STRK for the fee', disabled: true, note: `Need ${units(state.fee, 18, 5)} STRK.` };
  }
  const fee = state.fee !== undefined ? `${units(state.fee, 18, 5)} STRK` : '…';
  return { text: 'Bridge back', disabled: false, note: `Message fee ${fee}. You approve the gateway, which pays the endpoint.` };
}

function transferView(): string {
  const cta = ctaLabel();
  const bal = sourceBalance();
  const balance = bal !== undefined ? `${units(bal, state.token.decimals)} ${state.token.symbol}` : '—';
  const other = toStarknet() ? state.mirror?.balance : state.evmStatus?.balance;
  const destBalance = other !== undefined ? `${units(other, state.token.decimals)} ${state.token.symbol}` : '—';

  const banner = !isDeployed
    ? `<div class="banner is-bad">No deployment loaded. Run the scripts in <span class="mono">scripts/</span>, then <span class="mono">npm run dev</span> again.</div>`
    : state.error ? `<div class="banner is-bad">${esc(state.error)}</div>`
    : state.notice ? `<div class="banner">${esc(state.notice)}</div>` : '';

  // The destination is WHOEVER IS CONNECTED, never something typed.
  //
  // On the way in, the amount lands in an open note whose id is derived from
  // the recipient's PRIVATE viewing key. Only they can produce that, by signing
  // -- so a typed address could never receive into a pool, and offering the box
  // would only invite someone to send to an address the app cannot deliver to.
  // Connecting is also what derives the key, exactly as VeilX does it: connect,
  // sign the typed message, and the note follows.
  const destWallet = toStarknet() ? state.snSession?.address : state.evmSession?.address;
  const connectDest = destWallet
    ? `<div class="dest-wallet"><span class="dest-mark"></span><span class="mono">${esc(short(destWallet, 10, 8))}</span>
         <button class="dest-disconnect" data-disconnect="${toStarknet() ? 'sn' : 'evm'}"
           title="Disconnect">Disconnect</button></div>`
    : `<button id="connect-dest" class="max" style="margin-top:8px">Connect ${esc(toStarknet() ? starknetLabel : evmLabel)} wallet</button>`;

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

    <dl class="details">
      <div class="detail"><dt>Asset</dt><dd>${esc(state.asset.name)}</dd></div>
      <div class="detail"><dt>Route</dt><dd>${esc(sourceLabel())} → ${esc(destLabel())}</dd></div>
      ${toStarknet() && state.asset.poolReady
        ? `<div class="detail"><dt>Lands as</dt><dd>Pool note</dd></div>` : ''}
      <div class="detail"><dt>Message fee</dt><dd>${state.fee !== undefined ? units(state.fee, 18, 6) + (toStarknet() ? ' ETH' : ' STRK') : '—'}</dd></div>
      <div class="detail"><dt>Bridge fee</dt><dd>0</dd></div>
      <div class="detail"><dt>Estimated time</dt><dd>~3–10 min</dd></div>
    </dl>

    <button id="cta" class="cta" ${cta.disabled ? 'disabled' : ''}>${esc(cta.text)}</button>
    ${cta.note ? `<div class="cta-note">${esc(cta.note)}</div>` : ''}
  </div>`;
}

// ------------------------------------------------------------------- history

function historyView(): string {
  const items = loadHistory();
  if (!items.length) {
    return `<div class="history"><div class="history-empty">
      <p style="margin:0 0 6px;font-weight:600;color:var(--ink)">No transfers yet</p>
      <p style="margin:0">Bridged transfers from this browser will appear here.</p></div></div>`;
  }
  const rows = items.map((t: Transfer) => {
    const dir = t.direction === 'toStarknet'
      ? `${esc(evmLabel)} → ${esc(starknetLabel)}` : `${esc(starknetLabel)} → ${esc(evmLabel)}`;
    const explorer = t.direction === 'toStarknet' ? EXPLORER_EVM : EXPLORER_SN;
    return `<div class="row">
      <div class="row-main">${esc(t.amount)} ${esc(t.symbol ?? '')}<span style="color:var(--faint);font-weight:500">${dir}</span></div>
      <span class="status ${t.status}">${t.status}</span>
      <div class="row-sub">${esc(ago(t.at))} · to ${esc(short(t.recipient, 8, 6))} ·
        <a href="${explorer}/tx/${esc(t.hash)}" target="_blank" rel="noreferrer">tx</a>
        ${t.guid ? ` · <a href="${LZ_SCAN}/tx/${esc(t.hash)}" target="_blank" rel="noreferrer">LayerZero</a>` : ''}
      </div></div>`;
  }).join('');
  return `<div class="history">${rows}</div>`;
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
  const deriveNote = document.getElementById('derive-note');
  if (deriveNote) deriveNote.onclick = () => void doFindNote();
  const createNote = document.getElementById('create-note');
  if (createNote) createNote.onclick = () => void doCreateNote();
  const claimNote = document.getElementById('claim-note');
  if (claimNote) claimNote.onclick = () => void doClaimNote();

  const connectDest = document.getElementById('connect-dest');
  if (connectDest) connectDest.onclick = () => void (toStarknet() ? doConnectStarknet() : doConnectEvm());

  const claimSn = document.getElementById('claim-sn');
  if (claimSn) claimSn.onclick = () => void doClaimStarknet();
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

  document.querySelectorAll<HTMLButtonElement>('[data-disconnect]').forEach((b) => {
    b.onclick = () => void doDisconnect(b.dataset.disconnect as 'sn' | 'evm');
  });

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

/// Both wallets, in the header, connect-or-address -- the shape VeilX uses in
/// its topbar. A bridge touches two chains, so a single "Connect wallet" would
/// never say which one it meant.
function paintNavWallets(): void {
  const host = document.getElementById('nav-wallets');
  if (!host) return;

  const chip = (
    chain: 'evm' | 'sn', label: string, address: string | undefined
  ): string => address
    ? `<button class="nav-chip is-on" data-nav-wallet="${chain}" title="${esc(label)} — click to disconnect">
         <span class="nav-dot"></span><span class="mono">${esc(short(address, 6, 4))}</span>
       </button>`
    : `<button class="nav-chip" data-nav-wallet="${chain}">Connect ${esc(label)}</button>`;

  // Only when an EVM wallet is connected and there is something to claim:
  // a faucet button with nowhere to send the tokens is just a dead control.
  const faucet = state.evmSession && faucetTokens().length
    ? `<button class="nav-chip" id="get-faucets" ${state.busy ? 'disabled' : ''}>
         ${state.busy === FAUCET_BUSY ? 'Claiming…' : 'Get faucets'}
       </button>`
    : '';

  host.innerHTML =
    faucet +
    chip('evm', evmLabel, state.evmSession?.address) +
    chip('sn', starknetLabel, state.snSession?.address);

  const getFaucets = document.getElementById('get-faucets');
  if (getFaucets) getFaucets.onclick = () => void doGetFaucets();

  host.querySelectorAll<HTMLButtonElement>('[data-nav-wallet]').forEach((b) => {
    const chain = b.dataset.navWallet as 'evm' | 'sn';
    const connected = chain === 'evm' ? state.evmSession : state.snSession;
    b.onclick = () => void (connected
      ? doDisconnect(chain === 'evm' ? 'evm' : 'sn')
      : chain === 'evm' ? doConnectEvm() : doConnectStarknet());
  });
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
    const { batched } = await evm.claimFaucets(state.evmSession, tokens, faucetRouter());
    state.notice = batched
      ? `Claimed test tokens for all ${tokens.length} assets.`
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
  if (state.evmPicker) { state.evmPicker = undefined; render(); }
  else if (state.pickerOpen) { state.pickerOpen = false; render(); }
});

// ------------------------------------------------------------------- actions

async function reverse(): Promise<void> {
  state.direction = toStarknet() ? 'toEvm' : 'toStarknet';
  // The recipient belongs to whichever chain is now the destination, and the
  // old value is an address on the wrong one. Prefill from a connected wallet
  // rather than leaving something that would fail validation.
  const wallet = toStarknet() ? state.snSession?.address : state.evmSession?.address;
  state.recipient = wallet ?? '';
  state.amount = '';
  state.fee = undefined;
  state.error = undefined;
  state.notice = undefined;
  render();
  await refreshAll();
}

async function selectAsset(id: string): Promise<void> {
  const next = assets.find((a) => a.id === id);
  if (!next || !next.available || next.id === state.asset.id) {
    state.pickerOpen = false; render(); return;
  }
  // Switching asset switches the whole contract set, so every cached read is
  // stale. Drop them rather than showing one asset's balance under another's.
  state.asset = next;
  state.pickerOpen = false;
  state.token = { symbol: next.symbol, decimals: next.decimals };
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
  render();
  try { state.token = await evm.tokenInfo(next); } catch { /* catalogue stands */ }
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
    try {
      state.fee = toStarknet()
        ? await evm.quote(state.asset, amount, state.recipient)
        : await sn.quoteBridgeBack(state.asset, amount, state.recipient);
    } catch {
      // Usually an unwired peer; the eligibility panel explains that better.
      state.fee = undefined;
    }
    paintCta();
    const cells = document.querySelectorAll('.detail dd');
    if (cells[2]) {
      cells[2].textContent = state.fee !== undefined
        ? `${units(state.fee, 18, 6)} ${toStarknet() ? 'ETH' : 'STRK'}` : '—';
    }
  }, 350);
}

/// Re-read everything that depends on the connected wallets and the recipient.
async function refreshAll(): Promise<void> {
  const asset = state.asset;
  if (!asset.available) { render(); return; }
  const jobs: Array<Promise<void>> = [];

  if (state.evmSession) {
    jobs.push(evm.evmStatus(asset, state.evmSession.address).then((s) => { state.evmStatus = s; }).catch(() => {}));
    jobs.push(evm.claimableOf(asset, state.evmSession.address).then((c) => { state.claimableEvm = c; }).catch(() => {}));
  }
  if (state.snSession) {
    jobs.push(sn.mirrorStatus(asset, state.snSession.address).then((m) => { state.mirror = m; }).catch(() => {}));
    jobs.push(sn.feeTokenBalance(STARKNET_FEE_TOKEN, state.snSession.address).then((b) => { state.feeBalance = b; }).catch(() => {}));
  }
  // When bridging in, the mirror status we care about is the RECIPIENT's, not
  // our own wallet's.
  if (toStarknet() && state.recipient) {
    jobs.push(sn.mirrorStatus(asset, state.recipient).then((m) => { state.mirror = m; }).catch(() => {}));
  }
  await Promise.all(jobs);
  render();
  refreshQuote();
}


async function doConnectEvm(rdns?: string): Promise<void> {
  state.busy = 'Connecting…'; paintCta();
  try {
    state.evmSession = await evm.connectEvm(rdns);
    watchEvm();
    state.token = await evm.tokenInfo(state.asset);
    // Bridging back, the destination is this wallet. Not a choice.
    if (!toStarknet()) state.recipient = state.evmSession.address;
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
    await refreshAll();
  }
}

/// Connect, sign, derive, find the note -- one flow, as in VeilX.
///
/// The signature IS the point of connecting here: it produces the private
/// viewing key, and the key is what says where this holder's notes live. Asking
/// for it as a separate step later would be asking twice for one decision.
async function doConnectStarknet(): Promise<void> {
  state.busy = 'Connecting…'; paintCta();
  const previous = state.snSession?.address;
  try {
    state.snSession = await sn.connectStarknet();
    // A different account means the cached viewing key belongs to someone else.
    // Drop it rather than decrypting one account's notes with another's key.
    if (previous && previous !== state.snSession.address) {
      const chainId = (await sn.snProvider.getChainId()) as unknown as string;
      forgetViewingKey(previous, chainId);
      state.noteCtx = undefined;
      state.noteId = '';
      state.noteSlot = undefined;
      state.noteClaimedBy = undefined;
      state.noteSearched = false;
    }
    // Bridging in, the destination is this wallet. Not a choice: the note is
    // derived from this account's viewing key and nobody else can produce it.
    if (toStarknet()) state.recipient = state.snSession.address;
    state.error = undefined;
  } catch (e: any) {
    state.error = e?.message ?? String(e);
    state.busy = undefined;
    await refreshAll();
    return;
  }
  state.busy = undefined;
  await refreshAll();

  // The note, but only if it costs no signature. Connecting must not sign.
  await findNoteIfFree();
}

/// Derive the viewing key, find this holder's fillable note, and read who has
/// claimed it. One signature; no transaction and nothing stored.
/// Find the note only if that costs NO signature.
///
/// Connecting a wallet must not sign anything. Deriving the viewing key does
/// sign -- it is what produces the key -- so it happens when the holder asks
/// for it, not as a side effect of pressing Connect. Once derived it is cached,
/// so every later connect and every reload finds the note silently.
async function findNoteIfFree(): Promise<void> {
  if (!state.snSession || !toStarknet() || !state.asset.poolReady) return;
  let chainId: string;
  try { chainId = (await sn.snProvider.getChainId()) as unknown as string; }
  catch { return; }
  if (!hasCachedViewingKey(state.snSession.address, chainId)) {
    render();   // leaves the "Find my open note" button for the holder to press
    return;
  }
  await doFindNote();
}

/// Make an empty open note for this asset, through the SDK's proven path.
async function doCreateNote(): Promise<void> {
  if (!state.snSession || !state.noteCtx) return doFindNote();
  state.busy = 'Creating your note…'; paintCta(); render();
  try {
    const result = await createOpenNote(state.asset, state.noteCtx, (line) => {
      state.busy = `Creating your note — ${line}…`; paintCta();
    });
    if (result.ok) {
      state.noteSlot = result.slot;
      state.noteId = result.slot.noteId;
      state.noteSearched = true;
      state.error = undefined;
    } else {
      state.error = result.reason;
    }
  } catch (e: any) {
    state.error = e?.message ?? String(e);
  } finally {
    state.busy = undefined;
    if (state.noteId) await refreshNoteOwner(); else render();
  }
}

async function doFindNote(): Promise<void> {
  if (!state.snSession) return doConnectStarknet();
  state.busy = 'Check your wallet…'; paintCta();
  try {
    if (!state.noteCtx) state.noteCtx = await deriveNoteContext(state.snSession);
    const slot = await findFillableNote(state.asset, state.noteCtx);
    state.noteSlot = slot;
    state.noteId = slot?.noteId ?? '';
    state.noteSearched = true;
    state.error = undefined;
  } catch (e: any) {
    state.error = e?.message ?? String(e);
  } finally {
    state.busy = undefined;
    if (state.noteId) await refreshNoteOwner(); else render();
  }
}

async function refreshNoteOwner(): Promise<void> {
  if (!validNoteId() || !state.asset.poolReady) { state.noteClaimedBy = undefined; render(); return; }
  try {
    state.noteClaimedBy = await sn.noteOwner(state.asset, state.noteId);
  } catch {
    state.noteClaimedBy = undefined;
  }
  render();
}

async function doClaimNote(): Promise<void> {
  if (!state.snSession) return doConnectStarknet();
  state.busy = 'Claiming note…'; paintCta();
  try {
    await sn.registerNote(state.snSession, state.asset, state.noteId);
    state.notice = 'Note claimed. Only a transfer addressed to you can fill it.';
  } catch (e: any) {
    state.error = e?.message ?? String(e);
  } finally {
    state.busy = undefined;
    await refreshNoteOwner();
  }
}

async function doClaimStarknet(): Promise<void> {
  if (!state.snSession) return doConnectStarknet();
  const owner = state.recipient || state.snSession.address;
  state.busy = 'Claiming…'; paintCta();
  try {
    await sn.claimPending(state.snSession, state.asset, owner);
    state.notice = 'Released on ' + starknetLabel + '.';
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
    await refreshAll();
  }
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

async function onCta(): Promise<void> {
  if (toStarknet() && !state.evmSession) return doConnectEvm();
  if (!toStarknet() && !state.snSession) return doConnectStarknet();

  let amount: bigint;
  try {
    amount = parseUnits(state.amount, state.token.decimals);
  } catch (e: any) {
    state.error = e.message; render(); return;
  }

  const asset = state.asset;
  try {
    if (toStarknet()) {
      if (state.evmStatus && state.evmStatus.allowance < amount) {
        state.busy = 'Approving…'; paintCta();
        await evm.approve(state.evmSession!, asset, amount);
        state.notice = 'Approved. Confirm the transfer to bridge.';
        return;
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
      const fee = state.fee ?? (await sn.quoteBridgeBack(asset, amount, state.recipient));
      state.busy = 'Confirm in wallet…'; paintCta();
      const hash = await sn.bridgeBack(
        state.snSession!, asset, amount, state.recipient, fee, STARKNET_FEE_TOKEN
      );
      record({
        direction: 'toEvm', asset: asset.id, symbol: state.token.symbol,
        amount: units(amount, state.token.decimals), recipient: state.recipient,
        hash, status: 'sent',
      });
      state.notice = 'Burned and sent. The lockbox releases on arrival — a few minutes.';
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

// ---------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  render();
  if (state.asset.available) {
    try { state.token = await evm.tokenInfo(state.asset); } catch { /* catalogue stands */ }
    render();
  }

  // Re-attach wallets the user already authorised HERE, without prompting, so a
  // reload keeps the session instead of looking like a disconnect. Neither call
  // throws: nothing to restore is the normal case.
  //
  // Runs even when no asset is deployed: whether a wallet is connected has
  // nothing to do with whether this route carries an asset, and returning early
  // was leaving the header showing "Connect" for an already-connected wallet.
  const [snSession, evmSession] = await Promise.all([
    sn.restoreStarknet(),
    evm.restoreEvm(),
  ]);
  if (snSession) {
    state.snSession = snSession;
    if (toStarknet()) state.recipient = snSession.address;
  }
  if (evmSession) {
    state.evmSession = evmSession;
    if (!toStarknet()) state.recipient = evmSession.address;
    watchEvm();
  }
  if (!snSession && !evmSession) return;

  await refreshAll();
  await findNoteIfFree();
}

async function doDisconnect(which: 'sn' | 'evm'): Promise<void> {
  if (which === 'sn') {
    const previous = state.snSession?.address;
    await sn.disconnectStarknet();
    // The viewing key decrypts every note this account owns, so it must not
    // outlive the session -- especially on a shared machine.
    if (previous) {
      const chainId = (await sn.snProvider.getChainId()) as unknown as string;
      forgetViewingKey(previous, chainId);
    }
    state.snSession = undefined;
    state.noteCtx = undefined;
    state.noteId = '';
    state.noteSlot = undefined;
    state.noteClaimedBy = undefined;
    state.noteSearched = false;
    state.mirror = undefined;
    if (toStarknet()) state.recipient = '';
  } else {
    unwatchEvm?.();
    unwatchEvm = undefined;
    evm.disconnectEvm();
    state.evmSession = undefined;
    state.evmStatus = undefined;
    state.claimableEvm = 0n;
    if (!toStarknet()) state.recipient = '';
  }
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
      const next = await evm.restoreEvm();
      state.evmSession = next;
      if (!toStarknet()) state.recipient = next?.address ?? '';
      if (!next) state.notice = 'Wallet disconnected.';
      await refreshAll();
    })();
  });
}

void boot();
