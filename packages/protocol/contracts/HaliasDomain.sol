// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./HaliasRegistry.sol";
import "./interfaces/IHaliasPool.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

// ── Custom errors ─────────────────────────────────────────────────────────────

error ZeroDependency();
error NotAdmin();
error NotPendingAdmin();
error NotAliasOwner();
error InvalidOwner();
error WrongRegistrationFee();
error NoCommitment();
error CommitTooNew();
error CommitExpired();
error CommitmentPending();
error NameDoesNotMatchAlias();
error InsufficientFees();

// Claim
error ClaimNotAuthorised();
error ClaimMustBeETH();
error ClaimWrongPayout(uint256 expected, uint256 received);

// ERC-721 surface
error AliasApprovalsDisabled();
error UseAcceptAlias();
error NoOffer();
error OfferExpired();
error NotOfferedToSigner();

// Owner authorisation
error AuthorizationExpired();
error NotSignedByOwner();

// Pool
error OnlyPoolMaySendETH();

/// @title  HaliasDomain — who owns the names
/// @notice Mints an alias to an owner, takes the registration fee, and is the only address
///         permitted to write to {HaliasRegistry}.
/// @dev    This contract holds the admin key. That is precisely why it holds no user funds:
///         its entire balance is registration revenue, and the pool it talks to has no
///         admin at all. An auditor reasoning about custody never has to look here, and an
///         auditor reasoning about the admin never has to look at the pool.
///
///         Alias ownership is an ERC-721 so wallets can display it, but the token is not
///         freely transferable. Moving a name has to move its keys at the same instant —
///         otherwise the new owner receives a name whose incoming payments the old owner
///         can still decrypt. {offerAlias} then {acceptAlias} is the only path, and the
///         plain ERC-721 transfer and approval entry points revert.
///
///         The 3-argument `safeTransferFrom` is deliberately not overridden here: OpenZeppelin
///         declares it non-virtual and routes it through the 4-argument overload, which does
///         revert. That is a property of the dependency rather than of this code, so it is
///         pinned by a test instead — see "disables plain ERC-721 transfer and approval".
contract HaliasDomain is ERC721, EIP712, ReentrancyGuard {
    using Address for address payable;

    IHaliasPool     public immutable pool;
    HaliasRegistry  public immutable registry;

    address public admin;
    address public pendingAdmin;

    /// @notice Registration commitments, by hash, recording the block each was made.
    /// @dev    Registration is otherwise a race anyone watching the mempool wins. The alias
    ///         hash travels in plain calldata, so a front-runner registers it first with
    ///         *their own keys* — and then every payment to that name arrives in notes only
    ///         they can decrypt. The victim sees a revert. That is not squatting; it is
    ///         acquiring someone's incoming payments, and it is profitable, which is what
    ///         separates it from exact-copy proof replay (where every destination is bound in
    ///         `paramsHash` and a copier gains nothing).
    ///
    ///         Committing first closes it: an observer sees an opaque hash and cannot build a
    ///         competing commitment without the preimage. By the time the name is public, the
    ///         commitment is already MIN_COMMIT_AGE blocks old and a would-be front-runner
    ///         cannot manufacture one in the past.
    ///
    ///         `msg.sender` is bound into the commitment for a second reason: without it, the
    ///         reveal itself is stealable. `_record` makes `msg.sender` the owner, so copying
    ///         a reveal verbatim would mint the alias to the copier while the victim keeps
    ///         the keys. Binding the sender makes a copied reveal hash to a commitment that
    ///         does not exist.
    ///
    ///         {claim} needs none of this. Its owner is fixed inside the proof through
    ///         `externalData`, so a copied claim registers to the bound owner rather than the
    ///         copier — blockable, but not stealable.
    mapping(bytes32 => uint256) public commitments;

    /// @notice Who an alias has been offered to, if anyone. Zero means no outstanding offer.
    mapping(bytes32 => address) public pendingAliasOwner;
    /// @notice Per-alias acceptance nonce, so a signature cannot be reused on a later offer.
    mapping(bytes32 => uint256) public aliasNonce;

    bytes32 private constant ACCEPT_ALIAS_TYPEHASH = keccak256(
        "AcceptAlias(bytes32 aliasHash,bytes32 spendingPubkey,bytes32 nullifierKeyHash,"
        "bytes32 encryptionPubkey,address to,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant OFFER_ALIAS_TYPEHASH = keccak256(
        "OfferAlias(bytes32 aliasHash,address to,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant CANCEL_OFFER_TYPEHASH = keccak256(
        "CancelOffer(bytes32 aliasHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant UPDATE_ALIAS_DATA_TYPEHASH = keccak256(
        "UpdateAliasData(bytes32 aliasHash,bytes32 dataHash,uint256 nonce,uint256 deadline)"
    );

    /// @dev One block is the whole requirement: a front-runner seeing the reveal cannot
    ///      commit and reveal in the same block, so they are locked out. Longer only costs
    ///      legitimate users time.
    uint256 public constant MIN_COMMIT_AGE = 1;
    /// @dev Commitments expire so abandoned ones cannot be hoarded and revealed much later.
    ///
    ///      Seconds, not blocks, and the difference from MIN_COMMIT_AGE is deliberate: that
    ///      one is genuinely a block property — a front-runner who first learns the name from
    ///      the reveal must not be able to commit in the same block — while this bounds a
    ///      *duration*. Expressed in blocks it meant a day on mainnet and four hours on a
    ///      two-second L2, which quietly shortens how long a legitimate registrant has to
    ///      reveal. Same reasoning as REGISTRY_ROOT_MAX_AGE.
    uint256 public constant MAX_COMMIT_AGE = 1 days;

    uint256 public registrationFee = 0.001 ether;
    uint256 public accumulatedFees;
    string  private baseTokenURI;

    /// @dev The registration a claim is authorised to perform. Hashed into
    ///      `TransactParams.externalData`, which the pool commits into `paramsHash` — so
    ///      the prover fixes every field here, including `owner`.
    ///
    ///      That binding is what makes relayed claims safe. Minting to `msg.sender` would
    ///      hand the alias to whoever submitted the transaction, and a relayer holding the
    ///      alias could rotate its keys and redirect every future payment to that name.
    struct Registration {
        address owner;
        bytes32 aliasHash;
        bytes32 spendingPubkey;
        bytes32 nullifierKeyHash;   // Poseidon(nullifierKey, 1) — computed off-chain
        bytes32 encryptionPubkey;
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    /// @notice The plaintext behind an alias hash, published by its registrant.
    /// @dev    Optional and one-shot: see {_publishName}.
    event NamePublished(bytes32 indexed aliasHash, string name);
    event Committed(bytes32 indexed commitment, uint256 blockNumber);
    event AliasOffered(bytes32 indexed aliasHash, address indexed from, address indexed to);
    event AliasOfferCancelled(bytes32 indexed aliasHash);
    event AliasClaimed(bytes32 indexed aliasHash, address indexed owner, address indexed submitter);
    event RegistrationFeeSet(uint256 fee);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @dev Authorises an action reserved to an alias's owner, in either of the two ways an
    ///      owner can express intent.
    ///
    ///      An empty signature means the owner is submitting the transaction themselves, so
    ///      `msg.sender` is the authority and there is nothing to replay. A non-empty one
    ///      means anyone may submit it and the owner's EIP-712 signature is the authority —
    ///      which is the point: an owner recovering from a compromised key is exactly the
    ///      person least likely to hold ETH, and rotation is exactly what they need to do.
    ///      {SignatureChecker} accepts EOAs and ERC-1271 contracts alike.
    ///
    ///      The nonce is bumped on **both** paths, so the rule is one sentence: any
    ///      authorised action on an alias invalidates every signature outstanding for it. An
    ///      owner who signs an offer and then changes their mind by acting directly does not
    ///      leave the old signature live for someone to submit afterwards.
    function _authorizeOwner(
        bytes32 aliasHash,
        bytes32 structHash,
        uint256 deadline,
        bytes calldata signature
    ) private returns (address) {
        // An unregistered alias has no owner, and zero must be rejected explicitly rather
        // than left to the signature check: a malformed signature recovers to the zero
        // address, so `owner == address(0)` would otherwise authorise anyone against a token
        // that does not exist.
        address owner = _ownerOf(uint256(aliasHash));
        if (owner == address(0)) revert NotAliasOwner();

        if (signature.length != 0) {
            if (block.timestamp > deadline) revert AuthorizationExpired();
            if (!SignatureChecker.isValidSignatureNow(owner, _hashTypedDataV4(structHash), signature)) {
                revert NotSignedByOwner();
            }
        } else if (msg.sender != owner) {
            revert NotAliasOwner();
        }

        unchecked { aliasNonce[aliasHash]++; }
        return owner;
    }

    /// @dev `_admin` is explicit rather than `msg.sender`: this deploys through CREATE2, so
    ///      `msg.sender` is the factory. A previous deployment set admin to the factory and
    ///      stranded every admin function permanently.
    constructor(address _pool, address _registry, address _admin)
        ERC721("Halias Alias", "HLS") EIP712("Halias", "1")
    {
        if (_pool == address(0) || _registry == address(0) || _admin == address(0)) {
            revert ZeroDependency();
        }
        pool     = IHaliasPool(_pool);
        registry = HaliasRegistry(_registry);
        admin    = _admin;
    }

    // ── Registration ───────────────────────────────────────────────────────────

    /// @notice Reserve a registration before revealing what it is for.
    /// @param  commitment  {registrationCommitment} of the registration you intend to make.
    /// @dev    Deliberately unauthenticated: a commitment reveals nothing, and refusing to
    ///         store one would only reintroduce the race it exists to close.
    ///
    ///         A live commitment cannot be reset, and that is load-bearing. The hash is
    ///         public the moment it is made, so anyone could otherwise re-commit someone
    ///         else's in the same block as their reveal — pushing `madeAt` to the current
    ///         block and failing the reveal with {CommitTooNew}, indefinitely, for the price
    ///         of gas. Nobody can front-run the *first* commitment because that needs the
    ///         preimage, so refusing to overwrite closes the window entirely.
    ///
    ///         An expired one can be replaced, which is how a caller recovers from letting
    ///         a commitment go stale.
    function commit(bytes32 commitment) external {
        uint256 prev = commitments[commitment];
        if (prev != 0 && block.timestamp <= _commitTime(prev) + MAX_COMMIT_AGE) {
            revert CommitmentPending();
        }

        commitments[commitment] = block.number | (block.timestamp << 128);
        emit Committed(commitment, block.number);
    }

    /// @dev A commitment records both the block it was made in and the moment, packed into one
    ///      slot so the two-transaction flow still costs one SSTORE. Both are needed because
    ///      the two ages measure different things — see MAX_COMMIT_AGE.
    function _commitBlock(uint256 v) private pure returns (uint256) { return v & type(uint128).max; }
    function _commitTime(uint256 v)  private pure returns (uint256) { return v >> 128; }

    /// @notice The commitment for a registration. Derive it here rather than reimplementing
    ///         the encoding, so a caller cannot commit to something they cannot reveal.
    function registrationCommitment(
        bytes32 aliasHash,
        bytes32 spendingPubkey,
        bytes32 nullifierKeyHash,
        bytes32 encryptionPubkey,
        address owner,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(
            aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, owner, salt
        ));
    }

    /// @notice Register an alias, paying the fee from your own balance.
    /// @param  name  The plaintext behind `aliasHash`, or "" to keep it off chain.
    /// @param  salt  The salt used in the matching {commit}.
    function register(
        bytes32 aliasHash,
        bytes32 spendingPubkey,
        bytes32 nullifierKeyHash,
        bytes32 encryptionPubkey,
        string calldata name,
        bytes32 salt
    ) external payable nonReentrant {
        if (msg.value != registrationFee) revert WrongRegistrationFee();

        bytes32 c = registrationCommitment(
            aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, msg.sender, salt
        );
        uint256 madeAt = commitments[c];
        if (madeAt == 0)                                            revert NoCommitment();
        if (block.number    < _commitBlock(madeAt) + MIN_COMMIT_AGE) revert CommitTooNew();
        if (block.timestamp > _commitTime(madeAt)  + MAX_COMMIT_AGE) revert CommitExpired();
        // One-shot: consumed here so a commitment cannot be replayed, and the refund makes
        // the two-transaction flow cheaper than it looks.
        delete commitments[c];

        accumulatedFees += msg.value;

        _record(Registration({
            owner:            msg.sender,
            aliasHash:        aliasHash,
            spendingPubkey:   spendingPubkey,
            nullifierKeyHash: nullifierKeyHash,
            encryptionPubkey: encryptionPubkey
        }), name);
    }

    /// @notice Register an alias by spending a note already held in the pool, with no ETH
    ///         of your own.
    /// @dev    This is what makes an invite work: the inviter funds a note against a keypair
    ///         derived from the invite secret, and the claimer spends it to buy their name.
    ///         The claimer still pays gas, or names a relayer in `p.relayerFee` and lets the
    ///         pool pay it out of the same withdrawal.
    ///
    ///         Ordering is load-bearing. The claimer's change note is a non-zero output, and
    ///         the circuit demands registry membership for every non-zero output — so their
    ///         own alias has to be in the tree the proof is checked against, a tree that does
    ///         not yet exist when the proof is built.
    ///
    ///         The proof therefore carries the insertion. It proves against the root from
    ///         *before* this registration — on chain, and inside the freshness window — and
    ///         derives the tree that results from adding the claimer's leaf. The registry
    ///         write comes first only so {armPendingLeaf} can read the leaf back out of
    ///         stored state rather than trusting an argument.
    ///
    ///         Arming is what stops this being a hole. Without it a prover on the ordinary
    ///         `transact` path could claim an insertion of their own unregistered keys into a
    ///         tree of their choosing and pay themselves, which is precisely what the registry
    ///         proof exists to prevent.
    function claim(
        Registration calldata r,
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1,
        bytes calldata proof,
        string calldata name
    ) external nonReentrant {
        // The prover authorised exactly this registration. A submitter can decline to
        // submit; it cannot substitute itself for `r.owner` or alter a single key.
        if (keccak256(abi.encode(r)) != p.externalData) revert ClaimNotAuthorised();
        if (p.tokenAddress != address(0)) revert ClaimMustBeETH();

        _record(r, name);
        registry.armPendingLeaf(r.aliasHash);

        // The pool settles both destinations: the relayer is paid its fee directly, and
        // whatever is left over arrives here. Nothing about the relayer is this contract's
        // business, which is why there is no relayer logic anywhere in this file.
        uint256 balanceBefore = address(this).balance;
        pool.transact(p, encryptedOutput0, encryptedOutput1, proof);
        uint256 received = address(this).balance - balanceBefore;
        registry.clearPendingLeaf();

        // Measured rather than recomputed. Deriving the expected payout would mean
        // duplicating the pool's signed-amount decoding here, and the two could drift.
        if (received != registrationFee) revert ClaimWrongPayout(registrationFee, received);
        accumulatedFees += received;

        emit AliasClaimed(r.aliasHash, r.owner, msg.sender);
    }

    function _record(Registration memory r, string calldata name) private {
        if (r.owner == address(0)) revert InvalidOwner();

        // Registry first: it owns every invariant about the tree, including rejecting an
        // alias that is already taken. Minting before that would let a failed registration
        // leave a token behind.
        registry.register(r.aliasHash, r.spendingPubkey, r.nullifierKeyHash, r.encryptionPubkey);

        // `_mint`, deliberately, not `_safeMint` — static analysers flag this, so: `_safeMint`
        // calls `onERC721Received` on the recipient, and the recipient is `r.owner`, chosen by
        // the prover. That hands attacker-controlled code a re-entry point in the middle of a
        // claim, while the registry holds an armed pending leaf. `nonReentrant` stops re-entry
        // into `claim` but not calls into everything else, and reasoning about that window is
        // strictly worse than not opening it. The cost is that an alias minted to a contract
        // that cannot handle ERC-721 is stuck — an owner who asked for exactly that address.
        _mint(r.owner, uint256(r.aliasHash));
        _publishName(r.aliasHash, name);
    }

    /// @dev Publishes the plaintext when one is supplied, checked against the hash so a
    ///      false name cannot be attached to someone else's alias. Empty means do not
    ///      publish — an alias meant to be unguessable, or an unnamed invite account.
    ///
    ///      Registration is the only moment this is useful. Someone who has forgotten their
    ///      name cannot supply it later either, so a publish-afterwards function would not
    ///      address the failure it exists for.
    function _publishName(bytes32 aliasHash, string calldata name) private {
        if (bytes(name).length == 0) return;
        if (keccak256(bytes(name)) != aliasHash) revert NameDoesNotMatchAlias();
        emit NamePublished(aliasHash, name);
    }

    // ── Alias maintenance ──────────────────────────────────────────────────────

    // There is no `updateKeys`. It rotated the nullifier and encryption keys but never the
    // spending pubkey — so the one compromise that loses money was the one it could not
    // address, behind a name that implied otherwise. Offering an alias to yourself and
    // accepting it with fresh keys rotates all three, which is strictly more, and once
    // {offerAlias} carries a signature the whole rotation is relayable: exactly what someone
    // recovering from a compromise needs, since that is when they are least able to pay.
    //
    // It also removes a registry leaf writer, and every leaf write invalidates claims in
    // flight (F1). What it costs is `dataHash`, which {HaliasRegistry-reassign} clears and
    // which is zero on every alias in existence — reserved for proof-of-innocence and not yet
    // carrying anything. When it does, the distinction belongs on `reassign` keyed on whether
    // the owner actually changed, rather than in a separate function.

    /// @dev `nonReentrant` is defence in depth rather than a live fix. A relayer holding
    ///      control during a claim's payout could otherwise reach this, and while the pool
    ///      has already verified the registry root by then — so a mid-flight write cannot
    ///      affect the executing transaction — that safety depends on the ordering inside
    ///      a different contract. Guarding here keeps the argument local.
    function updateAliasData(
        bytes32 aliasHash,
        bytes32 newDataHash,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        _authorizeOwner(aliasHash, keccak256(abi.encode(
            UPDATE_ALIAS_DATA_TYPEHASH, aliasHash, newDataHash,
            aliasNonce[aliasHash], deadline
        )), deadline, signature);
        registry.setDataHash(aliasHash, newDataHash);
    }

    /// @notice Offer an alias to someone. Nothing moves until they accept.
    /// @dev    Recording an intent rather than performing the transfer is what makes the
    ///         handover safe. Taking the new owner *and* the new keys from the seller in one
    ///         step would let a seller hand over the token while installing keys they
    ///         controlled, leaving the recipient owning a name whose payments arrive for
    ///         someone else. The contract cannot detect that: keys come from an EIP-191
    ///         wallet signature through Poseidon, so there is no on-chain relationship
    ///         between an address and a pubkey.
    ///
    ///         Only the recipient can assert which keys are theirs, so only the recipient can
    ///         complete a transfer. Until then this changes nothing at all — the seller keeps
    ///         the token, the registry keeps its keys, and payments keep arriving for the
    ///         seller. There is no in-transit state to get wrong.
    ///
    ///         Offering an alias to yourself is the key-rotation path: accept it with fresh
    ///         keys and {HaliasRegistry-reassign} replaces all three, including the spending
    ///         pubkey. Signing both halves makes the whole rotation relayable.
    function offerAlias(
        bytes32 aliasHash,
        address to,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (to == address(0)) revert InvalidOwner();
        address owner = _authorizeOwner(aliasHash, keccak256(abi.encode(
            OFFER_ALIAS_TYPEHASH, aliasHash, to, aliasNonce[aliasHash], deadline
        )), deadline, signature);
        pendingAliasOwner[aliasHash] = to;
        emit AliasOffered(aliasHash, owner, to);
    }

    /// @notice Withdraw an outstanding offer.
    function cancelOffer(
        bytes32 aliasHash,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        _authorizeOwner(aliasHash, keccak256(abi.encode(
            CANCEL_OFFER_TYPEHASH, aliasHash, aliasNonce[aliasHash], deadline
        )), deadline, signature);
        delete pendingAliasOwner[aliasHash];
        emit AliasOfferCancelled(aliasHash);
    }

    /// @notice Complete a transfer, installing keys the recipient authorised.
    /// @dev    Authorisation is a signature rather than `msg.sender`, so a relayer can submit
    ///         this for a recipient holding no ETH — the same reason {claim} binds its owner
    ///         in the proof instead of reading the sender. {SignatureChecker} accepts both
    ///         EOAs and ERC-1271 contracts, which is what lets an escrow be a recipient.
    ///
    ///         The signature covers the keys, so a submitter cannot substitute its own; and
    ///         the alias's nonce, so a signature cannot be replayed against a later offer of
    ///         the same alias to the same address.
    function acceptAlias(
        bytes32 aliasHash,
        bytes32 newSpendingPubkey,
        bytes32 newNullifierKeyHash,
        bytes32 newEncryptionPubkey,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        address to = pendingAliasOwner[aliasHash];
        if (to == address(0)) revert NoOffer();
        if (block.timestamp > deadline) revert OfferExpired();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            ACCEPT_ALIAS_TYPEHASH, aliasHash,
            newSpendingPubkey, newNullifierKeyHash, newEncryptionPubkey,
            to, aliasNonce[aliasHash], deadline
        )));
        if (!SignatureChecker.isValidSignatureNow(to, digest, signature)) {
            revert NotOfferedToSigner();
        }

        // Consumed before anything else moves: one offer, one acceptance.
        delete pendingAliasOwner[aliasHash];
        unchecked { aliasNonce[aliasHash]++; }

        _transfer(ownerOf(uint256(aliasHash)), to, uint256(aliasHash));
        registry.reassign(aliasHash, newSpendingPubkey, newNullifierKeyHash, newEncryptionPubkey);
    }

    /// @notice The digest a recipient signs to accept `aliasHash`.
    /// @dev    Exposed so clients sign what this contract will verify rather than
    ///         reconstructing the encoding.
    function acceptAliasDigest(
        bytes32 aliasHash,
        bytes32 newSpendingPubkey,
        bytes32 newNullifierKeyHash,
        bytes32 newEncryptionPubkey,
        address to,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            ACCEPT_ALIAS_TYPEHASH, aliasHash,
            newSpendingPubkey, newNullifierKeyHash, newEncryptionPubkey,
            to, aliasNonce[aliasHash], deadline
        )));
    }

    // ── Admin ──────────────────────────────────────────────────────────────────
    //
    // Everything here touches revenue or metadata. None of it can reach a user's funds:
    // those live in the pool, which has no admin at all.

    function setRegistrationFee(uint256 _fee) external onlyAdmin {
        registrationFee = _fee;
        emit RegistrationFeeSet(_fee);
    }

    function setBaseTokenURI(string calldata baseURI) external onlyAdmin {
        baseTokenURI = baseURI;
    }

    /// @dev `nonReentrant` for uniformity, not because CEI leaves a hole — the balance is
    ///      reduced before the send, so a re-entrant withdrawal sees the lower figure and a
    ///      re-entrant registration only adds to it. It is the one ETH-sending function that
    ///      lacked the guard, and "this one is safe for a different reason than the others"
    ///      is a thing an auditor has to re-derive every time.
    function withdrawFees(address payable to, uint256 amount) external nonReentrant onlyAdmin {
        if (to == address(0)) revert InvalidOwner();
        if (amount > accumulatedFees) revert InsufficientFees();
        accumulatedFees -= amount;
        to.sendValue(amount);
        emit FeesWithdrawn(to, amount);
    }

    // No token rescue. It existed to recover tokens sent here by mistake, which is a
    // scenario this contract has no business in: it never holds tokens, and user assets are
    // in the pool, which has no admin at all. Keeping it meant one more admin-reachable path
    // for an auditor to rule out, in exchange for insuring against a mistake nobody has made.
    // Tokens sent here are stuck, and that is the correct outcome for value the contract was
    // never meant to receive.

    /// @dev Two-step, so a typo in the new address cannot orphan the role.
    function transferAdmin(address _admin) external onlyAdmin {
        if (_admin == address(0)) revert InvalidOwner();
        pendingAdmin = _admin;
        emit AdminTransferStarted(admin, _admin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address previous = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(previous, admin);
    }

    // ── ERC-721 restrictions ───────────────────────────────────────────────────

    function transferFrom(address, address, uint256) public pure override {
        revert UseAcceptAlias();
    }

    function safeTransferFrom(address, address, uint256, bytes memory) public pure override {
        revert UseAcceptAlias();
    }

    /// @dev Approvals are disabled outright rather than merely unused. An approval that
    ///      cannot be exercised is a footgun: it looks like it delegates the alias and
    ///      silently does nothing.
    function approve(address, uint256) public pure override {
        revert AliasApprovalsDisabled();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert AliasApprovalsDisabled();
    }

    function _baseURI() internal view override returns (string memory) {
        return baseTokenURI;
    }

    // ── Pool payouts ───────────────────────────────────────────────────────────

    /// @dev The pool pays a claim's registration fee here mid-call. Nothing else has any
    ///      reason to push ETH at this contract, and untracked ETH would sit outside
    ///      `accumulatedFees` where `withdrawFees` cannot reach it.
    receive() external payable {
        if (msg.sender != address(pool)) revert OnlyPoolMaySendETH();
    }
}
