use common_macros::contract_error;

#[contract_error]
pub enum LockboxError {
    ZeroAmount,
    ZeroNoteId,
    NotAnAccount,
    NotAuthorized,
    NotAFelt,
    BadMessage,
    AmountOutOfRange,
    NothingClaimable,
    StillUnauthorized,
    EscrowUnderflow,
}
