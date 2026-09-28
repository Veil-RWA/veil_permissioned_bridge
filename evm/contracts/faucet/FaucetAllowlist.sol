// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The issuer's allowlist for `FaucetAllowlistToken`, in OpenZeppelin
/// AccessControl's shape: an account is allowed when it holds `WHITELISTED_ROLE`.
/// This is the contract `VeilAllowlistLockbox` reads.
contract FaucetPermissionManager {
    bytes32 public constant WHITELISTED_ROLE = keccak256("WHITELISTED_ROLE");

    address public owner;
    mapping(address => bool) public isAgent;
    mapping(bytes32 => mapping(address => bool)) private _roles;

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);

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
    }

    function addAgent(address agent) external onlyOwner {
        isAgent[agent] = true;
        emit AgentAdded(agent);
    }

    function removeAgent(address agent) external onlyOwner {
        isAgent[agent] = false;
        emit AgentRemoved(agent);
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyAgent {
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external onlyAgent {
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }
}

/// An allowlisted ERC-20 with a public faucet, for Ethereum Sepolia.
///
/// The transfer check is the real one for this kind of asset: sender and
/// recipient both hold the whitelist role, and the token is not paused. Minting
/// requires the recipient to be allowed too.
///
/// The faucet is the only part that is not production shaped: `claim()` adds
/// the caller to the allowlist and mints to them, so a tester can get a balance
/// without anyone allowlisting them first. On a real asset both are the
/// issuer's decision. The token must be an agent of its permission manager.
contract FaucetAllowlistToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    address public owner;
    mapping(address => bool) public isAgent;

    FaucetPermissionManager public immutable permissionManager;
    bool public paused;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public faucetAmount;
    uint256 public faucetCooldown;
    mapping(address => uint256) public lastClaimed;
    mapping(address => bool) public hasClaimed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Paused(bool paused);
    event FaucetConfigured(uint256 amount, uint256 cooldown);
    event FaucetClaimed(address indexed account, uint256 amount);

    error NotOwner();
    error NotAgent();
    error ZeroAddress();
    error TokenPaused();
    error SenderNotAllowed();
    error RecipientNotAllowed();
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

    constructor(string memory name_, string memory symbol_, address owner_, address manager_) {
        if (owner_ == address(0) || manager_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        owner = owner_;
        permissionManager = FaucetPermissionManager(manager_);
    }

    function addAgent(address agent) external onlyOwner {
        isAgent[agent] = true;
    }

    function setPaused(bool value) external onlyAgent {
        paused = value;
        emit Paused(value);
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

        bytes32 role = permissionManager.WHITELISTED_ROLE();
        if (!permissionManager.hasRole(role, recipient)) permissionManager.grantRole(role, recipient);
        _mint(recipient, faucetAmount);
        emit FaucetClaimed(recipient, faucetAmount);
        return faucetAmount;
    }

    function mint(address to, uint256 amount) external onlyAgent {
        _mint(to, amount);
    }

    function _allowed(address account) private view returns (bool) {
        return permissionManager.hasRole(permissionManager.WHITELISTED_ROLE(), account);
    }

    function _mint(address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        if (paused) revert TokenPaused();
        if (!_allowed(to)) revert RecipientNotAllowed();
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
        if (paused) revert TokenPaused();
        if (!_allowed(from)) revert SenderNotAllowed();
        if (!_allowed(to)) revert RecipientNotAllowed();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
