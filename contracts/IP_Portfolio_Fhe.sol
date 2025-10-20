pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract IP_Portfolio_Fhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchClosed;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted IP Data Storage
    // For simplicity, we'll store a count of IP assets per batch.
    // In a real system, this would be a more complex mapping of IP data.
    mapping(uint256 => euint32) public encryptedIpCountPerBatch;

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event IpAssetAdded(uint256 indexed batchId, address indexed provider);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 decryptedIpCount);

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidBatchId();
    error InvalidCooldown();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier respectCooldown(address user, mapping(address => uint256) storage lastActionTime) {
        if (block.timestamp < lastActionTime[user] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        currentBatchId = 1; // Start with batch 1
        emit BatchOpened(currentBatchId);
        cooldownSeconds = 60; // Default cooldown of 60 seconds
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
            if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        isBatchClosed[currentBatchId] = false;
        emit BatchOpened(currentBatchId);
    }

    function closeCurrentBatch() external onlyOwner whenNotPaused {
        if (currentBatchId == 0 || isBatchClosed[currentBatchId]) revert BatchClosedOrInvalid();
        isBatchClosed[currentBatchId] = true;
        emit BatchClosed(currentBatchId);
    }

    function addEncryptedIpAsset(euint32 encryptedIpCount) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        if (currentBatchId == 0 || isBatchClosed[currentBatchId]) revert BatchClosedOrInvalid();

        _initIfNeeded(encryptedIpCount);
        euint32 memory currentCount = encryptedIpCountPerBatch[currentBatchId];
        encryptedIpCountPerBatch[currentBatchId] = currentCount.add(encryptedIpCount);
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit IpAssetAdded(currentBatchId, msg.sender);
    }

    function requestBatchIpCountDecryption(uint256 batchId) external whenNotPaused respectCooldown(msg.sender, lastDecryptionRequestTime) {
        if (batchId == 0 || !isBatchClosed[batchId]) revert InvalidBatchId(); // Only allow decryption for closed batches

        euint32 memory encryptedCount = encryptedIpCountPerBatch[batchId];
        _requireInitialized(encryptedCount);

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedCount);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // Rebuild ciphertexts array in the exact same order as during requestDecryption
        // For this contract, it's always a single euint32 for the batch IP count.
        euint32 memory encryptedCount = encryptedIpCountPerBatch[decryptionContexts[requestId].batchId];
        _requireInitialized(encryptedCount); // Ensure it's still initialized

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedCount);

        // State Verification: Re-calculate hash and compare
        // This ensures that the ciphertexts haven't changed since the decryption was requested.
        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // Proof Verification
        FHE.checkSignatures(requestId, cleartexts, proof);

        // Decode & Finalize
        // cleartexts is expected to be abi.encodePacked(value1, value2, ...)
        // For a single euint32, it's just the one value.
        uint256 decryptedIpCount = abi.decode(cleartexts, (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, decryptedIpCount);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 memory x) internal {
        if (!FHE.isInitialized(x)) {
            x = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 memory x) internal pure {
        if (!FHE.isInitialized(x)) {
            revert("Ciphertext not initialized");
        }
    }
}