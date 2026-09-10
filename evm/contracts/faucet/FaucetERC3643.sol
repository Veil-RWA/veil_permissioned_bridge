// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRegistry {
    function isVerified(address account) external view returns (bool);
    function investorCountry(address account) external view returns (uint16);
    function registerIdentity(address account, uint16 country) external;
}

interface ICompliance {
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);
    function transferred(address from, address to, uint256 amount) external;
    function created(address to, uint256 amount) external;
    function destroyed(address from, uint256 amount) external;
}

/// A permissioned ERC-3643 asset with a public faucet, for Ethereum Sepolia.
///
/// This is what the bridge is pointed at on testnet. The transfer gate is the
/// REAL one -- verified sender, verified recipient, neither frozen, not paused,
/// and every compliance module agreeing -- so a bridge-out that fails here
/// fails for the reason it would against an issuer's token, not a simplified
/// one. Everything the bridge reads (`identityRegistry`, `compliance`,
/// `paused`, `isFrozen`) is present because the lockbox and the app call all of
/// them.
///
/// The faucet is the only part that is not production shaped: `claim()`
/// registers the caller and mints to them. That is deliberate and testnet-only
/// -- on a real asset, registration is the issuer's KYC decision and minting is
/// the issuer's. It exists so a tester can get a permissioned balance without
/// anyone hand-registering them first.
contract FaucetERC3643 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    address public owner;
    mapping(address => bool) public isAgent;

    address public identityRegistry;
    address public compliance;
    bool public paused;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isFrozen;

    /// Faucet policy.
    uint256 public faucetAmount;
    uint16 public faucetCountry;
    uint256 public faucetCooldown;
    mapping(address => uint256) public lastClaimed;
    /// Whether an address has EVER claimed. Kept separately rather than
    /// inferred from `lastClaimed != 0`: a zero timestamp is a legal block
    /// timestamp, and inferring from it lets the cooldown be skipped.
    mapping(address => bool) public hasClaimed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnerChanged(address indexed previous, address indexed current);
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);
    event Paused(bool paused);
    event AddressFrozen(address indexed account, bool frozen);
    event FaucetConfigured(uint256 amount, uint16 country, uint256 cooldown);
    event FaucetClaimed(address indexed account, uint256 amount);
    event RecoverySuccess(address indexed from, address indexed to, uint256 amount);

    error NotOwner();
    error NotAgent();
    error ZeroAddress();
    error TokenPaused();
    error SenderFrozen();
    error RecipientFrozen();
    error SenderNotVerified();
    error RecipientNotVerified();
    error ComplianceBlocked();
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

    constructor(
        string memory name_,
        string memory symbol_,
        address owner_,
        address registry_,
        address compliance_
    ) {
        if (owner_ == address(0) || registry_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        owner = owner_;
        identityRegistry = registry_;
        compliance = compliance_;
        emit OwnerChanged(address(0), owner_);
    }

    // ── Admin ───────────────────────────────────────────────────────────────
    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }

    function addAgent(address agent) external onlyOwner {
        isAgent[agent] = true;
        emit AgentAdded(agent);
    }

    function removeAgent(address agent) external onlyOwner {
        isAgent[agent] = false;
        emit AgentRemoved(agent);
    }

    function setIdentityRegistry(address registry_) external onlyOwner {
        if (registry_ == address(0)) revert ZeroAddress();
        identityRegistry = registry_;
    }

    function setCompliance(address compliance_) external onlyOwner {
        compliance = compliance_;
    }

    function setPaused(bool value) external onlyAgent {
        paused = value;
        emit Paused(value);
    }

    function setAddressFrozen(address account, bool frozen) external onlyAgent {
        isFrozen[account] = frozen;
        emit AddressFrozen(account, frozen);
    }

    // ── Faucet ──────────────────────────────────────────────────────────────
    /// `amount` of 0 disables claiming.
    function configureFaucet(uint256 amount, uint16 country, uint256 cooldown)
        external
        onlyOwner
    {
        faucetAmount = amount;
        faucetCountry = country;
        faucetCooldown = cooldown;
        emit FaucetConfigured(amount, country, cooldown);
    }

    /// Register the caller if new, then mint them the faucet amount.
    ///
    /// Registering here is why this token must be an AGENT on the registry
    /// (`registry.addAgent(token)`). Without that the call reverts inside the
    /// registry rather than here.
    function claim() external returns (uint256) {
        if (faucetAmount == 0) revert FaucetDisabled();
        uint256 next = lastClaimed[msg.sender] + faucetCooldown;
        if (hasClaimed[msg.sender] && block.timestamp < next) {
            revert FaucetCooldown(next);
        }
        hasClaimed[msg.sender] = true;
        lastClaimed[msg.sender] = block.timestamp;

        if (!IRegistry(identityRegistry).isVerified(msg.sender)) {
            IRegistry(identityRegistry).registerIdentity(msg.sender, faucetCountry);
        }
        _mint(msg.sender, faucetAmount);
        emit FaucetClaimed(msg.sender, faucetAmount);
        return faucetAmount;
    }

    // ── Supply, agent-gated ─────────────────────────────────────────────────
    function mint(address to, uint256 amount) external onlyAgent {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyAgent {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        totalSupply -= amount;
        if (compliance != address(0)) ICompliance(compliance).destroyed(from, amount);
        emit Transfer(from, address(0), amount);
    }

    /// The T-REX recovery power: move a holder's balance without their key and
    /// without the transfer gate. The bridge's Starknet twin mirrors this, so
    /// the recovery path can be exercised across both chains.
    function forcedTransfer(address from, address to, uint256 amount) external onlyAgent {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (compliance != address(0)) ICompliance(compliance).transferred(from, to, amount);
        emit Transfer(from, to, amount);
        emit RecoverySuccess(from, to, amount);
    }

    function _mint(address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        if (paused) revert TokenPaused();
        if (!IRegistry(identityRegistry).isVerified(to)) revert RecipientNotVerified();
        if (compliance != address(0)) {
            if (!ICompliance(compliance).canTransfer(address(0), to, amount)) {
                revert ComplianceBlocked();
            }
        }
        totalSupply += amount;
        balanceOf[to] += amount;
        if (compliance != address(0)) ICompliance(compliance).created(to, amount);
        emit Transfer(address(0), to, amount);
    }

    // ── ERC-20, gated ───────────────────────────────────────────────────────
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// What the lockbox calls to escrow. The gate runs on the HOLDER and on the
    /// lockbox as recipient, which is why the lockbox has to be a registered
    /// identity before any bridge-out can succeed.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        if (paused) revert TokenPaused();
        if (isFrozen[from]) revert SenderFrozen();
        if (isFrozen[to]) revert RecipientFrozen();

        IRegistry registry = IRegistry(identityRegistry);
        if (!registry.isVerified(from)) revert SenderNotVerified();
        if (!registry.isVerified(to)) revert RecipientNotVerified();

        if (compliance != address(0)) {
            if (!ICompliance(compliance).canTransfer(from, to, amount)) revert ComplianceBlocked();
        }

        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (compliance != address(0)) ICompliance(compliance).transferred(from, to, amount);
        emit Transfer(from, to, amount);
    }
}
