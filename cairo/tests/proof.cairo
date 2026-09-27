// SNIP-36 proof facts and signed derives, for driving the REAL Veil pool's
// proven paths from the cash leg tests. A trimmed copy of the root package's
// tests/proof.cairo (same helpers, same hashes): the derive runs for real,
// `spy_messages_to_l1` captures its message, and `prove` installs proof facts
// committing to exactly that message before the settle.

use core::ec::{EcPointTrait, EcStateTrait, stark_curve};
use core::integer::u128_byte_reverse;
use core::keccak::compute_keccak_byte_array;
use core::poseidon::poseidon_hash_span;
use snforge_std::signature::KeyPairTrait;
use snforge_std::signature::secp256k1_curve::{Secp256k1CurveKeyPairImpl, Secp256k1CurveSignerImpl};
use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use starknet::eth_signature::public_key_point_to_eth_address;
use starknet::secp256_trait::{Secp256PointTrait, Secp256Trait, Signature, recover_public_key};
use starknet::secp256k1::Secp256k1Point;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, MessageToL1, MessageToL1Spy, MessageToL1SpyTrait,
    declare, get_class_hash, spy_messages_to_l1, start_cheat_block_number_global,
    start_cheat_proof_facts_global, start_cheat_resource_bounds_global, start_cheat_tip_global,
};
use starknet::{ContractAddress, EthAddress, ResourcesBounds, SyscallResultTrait};
use veil::interfaces::IVeilERC3643::{
    DepositNote, IVeilERC3643Dispatcher, IVeilERC3643DispatcherTrait, InvokeSwap, MakerOpening,
    OpenNoteOpening,
};

pub const BASE_BLOCK: u64 = 1000;

/// The transaction the virtual OS runs a derive in: no tip, zero-priced.
pub fn virtual_tx() {
    start_cheat_tip_global(0);
    start_cheat_resource_bounds_global(
        array![
            ResourcesBounds { resource: 'L1_GAS', max_amount: 0, max_price_per_unit: 0 },
            ResourcesBounds { resource: 'L2_GAS', max_amount: 0, max_price_per_unit: 0 },
            ResourcesBounds { resource: 'L1_DATA', max_amount: 0, max_price_per_unit: 0 },
        ]
            .span(),
    );
}

pub fn message_hash(from: ContractAddress, payload: Span<felt252>) -> felt252 {
    let mut data: Array<felt252> = array![from.into(), 0, payload.len().into()];
    for x in payload {
        data.append(*x);
    }
    poseidon_hash_span(data.span())
}

pub fn prove(pool: ContractAddress, payload: Span<felt252>) {
    start_cheat_block_number_global(BASE_BLOCK + 1);
    start_cheat_proof_facts_global(
        array![
            'PROOF0', 'VIRTUAL_SNOS', 0x1234, 'VIRTUAL_SNOS0', BASE_BLOCK.into(), 0x5678, 0x9abc, 1,
            message_hash(pool, payload),
        ]
            .span(),
    );
}

pub fn prove_last(ref spy: MessageToL1Spy) -> Span<felt252> {
    let msgs = spy.get_messages().messages;
    assert(msgs.len() > 0, 'no message to prove');
    let (from, m): @(ContractAddress, MessageToL1) = msgs.at(msgs.len() - 1);
    let payload = m.payload.span();
    prove(*from, payload);
    payload
}

pub fn decode<T, +Serde<T>, +Drop<T>>(ref payload: Span<felt252>) -> T {
    Serde::<T>::deserialize(ref payload).expect('payload does not decode')
}

pub fn maker_commitment(maker: ContractAddress, salt: felt252) -> felt252 {
    poseidon_hash_span(array!['VEIL_MAKER', maker.into(), salt].span())
}

pub fn neutral_rules_hash() -> felt252 {
    poseidon_hash_span(array!['VEIL_RULES', 0, 0, 0, 0, 0, 0, 0].span())
}

const STARK_CURVE_ORDER: u256 =
    0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2f;

pub fn secret_of(who: ContractAddress) -> felt252 {
    let a: felt252 = who.into();
    let a: u256 = a.into();
    (a % (STARK_CURVE_ORDER - 1) + 1).try_into().unwrap()
}

pub fn public_key_of(who: ContractAddress) -> felt252 {
    KeyPairTrait::<felt252, felt252>::from_secret_key(secret_of(who)).public_key
}

/// OpenZeppelin's account at `who`, keyed with `secret_of(who)`.
pub fn ensure_account(who: ContractAddress) {
    let deployed: felt252 = get_class_hash(who).into();
    if deployed != 0 {
        return;
    }
    let class = declare("AccountUpgradeable").unwrap().contract_class();
    class.deploy_at(@array![public_key_of(who)], who).unwrap();
}

// ── The EVM wallet holder ────────────────────────────────────────────────────
// A holder with no Starknet account: its 20-byte address, signing with its
// secp256k1 key (`personal_sign`). `sign` signs for it that way, so every
// helper below drives it unchanged.

pub const EVM_HOLDER_SECRET: u256 = 0xe5a1;

/// The Ethereum address of the secp256k1 key `secret`.
pub fn evm_address_of(secret: u256) -> ContractAddress {
    let key = KeyPairTrait::<u256, Secp256k1Point>::from_secret_key(secret).public_key;
    let address: EthAddress = public_key_point_to_eth_address(key);
    let address: felt252 = address.into();
    address.try_into().unwrap()
}

pub fn evm_holder() -> ContractAddress {
    evm_address_of(EVM_HOLDER_SECRET)
}

/// `personal_sign` of `hash` by `secret`, as [r.low, r.high, s.low, s.high,
/// y_parity], low-s as wallets emit it.
pub fn evm_personal_sign(secret: u256, hash: felt252) -> Array<felt252> {
    let mut msg: ByteArray = "";
    msg.append_byte(0x19);
    msg.append(@"Ethereum Signed Message:");
    msg.append_byte(0x0a);
    msg.append(@"32");
    let h: u256 = hash.into();
    msg.append_word(h.high.into(), 16);
    msg.append_word(h.low.into(), 16);
    let le = compute_keccak_byte_array(@msg);
    let digest = u256 { low: u128_byte_reverse(le.high), high: u128_byte_reverse(le.low) };
    let key = KeyPairTrait::<u256, Secp256k1Point>::from_secret_key(secret);
    let (r, s) = key.sign(digest).unwrap();
    let n = Secp256Trait::<Secp256k1Point>::get_curve_size();
    let s = if s > n / 2 {
        n - s
    } else {
        s
    };
    let (x, y) = key.public_key.get_coordinates().unwrap_syscall();
    let even = recover_public_key::<Secp256k1Point>(digest, Signature { r, s, y_parity: false })
        .unwrap();
    let (ex, ey) = even.get_coordinates().unwrap_syscall();
    let parity = if ex == x && ey == y {
        0
    } else {
        1
    };
    array![r.low.into(), r.high.into(), s.low.into(), s.high.into(), parity]
}

/// `who`'s signature over `hash`: the EVM holder's `personal_sign`, or a
/// Starknet account's STARK signature.
pub fn sign(who: ContractAddress, hash: felt252) -> Array<felt252> {
    if who == evm_holder() {
        return evm_personal_sign(EVM_HOLDER_SECRET, hash);
    }
    ensure_account(who);
    let (r, s) = KeyPairTrait::<felt252, felt252>::from_secret_key(secret_of(who))
        .sign(hash)
        .unwrap();
    array![r, s]
}

fn authorization_hash(
    pool: ContractAddress,
    signer: ContractAddress,
    action: felt252,
    arguments: Span<felt252>,
    nonce: felt252,
) -> felt252 {
    let domain_type = selector!(
        "\"StarknetDomain\"(\"name\":\"shortstring\",\"version\":\"shortstring\",\"chainId\":\"shortstring\",\"revision\":\"shortstring\")",
    );
    let auth_type = selector!(
        "\"Authorization\"(\"Pool\":\"ContractAddress\",\"Action\":\"selector\",\"Arguments\":\"felt*\",\"Nonce\":\"felt\")",
    );
    let chain_id = starknet::get_tx_info().unbox().chain_id;
    let domain = poseidon_hash_span(array![domain_type, 'Veil', 1, chain_id, 1].span());
    let message = poseidon_hash_span(
        array![auth_type, pool.into(), action, poseidon_hash_span(arguments), nonce].span(),
    );
    poseidon_hash_span(array!['StarkNet Message', domain, signer.into(), message].span())
}

/// (nonce, signature) for `signer` authorizing the pool derive `action` with
/// its other arguments `args` (Serde).
pub fn authorize(
    pool: IVeilERC3643Dispatcher, signer: ContractAddress, action: felt252, args: Span<felt252>,
) -> (felt252, Array<felt252>) {
    let nonce = poseidon_hash_span(array!['TEST_NONCE', action, poseidon_hash_span(args)].span());
    let hash = authorization_hash(pool.contract_address, signer, action, args, nonce);
    (nonce, sign(signer, hash))
}

/// The pool's exchange proves a venue fill of `receipt_ids`.
pub fn venue_fill_derive(
    pool: IVeilERC3643Dispatcher,
    exchange: ContractAddress,
    receipt_ids: Array<felt252>,
    makers: Array<MakerOpening>,
) {
    let mut args: Array<felt252> = array![];
    receipt_ids.serialize(ref args);
    makers.serialize(ref args);
    let (nonce, signature) = authorize(pool, exchange, selector!("venue_fill_derive"), args.span());
    pool.venue_fill_derive(receipt_ids, makers, nonce, signature);
}

/// Registers `user` with private viewing key `scalar`: the signed derive, then
/// the settle of what it proved (this also opens the user's self-channel).
pub fn register(pool: IVeilERC3643Dispatcher, user: ContractAddress, scalar: felt252) {
    let mut spy = spy_messages_to_l1();
    let key: u256 = scalar.into();
    let mut args: Array<felt252> = array![];
    user.serialize(ref args);
    key.serialize(ref args);
    0xA0D17.serialize(ref args);
    0x5E1F.serialize(ref args);
    0x0C7.serialize(ref args);
    let (nonce, signature) = authorize(
        pool, user, selector!("register_viewing_key_derive"), args.span(),
    );
    pool.register_viewing_key_derive(user, key, 0xA0D17, 0x5E1F, 0x0C7, nonce, signature);
    let p = prove_last(ref spy);
    pool
        .register_viewing_key_settle(
            (*p.at(0)).try_into().unwrap(), *p.at(1), *p.at(2), *p.at(3), *p.at(4), *p.at(5),
            *p.at(6), *p.at(7), *p.at(8), *p.at(9), *p.at(10), *p.at(11),
        );
}

/// `owner` deposits `amount` of `token` (already approved to the pool) into a
/// private note; returns its id. `note_salt` (>= 2) also keeps two otherwise
/// identical deposits' authorizations apart.
pub fn deposit(
    pool: IVeilERC3643Dispatcher,
    owner: ContractAddress,
    scalar: felt252,
    token: ContractAddress,
    amount: u128,
    note_salt: u128,
) -> felt252 {
    let mut spy = spy_messages_to_l1();
    let key: u256 = scalar.into();
    let mut args: Array<felt252> = array![];
    owner.serialize(ref args);
    key.serialize(ref args);
    token.serialize(ref args);
    amount.serialize(ref args);
    note_salt.serialize(ref args);
    0x5D.serialize(ref args);
    let (nonce, signature) = authorize(pool, owner, selector!("deposit_derive"), args.span());
    pool.deposit_derive(owner, key, token, amount, note_salt, 0x5D, nonce, signature);
    let mut payload = prove_last(ref spy);
    let msg: DepositNote = decode(ref payload);
    let note_id = msg.note_id;
    pool.deposit_settle(msg);
    note_id
}

/// `owner` reserves an empty open note for `token`; returns its id.
pub fn create_open_note(
    pool: IVeilERC3643Dispatcher, owner: ContractAddress, scalar: felt252, token: ContractAddress,
) -> felt252 {
    let mut spy = spy_messages_to_l1();
    let key: u256 = scalar.into();
    let mut args: Array<felt252> = array![];
    owner.serialize(ref args);
    key.serialize(ref args);
    token.serialize(ref args);
    0xE9.serialize(ref args);
    0x5B.serialize(ref args);
    let (nonce, signature) = authorize(pool, owner, selector!("create_open_note_derive"), args.span());
    pool.create_open_note_derive(owner, key, token, 0xE9, 0x5B, nonce, signature);
    let mut payload = prove_last(ref spy);
    let msg: OpenNoteOpening = decode(ref payload);
    let note_id = msg.note_id;
    pool.create_open_note_settle(msg);
    note_id
}

/// `caller` proves an invoke of `target` and settles it with `calldata`.
pub fn invoke(
    pool: IVeilERC3643Dispatcher,
    caller: ContractAddress,
    scalar: felt252,
    in_token: ContractAddress,
    in_amount: u128,
    out_token: ContractAddress,
    target: ContractAddress,
    calldata: Array<felt252>,
) -> InvokeSwap {
    let mut spy = spy_messages_to_l1();
    let key: u256 = scalar.into();
    let calldata_hash = poseidon_hash_span(calldata.span());
    let mut args: Array<felt252> = array![];
    caller.serialize(ref args);
    key.serialize(ref args);
    in_token.serialize(ref args);
    in_amount.serialize(ref args);
    out_token.serialize(ref args);
    target.serialize(ref args);
    calldata_hash.serialize(ref args);
    0xAE.serialize(ref args);
    7_u128.serialize(ref args);
    0x5C.serialize(ref args);
    let (nonce, signature) = authorize(pool, caller, selector!("invoke_derive"), args.span());
    pool
        .invoke_derive(
            caller, key, in_token, in_amount, out_token, target, calldata_hash, 0xAE, 7, 0x5C, nonce,
            signature,
        );
    let mut payload = prove_last(ref spy);
    let msg: InvokeSwap = decode(ref payload);
    let nullifiers: Array<felt252> = decode(ref payload);
    pool.invoke_settle(msg, nullifiers, calldata);
    msg
}

pub fn curve_x(scalar: felt252) -> felt252 {
    let generator = EcPointTrait::new_nz(stark_curve::GEN_X, stark_curve::GEN_Y).unwrap();
    let mut state = EcStateTrait::init();
    state.add_mul(scalar, generator);
    state.finalize_nz().unwrap().x()
}

/// A user's self-channel key (sender == recipient == owner).
pub fn self_channel_key(owner: ContractAddress, scalar: felt252) -> felt252 {
    poseidon_hash_span(array![2, owner.into(), scalar, owner.into(), curve_x(scalar)].span())
}

pub fn note_id(channel_key: felt252, token: ContractAddress, index: u32) -> felt252 {
    poseidon_hash_span(array!['VEIL_NOTE_ID', channel_key, token.into(), index.into()].span())
}
