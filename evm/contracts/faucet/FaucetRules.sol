// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVeilRulesSource} from "../IVeilRulesSource.sol";

interface IBalanceOf {
    function balanceOf(address account) external view returns (uint256);
}

/// The issuer's rules for `FaucetRulesToken`, and the adapter the bridge reads
/// (`IVeilRulesSource`). The token's own transfer check reads the same records,
/// so what the bridge carries to Starknet is exactly what the token enforces.
///
/// Platform accounts (the lockbox, issuer wallets) are exempt from the
/// investor-to-investor rules, as a transfer agent's own wallets are.
contract FaucetRulesSource is IVeilRulesSource {
    struct Holder {
        bool canHold;
        bool frozen;
        bool isInvestor;
        /// The issuer's lock on this holder, in total.
        uint256 lockedTotal;
    }

    address public owner;
    mapping(address => bool) public isAgent;
    address public token;

    mapping(address => Holder) private _holders;
    mapping(address => bool) public isPlatform;
    TokenRules private _token;
    bool public paused;

    event HolderSet(address indexed account);
    event TokenRulesSet();
    event PlatformSet(address indexed account, bool platform);
    event Paused(bool paused);

    error NotOwner();
    error NotAgent();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != owner && !isAgent[msg.sender]) revert NotAgent();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        _token.transfersEnabled = true;
    }

    function addAgent(address agent) external onlyOwner {
        isAgent[agent] = true;
    }

    function setToken(address token_) external onlyOwner {
        token = token_;
    }

    function setHolder(address account, bool canHold, bool frozen, bool isInvestor, uint256 lockedTotal)
        external
        onlyAgent
    {
        _holders[account] = Holder(canHold, frozen, isInvestor, lockedTotal);
        emit HolderSet(account);
    }

    function setPlatform(address account, bool platform) external onlyAgent {
        isPlatform[account] = platform;
        emit PlatformSet(account, platform);
    }

    function setTokenRules(TokenRules calldata rules) external onlyAgent {
        _token = rules;
        emit TokenRulesSet();
    }

    function setPaused(bool value) external onlyAgent {
        paused = value;
        emit Paused(value);
    }

    function holder(address account) external view returns (Holder memory) {
        return _holders[account];
    }

    // ── IVeilRulesSource ────────────────────────────────────────────────────

    function holderRules(address account) external view returns (HolderRules memory r) {
        Holder memory h = _holders[account];
        r.canHold = h.canHold || isPlatform[account];
        r.frozen = h.frozen;
        r.isInvestor = h.isInvestor;
        // The part of the lock this chain's balance does not cover: what must
        // stay unspent in the holder's Veil notes.
        uint256 here = token == address(0) ? 0 : IBalanceOf(token).balanceOf(account);
        r.locked = h.lockedTotal > here ? h.lockedTotal - here : 0;
    }

    function tokenRules() external view returns (TokenRules memory) {
        return _token;
    }
}

/// A rule-gated ERC-20 with a public faucet, for Ethereum Sepolia.
///
/// Every transfer is decided by the issuer's rules in `FaucetRulesSource`, the
/// same way the Veil pool decides a private movement of its twin:
///
///   - not paused; neither side frozen; the recipient may hold;
///   - between investors: transfers switched on, and against the sender's
///     balance -- a full-balance rule, the investor cap (a new investor only
///     when the sender exits), the lock, and the minimum holding.
///
/// The lock also applies when a holder escrows into the bridge: locked tokens
/// do not leave. The faucet is testnet only: `claim()` approves the caller as
/// an investor and mints to them. The token must be an agent of its source.
contract FaucetRulesToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    address public owner;
    mapping(address => bool) public isAgent;
    FaucetRulesSource public immutable rules;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public faucetAmount;
    uint256 public faucetCooldown;
    mapping(address => uint256) public lastClaimed;
    mapping(address => bool) public hasClaimed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event FaucetConfigured(uint256 amount, uint256 cooldown);
    event FaucetClaimed(address indexed account, uint256 amount);

    error NotOwner();
    error NotAgent();
    error ZeroAddress();
    error TokenPaused();
    error TransfersDisabled();
    error SenderFrozen();
    error RecipientFrozen();
    error RecipientCannotHold();
    error FullBalanceRequired();
    error InvestorCapReached();
    error TokensLocked();
    error BelowMinHolding();
    error InsufficientBalance();
    error InsufficientAllowance();
    error FaucetDisabled();
    error FaucetCooldown(uint256 availableAt);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != owner && !isAgent[msg.sender]) revert NotAgent();
        _;
    }

    constructor(string memory name_, string memory symbol_, address owner_, address rules_) {
        if (owner_ == address(0) || rules_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        owner = owner_;
        rules = FaucetRulesSource(rules_);
    }

    function addAgent(address agent) external onlyOwner {
        isAgent[agent] = true;
    }

    /// For the lockbox's defensive `paused()` read and for wallets.
    function paused() external view returns (bool) {
        return rules.paused();
    }

    function configureFaucet(uint256 amount, uint256 cooldown) external onlyOwner {
        faucetAmount = amount;
        faucetCooldown = cooldown;
        emit FaucetConfigured(amount, cooldown);
    }

    function claim() external returns (uint256) {
        return _claimFor(msg.sender);
    }

    function claimFor(address recipient) external returns (uint256) {
        return _claimFor(recipient);
    }

    function _claimFor(address recipient) private returns (uint256) {
        if (faucetAmount == 0) revert FaucetDisabled();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 next = lastClaimed[recipient] + faucetCooldown;
        if (hasClaimed[recipient] && block.timestamp < next) revert FaucetCooldown(next);
        hasClaimed[recipient] = true;
        lastClaimed[recipient] = block.timestamp;

        FaucetRulesSource.Holder memory h = rules.holder(recipient);
        if (!h.canHold || !h.isInvestor) rules.setHolder(recipient, true, h.frozen, true, h.lockedTotal);
        _mint(recipient, faucetAmount);
        emit FaucetClaimed(recipient, faucetAmount);
        return faucetAmount;
    }

    function mint(address to, uint256 amount) external onlyAgent {
        _mint(to, amount);
    }

    function _mint(address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        if (rules.paused()) revert TokenPaused();
        if (!rules.holderRules(to).canHold) revert RecipientCannotHold();
        if (rules.holderRules(to).frozen) revert RecipientFrozen();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        if (rules.paused()) revert TokenPaused();
        FaucetRulesSource.Holder memory f = rules.holder(from);
        IVeilRulesSource.HolderRules memory t = rules.holderRules(to);
        if (f.frozen) revert SenderFrozen();
        if (t.frozen) revert RecipientFrozen();
        if (!t.canHold) revert RecipientCannotHold();

        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();

        bool fromPlatform = rules.isPlatform(from);
        bool toPlatform = rules.isPlatform(to);
        // The lock binds a holder wherever the tokens go, the bridge included.
        if (!fromPlatform && f.lockedTotal != 0) {
            if (f.lockedTotal > balance || amount > balance - f.lockedTotal) revert TokensLocked();
        }
        if (!fromPlatform && !toPlatform) {
            IVeilRulesSource.TokenRules memory k = rules.tokenRules();
            if (!k.transfersEnabled) revert TransfersDisabled();
            if (k.fullBalanceRequired && amount != balance) revert FullBalanceRequired();
            if (k.investorCapReached && !t.isInvestor && amount != balance) revert InvestorCapReached();
            if ((k.minHoldingStrict || amount < balance) && balance - amount < k.minHolding) {
                revert BelowMinHolding();
            }
        }

        balanceOf[from] = balance - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
