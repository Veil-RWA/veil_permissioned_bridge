// Veil Bridge UI.
//
// Layout follows Across: sticky Transfer/History nav, one centred card, a
// vertical From -> To stack, quote details inline above the action button.
//
// Two things a bearer bridge does not need and this does:
//
//   The ELIGIBILITY panel. On an ERC-3643 asset a transfer can be perfectly
//   funded and still refused, so the gates are shown in the order they fail
//   BEFORE gas is spent rather than surfacing as a revert. "Blocked" and "will
//   arrive held" are different outcomes and are shown differently.
//
//   The ASSET picker. There is one lockbox and one twin per asset -- they are
//   never pooled -- so choosing an asset switches the entire contract set, not
//   just a ticker. Assets the current deployment does not carry stay visible
//   and greyed, because hiding them leaves the question unanswered.

import {
  isDeployed, evmLabel, starknetLabel, EXPLORER_EVM, EXPLORER_SN, LZ_SCAN,
} from './config';
import { assets, defaultAsset, type Asset } from './assets';
import { short, units, parseUnits, duration, ago } from './format';
import * as evm from './evm';
import * as sn from './starknet';
import { load as loadHistory, record, update, type Transfer } from './history';

type View = 'transfer' | 'history';

type State = {
  view: View;
  asset: Asset;
  pickerOpen: boolean;
  delivery: evm.Delivery;
  noteId: string;
  evmSession?: evm.EvmSession;
  snSession?: sn.SnSession;
  token: { symbol: string; decimals: number };
  amount: string;
  recipient: string;
  evmStatus?: evm.EvmStatus;
  mirror?: sn.MirrorStatus;
  fee?: bigint;
  busy?: string;
  error?: string;
  notice?: string;
};

const initial = defaultAsset();
const state: State = {
  view: 'transfer',
  asset: initial,
  pickerOpen: false,
  delivery: 'wallet',
  noteId: '',
  token: { symbol: initial.symbol, decimals: initial.decimals },
  amount: '',
  recipient: '',
};

const app = document.getElementById('app')!;
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const tint = (a: Asset): string => `linear-gradient(150deg, ${a.tint[0]}, ${a.tint[1]})`;

/// A note id must be a non-zero felt. Refusing an empty one here saves a
/// message that would silently degrade to the wallet on the far side.
function validNoteId(): boolean {
  const raw = state.noteId.trim();
  if (!raw) return false;
  try { return BigInt(raw) !== 0n; } catch { return false; }
}

// --------------------------------------------------------------- eligibility

type Gate = { ok: boolean | null; label: string; detail?: string };

function gates(): Gate[] {
  const s = state.evmStatus;
  const m = state.mirror;
  const out: Gate[] = [];

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
  return out;
}

function eligibilityCard(): string {
  if (!state.asset.available) {
    return `<div class="eligibility">
      <div class="eligibility-head">Eligibility</div>
      <p>${esc(state.asset.name)} is not deployed on this route yet.</p>
    </div>`;
  }
  if (!state.evmSession) {
    return `<div class="eligibility">
      <div class="eligibility-head">Eligibility</div>
      <p>Connect a wallet to check whether this transfer is permitted.</p>
    </div>`;
  }

  const list = gates();
  const failing = list.filter((g) => g.ok === false);
  // A recipient the mirror has never seen is a warning, not a failure: the
  // transfer still succeeds, it just lands quarantined.
  const onlyRecipient = failing.length > 0 && failing.every((g) => g.label.startsWith('Recipient'));
  const tone = failing.length === 0 ? 'is-good' : onlyRecipient ? 'is-warn' : 'is-bad';
  const head = failing.length === 0 ? 'Cleared to bridge' : onlyRecipient ? 'Will arrive held' : 'Blocked';

  const items = list.map((g) => {
    const mark = g.ok === null ? '<span class="mark idk">·</span>'
      : g.ok ? '<span class="mark ok">✓</span>' : '<span class="mark no">✕</span>';
    return `<li>${mark}<span>${esc(g.label)}${g.detail ? `<br><span style="color:var(--faint)">${esc(g.detail)}</span>` : ''}</span></li>`;
  }).join('');

  const stale = state.mirror && state.mirror.stalenessWindow > 0
    ? `<p style="margin-top:9px">Mirrored eligibility expires after ${duration(state.mirror.stalenessWindow)}. Anyone can refresh it.</p>`
    : '';

  return `<div class="eligibility ${tone}">
    <div class="eligibility-head">${head}</div>
    <ul class="checks">${items}</ul>
    ${stale}
  </div>`;
}

// ------------------------------------------------------------- asset picker

function assetPill(): string {
  const a = state.asset;
  return `<button id="asset-pill" class="token-pill" aria-haspopup="listbox" aria-expanded="${state.pickerOpen}">
    <span class="token-mark" style="background:${tint(a)}"></span>${esc(state.token.symbol)}
    <span class="pill-caret">▾</span>
  </button>`;
}

function assetPicker(): string {
  if (!state.pickerOpen) return '';
  const rows = assets.map((a) => {
    const selected = a.id === state.asset.id;
    return `<button class="asset-row${selected ? ' is-selected' : ''}${a.available ? '' : ' is-off'}"
        data-asset="${esc(a.id)}" ${a.available ? '' : 'disabled'} role="option" aria-selected="${selected}">
      <span class="token-mark" style="background:${tint(a)}"></span>
      <span class="asset-text">
        <span class="asset-symbol">${esc(a.symbol)}</span>
        <span class="asset-name">${esc(a.name)}</span>
      </span>
      <span class="asset-tag">${a.available ? esc(a.category) : 'not deployed'}</span>
    </button>`;
  }).join('');
  return `<div class="picker" role="listbox" aria-label="Select an asset">
    <div class="picker-head">Asset</div>
    ${rows}
    <div class="picker-foot">Each asset has its own lockbox and twin. They are never pooled.</div>
  </div>`;
}

// ------------------------------------------------------------------ transfer

function ctaLabel(): { text: string; disabled: boolean; note: string } {
  if (!isDeployed) return { text: 'Not deployed', disabled: true, note: 'No deployment found for this network pair.' };
  if (!state.asset.available) {
    return { text: `${state.asset.symbol} not available`, disabled: true, note: 'Pick an asset this deployment carries.' };
  }
  if (state.busy) return { text: state.busy, disabled: true, note: '' };
  if (!state.evmSession) return { text: 'Connect EVM wallet', disabled: false, note: '' };
  if (!state.recipient) return { text: 'Enter a recipient', disabled: true, note: `Paste a ${starknetLabel} address, or connect a wallet to fill it.` };

  let amount = 0n;
  try { amount = parseUnits(state.amount || '0', state.token.decimals); } catch { /* below */ }
  if (amount <= 0n) return { text: 'Enter an amount', disabled: true, note: '' };

  const s = state.evmStatus;
  if (s && amount > s.balance) return { text: 'Insufficient balance', disabled: true, note: '' };
  if (s && !s.verified) return { text: 'Not eligible to bridge', disabled: true, note: 'Your address is not verified on the source registry.' };
  if (s && !s.lockboxRegistered) return { text: 'Bridge not approved by issuer', disabled: true, note: 'The lockbox must be a registered identity before any escrow can succeed.' };
  if (s && s.allowance < amount) return { text: `Approve ${state.token.symbol}`, disabled: false, note: 'One approval, then the transfer.' };
  if (state.delivery === 'pool' && !validNoteId()) {
    return { text: 'Enter an open note id', disabled: true, note: 'A pool delivery needs a note to fill.' };
  }

  const fee = state.fee !== undefined ? `${units(state.fee, 18, 5)} ETH` : '…';
  return { text: 'Bridge', disabled: false, note: `Message fee ${fee}, paid to LayerZero.` };
}

function transferView(): string {
  const s = state.evmStatus;
  const cta = ctaLabel();
  const balance = s ? `${units(s.balance, state.token.decimals)} ${state.token.symbol}` : '—';
  const twin = state.mirror ? `${units(state.mirror.balance, state.token.decimals)} ${state.token.symbol}` : '—';

  const banner = !isDeployed
    ? `<div class="banner is-bad">No deployment loaded. Run the scripts in <span class="mono">scripts/</span>, then <span class="mono">npm run dev</span> again.</div>`
    : state.error
      ? `<div class="banner is-bad">${esc(state.error)}</div>`
      : state.notice
        ? `<div class="banner">${esc(state.notice)}</div>`
        : '';

  return `
  ${banner}
  <div class="card">
    <div class="leg">
      <div class="leg-head"><span>From</span><span class="leg-balance">${esc(balance)}</span></div>
      <div class="chain"><span class="chain-mark eth">E</span>${esc(evmLabel)}</div>
      <div class="amount-row">
        <input id="amount" class="amount" inputmode="decimal" placeholder="0.0" value="${esc(state.amount)}" />
        <button id="max" class="max">MAX</button>
        ${assetPill()}
      </div>
      ${assetPicker()}
    </div>

    <div class="swap-divider"><span>↓</span></div>

    <div class="leg">
      <div class="leg-head"><span>To</span><span class="leg-balance">${esc(twin)}</span></div>
      <div class="chain"><span class="chain-mark sn">S</span>${esc(starknetLabel)}</div>
      <input id="recipient" class="recipient" placeholder="0x… recipient on ${esc(starknetLabel)}" value="${esc(state.recipient)}" />
      ${state.snSession ? '' : `<button id="connect-sn" class="max" style="margin-top:8px">Connect Starknet wallet to fill</button>`}

      <div class="delivery">
        <div class="seg" role="radiogroup" aria-label="Where it lands">
          <button class="seg-btn${state.delivery === 'wallet' ? ' is-on' : ''}" data-delivery="wallet" role="radio" aria-checked="${state.delivery === 'wallet'}">Wallet</button>
          <button class="seg-btn${state.delivery === 'pool' ? ' is-on' : ''}" data-delivery="pool" role="radio" aria-checked="${state.delivery === 'pool'}">Veil pool</button>
        </div>
        ${state.delivery === 'pool'
          ? `<input id="note" class="recipient" placeholder="0x… open note id" value="${esc(state.noteId)}" />
             <p class="delivery-note">Filled into your open note, so the position arrives confidential. If the note cannot be filled it lands in the wallet above — never lost.</p>`
          : `<p class="delivery-note">Arrives as a public balance on ${esc(starknetLabel)}.</p>`}
      </div>
    </div>

    ${eligibilityCard()}

    <dl class="details">
      <div class="detail"><dt>Asset</dt><dd>${esc(state.asset.name)}</dd></div>
      <div class="detail"><dt>Lands as</dt><dd>${state.delivery === 'pool' ? 'Pool note' : 'Wallet balance'}</dd></div>
      <div class="detail"><dt>Route</dt><dd>${esc(evmLabel)} → ${esc(starknetLabel)}</dd></div>
      <div class="detail"><dt>Message fee</dt><dd>${state.fee !== undefined ? units(state.fee, 18, 6) + ' ETH' : '—'}</dd></div>
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
      <p style="margin:0">Bridged transfers from this browser will appear here.</p>
    </div></div>`;
  }
  const rows = items.map((t: Transfer) => {
    const dir = t.direction === 'toStarknet'
      ? `${esc(evmLabel)} → ${esc(starknetLabel)}`
      : `${esc(starknetLabel)} → ${esc(evmLabel)}`;
    const explorer = t.direction === 'toStarknet' ? EXPLORER_EVM : EXPLORER_SN;
    return `<div class="row">
      <div class="row-main">${esc(t.amount)} ${esc(t.symbol ?? '')}<span style="color:var(--faint);font-weight:500">${dir}</span></div>
      <span class="status ${t.status}">${t.status}</span>
      <div class="row-sub">
        ${esc(ago(t.at))} · to ${esc(short(t.recipient, 8, 6))} ·
        <a href="${explorer}/tx/${esc(t.hash)}" target="_blank" rel="noreferrer">tx</a>
        ${t.guid ? ` · <a href="${LZ_SCAN}/tx/${esc(t.hash)}" target="_blank" rel="noreferrer">LayerZero</a>` : ''}
      </div>
    </div>`;
  }).join('');
  return `<div class="history">${rows}</div>`;
}

// -------------------------------------------------------------------- render

function render(): void {
  app.innerHTML = state.view === 'transfer' ? transferView() : historyView();

  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.view === state.view);
    tab.onclick = () => { state.view = tab.dataset.view as View; state.pickerOpen = false; render(); };
  });

  const foot = document.getElementById('foot-route');
  if (foot) foot.textContent = isDeployed ? `${evmLabel} → ${starknetLabel}` : 'not deployed';

  if (state.view !== 'transfer') return;

  const amount = document.getElementById('amount') as HTMLInputElement | null;
  if (amount) amount.oninput = () => { state.amount = amount.value; state.error = undefined; refreshQuote(); paintCta(); };

  const recipient = document.getElementById('recipient') as HTMLInputElement | null;
  if (recipient) recipient.onchange = () => { state.recipient = recipient.value.trim(); void refreshMirror(); };

  const max = document.getElementById('max');
  if (max) max.onclick = () => {
    if (!state.evmStatus) return;
    state.amount = units(state.evmStatus.balance, state.token.decimals, state.token.decimals);
    render(); refreshQuote();
  };

  const pill = document.getElementById('asset-pill');
  if (pill) pill.onclick = (e) => { e.stopPropagation(); state.pickerOpen = !state.pickerOpen; render(); };

  document.querySelectorAll<HTMLButtonElement>('.asset-row').forEach((row) => {
    row.onclick = () => void selectAsset(row.dataset.asset!);
  });

  document.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) => {
    b.onclick = () => {
      state.delivery = b.dataset.delivery as evm.Delivery;
      if (state.delivery === 'wallet') state.noteId = '';
      render();
    };
  });
  const note = document.getElementById('note') as HTMLInputElement | null;
  if (note) note.oninput = () => { state.noteId = note.value.trim(); paintCta(); };

  const connectSn = document.getElementById('connect-sn');
  if (connectSn) connectSn.onclick = () => void doConnectStarknet();

  const cta = document.getElementById('cta');
  if (cta) cta.onclick = () => void onCta();
}

/// Update just the button, so typing does not blow away input focus.
function paintCta(): void {
  const button = document.getElementById('cta') as HTMLButtonElement | null;
  if (!button) return;
  const cta = ctaLabel();
  button.textContent = cta.text;
  button.disabled = cta.disabled;
  const note = document.querySelector('.cta-note');
  if (note) note.textContent = cta.note;
}

// Clicking away closes the picker.
document.addEventListener('click', () => {
  if (state.pickerOpen) { state.pickerOpen = false; render(); }
});

// ------------------------------------------------------------------- actions

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
  state.error = undefined;
  state.notice = undefined;
  render();

  try {
    state.token = await evm.tokenInfo(next);
    if (state.evmSession) state.evmStatus = await evm.evmStatus(next, state.evmSession.address);
    if (state.recipient) state.mirror = await sn.mirrorStatus(next, state.recipient);
  } catch (e: any) {
    state.error = e?.message ?? String(e);
  }
  render();
  refreshQuote();
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
      state.fee = await evm.quote(state.asset, amount, state.recipient);
    } catch {
      // Usually an unwired peer; the eligibility panel explains that better
      // than a thrown banner would.
      state.fee = undefined;
    }
    paintCta();
    const cells = document.querySelectorAll('.detail dd');
    if (cells[2]) cells[2].textContent = state.fee !== undefined ? `${units(state.fee, 18, 6)} ETH` : '—';
  }, 350);
}

async function refreshMirror(): Promise<void> {
  if (!state.asset.available || !state.recipient) { state.mirror = undefined; render(); return; }
  try {
    state.mirror = await sn.mirrorStatus(state.asset, state.recipient);
  } catch {
    state.mirror = undefined;
  }
  render();
  refreshQuote();
}

async function doConnectEvm(): Promise<void> {
  state.busy = 'Connecting…'; paintCta();
  try {
    state.evmSession = await evm.connectEvm();
    state.token = await evm.tokenInfo(state.asset);
    state.evmStatus = await evm.evmStatus(state.asset, state.evmSession.address);
    state.error = undefined;
  } catch (e: any) {
    state.error = e?.message ?? String(e);
  } finally {
    state.busy = undefined;
    render();
  }
}

async function doConnectStarknet(): Promise<void> {
  try {
    state.snSession = await sn.connectStarknet();
    if (!state.recipient) state.recipient = state.snSession.address;
    await refreshMirror();
  } catch (e: any) {
    state.error = e?.message ?? String(e);
    render();
  }
}

async function onCta(): Promise<void> {
  if (!state.evmSession) return doConnectEvm();

  let amount: bigint;
  try {
    amount = parseUnits(state.amount, state.token.decimals);
  } catch (e: any) {
    state.error = e.message; render(); return;
  }

  const asset = state.asset;
  try {
    if (state.evmStatus && state.evmStatus.allowance < amount) {
      state.busy = 'Approving…'; paintCta();
      await evm.approve(state.evmSession, asset, amount);
      state.evmStatus = await evm.evmStatus(asset, state.evmSession.address);
      state.notice = 'Approved. Confirm the transfer to bridge.';
      return;
    }

    const fee = state.fee ?? (await evm.quote(asset, amount, state.recipient));
    state.busy = 'Confirm in wallet…'; paintCta();
    const { hash, guid } = await evm.bridgeOut(
      state.evmSession, asset, amount, state.recipient, fee, state.delivery, state.noteId
    );

    record({
      direction: 'toStarknet',
      asset: asset.id,
      symbol: state.token.symbol,
      amount: units(amount, state.token.decimals),
      recipient: state.recipient,
      hash, guid, status: 'sent',
    });
    state.notice = state.delivery === 'pool'
      ? 'Sent. It will be filled into your note on arrival — a few minutes.'
      : 'Sent. Delivery takes a few minutes — track it under History.';
    state.amount = '';
    state.evmStatus = await evm.evmStatus(asset, state.evmSession.address);
    void watchDelivery(asset, hash, state.recipient);
  } catch (e: any) {
    state.error = e?.shortMessage ?? e?.message ?? String(e);
  } finally {
    state.busy = undefined;
    render();
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
      const [supply, mirror] = await Promise.all([
        sn.twinSupply(asset), sn.mirrorStatus(asset, recipient),
      ]);
      if (supply > before) {
        if (id) update(id, 'minted');
        state.notice = `Delivered and minted on ${starknetLabel}.`;
        if (state.asset.id === asset.id) state.mirror = mirror;
        render(); return;
      }
      if (mirror.pending > 0n) {
        if (id) update(id, 'quarantined');
        state.notice = 'Delivered, but held: the recipient is not eligible yet. It stays claimable.';
        if (state.asset.id === asset.id) state.mirror = mirror;
        render(); return;
      }
    } catch { /* transient RPC, keep polling */ }
  }
}

// ---------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  render();
  if (!state.asset.available) return;
  try {
    state.token = await evm.tokenInfo(state.asset);
  } catch { /* catalogue values stand */ }
  render();
}

void boot();
