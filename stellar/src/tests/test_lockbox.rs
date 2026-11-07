//! VeilStellarLockbox against LayerZero's real Soroban EndpointV2 and
//! SimpleMessageLib (from the pinned monorepo), a real Stellar Asset Contract,
//! and real `G…` accounts with trustlines. The Starknet gateway is the remote
//! peer: its packets are built here and verified through the message lib.

extern crate std;

use crate::{
    codec,
    errors::LockboxError,
    lockbox::{VeilStellarLockbox, VeilStellarLockboxClient},
};
use endpoint_v2::{EndpointV2, EndpointV2Client, MessagingFee, Origin, OutboundPacket};
use message_lib_common::packet_codec_v1;
use simple_message_lib::{SimpleMessageLib, SimpleMessageLibClient};
use soroban_sdk::{
    address_payload::AddressPayload,
    testutils::{Address as _, Events, IssuerFlags},
    token::{StellarAssetClient, TokenClient},
    xdr, Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, Val,
};
use std::rc::Rc;
use utils::{buffer_reader::BufferReader, testing_utils::decode_event_topics_data};

const STELLAR_EID: u32 = 40600;
const STARKNET_EID: u32 = 40500;
const GAS: u128 = 200_000;

struct T<'a> {
    env: Env,
    endpoint: EndpointV2Client<'a>,
    sml: SimpleMessageLibClient<'a>,
    lockbox: VeilStellarLockboxClient<'a>,
    sac: StellarAssetClient<'a>,
    token: TokenClient<'a>,
    asset: xdr::Asset,
    native_asset: xdr::Asset,
    native: Address,
    gateway: BytesN<32>,
    nonce: u64,
}

fn key(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

fn g_address(env: &Env, k: &BytesN<32>) -> Address {
    Address::from_payload(env, AddressPayload::AccountIdPublicKeyEd25519(k.clone()))
}

fn account_id(k: &BytesN<32>) -> xdr::AccountId {
    xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(k.to_array())))
}

fn entry(data: xdr::LedgerEntryData) -> Rc<xdr::LedgerEntry> {
    Rc::new(xdr::LedgerEntry { last_modified_ledger_seq: 0, data, ext: xdr::LedgerEntryExt::V0 })
}

/// A `G…` account with an authorized trustline to the asset.
fn open_account(t: &T, k: &BytesN<32>) -> Address {
    let id = account_id(k);
    let host = t.env.host();
    host.add_ledger_entry(
        &Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount { account_id: id.clone() })),
        &entry(xdr::LedgerEntryData::Account(xdr::AccountEntry {
            account_id: id.clone(),
            balance: 100_000_000,
            seq_num: xdr::SequenceNumber(0),
            num_sub_entries: 2,
            inflation_dest: None,
            flags: 0,
            home_domain: Default::default(),
            thresholds: xdr::Thresholds([1, 0, 0, 0]),
            signers: Default::default(),
            ext: xdr::AccountEntryExt::V0,
        })),
        None,
    )
    .unwrap();
    for a in [&t.asset, &t.native_asset] {
        trustline(t, &id, a);
    }
    g_address(&t.env, k)
}

fn trustline(t: &T, id: &xdr::AccountId, a: &xdr::Asset) {
    let asset = match a {
        xdr::Asset::CreditAlphanum4(a) => xdr::TrustLineAsset::CreditAlphanum4(a.clone()),
        xdr::Asset::CreditAlphanum12(a) => xdr::TrustLineAsset::CreditAlphanum12(a.clone()),
        xdr::Asset::Native => panic!("native asset"),
    };
    t.env
        .host()
        .add_ledger_entry(
            &Rc::new(xdr::LedgerKey::Trustline(xdr::LedgerKeyTrustLine {
                account_id: id.clone(),
                asset: asset.clone(),
            })),
            &entry(xdr::LedgerEntryData::Trustline(xdr::TrustLineEntry {
                account_id: id.clone(),
                asset,
                balance: 0,
                limit: i64::MAX,
                flags: 1, // AUTHORIZED_FLAG
                ext: xdr::TrustLineEntryExt::V0,
            })),
            None,
        )
        .unwrap();
}

fn setup<'a>() -> T<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    // The endpoint's fee token: in tests a credit asset too (XLM on-chain).
    let native_sac = env.register_stellar_asset_contract_v2(owner.clone());
    let native_asset = native_sac.asset();
    let native = native_sac.address();
    let zro = env.register_stellar_asset_contract_v2(owner.clone()).address();
    let endpoint_address = env.register(EndpointV2, (&owner, STELLAR_EID, &native));
    let sml_address = env.register(SimpleMessageLib, (&owner, &endpoint_address, &Address::generate(&env)));
    let endpoint = EndpointV2Client::new(&env, &endpoint_address);
    endpoint.set_zro(&zro);
    endpoint.register_library(&sml_address);
    endpoint.set_default_send_library(&STARKNET_EID, &sml_address);
    endpoint.set_default_receive_library(&STARKNET_EID, &sml_address, &0u64);

    // The classic asset: its issuer can revoke authorization (AUTH_REVOCABLE).
    let issuer = Address::generate(&env);
    let asset_sac = env.register_stellar_asset_contract_v2(issuer);
    asset_sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    let asset = asset_sac.asset();
    let sac = StellarAssetClient::new(&env, &asset_sac.address());
    let token = TokenClient::new(&env, &asset_sac.address());

    let lockbox_address =
        env.register(VeilStellarLockbox, (&owner, &endpoint_address, &asset_sac.address(), STARKNET_EID));
    let lockbox = VeilStellarLockboxClient::new(&env, &lockbox_address);
    let gateway = BytesN::from_array(&env, &[0x05; 32]);
    lockbox.set_peer(&STARKNET_EID, &Some(gateway.clone()), &owner);

    let sml = SimpleMessageLibClient::new(&env, &sml_address);
    T { env, endpoint, sml, lockbox, sac, token, asset, native_asset, native, gateway, nonce: 0 }
}

fn felt_word(env: &Env, low: u8) -> BytesN<32> {
    let mut b = [0u8; 32];
    b[31] = low;
    b[0] = 0x07;
    BytesN::from_array(env, &b)
}

fn zero(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0; 32])
}

/// The last packet the endpoint emitted: (receiver, message).
fn last_packet(t: &T) -> (BytesN<32>, u32, Bytes) {
    let events = t.env.events().all().filter_by_contract(&t.endpoint.address);
    let sym = Symbol::new(&t.env, "packet_sent").to_val();
    for event in events.events().iter().rev() {
        let Some((topics, data)) = decode_event_topics_data(&t.env, event) else { continue };
        if topics.contains(sym) {
            let map: Map<Symbol, Val> = data.into_val(&t.env);
            let encoded: Bytes = map.get(Symbol::new(&t.env, "encoded_packet")).unwrap().into_val(&t.env);
            let header = packet_codec_v1::decode_packet_header(
                &t.env,
                &encoded.slice(0..packet_codec_v1::HEADER_LENGTH),
            );
            let payload = encoded.slice(packet_codec_v1::HEADER_LENGTH..);
            let mut r = BufferReader::new(&payload);
            let _guid = r.read_bytes_n::<32>();
            return (header.receiver, header.dst_eid, r.read_bytes_until_end());
        }
    }
    panic!("no packet sent")
}

fn fund_fee(t: &T, payer: &Address, fee: &MessagingFee) {
    StellarAssetClient::new(&t.env, &t.native).mint(payer, &fee.native_fee);
}

/// The Starknet gateway's UNLOCK, delivered: verified through the message lib,
/// then executed.
fn deliver(t: &mut T, message: &Bytes) {
    t.nonce += 1;
    let packet = OutboundPacket {
        nonce: t.nonce,
        src_eid: STARKNET_EID,
        sender: Address::from_payload(&t.env, AddressPayload::ContractIdHash(t.gateway.clone())),
        dst_eid: STELLAR_EID,
        receiver: match t.lockbox.address.to_payload().unwrap() {
            AddressPayload::ContractIdHash(h) => h,
            _ => unreachable!(),
        },
        guid: BytesN::from_array(&t.env, &[t.nonce as u8; 32]),
        message: message.clone(),
    };
    t.sml.validate_packet(
        &packet_codec_v1::encode_packet_header(&t.env, &packet),
        &packet_codec_v1::payload_hash(&t.env, &packet),
    );
    let origin = Origin { src_eid: STARKNET_EID, sender: t.gateway.clone(), nonce: t.nonce };
    let executor = Address::generate(&t.env);
    t.lockbox.lz_receive(&executor, &origin, &packet.guid, message, &Bytes::new(&t.env), &0);
}

fn bridge(t: &T, from: &Address, amount: i128, note: u8) {
    let recipient = felt_word(&t.env, 0x11);
    let fee = t.lockbox.quote_bridge_out(from, &amount, &recipient, &GAS);
    fund_fee(t, from, &fee);
    t.lockbox.bridge_out(from, &amount, &recipient, &felt_word(&t.env, note), &zero(&t.env), &GAS, &fee);
}

// ── codec ───────────────────────────────────────────────────────────────────

#[test]
fn the_codec_matches_the_bridge_wire_format() {
    let env = Env::default();
    let k = key(&env, 0xAB);
    let m = codec::encode_mint(&env, &k, &felt_word(&env, 1), 1000, 7, true, false, &felt_word(&env, 2), &zero(&env));
    assert_eq!(m.len(), 173);
    assert_eq!(m.get(0), Some(1));
    assert_eq!(m.get(1), Some(0xAB));
    assert_eq!(m.get(96), Some(0xE8)); // 1000 = 0x03E8, last byte of the u256
    assert_eq!(m.get(95), Some(0x03));
    assert_eq!(m.get(104), Some(7)); // seq u64 at 97..105
    assert_eq!(m.get(105), Some(1)); // verified
    assert_eq!(codec::encode_identity(&env, &k, 3, true, false).len(), 45);
    assert_eq!(codec::encode_global(&env, 3, false).len(), 10);
    let u = codec::encode_unlock(&env, &k, 600);
    assert_eq!(u.len(), 65);
    assert_eq!(codec::decode_unlock(&env, &u), Some((k.clone(), 600)));
    // Too large for an i128, wrong kind, wrong length: refused.
    let mut big = u.clone();
    big.set(33, 1);
    assert_eq!(codec::decode_unlock(&env, &big), None);
    let mut kind = u.clone();
    kind.set(0, 1);
    assert_eq!(codec::decode_unlock(&env, &kind), None);
    assert_eq!(codec::decode_unlock(&env, &u.slice(0..64)), None);
}

// The cairo side pins the same bytes (test_stellar_holder.cairo,
// a_stellar_lockbox_message_names_accounts_by_key): the key 0xfcb2…3322 in an
// UNLOCK of 600 starts with 0x04 0xfc and its byte 32 is 0x22.
#[test]
fn an_unlock_vector_shared_with_cairo() {
    let env = Env::default();
    let mut k = [0u8; 32];
    hex_into("fcb2a5f4c3e1d2b0a9988776655443322110ffeeddccbbaa9988776655443322", &mut k);
    let u = codec::encode_unlock(&env, &BytesN::from_array(&env, &k), 600);
    assert_eq!(u.get(0), Some(4));
    assert_eq!(u.get(1), Some(0xfc));
    assert_eq!(u.get(32), Some(0x22));
    assert_eq!(u.get(63), Some(0x02));
    assert_eq!(u.get(64), Some(0x58));
}

fn hex_into(h: &str, out: &mut [u8]) {
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap();
    }
}

// ── outbound ────────────────────────────────────────────────────────────────

#[test]
fn bridge_out_escrows_and_sends_a_mint_to_the_gateway() {
    let t = setup();
    let k = key(&t.env, 0x07);
    let alice = open_account(&t, &k);
    t.sac.mint(&alice, &5_000);
    bridge(&t, &alice, 1_000, 0x42);
    // Read the endpoint's event before any other call clears the log, and
    // the auths of that same invocation.
    let (receiver, dst, message) = last_packet(&t);
    assert!(t.env.auths().iter().any(|(a, _)| *a == alice), "from authorized the bridge-out");

    assert_eq!(t.token.balance(&alice), 4_000);
    assert_eq!(t.token.balance(&t.lockbox.address), 1_000);
    assert_eq!(t.lockbox.total_escrowed(), 1_000);
    assert_eq!(t.lockbox.seq(), 1);
    assert_eq!(receiver, t.gateway);
    assert_eq!(dst, STARKNET_EID);
    let expected = codec::encode_mint(
        &t.env, &k, &felt_word(&t.env, 0x11), 1_000, 1, true, false, &felt_word(&t.env, 0x42), &zero(&t.env),
    );
    assert_eq!(message, expected);
}

#[test]
fn an_unauthorized_account_cannot_bridge_out() {
    let t = setup();
    let alice = open_account(&t, &key(&t.env, 0x07));
    t.sac.mint(&alice, &5_000);
    t.sac.set_authorized(&alice, &false);
    let recipient = felt_word(&t.env, 0x11);
    let fee = t.lockbox.quote_bridge_out(&alice, &1_000, &recipient, &GAS);
    let r = t.lockbox.try_bridge_out(&alice, &1_000, &recipient, &felt_word(&t.env, 1), &zero(&t.env), &GAS, &fee);
    assert_eq!(r.err().unwrap().ok().unwrap(), LockboxError::NotAuthorized.into());
}

#[test]
fn a_contract_address_cannot_bridge_out() {
    let t = setup();
    let c = Address::generate(&t.env); // a contract (C…) address
    t.sac.mint(&c, &5_000);
    let fee = MessagingFee { native_fee: 0, zro_fee: 0 };
    let r = t.lockbox.try_bridge_out(&c, &1, &felt_word(&t.env, 1), &felt_word(&t.env, 1), &zero(&t.env), &GAS, &fee);
    assert_eq!(r.err().unwrap().ok().unwrap(), LockboxError::NotAnAccount.into());
}

#[test]
fn words_the_starknet_side_cannot_read_are_refused_here() {
    let t = setup();
    let alice = open_account(&t, &key(&t.env, 0x07));
    t.sac.mint(&alice, &5_000);
    let fee = MessagingFee { native_fee: 0, zro_fee: 0 };
    let too_big = BytesN::from_array(&t.env, &[0x08; 32]);
    let r = t.lockbox.try_bridge_out(&alice, &1, &too_big, &felt_word(&t.env, 1), &zero(&t.env), &GAS, &fee);
    assert_eq!(r.err().unwrap().ok().unwrap(), LockboxError::NotAFelt.into());
    let r = t.lockbox.try_bridge_out(&alice, &1, &felt_word(&t.env, 1), &zero(&t.env), &zero(&t.env), &GAS, &fee);
    assert_eq!(r.err().unwrap().ok().unwrap(), LockboxError::ZeroNoteId.into());
    let r = t.lockbox.try_bridge_out(&alice, &0, &felt_word(&t.env, 1), &felt_word(&t.env, 1), &zero(&t.env), &GAS, &fee);
    assert_eq!(r.err().unwrap().ok().unwrap(), LockboxError::ZeroAmount.into());
}

#[test]
fn sync_compliance_sends_the_sac_authorization() {
    let t = setup();
    let k = key(&t.env, 0x07);
    let alice = open_account(&t, &k);
    let payer = open_account(&t, &key(&t.env, 0x0A));
    let fee = t.lockbox.quote_sync_compliance(&alice, &GAS);
    fund_fee(&t, &payer, &fee);
    t.lockbox.sync_compliance(&alice, &payer, &GAS, &fee);
    assert_eq!(last_packet(&t).2, codec::encode_identity(&t.env, &k, 1, true, false));

    // Revoked: not verified, and frozen.
    t.sac.set_authorized(&alice, &false);
    fund_fee(&t, &payer, &fee);
    t.lockbox.sync_compliance(&alice, &payer, &GAS, &fee);
    assert_eq!(last_packet(&t).2, codec::encode_identity(&t.env, &k, 2, false, true));

    // No trustline at all: not verified either.
    let stranger_key = key(&t.env, 0x0B);
    fund_fee(&t, &payer, &fee);
    t.lockbox.sync_compliance(&g_address(&t.env, &stranger_key), &payer, &GAS, &fee);
    assert_eq!(last_packet(&t).2, codec::encode_identity(&t.env, &stranger_key, 3, false, true));
}

#[test]
fn sync_global_says_not_paused() {
    let t = setup();
    let payer = open_account(&t, &key(&t.env, 0x0A));
    // GLOBAL is shorter than IDENTITY; the SML's flat fee covers either.
    let fee = t.lockbox.quote_sync_compliance(&payer, &GAS);
    fund_fee(&t, &payer, &fee);
    t.lockbox.sync_global(&payer, &GAS, &fee);
    assert_eq!(last_packet(&t).2, codec::encode_global(&t.env, 1, false));
}

// ── inbound ─────────────────────────────────────────────────────────────────

#[test]
fn an_unlock_releases_the_escrow_to_the_stellar_account() {
    let mut t = setup();
    let k = key(&t.env, 0x07);
    let alice = open_account(&t, &k);
    t.sac.mint(&alice, &5_000);
    bridge(&t, &alice, 1_000, 0x42);

    let bob_key = key(&t.env, 0x0C);
    let bob = open_account(&t, &bob_key);
    let unlock = codec::encode_unlock(&t.env, &bob_key, 600);
    deliver(&mut t, &unlock);
    assert_eq!(t.token.balance(&bob), 600);
    assert_eq!(t.lockbox.total_escrowed(), 400);
}

#[test]
fn an_unauthorized_recipient_is_held_then_claims() {
    let mut t = setup();
    let alice = open_account(&t, &key(&t.env, 0x07));
    t.sac.mint(&alice, &5_000);
    bridge(&t, &alice, 1_000, 0x42);

    let bob_key = key(&t.env, 0x0C);
    let bob = open_account(&t, &bob_key);
    t.sac.set_authorized(&bob, &false);
    let unlock = codec::encode_unlock(&t.env, &bob_key, 600);
    deliver(&mut t, &unlock);
    assert_eq!(t.token.balance(&bob), 0);
    assert_eq!(t.lockbox.claimable(&bob_key), 600);
    assert_eq!(t.lockbox.total_claimable(), 600);
    assert_eq!(t.lockbox.total_escrowed(), 1_000);

    let r = t.lockbox.try_claim(&bob_key);
    assert_eq!(r.err().unwrap().ok().unwrap(), LockboxError::StillUnauthorized.into());

    t.sac.set_authorized(&bob, &true);
    assert_eq!(t.lockbox.claim(&bob_key), 600);
    assert_eq!(t.token.balance(&bob), 600);
    assert_eq!(t.lockbox.claimable(&bob_key), 0);
    assert_eq!(t.lockbox.total_escrowed(), 400);
    let r = t.lockbox.try_claim(&bob_key);
    assert_eq!(r.err().unwrap().ok().unwrap(), LockboxError::NothingClaimable.into());
}

#[test]
fn a_recipient_with_no_trustline_is_held_not_reverted() {
    let mut t = setup();
    let alice = open_account(&t, &key(&t.env, 0x07));
    t.sac.mint(&alice, &5_000);
    bridge(&t, &alice, 1_000, 0x42);
    let nobody = key(&t.env, 0x0D);
    let unlock = codec::encode_unlock(&t.env, &nobody, 100);
    deliver(&mut t, &unlock);
    assert_eq!(t.lockbox.claimable(&nobody), 100);
}

#[test]
fn a_release_above_the_escrow_reverts() {
    let mut t = setup();
    let alice = open_account(&t, &key(&t.env, 0x07));
    t.sac.mint(&alice, &5_000);
    bridge(&t, &alice, 1_000, 0x42);
    let bob_key = key(&t.env, 0x0C);
    open_account(&t, &bob_key);
    let unlock = codec::encode_unlock(&t.env, &bob_key, 1_001);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| deliver(&mut t, &unlock)));
    assert!(r.is_err());
    assert_eq!(t.lockbox.total_escrowed(), 1_000);
}

#[test]
fn only_the_gateway_peer_is_heard() {
    let mut t = setup();
    t.gateway = BytesN::from_array(&t.env, &[0x06; 32]); // not the configured peer
    let unlock = codec::encode_unlock(&t.env, &key(&t.env, 0x0C), 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| deliver(&mut t, &unlock)));
    assert!(r.is_err());
}
