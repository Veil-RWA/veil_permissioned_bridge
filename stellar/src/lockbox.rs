use crate::{codec, errors::LockboxError, options, storage::LockboxStorage};
use common_macros::{contract_impl, lz_contract, only_auth};
use endpoint_v2::{MessagingFee, Origin};
use oapp::{
    oapp_core::init_ownable_oapp,
    oapp_receiver::LzReceiveInternal,
    oapp_sender::{FeePayer, OAppSenderInternal},
};
use oapp_macros::oapp;
use soroban_sdk::{
    address_payload::AddressPayload, assert_with_error, contractevent, panic_with_error,
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env,
};

/// Carries no Starknet destination: an indexed pair would be a free
/// cross-chain linkage query. The destination is in the message.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgedOut {
    #[topic]
    pub sender: Address,
    pub amount: i128,
    pub seq: u64,
    pub guid: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComplianceSynced {
    #[topic]
    pub account: Address,
    pub seq: u64,
    pub verified: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Released {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseHeld {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claimed {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

/// Escrows a classic Stellar asset (through its SAC) and drives its twin on
/// Starknet, as the EVM `VeilAllowlistLockbox` does for an allowlisted ERC-20.
///
/// DEPLOYMENT PRECONDITION. If the issuer sets AUTH_REQUIRED, the issuer must
/// `set_authorized(lockbox, true)` before any escrow can succeed; if it set
/// AUTH_CLAWBACK_ENABLED, it can claw the escrow back, which is its consent to
/// the bridge being withdrawable at any time, as on EVM.
#[lz_contract]
#[oapp]
pub struct VeilStellarLockbox;

#[contract_impl]
impl VeilStellarLockbox {
    pub fn __constructor(env: &Env, owner: &Address, endpoint: &Address, token: &Address, dst_eid: u32) {
        init_ownable_oapp::<Self>(env, owner, endpoint, owner);
        LockboxStorage::set_token(env, token);
        LockboxStorage::set_dst_eid(env, &dst_eid);
    }

    // ── admin ───────────────────────────────────────────────────────────────

    #[only_auth]
    pub fn set_dst_eid(env: &Env, dst_eid: u32) {
        LockboxStorage::set_dst_eid(env, &dst_eid);
    }

    // ── outbound ────────────────────────────────────────────────────────────

    /// Escrow `amount` from `from` (a `G…` account) and have it filled into
    /// `note_id`, an open note `sn_recipient` holds in a Veil pool on Starknet
    /// (`pool` zero = the gateway's default). The only way across: a bridge-in
    /// always lands in a pool note. `from` pays the LayerZero fee.
    #[allow(clippy::too_many_arguments)]
    pub fn bridge_out(
        env: &Env,
        from: &Address,
        amount: i128,
        sn_recipient: &BytesN<32>,
        note_id: &BytesN<32>,
        pool: &BytesN<32>,
        gas_limit: u128,
        fee: &MessagingFee,
    ) -> BytesN<32> {
        from.require_auth();
        assert_with_error!(env, amount > 0, LockboxError::ZeroAmount);
        assert_with_error!(env, *note_id != BytesN::from_array(env, &[0; 32]), LockboxError::ZeroNoteId);
        // Everything the Starknet side reads as a felt must be one, or the
        // message reverts there and the escrow is stranded behind it.
        assert_with_error!(
            env,
            codec::fits_felt(sn_recipient) && codec::fits_felt(note_id) && codec::fits_felt(pool),
            LockboxError::NotAFelt
        );
        let sender = account_key(env, from);
        // Fail fast: an unauthorized sender's escrow would fail in the SAC
        // anyway, and one that slipped past would only be quarantined.
        assert_with_error!(env, is_authorized(env, from), LockboxError::NotAuthorized);

        // The SAC's own gate (trustline, authorization) decides the escrow.
        token_client(env).transfer(from, &env.current_contract_address(), &amount);
        LockboxStorage::set_total_escrowed(env, &(LockboxStorage::total_escrowed(env) + amount));

        let seq = next_seq(env);
        let message = codec::encode_mint(env, &sender, sn_recipient, amount, seq, true, false, note_id, pool);
        let receipt = Self::__lz_send(
            env,
            dst_eid(env),
            &message,
            &options::executor_lz_receive_option(env, gas_limit, 0),
            &FeePayer::Verified(from.clone()),
            fee,
            from,
        );
        BridgedOut { sender: from.clone(), amount, seq, guid: receipt.guid.clone() }.publish(env);
        receipt.guid
    }

    /// Push `account`'s current eligibility (SAC `authorized`) to the mirror.
    /// Permissionless: it forwards only what the issuer's trustline flag
    /// already says. `payer` pays the LayerZero fee.
    pub fn sync_compliance(env: &Env, account: &Address, payer: &Address, gas_limit: u128, fee: &MessagingFee) -> BytesN<32> {
        payer.require_auth();
        let key = account_key(env, account);
        let verified = is_authorized(env, account);
        let seq = next_seq(env);
        // A revoked authorization is the SAC's freeze.
        let message = codec::encode_identity(env, &key, seq, verified, !verified);
        let receipt = Self::__lz_send(
            env,
            dst_eid(env),
            &message,
            &options::executor_lz_receive_option(env, gas_limit, 0),
            &FeePayer::Verified(payer.clone()),
            fee,
            payer,
        );
        ComplianceSynced { account: account.clone(), seq, verified }.publish(env);
        receipt.guid
    }

    /// Token-level state. A SAC has no pause, so this only ever says
    /// "not paused"; it exists so the mirror's global record is fresh.
    pub fn sync_global(env: &Env, payer: &Address, gas_limit: u128, fee: &MessagingFee) -> BytesN<32> {
        payer.require_auth();
        let seq = LockboxStorage::global_seq(env) + 1;
        LockboxStorage::set_global_seq(env, &seq);
        let receipt = Self::__lz_send(
            env,
            dst_eid(env),
            &codec::encode_global(env, seq, false),
            &options::executor_lz_receive_option(env, gas_limit, 0),
            &FeePayer::Verified(payer.clone()),
            fee,
            payer,
        );
        receipt.guid
    }

    pub fn quote_bridge_out(env: &Env, from: &Address, amount: i128, sn_recipient: &BytesN<32>, gas_limit: u128) -> MessagingFee {
        let zero = BytesN::from_array(env, &[0; 32]);
        let message = codec::encode_mint(
            env,
            &account_key(env, from),
            sn_recipient,
            amount.max(0),
            LockboxStorage::seq(env) + 1,
            true,
            false,
            &zero,
            &zero,
        );
        Self::__quote(env, dst_eid(env), &message, &options::executor_lz_receive_option(env, gas_limit, 0), false)
    }

    pub fn quote_sync_compliance(env: &Env, account: &Address, gas_limit: u128) -> MessagingFee {
        let message = codec::encode_identity(env, &account_key(env, account), LockboxStorage::seq(env) + 1, true, false);
        Self::__quote(env, dst_eid(env), &message, &options::executor_lz_receive_option(env, gas_limit, 0), false)
    }

    // ── held releases ───────────────────────────────────────────────────────

    /// Retry a held release. Permissionless: the funds only go to the account
    /// the original message named.
    pub fn claim(env: &Env, recipient: &BytesN<32>) -> i128 {
        let amount = LockboxStorage::claimable(env, recipient);
        assert_with_error!(env, amount > 0, LockboxError::NothingClaimable);
        let to = account_address(env, recipient);
        assert_with_error!(env, is_authorized(env, &to), LockboxError::StillUnauthorized);
        LockboxStorage::set_claimable(env, recipient, &0);
        LockboxStorage::set_total_claimable(env, &(LockboxStorage::total_claimable(env) - amount));
        token_client(env).transfer(&env.current_contract_address(), &to, &amount);
        debit_escrow(env, amount);
        Claimed { recipient: to, amount }.publish(env);
        amount
    }

    // ── views ───────────────────────────────────────────────────────────────

    pub fn token(env: &Env) -> Address {
        LockboxStorage::token(env).unwrap()
    }

    pub fn dst_eid(env: &Env) -> u32 {
        dst_eid(env)
    }

    pub fn seq(env: &Env) -> u64 {
        LockboxStorage::seq(env)
    }

    pub fn claimable(env: &Env, account: &BytesN<32>) -> i128 {
        LockboxStorage::claimable(env, account)
    }

    pub fn total_claimable(env: &Env) -> i128 {
        LockboxStorage::total_claimable(env)
    }

    pub fn total_escrowed(env: &Env) -> i128 {
        LockboxStorage::total_escrowed(env)
    }
}

// ── inbound ─────────────────────────────────────────────────────────────────

impl LzReceiveInternal for VeilStellarLockbox {
    /// Release escrow on the gateway's UNLOCK. Never reverts on a policy
    /// outcome: the twin is already burned, so an account that cannot receive
    /// now is parked in `claimable`. A malformed message, or a release larger
    /// than the escrow (supply minted that this contract never backed), does
    /// revert, leaving the message retryable.
    fn __lz_receive(
        env: &Env,
        _origin: &Origin,
        _guid: &BytesN<32>,
        message: &Bytes,
        _extra_data: &Bytes,
        _executor: &Address,
        _value: i128,
    ) {
        let (key, amount) =
            codec::decode_unlock(env, message).unwrap_or_else(|| panic_with_error!(env, LockboxError::BadMessage));
        assert_with_error!(env, amount > 0, LockboxError::AmountOutOfRange);
        assert_with_error!(env, amount <= LockboxStorage::total_escrowed(env), LockboxError::EscrowUnderflow);
        let to = account_address(env, &key);
        if !is_authorized(env, &to) {
            hold(env, &key, &to, amount);
            return;
        }
        match token_client(env).try_transfer(&env.current_contract_address(), &to, &amount) {
            Ok(Ok(())) => {
                debit_escrow(env, amount);
                Released { recipient: to, amount }.publish(env);
            }
            _ => hold(env, &key, &to, amount),
        }
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn token_client(env: &Env) -> TokenClient<'_> {
    TokenClient::new(env, &LockboxStorage::token(env).unwrap())
}

fn dst_eid(env: &Env) -> u32 {
    LockboxStorage::dst_eid(env).unwrap()
}

fn next_seq(env: &Env) -> u64 {
    let s = LockboxStorage::seq(env) + 1;
    LockboxStorage::set_seq(env, &s);
    s
}

/// The SAC's `authorized(id)`; false when it cannot answer (no trustline).
fn is_authorized(env: &Env, account: &Address) -> bool {
    let sac = StellarAssetClient::new(env, &LockboxStorage::token(env).unwrap());
    matches!(sac.try_authorized(account), Ok(Ok(true)))
}

/// A `G…` account's raw Ed25519 key. Contracts are refused: the Starknet side
/// reads the word as a Stellar account key.
fn account_key(env: &Env, account: &Address) -> BytesN<32> {
    match account.to_payload() {
        Some(AddressPayload::AccountIdPublicKeyEd25519(key)) => key,
        _ => panic_with_error!(env, LockboxError::NotAnAccount),
    }
}

fn account_address(env: &Env, key: &BytesN<32>) -> Address {
    Address::from_payload(env, AddressPayload::AccountIdPublicKeyEd25519(key.clone()))
}

fn debit_escrow(env: &Env, amount: i128) {
    let escrowed = LockboxStorage::total_escrowed(env);
    assert_with_error!(env, amount <= escrowed, LockboxError::EscrowUnderflow);
    LockboxStorage::set_total_escrowed(env, &(escrowed - amount));
}

fn hold(env: &Env, key: &BytesN<32>, to: &Address, amount: i128) {
    LockboxStorage::set_claimable(env, key, &(LockboxStorage::claimable(env, key) + amount));
    LockboxStorage::set_total_claimable(env, &(LockboxStorage::total_claimable(env) + amount));
    ReleaseHeld { recipient: to.clone(), amount }.publish(env);
}
