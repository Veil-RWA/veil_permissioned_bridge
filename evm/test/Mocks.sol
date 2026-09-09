// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// TEST ONLY. Stand-ins for the T-REX deployment the bridge sits in front of,
// and for the LayerZero endpoint it talks through.

import {
    ILayerZeroReceiver,
    MessagingFee,
    MessagingParams,
    MessagingReceipt,
    Origin
} from "../contracts/lz/ILayerZeroEndpointV2.sol";
import {BridgeMsgCodec} from "../contracts/BridgeMsgCodec.sol";

contract MockIdentityRegistry {
    mapping(address => bool) public verified;
    mapping(address => uint16) public country;

    function setVerified(address a, bool v) external {
        verified[a] = v;
    }

    function setCountry(address a, uint16 c) external {
        country[a] = c;
    }

    function isVerified(address a) external view returns (bool) {
        return verified[a];
    }

    function investorCountry(address a) external view returns (uint16) {
        return country[a];
    }
}

contract MockCompliance {
    bool public allow = true;

    function setAllow(bool v) external {
        allow = v;
    }

    function canTransfer(address, address, uint256) external view returns (bool) {
        return allow;
    }
}

/// A T-REX token complete enough to exercise the lockbox: the transfer gate is
/// the real one, so a test can make an escrow or a release fail for a genuine
/// compliance reason rather than a contrived one.
contract MockERC3643Token {
    address public identityRegistry;
    address public compliance;
    bool public paused;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isFrozen;
    uint256 public totalSupply;

    constructor(address registry_, address compliance_) {
        identityRegistry = registry_;
        compliance = compliance_;
    }

    function setPaused(bool v) external {
        paused = v;
    }

    function setFrozen(address a, bool v) external {
        isFrozen[a] = v;
    }

    function setCompliance(address c) external {
        compliance = c;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _gate(address from, address to, uint256 amount) private view {
        require(!paused, "paused");
        require(!isFrozen[from], "sender frozen");
        require(!isFrozen[to], "recipient frozen");
        require(MockIdentityRegistry(identityRegistry).isVerified(from), "sender not verified");
        require(MockIdentityRegistry(identityRegistry).isVerified(to), "recipient not verified");
        require(MockCompliance(compliance).canTransfer(from, to, amount), "compliance");
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _gate(msg.sender, to, amount);
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _gate(from, to, amount);
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Records what the OApp handed the endpoint, and can drive a message back into
/// it the way the real executor would.
contract MockEndpoint {
    uint32 public lastDstEid;
    bytes32 public lastReceiver;
    bytes public lastMessage;
    bytes public lastOptions;
    address public lastRefund;
    address public lastDelegate;
    uint256 public sendCount;
    uint256 public nativeFee;
    uint64 private nonce;

    function setFee(uint256 fee) external {
        nativeFee = fee;
    }

    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory)
    {
        lastDstEid = params.dstEid;
        lastReceiver = params.receiver;
        lastMessage = params.message;
        lastOptions = params.options;
        lastRefund = refundAddress;
        sendCount += 1;
        nonce += 1;
        return MessagingReceipt({
            guid: bytes32(uint256(nonce)),
            nonce: nonce,
            fee: MessagingFee({nativeFee: msg.value, lzTokenFee: 0})
        });
    }

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee({nativeFee: nativeFee, lzTokenFee: 0});
    }

    function setDelegate(address delegate) external {
        lastDelegate = delegate;
    }

    /// Deliver as the endpoint, which is what makes the OApp's caller check pass.
    function deliver(
        address oapp,
        uint32 srcEid,
        bytes32 sender,
        uint64 nonce_,
        bytes calldata message
    ) external {
        ILayerZeroReceiver(oapp).lzReceive(
            Origin({srcEid: srcEid, sender: sender, nonce: nonce_}),
            bytes32(uint256(nonce_)),
            message,
            address(0),
            ""
        );
    }
}

/// Exposes the codec's internal functions so the wire format can be asserted
/// from the EVM side against the same vectors the Cairo tests pin.
contract CodecHarness {
    function encodeMint(
        address evmSender,
        bytes32 snRecipient,
        uint256 amount,
        uint64 seq,
        bool verified,
        bool frozen,
        uint16 country,
        uint8 delivery,
        bytes32 noteId
    ) external pure returns (bytes memory) {
        return BridgeMsgCodec.encodeMint(
            evmSender, snRecipient, amount, seq, verified, frozen, country, delivery, noteId
        );
    }

    function encodeIdentity(
        address evmAccount,
        uint64 seq,
        bool verified,
        bool frozen,
        uint16 country
    ) external pure returns (bytes memory) {
        return BridgeMsgCodec.encodeIdentity(evmAccount, seq, verified, frozen, country);
    }

    function encodeGlobal(uint64 seq, bool paused) external pure returns (bytes memory) {
        return BridgeMsgCodec.encodeGlobal(seq, paused);
    }

    function decodeUnlock(bytes calldata message)
        external
        pure
        returns (address recipient, uint256 amount)
    {
        return BridgeMsgCodec.decodeUnlock(message);
    }

    function decodeMint(bytes calldata message)
        external
        pure
        returns (address, bytes32, uint256, uint64, bool, bool, uint16, uint8, bytes32)
    {
        return BridgeMsgCodec.decodeMint(message);
    }
}

// ------------------------------------------------- T-REX modular compliance
// Shaped like @tokenysolutions/t-rex v4.1.6 so ComplianceReader is tested
// against the real introspection surface: per-item getters only, `name()` for
// identification, and a MaxBalanceModule that deliberately exposes NO getter
// for its cap -- the reason the export tool has to read event logs.

contract MockModularCompliance {
    address[] private modules;
    address public tokenBound;

    function setTokenBound(address t) external {
        tokenBound = t;
    }

    function getTokenBound() external view returns (address) {
        return tokenBound;
    }

    function addModule(address m) external {
        modules.push(m);
    }

    function getModules() external view returns (address[] memory) {
        return modules;
    }

    function canTransfer(address, address, uint256) external pure returns (bool) {
        return true;
    }
}

contract MockCountryAllowModule {
    mapping(address => mapping(uint16 => bool)) private allowed;

    // Signatures copied from @tokenysolutions/t-rex v4.1.6. The export tool
    // reconstructs candidates from these, so a mock that only implemented the
    // getters would test nothing that matters.
    event CountryAllowed(address _compliance, uint16 _country);
    event CountryUnallowed(address _compliance, uint16 _country);

    function name() external pure returns (string memory) {
        return "CountryAllowModule";
    }

    function setCountryAllowed(address compliance, uint16 country, bool value) external {
        allowed[compliance][country] = value;
        if (value) emit CountryAllowed(compliance, country);
        else emit CountryUnallowed(compliance, country);
    }

    function isCountryAllowed(address compliance, uint16 country) external view returns (bool) {
        return allowed[compliance][country];
    }
}

contract MockCountryRestrictModule {
    mapping(address => mapping(uint16 => bool)) private restricted;

    event AddedRestrictedCountry(address indexed _compliance, uint16 _country);
    event RemovedRestrictedCountry(address indexed _compliance, uint16 _country);

    function name() external pure returns (string memory) {
        return "CountryRestrictModule";
    }

    function setCountryRestricted(address compliance, uint16 country, bool value) external {
        restricted[compliance][country] = value;
        if (value) emit AddedRestrictedCountry(compliance, country);
        else emit RemovedRestrictedCountry(compliance, country);
    }

    function isCountryRestricted(address compliance, uint16 country) external view returns (bool) {
        return restricted[compliance][country];
    }
}

contract MockSupplyLimitModule {
    mapping(address => uint256) private limits;

    event SupplyLimitSet(address _compliance, uint256 _limit);

    function name() external pure returns (string memory) {
        return "SupplyLimitModule";
    }

    function setSupplyLimit(address compliance, uint256 limit) external {
        limits[compliance] = limit;
        emit SupplyLimitSet(compliance, limit);
    }

    function getSupplyLimit(address compliance) external view returns (uint256) {
        return limits[compliance];
    }
}

contract MockTransferRestrictModule {
    mapping(address => mapping(address => bool)) private allowedUsers;

    event UserAllowed(address _compliance, address _userAddress);
    event UserDisallowed(address _compliance, address _userAddress);

    function name() external pure returns (string memory) {
        return "TransferRestrictModule";
    }

    function setUserAllowed(address compliance, address user, bool value) external {
        allowedUsers[compliance][user] = value;
        if (value) emit UserAllowed(compliance, user);
        else emit UserDisallowed(compliance, user);
    }

    function isUserAllowed(address compliance, address user) external view returns (bool) {
        return allowedUsers[compliance][user];
    }
}

/// Faithfully getter-less, like the real one: the cap is private and only the
/// `MaxBalanceSet` event ever reveals it.
contract MockMaxBalanceModule {
    mapping(address => uint256) private _maxBalance;
    mapping(address => mapping(address => uint256)) private _IDBalance;

    event MaxBalanceSet(address indexed _compliance, uint256 indexed _maxBalance);

    function name() external pure returns (string memory) {
        return "MaxBalanceModule";
    }

    function setMaxBalance(address compliance, uint256 max) external {
        _maxBalance[compliance] = max;
        emit MaxBalanceSet(compliance, max);
    }

    function setIdBalance(address compliance, address identity, uint256 balance) external {
        _IDBalance[compliance][identity] = balance;
    }

    function getIDBalance(address compliance, address identity) external view returns (uint256) {
        return _IDBalance[compliance][identity];
    }
}

/// A module that reverts on every probe, to prove the reader degrades to
/// "false" instead of failing the whole export.
contract MockHostileModule {
    function name() external pure returns (string memory) {
        return "HostileModule";
    }

    fallback() external {
        revert("nope");
    }
}

interface ILockboxClaim {
    function claim(address recipient) external returns (uint256);
}

/// TEST ONLY. An ERC-3643 whose `transfer` re-enters the lockbox's `claim`.
///
/// A malicious or merely exotic token is the one component the lockbox cannot
/// vet -- it is chosen by the issuer, and hook-bearing ERC-20s are common in
/// RWA deployments. This one exists to prove the claim path zeroes its
/// bookkeeping before making the outbound call, so a re-entrant claim finds
/// nothing left to take.
contract MockReentrantToken {
    address public identityRegistry;
    address public compliance;
    address public lockbox;
    address public reenterFor;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address registry_, address compliance_) {
        identityRegistry = registry_;
        compliance = compliance_;
    }

    function setLockbox(address l) external {
        lockbox = l;
    }

    /// Arm the re-entrancy: the next `transfer` will call `claim(recipient)`.
    function setReenterFor(address a) external {
        reenterFor = a;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (reenterFor != address(0) && !reentryAttempted) {
            reentryAttempted = true;
            try ILockboxClaim(lockbox).claim(reenterFor) returns (uint256) {
                reentrySucceeded = true;
            } catch {
                reentrySucceeded = false;
            }
        }
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
